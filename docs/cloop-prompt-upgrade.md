# Cloop prompt and engine upgrade

This replaces the contradictory grading, retry, coverage, and completion rules in the supplied brief. The implementation is for the default Tutor-Core V2 route. Existing stored curriculum, goals, and past scores have not been regenerated or rewritten.

## What failed in the supplied chat

| Evidence | Problem | Required behavior |
| --- | --- | --- |
| Five goals include “Identify effects”, “Analyze speed/direction”, and “Classify effects” | Concepts overlap; repeated easy questions look like broad syllabus coverage. | Partition the supplied topic into distinct supported concepts. For this force-effects topic: starting/stopping motion, changing speed, changing direction, changing shape. |
| “yes both” to a question that also asks why | The required explanation is absent. | Grade every part of the actual question. A correct choice alone does not answer a request for reasoning. |
| “acclearation” after “Besides speed, what else?” | A spelling correction hides a missing direction concept. Acceleration is not evidence the student recalled the requested effect. | Separate language mistakes from conceptual obligations; ask an unambiguous question and check direction explicitly. |
| Catching question accepts “friction” without context | The scenario and desired force classification are underspecified. | Ask an unambiguous question. Do not assume an unqualified friction answer identifies the applied force of the catching hand; accept a physically supported explanation when the scenario supports it. |
| “speed, shape changing, acceleration, stretch” is followed by praise | Stretch is an example of shape change; acceleration overlaps motion changes. The list misses distinct requested effects. | Use separate required criteria. Do not count synonyms/examples twice, or treat one correct component as a complete answer. |
| “don't know” becomes a toy-car speed-up question | A supported, narrower answer replaces an independent recall assessment. | Teach after difficulty, but retain the original assessment requirements and record assistance. Supported success does not certify independent recall. |
| Final full-effects question ends after “start and stop motion” | A partial answer passes a full recall gate. | Require all components of the actual recall question. Repeated incomplete answers can end remediation, but cannot confirm mastery. |
| 17 questions / 15 correct for five goals | Retry answers became extra scored questions. | Use three assessment slots per goal. Record retries as learning evidence without changing first-response credit. |
| 88% / Excellent / “All learning goals achieved” | The report combines inflated recognition success with failed or supported recall. | Separate accuracy, assessed coverage, session closure, goal completion, and confirmed mastery. Failed recall remains an improvement area. |
| Videos/diagrams appear during round-up | The API bypasses the assessment-only attachment rules. | Keep round-up media-free, including after a video request. |

A defensible replacement percentage cannot be computed from this pasted chat alone: the stored question rubrics, source curriculum, and assistance flags are missing. The upgrade does not invent one or claim to repair historical reports.

## Changes to the original specification

