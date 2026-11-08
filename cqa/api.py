"""HTTP API (FastAPI). UI-agnostic: any HTML page or a Dynamics 365 web resource
can drive it. Run:  uvicorn cqa.api:app --port 8030

Env: CQA_PROVIDER (default: Gemma 4 26B-A4B on GEMMA_BASE_URL), CQA_STRATEGY (grounded),
     CQA_THINKING (high), CQA_BUDGET_USD (2.0), CQA_DB (data/cqa.sqlite),
     ORGANIZER_API (base GET url; ?group_id=... is appended).
"""

from __future__ import annotations

import asyncio
import html
import os
import re
import time
from pathlib import Path
from typing import Any, Optional, Union

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import httpx

from . import export, prompts, scoring
from .prompt_presets import PRESETS
from .data import load_checklist, load_dialogs, normalize_record, records_from_payload
from .evaluate import evaluate
from .llm import Budget, default_provider, load_env, make_provider
from .models import Checklist, CriterionResult, Dialog, Evaluation
from .store import Store
from .catalog import Catalog, PROVIDERS
from .validate import coerce_answer

ROOT = Path(__file__).resolve().parents[1]
load_env(ROOT / ".env")

store = Store(os.environ.get("CQA_DB", str(ROOT / "data" / "cqa.sqlite")))
budget = Budget(float(os.environ.get("CQA_BUDGET_USD", "2.0")))
catalog = Catalog(store)
PROVIDER_SPEC = os.environ.get("CQA_PROVIDER") or default_provider()
STRATEGY = os.environ.get("CQA_STRATEGY", "grounded")
THINKING = os.environ.get("CQA_THINKING", "high")
SAMPLES = int(os.environ.get("CQA_SAMPLES", "3"))
# parallelism: calls evaluated at once, and model requests in flight (the kt-103 nginx balances them across vLLM instances)
CALLS_PARALLEL = int(os.environ.get("CQA_CALLS_PARALLEL", "12"))
LLM_PARALLEL = int(os.environ.get("CQA_LLM_PARALLEL", "32"))

_have = {c["id"] if isinstance(c, dict) else c for c in (store.checklists() or [])}
for _f in ("official.json",):                         # the organizers' official checklist
    _cl = load_checklist(ROOT / "checklists" / _f)
    if _cl.id not in _have:
        store.save_checklist(_cl.model_dump())

for _p in PRESETS:                                     # built-in system prompts (admin edits them later)
    if not store.prompt(_p["id"]):
        store.save_prompt(dict(_p), activate=True)

