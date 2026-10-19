# Tutor evaluation engine

How student answers and responses are graded in topic chat. Covers the live
Tutor-Core V2 evaluator (`services/tutor-core/evaluator.js`) and the legacy V1
grounded grader (`services/topic-chat/answer-grader.js`) that the kill-switched
V1 route still uses.

## Status and scope

| Item | Value |
| --- | --- |
| Live engine | Tutor-Core V2 (`processTutorTurn` → `evaluateStudentTurn`) |
| Legacy engine | V1 `gradeAnswer` (only when `ENABLE_TUTOR_CORE_V2=false`, `x-tutor-version: v1`, or `?v=1`) |
| Evaluator LLM | DeepSeek via `services/ai/deepseek-client.js` → `ai/providers`, `temperature: 0`, strict JSON, `featureArea: 'tutor-core'`, `subFeature: 'evaluator'` |
| Verdict ownership | Code combines model evidence; the model is never asked for the verdict or a percentage |
| In-flight migration copy | `ai/agents/socratic-tutor/evaluators/answer-evaluator.js` is a line-identical copy of V2 `evaluator.js` with only the require paths rewritten (it still imports guards/validate from `services/tutor-core`); keep both trees in sync until migration completes |

## Files

| File | Role |
| --- | --- |
| `services/tutor-core/evaluator.js` | V2 grading pipeline + `EVALUATOR_PROMPT` |
| `services/tutor-core/evaluator-guards.js` | Deterministic post-guards (English-only error labels) |
| `services/tutor-core/validate.js` | Supplies `cleanObjectiveText`, `PHYSICAL_ENTITIES`, `CONFLICTING_ENTITY_GROUPS`; owns the question contract/rubric shape |
| `services/tutor-core/state.js` | Consumes the verdict: assessment slots, first-credit, assistance, advance |
| `services/tutor-core/summary.js` | Consumes slots for the mastery report |
| `services/topic-chat/answer-grader.js` | V1 grader: intent classification + rubric scoring |
| `services/topic-chat/topic-chat.js` | V1 caller: pre-grade, grounded correction, teaching-vs-grading reconcile |

---

## V2 pipeline: how a student answer is graded

Entry point: `evaluateStudentTurn()` — `services/tutor-core/evaluator.js:445`.
Called from `orchestrator.js:86-96` with the student message, the last question
text/options, the persisted `lastQuestionRubric`, scenario, phase, topic/goal
context, class level, and AKG `academic_boundaries`.

### Pipeline order

```
student message
  │
  ├─ 0. Trim/empty guard ────────────── empty → unavailable(HELP, not_applicable)
  ├─ 1. Option resolution ───────────── "B"/"2"/option text → resolvedText (CHECK phase only)
  ├─ 2. Request-kind routing ────────── explain_answer | try_again | move_on | clarify_task
  │                                     → short-circuit, never graded (not_applicable)
  ├─ 3. Rubric normalization ────────── malformed persisted rubric → unavailable
  ├─ 4. Question↔rubric alignment ───── conflict → repair_needed (CLARIFY_TASK)
  ├─ 5. Deterministic MCQ key ───────── stored key + resolved option → graded without LLM
  ├─ 6. LLM semantic evidence ───────── temp 0, strict JSON: per-criterion satisfied + evidence
  ├─ 7. Evidence combination ────────── assessedResult(): verdict, score, diff, feedback
  ├─ 8. Deterministic guards ────────── applyGradingGuards(): English-only errors never punish
  └─ 9. Failure fallback ────────────── unavailable() — credit is never awarded
```

### 1. Option resolution (`resolveOptionAnswer`, `evaluator.js:167`)

Only called with the options of the question actually being answered — never
resurrects an older MCQ from history (`orchestrator.js:44-54` handles that
upstream: an explicit `lastQuestionOptions: null` means the last question was
written). Accepts `A`/`B`, `1`/`2`, `option B`, or exact option text. A resolved
option is always intent `ANSWER`.

### 2. Request-kind routing (`detectRequestKind`, `evaluator.js:42`)

Regexes, not the model, classify explicit control requests before any academic
handling. While `response_mode === 'offer_choice'`, `1`/`explain`/`first one`
map to `explain_answer` and `2`/`try`/`second one` to `try_again`.

