"""Deterministic scoring — the LLM never computes points.

Per criterion: fraction = binary yes→1 / no→0, scale (v-min)/(max-min).
earned = fraction × weight.
N/A policy:
  redistribute (hackathon rule): N/A drops out of the denominator, so its
      weight is spread over applicable criteria in proportion to their weights.
  full_credit (qbox QMT since 2026-10): N/A counts as earned at full weight.
Gross error (critical criterion answered "no") is reported separately;
policy "zero_total" additionally zeroes the total.
Sections are scored the same way within each section.
"""

from __future__ import annotations

from decimal import ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_EVEN, ROUND_HALF_UP, Decimal
from typing import Any

from .models import Checklist, CriterionResult

_MODES = {"half_up": ROUND_HALF_UP, "half_even": ROUND_HALF_EVEN,
          "floor": ROUND_FLOOR, "ceil": ROUND_CEILING}


def fraction(criterion, answer) -> float | None:
    if answer == "na":
        return None
    if criterion.type == "binary":
        return 1.0 if answer == "yes" else 0.0
    s = criterion.scale
    v = max(s.min, min(s.max, int(answer)))
    return (v - s.min) / (s.max - s.min) if s.max > s.min else 1.0


def _round(x: float | None, checklist: Checklist) -> float | None:
    if x is None:
        return None
    q = Decimal(1).scaleb(-checklist.rounding.decimals)
    return float(Decimal(str(x)).quantize(q, rounding=_MODES[checklist.rounding.mode]))


def _aggregate(rows: list[dict[str, Any]], policy: str) -> tuple[float | None, float, float]:
    applicable = earned = 0.0
    any_applicable = False
    for r in rows:
        w = r["weight"]
        if r["fraction"] is None:
            if policy == "full_credit":
                applicable += w
                earned += w
            continue
        any_applicable = True
        applicable += w
        earned += w * r["fraction"]
    if not any_applicable or applicable <= 0:
        return None, applicable, earned
    return 100.0 * earned / applicable, applicable, earned


def compute(checklist: Checklist, results: list[CriterionResult]) -> dict[str, Any]:
    by_id = checklist.by_id()
    res = {r.criterion_id: r for r in results}
    rows = []
    gross = []
    for c in checklist.criteria:
        r = res.get(c.id)
        if r is None:
            continue
        f = fraction(c, r.answer)
        if c.critical and r.answer == c.flag_on:
            gross.append(c.id)
        rows.append({"criterion_id": c.id, "section": c.section, "weight": c.weight,
                     "answer": r.answer, "fraction": f,
                     "points": None if f is None else round(f * c.weight, 4)})

    policy = checklist.na_policy
    total_raw, applicable, earned = _aggregate([r for r in rows if r["weight"] > 0], policy)

    # effective weight of each criterion after N/A redistribution (for display)
    for r in rows:
        if r["fraction"] is None and policy == "redistribute":
            r["effective_weight"] = 0.0
        else:
            r["effective_weight"] = round(100.0 * r["weight"] / applicable, 3) if applicable else 0.0

    sections: dict[str, Any] = {}
    for sec in dict.fromkeys(c.section for c in checklist.criteria if c.section):
        srows = [r for r in rows if r["section"] == sec and r["weight"] > 0]
        if not srows:
            continue
        s, _, _ = _aggregate(srows, policy)
        sections[sec] = _round(s, checklist)

    total = _round(total_raw, checklist)
    total_before_gross = total
    if gross and checklist.gross_error_policy == "zero_total" and total is not None:
        total = 0.0
    return {
        "total": total,
        "total_without_gross_policy": total_before_gross,
        "gross_error": bool(gross),
        "gross_error_criteria": gross,
        "sections": sections,
        "criteria": rows,
        "na_policy": policy,
        "missing": [c.id for c in checklist.criteria if c.id not in res],
        "_unused": [k for k in res if k not in by_id],
    }