app = FastAPI(title="CQA — Conversation Quality Analytics", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def _ui_no_cache(request, call_next):
    """UI files revalidate on every load (ETag/304), so a new version is never hidden by the browser cache."""
    resp = await call_next(request)
    if request.url.path.startswith("/ui"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


def _provider(spec: Optional[str] = None):
    return make_provider(spec or PROVIDER_SPEC, budget=budget, thinking=THINKING,
                         cache_dir=ROOT / "runs" / "cache", concurrency=LLM_PARALLEL)


def _checklist(cid: str, version: Optional[int] = None) -> Checklist:
    body = store.checklist(cid, version)
    if not body:
        raise HTTPException(404, f"checklist {cid} not found")
    return Checklist.model_validate(body)


# ---------------------------------------------------------- providers / models
# Like OpenRouter's «Bring your own key»: pick a provider, paste a key (checked before saving),
# choose the models that may be used and the default one. Keys are never returned unmasked.
class ProviderReq(BaseModel):
    key: Optional[str] = None
    base_url: Optional[str] = None


class ModelsReq(BaseModel):
    models: list[dict]
    default: Optional[str] = None


@app.get("/providers")
def list_providers():
    return catalog.providers()


@app.put("/providers/{pid}")
async def save_provider(pid: str, req: ProviderReq):
    if pid not in PROVIDERS:
        raise HTTPException(404, "unknown provider")
    meta = PROVIDERS[pid]
    key = (req.key or "").strip() or None
    url = (req.base_url or "").strip() or None
    if not key and not meta.get("key_optional"):
        raise HTTPException(400, "Нужен API-ключ")
    if meta.get("needs_url") and not (url or catalog.creds(pid)[1]):
        raise HTTPException(400, "Нужен адрес сервера")
    try:
        await catalog.check(pid, key or catalog.creds(pid)[0], url or catalog.creds(pid)[1])
    except ValueError as e:
        raise HTTPException(400, str(e))
    catalog.save_provider(pid, key, url)
    return catalog.providers()


@app.delete("/providers/{pid}")
def remove_provider(pid: str):
    catalog.remove_provider(pid)
    return catalog.providers()


@app.get("/providers/{pid}/models")
async def provider_models(pid: str):
    if pid not in PROVIDERS:
        raise HTTPException(404, "unknown provider")
    try:
        return await catalog.provider_models(pid)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/models")
def list_models():
    return catalog.models()


@app.put("/models")
def save_models(req: ModelsReq):
    try:
        catalog.save_models(req.models, req.default)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return catalog.models()


@app.get("/health")
def health():
    d = catalog.default()
    return {"ok": True, "provider": PROVIDER_SPEC, "default_model": d["label"] if d else None, "strategy": STRATEGY,
            "spent_usd": round(budget.spent, 5), "budget_usd": budget.max_usd}


# ---------------------------------------------------------------- checklists
@app.get("/checklists")
def list_checklists():
    return store.checklists()


@app.get("/checklists/{cid}/versions")
def checklist_versions(cid: str):
    return store.checklist_versions(cid)


@app.get("/checklists/{cid}")
def get_checklist(cid: str, version: Optional[int] = None):
    return _checklist(cid, version).model_dump()


@app.put("/checklists/{cid}")
def save_checklist(cid: str, body: Checklist):
    """Saves a NEW version; older evaluations keep pointing at theirs."""
    if body.id != cid:
        raise HTTPException(400, "id in body must match the path")
    ids = [c.id for c in body.criteria]
    if len(ids) != len(set(ids)):
        raise HTTPException(400, "criterion ids must be unique")
    for c in body.criteria:
        if c.type == "scale" and (not c.scale or c.scale.max <= c.scale.min):
            raise HTTPException(400, f"criterion {c.id}: scale needs max > min")
    if not store.prompt(body.prompt_id):
        raise HTTPException(400, f"system prompt {body.prompt_id} not found")
    return store.save_checklist(body.model_dump())


# ------------------------------------------------------------ system prompts
# Admin edits and versions them; a methodologist reads them and picks one per checklist.
# (Prototype: roles are enforced in the UI only — there is no auth yet.)
class PromptReq(BaseModel):
    title: str
    description: str = ""
    text: str
    activate: bool = False


class ActivateReq(BaseModel):
    version: int


class RenderReq(BaseModel):
    checklist: Checklist
    prompt_id: Optional[str] = None
    version: Optional[int] = None


def _prompt_row(p: dict) -> dict:
    return {**p, "active_version": store.active_prompt_version(p["id"]),
            "versions": store.prompt_versions(p["id"]),
            "used_by": [c["id"] for c in store.checklists() if c.get("prompt_id", "strict") == p["id"]]}


@app.get("/prompts")
def list_prompts():
    return [_prompt_row(p) for p in store.prompts()]


@app.get("/prompts/{pid}")
def get_prompt(pid: str, version: Optional[int] = None):
    p = store.prompt(pid, version)
    if not p:
        raise HTTPException(404, f"system prompt {pid} not found")
    return _prompt_row(p)


@app.put("/prompts/{pid}")
def save_prompt(pid: str, req: PromptReq):
    """Saves a NEW version (creates the prompt when the id is new)."""
    if not re.fullmatch(r"[a-z0-9_-]{2,40}", pid):
        raise HTTPException(400, "id: 2-40 chars a-z 0-9 _ -")
    if not req.text.strip():
        raise HTTPException(400, "text is empty")
    body = store.save_prompt({"id": pid, "title": req.title, "description": req.description,
                              "text": req.text.strip()}, activate=req.activate)
    return _prompt_row(body)


@app.post("/prompts/{pid}/activate")
def activate_prompt(pid: str, req: ActivateReq):
    if not store.prompt(pid, req.version):
        raise HTTPException(404, "version not found")
    store.activate_prompt(pid, req.version)
    return _prompt_row(store.prompt(pid))


@app.post("/prompts/render")
def render_prompt(req: RenderReq):
    """The exact system message the model gets for this checklist (unsaved edits included)."""
    pid = req.prompt_id or req.checklist.prompt_id
    p = store.prompt(pid, req.version)
    if not p:
        raise HTTPException(404, f"system prompt {pid} not found")
    return {"prompt_id": pid, "version": p["version"], "title": p.get("title", pid),
            "text": prompts.system_prompt(req.checklist, rules=p["text"])}


# ------------------------------------------------------------------- dialogs
class ImportReq(BaseModel):
    source: Optional[str] = None      # URL or local path of an organizers' response
    group_id: Optional[str] = None    # uses ORGANIZER_API + ?group_id=


@app.post("/dialogs/import")
async def import_dialogs(req: ImportReq):
    src = req.source
    if not src and req.group_id:
        base = os.environ.get("ORGANIZER_API")
        if not base:
            raise HTTPException(400, "ORGANIZER_API is not configured")
        src = f"{base}{'&' if '?' in base else '?'}group_id={req.group_id}"
    if not src:
        raise HTTPException(400, "source or group_id required")
    dialogs = await asyncio.to_thread(load_dialogs, src)
    for d in dialogs:
        store.save_dialog(d.model_dump(), req.group_id or Path(src).stem)
    return {"imported": len(dialogs)}


class UploadReq(BaseModel):
    payload: Any                     # organizers' response, a list of records, or one record
    dataset: str = "upload"


@app.post("/dialogs/upload")
def upload_dialogs(req: UploadReq):
    """Transcript upload from the UI (a JSON file chosen by the user)."""
    p = req.payload
    if isinstance(p, dict) and "conversation_id" in p:
        recs = [p]
    elif isinstance(p, list):
        recs = p
    elif isinstance(p, dict):
        recs = records_from_payload(p)
    else:
        raise HTTPException(400, "unrecognised payload")
    try:
        dialogs = [normalize_record(r) for r in recs]
    except Exception as e:
        raise HTTPException(400, f"bad record: {e}")
    if not dialogs:
        raise HTTPException(400, "no records")
    for d in dialogs:
        store.save_dialog(d.model_dump(), req.dataset)
    return {"imported": len(dialogs), "ids": [d.conversation_id for d in dialogs]}


# operator who introduces themselves: «меня зовут Антон», «I'm Maya», «менің атым Айгүл», «это Ольга»
_INTRO = re.compile(r"(?:меня зовут|мое имя|моё имя|i'?m|my name is|менің атым|менің есімім|on the line is)\s+([A-ZА-ЯЁӘІҢҒҮҰҚӨҺ][a-zа-яёәіңғүұқөһ]{1,20})", re.I)


def _operator_of(d: dict) -> tuple[Optional[str], str]:
    """(name, source): from the record, else from the operator's self-introduction in the first replies."""
    if d.get("operator"):
        return d["operator"], "record"
    for t in [t for t in d.get("turns") or [] if t["speaker"] == "operator"][:3]:
        m = _INTRO.search(t["text"])
        if m and m.group(1).lower() not in ("from", "here", "the", "a", "your", "из", "ваш", "ваша", "оператор"):
            return m.group(1).capitalize(), "intro"
    return None, ""


def _call_time(d: dict) -> Optional[float]:
    """When the call happened: record field, else an absolute turn timestamp, else the upload time."""
    from datetime import datetime
    for v in [d.get("started_at")] + [t.get("timestamp") for t in (d.get("turns") or [])[:1]]:
        if v and len(str(v)) >= 10 and str(v)[4] == "-":
            try:
                return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
            except ValueError:
                pass
    return d.get("imported_at")


def _runs_by_dialog(checklist_id: str) -> dict[str, int]:
    """Newest run that evaluated each dialog (evaluations made before runs carry no run_id)."""
    out: dict[str, int] = {}
    for r in store.runs():
        if r.get("checklist_id") == checklist_id:
            for c in r.get("results") or {}:
                out.setdefault(c, r["id"])
    return out


@app.get("/dialogs")
def list_dialogs(dataset: Optional[str] = None, checklist_id: str = "official"):
    out = []
    run_of = _runs_by_dialog(checklist_id)
    for d in store.dialogs(dataset):
        ev = store.evaluation(d["conversation_id"], checklist_id)
        out.append({"conversation_id": d["conversation_id"], "channel": d["channel"],
                    "language": d["language"], "dataset": d["dataset"], "turns": len(d["turns"]),
                    "has_audio": bool(d.get("audio_url")),
                    "total": ev["final"]["score"]["total"] if ev else None,
                    "gross_error": ev["final"]["score"]["gross_error"] if ev else None,
                    "imported_at": d.get("imported_at"),
                    "operator": (op := _operator_of(d))[0], "operator_source": op[1], "call_at": _call_time(d),
                    "run_id": (ev.get("run_id") or run_of.get(d["conversation_id"])) if ev else None,
                    "evaluated_at": store.evaluation_time(d["conversation_id"], checklist_id) if ev else None,
                    "appealed": bool(aps := [a for a in store.appeals(cid=d["conversation_id"]) if _appeal_of(a, ev)]),
                    # pending while any appeal awaits a decision; decided once all are resolved
                    "appeal_state": (None if not aps else
                                     "pending" if any(a["status"] == "pending" for a in aps) else "decided")})
    return out


@app.get("/dialogs/{cid}")
def get_dialog(cid: str):
    d = store.dialog(cid)
    if not d:
        raise HTTPException(404)
    return d


@app.get("/dialogs/{cid}/audio")
async def dialog_audio(cid: str):
    """The organizers' audio_url is an HTML player page holding a short-lived signed mp3 link.
    Resolve it on demand and redirect, so the UI's own <audio> can seek to evidence turns."""
    d = store.dialog(cid)
    if not d or not d.get("audio_url"):
        raise HTTPException(404, "no recording")
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as cli:
            r = await cli.get(d["audio_url"])
    except httpx.HTTPError as e:
        raise HTTPException(502, f"recording page unavailable: {e!r}")
    if r.headers.get("content-type", "").startswith("audio/"):
        return RedirectResponse(d["audio_url"])
    m = re.search(r'<source[^>]+src="([^"]+)"', r.text) or re.search(r'<audio[^>]+src="([^"]+)"', r.text)
    if not m:
        raise HTTPException(502, "no audio source on the recording page")
    return RedirectResponse(html.unescape(m.group(1)))


# --------------------------------------------------------------- evaluation runs
# «Оценить» enqueues a run and returns at once; one worker takes runs in order. Every run keeps a
# snapshot of its own results, so its statistics survive later re-evaluations of the same dialogs.
class EvalReq(BaseModel):
    conversation_ids: Optional[list[str]] = None   # None = all imported
    checklist_id: str = "official"
    strategy: Optional[str] = None
    model_id: Optional[str] = None                 # a model from /models (the UI sends this)
    provider: Optional[str] = None                 # raw provider spec (scripts); default: the catalog default
    concurrency: int = CALLS_PARALLEL
    wait: bool = False                             # scripts: block until the run is finished


ACTIVE = ("queued", "running")
_queue: Optional[asyncio.Queue] = None
_params: dict[int, EvalReq] = {}                    # provider/strategy/concurrency of queued runs


def _row(cid: str, ev: dict, run_id: Optional[int] = None) -> dict:
    """Compact per-dialog row (shared by /evaluations and run snapshots)."""
    d = store.dialog(cid) or {}
    return {"conversation_id": cid, "channel": d.get("channel"), "language": d.get("language"),
            "turns": len(d.get("turns") or []), "has_audio": bool(d.get("audio_url")),
            "checklist_version": ev["checklist_version"], "run_id": run_id or ev.get("run_id"),
            "eval_id": ev.get("eval_id"), "eval_no": ev.get("eval_no"),
            "model": ev["original"].get("model"), "prompt": ev["original"].get("prompt") or "strict v1",
            "total": ev["final"]["score"]["total"], "original_total": ev["original"]["score"]["total"],
            "gross_error": ev["final"]["score"]["gross_error"],
            "answers": {r["criterion_id"]: r["answer"] for r in ev["final"]["results"]},
            "original_answers": {r["criterion_id"]: r["answer"] for r in ev["original"]["results"]},
            "needs_review": sum(1 for r in ev["final"]["results"] if r.get("needs_review")),
            "cost_usd": (ev["original"].get("usage") or {}).get("cost_usd"),
            "tokens_in": (ev["original"].get("usage") or {}).get("prompt_tokens"),
            "tokens_out": (ev["original"].get("usage") or {}).get("completion_tokens"),
            "wall_s": (ev["original"].get("usage") or {}).get("wall_s")}


# Self-hosted models cost nothing per call; to compare runs we price them at OpenRouter's rate for the
# same model ($ per 1M tokens, checked 2026-11-07). Rows without token counts use the measured average.
OPENROUTER_PRICE = {"gemma-4-26b": (0.0675, 0.225)}
AVG_TOKENS = (2923 * 3, 8792 * 3)      # Gemma, grounded, 3-sample vote (runs/dev_kt_gemma.json × 3)


def _run_cost(run: dict, rows: list[dict]) -> tuple[float, bool]:
    """(USD, estimated?) — real provider cost when it was billed, else an OpenRouter-price estimate."""
    real = sum(r.get("cost_usd") or 0 for r in rows)
    if real > 0:
        return round(real, 5), False
    model = str(run.get("model_spec") or run.get("model") or "").lower()
    price = next((v for k, v in OPENROUTER_PRICE.items() if k in model), None)
    if not price:
        return 0.0, False
    usd = sum(((r.get("tokens_in") or AVG_TOKENS[0]) * price[0] + (r.get("tokens_out") or AVG_TOKENS[1]) * price[1]) / 1e6
              for r in rows)
    return round(usd, 5), True


def _summary(run: dict) -> dict:
    """List view of a run: everything but the per-dialog snapshot, plus aggregates."""
    rows = list((run.get("results") or {}).values())
    totals = [r["total"] for r in rows if r.get("total") is not None]
    out = {k: v for k, v in run.items() if k != "results"}
    out.update(n_total=len(run.get("conversation_ids") or []), n_done=len(rows), n_failed=len(run.get("failed") or {}),
               avg_total=round(sum(totals) / len(totals), 2) if totals else None,
               gross=sum(1 for r in rows if r.get("gross_error")))
    out["cost_usd"], out["cost_estimated"] = _run_cost(run, rows)
    return out


async def _execute(rid: int) -> None:
    run = store.run(rid)
    req = _params.pop(rid, None) or EvalReq(conversation_ids=run["conversation_ids"], checklist_id=run["checklist_id"],
                                            model_id=run.get("model_id"), provider=run.get("provider_spec"))
    cl = _checklist(run["checklist_id"], run["checklist_version"])
    sp = store.prompt(run["prompt_id"], run["prompt_version"]) or store.prompt("strict")
    provider = (catalog.make(req.model_id, budget=budget, thinking=THINKING, cache_dir=ROOT / "runs" / "cache",
                             concurrency=LLM_PARALLEL)
                if req.model_id else _provider(req.provider))
    run.update(status="running", started_at=time.time(), model_spec=getattr(provider, "name", None),
               model=getattr(provider, "label", None) or getattr(provider, "name", run.get("model")))
    store.update_run(run)
    sem = asyncio.Semaphore(max(1, req.concurrency))
    lock = asyncio.Lock()

    async def one(cid: str) -> None:
        body = store.dialog(cid)
        try:
            if not body:
                raise ValueError("dialog not imported")
            async with sem:
                ev = await evaluate(provider, cl, Dialog.model_validate(body), strategy=req.strategy or STRATEGY,
                                    samples=SAMPLES, rules=sp["text"], prompt_label=f"{sp['id']} v{sp['version']}")
            async with lock:                    # number the evaluations of a call in order
                no = store.next_eval_no(cid, cl.id)
                store.save_history({"eval_id": f"{cid}#{no}", "conversation_id": cid, "checklist_id": cl.id,
                                    "checklist_version": cl.version, "run_id": rid, "eval_no": no, "pending": True})
            doc = {"conversation_id": cid, "checklist_id": cl.id, "checklist_version": cl.version, "run_id": rid,
                   "eval_id": f"{cid}#{no}", "eval_no": no, "created_at": time.time(),
                   "original": ev.model_dump(), "final": {"results": [r.model_dump() for r in ev.results],
                                                           "score": ev.score}, "decisions": []}
            store.save_evaluation(cid, cl.id, doc)
            store.save_history(doc)
            async with lock:
                run["results"][cid] = _row(cid, doc, rid)
                store.update_run(run)
        except Exception as e:  # one broken dialog must not stop the run
            async with lock:
                run["failed"][cid] = repr(e)[:300]
                store.update_run(run)

    await asyncio.gather(*[one(c) for c in run["conversation_ids"]])
    run.update(status="failed" if run["failed"] and not run["results"] else "done", finished_at=time.time())
    store.update_run(run)


async def _worker() -> None:
    while True:
        rid = await _queue.get()
        try:
            await _execute(rid)
        except Exception as e:
            run = store.run(rid) or {"id": rid}
            run.update(status="failed", error=repr(e)[:300], finished_at=time.time())
            store.update_run(run)
        finally:
            _queue.task_done()


@app.on_event("startup")
async def _start_worker() -> None:
    global _queue
    _queue = asyncio.Queue()
    for run in reversed(store.runs(list(ACTIVE))):   # oldest first
        if run["status"] == "running":                # the server stopped mid-run
            run.update(status="failed", error="прервано перезапуском сервера", finished_at=time.time())
            store.update_run(run)
        else:
            _queue.put_nowait(run["id"])
    asyncio.get_running_loop().create_task(_worker())


def _backfill_runs() -> None:
    """Evaluations made before runs existed become «imported» runs: one per checklist × model × prompt."""
    if store.runs():
        return
    for c in store.checklists():
        groups: dict[tuple, list] = {}
        for e in store.evaluations_latest(c["id"]):
            o = e["original"]
            groups.setdefault((o.get("model") or "?", o.get("prompt") or "strict v1"), []).append(e)
        for (model, prompt), evs in sorted(groups.items(), key=lambda kv: min(e.get("updated_at") or 0 for e in kv[1])):
            pid, _, pv = prompt.partition(" ")
            times = [e.get("updated_at") or time.time() for e in evs]
            store.create_run({
                "status": "done", "source": "import", "checklist_id": c["id"],
                "checklist_version": max(e["checklist_version"] for e in evs), "checklist_title": c.get("title") or c["id"],
                "prompt_id": pid, "prompt_version": int(pv.lstrip("v") or 1), "model": model,
                "strategy": evs[0]["original"].get("strategy"),
                "conversation_ids": [e["conversation_id"] for e in evs], "failed": {},
                "results": {e["conversation_id"]: _row(e["conversation_id"], e) for e in evs},
                "created_at": min(times), "started_at": min(times), "finished_at": max(times)})


_backfill_runs()


def _backfill_history() -> None:
    """Gives every existing evaluation an id and a place in the call's history:
    - the original DeepSeek evaluations (data/seed) that were later replaced,
    - evaluations known only from a run snapshot (answers and totals, no comments),
    - the current evaluation.
    Appeals made before this are attached to the evaluation that was current when they were filed."""
    if store.setting("history_v1"):
        return
    seed_path = ROOT / "data" / "seed" / "dev_evaluations.json"
    seed = {}
    if seed_path.exists():
        import json as _json
        seed = {e["conversation_id"]: e for e in _json.loads(seed_path.read_text(encoding="utf-8"))}
    runs = sorted(store.runs(), key=lambda r: r["created_at"])
    seed_run = next((r for r in runs if r.get("source") == "import" and "deepseek" in str(r.get("model")).lower()), None)
    for c in store.checklists():
        cl = Checklist.model_validate(c)
        run_of = _runs_by_dialog(cl.id)
        for cur in store.evaluations_latest(cl.id):
            cid = cur["conversation_id"]
            cur_run = cur.get("run_id") or run_of.get(cid)
            docs = []
            # 1) the original evaluation from the seed, if the current one replaced it
            cur_is_seed = ("deepseek" in str(cur["original"].get("model")).lower() and not cur.get("run_id")) or (
                cid in seed and (seed[cid].get("model"), seed[cid].get("prompt")) == (cur["original"].get("model"), cur["original"].get("prompt")))
            if cid in seed and seed[cid].get("checklist_id") == cl.id and not cur_is_seed:
                e = Evaluation.model_validate(seed[cid])
                e.checklist_version = cur["checklist_version"]
                e.score = scoring.compute(cl, e.results)
                docs.append({"conversation_id": cid, "checklist_id": cl.id, "checklist_version": e.checklist_version,
                             "run_id": seed_run["id"] if seed_run and cid in seed_run["results"] else None,
                             "original": e.model_dump(), "decisions": [],
                             "final": {"results": [r.model_dump() for r in e.results], "score": e.score},
                             "created_at": seed_run["created_at"] if seed_run else (cur.get("updated_at") or time.time()) - 1})
            # 2) other runs that evaluated this call (only their snapshot survives)
            for r in runs:
                if cid not in r["results"] or r["id"] == cur_run or (seed_run and r["id"] == seed_run["id"] and docs):
                    continue
                row = r["results"][cid]
                res = [{"criterion_id": k, "answer": v, "source": "ai",
                        "explanation": "Комментарии этой оценки не сохранились — есть только ответы и итог"}
                       for k, v in row["answers"].items()]
                docs.append({"conversation_id": cid, "checklist_id": cl.id, "checklist_version": row["checklist_version"],
                             "run_id": r["id"], "partial": True, "decisions": [],
                             "original": {"model": r.get("model"), "prompt": f"{r.get('prompt_id')} v{r.get('prompt_version')}",
                                          "results": res, "score": {"total": row["total"], "gross_error": row["gross_error"]}},
                             "final": {"results": res, "score": {"total": row["total"], "gross_error": row["gross_error"]}},
                             "created_at": r.get("started_at") or r["created_at"]})
            # 3) the current one
            docs.append({**cur, "run_id": cur_run, "created_at": cur.get("created_at") or cur.get("updated_at") or time.time()})
            docs.sort(key=lambda d: d["created_at"])
            for i, d in enumerate(docs, 1):
                d.update(eval_id=f"{cid}#{i}", eval_no=i)
                d.pop("updated_at", None)
                store.save_history(d)
            store.save_evaluation(cid, cl.id, docs[-1])
            # appeals: the evaluation that was current when the appeal was filed
            for a in store.appeals(cid=cid):
                if a.get("eval_id") or a["checklist_id"] != cl.id:
                    continue
                before = [d for d in docs if d["created_at"] <= a["created_at"]] or docs[:1]
                target = before[-1]
                dec = a.get("decision")
                if dec and not any(x.get("appeal_id") == a["id"] for x in target["decisions"]):
                    target["decisions"].append(dec)
                    store.save_history(target)
                    if target is docs[-1]:
                        store.save_evaluation(cid, cl.id, target)
                body = {k: a[k] for k in ("disputed", "fragment", "checklist_version", "decision") if k in a}
                store.set_appeal_body(a["id"], {**body, "eval_id": target["eval_id"]})
    store.set_setting("history_v1", True)


_backfill_history()


@app.post("/evaluate")
async def run_evaluation(req: EvalReq):
    cl = _checklist(req.checklist_id)
    ids = req.conversation_ids or [d["conversation_id"] for d in store.dialogs()]
    if not ids:
        raise HTTPException(400, "no dialogs to evaluate")
    sp = store.prompt(cl.prompt_id) or store.prompt("strict")
    if not req.model_id and not req.provider:          # no choice → the default model from the catalog
        d = catalog.default()
        req.model_id = d["id"] if d else None
    label = PROVIDER_SPEC
    if req.model_id:
        m = next((x for x in catalog.models() if x["id"] == req.model_id), None)
        if not m:
            raise HTTPException(400, f"модель {req.model_id} не найдена")
        if not m["usable"]:
            raise HTTPException(400, f"провайдер «{m['provider_title']}» не подключён")
        label = m["label"]
    elif req.provider:
        label = req.provider
    run = store.create_run({
        "status": "queued", "source": "ui", "checklist_id": cl.id, "checklist_version": cl.version,
        "checklist_title": cl.title or cl.id, "prompt_id": sp["id"], "prompt_version": sp["version"],
        "model": label, "model_id": req.model_id, "provider_spec": req.provider,
        "strategy": req.strategy or STRATEGY, "samples": SAMPLES,
        "conversation_ids": list(dict.fromkeys(ids)), "failed": {}, "results": {}})
    _params[run["id"]] = req
    ahead = sum(1 for r in store.runs(list(ACTIVE)) if r["id"] < run["id"])
    _queue.put_nowait(run["id"])
    if req.wait:
        while (store.run(run["id"]) or {}).get("status") in ACTIVE:
            await asyncio.sleep(1)
        return _summary(store.run(run["id"]))
    return {**_summary(run), "ahead": ahead}


@app.get("/runs")
def list_runs(active: bool = False, checklist_id: Optional[str] = None):
    runs = store.runs(list(ACTIVE) if active else None)
    if checklist_id:
        runs = [r for r in runs if r.get("checklist_id") == checklist_id]
    out = []
    for r in runs:
        sm = _summary(r)
        if active:   # the queue page needs to know which dialogs are still waiting
            sm["pending_ids"] = [c for c in r["conversation_ids"] if c not in r["results"] and c not in r["failed"]]
        out.append(sm)
    return out


@app.get("/runs/{rid}")
def get_run(rid: int):
    run = store.run(rid)
    if not run:
        raise HTTPException(404, "run not found")
    return {**_summary(run), "rows": list(run["results"].values()), "failed": run.get("failed") or {}}


@app.get("/evaluations")
def list_evaluations(checklist_id: str = "official", all: bool = False):
    """Compact rows: the latest evaluation of each call, or with ?all=1 every evaluation ever made
    (one row per evaluation instance, newest first)."""
    appeals = store.appeals()
    run_of = _runs_by_dialog(checklist_id)
    latest = {e["conversation_id"]: e.get("eval_id") for e in store.evaluations_latest(checklist_id)}
    source = ([{**h, "updated_at": h.get("created_at")} for h in store.history_all(checklist_id) if not h.get("pending")]
              if all else store.evaluations_latest(checklist_id))
    out = []
    for ev in source:
        cid = ev["conversation_id"]
        ev = {**ev, "run_id": ev.get("run_id") or (run_of.get(cid) if not all else None)}
        mine = [a for a in appeals if a["conversation_id"] == cid and _appeal_of(a, ev)]
        out.append({**_row(cid, ev), "dataset": None, "updated_at": ev.get("updated_at"),
                    "is_latest": ev.get("eval_id") == latest.get(cid), "partial": bool(ev.get("partial")),
                    "sources": {r["criterion_id"]: r.get("source", "ai") for r in ev["final"]["results"]},
                    "decisions": len(ev.get("decisions") or []),
                    "appeals": {"pending": sum(a["status"] == "pending" for a in mine), "total": len(mine),
                                # outcome per appeal: the list shows what changed, not only that something did
                                "items": [{"id": a["id"], "criterion_id": a["criterion_id"], "status": a["status"],
                                           "before": a["disputed"]["answer"],
                                           "after": (a.get("decision") or {}).get("answer_after")} for a in mine]}})
    return out


@app.get("/export")
def export_results(checklist_id: str = "official", team: str = "VibeTeam", dataset: Optional[str] = None):
    """Organizers' submission format (results.json) from the FINAL results, reviewer decisions included.
    ?dataset=<group_id> limits it to one imported set (e.g. DEV or the control set); a dialog of that set
    with no finished evaluation goes in as status "error" so nothing is silently dropped."""
    cl = _checklist(checklist_id)
    want = [d["conversation_id"] for d in store.dialogs(dataset)] if dataset else None
    evs = [ev for ev in store.evaluations_latest(checklist_id) if want is None or ev["conversation_id"] in want]
    recs, ids = [], []
    for ev in evs:
        ecl = _checklist(checklist_id, ev["checklist_version"])
        e = Evaluation(conversation_id=ev["conversation_id"], checklist_id=checklist_id,
                       checklist_version=ev["checklist_version"], strategy=ev["original"].get("strategy", ""),
                       model=ev["original"].get("model", ""),
                       results=[CriterionResult.model_validate(r) for r in ev["final"]["results"]],
                       score=ev["final"]["score"])
        recs.append(export.record(ecl, e))
        ids.append(ev["conversation_id"])
    for cid in want or []:
        if cid not in ids:
            recs.append({"conversation_id": cid, "status": "error", "criteria": [], "score": None,
                         "error": "Оценка не получена"})
            ids.append(cid)
    # model names actually used; a vLLM path (/models/…) means our own server → "local"
    used = sorted({str(ev["original"].get("model") or "") for ev in evs} - {""})
    clean = lambda m: re.sub(r"\[.*?\]$", "", m).removeprefix("/models/")
    local = [m.startswith("/models/") for m in used]
    mode = "local" if local and all(local) else "hybrid" if any(local) else "external_api"
    doc = export.document(recs, team=team, model_name=", ".join(dict.fromkeys(clean(m) for m in used)) or PROVIDER_SPEC,
                          mode=mode)
    return {**doc, "_check": export.check(doc, cl, want if want is not None else ids)}


@app.get("/evaluations/{cid}")
def get_evaluation(cid: str, checklist_id: str = "official", eval_id: Optional[str] = None,
                   version: Optional[int] = None):
    """The current evaluation of a call, or ?eval_id=<call>#<n> for any earlier one."""
    current = store.evaluation(cid, checklist_id)
    ev = store.history(eval_id) if eval_id else store.evaluation(cid, checklist_id, version)
    if not ev or ev.get("pending"):
        raise HTTPException(404, "not evaluated")
    hist = [h for h in store.history_list(cid, checklist_id) if not h.get("pending")]
    runs = {r["id"]: r for r in store.runs()}
    return {**ev, "dialog": store.dialog(cid),
            "appeals": [a for a in store.appeals(cid=cid) if _appeal_of(a, ev)],
            "is_latest": bool(current) and ev.get("eval_id") == current.get("eval_id"),
            "latest_eval_id": current.get("eval_id") if current else None,
            "history": [{"eval_id": h["eval_id"], "eval_no": h.get("eval_no"), "created_at": h.get("created_at"),
                         "run_id": h.get("run_id"), "checklist_version": h["checklist_version"],
                         "total": h["final"]["score"]["total"], "gross_error": h["final"]["score"]["gross_error"],
                         "model": (runs.get(h.get("run_id")) or {}).get("model") or h["original"].get("model"),
                         "prompt": h["original"].get("prompt") or "strict v1",
                         "latest": bool(current) and h["eval_id"] == current.get("eval_id"),
                         "appeals": sum(1 for a in store.appeals(cid=cid) if a.get("eval_id") == h["eval_id"])}
                        for h in hist]}


# ------------------------------------------------------------------- appeals
class AppealReq(BaseModel):
    eval_id: Optional[str] = None                # which evaluation is disputed (default: the current one)
    conversation_id: str
    criterion_id: str
    comment: str
    checklist_id: str = "official"


def _appeal_of(a: dict, ev: Optional[dict]) -> bool:
    """An appeal disputes one evaluation (by eval_id)."""
    return bool(ev) and a.get("eval_id") == ev.get("eval_id")


@app.post("/appeals")
def create_appeal(req: AppealReq):
    ev = store.history(req.eval_id) if req.eval_id else store.evaluation(req.conversation_id, req.checklist_id)
    if not ev:
        raise HTTPException(404, "evaluation not found")
    cur = next((r for r in ev["final"]["results"] if r["criterion_id"] == req.criterion_id), None)
    if not cur:
        raise HTTPException(400, "unknown criterion")
    if any(a["status"] == "pending" and a["criterion_id"] == req.criterion_id and _appeal_of(a, ev)
           for a in store.appeals(cid=req.conversation_id)):
        raise HTTPException(409, "an appeal on this criterion is already pending")
    if not req.comment.strip():
        raise HTTPException(400, "comment is required")
    dialog = store.dialog(req.conversation_id)
    cited = sorted(set(cur.get("evidence") or []) |
                   set(range(*(lambda r: (r[0], r[1] + 1))(cur["checked_range"]))) if cur.get("checked_range") else
                   set(cur.get("evidence") or []))
    fragment = [t for t in dialog["turns"] if t["idx"] in cited]
    aid = store.create_appeal(req.conversation_id, req.checklist_id, req.criterion_id, req.comment,
                              {"disputed": cur, "fragment": fragment, "eval_id": ev.get("eval_id"),
                               "checklist_version": ev["checklist_version"]})
    return store.appeal(aid)


@app.get("/appeals")
def list_appeals(status: Optional[str] = None):
    out, cur = [], {}
    for a in store.appeals(status=status):
        k = (a["conversation_id"], a["checklist_id"])
        if k not in cur:
            cur[k] = (store.evaluation(*k) or {}).get("eval_id")
        h = store.history(a["eval_id"]) if a.get("eval_id") else None
        out.append({**a, "eval_no": (h or {}).get("eval_no"), "eval_latest": a.get("eval_id") == cur[k]})
    return out


class DecisionReq(BaseModel):
    action: str                                  # "confirm" | "change"
    reason: str
    new_answer: Optional[Union[int, str]] = None
    reviewer: str = "reviewer"


@app.post("/appeals/{aid}/decision")
def decide(aid: int, req: DecisionReq):
    ap = store.appeal(aid)
    if not ap:
        raise HTTPException(404)
    if ap["status"] != "pending":
        raise HTTPException(409, f"appeal already {ap['status']}")
    if not req.reason.strip():
        raise HTTPException(400, "reason is required")
    ev = (store.history(ap["eval_id"]) if ap.get("eval_id") else None) or \
        store.evaluation(ap["conversation_id"], ap["checklist_id"], ap.get("checklist_version"))
    cl = _checklist(ap["checklist_id"], ev["checklist_version"])
    crit = cl.by_id()[ap["criterion_id"]]
    before = ev["final"]["score"]["total"]

    if req.action == "change":
        ans, issues = coerce_answer(crit, req.new_answer)
        if issues:
            raise HTTPException(400, "; ".join(issues))
        if str(ans) == str(ap["disputed"]["answer"]):
            raise HTTPException(400, "new answer equals the disputed one: use confirm")
        results = []
        for r in ev["final"]["results"]:
            if r["criterion_id"] == crit.id:
                r = {**r, "answer": ans, "source": "reviewer",
                     "explanation": f"Изменено проверяющим: {req.reason}", "needs_review": False}
            results.append(r)
        ev["final"]["results"] = results
        ev["final"]["score"] = scoring.compute(cl, [CriterionResult.model_validate(r) for r in results])
        status = "changed"
    elif req.action == "confirm":
        status = "confirmed"
    else:
        raise HTTPException(400, "action must be confirm or change")

    decision = {"appeal_id": aid, "criterion_id": crit.id, "action": req.action, "reason": req.reason,
                "reviewer": req.reviewer, "answer_before": ap["disputed"]["answer"],
                "answer_after": req.new_answer if req.action == "change" else ap["disputed"]["answer"],
                "total_before": before, "total_after": ev["final"]["score"]["total"]}
    ev["decisions"].append(decision)
    if ev.get("eval_id"):
        store.save_history(ev)
    current = store.evaluation(ap["conversation_id"], ap["checklist_id"])
    if not ev.get("eval_id") or (current and current.get("eval_id") == ev["eval_id"]):
        store.save_evaluation(ap["conversation_id"], ap["checklist_id"], ev)
    store.update_appeal(aid, status, {"disputed": ap["disputed"], "fragment": ap["fragment"], "eval_id": ap.get("eval_id"),
                                      "checklist_version": ev["checklist_version"], "decision": decision})
    return {"appeal": store.appeal(aid), "original_total": ev["original"]["score"]["total"],
            "final_total": ev["final"]["score"]["total"]}


# ------------------------------------------------------------------------ UI
# Plain HTML/CSS/JS (no build step) so the same files can become a Dynamics 365 web resource.
_WEB = ROOT / "web"
if _WEB.exists():
    app.mount("/ui", StaticFiles(directory=str(_WEB), html=True), name="ui")

    @app.get("/", include_in_schema=False)
    def _root():
        return RedirectResponse("/ui/")
