"""Evaluation strategies.

  single        V1 baseline: one call, all criteria, free-text quotes, no checks.
  grounded      V2: one call, turn-id evidence, reasoning-first, deterministic
                validation + one targeted repair call for failing criteria.
  per_criterion V3: one call per criterion on a shared cached prefix, same
                validation + repair per criterion.
  samples>1     self-consistency on top of grounded/per_criterion: k samples at
                T=0.7, majority answer, agreement becomes confidence.

Rule-based pre-pass: criteria that need audio are N/A on chats without asking
the model.
"""

from __future__ import annotations

import asyncio
import time
from collections import Counter
from typing import Any, Optional

from . import prompts, scoring
from .audio import features_block, fetch_audio
from .llm import LLMResult
from .models import Checklist, Criterion, CriterionResult, Dialog, Evaluation
from .validate import build_result, items_from, parse_json

STRATEGIES = ("single", "grounded", "per_criterion", "hybrid")
DEEP_THINKING = "high"   # reasoning level for deep_check criteria in the hybrid strategy


class Usage:
    def __init__(self):
        self.calls = self.cached = 0
        self.cost = 0.0
        self.prompt = self.completion = self.cache_hit = self.reasoning = 0

    def add(self, r: LLMResult):
        self.calls += 1
        self.cached += int(r.cached)
        self.cost += r.cost_usd
        u = r.usage or {}
        self.prompt += u.get("prompt_tokens", 0)
        self.completion += u.get("completion_tokens", 0)
        self.cache_hit += u.get("prompt_cache_hit_tokens", 0) or 0
        self.reasoning += (u.get("completion_tokens_details") or {}).get("reasoning_tokens", 0) or 0

    def as_dict(self) -> dict[str, Any]:
        return {"calls": self.calls, "cached_calls": self.cached, "cost_usd": round(self.cost, 6),
                "prompt_tokens": self.prompt, "completion_tokens": self.completion,
                "cache_hit_tokens": self.cache_hit, "reasoning_tokens": self.reasoning}


def _fallback(c: Criterion, why: str) -> CriterionResult:
    ans = "na" if c.na_allowed else ("no" if c.type == "binary" else c.scale.min)
    return CriterionResult(criterion_id=c.id, answer=ans, explanation="",
                           needs_review=True, issues=[why])


def _rule_based(cl: Checklist, d: Dialog) -> dict[str, CriterionResult]:
    out = {}
    for c in cl.criteria:
        if c.requires_audio and not d.audio_url:
            out[c.id] = CriterionResult(
                criterion_id=c.id, answer="na", source="rule",
                explanation="Текстовый диалог: оценка требует аудиозаписи.",
                na_reason="Нет аудиозаписи — интонацию/дикцию по тексту оценить нельзя.")
    return out


async def _call(provider, messages, usage: Usage, *, temperature=0.0, sample=0, max_tokens=16000,
                thinking=None):
    kw = {"temperature": temperature, "max_tokens": max_tokens, "json_mode": True}
    if sample:
        kw["sample"] = sample
    if thinking:
        kw["thinking"] = thinking
    r = await provider.complete(messages, **kw)
    usage.add(r)
    return r


def _collect(text: str, crits: list[Criterion], d: Dialog, grounded: bool) -> tuple[dict, dict]:
    """-> (results by id, problems by id)"""
    by_id = {c.id: c for c in crits}
    results, problems = {}, {}
    try:
        items = items_from(parse_json(text))
    except Exception:
        return {}, {c.id: ["output was not valid JSON"] for c in crits}
    for it in items:
        cid = str(it.get("id") or it.get("criterion_id") or "")
        if cid in by_id and cid not in results:
            r = build_result(by_id[cid], it, d, grounded=grounded)
            results[cid] = r
            if r.issues:
                problems[cid] = r.issues
    for c in crits:
        if c.id not in results:
            problems[c.id] = ["missing from the answer"]
    return results, problems


async def _batch(provider, cl, d, crits, usage, *, grounded, repair, temperature=0.0, sample=0):
    msgs = prompts.all_criteria_messages(cl, d, crits, grounded=grounded)
    r = await _call(provider, msgs, usage, temperature=temperature, sample=sample)
    results, problems = _collect(r.text, crits, d, grounded)
    for attempt in (1, 2):
        # Nothing usable (runaway reasoning, truncated or non-JSON output): a repair turn would
        # only append the garbage to the context, so start over with a fresh sample instead.
        if results or not repair:
            break
        r = await _call(provider, msgs, usage, temperature=max(temperature, 0.3),
                        sample=sample + 100 * attempt)
        results, problems = _collect(r.text, crits, d, grounded)
    if repair and problems and results:
        # echo back only the parsed answer, never leaked reasoning, to keep the context small
        echo = prompts.to_json({"criteria": [{"id": k, "answer": v.answer, "evidence": v.evidence}
                                             for k, v in results.items()]})
        msgs2 = msgs + [{"role": "assistant", "content": echo}, prompts.repair_message(problems)]
        try:
            r2 = await _call(provider, msgs2, usage, temperature=temperature, sample=sample)
        except Exception as e:  # a failed repair must not lose the answers we already have
            return results, {cid: p + [f"repair failed: {e!r}"[:200]] for cid, p in problems.items()}
        fixed, still = _collect(r2.text, [c for c in crits if c.id in problems], d, grounded)
        for cid, res in fixed.items():
            results[cid] = res
        problems = {cid: p for cid, p in still.items()}
    return results, problems


