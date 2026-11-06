# Cloop AI Tutor Architecture

> **Authoritative Technical Specification**  
> *Confidential — Cloop Educational Technologies*

---

## 1. Architectural Philosophy & Core Principles

Cloop is an AI-powered mastery-learning platform for K-12 students. Unlike conventional conversational chatbots that simply generate open-ended answers from prompt chains, the Cloop AI Tutor is built upon **three foundational engineering principles**:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        CLOOP ARCHITECTURAL TRIAD                       │
├────────────────────────────┬─────────────────────────────┬─────────────┤
│ 1. Deterministic State     │ 2. Dual-Model Pipeline      │ 3. AKG      │
│    Engine                  │    Separation               │    Boundary │
│                            │                             │    Control  │
│ Server owns the curriculum │ Evaluator (Temp 0.0) ≠      │ Strictly    │
│ phase, goals, attempts,    │ Generator (Temp 0.4)        │ enforces    │
│ scoring, and progression.  │ Strict objective grading vs │ textbook &  │
│ LLMs cannot advance goals. │ pedagogical micro-bubbles.  │ grade level │
└────────────────────────────┴─────────────────────────────┴─────────────┘
```

1. **Server-Owned Progression (Deterministic State Machine)**:
   The LLM does **not** decide when a learning goal is mastered, how many attempts remain, or when to wrap up a session. The server state machine owns the curriculum progress, tracks every attempt, scores evidence against real database goals, and instructs the LLM what to do next (`stateInstruction`).
2. **Strict Dual-Model Separation**:
   - **Evaluator (`evaluator.js`)**: Runs at **Temperature 0.0**. Grades student answers against visible question obligations using semantic rubrics and checks for scientific contradictions. It never generates conversational text or chat bubbles.
   - **Dialogue Generator (`tutor-generator.js`)**: Runs at **Temperature 0.4**. Takes the evaluated verdict, pedagogical directive, and curriculum facts to produce concise, empathetic micro-bubbles.
   - **Enforcer / Validator (`validate.js`)**: Deterministic code layer that validates LLM output, splits text into bite-sized micro-bubbles (< 19 words each), strips unearned praise, guarantees punctuation, and removes system introspection leaks.
3. **Academic Knowledge Graph (AKG) Boundary Control**:
   Curriculum boundary enforcement prevents the tutor from leaking advanced concepts (e.g., introducing Newton’s Laws or molecular orbitals to a Class 6 student learning about basic pushes and pulls).

---

## 2. System Architecture & Turn Processing Pipeline

Every user message sent to `POST /api/topic-chats/:topicId/message` triggers an orchestrated 4-step pipeline executed in [`topic-chats-v2.js`](file:///c:/cloop/backend/api/topic-chats/topic-chats-v2.js) and [`orchestrator.js`](file:///c:/cloop/backend/services/tutor-core/orchestrator.js):

```
Student Message
      │
      ▼
┌────────────────────────────────────────────────────────┐
│ STEP 1: Academic Knowledge Graph (AKG) Resolution       │
│ • Loads/caches syllabus boundary, analogies, traps     │
└───────────────────────────────────┬────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────┐
│ STEP 2: Evaluator (Temperature 0.0)                    │
│ • Classifies Intent (ANSWER, HELP, IDK, speed_up, etc) │
│ • Validates question rubric alignment                  │
│ • Detects contradictions & assigns error type          │
│ • Produces complete_answer & diff_html                 │
│ • Applies Grading Guards (feedbackAffirmsAnswer)       │
└───────────────────────────────────┬────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────┐
│ STEP 3: Deterministic State Machine Transition         │
│ • Advances phase (PROBE → THEORY → DIALOGUE → ... )    │
│ • Computes attempt counts & assistance ladder          │
│ • Decides response_mode (teach, check, choice, etc)    │
│ • Produces next stateInstruction                       │
└───────────────────────────────────┬────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────┐
│ STEP 4: Dialogue Generator & Enforcer                  │
│ • Generates pedagogical response from directive        │
│ • Produces private rubric for the next question        │
│ • Formats & splits into micro-bubbles (< 19 words)     │
│ • Strips leaked system labels via student-text.js      │
└───────────────────────────────────┬────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────┐
│ STEP 5: Persistence & Client Delivery (< 1.5s)         │
│ • Updates admin_chat (with __correction__: metadata)   │
│ • Appends chat_goal_progress & learning_turns          │
│ • Saves session_state in chat_process.feedback         │
│ • Returns immediate conversational response            │
└────────────────────────────────────────────────────────┘
```

---

## 3. The 6 Teaching Lifecycle Phases

The tutor guides the learner through 6 structured pedagogical phases defined in [`state.js`](file:///c:/cloop/backend/services/tutor-core/state.js):

```
┌───────┐     ┌────────┐     ┌──────────┐     ┌───────┐     ┌─────────┐     ┌──────┐
│ PROBE │ ──► │ THEORY │ ──► │ DIALOGUE │ ──► │ CHECK │ ──► │ ROUNDUP │ ──► │ WRAP │
└───────┘     └────────┘     └──────────┘     └───────┘     └─────────┘     └──────┘
(Hook Q)     (Mental Model)   (Socratic Q)    (MCQ/Assess)   (Synthesis)   (Report)
```

| Phase | Purpose | Question Type | Scored? | Progression Criteria |
|---|---|---|---|---|
| **`PROBE`** | Everyday intuitive hook question connecting the topic to the student's lived experience. | Open, conversational | **No** (never penalizes prior knowledge) | Advances after student responds. |
| **`THEORY`** | Concise conceptual grounding. Explains core principles without cognitive overload. | Open concept inquiry | **No** | Advances after introducing the mental model. |
| **`DIALOGUE`** | Socratic guided inquiry. Interactive questioning leading the student to discover principles. | Open, concept-focused | **Yes** | Advances upon correct answer or handled assistance. |
| **`CHECK`** | Formal evaluation of the goal. Tests understanding and independent application. | Reasoning MCQ or direct check | **Yes** | Completes goal slot upon verified answer. |
| **`ROUNDUP`** | Topic synthesis across all goals. Rapid recall and conceptual connection questions. | Recall open question & reasoning MCQ | **Yes** | Cycles through each goal before final wrap. |
| **`WRAP`** | Topic completion. Congratulatory closing, performance report, and revision sheet. | None (Session closed) | Final score aggregated | Triggers progressive wrap endpoint (`POST /wrap`). |

---

## 4. Response Modes & The Assistance Ladder

When a student struggles, Cloop does not repeat the question endlessly. The state engine moves through a structured **assistance ladder**:

```
Student Incorrect Answer
          │
          ├─► Attempt 1: response_mode = 'teach'
          │   Tutor provides a hint or alternate angle (without stating the answer).
          │   Asks the check question in fresh words.
          │
          ├─► Attempt 2: response_mode = 'offer_choice'
          │   Tutor pauses questioning and offers choice:
          │   "Would you like me to explain the answer, or would you like another try?"
          │
          ├─► Learner selects "Explain": response_mode = 'explain'
          │   Tutor explains the concept directly in 1–2 micro-bubbles.
          │
          └─► Learner says "Move faster": response_mode = 'closing' (Fast-Track)
              Asks 1 final recall question on current goal, then immediately wraps.
