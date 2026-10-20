#!/usr/bin/env node
// Focused offline release gate. Every suite runs in a separate Node process so
// provider/database stubs cannot leak into another suite or hide the agent route.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = [
  ...fs.readdirSync(path.join(root, 'services/tutor-core')).filter(name => name.endsWith('.test.js')).sort().map(name => `services/tutor-core/${name}`),
  'ai/agents/socratic-tutor/context/context-builder.test.js',
  'api/topic-chats/topic-chats-v2.test.js',
];
let total = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--test-reporter=tap', file], {
    cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const count = Number(output.match(/^# tests (\d+)$/m)?.[1]);
  const failed = Number(output.match(/^# fail (\d+)$/m)?.[1]);
  if (result.error || result.status !== 0 || !count || failed !== 0) {
    process.stderr.write(output);
    if (result.error) process.stderr.write(`${result.error.message}\n`);
    process.exit(1);
  }
  total += count;
  console.log(`${file}: ${count} passed`);
}
console.log(`${total} tests passed across ${files.length} isolated suites. No live model or database calls.`);
