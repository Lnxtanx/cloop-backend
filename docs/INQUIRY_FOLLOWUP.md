# Scientific Inquiry follow-up: confirmed defects and implementation

Base: `729c025bed82f1288e7594ec8078e9f94f958981`.

The public repository at this commit matches the previously supplied repair handoff. These defects were missed in that handoff; the repository comparison does not show an omitted application of the patch by the developer. Production deployment identity remains separate from this source comparison.

## Confirmed failures

1. The fallback code generated “State the 1 key facts…” by counting sentences. One sentence contained three required components. This made the visible task misleading and the rubric inconsistent.
2. ROUNDUP overwrote a valid generated observation/inference question and rubric. An objective-only stored goal could then produce an explanation-only fallback on every acknowledgement. This loop was reproduced with no live model calls.
3. The exit parser recognised “end session” but rejected “Pls end this session” and “Please end this session”.
4. The exact request “Ok. Give me a list of all that I have been taught.” did not match the recap parser.
5. While waiting for a replacement question, the evaluator was bypassed and the state guard could swallow the composite “I got it. Move on”.

The earlier tests used simpler command strings and factual goal fixtures. They did not cover this realistic objective-only final-recall acknowledgement sequence. Passing counts did not establish live pedagogical quality.

## Apply this follow-up

Do not reapply the original d0bfc4d-base patch. This is an incremental patch on the committed repair.

Extract this ZIP outside the backend repository. In a clean backend checkout:

```bash
git fetch origin
git switch -c fix/inquiry-recall-and-controls 729c025bed82f1288e7594ec8078e9f94f958981
git apply --check /path/to/handoff/cloop-inquiry-followup.patch
git apply /path/to/handoff/cloop-inquiry-followup.patch
git diff --check
npm ci
npm run test:tutor-repair
npm test
```

Replace the patch path with the extracted path. If the check fails, confirm the base before applying individual files. Integrate newer main-branch work through the normal reviewed merge process after this branch passes.

## Behaviour implemented

- A shared command parser recognises polite, abbreviated and composite exit/move requests before grading or question-recovery guards. Quoted commands, negations and science answers such as “stop motion” do not become exit commands.
- The exact recap request is handled as a learning request, without scoring or changing the recall pointer.
- A valid ROUNDUP question and rubric survive formatting when the stored goal contains a learning objective. Known factual rubrics remain protected against being reduced to an easier subset.
- A list of three inquiry components produces an explicit three-component question with three atomic criteria. Sentence count is not used as a mark or required-item count.
- Repeated failure to produce a valid question is bounded. After two failed replacements, the item is left unverified, without a wrong-answer penalty; acknowledgement resumes progression and the report remains available. Intentional explanations and recaps are not counted as generation failures.
- Both generator prompts distinguish an evidence-based inference from an unsupported guess and prohibit inventing colour, motion or temperature conditions.

ROUNDUP, scoring, reports, revision sheets, stars, mobile bubble limits and Flash thinking remain in place. No package dependency, environment setting or database migration changes are required.

## Run the exact staging replay

Start a fresh Scientific Inquiry session on the branch. Also test a saved session that was already waiting for a replacement question.

1. Reach the last observation/inference recall. With objective-only stored goal text, verify that a valid generated question remains visible and its rubric remains saved.
2. Reply “Yes”, “Ok”, “Correct”, “Got it” repeatedly. The session must not deliver an unlimited sequence of identical definitions. No acknowledgement earns mastery credit.
3. Send “I got it. Move on”. Confirm the recall pointer advances or the report appears if this was the last item. The command must not be graded as a science answer.
4. Send “Ok. Give me a list of all that I have been taught.” Confirm a sourced recap appears; use “continue” to read any remaining pages. No unrelated ball question may replace it.
5. Send “Pls end this session”. Confirm WRAP with the report and revision sheet. Repeat with “Please end this session” and “Ok, please stop this lesson”.
6. Simulate a generator returning no usable question twice. Confirm the item becomes unverified, does not increase wrong answers, and progression resumes after acknowledgement.
7. Replay a fully correct session and confirm all recall goals still run before a complete report.

For science quality, use `SCIENTIFIC_INQUIRY_REFERENCE.md` to check the actual curriculum notes and generated teaching. The reference is not automatically written to the production database. Correct any contradictory source material through the existing curriculum-editing workflow; prompts cannot certify an inaccurate source.

## Release and rollback

Commit the follow-up as one change, run the existing review/deployment process and retain the deployed SHA with the replay results. Revert that commit or redeploy the preceding release to roll back. No database rollback is needed. Keep provider configuration unchanged.

## Test boundary

See `TEST_RESULTS.txt` for commands and counts actually run. New tests exercise the real production tutor pipeline with provider/database I/O stubbed, including the exact command strings, objective-only final goal and acknowledgement loop. They do not constitute a live DeepSeek replay or a guarantee that every generated scientific statement is correct.
