# Benchmark results — how the default was chosen

Two gold sets, 8 criteria each (80 labelled items per set):

- **dev** — `dialogs.json` / `gold.json`: 10 dialogs (5 RU, 2 KZ, 3 EN; 6 chats, 4 calls).
  Written together with the checklist, so it is optimistic.
- **hold-out** — `holdout_*.json`: 10 harder dialogs (5 RU, 3 KZ incl. RU code-switching,
  2 EN) written by a separate agent that saw only the checklist. They have 1–3 traps
  each: a bot greeting with no operator greeting, a pause visible only in timestamps,
  identification data the client volunteered instead of the operator requesting it,
  T+3 stated instead of T+1, 0.5% of 200 000 = 10 000, a casual request for the SMS
  code, a hedged personal recommendation, a summary with no goodbye, and similar.

Metrics: `acc` = the answer is in the accepted set. `strict` = scale answers equal the
primary gold. `gross_rec` = recall of gross errors. `mae` = |total − gold total| in
points. Evidence hit rate (cited turn ids ∩ gold) was 100% for every grounded variant.

## Round 1 — Claude agents as the model (no API spend, 6 dev dialogs)

| strategy | acc | evid | mae | calls/dlg |
|---|---|---|---|---|
| single | 100% | 96.8% | 1.32 | 1 |
| grounded | 97.9% | 100% | 1.32 | 1 |
| per_criterion | 100% | 100% | 0.00 | 8 |

A strong model saturates the dev set. Its one miss showed the gross-error definition
was ambiguous (data the client volunteered vs. data the operator requested), so the
definition was fixed. The pipeline itself (validation, repair, evidence ids) worked
end to end.

## Round 2 — DeepSeek, dev set

| variant | acc | mae | $/dlg | s/dlg |
|---|---|---|---|---|
| flash single | 97.5% | 3.64 | 0.00043 | 5 |
| flash grounded | 97.5% | 1.88 | 0.00054 | 6 |
| flash per_criterion | 98.8% | 1.73 | 0.00086 | 13 |
| flash per_criterion, 3-sample vote | 97.5% | 2.82 | 0.00179 | 39 |
| pro grounded | 97.5% (gross recall 67%) | 4.01 | 0.00150 | 10 |
| pro per_criterion | 97.5% (gross recall 67%) | 3.87 | 0.00363 | 17 |

Every variant landed within ±1–2 items, so the dev set was saturated. Pro was not better
and missed the SMS-code gross error. Self-consistency added cost and no accuracy.

## Round 3 — hold-out (the deciding set)

| variant | acc | mae | $/dlg |
|---|---|---|---|
| flash single | 93.8% | 8.04 | 0.00048 |
| flash grounded, prompt v1 | 96.3% | 8.42 | 0.00056 |
| flash grounded, prompt v2 (applicability first, worst-moment rule) | 96.3% | 6.86 | 0.00056 |
| flash per_criterion, v2 | 97.5% | 8.95 | 0.00087 |
| pro grounded, v2 | 97.5% | 6.07 | 0.00174 |
| flash hybrid (routine batch + thinking for `solution`) | 97.5% | 2.80 | 0.00075 |
| flash grounded, verification instruction, thinking **off** | 95.0% | 6.86 | 0.00044 |
| flash grounded, verification instruction, thinking **high** | 98.8% | 2.50 | 0.00068 |

