# Tutor Lifecycle & Architecture Flowcharts

> **Visual Architectural Guide: Request Pipeline, State Machine Transitions & Decoupled Session Wrap**  
> *Confidential — Cloop Educational Technologies*

---

## 1. End-to-End Chat Turn Execution

This flowchart depicts what occurs on every student message sent to `POST /api/topic-chats/:topicId/message`:

```mermaid
flowchart TD
    A["Student Sends Message"] --> B["handleTopicChatMessageV2\n(api/topic-chats/topic-chats-v2.js)"]
    
    B --> C["1. JIT AKG Resolution\nFetch curriculum bounds & misconceptions"]
    C --> D["2. Evaluator (Temp 0.0)\nClassify intent, grade criteria, detect contradictions"]
    
    D --> E{"Is student answer?"}
    E -- "Yes" --> F["Construct publicCorrection\n(diff_html, complete_answer, 😊/😢)"]
    E -- "No (ACK/HELP/IDK)" --> G["No grading penalties\nSet response mode to support"]
    
    F --> H["3. State Machine (advance())\nUpdate goal progress & compute next stateInstruction"]
    G --> H
    
    H --> I["4. Dialogue Generator (Temp 0.4)\nGenerate tutor response micro-bubbles"]
    I --> J["5. Validator / Enforcer\nSanitize text, split bubbles (<19w), strip 'Topic 1:'"]
    
    J --> K["6. Database Persistence\n• admin_chat (with __correction__)\n• chat_process (session_state)\n• learning_turns & chat_goal_progress"]
    
    K --> L["7. Deliver JSON to Client (<1.5s)\nuserMessage, aiMessages, all_goals_completed"]
```

---

## 2. Pedagogical State Machine & Assistance Ladder

The state machine (`services/tutor-core/state.js`) guides the learner through 6 phases with a deterministic assistance ladder for wrong answers:

```mermaid
stateDiagram-v2
    [*] --> PROBE: Session Starts
    PROBE --> THEORY: Student answers hook question (Ungraded)
    THEORY --> DIALOGUE: Tutor presents core mental model
    
    state DIALOGUE {
        [*] --> AskSocraticQuestion
        AskSocraticQuestion --> EvaluateAnswer
        EvaluateAnswer --> CorrectDialogue: Correct Answer
        EvaluateAnswer --> FirstWrongDialogue: Incorrect (1st time)
        FirstWrongDialogue --> AskSocraticQuestion: Hint provided (teach mode)
        EvaluateAnswer --> SecondWrongDialogue: Incorrect (2nd time)
        SecondWrongDialogue --> OfferChoice: Pause & offer explain/retry
    }
    
    DIALOGUE --> CHECK: Socratic dialogue goal satisfied
    
    state CHECK {
        [*] --> AskCheckQuestion
        AskCheckQuestion --> EvaluateCheck
        EvaluateCheck --> CorrectCheck: Correct Answer
        EvaluateCheck --> RetryCheck: Incorrect (Answer withheld)
    }
    
    CHECK --> DIALOGUE: Advance to Next Goal
    CHECK --> ROUNDUP: All Goals Checked
    
    state ROUNDUP {
        [*] --> RecallGoalQuestions
        RecallGoalQuestions --> ReasoningMCQ: Final synthesis
    }
    
    ROUNDUP --> WRAP: Round-up complete / Fast-track requested
    
    state WRAP {
        [*] --> CelebratoryBubble: Final conversational feedback
        CelebratoryBubble --> TriggerWrapEndpoint: all_goals_completed = true
    }
    
    WRAP --> [*]: Session Completed
```

---

## 3. Fast-Track ("Move Faster") Lifecycle

When a student indicates they already understand the concept or want to accelerate, the system respects their autonomy without failing unasked work:

```mermaid
flowchart LR
    A["Student: 'Can you move faster / I got the concept'"] --> B["teachingRequest('speed_up')"]
    B --> C["state.fastTrack = true\nresponse_mode = 'check'"]
    C --> D["Skip unasked teaching slots\nJump directly to ROUNDUP"]
    D --> E["Ask 1 short recall check on current goal"]
    E --> F["Student answers recall question"]
    F --> G["Immediate transition to WRAP\nendedReason = 'learner_fast_track'"]
    G --> H["Session closes with accurate score\ncounts only questions answered"]
```

---

## 4. Decoupled Wrap & Progressive Revision Sequence

To guarantee instant chat response times (< 1.5s) while still producing deep AI revision sheets and educational YouTube videos, the wrap process is cleanly decoupled:

```mermaid
sequenceDiagram
    autonumber
    actor Student
    participant Browser as Frontend (TopicChat.tsx)
    participant MsgAPI as POST /:topicId/message
    participant WrapAPI as POST /:topicId/wrap
    participant AI as AI Revision Agent
    participant YT as YouTube Search API
    participant DB as PostgreSQL

    Student->>Browser: Submits final answer
    Browser->>MsgAPI: Sends message
    MsgAPI->>DB: Saves user correction & final closing bubble
    MsgAPI-->>Browser: 201 Created { aiMessages: [ClosingBubble], all_goals_completed: true } (~1.2s)
    
    Note over Browser: User sees their answer evaluated & tutor's celebratory greeting instantly!
    Browser->>Browser: Displays "Session Complete" & starts wrap spinner
    
    Browser->>WrapAPI: POST /:topicId/wrap
    WrapAPI->>DB: Loads student's learning_turns (mistakes & error types)
    WrapAPI->>AI: generateRevisionSheetWithAI(learningTurns, metrics)
    AI-->>WrapAPI: Returns targeted tips & video queries
    WrapAPI->>YT: getRevisionVideos(queries, grade, chapter)
    YT-->>WrapAPI: Returns curated educational videos
    WrapAPI->>DB: Persists session_summary & revision_sheet in admin_chat
    WrapAPI-->>Browser: 200 OK { session_summary, revision_sheet }
    
    Note over Browser: Browser appends Scorecard & Revision Sheet ONCE (with duplicate guards)!
```

---

## 5. Related Documentation Links

- [**Cloop AI Tutor Architecture**](file:///c:/cloop/backend/docs/TUTOR_ARCHITECTURE.md)
- [**Socratic Pedagogy & Prompt Engineering Specification**](file:///c:/cloop/backend/docs/SOCRATIC_METHOD_AND_PROMPTS.md)
- [**Complete Codebase Module Map**](file:///c:/cloop/backend/docs/CODEBASE_MODULE_MAP.md)
- [**Curriculum Seeding & Database Schema**](file:///c:/cloop/backend/docs/CURRICULUM_AND_DATABASE.md)
- [**Contributing Guidelines & Architectural Invariants**](file:///c:/cloop/backend/docs/CONTRIBUTING_GUIDELINES.md)


