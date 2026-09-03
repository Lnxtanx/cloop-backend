# tutor-core

The session engine. Structure lives here, in code; the model is left only
language.

## Session shape

    PROBE → THEORY → OBJECTIVES → [ DIALOGUE ×2 → CHECK ×1 ] per goal → WRAP → DONE

`state.js` owns the phase. It is never read back out of the model's own
output, and the question type (`open` vs `mcq`) is decided per phase rather
than left to the model — multiple choice happens only in CHECK, as assessment
of what the dialogue taught, never as the teaching itself.

## What each module is for

| file | role |
|---|---|
| `state.js` | the phase machine, intent vocabulary, escalation ladder. Pure. |
| `summary.js` | the mastery report, computed from tallies the machine recorded. |
| `evaluator.js` | model call 1 — intent and grading. |
| `evaluator-guards.js` | the grading rules the *server* enforces. Pure. |
| `tutor-generator.js` | model call 2 — the bubbles. |
| `validate.js` | deterministic repair of the model's output before persistence. |
| `orchestrator.js` | the pipeline, and the seam between all of the above. |

## The two vocabularies

The evaluator classifies intent as `ANSWER | ACK | HELP_REQUEST | IDK |
OFF_TOPIC | GIBBERISH`. The state machine acts on `ANSWER | ACK | HELP | IDK |
OFF_TOPIC`. Everything crossing that seam goes through
`state.normalizeIntent`, which accepts both.

This is not incidental. A live session sent a student the identical two
bubbles three turns running because `HELP_REQUEST` matched nothing in the
state machine and the turn fell through to the phase default. Anything
unrecognised now normalises to `HELP` rather than falling through: a student
we cannot classify needs a hand, not the same sentence twice.

## Never saying the same thing twice

`instructionFor` will not return the directive the previous turn used.
Identical directives produce near-identical bubbles. When a directive would
repeat, the `ESCALATION` ladder moves to one that teaches the same point a
different way, and the depth walked is driven by how long the student has been
stuck — not merely by "is this the same as last time", which made an early
version of the ladder alternate between two rungs forever.

The last rung stops asking and starts helping: `give_starter` hands over a
sentence opening to finish, and `reveal_and_move_on` gives the answer plainly
and continues. After `STUCK_LIMIT` consecutive non-answers the phase advances
regardless, so a student who never answers still reaches a summary.

## Grading the concept, not the English

`evaluator-guards.js` reverses any wrong verdict whose stated reason is
spelling, grammar, tense or phrasing. "It is increase" is a right answer.
The evaluator prompt says so too, but a prompt is a request and this is the
enforcement.

Corrections are also gated on `isScored(phase)`: PROBE, THEORY and OBJECTIVES
ask the student to predict and think aloud, and those answers must not come
back with a red strikethrough and a crying face.

## Checking a change

    node --test services/tutor-core/*.test.js
    node services/tutor-core/simulate.js --sessions 500 --seed 42

`state.test.js`, `validate.test.js`, `regression.test.js`, `pipeline.test.js`
and `simulate.js` run standalone — they stub or avoid the model client
entirely. `orchestrator.test.js` loads `evaluator.js` unstubbed and so needs
`services/ai/deepseek-client.js`, which exists only in the application repo.

`regression.test.js` replays sessions that shipped broken. `simulate.js`
plays whole sessions and asserts what a student would actually experience.

Both must fail when the bug they describe is reintroduced — that is the point
of them. To confirm they still have teeth, break `normalizeIntent` so it
returns its argument unchanged, and check that you get test failures *and*
simulation violations. Checks that pass against known-broken code are worse
than no checks, because they are believed.

For the same reason, invariants in `simulate.js` are written against the
fixture's own `kind` field rather than against anything the code under test
computes. An earlier version asked the state machine to classify the intent
first, so a broken classifier silently skipped the check that would have
caught it.
