"""Parse and validate model output deterministically.

Catches the failure modes that matter for a KPI-grade score:
wrong answer type, N/A where not allowed, evidence ids that do not exist,
a positive verdict supported only by BOT/CLIENT turns (bot greeting credited
to the operator), a negative verdict with no checked range or evidence.
"""

from __future__ import annotations

import difflib
import json
import re
from typing import Any

from .models import Criterion, CriterionResult, Dialog

_YES = {"yes", "y", "true", "да", "иә", "done", "pass", "1"}
_NO = {"no", "n", "false", "нет", "жоқ", "violation", "fail", "0"}
_NA = {"na", "n/a", "n.a.", "not applicable", "неприменимо", "null", "none"}


def parse_json(text: str) -> Any:
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.S)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Models that leak their reasoning into content (e.g. a "thought ..." preamble that itself
    # contains braces): take the last parseable JSON object, preferring one with criteria.
    dec = json.JSONDecoder()
    found = []
    for m in re.finditer(r"\{", text):
        try:
            obj, _ = dec.raw_decode(text, m.start())
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            found.append(obj)
    if not found:
        raise json.JSONDecodeError("no JSON object found", text, 0)
    with_items = [o for o in found if any(k in o for k in ("criteria", "results", "items"))]
    return (with_items or found)[-1]


def items_from(obj: Any) -> list[dict]:
    if isinstance(obj, dict):
        for k in ("criteria", "results", "items"):
            if isinstance(obj.get(k), list):
                return obj[k]
        if "id" in obj:
            return [obj]
    if isinstance(obj, list):
        return obj
    return []


def coerce_answer(c: Criterion, raw: Any) -> tuple[Any, list[str]]:
    issues = []
    if raw is None:
        raw = "na"
    s = str(raw).strip().lower()
    if s in _NA:
        if not c.na_allowed:
            issues.append("N/A is not allowed for this criterion")
        return "na", issues
    if c.type == "binary":
        if isinstance(raw, bool):
            return ("yes" if raw else "no"), issues
        if s in _YES:
            return "yes", issues
        if s in _NO:
            return "no", issues
        issues.append(f"answer must be {c.allowed_answers()}, got {raw!r}")
        return "no", issues
    try:
        v = int(round(float(s)))
    except ValueError:
        issues.append(f"answer must be {c.allowed_answers()}, got {raw!r}")
        return c.scale.min, issues
    if not (c.scale.min <= v <= c.scale.max):
        issues.append(f"answer {v} outside {c.scale.min}..{c.scale.max}")
        v = max(c.scale.min, min(c.scale.max, v))
    if c.scale.steps and v not in c.scale.steps:
        snapped = min(c.scale.steps, key=lambda x: (abs(x - v), x))
        issues.append(f"answer {v} is not a scale step {c.scale.steps}")
        v = snapped
    return v, issues


def _ids(raw: Any, n: int) -> tuple[list[int], list[Any]]:
    good, bad = [], []
    if raw is None:
        return good, bad
    if not isinstance(raw, list):
        raw = [raw]
    for x in raw:
        try:
            i = int(str(x).strip().strip("[]t#"))
        except ValueError:
            bad.append(x)
            continue
        (good if 0 <= i < n else bad).append(i)
    return sorted(set(good)), bad


def quote_to_turns(d: Dialog, quote: str) -> list[int]:
    """Baseline strategy returns quotes; map them to turn ids by fuzzy match."""
    q = (quote or "").strip().strip('"«»').lower()
    if len(q) < 4:
        return []
    best, best_r = None, 0.0
    for t in d.turns:
        txt = t.text.lower()
        if q in txt:
            return [t.idx]
        r = difflib.SequenceMatcher(None, q, txt).ratio()
        if r > best_r:
            best, best_r = t.idx, r
    return [best] if best is not None and best_r >= 0.5 else []


def is_positive(c: Criterion, answer: Any) -> bool:
    if answer == "na":
        return False
    if c.type == "binary":
        return answer == "yes"
    return answer > c.scale.min


def build_result(c: Criterion, item: dict, d: Dialog, *, grounded: bool) -> CriterionResult:
    answer, issues = coerce_answer(c, item.get("answer"))
    n = len(d.turns)
    if grounded:
        evidence, bad = _ids(item.get("evidence"), n)
        if bad:
            issues.append(f"evidence ids {bad} do not exist (valid 0..{n - 1})")
        rng, bad_r = _ids(item.get("checked_range"), n)
        checked = [min(rng), max(rng)] if rng else None
    else:
        evidence = quote_to_turns(d, str(item.get("quote") or ""))
        checked = None

    if grounded and answer != "na":
        speakers = {d.turns[i].speaker for i in evidence}
        if c.critical:
            if answer == c.flag_on and "operator" not in speakers:
                issues.append("gross error claimed but no OPERATOR turn cited")
        elif is_positive(c, answer):
            if not evidence:
                issues.append("positive answer without evidence ids")
            elif not speakers & {"operator", "system"}:
                issues.append("positive answer cites only CLIENT/BOT turns; the operator's own action is required")
        elif not evidence and not checked:
            issues.append("negative answer needs evidence ids or checked_range")

    conf = item.get("confidence")
    try:
        conf = None if conf is None else max(0.0, min(1.0, float(conf)))
    except (TypeError, ValueError):
        conf = None
    return CriterionResult(
        criterion_id=c.id, answer=answer, reasoning=str(item.get("reasoning") or ""),
        explanation=str(item.get("explanation") or ""), evidence=evidence, checked_range=checked,
        na_reason=str(item.get("na_reason") or "") if answer == "na" else "",
        confidence=conf, issues=issues,
    )
