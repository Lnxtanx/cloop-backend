# Curriculum Structure & Database Persistence

> **Technical Specification: Curriculum Data Model, Seeding Hierarchy & Session State Persistence**  
> *Confidential — Cloop Educational Technologies*

---

## 1. Overview & Core Philosophy

Cloop separates its data into two distinct domains:
1. **Static Curriculum Hierarchy**: Pre-seeded, structured educational content stored in PostgreSQL (`global_subjects`, `global_chapters`, `global_topics`, `global_topic_goals`).
2. **Dynamic Student Session Ledger**: High-fidelity event and state tables (`admin_chat`, `chat_process`, `chat_goal_progress`, `learning_turns`, `user_topic_reports`) that record every message, attempt, and state snapshot.

> **CRITICAL ARCHITECTURAL INVARIANT**:  
> The database already contains live curriculum data linked to active student progress records. **Developers must never delete, re-seed, or arbitrarily overwrite database goal IDs.** Modifying goal IDs without migration mapping will break student learning history, invalidate topic completions, and corrupt past session reports.

---

## 2. Static Curriculum Hierarchy (Content Seeding)

The static curriculum is organized into a strict four-tier relational tree in PostgreSQL:

```
┌────────────────────────────────────────────────────────┐
│ global_subjects                                        │
│ (id, board, grade, name) e.g. CBSE Class 8 Science     │
└───────────────────────────┬────────────────────────────┘
                            │ 1 : N
                            ▼
┌────────────────────────────────────────────────────────┐
│ global_chapters                                        │
│ (id, subject_id, order, title) e.g. Ch 1: World of Sci │
└───────────────────────────┬────────────────────────────┘
                            │ 1 : N
                            ▼
┌────────────────────────────────────────────────────────┐
│ global_topics                                          │
│ (id, chapter_id, order, title, content, textbook_txt)  │
└───────────────────────────┬────────────────────────────┘
                            │ 1 : N
                            ▼
┌────────────────────────────────────────────────────────┐
│ global_topic_goals                                     │
│ (id, topic_id, order, title, description, core_concept)│
└────────────────────────────────────────────────────────┘
```

### Table Specifications:

#### `global_subjects`
- Identifies the official school curriculum.
- Fields: `id`, `name` (e.g. "Science"), `grade` (e.g. "8"), `board` (e.g. "CBSE", "NCERT").

#### `global_chapters`
- Represents textbook chapters within a subject.
- Fields: `id`, `subject_id`, `order` (sequence index), `title` (e.g. "Exploring the Investigative World of Science").

#### `global_topics`
- Represents individual learning units within a chapter.
- Fields: `id`, `chapter_id`, `order`, `title` (e.g. "How Scientists Investigate"), `content` (concise topic summary), `textbook_content` (authentic textbook excerpt).

#### `global_topic_goals`
- **The fundamental atomic unit of mastery in Cloop.**
- A topic has **2 to 4 goals**.
- Fields:
  - `id`: Unique integer primary key referenced across all analytics.
  - `topic_id`: Foreign key to `global_topics`.
  - `order`: Sequence order within the topic.
  - `title`: Short title of the concept (e.g. "Changing one thing at a time").
  - `description`: Explains what the student learns and the exact scientific criterion required to master the goal.

---

## 3. Dynamic Session Ledger (The 5 State Tables)

When a student chats with the tutor, their interaction is persisted across **5 complementary tables**:

```
                              Student Chat Turn
                                      │
           ┌──────────────────────────┼──────────────────────────┐
           │                          │                          │
           ▼                          ▼                          ▼
   ┌───────────────┐          ┌───────────────┐          ┌───────────────┐
   │  admin_chat   │          │ chat_process  │          │ chat_goal_    │
   │               │          │               │          │   progress    │
   │ User/AI text, │          │ State ledger: │          │ Real-time     │
   │ micro-bubbles,│          │ session_state,│          │ per-goal stats│
   │ diff_html,    │          │ evaluator_res,│          │ (correct,     │
   │ __correction__│          │ question IDs. │          │ questions).   │
   └───────┬───────┘          └───────┬───────┘          └───────────────┘
           │                          │
           ▼                          ▼
   ┌───────────────┐          ┌───────────────┐
   │learning_turns │          │  user_topic_  │
   │               │          │    reports    │
   │ Granular      │          │               │
   │ question log: │          │ Overall topic │
   │ raw answer,   │          │ scorecard:    │
   │ score_percent,│          │ score %,      │
   │ error_type.   │          │ star rating.  │
   └───────────────┘          └───────────────┘
```