Main failure: **wrong facts stated confidently** (T+3, the 10× arithmetic slip). Every
non-reasoning variant marked those answers as correct, Pro included. The ablation shows
the verification instruction alone does nothing; reasoning is what catches them. The
one remaining false negative ("an ID valid until 1 Nov 2026 has expired") came from the
model not knowing the dialog date, so the dialog date (or an explicit "unknown — don't
judge relative dates") now goes into the prompt header.

## Final — repeatability (3 independent uncached runs each)

| config | hold-out acc | hold-out mae | dev acc | dev mae | gross recall | $/dlg | s/dlg |
|---|---|---|---|---|---|---|---|
| **grounded + flash + thinking high** | **99.6%** (100 / 98.8 / 100) | **1.35** | **99.2%** | 3.5 | **100% (6/6 runs)** | ~0.0006 | ~12 |
| grounded + flash + thinking off | 94.4% | 8.5 | 97.5% | 2.8 | 67% in 4 of 6 runs | ~0.0004 | ~7 |
| hybrid | 95.0% | 7.42 | 98.8% | 3.04 | 100% | ~0.0008 | ~9 |

**Default: `grounded`, `deepseek-flash`, thinking `high`, prompt v2.** It needs one call
per dialog, plus one repair call only when validation fails. That costs about
**$0.0005–0.0009 per evaluation**, ≈ $0.05 for the 65-dialog DEV set.

Dev mae for the final config is non-zero mostly through scale answers that are
acceptable but not primary (e.g. `needs` = 2 where 1 is primary): `acc` counts them
correct, while `mae` uses the primary label.

## Other models via OpenRouter (same `grounded` pipeline, prompt v2; 1 run each)

| model | thinking | hold-out acc | hold-out mae | dev acc | dev mae | gross recall | gross false pos | $/dlg | s/dlg |
|---|---|---|---|---|---|---|---|---|---|
| deepseek-flash (default, 3-run mean) | high | 99.6% | 1.35 | 99.2% | 3.5 | 100% | 0 | ~0.0006 | ~12 |
| claude-sonnet-5.5 | high | **100%** | 2.88 | 98.8% | 2.31 | 100% | 0 | 0.0217 | 11 |
| claude-haiku-5.5 | high | 98.8% | 4.88 | 96.3% | 6.23 | 100% | **1** | 0.0018 | 14 |
| claude-haiku-5.5 | off | 97.5% | 4.58 | 95.0% | 5.48 | 67% (dev) | 0 | 0.0010 | 7 |

- **Sonnet 5.5** is the most accurate single run: it caught every hold-out trap, T+1 included, with
  no review flags. It costs about 36× deepseek-flash. That is a good fit as a second-opinion
  reviewer on appealed or low-confidence items, not as the bulk judge.
- **Haiku 5.5 + thinking** caught every gross error but produced one false gross error on
  `b-en-call-01`, which would wrongly flag an operator, and it needs more N/A care. With
  thinking off it repeats the DeepSeek pattern: it missed the SMS-code gross error and the
  T+3 fact.
- `b-en-chat-02/solution` (got 1, gold 2) is missed by every Claude model. It may be a gold-label
  judgement call worth a second human look.

## DEV — organizers' 65 dialogs, official checklist (no answer key)

There are no labels, so two signals stand in for accuracy. **Run-to-run agreement** comes from two
independent runs. **Gross-violation recall** uses 8 violations confirmed by hand: insults, private paid
advice in RU/KZ/EN, money sent to a personal card, and account facts disclosed to unverified clients
in RU/KZ/EN.

| setup | agreement | mean \|Δ total\| | gross caught |
|---|---|---|---|
| checklist with my extra wording, 1 sample | 91.0% | 5.45 | 7/8 (KZ disclosure missed) |
| + clarified closure/discovery wording, 1 sample | 93.7% | 3.22 | 6–7/8 |
| + 3-sample vote (median for scales with no majority) | 95.2% | 2.34 | 7–8/8 |
| checklist-specific wording fixes, 3 samples | 95.4% | 1.99 | 8/8 |
| **organizers' wording only + generic prompt rules (v3), 3 samples — final** | **95.0%** | 2.65 | **8/8, both runs, 0 false** |
| organizers' wording only, old prompt (v2), 3 samples | — | — | 5/8 |

**Generalisation.** The next checklist will differ, so the fixes are in the prompt as
checklist-independent rules, not in the checklist text:
- criteria are independent; never soften a verdict because another criterion covers the problem;
- read AND/OR in definitions literally; a courtesy phrase counts only as what it literally is;
- check critical criteria on substance, in any language or wording;
- decide applicability from the facts of the dialog.

On the earlier, completely different 8-criterion checklist, prompt v3 scored **100% on both dev and
hold-out** (it was 99.2% and 99.6% with v2), so it does not regress on a checklist it was not tuned for.

Least stable on DEV: `consultation` (0.85 agreement; 15 vs 20 is a judgement call) and `discovery`
(0.91; N/A vs applicable). The vote flags items with no majority as `needs_review`.

Spend for this round: DeepSeek balance $7.23 → $4.67. The internal cost meter reported about $1.4,
so the price table undercounts (likely peak-hour pricing). Trust the balance endpoint.

## Self-hosted models on kt-103 (vLLM; requests only, servers untouched)

Gemma 4 26B-A4B-it and Qwen3.8-Flash-Next-FP8 use the same `grounded` pipeline and prompt v3, one run each.
Thinking runs use temperature 0.6. At temperature 0, both models fell into endless reasoning on most dialogs.

| model | thinking | dev (key) | hold-out (key) | gross recall (key) | DEV: agreement with DeepSeek | DEV: gross 8/8 | DEV: mean total vs DeepSeek | s/dlg |
|---|---|---|---|---|---|---|---|---|
| DeepSeek flash (run 2 vs run 1, ceiling) | high | 99.2% | 99.6% | 100% | 95.0% | 8/8 | ±2.65 | ~12 |
| Gemma 4 26B-A4B | high | 98.8% | **100%** | 100% | 85.8% | 8/8, 0 extra | **+7.2 (lenient)** | ~28 |
| Qwen3.8-Flash-Next | high | 98.8% | 97.5% | 100% | 88.7% | 8/8, 2 extra (calls) | +3.0 | ~23 |
| Gemma 4 26B-A4B | off | 93.8% | 93.8% | 100%, 3 false pos | — | — | — | ~5 |
| Qwen3.8-Flash-Next | off | 97.5% | 98.8% | 67% | — | — | — | ~6 |

- **Gemma is systematically lenient on DEV.** It gives `closure` = yes for a bare "Пожалуйста. Хорошего
  дня!" 15 times, which ignores the "summary/offer AND farewell" rule, and `consultation` 15 → 20 11
  times. That inflates totals by about 7 points.
- **Qwen's two extra flags are on voice calls**, and both are borderline. In `p4-ru-003` the operator asks
  for the SMS code sent for identification, which is the company's procedure. In `p4-ru-004` the operator
  tells an unverified caller that "a different house number is on file", which arguably is a disclosure.
- Gemma thinking writes about 7.5k output tokens per dialog at about 270 tok/s per stream. The latency
  comes from reasoning length, not decode speed.

## Known limits

- **Domain facts.** T+1 settlement was still missed in 1 of 3 runs. For production, put
  the broker's own reference facts (tariffs, settlement, tax rules) in the checklist's
  `context` field; the model then verifies against them rather than against its memory.
- **Gold sets are synthetic** (20 dialogs). Re-run `bench.run_bench` on the organizers'
  DEV set once it is labelled; the harness and metrics carry over unchanged.
- **Intonation/diction** needs real recordings + `librosa`. Without them the criterion is
  N/A by rule, never guessed from text.

Total API spend for all of the above: **$0.49** (balance 7.72 → 7.23).