| `request_kind` | Evaluator result | State machine effect (`state.js:312-384`) |
| --- | --- | --- |
| `explain_answer` | intent HELP, not_applicable, `EXPLAIN_ANSWER` | slot marked assisted/skipped if unassessed, question revealed and advanced |
| `try_again` | intent ACK, not_applicable, `RETRY` | slot assisted, same question retried (rubric preserved) |
| `move_on` | intent HELP, not_applicable, `MOVE_ON` | slot `skipped`, next question |
| `clarify_task` | intent HELP, `help_subtype: question_clarification`, `CLARIFY_QUESTION` | response_mode `task_repair`, no penalty, same question repaired |

`detectHelpSubtype` also catches clarification wording inside normal messages
(`evaluator.js:64`).

### 3. Rubric normalization (`normalizeRubric`, `evaluator.js:216`)

The question contract persisted by the generator (`lastQuestionRubric` in
session state, see `docs/cloop-prompt-upgrade.md`) is validated: 1–12 criteria,
unique non-empty ids/descriptions, boolean `required`, at least one required
criterion, optional `model_answer` / `correct_option_text`. A persisted rubric
that fails validation means the answer is **not graded** (`unavailable`) — the
model can never grade against a malformed contract.

### 4. Question↔rubric alignment (`validateQuestionRubricAlignment`, `evaluator.js:71`)

Protects against grading against requirements the visible question never asked:

- Direct classification/naming questions may not secretly require explanations.
- "How is an image formed?" rubrics may not secretly require accommodation
  (near/far focus); such criteria are demoted to optional.
- Entity conflict groups (`wall/desk/floor/...`, `car/cart/truck/...`,
  `beaker/flask/cup/...`, `sponge/spring/...`, `box/block/stone/...`) must not
  disagree between question, rubric, and saved scenario.

On conflict the result is `evaluation_status: 'repair_needed'` with
`suggested_action: 'CLARIFY_TASK'` — the session repairs the question instead
of penalizing the student.

### 5. Deterministic MCQ path (`evaluator.js:560-568`)

When the phase is CHECK (or legacy caller without phase) and the rubric has a
`correct_option_text` and the student selected an option:

- the key must match **exactly one** actual option, else `unavailable`
  ("Ambiguous or missing MCQ key");
- verdict is a direct string comparison, `graded_by: 'mcq_key'`;
- works even during model outages.

### 6. LLM semantic evidence (`EVALUATOR_PROMPT`, `evaluator.js:377`)

For free-text answers the model is invoked with the prompt plus a JSON context
record (never free-form): class level, phase, topic/goal, scenario, last
question + options, the rubric, the resolved student answer, optional
`academic_boundaries` from the AKG. Key prompt contracts:

- **No verdict, no score.** It returns per-criterion `{id, satisfied, evidence}`
  plus a `contradictions` list and `error_type`; code combines them.
- **Grade the actual last question and scenario**, not a broadly related fact.
  Never demand unasked explanations/formulas/units.
- **Source-grounded.** Never invent facts, counts, classifications; never
  "correct" a right term into a different one; distinguish nitrogen gas vs
  nitrogen oxides, symptom vs mechanism, etc.
- **Evidence is quoted**, `satisfied` is a real boolean, every criterion
  reported exactly once.
- **English is not graded.** Spelling/grammar never make content incorrect; a
  language mistake cannot hide a conceptual mistake either.
- For non-answers (ACK/HELP/IDK/OFF_TOPIC) the model must return empty
  criterion/contradiction arrays and null corrections.

If the model emits intent ≠ ANSWER, the evaluator returns
`evaluation_status: 'not_applicable'` with `suggested_action` = `CLARIFY_QUESTION`,
`GIVE_HINT`, `HANDLE_OFF_TOPIC`, or `REASK`.

### 7. Evidence combination (`readCriteria` + `assessedResult`, `evaluator.js:238/310`)

`readCriteria` rejects any model output that does not exactly cover the rubric:
unknown/missing/duplicate criterion ids, non-boolean `satisfied`, empty
evidence, or a mismatched count all throw → `unavailable`. The model may
satisfy a rubric; it may never redefine it.

`assessedResult` then computes:

- Criteria whose text demands an explanation are demoted to optional when the
  visible question doesn't ask "why" (second layer over stage 4).
- `is_correct = all required criteria satisfied AND no contradictions`
  (`evaluator.js:322`).
- `score_percent = round(satisfied_required / required * 100)`; any
  contradiction forces 0. This internal percentage is diagnostic only — it is
  **not** the headline mastery score and is not shown to students
  (`user_topic_reports`/summary compute mastery from slots instead).