async def _one(provider, cl, d, c, usage, *, repair, temperature=0.0, sample=0, thinking=None):
    msgs = prompts.single_criterion_messages(cl, d, c)
    mt = 12000 if thinking else 2000
    r = await _call(provider, msgs, usage, temperature=temperature, sample=sample, max_tokens=mt, thinking=thinking)
    results, problems = _collect(r.text, [c], d, True)
    if repair and problems:
        msgs2 = msgs + [{"role": "assistant", "content": r.text}, prompts.repair_message(problems)]
        r2 = await _call(provider, msgs2, usage, temperature=temperature, sample=sample, max_tokens=mt,
                         thinking=thinking)
        fixed, problems = _collect(r2.text, [c], d, True)
        results.update(fixed)
    return results, problems


async def _gather_all(coros):
    """gather that lets every branch finish (so all agent requests get written) before raising."""
    outs = await asyncio.gather(*coros, return_exceptions=True)
    for o in outs:
        if isinstance(o, BaseException):
            raise o
    return outs


async def _run_once(provider, cl, d, crits, strategy, usage, *, temperature=0.0, sample=0):
    if strategy == "single":
        return await _batch(provider, cl, d, crits, usage, grounded=False, repair=False,
                            temperature=temperature, sample=sample)
    if strategy == "grounded":
        return await _batch(provider, cl, d, crits, usage, grounded=True, repair=True,
                            temperature=temperature, sample=sample)
    if strategy == "hybrid":
        # routine criteria: one fast grounded call; deep_check criteria: own call with reasoning
        routine = [c for c in crits if not c.deep_check]
        deep = [c for c in crits if c.deep_check]
        jobs = [_one(provider, cl, d, c, usage, repair=True, temperature=temperature, sample=sample,
                     thinking=DEEP_THINKING) for c in deep]
        if routine:
            jobs.append(_batch(provider, cl, d, routine, usage, grounded=True, repair=True,
                               temperature=temperature, sample=sample))
        results, problems = {}, {}
        for res, prob in await _gather_all(jobs):
            results.update(res)
            problems.update(prob)
        return results, problems
    if strategy == "per_criterion":
        outs = await _gather_all([_one(provider, cl, d, c, usage, repair=True,
                                       temperature=temperature, sample=sample) for c in crits])
        results, problems = {}, {}
        for res, prob in outs:
            results.update(res)
            problems.update(prob)
        return results, problems
    raise ValueError(strategy)


def _vote(runs: list[dict[str, CriterionResult]], crits: list[Criterion]) -> dict[str, CriterionResult]:
    out = {}
    for c in crits:
        cands = [r[c.id] for r in runs if c.id in r]
        if not cands:
            continue
        counts = Counter(str(x.answer) for x in cands)
        top, n = counts.most_common(1)[0]
        no_majority = n * 2 <= len(cands)
        nums = sorted(x.answer for x in cands if isinstance(x.answer, int))
        if no_majority and c.type == "scale" and nums:
            top = str(nums[(len(nums) - 1) // 2])          # no majority on a scale → median sample
            n = counts[top]
        pick = next(x for x in cands if str(x.answer) == top)
        pick = pick.model_copy(update={"confidence": round(n / len(cands), 3),
                                       "needs_review": pick.needs_review or no_majority})
        out[c.id] = pick
    return out


async def evaluate(provider, cl: Checklist, d: Dialog, *, strategy: str = "grounded",
                   samples: int = 1, rules: Optional[str] = None, prompt_label: str = "") -> Evaluation:
    t0 = time.perf_counter()
    if rules:   # this task (and the sub-tasks it spawns) use the chosen system prompt
        prompts.RULES.set(rules)
    usage = Usage()
    fixed = _rule_based(cl, d)
    crits = [c for c in cl.criteria if c.id not in fixed]
    if any(c.requires_audio for c in crits) and d.is_call and not d.acoustic:
        audio_bytes = await asyncio.to_thread(fetch_audio, d.audio_url) if d.audio_url else None
        block, prosody_ok = await asyncio.to_thread(features_block, d, audio_bytes)
        if prosody_ok:
            d = d.model_copy(update={"acoustic": block})
        else:
            why = ("Запись недоступна или не распознана — интонацию по тексту оценить нельзя."
                   if audio_bytes is None else
                   "Не удалось измерить просодию (нужен пакет librosa) — интонацию оценить нельзя.")
            for c in crits:
                if c.requires_audio:
                    fixed[c.id] = CriterionResult(criterion_id=c.id, answer="na", source="rule",
                                                  explanation=why, na_reason=why, needs_review=True)
            crits = [c for c in crits if c.id not in fixed]

    if samples <= 1:
        results, problems = await _run_once(provider, cl, d, crits, strategy, usage)
    else:
        runs = await _gather_all([_run_once(provider, cl, d, crits, strategy, usage,
                                                temperature=0.7, sample=k + 1) for k in range(samples)])
        results = _vote([r for r, _ in runs], crits)
        problems = {cid: p for _, pr in runs for cid, p in pr.items() if cid not in results}

    final = []
    for c in cl.criteria:
        if c.id in fixed:
            final.append(fixed[c.id])
        elif c.id in results:
            r = results[c.id]
            if c.id in problems:
                r = r.model_copy(update={"needs_review": True, "issues": problems[c.id]})
            final.append(r)
        else:
            final.append(_fallback(c, "; ".join(problems.get(c.id, ["no answer"]))))

    ev = Evaluation(conversation_id=d.conversation_id, checklist_id=cl.id, checklist_version=cl.version,
                    strategy=strategy + (f"+sc{samples}" if samples > 1 else ""),
                    model=getattr(provider, "name", "?"), prompt=prompt_label, results=final)
    ev.score = scoring.compute(cl, final)
    ev.usage = {**usage.as_dict(), "wall_s": round(time.perf_counter() - t0, 2)}
    return ev
