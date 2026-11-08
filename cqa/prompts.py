"""Prompt construction.

Design choices (each one was a measured alternative — see bench/):
- Turns carry stable ids [n]; evidence is returned as ids, not free quotes, so
  links into the transcript/player are exact and checkable.
- 'reasoning' precedes 'answer' in the output object: the model commits to
  observations before the verdict.
- Shared prefix (system + transcript) is byte-identical across calls of one
  dialog so per-criterion calls hit the provider's prompt cache.
- Bot/system turns are context only; only the operator is judged.
"""

from __future__ import annotations

import json
from contextvars import ContextVar
from typing import Optional

from .models import Checklist, Criterion, Dialog

import os

# 1 = first design; 2 = adds explicit applicability-first decision procedure and
# worst-moment rule for scales (iteration 2, see bench/RESULTS.md)
PROMPT_VERSION = int(os.environ.get("CQA_PROMPT_VERSION", "3"))

LANG_NAMES ={"ru": "Russian", "en": "English", "kk": "Kazakh", "kz": "Kazakh"}

SPEAKER_LABEL = {"operator": "OPERATOR", "client": "CLIENT", "bot": "BOT", "system": "SYSTEM"}


def fmt_offset(sec: float) -> str:
    sec = int(round(sec))
    return f"{sec // 60:02d}:{sec % 60:02d}"


def render_transcript(d: Dialog, *, with_ids: bool = True) -> str:
    lines = []
    for t in d.turns:
        tag = f"[{t.idx}] " if with_ids else ""
        lines.append(f"{tag}{fmt_offset(t.offset_sec)} {SPEAKER_LABEL[t.speaker]}: {t.text}")
    return "\n".join(lines)


def render_criterion(c: Criterion) -> str:
    out = [f"- id: {c.id}", f"  title: {c.title}"]
    if c.description:
        out.append(f"  definition: {c.description}")
    out.append(f"  answer: {c.allowed_answers()}")
    if c.type == "scale" and c.scale and c.scale.labels:
        for k, v in c.scale.labels.items():
            out.append(f"    {k} = {v}")
    if c.na_allowed:
        out.append(f"  N/A only when: {c.na_rule or 'the criterion cannot apply to this dialog'}")
    else:
        out.append('  N/A: not allowed')
    if c.critical:
        out.append(f'  critical: yes (gross error check) — answer "{c.flag_on}" means a violation WAS found')
    if c.deep_check:
        out.append("  verification: before answering, list every number, calculation, date, deadline, "
                   "settlement period, fee and tax rule the operator states and check each one (redo the "
                   "arithmetic; use your knowledge of market rules). One wrong fact delivered as true "
                   "decides the answer.")
    return "\n".join(out)


def base_rules(grounded: bool = True) -> list[str]:
    """The built-in rule set (the 'strict' system prompt)."""
    rules = [
        "You are a strict, fair quality-assurance auditor of contact-centre dialogs.",
        "You evaluate ONLY the OPERATOR. CLIENT, BOT and SYSTEM turns are context: a greeting or "
        "question by the BOT never counts as the operator's action, and a criterion broken by the BOT "
        "is not the operator's fault. SYSTEM events (verification, transfer, client left) are facts.",
        "Dialogs can be in Russian, Kazakh or English, or mix them. Judge meaning, not language.",
        "Voice calls are speech-to-text transcripts of spoken conversation. Misrecognised or garbled words, broken "
            "grammar, missing punctuation, overlapping speech and fillers are transcription artefacts or normal oral "
            "speech, not the operator's mistakes; judge speech by spoken, not written, norms. If the recording or "
            "transcript is incomplete or a fragment is unintelligible, do not count what is missing as the operator's "
            "failure: judge what is there, and use N/A where the criterion allows it when the needed part is missing.",
        "Apply each criterion's definition literally. Do not invent criteria and do not merge them.",
        "Use N/A only where the criterion allows it and its N/A condition is actually met; otherwise "
        "give a real answer.",
    ]
    if grounded:
        rules += [
            "Every turn has an id in square brackets. Cite evidence by these ids.",
            "If the required action is present, cite the turn(s) where it happens. If it is absent, "
            "set checked_range to [first_id, last_id] of the part of the dialog you searched and cite "
            "the turn(s) where it should have happened, if any.",
            "Write 'reasoning' FIRST (brief observations, max 2 sentences), then decide 'answer'.",
        ]
        if PROMPT_VERSION >= 2:
            rules += [
                "Decision procedure for every criterion: (1) applicability — if N/A is allowed, test its "
                "N/A condition first and stop at N/A only if it is clearly met; a requirement that is "
                "simply not triggered (no pause, no account data, client left) is N/A, not a violation; "
                "(2) find the operator turns that matter; (3) compare them with the definition and level "
                "descriptions; (4) answer.",
                "Scale criteria are judged by the worst relevant moment: if any operator turn matches the "
                "description of a lower level, the lower level wins.",
            ]
        if PROMPT_VERSION >= 3:
            # learned on real data (bench/RESULTS.md, "DEV"); deliberately checklist-independent
            rules += [
                "Criteria are independent. One operator action can satisfy or break several criteria; judge "
                "each one against its own definition and never soften or skip a verdict because another "
                "criterion already covers the problem.",
                "Read definitions literally, including their logic: when a positive answer requires several "
                "elements joined by AND, every element must be present in the operator's turns; a generic "
                "courtesy phrase counts only as the element it literally is (a farewell is a farewell, not a "
                "summary or an offer of further help).",
                "A critical (gross-violation) criterion is checked on substance: if any operator turn does what "
                "one of the listed violations describes — even in other words, in any language, or as a side "
                "remark — it is a violation. For example, telling a person whose identity is not confirmed "
                "anything about a specific account or client is disclosure of confidential information.",
                "Applicability is decided from the facts of the dialog, not from what the operator chose to do: "
                "if the client's request needed a detail that was missing, clarification was required.",
            ]
    else:
        rules += ["Support each answer with a short verbatim quote from the dialog."]
    return rules


