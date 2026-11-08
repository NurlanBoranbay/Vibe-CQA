"""Score a strategy × provider against the gold set.

  python -m bench.run_bench --provider deepseek:deepseek-flash --strategy grounded
  python -m bench.run_bench --provider agent:runs/agent/grounded --strategy grounded --ids ...

Metrics
  acc            answer ∈ gold.accept, over all criterion×dialog items
  acc_strict     scale answers must equal the primary gold value
  gross_*        gross-error detection (critical criterion answered "no")
  na_*           N/A precision/recall vs items whose only acceptable answer is N/A
  evid_hit       among correct non-N/A answers with gold evidence: cited ids ∩ gold ≠ ∅
  total_mae      |predicted total − gold total| in points (gold total from primary answers)
  review         items flagged needs_review by the validator
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cqa import scoring  # noqa: E402
from cqa.data import load_checklist, load_dialogs, select  # noqa: E402
from cqa.evaluate import evaluate  # noqa: E402
from cqa.llm import Budget, Pending, load_env, make_provider  # noqa: E402
from cqa.models import CriterionResult  # noqa: E402
from cqa.prompt_presets import PRESETS  # noqa: E402


def gold_total(cl, gold_d):
    res = [CriterionResult(criterion_id=cid, answer=g["accept"][0]) for cid, g in gold_d.items()]
    return scoring.compute(cl, res)["total"]


def metrics(cl, evals, gold):
    n = ok = strict = 0
    per_crit = {c.id: [0, 0] for c in cl.criteria}
    gp = gt = gfp = 0  # gross: true pos, gold pos, false pos
    na_pred = na_true_pred = na_gold = 0
    ev_n = ev_hit = 0
    review = 0
    errs = []
    maes = []
    for ev in evals:
        g = gold[ev.conversation_id]
        for r in ev.results:
            gi = g.get(r.criterion_id)
            if gi is None:
                continue
            acc = [str(a) for a in gi["accept"]]
            good = str(r.answer) in acc
            n += 1
            ok += good
            strict += str(r.answer) == acc[0] or (good and isinstance(gi["accept"][0], str))
            per_crit[r.criterion_id][0] += good
            per_crit[r.criterion_id][1] += 1
            review += r.needs_review
            if not good:
                errs.append(f"{ev.conversation_id}/{r.criterion_id}: got {r.answer!r}, gold {gi['accept']}")
            crit = cl.by_id()[r.criterion_id]
            if crit.critical:
                gold_pos = gi["accept"][0] == crit.flag_on
                gt += gold_pos
                gp += gold_pos and r.answer == crit.flag_on
                gfp += (not gold_pos) and r.answer == crit.flag_on
            only_na = acc == ["na"]
            na_gold += only_na
            if r.answer == "na":
                na_pred += 1
                na_true_pred += "na" in acc
            if good and r.answer != "na" and gi["evidence"]:
                ev_n += 1
                cited = set(r.evidence)
                if r.checked_range:
                    cited |= set(range(r.checked_range[0], r.checked_range[1] + 1)) if not r.evidence else set()
                ev_hit += bool(cited & set(gi["evidence"]))
        gt_total = gold_total(cl, g)
        if ev.score.get("total") is not None and gt_total is not None:
            maes.append(abs(ev.score["total"] - gt_total))
        elif ev.score.get("total") != gt_total:
            maes.append(100.0)
    cost = sum(e.usage.get("cost_usd", 0) for e in evals)
    return {
        "dialogs": len(evals), "items": n,
        "acc": round(ok / n, 4) if n else None,
        "acc_strict": round(strict / n, 4) if n else None,
        "gross_recall": round(gp / gt, 3) if gt else None,
        "gross_false_pos": gfp,
        "na_precision": round(na_true_pred / na_pred, 3) if na_pred else None,
        "na_recall": round(sum(1 for ev in evals for r in ev.results
                               if gold[ev.conversation_id].get(r.criterion_id, {}).get("accept") == ["na"]
                               and r.answer == "na") / na_gold, 3) if na_gold else None,
        "evid_hit": round(ev_hit / ev_n, 3) if ev_n else None,
        "total_mae": round(sum(maes) / len(maes), 2) if maes else None,
        "review_flags": review,
        "cost_usd": round(cost, 5),
        "cost_per_dialog_usd": round(cost / len(evals), 6) if evals else None,
        "calls": sum(e.usage.get("calls", 0) for e in evals),
        "completion_tokens": sum(e.usage.get("completion_tokens", 0) for e in evals),
        "cache_hit_tokens": sum(e.usage.get("cache_hit_tokens", 0) for e in evals),
        "avg_wall_s": round(sum(e.usage.get("wall_s", 0) for e in evals) / len(evals), 2) if evals else None,
        "per_criterion_acc": {k: round(a / b, 3) if b else None for k, (a, b) in per_crit.items()},
        "errors": errs,
    }


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", required=True)
    ap.add_argument("--strategy", default="grounded")
    ap.add_argument("--samples", type=int, default=1)
    ap.add_argument("--thinking", default="high")
    ap.add_argument("--ids", nargs="*")
    ap.add_argument("--budget", type=float, default=1.0, help="hard USD cap for this run")
    ap.add_argument("--dialogs", default=str(ROOT / "bench" / "dialogs.json"))
    ap.add_argument("--gold", default=str(ROOT / "bench" / "gold.json"))
    ap.add_argument("--checklist", default=str(ROOT / "bench" / "checklist_default.json"))
    ap.add_argument("--label", default=None)
    ap.add_argument("--prompt", default=None, help="system prompt preset: strict | soft (default: built-in strict rules)")
    ap.add_argument("--concurrency", type=int, default=4, help="dialogs in parallel")
    a = ap.parse_args()

    load_env(ROOT / ".env")
    cl = load_checklist(a.checklist)
    gold = json.loads(Path(a.gold).read_text(encoding="utf-8"))
    dialogs = [d for d in select(load_dialogs(a.dialogs), a.ids) if d.conversation_id in gold]
    budget = Budget(a.budget)
    provider = make_provider(a.provider, budget=budget, thinking=a.thinking,
                             cache_dir=ROOT / "runs" / "cache")

    sem = asyncio.Semaphore(a.concurrency)
    pending = []

    async def run(d):
        async with sem:
            try:
                rules = next(p["text"] for p in PRESETS if p["id"] == a.prompt) if a.prompt else None
                return await evaluate(provider, cl, d, strategy=a.strategy, samples=a.samples, rules=rules,
                                      prompt_label=f"{a.prompt} v1" if a.prompt else "")
            except Pending:
                pending.append(d.conversation_id)
                return None

    evals = [e for e in await asyncio.gather(*[run(d) for d in dialogs]) if e]
    label = a.label or f"{a.provider.replace(':', '_').replace('/', '_')}__{a.strategy}__sc{a.samples}__think-{a.thinking}"
    out_dir = ROOT / "runs" / "bench"
    out_dir.mkdir(parents=True, exist_ok=True)
    if pending:
        print(json.dumps({"label": label, "pending_dialogs": pending, "done": len(evals)}, ensure_ascii=False))
        return
    m = metrics(cl, evals, gold)
    m["label"] = label
    (out_dir / f"{label}.json").write_text(json.dumps(
        {"metrics": m, "evaluations": [e.model_dump() for e in evals]}, ensure_ascii=False, indent=1),
        encoding="utf-8")
    show = {k: v for k, v in m.items() if k not in ("errors",)}
    print(json.dumps(show, ensure_ascii=False))
    for e in m["errors"]:
        print("  x", e)


if __name__ == "__main__":
    asyncio.run(main())
