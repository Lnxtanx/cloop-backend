#!/usr/bin/env node
/**
 * Load curated knowledge statements onto learning goals.
 *
 *   node scripts/import-knowledge-statements.js data/knowledge-statements/scientific-inquiry.json
 *   node scripts/import-knowledge-statements.js <file> --apply
 *   node scripts/import-knowledge-statements.js <file> --apply --force   # only after reviewing a verified overwrite
 *
 * Without --apply nothing is written: the plan is printed so a person can check
 * every goal it matched. Any problem stops the whole import.
 * Requires prisma/sql/20261021_add_goal_knowledge_statement.sql to have run.
 */

const fs = require('fs');
const { planImport, applyImport } = require('../services/curriculum/knowledge-statements');

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(arg => !arg.startsWith('--'));
  const apply = args.includes('--apply');
  const force = args.includes('--force');
  if (!file) {
    console.error('Usage: node scripts/import-knowledge-statements.js <statements.json> [--apply] [--force]');
    process.exitCode = 2;
    return;
  }

  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const prisma = require('../lib/prisma');
  try {
    const plan = await planImport(prisma, spec, { force });
    console.log(`\nSource: ${plan.source || '(missing)'}`);
    console.log(`Marked verified: ${plan.verified ? 'yes' : 'no (pending teacher review)'}\n`);
    for (const change of plan.changes) {
      const status = change.unchanged ? 'unchanged' : change.before ? 'REPLACE' : 'ADD';
      console.log(`[${status}] topic ${change.topic_id} (subject ${change.subject_id}) "${change.topic_title}"`);
      console.log(`         goal ${change.goal_id} "${change.goal_title}"`);
      if (change.before && !change.unchanged) console.log(`         was: ${change.before}`);
      console.log(`         now: ${change.after}`);
    }
    if (plan.errors.length) {
      console.error(`\n${plan.errors.length} problem(s). Nothing was written:`);
      for (const error of plan.errors) console.error(`  - ${error}`);
      process.exitCode = 1;
      return;
    }
    const pending = plan.changes.filter(change => !change.unchanged).length;
    if (!apply) {
      console.log(`\nDry run: ${pending} goal(s) would change. Nothing was written. Re-run with --apply to write.`);
      return;
    }
    const written = await applyImport(prisma, plan);
    console.log(`\nWrote ${written} goal(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Import failed:', error.message);
  process.exitCode = 1;
});
