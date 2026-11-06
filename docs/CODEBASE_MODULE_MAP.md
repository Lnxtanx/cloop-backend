# Cloop Socratic AI Tutor — Complete Codebase Module Map

> **Exhaustive Technical Code Reference**  
> *Confidential — Cloop Educational Technologies*

---

## 1. Directory Tree Overview

```
backend/
├── api/
│   └── topic-chats/
│       ├── topic-chats-v2.js         # Production turn handler (POST /:topicId/message & POST /:topicId/wrap)
│       └── topic-chats.js            # Legacy chat endpoints and history queries
├── services/
│   ├── tutor-core/                   # The Core Socratic Engine (Deterministic State & Processing Pipeline)
│   │   ├── orchestrator.js           # Turn pipeline orchestrator (AKG → Evaluator → State → Generator → Validator)
│   │   ├── state.js                  # Pure state machine (6 phases, 3 assessment slots, assistance ladder)
│   │   ├── evaluator.js              # Temperature 0.0 grading & semantic rubric verification
│   │   ├── evaluator-guards.js       # Deterministic grading guards (strips language/grammar penalties)
│   │   ├── tutor-generator.js        # Dialogue generator (Temperature 0.4, Socratic micro-bubbles)
│   │   ├── validate.js               # Output enforcer (word counts, bubble splitting, anti-repetition)
│   │   ├── student-text.js           # Text sanitizer (drops introspection leaks, strips prefixes, punctuation)
│   │   ├── learning-requests.js      # Student intent parser (help, idk, exit, speed-up, recap)
│   │   ├── summary.js                # Report brief & verifiable mastery scoring
│   │   ├── academic-notes.js         # Extracts definitions, mechanisms, formulas, and examples from syllabus
│   │   ├── question-contract.js      # Server-side contract persistence between turns
│   │   ├── question-recovery.js      # Recovers lost question context and rubrics across retries
│   │   ├── diagram-cache.js          # Fast retrieval and caching of Mermaid diagrams
│   │   ├── media-policy.js           # Controls video/diagram triggers based on phase and explicit student requests
│   │   ├── public-feedback.js        # Formats public feedback payload (green/red bubbles, diffs, emojis)
│   │   └── revision-generator.js     # Synthesizes grounded end-of-lesson revision sheets
│   ├── academic-graph/               # Academic Knowledge Graph (AKG) Boundary Control
│   │   ├── akg-service.js            # High-level AKG resolver and cache manager
│   │   ├── akg-cache.js              # In-memory and Postgres cache for topic intelligence
│   │   ├── akg-extractor.js          # Extracts syllabus boundaries, analogies, and misconceptions
│   │   └── akg-types.js              # Type definitions and schemas for AKG entities
│   └── topic-chat/
│       ├── topic-chat-service.js     # Chat persistence and database transaction manager
│       └── topic-chat-helpers.js     # Goal filtering (e.g., filterGoalsForStartingTopic)
└── ai/agents/socratic-tutor/          # Modern Modular Socratic Agent Architecture
    ├── agent.js                      # High-level agent entry point (`processTurn`)
    ├── index.js                      # Agent exports and registration
    ├── context/
    │   └── context-builder.js        # Enriches turns with analogies, grade rigor, and scenario continuity
    ├── evaluators/
    │   ├── answer-evaluator.js       # DeepSeek Temperature 0.0 evaluator with question-rubric guards
    │   └── intent-evaluator.js       # Fast classification of conversational student intents
    ├── formatters/
    │   └── bubble-formatter.js       # Formats, paginates, and sanitizes micro-bubbles (< 19 words)
    ├── generators/
    │   ├── dialogue-generator.js     # High-level dialogue generation with subject-calibrated rules
    │   └── revision-generator.js     # Generates mistake-targeted revision sheets
    ├── inspector/
    │   └── inspector-store.js        # Telemetry and turn-level inspection logging
    ├── state/
    │   └── state-machine.js          # Mirror-pure state machine implementation
    ├── tools/
    │   ├── akg-tool.js               # Tool for querying the Academic Knowledge Graph
    │   ├── diagram-tool.js           # Tool for generating or fetching Mermaid diagrams
    │   ├── memory-tool.js            # Tool for querying misconceptions and student error history
    │   ├── search-tool.js            # Safe curriculum-grounded textbook search tool
    │   └── video-tool.js             # Curriculum animation search tool
    └── prompts/                      # 15 specialized prompt modules (see SOCRATIC_METHOD_AND_PROMPTS.md)

cloop-website/src/features/chat/components/
├── ChatBubbles.tsx                   # Renders green/red user bubbles, emojis, and Verified Answer container
├── TopicChat.tsx                     # Main chat view, handles decoupled wrap execution and speech
├── WrapSummaryCard.tsx               # Renders session mastery summary card
└── RevisionSheetModal.tsx            # Interactive revision sheet with YouTube players and notes
```

---

## 2. File-by-File Technical Specification

