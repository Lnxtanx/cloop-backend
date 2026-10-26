-- Add textbook_content column to global_topics table.
--
-- Holds the verbatim extracted textbook text for each topic.
-- Keeps the existing 'content' column (short pedagogical summary) separate.
--
-- Safe, additive, and idempotent.
--
-- Run with:
--   psql "$DATABASE_URL" -f prisma/sql/20261026_add_topic_textbook_content.sql
--
-- Rollback:
--   ALTER TABLE global_topics DROP COLUMN IF EXISTS textbook_content;

BEGIN;

ALTER TABLE global_topics ADD COLUMN IF NOT EXISTS textbook_content TEXT;

COMMIT;