1. **Source scope:** goals cover the supplied topic curriculum. Neither a title nor a 300/1,800-character excerpt proves full board-syllabus coverage. Goal generation reads complete source content up to 32,000 characters; missing or oversized content fails visibly instead of silently truncating or inventing a syllabus. Known board/class context is passed explicitly. Source accuracy and semantic syllabus coverage still require curriculum review.
2. **Goal count:** allow 2–6 concrete goals. The original “always 4–6” contradicts its own two-goal speed example and encourages padding narrow topics. Preserve separate concepts, definitions where appropriate, formulas and units where supported. Structural/source checks and a source-backed force-effects fallback reject the transcript's redundant goal design.
3. **Correctness:** code combines semantic evidence against a persisted question rubric. The model still interprets free text; code alone cannot prove scientific truth. A second model call and an English guard do not make grading independent of LLM interpretation. MCQ selections with a stored key are compared in code.
4. **Question scope:** grade the actual asked question, including all requested components. Require explanations, examples, formulas, and units only when requested by that question. Full round-up recall covers the goal's core facts; illustrative examples are not automatically additional recall obligations.
5. **No outage credit:** evaluator failure means `is_correct: null`, `score_percent: null`, `evaluation_status: "unavailable"`. Hold and neutrally repeat the assessment; after three unavailable attempts, record it unverified and move on. Never award the original fallback's invented 75% success.
6. **No English-label shortcut:** an English-only error label does not prove conceptual correctness. Satisfied semantic criteria permit credit; missing evidence remains ungraded. Mixed language/content errors remain content errors.
7. **Scoring slots:** one DIALOGUE, CHECK, and ROUNDUP slot per goal. The first verified answer fixes independent credit. Wrong-first retries cannot erase that error. HELP/IDK-assisted success is recorded separately. Pure skipped/unverified slots are excluded from attempted accuracy and remain visible in coverage.
8. **Recall gate:** first recall is uncoached. After a wrong answer or IDK, explain before retrying the same full question. Assisted retry success is learning progress, not independent recall. Mastered requires all three slots assessed and a correct recall response without in-turn assistance. This measures observed performance; it cannot prove a student used no notes or copied nothing.
9. **Completion:** WRAP is reachable after normal traversal, off-topic strikes, or the turn cap. Early endings produce partial reports, not false completion. A goal is complete only when all three slots are assessed and finalized. Traversal completion and mastery are separate flags. Final closing percentages and claims are composed in code.
10. **Repetition:** repeated directive names are allowed for different goals' independent recall and for neutral evaluator retries. Never escalate a new recall into an answer-giving hint merely to vary a directive name. Retry question/rubric pairs stay together.
11. **Presentation:** every bubble has at most 19 words. Preserve an entire coherent terminal question; do not grade a chopped question against the original rubric. Invalid MCQs fall back to a source-grounded written question within the CHECK slot. Cards contain the correct answer, escaped `<del>/<ins>` diff, and feedback explanation. Numeric scores stay off correction cards, including after refresh.
12. **End artifacts:** generate revision notes once and persist them with the report. Repeated DONE turns reuse them. Notes represent every topic goal and retain source formulas/units. Aim for under 200 words; unusually long verified formulas take priority over that word target. Diagrams render stored goal facts rather than generic chapter claims.

## Server-owned question contract

Persist this alongside the final question and options in session state. Keep it off all student-facing API responses, including history/debug payloads.

```json
{
  "criteria": [
    { "id": "start_stop", "description": "State that a force can start or stop motion", "required": true },
    { "id": "speed", "description": "State that a force can change speed", "required": true },
    { "id": "direction", "description": "State that a force can change direction", "required": true },
    { "id": "shape", "description": "State that a force can change shape", "required": true }
  ],
  "model_answer": "A force can start or stop motion, change speed, change direction, or change shape."
}
```

That example applies to a question asking for all four effects. A question asking only about direction needs a direction-specific rubric. A CHECK rubric also has `correct_option_text`, matching exactly one actual option text. Generated answer keys/rubrics need factual review; structural validation cannot prove distractor correctness.

The evaluator returns one `{id, satisfied, evidence}` result per criterion and a `contradictions` list. Unknown/missing/duplicate IDs, non-boolean satisfaction, missing evidence, and malformed JSON do not produce credit. Code derives `is_correct` from all required criteria plus absence of contradictions; any evaluator-proposed verdict/percentage is ignored. Internal criterion-completeness percentages are not headline mastery scores.

## Prompts and runtime flow

Use these canonical implemented prompts instead of reproducing the old wording:

- [Goals template](../services/topic-chat/prompts/goals_prompt.txt): complete supplied curriculum, 2–6 distinct concepts, no guessed board syllabus, concrete force-effects examples.
- [Evaluator](../services/tutor-core/evaluator.js): exact-question semantic criteria, context-sensitive intent, conceptual rather than English grading, strict evidence schema, null on unavailable grading.
- [Tutor generator](../services/tutor-core/tutor-generator.js): correctness-based acknowledgment, prior-answer feedback separated from the next goal, full uncoached initial recall, preserved retry requirements, private question rubric.
- [Revision generator](../services/tutor-core/revision-generator.js): complete goal descriptions and actual coverage evidence, source formulas/units, no claims of mastery, validated output and a deterministic fallback.

Student/history/curriculum text is data, not a source of instructions. The live evaluator and generator serialize turn data separately from behavioral rules. Keep recent history small while retaining the complete current goal and pending question rubric.

```text
PROBE → THEORY → OBJECTIVES → [DIALOGUE → CHECK] per goal
      → ROUNDUP for every goal → WRAP → DONE
```

