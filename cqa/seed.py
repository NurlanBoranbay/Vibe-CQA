"""Load the DEV dialogs and the already-computed evaluations into the store,
so the UI works without spending on model calls.

    python -m cqa.seed                 # new database: the demo snapshot (data/seed/demo.sqlite) if present
    python -m cqa.seed --no-demo       # data/dev/dev_raw.json + data/seed/dev_evaluations.json only
    python -m cqa.seed --force         # overwrite evaluations that already exist
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
from pathlib import Path

from . import scoring
from .data import load_checklist, load_dialogs
from .models import Checklist, CriterionResult, Evaluation
from .store import Store

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("CQA_DB", str(ROOT / "data" / "cqa.sqlite")))
    ap.add_argument("--dialogs", default=str(ROOT / "data" / "dev" / "dev_raw.json"))
    ap.add_argument("--evaluations", default=str(ROOT / "data" / "seed" / "dev_evaluations.json"))
    ap.add_argument("--dataset", default="DEV")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--no-demo", action="store_true", help="ignore data/seed/demo.sqlite")
    a = ap.parse_args()

    demo = ROOT / "data" / "seed" / "demo.sqlite"
    if not a.no_demo and demo.exists() and not Path(a.db).exists():
        # the demo state: DEV and the control set evaluated, sample appeals, checklists, runs
        Path(a.db).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(demo, a.db)
        print(f"demo snapshot → {a.db}")
        return

    store = Store(a.db)
    for f in ("official.json",):
        cl = load_checklist(ROOT / "checklists" / f)
        if not store.checklist(cl.id):
            store.save_checklist(cl.model_dump())
    cl = Checklist.model_validate(store.checklist("official"))

    dialogs = load_dialogs(a.dialogs)
    for d in dialogs:
        store.save_dialog(d.model_dump(), a.dataset)

    n = 0
    if Path(a.evaluations).exists():
        for raw in json.loads(Path(a.evaluations).read_text(encoding="utf-8")):
            ev = Evaluation.model_validate(raw)
            if ev.checklist_id != cl.id:
                continue
            if store.evaluation(ev.conversation_id, cl.id, cl.version) and not a.force:
                continue
            # re-score with the stored checklist so totals follow its rules and version
            ev.checklist_version = cl.version
            ev.score = scoring.compute(cl, ev.results)
            doc = {"conversation_id": ev.conversation_id, "checklist_id": cl.id,
                   "checklist_version": cl.version, "original": ev.model_dump(),
                   "final": {"results": [r.model_dump() for r in ev.results], "score": ev.score},
                   "decisions": []}
            store.save_evaluation(ev.conversation_id, cl.id, doc)
            n += 1
    print(f"dialogs: {len(dialogs)} ({a.dataset}); evaluations seeded: {n}; checklist {cl.id} v{cl.version}; db {a.db}")


if __name__ == "__main__":
    main()
