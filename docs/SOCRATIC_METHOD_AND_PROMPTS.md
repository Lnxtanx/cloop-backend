# Cloop Socratic Pedagogy & Prompt Engineering Specification

> **Authoritative Technical & Pedagogical Architecture**  
> *Confidential — Cloop Educational Technologies*

---

## 1. Pedagogical Philosophy: Socratic Guided Inquiry

At Cloop, teaching is **not** passive content delivery or conversational recitation. Traditional generative AI chatbots typically answer questions directly, lecture with walls of text, or indiscriminately praise students. In contrast, Cloop's AI Tutor is an active **Socratic Inquiry Engine** designed for K-12 students (Class 6 to Class 12 across CBSE, ICSE, and State Boards).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          THE SOCRATIC DIALOGUE CYCLE                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│      1. ELICITATION (Probe)           2. COGNITIVE ANCHORING (Theory)       │
│      Tap into everyday intuition      Ground in bite-sized mental model      │
│      "What happens when you rub a     "Atoms have 3 particles: electrons,   │
│       plastic comb on hair?"          protons, neutrons. Each has a charge."│
│                      │                                     │                │
│                      ▼                                     ▼                │
│      3. SOCRATIC GUIDANCE (Dialogue)  4. FORMATIVE ASSESSMENT (Check)       │
│      Guide discovery via questions    Verify independent application via    │
│      "If proton is positive, what     targeted reasoning or MCQ checks.     │
│       charge cancels it out?"                                               │
│                      │                                     │                │
│                      ▼                                     ▼                │
│      5. ERROR SCAFFOLDING (Ladder)    6. SUMMATIVE SYNTHESIS (Roundup)      │
│      Scaffold hints, breakdowns, or   Exam-readiness recall in student's    │
│      choice without giving away key   own words across all goals.           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Core Pedagogical Directives
1. **Guided Inquiry Over Lecturing**:
   - Students must construct scientific principles, mathematical logic, and civic relationships through their own deduction.
   - The tutor asks strategic, focused questions rather than writing multi-paragraph lectures.
2. **Grade-Calibrated Cognitive Load**:
   - **Class 6**: Pure concrete observational learning; sensory vocabulary; intuitive real-world examples; zero unnecessary algebraic abstraction or complex jargon.
   - **Class 7**: Descriptive processes, structured reasoning, elementary mechanisms, and simple arithmetic relationships.
   - **Class 8**: Core foundational principles, qualitative cause-and-effect, introductory quantitative relationships, and standard syllabus definitions.
   - **Class 9–10**: Board-standard academic rigor, formal mathematical laws/equations, precise curriculum terminology, and exam-grade conceptual clarity.
3. **Micro-Bubble Communication**:
   - Ordinary turns: 1 to 2 chat bubbles, strictly under 20 words each.
   - Concept breakdowns / explanations: 3 to 4 sequenced micro-bubbles (< 25 words each) breaking down: *Analogy/Hook → Core Mechanism → Everyday Application → Check Question*.
4. **Uncompromising Academic Honesty**:
   - Never provide false praise (e.g., never say "Great job!" or "Spot on!" for incorrect or incomplete answers).
   - Constructive reinforcement: acknowledge whatever partial truth the student noticed, then highlight the missing conceptual link.

---

## 2. The 6-Phase Socratic Teaching Lifecycle

