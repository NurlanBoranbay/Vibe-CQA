# CQA — Conversation Quality Analytics (engine + API)

Scores an operator's work in a chat or call against a configurable checklist,
with per-criterion answer, points, weight, explanation and **turn-level evidence**,
N/A handling with weight redistribution, a separately flagged gross error,
section scores, and an appeal → reviewer decision → recalculation flow.

The UI is intentionally not here: everything is an HTTP API (CORS open) so an
HTML page or a Dynamics 365 web resource can sit on top.

## Run

```bash
pip install fastapi uvicorn httpx pydantic          # librosa optional (prosody for intonation)
cp .env.example .env                                  # put DEEPSEEK_API_KEY=...
python -m cqa.seed                                    # DEV dialogs + already-computed evaluations, no model calls
uvicorn cqa.api:app --port 8030                       # UI: http://localhost:8030/  · Swagger: /docs
```

## UI

`web/` holds plain HTML, CSS and JavaScript with no build step, served at `/ui/`. To use it as a
Dynamics 365 HTML web resource, upload `web/` as is and set `window.CQA_CONFIG = {apiBase: "https://<cqa-service>"}`
before `js/core.js` loads.

| Screen | What it does |
|---|---|
| Очередь на оценку | import (organizers' API by `group_id`, a URL, or a JSON file); filters; choose dialogs, checklist and model → run the evaluation |
| Оценки | all evaluations: final and original AI total, gross-error flag, N/A, appeals, status; export `results.json` |
| Карточка оценки | each criterion's answer, points, weight before and after N/A redistribution, explanation; evidence links (`#/eval/<id>?t=<turn №>`) scroll to the message and seek the call recording; checked range for a missing action; N/A reason; section scores; "Оспорить" button |
| Апелляции | reviewer queue → disputed answer, the operator's comment, the dialog fragment → confirm or change with a reason; the new total is previewed, then recalculated by the server |
| Чек-листы | edit criteria, wording, weight, answer type, scale steps and level labels, N/A rule, gross-error flag and the model context; each save is a new version; "Применить к диалогам" re-evaluates |
| Аналитика качества | score distribution, per-criterion breakdown (full / partial / no / N/A), language and channel splits, lowest-scoring dialogs |
| Точность ИИ | AI vs reviewer decisions per criterion (scored too high / too low / applicability), plus benchmark results |

There is no login. A role switcher in the sidebar shows the separate actions: Оператор files appeals,
Проверяющий decides them and runs evaluations, Методолог also edits checklists. Call recordings play through
`GET /dialogs/{id}/audio`, which resolves the organizers' player page to its short-lived mp3 link.

Batch, without the server:

```bash
python -m cqa.cli --source bench/dialogs.json --out runs/out.json
python -m cqa.cli --source "<organizers GET url with group_id>"
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/checklists`, `/checklists/{id}?version=` | checklist (latest or a version) |
| PUT | `/checklists/{id}` | save a **new version** (criteria, weights, type binary/scale, scale range, N/A rule, critical, requires_audio) |
| POST | `/dialogs/import` | `{"source": url-or-path}` or `{"group_id": "DEV"}` (with `ORGANIZER_API`) |
| GET | `/dialogs` | list with total / gross error / appealed |
| POST | `/evaluate` | `{"conversation_ids": [...], "checklist_id": "default", "provider"?: "...", "strategy"?: "..."}` |
| GET | `/evaluations/{cid}?version=` | original + final result, decisions, dialog, appeals, available versions |
| POST | `/appeals` | `{"conversation_id", "criterion_id", "comment"}` → stores disputed answer + dialog fragment |
| GET | `/appeals?status=pending` | reviewer queue |
| POST | `/appeals/{id}/decision` | `{"action": "confirm"\|"change", "new_answer"?, "reason"}` → recalculates total |

Re-applying a changed checklist creates a new evaluation version; earlier
versions keep their appeals and decisions (`?version=1`).

## Hackathon submission (official checklist)

```bash
python -m cqa.cli --source "<organizers GET url>&group_id=DEV" --export results/dev/results.json --team "<team>"
python -m cqa.cli --source "<prod url>" --export results/prod/results.json --team "<team>"
```

`checklists/official.json` is the official 8-criterion checklist (`contact … critical`), written with
the organizers' wording only. `--export` writes "Формат JSON 1.0": evidence turns are 1-based, N/A is `null`,
`critical_flag` comes from the critical criterion, and a failed dialog becomes `status: "error"`. Before
writing, the file is checked against the guide's rules (ids, 8 criteria, value types, scale steps).
Default: 3-sample vote (majority, or the median for a scale with no majority), about $0.003 per dialog.

**New checklist:** write it as JSON in the same shape. Use `type` binary/scale, `scale.steps`, `na_rule`,
`critical` + `flag_on` (which answer means a violation), and `weight`. No code changes are needed. The prompt
rules are deliberately checklist-independent; see bench/RESULTS.md, "DEV".

## Plugging a different model

Provider spec (API `provider`, CLI/bench `--provider`, env `CQA_PROVIDER`):

| spec | endpoint |
|---|---|
| `compat:/models/gemma-4-26B-A4B-it@<url>` (**default**, `GEMMA_BASE_URL`, default `http://127.0.0.1:18887/v1` — SSH tunnel to kt-103) | Gemma 4 26B-A4B, thinking, self-hosted vLLM |
| `deepseek:deepseek-flash` / `deepseek:deepseek-v4-pro` | DeepSeek, `DEEPSEEK_API_KEY` |
| `openai:<model>` | OpenAI, `OPENAI_API_KEY` |
| `openrouter:<vendor/model>` (e.g. `openrouter:anthropic/claude-sonnet-5.5`) | OpenRouter, `OPENROUTER_API_KEY`; `--thinking` maps to `reasoning.effort`, cost read from the response |
| `compat:<model>@<base_url>` | any OpenAI-compatible server (vLLM, Ollama, OpenRouter…), `LLM_API_KEY` |
| `agent:<dir>` | no API: prompts are written to `<dir>/requests/`, answers read from `<dir>/responses/` — lets an external agent (Claude, a human) act as the model |

All calls go through a response cache (`runs/cache`) and a hard USD budget.

## How it scores

- **The model never computes points.** It returns per criterion: `reasoning` →
  `answer` (`yes`/`no`, integer on the scale, or `na`) → `evidence` (turn ids) →
  `checked_range` (when an action is missing) → `explanation` / `na_reason`.
- **Deterministic validation** (`cqa/validate.py`) rejects: wrong answer type, N/A
  where not allowed, non-existent turn ids, a positive answer supported only by
  BOT/CLIENT turns (bot greeting credited to the operator), a negative answer with
  no evidence or checked range. Failing criteria get **one targeted repair call**;
  still failing → `needs_review`.
- **Scoring** (`cqa/scoring.py`): scale → (v−min)/(max−min) × weight; N/A drops out
  of the denominator (weight redistributed proportionally — hackathon rule;
  `na_policy: full_credit` gives the qbox/QMT behaviour); gross error flagged
  separately (`gross_error_policy: zero_total` to zero the total); section
  scores; rounding mode and decimals from the checklist.
- **Audio criteria** (`requires_audio: true`, e.g. intonation): N/A by rule on
  chats; on calls, prosody per operator turn (pitch range/variability, loudness,
  tempo; segments cut by transcript timestamps so the client is never measured)
  is measured with librosa and given to the model as numbers. If the recording or
  librosa is unavailable the criterion is N/A with a reason — the model is never
  asked to guess tone from text.

## Strategies (benchmarked — see [bench/RESULTS.md](bench/RESULTS.md))

- `grounded` + thinking `high` — **default** strategy (default model: Gemma 4 26B-A4B; DeepSeek flash was the earlier default): one call, turn-id evidence,
  validation + targeted repair. Hold-out: 99.6% answer accuracy, 100% gross-error recall,
  1.35-point mean total error over 3 runs.
- `single` — one call, quotes instead of ids, no validation (baseline)
- `per_criterion` — one call per criterion on a cached shared prefix
- `hybrid` — routine criteria in one fast call, `deep_check` criteria in their own reasoning call
- `--samples k` — self-consistency vote
- `--thinking off|low|high` — DeepSeek reasoning level (off is cheaper but misses gross errors)

## Benchmark

```bash
python -m bench.run_bench --provider deepseek:deepseek-flash --strategy grounded
python -m bench.run_bench --provider deepseek:deepseek-flash --strategy grounded \
       --dialogs bench/holdout_dialogs.json --gold bench/holdout_gold.json
```

Gold sets: `bench/dialogs.json` + `gold.json` (dev, 10 dialogs) and
`bench/holdout_*.json` (10 harder dialogs written independently, blind to the prompts).

## Cost

Model: **DeepSeek V4.1 Flash** (`deepseek-flash`), thinking high, `grounded`:
about **$0.0005–0.0009 per evaluation** including reasoning tokens and the occasional
repair call (≈ 3–4k input, 1–3k output tokens), ≈ 12 s. The whole 65-dialog DEV set
costs about $0.05.

## Tests

```bash
python -m unittest tests.test_core -v      # scoring, validation, data — no model needed
```
