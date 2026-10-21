-- Give each learning goal the facts it teaches.
--
-- global_topic_goals.description holds a learning objective ("Students will
-- explain..."). The tutor cannot teach, grade or recap from an objective, and
-- the validator deliberately refuses to treat one as a fact, so goals written
-- that way left ROUNDUP with nothing to ask and recaps with nothing to list.
--
-- knowledge_statement is the full-mark answer for the goal: 1-3 short factual
-- sentences. Provenance travels with it so an unreviewed statement is never
-- mistaken for a checked one.
--
-- Additive and idempotent: safe to run more than once, touches no existing
-- column or row, and needs no backfill. Equivalent to running `prisma db push`
-- with the schema.prisma change in the same commit.
--
--   psql "$DATABASE_URL" -f prisma/sql/20261021_add_goal_knowledge_statement.sql
--
-- Rollback (drops only the new columns and any statements stored in them):
--   ALTER TABLE global_topic_goals
--     DROP COLUMN IF EXISTS knowledge_statement, DROP COLUMN IF EXISTS knowledge_source,
--     DROP COLUMN IF EXISTS knowledge_verified,  DROP COLUMN IF EXISTS knowledge_updated_at;

BEGIN;

ALTER TABLE global_topic_goals ADD COLUMN IF NOT EXISTS knowledge_statement  TEXT;
ALTER TABLE global_topic_goals ADD COLUMN IF NOT EXISTS knowledge_source     VARCHAR(200);
ALTER TABLE global_topic_goals ADD COLUMN IF NOT EXISTS knowledge_verified   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE global_topic_goals ADD COLUMN IF NOT EXISTS knowledge_updated_at TIMESTAMP(6);

COMMIT;
