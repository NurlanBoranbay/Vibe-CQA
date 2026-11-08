"""Deterministic parts: scoring, validation, data normalisation. No model needed.

    python -m unittest tests.test_core -v
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cqa import scoring  # noqa: E402
from cqa.data import load_checklist, load_dialogs, normalize_record  # noqa: E402
from cqa.models import CriterionResult  # noqa: E402
from cqa.validate import build_result, coerce_answer  # noqa: E402

CL = load_checklist(ROOT / "bench" / "checklist_default.json")
D = {d.conversation_id: d for d in load_dialogs(str(ROOT / "bench" / "dialogs.json"))}


def res(**answers):
    return [CriterionResult(criterion_id=k, answer=v) for k, v in answers.items()]


ALL_GOOD = dict(greeting="yes", identification="yes", needs=2, solution=2, hold="yes",
                politeness=2, closing=2, gross_error="yes")


class Scoring(unittest.TestCase):
    def test_perfect_is_100(self):
        self.assertEqual(scoring.compute(CL, res(**ALL_GOOD))["total"], 100.0)

    def test_na_redistributes_weight(self):
        # hold (5) and identification (15) N/A → denominator 80; greeting missed (10) → 70/80
        s = scoring.compute(CL, res(**{**ALL_GOOD, "hold": "na", "identification": "na", "greeting": "no"}))
        self.assertEqual(s["total"], 87.5)
        hold = next(r for r in s["criteria"] if r["criterion_id"] == "hold")
        self.assertEqual(hold["effective_weight"], 0.0)

    def test_full_credit_policy(self):
        cl = CL.model_copy(update={"na_policy": "full_credit"})
        s = scoring.compute(cl, res(**{**ALL_GOOD, "hold": "na", "greeting": "no"}))
        self.assertEqual(s["total"], 90.0)

    def test_scale_is_proportional(self):
        s = scoring.compute(CL, res(**{**ALL_GOOD, "solution": 1}))  # loses half of 25
        self.assertEqual(s["total"], 87.5)

    def test_gross_error_flag_and_zero_policy(self):
        s = scoring.compute(CL, res(**{**ALL_GOOD, "gross_error": "no"}))
        self.assertTrue(s["gross_error"])
        self.assertEqual(s["total"], 100.0)  # weight 0 + policy "flag"
        cl = CL.model_copy(update={"gross_error_policy": "zero_total"})
        self.assertEqual(scoring.compute(cl, res(**{**ALL_GOOD, "gross_error": "no"}))["total"], 0.0)

    def test_all_na_section_is_none(self):
        s = scoring.compute(CL, res(**{**ALL_GOOD, "closing": "na"}))
        self.assertIsNone(s["sections"]["Завершение"])

    def test_rounding_half_up(self):
        # 10+15+15+... chosen so the raw total is x.x5
        s = scoring.compute(CL, res(**{**ALL_GOOD, "greeting": "no", "identification": "no", "needs": 1,
                                       "solution": 0, "politeness": 1, "closing": 0, "hold": "na"}))
        self.assertEqual(s["total"], round(100 * (7.5 + 7.5) / 95, 1))


class Validation(unittest.TestCase):
    def crit(self, cid):
        return CL.by_id()[cid]

    def test_coerce(self):
        self.assertEqual(coerce_answer(self.crit("greeting"), "Да")[0], "yes")
        self.assertEqual(coerce_answer(self.crit("needs"), "2")[0], 2)
        ans, issues = coerce_answer(self.crit("greeting"), "na")
        self.assertTrue(issues)  # N/A not allowed for greeting
        ans, issues = coerce_answer(self.crit("needs"), 5)
        self.assertEqual(ans, 2)
        self.assertTrue(issues)

    def test_bot_greeting_is_not_operator_evidence(self):
        d = D["b-ru-chat-01"]  # turn 1 is the bot's greeting
        r = build_result(self.crit("greeting"), {"answer": "yes", "evidence": [1]}, d, grounded=True)
        self.assertTrue(any("CLIENT/BOT" in i for i in r.issues))

    def test_bad_ids_flagged(self):
        d = D["b-ru-chat-01"]
        r = build_result(self.crit("greeting"), {"answer": "no", "evidence": [99]}, d, grounded=True)
        self.assertTrue(any("do not exist" in i for i in r.issues))

    def test_negative_needs_range_or_evidence(self):
        d = D["b-ru-chat-01"]
        r = build_result(self.crit("closing"), {"answer": 0, "evidence": []}, d, grounded=True)
        self.assertTrue(r.issues)
        r = build_result(self.crit("closing"), {"answer": 0, "evidence": [], "checked_range": [9, 13]}, d,
                         grounded=True)
        self.assertFalse(r.issues)
        self.assertEqual(r.checked_range, [9, 13])


class Data(unittest.TestCase):
    def test_offsets(self):
        self.assertEqual(D["b-ru-chat-01"].turns[4].offset_sec, 41.0)
        self.assertEqual(D["b-ru-call-01"].turns[7].offset_sec, 140.0)  # ISO 10:04:25 - 10:02:05
        self.assertEqual(D["b-ru-call-01"].turns[7].timestamp, "2026-03-14T10:04:25+05:00")

    def test_speaker_aliases(self):
        d = normalize_record({"conversation_id": "x", "channel": "agent chat", "language": "ru",
                              "transcript": [{"timestamp": "00:01", "speaker": "Agent", "text": "hi"}]})
        self.assertEqual(d.turns[0].speaker, "operator")
        self.assertEqual(d.language, "RU")


OFF = load_checklist(ROOT / "checklists" / "official.json")
OFF_GOOD = dict(contact="yes", discovery="yes", identification="yes", consultation=20, empathy="yes",
                dialogue=10, closure="yes", critical="no")


class Official(unittest.TestCase):
    def test_weights_sum_100(self):
        self.assertEqual(sum(c.weight for c in OFF.criteria), 100)

    def test_steps_snap(self):
        c = OFF.by_id()["dialogue"]
        v, issues = coerce_answer(c, 6)
        self.assertEqual(v, 7)
        self.assertTrue(issues)
        self.assertEqual(coerce_answer(c, 4), (4, []))

    def test_scale_points_and_two_decimals(self):
        # consultation 15/20 → 15 of 20; dialogue 7/10 → 10.5 of 15; closure N/A → /95
        s = scoring.compute(OFF, res(**{**OFF_GOOD, "consultation": 15, "dialogue": 7, "closure": "na"}))
        self.assertEqual(s["total"], round(100 * (10 + 15 + 20 + 15 + 15 + 10.5) / 95, 2))

    def test_critical_yes_is_violation(self):
        self.assertFalse(scoring.compute(OFF, res(**OFF_GOOD))["gross_error"])
        s = scoring.compute(OFF, res(**{**OFF_GOOD, "critical": "yes"}))
        self.assertTrue(s["gross_error"])
        self.assertEqual(s["total"], 100.0)  # flagged separately, not zeroed

    def test_export_format(self):
        from cqa import export
        from cqa.models import Evaluation
        rs = res(**{**OFF_GOOD, "identification": "na", "critical": "yes"})
        rs[0].evidence = [3]
        rs[0].explanation = "ok"
        ev = Evaluation(conversation_id="x", checklist_id="official", checklist_version=1, strategy="g",
                        model="m", results=rs, score=scoring.compute(OFF, rs))
        doc = export.document([export.record(OFF, ev), export.error_record("y", "boom")], team="t", model_name="m")
        r = doc["results"][0]
        self.assertEqual(r["criteria"][0]["evidence_turns"], [4])           # 1-based
        self.assertIsNone(next(x for x in r["criteria"] if x["criterion_id"] == "identification")["value"])
        self.assertIs(r["score"]["critical_flag"], True)
        self.assertEqual(export.check(doc, OFF, ["x", "y"]), [])


if __name__ == "__main__":
    unittest.main()