```

---

## 5. Public Feedback & Correction Bubble Contract

The visual presentation of user answers is strictly governed by pedagogical contracts in the backend and [`ChatBubbles.tsx`](file:///c:/cloop/cloop-website/src/features/chat/components/ChatBubbles.tsx):

### 1. Color & Emotion Styling
- **Correct Answer**:
  - Border: Soft green (`#86efac`)
  - Background: Soft green tint (`#f0fdf4`)
  - Text color: Forest green (`#14532d`)
  - Badge emoji: `😊`
- **Incorrect Answer**:
  - Border: Soft red (`#fca5a5`)
  - Background: Soft red tint (`#fef2f2`)
  - Text color: Dark red (`#7f1d1d`)
  - Badge emoji: `😢`

### 2. The "Verified Answer" Container
- Regardless of whether the user answer is correct or incorrect, the **Verified Answer / Correct Answer container is ALWAYS positive green** (`background: #f0fdf4`, `border: 1.5px solid #86efac`, text `#14532d`).
- **Pedagogical Rationale**: The correct scientific fact should always be framed as an affirming, trustworthy anchor, never painted red like a punishment.

### 3. Answer Withholding on Retries (`answerWithheld`)
- When a student gets an answer wrong and the tutor is giving them an **immediate retry on the exact same question**:
  - `complete_answer` is temporarily withheld (`answer_withheld: true`).
  - The student sees their red bubble, crying emoji `😢`, and hint/diff, but the final model answer is not spoiled before they attempt the retry.
  - As soon as the student retries, chooses "Explain the answer", or the session wraps, the verified answer is fully revealed.
  - Correct answers **always** show the verified answer container immediately.

---

## 6. Decoupled Wrap & AI Revision Engine

To prevent the student's final chat turn from freezing for 30–50 seconds, session wrap is cleanly **decoupled**:

```
[User Turn Finishes Final Goal]
              │
              ▼
   POST /:topicId/message
   • Immediately returns final tutor congratulatory bubble
   • Emits all_goals_completed: true (< 1.5 seconds)
              │
              ▼
   Frontend receives response
   • Displays celebratory chat bubble
   • Shows smooth background wrap spinner
   • Fires POST /:topicId/wrap
              │
              ▼
   POST /:topicId/wrap (Single Source of Truth)
   • Generates Postgres-backed 100% accurate metrics (correct ÷ answered)
   • Calls AI Revision Agent with student's actual learning_turns mistakes
   • Queries YouTube for high-relevance curriculum animation videos
   • Persists session_summary and revision_sheet into admin_chat
   • Returns wrap messages to client
              │
              ▼
   Frontend appends wrap cards ONCE (with duplicate ID/type guards)
```

---

## 7. Deterministic Text Sanitization (`student-text.js`)

To guarantee a clean, distraction-free learning experience, all text directed to the student passes through [`student-text.js`](file:///c:/cloop/backend/services/tutor-core/student-text.js):
- **Strips Title Numbering**: `"Topic 1: Introduction to Scientific Inquiry"` → `"Introduction to Scientific Inquiry"`.
- **Drops Internal Introspection Leaks**: Automatically removes model self-talk sentences like `"I cannot verify the smoke answer from this material"` or `"According to my instructions..."`.
- **Enforces Punctuation**: Questions always end with clean question marks; statements end with periods.