### `backend/services/tutor-core/orchestrator.js`
- **Role**: Master Turn Orchestrator. Coordinates the full lifecycle of a student turn.
- **Key Functions**:
  - `processTutorTurn(params)`: Executes the full 5-step pipeline. Checks for modular `socraticAgent` delegate; falls back cleanly to local pipeline if not present.
    - *Input*: `{ studentMessage, topic, goals, chatHistory, currentState, userProfile, wantsVideo, akgContext, userId }`
    - *Output*: `{ evaluatorResult, intent, answeredPhase, gradedThisTurn, nextState, stateInstruction, questionType, attachments, masteryReport, revisionSheet, messages, userCorrection, mermaid_diagram, all_goals_completed, session_closed }`
  - `findLastQuestion(chatHistory, state)`: Searches chat history backwards for the active question text ending in `?` or `？`.
  - `findLastQuestionOptions(chatHistory, state)`: Extracts options from the active question, returning `null` if the last question was open-ended to prevent resurrecting old MCQs.
  - `closingMessage(report)`: Generates authoritative closing text based on database mastery metrics.

---

### `backend/services/tutor-core/state.js` & `backend/ai/agents/socratic-tutor/state/state-machine.js`
- **Role**: Pure Deterministic State Machine. Tracks curriculum phase, goal progression, attempts, and scoring.
- **Key Functions**:
  - `initialState(goalTotal)`: Initializes the deterministic session state:
    ```javascript
    {
      phase: "PROBE",
      goalIndex: 0,
      goalTotal: total,
      openThisGoal: 0,
      mcqThisGoal: 0,
      roundupIndex: 0,
      recallThisGoal: 0,
      totalQuestions: 0,
      totalTurns: 0,
      consecutiveWrong: 0,
      offTopicStreak: 0,
      stuckStreak: 0,
      response_mode: "check",
      perGoal: [{ correct: 0, total: 0, errors: [], assessments: {} }],
      teachingCoverage: [{ definition: false, explanation: false, formula: false, example: false }]
    }
    ```
  - `advance(state, event)`: Advances the state based on student intent and evaluation verdict. Never mutates input.
    - Evaluates 3 assessment slots per goal: `DIALOGUE` (open), `CHECK` (MCQ), `ROUNDUP` (recall).
    - Sets `response_mode` to `'teach'` on first failure; `'offer_choice'` on second failure; `'explain'` when explanation is requested.
  - `instructionFor(state, event)`: Derives the next pedagogical directive (`stateInstruction`) for the LLM generator:
    - Examples: `probe_prior_knowledge`, `teach_theory`, `open_goal_dialogue`, `assess_with_mcq`, `hint_then_easier`, `offer_choice`, `roundup_recall`.
  - `questionTypeFor(phase, state)`: Returns `'open'`, `'mcq'`, or `null`.
  - `isScored(phase)`: Returns `true` only for `DIALOGUE`, `CHECK`, and `ROUNDUP`.

---

### `backend/services/tutor-core/evaluator.js` & `backend/ai/agents/socratic-tutor/evaluators/answer-evaluator.js`
- **Role**: Semantic Grading Engine (Temperature 0.0). Grades student answers against visible question obligations.
- **Key Functions**:
  - `evaluateStudentTurn(params)`: Sends prompt to DeepSeek-V4-Pro at Temperature 0.0.
  - `validateQuestionRubricAlignment(lastQuestionText, rubric, scenario)`: Prevents hidden grading traps. If the question did not ask "why", strips unasked explanation criteria from the required list.
  - `validateCriterionRequirements(criteria, lastQuestionText)`: Verifies that any unsatisfied criterion has a verbatim requirement in the visible question.
  - `resolveOptionAnswer(studentMessage, options)`: Maps option letters (`A`, `B`), numbers (`1`, `2`), or text onto the exact option object.
  - `assessedResult(parsed, criteria, rubric, resolved, gradedBy, lastQuestionText)`: Combines satisfied criteria, detects contradictions, assigns error type (`Conceptual`, `Factual`, `Incomplete`), and formats diff HTML.
  - `applyGradingGuards(result)`: Applies deterministic rules in `evaluator-guards.js`.

---

### `backend/services/tutor-core/evaluator-guards.js`
- **Role**: Deterministic Grading Guard layer.
- **Key Functions**:
  - `applyGradingGuards(result)`: Strips English/language penalties (`spelling`, `grammar`, `typo`, `wording`, `tense`). If all semantic criteria are satisfied, flips `is_correct` to `true` and clears `error_type`.

---

### `backend/services/tutor-core/tutor-generator.js` & `backend/ai/agents/socratic-tutor/generators/dialogue-generator.js`
- **Role**: Dialogue Generation Engine (Temperature 0.4).
- **Key Functions**:
  - `generateTutorResponse(params)`: Produces empathetic, pedagogical micro-bubbles from the server's `stateInstruction`.
  - `buildTutorPrompt(params)`: Assembles the prompt including enriched context, grade-level rigor, subject rules, and temporal state.
  - Generates the next question alongside its strict private `lastQuestionRubric`.

---

