# CLOOP Topic Chat — Conversation Flow

> Topic: **Sources of Energy** | Goal: "Student understands renewable vs non-renewable energy"

---

## PHASE OVERVIEW

```
For each goal:
  ┌─────────────────────────────────┐
  │   CONCEPT UNDERSTANDING PHASE   │  2–3 questions
  │   (everyday, concrete Q's)      │
  └──────────────┬──────────────────┘
                 │ concept_clarity_score >= 0.80
                 ▼
  ┌─────────────────────────────────┐
  │     EXAM READINESS PHASE        │  2–3 questions
  │   (textbook-style Q's)          │
  └──────────────┬──────────────────┘
                 │ both phases done
                 ▼
  ┌─────────────────────────────────┐
  │       SCORE PREDICTION          │
  │  predicted = concept×50 + exam×50│
  └──────────────┬──────────────────┘
                 │
                 ▼
         Next goal begins
```

---

## SITUATION 1 — Student answers CORRECTLY (Concept Phase)

```
AI:       "If it rains all day, will solar panels produce more or less electricity?"

Student:  "Less electricity because there's no sunlight."

              evaluation:
                concept_clarity_score = 0.90  ✅ CLEAR
                understanding_status  = "CLEAR"
                next_step_type        = "ask_exam_question"

AI Bubble 1:  "Exactly right! No sunlight means no energy conversion."
AI Bubble 2:  "Define renewable energy in one line."
                                           ↑
                              (auto-continues to EXAM phase)
```

---

## SITUATION 2 — Student answers PARTLY CORRECT (Concept Phase)

```
AI:       "Why is coal called non-renewable?"

Student:  "Because it takes time to form."

              evaluation:
                concept_clarity_score = 0.60  ⚠️ PARTLY CLEAR
                understanding_status  = "PARTLY_CLEAR"
                next_step_type        = "recheck_understanding"

AI Bubble 1:  "Partially right. Coal takes millions of years to form —
               so once used, we can't get it back in our lifetime."
AI Bubble 2:  "If we burn all coal today, can we make more coal
               in the next 100 years — yes or no?"
                                           ↑
                              (auto-continues — recheck question)
```

---

## SITUATION 3 — Student answers WRONG (Concept Phase)

```
AI:       "If you push a book and it doesn't move, what type of friction is acting?"

Student:  "Kinetic friction."

              evaluation:
                concept_clarity_score = 0.20  ❌ UNCLEAR
                understanding_status  = "UNCLEAR"
                next_step_type        = "recheck_understanding"

AI Bubble 1:  "Not quite."
AI Bubble 2:  "Kinetic friction acts when something is already moving.
               When an object is still and resists being pushed, that's
               static friction."
AI Bubble 3:  "A car parked on a slope doesn't slide — which friction
               is keeping it in place?"
                                           ↑
                   (auto-continues — simpler recheck on same concept)
```

---

## SITUATION 4 — Student says "I don't know"

```
AI:       "How is solar energy different from coal energy?"

Student:  "idk" / "I don't know" / "skip"

              evaluation:
                concept_clarity_score = 0.10
                understanding_status  = "UNCLEAR"
                next_step_type        = "recheck_understanding"
                diff_html             = null  (no correction shown)

AI Bubble 1:  "No problem! Solar energy comes from sunlight —
               it's free and never runs out. Coal is dug from the
               ground and will finish one day."
AI Bubble 2:  "Which one — solar or coal — do you think will last
               forever?"
                                           ↑
                   (auto-continues — no punishment, easier question)
```

---

## SITUATION 5 — Student answers CORRECTLY in Exam Phase

```
AI:       "Define renewable energy."   [EXAM phase]

Student:  "Energy that can be replenished naturally."

              evaluation:
                question_mode  = "exam"
                next_step_type = "continue_exam_question"

AI Bubble 1:  "Well said."
AI Bubble 2:  "Name two examples of non-renewable sources of energy."
                                           ↑
                              (auto-continues — next exam question)
```

---

## SITUATION 6 — Student answers WRONG in Exam Phase

```
AI:       "State one advantage of wind energy."   [EXAM phase]

Student:  "It is cheap to build windmills."

              evaluation:
                question_mode  = "exam"
                next_step_type = "continue_exam_question"

AI Bubble 1:  "Close, but the key advantage is that wind energy
               is renewable and causes no pollution."

User correction bubble:
  diff_html: "It is <del>cheap to build windmills</del>
              <ins>renewable and causes no pollution</ins>."

AI Bubble 2:  "What is one disadvantage of solar energy?"
                                           ↑
                              (auto-continues — next exam question)
```

---

## SITUATION 7 — Goal Complete → Score Prediction

```
[After concept phase ✅ + exam phase ✅ for this goal]

              evaluation:
                next_step_type = "predict_score"

AI Bubble 1:  "Great work on 'Renewable vs Non-Renewable'!
               Based on your responses, I predict you'll score
               around 78% on this topic."

score_prediction: {
  concept_score:   0.85,
  exam_score:      0.70,
  predicted_score: 77.5
}

AI Bubble 2:  "Now let's look at the next idea — [Next Goal Title].
               Here's a question to start: ..."
                                           ↑
                         (auto-continues to NEXT GOAL's concept phase)
```

---

## SITUATION 8 — All Goals Complete → Session Summary

```
[All goals have reached predict_score]

AI: Session summary card shown with:
  - Total questions asked
  - Correct / Incorrect count
  - Overall predicted score
  - Per-goal breakdown
  - Star rating (≥90→5⭐, ≥75→4⭐, ≥60→3⭐, ≥40→2⭐)

Topic marked: is_completed = true, completion_percent = 100%
```

---

## FULL EXAMPLE — Single Goal, End to End

```
── GOAL: "Renewable vs Non-Renewable" ──────────────────────────────

[CONCEPT PHASE]

AI:      "If it rains all week, will a solar power plant produce
          the same electricity as usual?"
Student: "No, less because no sun"
          → score 0.85 CLEAR (still need 1 more concept Q)

AI:      "Why can't we make more coal once it's all used up?"
Student: "Coal takes million years to make underground"
          → score 0.88 CLEAR → concept phase done ✅

[EXAM PHASE]

AI:      "Define non-renewable energy."
Student: "Energy that cannot be replenished naturally."
          → score_percent 95 → next exam Q

AI:      "Name two renewable sources of energy."
Student: "Solar and wind"
          → score_percent 100 → exam phase done ✅

[SCORE PREDICTION]

AI:      "Excellent work! Based on your understanding and exam
          answers, I predict you'll score around 91% on this goal."
          → concept_score: 0.87, exam_score: 0.97, predicted: 92

AI:      "Let's move to the next concept. [Next goal Q]..."

── END OF GOAL ─────────────────────────────────────────────────────
```

---

## KEY RULES SUMMARY

| Rule | Behavior |
|------|----------|
| Auto-continue | AI always ends `messages[]` with next question — never waits |
| Phase gate | Exam questions only start after concept_clarity_score ≥ 0.80 |
| Recheck | PARTLY_CLEAR (0.50–0.79) → 1 more targeted concept question |
| No-attempt | "I don't know" → hint + easier question, no punishment |
| Goal complete | When AI returns `next_step_type: predict_score` |
| Topic complete | When ALL goals reach `predict_score` → completion_percent = 100% |
| Score formula | `predicted = (concept_score × 50) + (exam_score × 50)` |
| Never say | "Shall we move on?", "Ready?", "Should we proceed?" |
