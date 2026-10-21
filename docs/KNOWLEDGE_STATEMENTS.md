# Knowledge statements

Every learning goal has a `description`, and most descriptions are learning
objectives: *"Students will explain the role of curiosity and questioning."*
An objective says what to learn, not what is true, so the tutor cannot teach,
grade or recap from it.

`global_topic_goals.knowledge_statement` holds what is true: the goal's
full-mark answer. When a goal has one, the tutor uses it everywhere it needs
facts:

| Where | What changes |
|---|---|
| Teaching | DeepSeek receives the statement as `next_goal.key_facts` and teaches those facts |
| ROUNDUP grading | DeepSeek's recall rubric must copy each fact word for word; if it doesn't, or if DeepSeek gives no usable question, the validator builds the question from the statement |
| Recap ("list what I've been taught") | Lists every goal's statement |
| Goals without a statement | Behave exactly as before |

Code: `services/tutor-core/academic-notes.js` (`buildAcademicNotes`),
`sourceFactsFor` / `topicFactsFor` in `services/tutor-core/validate.js` and its
production copy `ai/agents/socratic-tutor/formatters/bubble-formatter.js`.

## Writing a statement

- **1 to 3 sentences**, each one a point an examiner would award a mark for.
- **Facts, not objectives.** "An inference is a conclusion based on
  observations" — not "Students will understand inferences".
- **No lesson summaries.** "This topic introduces…" is refused.
- **No examples inside the statement.** Examples belong in teaching; a
  statement is what the student must recall.
- **Match the goal as written**, at the class level of the topic.
- Separate two facts with a semicolon or a full stop.

The importer checks every sentence with the same filter the tutor uses, so an
objective or summary is refused at import rather than silently ignored later.

### Shapes that give the best fallback questions

The validator builds a recall question from the statement only when DeepSeek's
question can't be used. These shapes produce clear questions:

| Statement | Fallback question |
|---|---|
| `Scientific inquiry includes observing, asking a question, guessing a possible answer, testing the guess and analysing the results.` | Name all 5 components of scientific inquiry? |
| `An observation is …; an inference is …` | Define observation and inference? |
| `A thermometer is an instrument that measures temperature.` | What is meant by thermometer? |
| `Curiosity sparks questions about how and why things happen.` | What does curiosity spark? |
| `Scientific inquiry starts with curiosity and careful observation.` | What does scientific inquiry start with? |

Other shapes still work for teaching and recap; if the validator can't build a
question from them it keeps DeepSeek's.

## Loading statements

Statements live in `data/knowledge-statements/*.json` (see
`scientific-inquiry.json`) and are loaded with:

```bash
node scripts/import-knowledge-statements.js data/knowledge-statements/scientific-inquiry.json          # dry run
node scripts/import-knowledge-statements.js data/knowledge-statements/scientific-inquiry.json --apply  # write
```

- The dry run prints every goal it matched. Check it before `--apply`.
- Topics are matched by title without the `Topic N:` prefix. The same topic
  forked into several subjects gets the statement in every copy; add
  `"subject_id"` or `"topic_id"` to limit it to one.
- Goals are matched by `goal_title_includes` words or by `goal_id`. Each entry
  must match exactly one goal, or nothing is written.
- `source` is required and is stored with every statement.
- `verified` stays `false` until a teacher has checked the statements against
  the board textbook. A verified statement is never overwritten without
  `--force`, and re-importing the same words unverified keeps it verified.

The Scientific Inquiry pilot has two files. Import `scientific-inquiry.json`
first (all three goals, unverified), then `scientific-inquiry.verified.json`
(goals 1 and 2, checked against NCERT *Curiosity* Grade 6, Chapter 1). Goal 3,
observation and inference, is not in that chapter, so it stays unverified.

## Statements for every other topic

Writing a statement for every goal by hand is slow, so DeepSeek drafts them
and a teacher checks them. Drafts never reach students until a teacher has
approved them.

1. **Draft** a batch (one chapter or subject at a time works well):

   ```bash
   node scripts/draft-knowledge-statements.js --chapter 5
   node scripts/draft-knowledge-statements.js --subject 22 --limit 10
   ```

   It finds goals that have no statement, sends DeepSeek the board, class,
   chapter, topic content and goal titles, checks every draft with the
   importer's own validator, and retries a refused draft once. It writes a
   review-queue file to `data/knowledge-statements/review/` (not committed)
   and nothing to the database. Forked copies of the same topic are drafted
   once. A goal that already has a statement in any copy is skipped. A goal
   DeepSeek is unsure about comes back empty and flagged for the teacher.

2. **Review.** The teacher opens the queue file in the review page, checks each
   statement against the textbook, approves, edits or skips it, enters their
   name and the textbook, and exports. Only approved statements are exported,
   with `"verified": true` and the teacher's name as `source`. Each forked copy
   is pinned by `topic_id` and `goal_id`.

3. **Import** the exported file with the usual dry run, then `--apply`. Keep
   the exported file in `data/knowledge-statements/` as the record.

The importer refuses a review-queue file (`"review_queue": true`), so
unchecked drafts cannot be loaded by mistake.

The review page's check (`services/curriculum/knowledge-review.js`) is the
same as the importer's; `knowledge-review.test.js` keeps them in agreement.

## Deploying the column

Run the SQL **before** deploying code that includes this change:

```bash
psql "$DATABASE_URL" -f prisma/sql/20261021_add_goal_knowledge_statement.sql
```

`npm run deploy` runs `prisma migrate deploy`, but this repository has no
`prisma/migrations` folder, so deploys do not change the database. If the code
ships first, the regenerated Prisma client queries columns that do not exist
yet and every goal lookup fails. The SQL is additive and idempotent, and the
code currently in production ignores the new columns, so running it early is
safe. Rollback SQL is in the file's header.