- `error_type`: `Conceptual` (contradictions), else the model's
  Conceptual/Factual/Incomplete/Calculation, else `Incomplete`.
- `diff_html` via `safeDiff` (`evaluator.js:293`): only
  `<del>wrong</del><ins>correct</ins>`, insertion ≤ 15 words, complete
  sentence, escaped, no commentary. A deterministic fallback diff is built from
  the model answer when the model omitted markup (`evaluator.js:362-373`).
- A wrong answer without `complete_answer` throws → `unavailable` (`:605`).
- Special case: for "which part controls light entering the eye", `pupil` and
  `iris` are both accepted (`:351-360`).

### 8. Deterministic guards (`applyGradingGuards`, `evaluator-guards.js:33`)

The last line of defense for the English issue. If the model marks an answer
`is_correct: false` with a **language-only** `error_type` (spelling, grammar,
tense, wording, ...):

| Evidence state | Guard outcome |
| --- | --- |
| Any required criterion unsatisfied, contradiction, or content fault | re-label error as `Incomplete`/`Conceptual` (a language label cannot hide a content mistake) |
| All required criteria satisfied, no contradictions | upgrade to `is_correct: true`, `MOVE_ON` |
| Anything else | `is_correct: null`, `score_percent: null`, status `unavailable`, `REASK` — "needs a concept check" |

### 9. Failure fallback (`evaluator.js:607-612`)

Any parse/shape/LLM failure never awards credit and never leaks provider error
text. The student gets `evaluation_status: 'unavailable'`, a regex-fallback
intent (`fallbackIntent`), and `suggested_action` `REASK`/`GIVE_HINT`. The
state machine then re-asks neutrally (see below) — no invented 75% or 50%.

### Result statuses

| `evaluation_status` | Meaning |
| --- | --- |
| `evaluated` | Evidence combined; `is_correct` is boolean |
| `unavailable` | Could not verify (LLM/parse/malformed contract/ambiguous key); `is_correct: null` |
| `not_applicable` | Non-answer (ACK/HELP/IDK/OFF_TOPIC) or control request; never scored |
| `repair_needed` | Question↔rubric conflict; CLARIFY_TASK without penalty |

`graded_by`: `rubric_semantic` | `semantic_legacy` | `mcq_key` | `null`.

---

## How the verdict drives the session (`state.advance`)

`orchestrator.js:99-106` converts the evaluator result into an `advance()` event
(`correct`, `evaluationStatus`, `errorType`, `intent`, request kinds). Inside
`services/tutor-core/state.js`:

- **Three scored slots per goal** (DIALOGUE, CHECK, ROUNDUP). The **first
  assessable response fixes credit** (`state.js:494-510`): `assessed = true`,
  `first_correct`, outcome `correct | assisted | incorrect`, goal tallies
  incremented once. Retries/diagnostics append to `slot.attempts` without
  changing credit.
- **Unavailable grading** (`state.js:476-489`): recorded as an `unverified`
  attempt with `correct: null`; the same question is neutrally re-asked
  (`reask_shorter`). After `MAX_UNVERIFIED_ATTEMPTS` (3) the slot completes and
  the session moves on — an outage cannot trap the student.
- **Assistance**: HELP/IDK, hints, offer-choice, and `previousQuestionAssisted`
  mark the slot `assisted`; assisted first-success records outcome `assisted`,
  which cannot certify independent recall.
- **Wrong answers**: first wrong → teach (`correct_and_reask`, slot assisted);
  second → `offer_choice`; `MAX_ATTEMPTS` (3) → reveal and advance
  (`state.js:527-552`).
- **Correct** → slot completed, `advanceQuestion()` resets per-question pressure
  and moves the phase (`state.js:515-525`).

## How slots become the mastery report (`summary.buildReport`)

`services/tutor-core/summary.js:32` recomputes everything from slots:

- per-goal `accuracy = correct / asked` where `asked` counts slot totals only;
- band from `BANDS` (`Mastered ≥ 80%` … `Emerging`), but `Mastered` additionally
  requires all three slots assessed and a **correct, unassisted ROUNDUP
  recall** (`summary.js:42,52,78`);
- legacy tallies without matching slots are labeled `legacy_evidence` /
  `fresh_session_recommended` and can never certify mastery;
- overall score, stars, and performance level pile on the same recall gate;
  skipped/unverified/assisted counts stay visible in the breakdown.