Every topic session progresses through 6 deterministic phases defined in [`state-machine.js`](file:///c:/cloop/backend/ai/agents/socratic-tutor/state/state-machine.js) and [`state.js`](file:///c:/cloop/backend/services/tutor-core/state.js):

```
┌───────┐     ┌────────┐     ┌──────────┐     ┌───────┐     ┌─────────┐     ┌──────┐
│ PROBE │ ──► │ THEORY │ ──► │ DIALOGUE │ ──► │ CHECK │ ──► │ ROUNDUP │ ──► │ WRAP │
└───────┘     └────────┘     └──────────┘     └───────┘     └─────────┘     └──────┘
(Hook Q)     (Mental Model)   (Socratic Q)    (MCQ/Assess)   (Synthesis)   (Report)
```

### Phase 1: `PROBE` (Everyday Intuitive Hook)
- **Goal**: Gauge intuitive prior knowledge before formal terminology is introduced.
- **Rules**:
  - Prompt: [`prompts/dialogue/probe-prompt.js`](file:///c:/cloop/backend/ai/agents/socratic-tutor/prompts/dialogue/probe-prompt.js).
  - Open-ended, warm, connects to everyday life (e.g., rubbing combs, rolling balls, boiling tea).
  - **Unscored**: The student is never penalized for lack of prior knowledge.
  - Generates a flexible prior intuition rubric (`criteria: [{ id: "prior_intuition", required: true }]`).

### Phase 2: `THEORY` (Cognitive Grounding)
- **Goal**: Deliver the core mental model and foundational principles without cognitive overload.
- **Rules**:
  - Delivers 2–3 micro-bubbles explaining the core definitions and mechanisms.
  - Automatically attaches key conceptual points (`attachmentsFor(state) = ["key_points"]`).
  - May attach a cached concept Mermaid diagram (`diagram-cache.js` / `diagram-tool.js`).
  - **Unscored**: Focuses on comprehension before questioning begins.

### Phase 3: `DIALOGUE` (Socratic Guided Questioning)
- **Goal**: Guide the student to articulate and reason through the goal's key mechanism in their own words.
- **Rules**:
  - Prompt: [`prompts/dialogue/socratic-inquiry-prompt.js`](file:///c:/cloop/backend/ai/agents/socratic-tutor/prompts/dialogue/socratic-inquiry-prompt.js).
  - Bubble 1: Brief acknowledgement or conceptual context (< 20 words).
  - Bubble 2: Focused inquiry question requiring written reasoning (< 20 words).
  - **Scored**: Assessment Slot 1 for the goal (`isScored(phase) === true`).
  - Strict private rubric created alongside the question.

### Phase 4: `CHECK` (Formative Multiple-Choice Assessment)
- **Goal**: Verify concept retention and discriminate between common misconceptions.
- **Rules**:
  - Prompt: [`prompts/dialogue/mcq-check-prompt.js`](file:///c:/cloop/backend/ai/agents/socratic-tutor/prompts/dialogue/mcq-check-prompt.js).
  - Delivers 2 to 4 distinct, plausible answer options with exactly one correct option.
  - **Scored**: Assessment Slot 2 for the goal.
  - Evaluated via strict option resolution (`resolveOptionAnswer`).

### Phase 5: `ROUNDUP` (Summative Topic Synthesis & Exam Readiness)
- **Goal**: Test independent recall across **all** goals before concluding the session.
- **Rules**:
  - Cycles through each goal in the topic (`roundupIndex = 0 ... goalTotal - 1`).
  - Prompt: [`prompts/dialogue/roundup-recall-prompt.js`](file:///c:/cloop/backend/ai/agents/socratic-tutor/prompts/dialogue/roundup-recall-prompt.js).
  - Asks the student to state that goal's definition, formula, or core principle in their own words.
  - Optional reasoning MCQ format for Class 9–10 exam readiness (`roundup_reasoning_mcq`).
  - **Scored**: Assessment Slot 3 for each goal. Guarantees the final score is anchored in active recall, not passive recognition.

### Phase 6: `WRAP` (Mastery Reporting & Revision Sheet)
- **Goal**: Session completion, celebratory closing, and revision asset generation.
- **Rules**:
  - Prompt: [`prompts/synthesis/session-wrap-prompt.js`](file:///c:/cloop/backend/ai/agents/socratic-tutor/prompts/synthesis/session-wrap-prompt.js) & [`revision-sheet-prompt.js`](file:///c:/cloop/backend/ai/agents/socratic-tutor/prompts/synthesis/revision-sheet-prompt.js).
  - Pure reporting: no further questions asked.
  - Generates verifiable mastery metrics and grounded revision sheet.
  - Decoupled via `POST /api/topic-chats/:topicId/wrap` for instantaneous UI turns.

---

## 3. The Assistance Ladder & Scaffolding Architecture

When a student struggles, makes a mistake, or expresses confusion, Cloop does not repeat the same question endlessly. The state engine enforces a deterministic **Assistance Ladder**:

```
                              Student Attempt
                                     │
                 ┌───────────────────┴───────────────────┐
                 ▼                                       ▼
          Correct Answer                          Incorrect Answer
      (consecutiveWrong = 0)                   (consecutiveWrong += 1)
                 │                                       │
         Advance to next slot                            ▼
                                                First Wrong Attempt
                                             (unsuccessful_responses = 1)
                                                         │
                                                         ▼
                                            response_mode = 'teach'
                                            • Hint or alternate angle
                                            • Fresh check question
                                            • (complete_answer withheld)
                                                         │
                                                         ▼
                                                Second Wrong Attempt
                                             (unsuccessful_responses >= 2)
                                                         │
                                                         ▼
                                            response_mode = 'offer_choice'
                                            • Asks: "Would you like me to explain
                                              the answer, or another try?"
                                            • Options: ["Explain", "Another try"]
                                                         │
                                    ┌────────────────────┴────────────────────┐
                                    ▼                                         ▼
                            "Explain the answer"                      "I want another try"
                                    │                                         │
                                    ▼                                         ▼
                        response_mode = 'explain'                  response_mode = 'teach'
                        • 3-4 micro-bubble breakdown               • Fresh scaffolded hint
                          (Analogy → Mechanism → Check)            • Retry opportunity
```

### The 4 Response Modes:
1. **`teach` (Attempt 1)**:
   - The tutor isolates the missing concept without giving away the answer.
   - Generates a fresh inquiry question with a new angle.
   - Sets `answer_withheld: true` so the student cannot copy-paste the model answer.
2. **`offer_choice` (Attempt 2)**:
   - Suspends questioning to prevent student frustration and anxiety.
   - Prompt: [`prompts/teaching/choice-offering-prompt.js`](file:///c:/cloop/backend/ai/agents/socratic-tutor/prompts/teaching/choice-offering-prompt.js).
   - Generates interactive choice options:
     - `"Explain the answer"`
     - `"I want another try"`
3. **`explain` (Student Requests Explanation or Selects "Explain")**:
   - Prompt: [`prompts/teaching/concept-breakdown-prompt.js`](file:///c:/cloop/backend/ai/agents/socratic-tutor/prompts/teaching/concept-breakdown-prompt.js).
   - Produces 3 to 4 sequenced conversational micro-bubbles:
     - **Bubble 1 (Intuition / Analogy)**: Everyday physical hook.
     - **Bubble 2 (Core Principle / Mechanism)**: Clear, step-by-step scientific or mathematical logic.
     - **Bubble 3 (Real-World Application)**: Connects to practical observation.
     - **Bubble 4 (Check Question)**: Friendly check question verifying student followed along.
   - Marks the assessment slot as `assisted` (cannot retrospectively earn unassisted mastery).
4. **`task_repair` / `clarify_question` (Student Asks Clarification)**:
   - Triggered when the student asks "what do you mean by that?" or asks about confusing wording.
   - Prompt: [`prompts/dialogue/curiosity-branch-prompt.js`](file:///c:/cloop/backend/ai/agents/socratic-tutor/prompts/dialogue/curiosity-branch-prompt.js).
   - Directly clarifies the question without penalizing the student or advancing attempts.

---

## 4. Prompt Engineering Architecture (`ai/agents/socratic-tutor/prompts/`)

Every prompt in Cloop is modularized, typed, and source-grounded. The prompts directory contains 15 specialized modules:

```
backend/ai/agents/socratic-tutor/prompts/
├── dialogue/
│   ├── curiosity-branch-prompt.js    # Direct answers to curious student queries
│   ├── mcq-check-prompt.js           # Formative multiple-choice generation
│   ├── probe-prompt.js               # Prior intuition hook generation
│   ├── roundup-recall-prompt.js      # Summative recall questions per goal
│   └── socratic-inquiry-prompt.js    # Written reasoning dialogue turns
├── evaluation/
│   ├── intent-classification-prompt.js # Fast intent classification (Temp 0.0)
│   └── rubric-evaluation-prompt.js   # Multi-criterion factual grading (Temp 0.0)
├── synthesis/
│   ├── revision-sheet-prompt.js      # Grounded student revision sheet
│   └── session-wrap-prompt.js        # Closing congratulatory summaries
├── system/
│   ├── master-persona.js             # Core persona, multi-subject tone, rules
│   └── safety-and-grounding.js       # Curriculum boundary & anti-hallucination rules
└── teaching/
    ├── choice-offering-prompt.js     # "Explain or try again?" choice generator
    ├── concept-breakdown-prompt.js   # Stepped 4-bubble conceptual breakdowns
    └── hint-scaffolding-prompt.js    # Scaffolded intuitive hint generator
```

### 1. `system/master-persona.js`
Defines Cloop's identity across subjects:
- **Role**: Socratic Academic Tutor for K-12 students.
- **Subject Adapters**:
  - **Science**: Predict-observe-explain; separate observation from conclusion; fair test parameters; physical cause-and-effect.
  - **Mathematics**: Step-by-step problem-solving; logical equivalence; single-step checks before final calculation.
  - **Social Science**: Cause-and-consequence; maps and timelines; distinguishing fact from historical interpretation.
  - **English / Languages**: Meaning in context; inference from passages; textual evidence quotes.
- **Bubble Formatting Rules**: strictly under 20 words for regular turns; under 25 words for stepped explanation bubbles.

### 2. `dialogue/curiosity-branch-prompt.js`
Solves the classic chatbot dilemma: when a student asks a curious out-of-turn question (e.g., *"Why does water boil?"* or *"Can electrons be split?"*), traditional tutors either ignore it or get derailed.
- **Structure**:
  - **Bubble 1**: Directly and enthusiastically answers the student's question with scientific accuracy (< 30 words).
  - **Bubble 2**: Smoothly bridges the insight back to the active curriculum goal and re-asks the pending task (< 30 words).
- **Rule**: Never penalizes or marks wrong for asking questions.

### 3. `evaluation/rubric-evaluation-prompt.js`
Powers the strict Temperature 0.0 evaluator (`answer-evaluator.js` / `evaluator.js`):
- **Core Directives**:
  - "GRADE THE ACTUAL LAST QUESTION AND EXACT SCENARIO, not a broadly related fact or the entire goal description."
  - "English, spelling, grammar, tense and word order never make content incorrect. Judge the idea."
  - "Evidence must quote the student's actual answer or identify the missing requirement; do not invent content."
  - "Do not return your own correctness verdict or score: the server combines the evidence."

---

## 5. Rubric Generation & Dynamic Evidence Validation

One of Cloop's most powerful architectural safeguards is the **Dynamic Rubric Contract**.

### The Rubric Contract Schema
When the Dialogue Generator creates a question, it simultaneously creates a private grading rubric:

```json
{
  "messages": [
    { "message": "Atoms are made of protons, neutrons, and electrons.", "message_type": "text" },
    { "message": "Which particle carries a negative charge, and which is neutral?", "message_type": "text" }
  ],
  "lastQuestionRubric": {
    "criteria": [
      { "id": "negative_particle", "description": "Names electron as negative", "required": true },
      { "id": "neutral_particle", "description": "Names neutron as neutral", "required": true }
    ],
    "model_answer": "The electron carries a negative charge, and the neutron is neutral."
  }
}
```

### Deterministic Grading Guards:
1. **Question-Rubric Alignment Guard (`validateQuestionRubricAlignment`)**:
   - If the visible question asks for direct naming or classification (e.g., *"Is friction contact or non-contact?"*), the server **forbids** the rubric from secretly requiring an unasked explanation (e.g., *"and explain why"*).
   - If the rubric contains unasked explanation criteria, the server automatically demotes them to `required = false`.
2. **Verbatim Question Requirement Guard (`validateCriterionRequirements`)**:
   - If the evaluator marks a criterion unsatisfied, it must cite the exact words in `lastQuestionText` that established that obligation.
   - If a criterion failed with no corresponding obligation in the question, the server rejects the failure and sets status to `repair_needed`.
3. **Language-Only Error Guard (`evaluator-guards.js`)**:
   - If the model assigns an error like `spelling`, `grammar`, `typo`, or `wording`, but all semantic criteria are satisfied, the server **flips the verdict to `is_correct: true`**.
   - Language mistakes never penalize scientific or conceptual understanding.

---

## 6. Context Enrichment Engine (`context/context-builder.js`)

Before generating any turn, the context builder enriches the prompt with comprehensive domain assets:

### 1. Real-World Everyday Analogies
Contains curated, curriculum-calibrated Indian and everyday life analogies across domains:
- **Friction**: Bicycle brake pads on rims; football rolling on grass blades; rubbing palms on winter mornings.
- **Inertia**: Passengers jerking forward when a bus brakes; dust flying off a struck carpet.
- **Pressure**: Sharp needle vs blunt finger on a balloon; wide shoulder straps on school bags.
- **Optics**: Eye lens flexing to switch focus between blackboard and textbook; magnifying glass focusing sunlight.
- **Circuits**: Water pump pushing water through pipes analogous to a battery driving current.
- **Fractions**: Slicing round pizza or sharing chocolate bars with equal squares.
- **Algebra**: A balance scale where mystery gifts balance known weights.

### 2. Scenario Continuity Locking
Prevents the tutor from switching physical objects mid-lesson. If the initial probe established a scenario about *a plastic scale and bits of paper*, subsequent dialogue turns lock into that same scenario rather than abruptly jumping to comb or amber rod examples.

### 3. Question Deduplication & Pacing
Extracts all previously asked questions from `chatHistory` to ensure no question is ever repeated, preventing loops when students retry concepts.

---

## 7. Public Feedback & Verified Answer UI Contract

When a student answers, the visual feedback delivered to the frontend follows strict pedagogical rules:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    STUDENT ANSWER BUBBLE (CORRECT)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│  the electron ,cause it have negative charge.                           😊  │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ VERIFIED ANSWER:                                                      │  │
│  │ The electron is removed, because it is the negatively charged         │  │
│  │ particle in the atom, while the proton is positive and the neutron    │  │
│  │ is neutral.                                                           │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

1. **Bubble Styling**:
   - **Correct**: Soft green border (`#86efac`), background (`#f0fdf4`), green text (`#14532d`), emoji `😊`.
   - **Incorrect**: Soft red border (`#fca5a5`), background (`#fef2f2`), red text (`#7f1d1d`), emoji `😢`.
2. **The Verified Answer Container**:
   - **Invariant**: The Verified Answer container is **ALWAYS positive green** (`#f0fdf4` / `#86efac`).
   - Rationale: Correct scientific facts are positive anchors of truth. They must never be colored red like an error.
3. **Answer Withholding (`answer_withheld: true`)**:
   - When a student is granted an immediate retry on a question, the model answer is withheld until the retry or choice phase to prevent premature copying.

