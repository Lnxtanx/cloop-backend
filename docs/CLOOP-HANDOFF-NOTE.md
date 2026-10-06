# Cloop backend — handoff note (git state, review, prompt compression)

Prepared as a second-opinion review of the Codex "upgraded prompt" work on `Lnxtanx/cloop-backend`,
plus a follow-up prompt-compression change. Read this before merging or shipping.

---

## 1. The git state is forked — decide which iteration is canonical FIRST

There are **two different Codex upgrades**, and they are siblings, not a line:

```
91793c6  added ai avtar
  └ be39491  Tutor: cover the full syllabus … (curriculum coverage)
      └ 4f0bd4d  Tutor: assess definitions/formulas + exam-readiness round-up   ← common parent
          ├ 9c3ebe0  Upgrade tutor engine … (ITERATION A)  ← currently origin/main
          └ (uploaded patch)  Codex upgrade (ITERATION B)  ← built on 4f0bd4d, NOT on A
```

- **Iteration A = `9c3ebe0`, currently on `main`.** It does **not** contain the separate
  final-test engine. It is missing `services/tutor-core/final-test.js`,
  `final-test-state.js`, `academic-notes.js`, and the `fire-control-replay.test.js` /
  `provider-integrity.test.js` / `teaching-assistance.test.js` suites.
- **Iteration B = the uploaded `cloop-upgrade.patch`.** This is the one the verification doc
  (`fire-control-verification.md`) describes and the one that actually fixes the transcript
  failures. It branches from `4f0bd4d` (A's parent), so **B and A overlap and will conflict on
  merge.**

**Action required:** B is the intended, fixed version. Either reset `main` to B, or merge B and
resolve conflicts in A's favour only where A has a genuinely newer fix. Do **not** assume `main`
is current — today it is the version *without* the fire-control fixes.

Apply order to reproduce the intended tree from `4f0bd4d`:
1. `git checkout -B <branch> 4f0bd4d`
2. `git apply cloop-upgrade.patch`          (iteration B — the Codex upgrade)
3. `git apply cloop-prompt-compression.patch` (the prompt-compression follow-up, below)

---

## 2. Review of iteration B — what's real, what's unproven

**Verified by running it:** `bash scripts/test-tutor-core.sh` → **367 tests across 24 suites pass**,
including a 10-case Fire Control replay that feeds the transcript's bad model outputs and checks the
code cleans them up.

Your three transcript complaints, mapped to the code:

| Complaint | Status | Where |
| --- | --- | --- |
| Corrections cut off mid-clause ("…of the", "…controls") | **Fixed (backend).** `assertCompletionIntegrity` in `deepseek-client.js` rejects any response with `finish_reason: length/max_tokens`; the JSON parser refuses unbalanced braces. Truncated output is retried, then a complete source-backed fallback is used. | `services/ai/deepseek-client.js` |
| Correction text glued to the student's answer ("Water was used**Yes, I have seen…**") | **Backend returns separate fields** (`diff_html`, `complete_answer`, `feedback`); **the glued rendering is a FRONTEND concern and was never tested.** If the UI concatenates `studentMessage + complete_answer` or renders `<del>/<ins>` without visible strikethrough, it will still look broken. | `orchestrator.js`, `public-feedback.js` + **frontend** |
| Same question repeated through confusion | **Loop now terminates deterministically.** Wrong answers + ACK + HELP + IDK share one 3-turn assistance budget; after `STUCK_LIMIT=2` non-answers or 3 total assists the server force-reveals the answer and advances; an explicit "tell me the answer" reveals immediately. **Caveat:** on an ordinary retry the code keeps the same rubric/question by design and only prepends an explanation — whether the re-ask is *reworded* is model-dependent. | `state.js`, `validate.js` |

**The limits to be honest about (the verification doc says the same):**
- **Zero live-model runs.** Every test stubs the provider and DB. The tests prove the *guardrails*,
  not that the live model produces correct science, good clarifications, or good rewording.
- **Frontend untested** — the concatenation fix, text clipping, the new notes/focus-area cards, and
  PDF download were never rendered.
- **Needs a fresh session.** The new engine only activates on a new session; existing/mixed chats
  return `requires_new_session`. Re-running the old chat shows old behaviour. Start via
  `POST /api/topic-chats/:topicId/session/new`.
- **Only as good as the per-topic source content.** Goal generation returns
  `insufficient_content: true` if the stored topic has fewer than two supported concepts. Thin
  Fire Control content → the engine refuses or is forced to teach from a syllabus it's told not to
  guess. Verify topic content exists before trusting any topic.

---

## 3. The prompt-compression follow-up (`cloop-prompt-compression.patch`)

**Why:** iteration B's five runtime prompts had grown dense and topic-specific — a ~50-line
combustion essay, a 15-line fire-control block, and force-example paragraphs loaded on **every**
model call regardless of topic. That bloat over-fit the tutor to combustion and is a likely
contributor to the model confusion in the transcript.

**What it does:** generalises the topic-specific guardrails into universal, source-grounded rules
that still cover every original case, keeping one or two short illustrations. No behaviour change;
deterministic code guards (e.g. the N2-vs-NOx evidence check) are untouched.

| File | Change |
| --- | --- |
| `services/tutor-core/evaluator.js` | combustion + fire + force blocks (~50 lines) → one "SOURCE-GROUNDED ACCURACY (every topic)" rule |
| `services/tutor-core/tutor-generator.js` | rules 6/12/14 de-combusted → general "preserve exact terms / no ambiguous question / no guessed class" |
| `services/tutor-core/final-test.js` | combustion block → general distinct-facts rule |
| `services/topic-chat/prompts/goals_prompt.txt` | force + combustion worked examples and their two rules → one general rule + a single speed example (47 → 27 lines) |
| `docs/CLOOP_UPGRADED_PROMPT.md` | spec synced; §8 combustion example now labelled illustration-only |
| 4 test files | assertions that checked old prompt wording repointed to the new universal phrasing |

**Verified:** full suite still **367 tests / 24 suites pass**. Patch applies cleanly on iteration B.

**Guidance for future prompt edits:** keep the runtime prompts **topic-neutral**. Subject specifics
(combustion, fire, force, etc.) are illustrations only — never bake a subject's facts into a prompt.
When a known failure needs a hard guarantee, add a deterministic code guard (as the N2/NOx check
already does), not another paragraph of prompt.

---

## 4. Pre-ship checklist (operational — not covered by the tests)

1. Resolve the A/B fork (§1); make iteration B canonical.
2. Apply the compression patch on top of B.
3. Confirm the target topic has real source content in the DB.
4. Run ONE live, fresh-session session with a real model key, using the exact transcript answers.
5. In the real frontend, verify: the correction card shows the student answer struck through with the
   complete answer on its own line (no gluing); no clipped text; the score appears only in the
   closing report.
6. Confirm the loop breaks: "I don't know" twice, then "tell me the answer" → full answer + a *new*
   question, not a repeat.
7. Sanity-check the model's science on 2–3 corrections (code can't catch a confident wrong answer).

Code owns routing, question contracts, retry bounds, full-answer preservation, truncation rejection,
the assistance budget, and score arithmetic. Prompts alone cannot guarantee those — which is why the
tests pass and the live/frontend gates above still matter.
