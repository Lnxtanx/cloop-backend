# tutor-core

Server-owned tutoring flow:

```text
PROBE → THEORY → OBJECTIVES → [DIALOGUE ×1 → CHECK ×1] per goal
      → ROUNDUP ×1 per goal → WRAP → DONE
```

The server owns phases, assessment slots, attachments, and score calculations. The model interprets free text and writes tutor language/initial question rubrics. Semantic interpretation and generated factual keys remain model-dependent; this is not a deterministic scientific oracle.

Each final question is persisted with a private `lastQuestionRubric` and its actual options. The evaluator returns evidence per required criterion; code combines that evidence rather than accepting a model verdict or percentage. Known MCQ selections use the stored key directly. Missing or malformed evidence is ungraded (`null`), never a fallback 75% success. English is not graded, but an English error label alone cannot establish correctness.

Each goal has three scored slots: DIALOGUE, CHECK, ROUNDUP. First verified responses fix credit; retries are diagnostic evidence. HELP/IDK mark assistance. Skipped and unverified slots remain explicit in coverage. Independent written recall and complete assessment coverage gate Mastered. Completion, closure, assessed coverage, and mastery are separate.

New recall questions are uncoached and matched to complete stored goal facts. Assistance after a failed first recall can teach, but cannot certify independent recall. Retries preserve both the pending question and its rubric. Repeated directive names on a different goal are allowed; infrastructure retries stay neutral.

The validator enforces two bubbles, at most 19 words per bubble, complete questions, safe correction HTML, and CHECK-only MCQs. Invalid generated MCQs become grounded written assessments. Correction cards include an explanation and no numeric score, including after refresh. End artifacts are cached and reused on DONE.

| Module | Responsibility |
| --- | --- |
| `state.js` | Pure transitions, counters, three assessment slots, assistance/attempt records |
| `summary.js` | Earned score, coverage, recall, mastery and completion report |
| `evaluator.js` / `evaluator-guards.js` | Exact-question semantic evidence, MCQ key comparison, schema and English guards |
| `tutor-generator.js` | Prompt/directive language and private question rubric |
| `validate.js` | Deterministic presentation and question-contract validation |
| `orchestrator.js` | Previous-question evaluation → next-state/question → validation/persistence contract |
| `revision-generator.js` | All-goal source-grounded notes and fallback |
| `diagram-cache.js` | Stored goal facts rendered as a Mermaid map |

Run `npm test` for isolated, dependency-stubbed suites and `node services/tutor-core/simulate.js --sessions 500 --seed 42` for adversarial state simulations. Simulation failures produce a nonzero exit code. These checks do not call a live model or database.

See the [upgrade specification and transcript audit](../../docs/cloop-prompt-upgrade.md) for changed contracts, rollout requirements, and known limits.