### 1. `admin_chat` (The Chat Transcript)
- Primary chat message table storing both user and AI turns.
- **Key Columns**:
  - `sender`: `'user'` or `'ai'`.
  - `message`: Text content of the bubble.
  - `message_type`:
    - `'text'`: Standard micro-bubble.
    - `'user_correction'`: Student answer evaluated with inline diff and verified answer.
    - `'session_summary'`: Summary scorecard card.
    - `'revision_sheet'`: Personalized AI revision sheet.
    - `'mermaid_diagram'`, `'youtube_video'`, `'google_image'`.
  - `diff_html`: Stores inline `<del>` / `<ins>` diff HTML for student corrections, or JSON string for summary/sheet cards.
  - `emoji`: Emotional feedback badge (`😊` for correct, `😢` for incorrect).
  - `options`: String array. For user messages, stores serialized metadata fallback: `['__correction__:' + JSON.stringify(publicCorrection)]`.

### 2. `chat_process` (The Single Source of Truth for Session State)
- Preserves the full internal state machine between turns.
- **Key Columns**:
  - `chat_id`: Links to `admin_chat.id`.
  - `user_message`: Raw student text.
  - `corrected_message`: Model answer or corrected answer string.
  - `feedback`: JSON object containing:
    - `session_state`: The full `TutorState` snapshot (`phase`, `goalIndex`, `perGoal`, `response_mode`, `active_learning_point_id`, `learning_support`).
    - `evaluator_result`: Detailed output from `evaluator.js` (`is_correct`, `score_percent`, `error_type`, `feedback`).
    - `user_correction`: Public student correction object.
    - `active_question_record`: Rubric criteria and question ID.

### 3. `chat_goal_progress` (Goal Progression Tracker)
- Tracks live goal completion per student.
- **Key Columns**: `goal_id`, `user_id`, `chat_id`, `num_questions`, `num_correct`, `num_incorrect`, `is_completed`.

### 4. `learning_turns` (Granular Mastery Log)
- Records every attempted academic question for analytics and AI revision generation.
- **Key Columns**:
  - `topic_id`, `user_id`, `goal_id`, `chat_id`.
  - `question_text`: Verbatim question asked by the tutor.
  - `user_answer_raw`: Verbatim student text.
  - `is_correct`: Boolean verdict.
  - `score_percent`: Graded score (0–100%).
  - `error_type`: Error classification (`'Conceptual'`, `'Incomplete'`, `'Calculation'`).
  - `corrected_answer`: Full model answer.
  - `diff_html`: Sanitized diff.
  - `feedback_text`: Pedagogical feedback.

### 5. `user_topic_reports` (Topic Completion Scorecard)
- Stores the final verified topic metrics.
- **Key Columns**:
  - `user_id`, `topic_id`.
  - `total_questions`, `correct_answers`, `incorrect_answers`.
  - `score_percent`: Computed strictly as `(correct_answers / total_questions) * 100`.
  - `star_rating`: 1 to 5 stars.
  - `performance_level`: `'Needs Improvement'`, `'Good'`, or `'Excellent'`.
  - `metrics_json`: Full breakdown of per-goal scores, error counts, and weak areas.

---

## 4. Session Resumption Contract (`GET /:topicId`)

When a user opens or refreshes a topic chat (`GET /api/topic-chats/:topicId`), the backend reconstructs the state with **zero loss of styling or progress** using a multi-source fallback:

```
                          GET /api/topic-chats/:topicId
                                      │
                                      ▼
                       Fetch admin_chat messages for topic
                                      │
                   ┌──────────────────┴──────────────────┐
                   │                                     │
         Enrich user messages                   Unpack AI messages
                   │                                     │
    1. Check learning_turns                     Parse diff_html JSON
    2. Check chat_process feedback              • session_summary
    3. Check admin_chat.options                 • revision_sheet
       (__correction__:)                        • mermaid_diagram
                   │                                     │
                   ▼                                     ▼
        Restore top-level:                      Deliver unified array:
        • is_correct (boolean)                  messages: [...]
        • complete_answer (string)
        • diff_html & emoji
        • bubble_color (green/red)
```

**Guaranteed Result**: Even after a hard browser reload, correct answers stay green (`#86efac` / `😊`), incorrect answers stay red (`#fca5a5` / `😢`), the Verified Answer container remains visible, and the tutor resumes from the exact state saved in `chat_process`.

---

## 5. Safe Curriculum Update Protocol

If a textbook is updated or topic goals need refinement:
1. **Never edit `global_topic_goals` directly in production.**
2. **Draft the goals** in `data/curriculum-drafts/` with exact quotes as evidence.
3. **Audit the draft** using `scripts/check-curriculum-draft.js` to verify every quote exists verbatim in the chapter text.
4. **Run the catalog exporter**:
   ```powershell
   node scripts/export-catalog.js --out exports
   ```
   This generates `catalog.csv` (subject/chapter/topic/goal IDs) and `goal-usage.csv` (student progress counts).
5. **Map Draft Goals to Existing IDs**: The curriculum team maps new definitions to existing IDs so existing student completion records are preserved.
6. **Apply Database Migration via SQL script**.