# Prompt text chosen for the current evaluation (set per task by evaluate(); None = built-in rules).
RULES: ContextVar[Optional[str]] = ContextVar("cqa_rules", default=None)


def rules_text(rules: list[str]) -> str:
    return "\n".join(f"- {r}" for r in rules)


def system_prompt(cl: Checklist, *, grounded: bool = True, rules: Optional[str] = None) -> str:
    """Editable rules (a versioned prompt from the store, or the built-in ones) + the parts that
    always come from the checklist: explanation language and business context."""
    lang = LANG_NAMES.get(cl.explain_language.lower(), cl.explain_language)
    custom = rules if rules is not None else RULES.get()
    head = custom.strip() if (grounded and custom) else rules_text(base_rules(grounded))
    ctx = f"\nBusiness context: {cl.context}" if cl.context else ""
    return head + f"\n- Write 'explanation' and 'na_reason' in {lang}, 1-2 sentences, addressed to a supervisor." + ctx


def output_schema(grounded: bool) -> str:
    if grounded:
        item = ('{"id": "<criterion id>", "reasoning": "<observations>", "answer": <answer>, '
                '"evidence": [<turn ids>], "checked_range": [<from id>, <to id>] or null, '
                '"explanation": "<why>", "na_reason": "<why N/A, else empty>", "confidence": <0..1>}')
    else:
        item = ('{"id": "<criterion id>", "answer": <answer>, "quote": "<verbatim quote or empty>", '
                '"explanation": "<why>", "na_reason": "<why N/A, else empty>"}')
    return 'Return JSON only: {"criteria": [' + item + ", ...]} with one object per criterion, in order."


def dialog_date(d: Dialog) -> str | None:
    for t in d.turns:
        if "T" in t.timestamp and len(t.timestamp) >= 10:
            return t.timestamp[:10]
    return None


def dialog_header(d: Dialog) -> str:
    date = dialog_date(d)
    when = (f"dialog date: {date}" if date else
            "dialog date: unknown — do not treat a statement that a date has or has not passed as false")
    return (f"Dialog {d.conversation_id} | channel: {d.channel} | language: {d.language} | "
            f"{len(d.turns)} turns | {when}")


def prefix_messages(cl: Checklist, d: Dialog, *, grounded: bool = True) -> list[dict]:
    """Byte-identical for every call on the same dialog → prompt-cache friendly."""
    user = dialog_header(d) + "\n\nTRANSCRIPT:\n" + render_transcript(d, with_ids=grounded)
    if d.acoustic:
        user += "\n\n" + d.acoustic
    return [
        {"role": "system", "content": system_prompt(cl, grounded=grounded)},
        {"role": "user", "content": user},
    ]


def all_criteria_messages(cl: Checklist, d: Dialog, criteria: list[Criterion], *, grounded: bool) -> list[dict]:
    body = "CHECKLIST:\n" + "\n".join(render_criterion(c) for c in criteria) + "\n\n" + output_schema(grounded)
    msgs = prefix_messages(cl, d, grounded=grounded)
    msgs[1] = {"role": "user", "content": msgs[1]["content"] + "\n\n" + body}
    return msgs


def single_criterion_messages(cl: Checklist, d: Dialog, c: Criterion) -> list[dict]:
    return prefix_messages(cl, d) + [
        {"role": "assistant", "content": "Transcript read. Send the criterion."},
        {"role": "user", "content": "CRITERION:\n" + render_criterion(c) + "\n\n" + output_schema(True)},
    ]


def repair_message(problems: dict[str, list[str]]) -> dict:
    lines = [f"- {cid}: " + "; ".join(p) for cid, p in problems.items()]
    return {"role": "user", "content":
            "Some answers violate the rules:\n" + "\n".join(lines) +
            "\nRe-check the transcript and return corrected objects for ONLY these criteria, "
            "same JSON format {\"criteria\": [...]}."}


def to_json(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)