Retain `OPEN_PER_GOAL=1`, `MCQ_PER_GOAL=1`, `RECALL_PER_GOAL=1`, `MAX_ATTEMPTS=3`, `STUCK_LIMIT=2`, `OFF_TOPIC_STRIKES=3`, and `MAX_TURNS=40`. Add `MAX_UNVERIFIED_ATTEMPTS=3`. Process the current allowed answer before applying the turn cap. Reset question-specific counters at each new slot.

The pipeline evaluates the previous question, advances the server state, generates the next question, validates it, then privately persists that exact question/rubric/options. During ROUNDUP, both evaluation and persistence use `roundupIndex`; teaching-loop `goalIndex` is not the active recall pointer. Never resolve a written number/letter against some older MCQ.

Routine written turns use evaluator plus generator calls. Known-key MCQs can skip semantic evaluation. Startup does not grade a fictional student response. Closing prose is deterministic, and revision generation runs once; DONE makes no new model calls. Evaluator/generator token limits are 900 to fit structured evidence/rubrics; goals use 1,500, revision 800. Cost/latency should be measured with the configured production model.

## Scoring and UI contract

Keep existing report aliases for consumers, with added assistance, coverage, and recall fields:

```json
{
  "overall_mastery_percent": 67,
  "assessment_coverage_percent": 100,
  "total_questions": 12,
  "correct_answers": 8,
  "incorrect_answers": 3,
  "assisted_answers": 1,
  "goals_completed": 4,
  "goals_total": 4,
  "recall_completed": true,
  "recall_passed": false,
  "mastery_confirmed": false,
  "session_completed": true,
  "ended_reason": "complete"
}
```

These are illustrative numbers, not a rescore of the pasted chat. `correct_answers` is earned independent credit; semantically correct assisted first answers are shown separately, rather than labeled wrong. `incorrect_answers` records first-response content failures. Attempts and error counts can exceed assessment counts because remediation is diagnostic.

Accuracy is `round(independent_correct / assessed_slots × 100)`. A goal with no assessed slots is “Not covered,” not a failed 0% goal. Skipped/unverified counts and expected assessment coverage accompany the percentage. A 100% attempted score with incomplete coverage does not become Mastered/Excellent. Existing bands remain, but Mastered additionally requires full assessment coverage and independent recall. Improvement areas include missing/failed/assisted recall even when recognition accuracy is high.

Student responses expose:

- `session_closed`: the state is WRAP/DONE; a report exists.
- `session_completed`: normal traversal ended with `ended_reason="complete"`; some questions may have been skipped.
- `all_goals_completed`: all goal assessment slots are assessed/finalized and recall is completed.
- `mastery_confirmed`: every goal meets the mastery and independent-recall requirements.

The frontend must use `mastery_confirmed` for “All learning goals achieved” or a mastery celebration. Finishing traversal alone supports “Session complete.” Correction `feedback` contains `is_correct` (boolean or null), `error_type`, `explanation`, and `evaluation_status`; no score badge or numeric score field. Headline scores/reports appear only after closure. End cards show incomplete coverage and remaining recall explicitly.

## Verification and rollout

Run `npm test` and `node services/tutor-core/simulate.js --sessions 500 --seed 42`. Suites stub provider/Prisma/media boundaries; they exercise exact-question grading, malformed responses, assistance, state transitions, full recall, early termination, media gating, history privacy, and curriculum failure propagation. The simulation has an independent expected-evidence ledger and exits nonzero on violations.

The default `ENABLE_TUTOR_CORE_V2` path uses these changes. The explicitly selected legacy V1 tutoring flow is not converted to the V2 state machine. History serialization was tightened to stop returning private rubrics, answer keys, and live evaluator scores.

Before production use, review/regenerate the existing overlapping cached goals against the actual board/class topic source and start fresh sessions. Existing persisted tallies remain readable but cannot establish the new recall evidence retrospectively. Reports label `score_evidence` as `assessment_slots`, `legacy_totals`, or `legacy_mixed`; legacy evidence prevents mastery certification and sets `fresh_session_recommended`. Historical scores stay historical. Frontend source is not present in this repository; its achievement copy, null-verdict styling, and PDF output need validation with the returned fields. Preserve the original PDF `<sub>/<super>` rule.

No live LLM/DB validation or deployment was performed. Stubbed tests establish deterministic behavior, not the scientific reliability of a configured model. Human-reviewed curriculum/rubrics and a labeled free-text evaluation set remain necessary to measure that reliability.
