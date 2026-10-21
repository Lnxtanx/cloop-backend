#!/usr/bin/env node
/**
 * Draft knowledge statements for goals that have none, into a review queue.
 *
 *   node scripts/draft-knowledge-statements.js --subject 22 --limit 10
 *   node scripts/draft-knowledge-statements.js --chapter 5 --out data/knowledge-statements/review/ch5.json
 *   node scripts/draft-knowledge-statements.js --topic 101
 *
 * Nothing is written to the database. A teacher opens the queue file in the
 * review page, approves or corrects each statement, and exports an import file
 * marked verified. Load that file with scripts/import-knowledge-statements.js.
 * Uses the DeepSeek reasoning model (DEEPSEEK_API_KEY) on each topic once.
 */

const fs = require('fs');
const path = require('path');
const { draftBatch } = require('../services/curriculum/draft-knowledge-statements');

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const number = name => (option(args, name) ? Number(option(args, name)) : undefined);
  const options = { subjectId: number('subject'), chapterId: number('chapter'), topicId: number('topic'), limit: number('limit') ?? 20 };
  if (Object.values(options).some(value => value !== undefined && !(Number.isInteger(value) && value > 0))) {
    console.error('Usage: node scripts/draft-knowledge-statements.js [--subject ID] [--chapter ID] [--topic ID] [--limit N] [--out FILE]');
    process.exitCode = 2;
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  const out = option(args, 'out') || path.join('data/knowledge-statements/review', `drafts-${date}-${Date.now()}.json`);

  const { deepseek } = require('../ai/providers');
  const invoke = (systemPrompt, user) => deepseek.invokeModel(systemPrompt, [{ role: 'user', content: user }], {
    model: deepseek.MODELS.PRO, jsonFormat: true, temperature: 0.2, maxTokens: 4096,
    featureArea: 'curriculum', subFeature: 'knowledge-statement-drafts',
  });

  const prisma = require('../lib/prisma');
  try {
    const queue = await draftBatch(prisma, { ...options, date }, { invoke, extractJson: deepseek.extractJson, log: console.log });
    if (!queue.topics.length) {
      console.log('No goals without a knowledge statement in this scope.');
      return;
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(queue, null, 2)}\n`);
    const goals = queue.topics.flatMap(topic => topic.goals);
    const flagged = goals.filter(goal => goal.draft_problems.length).length;
    console.log(`\nWrote ${goals.length} draft(s) for ${queue.topics.length} topic(s) to ${out}`);
    if (flagged) console.log(`${flagged} draft(s) are flagged for the teacher to rewrite.`);
    console.log('Nothing was written to the database. Send this file to a teacher for review.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Drafting failed:', error.message);
  process.exitCode = 1;
});
