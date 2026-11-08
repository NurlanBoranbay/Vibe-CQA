"""Batch evaluation from the command line.

  python -m cqa.cli --source bench/dialogs.json --out runs/out.json
  python -m cqa.cli --source "https://<organizers>/...?group_id=DEV" --provider compat:qwen2.5@http://localhost:8000/v1
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from . import export
from .data import load_checklist, load_dialogs, select
from .evaluate import evaluate
import os

from .llm import Budget, default_provider, load_env, make_provider

ROOT = Path(__file__).resolve().parents[1]


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="organizers' JSON file or GET URL")
    ap.add_argument("--checklist", default=str(ROOT / "checklists" / "official.json"))
    ap.add_argument("--provider", default=None, help="default: CQA_PROVIDER or Gemma 4 (llm.default_provider)")
    ap.add_argument("--strategy", default="grounded")
    ap.add_argument("--thinking", default="high")
    ap.add_argument("--ids", nargs="*")
    ap.add_argument("--samples", type=int, default=3, help="self-consistency: k samples, majority/median vote")
    ap.add_argument("--budget", type=float, default=1.0)
    ap.add_argument("--concurrency", type=int, default=6)
    ap.add_argument("--out", default=str(ROOT / "runs" / "evaluations.json"))
    ap.add_argument("--export", help="write the organizers' results.json here (e.g. results/dev/results.json)")
    ap.add_argument("--team", default="VibeTeam")
    a = ap.parse_args()

    load_env(ROOT / ".env")
    a.provider = a.provider or os.environ.get("CQA_PROVIDER") or default_provider()
    cl = load_checklist(a.checklist)
    dialogs = select(load_dialogs(a.source), a.ids)
    budget = Budget(a.budget)
    provider = make_provider(a.provider, budget=budget, thinking=a.thinking, cache_dir=ROOT / "runs" / "cache")
    sem = asyncio.Semaphore(a.concurrency)

    async def one(d):
        async with sem:
            try:
                ev = await evaluate(provider, cl, d, strategy=a.strategy, samples=a.samples)
            except Exception as e:  # recorded as status=error, never as a zero score
                print(f"{d.conversation_id:24s} ERROR {e!r}")
                return d.conversation_id, repr(e)
            s = ev.score
            print(f"{d.conversation_id:24s} total={s['total']!s:>6} gross={s['gross_error']!s:5} "
                  f"review={sum(r.needs_review for r in ev.results)} ${ev.usage['cost_usd']:.5f}")
            return ev

    out = await asyncio.gather(*[one(d) for d in dialogs])
    evs = [e for e in out if not isinstance(e, tuple)]
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps([e.model_dump() for e in evs], ensure_ascii=False, indent=1), encoding="utf-8")
    if a.export:
        recs = [export.error_record(*e) if isinstance(e, tuple) else export.record(cl, e) for e in out]
        model_name = getattr(provider, "model", a.provider)
        doc = export.document(recs, team=a.team, model_name=model_name,
                              mode="local" if a.provider.startswith(("compat:", "agent:")) else "external_api")
        probs = export.check(doc, cl, [d.conversation_id for d in dialogs])
        Path(a.export).parent.mkdir(parents=True, exist_ok=True)
        Path(a.export).write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"export → {a.export}; problems: {probs or 'none'}")
    print(f"{len(evs)} dialogs → {a.out}; spent ${budget.spent:.5f}")


if __name__ == "__main__":
    asyncio.run(main())