### `backend/services/tutor-core/validate.js` & `backend/ai/agents/socratic-tutor/formatters/bubble-formatter.js`
- **Role**: Output Validation & Enforcement Layer.
- **Key Functions**:
  - `enforce(rawTutorOutput, context)`: Enforces hard limits:
    - Splits bubbles over 19 words into bite-sized conversational messages.
    - Strips unearned praise ("Great job!" on wrong answers).
    - Guarantees question punctuation (`?` on inquiries).
    - Shuffles MCQ options to prevent position bias.
    - Strips introspection leaks (`student-text.js`).

---

### `backend/services/tutor-core/student-text.js`
- **Role**: Student-Facing Text Sanitizer.
- **Key Functions**:
  - `cleanStudentFacingText(text)`:
    - Drops model introspection leaks (`"I cannot verify..."`, `"According to my instructions..."`).
    - Strips topic title numbers (`"Topic 1: Charged Particles"` → `"Charged Particles"`).
    - Ensures proper sentence capitalization and punctuation.

---

### `backend/services/tutor-core/learning-requests.js`
- **Role**: Intent & Control Request Classifier.
- **Key Functions**:
  - `teachingRequest(text)`: Detects requests like `recap_topic`, `give_example`, `clarify_term`, `clarify_task`.
  - `controlRequest(text)`: Detects control commands like `end_session`, `move_on`, `speed_up` ("move faster").

---

### `backend/services/tutor-core/academic-notes.js`
- **Role**: Syllabus Fact Extractor.
- **Key Functions**:
  - `buildAcademicNotes(goal)`: Parses goal descriptions to extract structured notes:
    - `definition`: Sourced foundational definition.
    - `mechanism`: Physical or mathematical cause-and-effect principle.
    - `formulas`: Mathematical equations, SI units, and symbols.
    - `examples`: Curated real-world illustrations.

---

### `backend/services/tutor-core/summary.js`
- **Role**: Verifiable Session Mastery Aggregator.
- **Key Functions**:
  - `buildReport(state, goals)`: Aggregates real database attempts into a verifiable mastery report:
    - `overall_mastery_percent`: Formula = `(goals_mastered / goals_total) * 100`.
    - `accuracy_percent`: Formula = `(correct_answers / total_questions) * 100`.
    - `recall_completed`: Boolean indicating whether the student completed independent recall across all goals in the `ROUNDUP` phase.
    - `key_errors`: List of conceptual and factual errors made during the session.

---

### `backend/services/tutor-core/diagram-cache.js` & `backend/ai/agents/socratic-tutor/tools/diagram-tool.js`
- **Role**: Diagram Retrieval & Caching.
- **Key Functions**:
  - `getCachedDiagram(topicTitle, goalTitle, goal)`: Returns a pre-validated Mermaid diagram suited for the current topic.
  - Automatically caches diagrams in PostgreSQL to guarantee sub-millisecond retrieval.

---

### `backend/services/academic-graph/akg-service.js`
- **Role**: Academic Knowledge Graph (AKG) Boundary Control.
- **Key Functions**:
  - `resolveTopicIntelligence(topic, prisma, options)`: Resolves topic boundaries, prerequisite concepts, common misconceptions, and grade-appropriate limits from the database or cache.
  - Ensures Class 6 students are never exposed to Class 11 formulas.

---

### `backend/api/topic-chats/topic-chats-v2.js`
- **Role**: Production API Controller for Topic Chat.
- **Key Endpoints**:
  - `POST /api/topic-chats/:topicId/message`: Main conversational turn endpoint (< 1.5 seconds).
    1. Loads topic, chapter, and curriculum goals.
    2. Loads chat history from `admin_chat`.
    3. Restores previous session state from `chat_process.feedback.session_state`.
    4. Executes `processTutorTurn(params)`.
    5. Saves user message in `admin_chat` with `__correction__:` options metadata.
    6. Saves AI response bubbles in `admin_chat`.
    7. Appends `chat_goal_progress` and `learning_turns`.
    8. Persists new `session_state` in `chat_process`.
    9. Returns immediate conversational response to client.
  - `POST /api/topic-chats/:topicId/wrap`: Decoupled Session Wrap Endpoint.
    1. Computes 100% accurate metrics directly from Postgres `learning_turns`.
    2. Generates grounded revision sheet using the student's actual session errors.
    3. Fetches high-relevance curriculum animation videos from YouTube.
    4. Persists `session_summary` and `revision_sheet` into `admin_chat`.
    5. Returns wrap payload to frontend without turn freezes.

---

### Frontend Components (`cloop-website/src/features/chat/components/`)
- **`ChatBubbles.tsx`**:
  - Parses `__correction__:` from `admin_chat.options` or direct payload.
  - Styles student answers: Soft green (`#86efac` / `#f0fdf4`) for correct; Soft red (`#fca5a5` / `#fef2f2`) for incorrect.
  - Enforces the **Verified Answer Container Invariant**: always positive green (`#86efac` / `#f0fdf4`).
- **`TopicChat.tsx`**:
  - Manages message streams and handles the decoupled wrap trigger:
    - Upon receiving `all_goals_completed: true`, displays celebratory chat bubble, shows wrap spinner, and fires `POST /api/topic-chats/:topicId/wrap`.
    - Appends wrap cards with duplicate ID/type guards to prevent duplicate cards.

