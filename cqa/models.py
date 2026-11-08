"""Data shapes: dialog, checklist, per-criterion result, evaluation.

Answers use one vocabulary across criterion types:
  binary -> "yes" | "no"
  scale  -> int within [scale.min, scale.max]
  any    -> "na" (only when criterion.na_allowed)
"""

from __future__ import annotations

from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, Field

Speaker = Literal["client", "operator", "bot", "system"]
Answer = Union[int, Literal["yes", "no", "na"]]


class Turn(BaseModel):
    idx: int
    speaker: Speaker
    text: str
    timestamp: str          # original value, kept verbatim
    offset_sec: float       # seconds from dialog start (player seek / display)


class Dialog(BaseModel):
    conversation_id: str
    channel: str            # "agent chat" | "voice call"
    language: str           # RU | KZ | EN
    audio_url: Optional[str] = None
    operator: Optional[str] = None      # operator id/name when the source provides it
    started_at: Optional[str] = None    # call/chat start (ISO) when the source provides it
    turns: list[Turn]
    acoustic: str = ""      # measured audio features block (filled only for audio criteria)

    @property
    def is_call(self) -> bool:
        return "call" in self.channel.lower() or bool(self.audio_url)


class Scale(BaseModel):
    min: int = 0
    max: int = 2
    steps: Optional[list[int]] = None    # allowed values, e.g. [0, 5, 10, 15, 20]; None = any int in range
    labels: dict[str, str] = Field(default_factory=dict)


class Criterion(BaseModel):
    id: str
    section: str = ""
    title: str
    description: str = ""
    type: Literal["binary", "scale"] = "binary"
    scale: Optional[Scale] = None
    weight: float = 0
    na_allowed: bool = False
    na_rule: str = ""
    critical: bool = False           # "gross error" criterion: flagged separately
    flag_on: Literal["yes", "no"] = "no"   # critical: which answer means a violation was found
    requires_audio: bool = False     # e.g. intonation/diction: N/A without audio
    deep_check: bool = False         # hybrid strategy: own call with reasoning + fact verification

    def allowed_answers(self) -> str:
        if self.type == "binary":
            base = '"yes" | "no"'
        else:
            s = self.scale or Scale()
            base = ("one of " + ", ".join(map(str, s.steps))) if s.steps else f"integer {s.min}..{s.max}"
        return base + (' | "na"' if self.na_allowed else "")


class Rounding(BaseModel):
    decimals: int = 1
    mode: Literal["half_up", "half_even", "floor", "ceil"] = "half_up"


class Checklist(BaseModel):
    id: str
    version: int = 1
    title: str = ""
    explain_language: str = "ru"
    rounding: Rounding = Rounding()
    na_policy: Literal["redistribute", "full_credit"] = "redistribute"
    gross_error_policy: Literal["flag", "zero_total"] = "flag"
    context: str = ""
    prompt_id: str = "strict"        # system prompt the checklist is evaluated with (see /prompts)
    criteria: list[Criterion]

    def by_id(self) -> dict[str, Criterion]:
        return {c.id: c for c in self.criteria}


class CriterionResult(BaseModel):
    criterion_id: str
    answer: Answer
    reasoning: str = ""
    explanation: str = ""
    evidence: list[int] = Field(default_factory=list)          # turn idx
    checked_range: Optional[list[int]] = None                  # [from, to] when action absent
    na_reason: str = ""
    confidence: Optional[float] = None
    needs_review: bool = False
    issues: list[str] = Field(default_factory=list)            # validator notes
    source: str = "ai"                                          # ai | rule | reviewer


class Evaluation(BaseModel):
    conversation_id: str
    checklist_id: str
    checklist_version: int
    strategy: str
    model: str
    prompt: str = ""                  # system prompt used, "<id> v<version>"
    results: list[CriterionResult]
    score: dict[str, Any] = Field(default_factory=dict)
    usage: dict[str, Any] = Field(default_factory=dict)
