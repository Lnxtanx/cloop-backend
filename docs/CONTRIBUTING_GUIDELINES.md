# Tutor Engineering & Contribution Guidelines

> **Architectural Guardrails, Invariants & Development Protocols**  
> *Confidential — Cloop Educational Technologies*

---

## 1. Non-Negotiable Architectural Invariants

Every engineer working on Cloop's AI Tutor backend or frontend must adhere to the following architectural rules:

### 1. The Server Owns the State Machine — Never the LLM
- The state machine in [`services/tutor-core/state.js`](file:///c:/cloop/backend/services/tutor-core/state.js) deterministically tracks phases, goal indices, error streaks, and mastery completion.
- **Rule**: Never allow an LLM prompt to declare a goal completed or advance to the next phase on its own. State transitions must remain 100% deterministic code.

### 2. Strict Dual-Model Separation
- **Rule**: Never combine evaluation and dialogue generation into a single prompt.
- The **Evaluator** runs at **Temperature 0.0** and outputs strict JSON assessing question criteria against facts.
- The **Generator** runs at **Temperature 0.4** and follows the server's `stateInstruction` to generate micro-bubbles.

### 3. The Verified Answer Container Must ALWAYS Be Green
- **Rule**: The complete model answer container must always be styled with `background: #f0fdf4` and `border: 1.5px solid #86efac` (green).
- Even if a student gets the answer wrong, the correct scientific fact is framed as a positive, reassuring anchor.

### 4. Answer Withholding on Question Retries
- **Rule**: While a student is retrying the exact same question, `complete_answer` must remain withheld (`answer_withheld: true`).
- Revealing the exact answer before a retry tests copy-pasting rather than understanding. The answer is revealed once the student moves on, asks for explanation, or the session ends.

### 5. Keep Session Wrap Decoupled
- **Rule**: Never synchronously generate revision sheets or fetch YouTube videos inside `POST /api/topic-chats/:topicId/message`.
- The chat turn must return in **< 1.5 seconds**. All heavy synthesis belongs in `POST /api/topic-chats/:topicId/wrap`.

### 6. Micro-Bubbles (< 19 Words) & Text Sanitization
- **Rule**: Dialogue generator output must be split into short conversational micro-bubbles. No bubble may exceed 19 words.
- All student-facing text must pass through `forStudent()` in [`student-text.js`](file:///c:/cloop/backend/services/tutor-core/student-text.js) to strip internal introspection notes (`"I cannot verify..."`) and title prefixes (`"Topic 1:"`).

---

## 2. Curriculum Update & Database Protocol

The production database contains live learning history tied to integer IDs in `global_topic_goals`.

### What NOT to Do:
❌ Never drop or truncate `global_topic_goals` or `global_topics`.  
❌ Never insert new goal IDs without mapping existing student progress records.  
❌ Never create arbitrary goal titles that do not match the NCERT textbook.

### Safe Curriculum Update Procedure:
1. **Draft Changes**: Edit or create JSON drafts in `data/curriculum-drafts/` with exact verbatim textbook quotes.
2. **Validate Grounding**: Run `node scripts/check-curriculum-draft.js` to ensure every quote exists in the textbook text.
3. **Export Current Catalog**:
   ```powershell
   node scripts/export-catalog.js --out exports
   ```
4. **Map Existing IDs**: Map new goals to existing database IDs in coordination with the curriculum team.
5. **Run Migration**: Apply changes via tracked SQL migration files in `prisma/sql/`.

---

## 3. Testing & Verification Checklist

Before pushing any changes or opening a PR:

1. **Verify Syntax**:
   ```powershell
   node -c api/topic-chats/topic-chats-v2.js
   node -c services/tutor-core/orchestrator.js
   node -c services/tutor-core/state.js
   ```
2. **Run Core Unit Tests**:
   ```powershell
   node services/tutor-core/state.test.js
   node services/tutor-core/evaluator.test.js
   node services/tutor-core/scoring.test.js
   node services/academic-graph/akg-service.test.js
   ```
3. **Verify Frontend Compatibility**:
   ```powershell
   npm run build --prefix cloop-website
   ```
