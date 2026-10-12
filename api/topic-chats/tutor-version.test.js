const test = require('node:test');
const assert = require('node:assert/strict');
const { useTutorCoreV2 } = require('./tutor-version');

test('version selection defaults to core and recognizes explicit case-insensitive opt-outs', () => {
  for (const flag of [undefined, '', 'true', 'TRUE', '1', 'yes', 'on']) assert.equal(useTutorCoreV2({}, { ENABLE_TUTOR_CORE_V2: flag }), true);
  for (const flag of ['false', 'FALSE', '0', 'off', 'NO']) assert.equal(useTutorCoreV2({}, { ENABLE_TUTOR_CORE_V2: flag }), false);
  assert.equal(useTutorCoreV2({ headers: { 'x-tutor-version': 'V1' } }, {}), false);
  assert.equal(useTutorCoreV2({ query: { v: '1' } }, {}), false);
  assert.equal(useTutorCoreV2({ headers: { 'x-tutor-version': 'v2' } }, { ENABLE_TUTOR_CORE_V2: 'false' }), false);
});