The closing message and all figures are composed in code (`orchestrator.js:61-69`);
the model only writes prose around `reportBrief()` facts.

---

## V1 legacy grader (`services/topic-chat/answer-grader.js`)

Used by the V1 route (message handler `topic-chat.js:218` pre-grade,
`:424-476` grounded correction) and still the source of V1 correction bubbles.

1. **Intent gate first** (`intentOf`, `:24`): `ANSWER`, `ACK`, `HELP`,
   `NO_ATTEMPT`, `GIBBERISH`. Non-ANSWERS return `noAttemptResult()`
   (`score_percent: 10`, no diff, no complete answer) so no red bubble or
   strikethrough ever renders for "idk"/"ok"/"explain".
2. **One LLM call**, `temperature: 0`, against reference `topicContent` sliced
   to 3000 chars, returning `correctness`/`completeness` snapped to
   `{0, 0.5, 1}` (`snap`, `:6`).
3. **Derived verdict**: `is_correct = correctness === 1 AND completeness ≥ 0.5`
   (`:178`) — the model's own boolean is ignored.
4. Diff hygiene: only real `<del>/<ins>` markup is trusted; grader commentary
   in `diff_html` is discarded and replaced by `buildFallbackDiffHtml` (`:75`).
5. **Fallback on error** (`:198-211`): fixed `is_correct: false`, 50%,
   "Conceptual Error" — a legacy heuristic; Tutor-Core V2 deliberately replaces
   this with `unavailable`/`null` so outages never fabricate a score.
6. `topic-chat.js:25-54` post-processes with `reconcileTeachingVsGrading`: if
   the grader called a gotcha/exclusion answer correct but the tutor's own
   bubbles teach "all three are…", the verdict is downgraded to wrong so the
   recorded result agrees with what was taught.

`input_intent` is returned alongside the verdict so the V1 prompt can instruct
the tutor to never punish non-answers.

## V1 vs V2 at a glance

| Concern | V1 `gradeAnswer` | V2 `evaluateStudentTurn` |
| --- | --- | --- |
| Question contract | question text + topic content | persisted private rubric + options + scenario |
| Verdict source | model rubric values snapped, then derived in code | per-criterion evidence combined in code |
| MCQ | graded by model | deterministic key comparison (`mcq_key`) |
| Alignment protection | none | alignment validator → `repair_needed` |
| Non-answers | intent regex, no score | request-kind routing + intent, `not_applicable`, no score |
| LLM/parse failure | 50% invented verdict | `unavailable`, `null`, neutral re-ask, slot unverified |
| English-only errors | not guarded | `applyGradingGuards` reclassifies or upgrades |
| Retries | scored as new questions | diagnostic only; first response fixes credit |
| Score exposed | `score_percent` on corrections | no numeric score on correction cards; mastery from slots |

## Design invariants worth preserving

1. **The model never returns the verdict or the final score.** Code combines
   evidence; malformed model output means ungraded, not guessed.
2. **Known MCQ keys are graded deterministically**, so assessment survives
   model outages.
3. **English is never graded.** Neither a language error nor a language-only
   label can change the content verdict.
4. **Grade the asked question, not the topic.** Rubric criteria are validated
   against the visible question; unasked requirements are demoted or repaired.
5. **Failure = unknown.** `null` verdicts hold the question and are recorded as
   unverified; they are never converted into credit.
6. **First verified response fixes credit**; assistance is tracked separately
   and blocks the independent-recall mastery gate.

## Known caveats

- Semantic grading still depends on the LLM's interpretation of free text; the
  rubric/evidence combination prevents invented scores, not all grading noise.
  Generated rubrics and keys still need factual review.
- `evaluateStudentTurn` does not destructure `userId`; the call at
  `orchestrator.js:96` passes it, but `evaluator.js:587` reads
  `context.userId`, which is always `null`. Evaluator token telemetry is
  therefore unattributed until this is fixed.
- V1's `intentOf` documents an `OFF_TOPIC_DISRUPTION` class but never returns
  it; off-topic answers simply fall through to `ANSWER`.
- `ai/agents/socratic-tutor/evaluators/answer-evaluator.js` duplicates
  `services/tutor-core/evaluator.js` (only require paths differ) and still
  imports guards/validate from `services/tutor-core`. Any grading change must
  currently be applied twice; V2 wires `services/tutor-core`, the `ai/` agent
  is not yet routed.
