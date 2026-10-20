# Cloop tutor repair: implementation instructions

Base commit: `d0bfc4db303f58d8963465c7187046378e6c9c7b`.

Apply the supplied patch as one change. It contains code, both runtime paths, prompt changes and tests. Replacing only the prompt leaves the API and state bugs active.

## 1. Create the implementation branch

Extract the handoff ZIP outside your repository. Keep `cloop-tutor-repair.patch` in that extracted directory. Open a terminal in your backend repository. Use a clean working tree; keep unrelated work on its existing branch.

```bash
git status --short
git fetch origin
git switch -c fix/tutor-support-and-media d0bfc4db303f58d8963465c7187046378e6c9c7b
```

The first command should show no local changes before switching. If this base commit is unavailable, fetch it from the same repository. This patch is pinned to that base rather than an assumed production version.

## 2. Apply the code

Replace `/path/to/handoff` with the extracted ZIP directory. Use quotes if the path contains spaces.

```bash
git apply --check /path/to/handoff/cloop-tutor-repair.patch
git apply /path/to/handoff/cloop-tutor-repair.patch
git diff --check
```

If the check fails, stop applying files individually. First confirm the base SHA and clean branch. Integrate later main-branch changes through a normal reviewed merge after this branch passes its tests.

## 3. Install and run the checks

Confirm the normal V2 route is active: `ENABLE_TUTOR_CORE_V2` must not be `false`, and the frontend must not send `x-tutor-version: v1` or `?v=1`. The legacy V1 engine is outside this patch.

Use the project's supported Node version and existing package lock. No new package, environment variable or database migration is required.

```bash
npm ci
npm run test:tutor-repair
npm test
```

`test:tutor-repair` runs separate processes for the tutor suites, context grounding and topic-chat API. Its new production-agent integration test uses the actual agent, evaluator, state, generator and formatter with external provider/inspector I/O stubbed. It cannot silently pass through the compatibility orchestrator instead.

`npm test` also checks the existing academic, topic and authentication suites. It requires permission to bind a local port for authentication HTTP tests. On Windows, run that existing Bash command in WSL/Git Bash; the new repair command runs directly in Node.

## 4. What the patch changes

| Files | Required behaviour implemented |
|---|---|
| `state/state-machine.js` and `services/tutor-core/state.js` | First unsuccessful response teaches; second offers explanation or one more try. Applies during THEORY, OBJECTIVES, DIALOGUE, CHECK and ROUNDUP. Retry preserves struggle history. |
| Agent, compatibility orchestrator and `question-contract.js` | Support choices, explanations and recaps preserve a valid pending academic question. Invalid rubrics are retired and replaced before grading resumes. |
| `learning-requests.js` and both evaluators | Explanation, clarification, recap and example requests are ungraded controls. Conditional wording such as “before we move on” cannot skip the lesson. |
| Both evaluators | A missing required point needs evidence that the question actually requested it. Unsupported requirements produce ungraded task repair. Valid partial answers are retained; complete answers remain available. |
| Both formatters and generators | Remove objective-heading fallback questions, supply source-backed recall tasks, preserve complete scientific wording and allow explanation-only responses. |
| `context/context-builder.js` | Never manufacture a definition, mechanism or unit from a title or learning objective. Missing factual content remains explicitly missing. |
| `media-policy.js`, agent and topic-chat API | HELP/IDK alone does not attach media. The API follows the final attachment plan and deduplicates stable asset IDs within a session. Explicit replay works. |

The ordinary phase sequence remains PROBE → THEORY → OBJECTIVES → DIALOGUE/CHECK per goal → ROUNDUP → WRAP → DONE. Scores, revision sheets, completion checks and stars remain in the teaching engine. Provider, Flash thinking and model-tier configuration are unchanged.

## 5. Support-turn behaviour

- “Explain the answer” delivers the explanation now, without another compulsory quiz. It holds the phase. The student's next acknowledgement resumes progression.
- Revealing the last recall answer delivers teaching before WRAP. A revealed answer does not certify independent mastery.
- Asking for an answer does not create a wrong answer or increase the assessed-question denominator. Any genuine previous wrong answer remains recorded.
- “What do you mean by effect?” explains the wording and preserves the question. It does not count as another failed attempt.
- “List all concepts and definitions before we move on” returns factual topic notes. Longer recaps use short pages. “Continue” sends the queued page without another model call or a grade.
- Explicit video/diagram requests preserve the pending task and do not become failed academic answers.
- Exit commands and the existing turn cap still close with a report, including during question repair.

## 6. Verify the release in staging

Deploy this branch to staging using your existing deployment process. Start a NEW session; old saved rubrics and old chat messages do not retroactively change.

Use “What Is a Force?” with the existing board/grade syllabus. Check these exact cases in the UI and inspector:

1. Ask “What is a force, and who or what can exert one?” Answer “Force is a push or pull. One object can exert it on another.” It must not fail for omitting an unasked non-living example.
2. Reply “I don't know” twice on the same learning point. The second reply must offer Explain/Another try without repeating the failed question.
3. Select “Explain the answer.” Confirm complete explanation, no new compulsory quiz, no wrong-answer card. Reply “OK”; the session continues.
4. Ask “What do you mean by which effect?” Confirm a definition of effect in the current scenario, unchanged attempt count and no score.
5. Ask for all definitions before moving on, then “continue” when offered. Confirm remaining definitions arrive and the lesson has not been skipped.
6. Give an incomplete but valid answer. Confirm feedback names the missing point and does not strike out correct content. Apostrophes must display normally in plain-text answers.
7. Repeat HELP/IDK. Confirm no automatic video or concept diagram. Request a video explicitly, then continue normally; the same link must not reappear automatically. Explicitly requesting the same video again may replay it.
8. Complete a fresh three-goal session correctly. Confirm three DIALOGUE, three CHECK and three ROUNDUP assessment slots, followed by report, revision sheet and stars. No score appears before WRAP.
9. Ask for the final recall answer. Confirm explanation first, then a report after acknowledgement, with assisted/skipped evidence rather than invented independent mastery.
10. Exit while the tutor is repairing a question. Confirm a terminal report instead of another repair loop.

For any failed case, save the deployed SHA, answered phase, visible question, private rubric, evaluator evidence, directive, response mode, validated bubbles and attachment plan. Keep credentials and student identifiers out of shared traces.

Also inspect the MCQ content: a resting book still experiences forces; force does not require motion. A question about turning a ball must establish that it was already moving. These semantic checks still require a real-provider staging replay; deterministic unit tests do not independently certify arbitrary generated science.

## 7. Commit and release

```bash
git diff --check
git add ai/agents/socratic-tutor api/topic-chats services/tutor-core scripts/test-tutor-repair.js package.json docs/TUTOR_REPAIR_IMPLEMENTATION.md
git commit -m "Fix tutor support routing, academic fallbacks and selective media"
```

Merge through your existing reviewed release process only after both test commands and the staging cases pass. Keep the current DeepSeek Flash/thinking settings. Record first-text and complete-turn timings on the same workload as the existing 2.9-second benchmark; this patch makes no independent latency guarantee.

## 8. Rollback

Redeploy the preceding application release, or revert this repair commit on the release branch. No database rollback is needed. Keep saved history; begin a fresh session when comparing either version.

## Evidence boundary

See the handoff's `TEST_RESULTS.txt` for commands and counts actually run. Automated verification uses provider/database stubs. The live inspector, production deployment and paid model calls were not exercised in this environment. Frontend component code is outside this backend patch; if correctly escaped `diff_html` still appears as literal entities after staging, check that the correction renderer parses its allowed markup exactly once.
