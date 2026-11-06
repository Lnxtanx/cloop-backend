# Cloop Backend

> **Mastery-Driven Educational Learning Platform for K-12 Students**  
> *Core Services, Topic Chat API, and Dual-Model Socratic Tutor Engine*

---

## 📚 Complete Technical Documentation

To ensure all developers and contributors maintain architectural integrity and understand our pedagogical contracts, refer to the authoritative documentation suite in [`docs/`](docs/):

| Document | Description |
|---|---|
| 📖 **[Tutor Architecture Specification](docs/TUTOR_ARCHITECTURE.md)** | Master specification: Deterministic state engine, dual-model separation (Evaluator vs Generator), AKG perimeter control, and decoupled wrap engine. |
| 🗄️ **[Curriculum & Database Persistence](docs/CURRICULUM_AND_DATABASE.md)** | Relational curriculum hierarchy (`global_subjects` → `global_chapters` → `global_topics` → `global_topic_goals`), content seeding model, and the 5 dynamic session tables. |
| 📊 **[Tutor Lifecycle & Flowcharts](docs/TUTOR_LIFECYCLE_FLOWCHART.md)** | Mermaid diagrams: End-to-end turn processing, the 6 teaching phases (`PROBE` → `WRAP`), the assistance ladder, and decoupled wrap sequence. |
| 🛡️ **[Developer Contributing Guidelines](docs/CONTRIBUTING_GUIDELINES.md)** | Architectural guardrails, non-negotiable invariants, and the protocol for safe curriculum updates. |

---

## 🛠️ Key Architectural Components

### 1. Dual-Model Socratic Tutor (`services/tutor-core/`)
- **Deterministic State Engine (`state.js`)**: Server-owned state transitions through `PROBE`, `THEORY`, `DIALOGUE`, `CHECK`, `ROUNDUP`, and `WRAP`.
- **Evaluator (`evaluator.js` / Temp 0.0)**: Strict factual rubric grading, contradiction detection, and diff generation.
- **Dialogue Generator (`tutor-generator.js` / Temp 0.4)**: Socratic micro-bubble dialogue (< 19 words per bubble) driven by server directives.
- **Enforcer & Sanitizer (`validate.js` + `student-text.js`)**: Enforces formatting, splits bubbles, strips unearned praise, and removes title numbering and introspection leaks.

### 2. Academic Knowledge Graph (AKG) — `services/academic-graph/`
- **Curriculum Perimeter Enforcement**: Strictly prevents higher-grade concepts from leaking into introductory topics.
- **JIT Read-Through Cache**: Caches topic perimeter intelligence in `topic_academic_intelligence`.
- **Misconception Traps**: Informs the evaluator of common student traps for precise, helpful feedback.

### 3. Topic Chats API — `api/topic-chats/`
- **`topic-chats-v2.js`**: Modern V2 message handler connecting the client to the tutor-core pipeline.
- **`topic-chats.js`**: Session initialization, greeting generation, state restoration, and the decoupled wrap endpoint (`POST /:topicId/wrap`).

### 4. Media & Revision Services — `services/topic-chat/` & `services/media-search.js`
- **`session-report.js`**: Deterministic Postgres-backed session score calculation (`correct ÷ answered`).
- **`revision-sheet-generator.js`**: AI Revision Sheet Agent that personalizes recall tips based on the student's actual session errors.
- **`media-search.js`**: YouTube and image search grounded in grade level, chapter, and AI-targeted queries.

---

## 🚀 Environment Configuration

Key environment variables required in `.env`:

```env
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/cloop"

# LLM Providers
DEEPSEEK_API_KEY="sk-..."
GEMINI_API_KEY="AIzaSy..."

# Media Search
YOUTUBE_API_KEY="AIzaSy..."
GOOGLE_API_KEY="AIzaSy..."
GOOGLE_CX_ID="..."

# Tutor Feature Flags
ENABLE_TUTOR_CORE_V2="true"
```

---

## 🧪 Testing & Verification

Run core unit test suites offline:

```powershell
# Core State Machine & Evaluator Tests
node services/tutor-core/state.test.js
node services/tutor-core/evaluator.test.js
node services/tutor-core/scoring.test.js

# Academic Knowledge Graph Tests
node services/academic-graph/akg-service.test.js

# Diagram Cache Tests
node services/tutor-core/diagram-cache.test.js
```

---

## 📝 Catalog Export Protocol

To export the current database catalog for curriculum mapping:

```powershell
node scripts/export-catalog.js --out exports
```

Generates `catalog.csv` and `goal-usage.csv` without personal data to allow safe mapping of new textbook goals to existing database IDs.
