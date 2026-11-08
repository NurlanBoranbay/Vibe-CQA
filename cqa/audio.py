"""Acoustic evidence for criteria that need sound (intonation, tempo, diction).

The model cannot hear; we measure and hand it numbers it can reason over,
each tied to a turn id so evidence still links into the player.

Two tiers:
  timing   (always for calls, from ISO timestamps): per operator turn, words per
           minute over the turn's slot, client→operator response latency, long
           operator silences. Rough (a slot includes pauses), but free.
  prosody  (if `librosa` is installed and audio_url is fetchable): per operator
           turn — pitch median/range (semitones), pitch variability (flat vs
           lively), RMS loudness, speaking-rate proxy (voiced-onset rate).
           Segments are cut by transcript timestamps, so only the operator is
           measured, never the client.

Criteria with requires_audio=True are answered N/A on chats by rule (evaluate.py).
"""

from __future__ import annotations

import io
from typing import Any, Optional

from .models import Dialog


def timing_features(d: Dialog) -> list[dict[str, Any]]:
    feats = []
    turns = d.turns
    for i, t in enumerate(turns):
        if t.speaker != "operator":
            continue
        nxt = turns[i + 1].offset_sec if i + 1 < len(turns) else None
        slot = (nxt - t.offset_sec) if nxt is not None else None
        words = len(t.text.split())
        f: dict[str, Any] = {"turn": t.idx, "words": words}
        if slot and slot > 0.5:
            f["wpm_upper_bound"] = round(60 * words / slot)
        prev_client = next((p for p in reversed(turns[:i]) if p.speaker == "client"), None)
        if prev_client is not None:
            f["latency_after_client_s"] = round(t.offset_sec - prev_client.offset_sec, 1)
        feats.append(f)
    return feats


def _prosody(audio_bytes: bytes, d: Dialog) -> list[dict[str, Any]]:
    import librosa  # optional dependency
    import numpy as np

    y, sr = librosa.load(io.BytesIO(audio_bytes), sr=16000, mono=True)
    out = []
    turns = d.turns
    for i, t in enumerate(turns):
        if t.speaker != "operator":
            continue
        start = t.offset_sec
        end = turns[i + 1].offset_sec if i + 1 < len(turns) else len(y) / sr
        seg = y[int(start * sr): int(end * sr)]
        if len(seg) < sr // 2:
            continue
        f0, voiced, _ = librosa.pyin(seg, fmin=65, fmax=400, sr=sr)
        f0 = f0[~np.isnan(f0)]
        rms = librosa.feature.rms(y=seg)[0]
        onsets = librosa.onset.onset_detect(y=seg, sr=sr)
        row: dict[str, Any] = {"turn": t.idx,
                               "loudness_db": round(float(20 * np.log10(np.mean(rms) + 1e-9)), 1),
                               "onsets_per_s": round(len(onsets) / (len(seg) / sr), 2)}
        if len(f0) > 10:
            st = 12 * np.log2(f0 / np.median(f0))
            row["pitch_median_hz"] = round(float(np.median(f0)))
            row["pitch_range_st"] = round(float(np.percentile(st, 95) - np.percentile(st, 5)), 1)
            row["pitch_std_st"] = round(float(np.std(st)), 2)  # < ~1.5 st reads as monotone
        out.append(row)
    return out


def features_block(d: Dialog, audio_bytes: Optional[bytes] = None) -> tuple[str, bool]:
    """(text block for the prompt, prosody_available). ('', False) for chats.

    Without measured prosody the caller must not let the model judge
    intonation: timing alone cannot show tone, and the model will happily
    invent "acoustic evidence" if asked.
    """
    if not d.is_call:
        return "", False
    lines = ["ACOUSTIC MEASUREMENTS (operator turns only; machine-measured, approximate):"]
    for f in timing_features(d):
        lines.append("  timing " + ", ".join(f"{k}={v}" for k, v in f.items()))
    ok = False
    if audio_bytes:
        try:
            rows = _prosody(audio_bytes, d)
            for f in rows:
                lines.append("  prosody " + ", ".join(f"{k}={v}" for k, v in f.items()))
            lines.append("  guide: pitch_std_st < 1.5 → monotone; loudness jumps > 6 dB → raised voice; "
                         "wpm_upper_bound > 180 → rushed.")
            ok = bool(rows)
        except Exception:  # librosa missing or audio unreadable
            ok = False
    return "\n".join(lines), ok


def fetch_audio(url: str, timeout: float = 60) -> Optional[bytes]:
    import httpx
    try:
        r = httpx.get(url, timeout=timeout, follow_redirects=True)
        r.raise_for_status()
        return r.content
    except Exception:
        return None
