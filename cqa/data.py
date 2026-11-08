"""Load dialogs from the organizers' API / a saved response, and checklists.

Organizers' format (guide p.3):
  {"isSuccess": true, "data": {"records": [{conversation_id, channel, language,
   transcript: [{timestamp, speaker, text}], audio_url}]}}
Chats use MM:SS timestamps, calls ISO 8601 with timezone. Timestamps are kept
verbatim; offset_sec is derived for display and player seeking.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import httpx

from .models import Checklist, Dialog, Turn

_SPEAKERS = {
    "client": "client", "customer": "client", "user": "client", "клиент": "client",
    "operator": "operator", "agent": "operator", "оператор": "operator",
    "bot": "bot", "бот": "bot", "assistant": "bot",
    "system": "system", "система": "system",
}


def _to_seconds(ts: str) -> float | None:
    ts = (ts or "").strip()
    if not ts:
        return None
    if "T" in ts or (len(ts) > 8 and "-" in ts):
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    parts = ts.split(":")
    try:
        nums = [float(p) for p in parts]
    except ValueError:
        return None
    sec = 0.0
    for n in nums:
        sec = sec * 60 + n
    return sec


def normalize_record(rec: dict[str, Any]) -> Dialog:
    raw = rec.get("transcript") or []
    if isinstance(raw, str):  # defensive: guide says it is already an array
        raw = json.loads(raw)
    absolute = [_to_seconds(str(t.get("timestamp", ""))) for t in raw]
    known = [a for a in absolute if a is not None]
    base = min(known) if known else 0.0
    turns = []
    last = 0.0
    for i, t in enumerate(raw):
        a = absolute[i]
        off = (a - base) if a is not None else last
        last = off
        spk = _SPEAKERS.get(str(t.get("speaker", "")).strip().lower(), "client")
        turns.append(Turn(idx=i, speaker=spk, text=str(t.get("text") or ""),
                          timestamp=str(t.get("timestamp", "")), offset_sec=round(off, 2)))
    return Dialog(
        conversation_id=str(rec.get("conversation_id")),
        channel=str(rec.get("channel") or ""),
        language=str(rec.get("language") or "").upper(),
        audio_url=rec.get("audio_url") or None,
        operator=next((str(rec[k]) for k in ("operator", "operator_name", "operator_id", "agent", "agent_name", "agent_id")
                       if rec.get(k)), None),
        started_at=next((str(rec[k]) for k in ("started_at", "start_time", "created_at", "date", "datetime")
                         if rec.get(k)), None),
        turns=turns,
    )


def records_from_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    if "data" in payload and isinstance(payload["data"], dict):
        if payload.get("isSuccess") is False:
            raise ValueError(f"API error: {payload.get('error')}")
        return payload["data"].get("records") or []
    if "records" in payload:
        return payload["records"]
    if isinstance(payload, list):
        return payload
    raise ValueError("unrecognised dataset payload")


def load_dialogs(source: str) -> list[Dialog]:
    """`source` is a path to a saved JSON response or an http(s) GET URL."""
    if source.startswith("http"):
        r = httpx.get(source, timeout=60)
        r.raise_for_status()
        payload = r.json()
    else:
        payload = json.loads(Path(source).read_text(encoding="utf-8"))
    return [normalize_record(r) for r in records_from_payload(payload)]


def load_checklist(path: str | Path) -> Checklist:
    return Checklist.model_validate_json(Path(path).read_text(encoding="utf-8"))


def select(dialogs: Iterable[Dialog], ids: list[str] | None) -> list[Dialog]:
    if not ids:
        return list(dialogs)
    wanted = set(ids)
    return [d for d in dialogs if d.conversation_id in wanted]
