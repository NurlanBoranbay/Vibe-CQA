"""Organizers' submission format (Student Guide appendix, "Формат JSON 1.0").

value: binary → true/false, scale → step value, N/A → null.
evidence_turns: 1-based indices into the original transcript array (internal ids are 0-based).
critical_flag: equals the value of the critical criterion (true = violation found).
A dialog that could not be evaluated → status "error", empty criteria, score null.
"""

from __future__ import annotations

from typing import Any, Optional

from .models import Checklist, Evaluation


def _value(c, answer) -> Any:
    if answer == "na":
        return None
    if c.type == "binary":
        return answer == "yes"
    return int(answer)


def _turns(r) -> list[int]:
    ids = list(r.evidence)
    if not ids and r.checked_range:
        ids = list(r.checked_range)          # where the missing action was expected
    return sorted({i + 1 for i in ids})


def record(cl: Checklist, ev: Evaluation) -> dict:
    res = {r.criterion_id: r for r in ev.results}
    crit = []
    for c in cl.criteria:
        r = res[c.id]
        crit.append({
            "criterion_id": c.id,
            "value": _value(c, r.answer),
            "rationale": (r.na_reason or r.explanation) if r.answer == "na" else (r.explanation or r.reasoning),
            "evidence_turns": _turns(r),
        })
    total = ev.score.get("total")
    return {
        "conversation_id": ev.conversation_id,
        "status": "ok",
        "criteria": crit,
        "score": {"final_score": None if total is None else round(float(total), 2),
                  "critical_flag": bool(ev.score.get("gross_error"))},
    }


def error_record(conversation_id: str, error: str) -> dict:
    return {"conversation_id": conversation_id, "status": "error", "criteria": [], "score": None,
            "error": error}


def document(records: list[dict], *, team: str, model_name: str, mode: str = "external_api") -> dict:
    return {"schema_version": "1.0", "team_name": team,
            "model": {"mode": mode, "name": model_name}, "results": records}


def check(doc: dict, cl: Checklist, expected_ids: Optional[list[str]] = None) -> list[str]:
    """Pre-push validation from the guide: one record per id, no dupes, 8 criteria exactly once."""
    probs = []
    ids = [r["conversation_id"] for r in doc["results"]]
    if len(ids) != len(set(ids)):
        probs.append("duplicate conversation_id")
    if expected_ids is not None and set(ids) != set(expected_ids):
        probs.append(f"id mismatch: missing {sorted(set(expected_ids) - set(ids))}, extra {sorted(set(ids) - set(expected_ids))}")
    want = [c.id for c in cl.criteria]
    by = cl.by_id()
    for r in doc["results"]:
        if r["status"] != "ok":
            continue
        got = [x["criterion_id"] for x in r["criteria"]]
        if sorted(got) != sorted(want):
            probs.append(f"{r['conversation_id']}: criteria {got}")
        for x in r["criteria"]:
            c = by[x["criterion_id"]]
            v = x["value"]
            if v is None and not c.na_allowed:
                probs.append(f"{r['conversation_id']}/{c.id}: null not allowed")
            elif c.type == "scale" and v is not None and c.scale.steps and v not in c.scale.steps:
                probs.append(f"{r['conversation_id']}/{c.id}: {v} not in {c.scale.steps}")
            elif c.type == "binary" and v is not None and not isinstance(v, bool):
                probs.append(f"{r['conversation_id']}/{c.id}: not bool")
        crit_v = next((x["value"] for x in r["criteria"] if by[x["criterion_id"]].critical), None)
        if r["score"]["critical_flag"] != bool(crit_v):
            probs.append(f"{r['conversation_id']}: critical_flag != critical value")
    return probs
