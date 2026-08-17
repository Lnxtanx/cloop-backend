/**
 * Standalone Test Script for Strict 2026-27 Rationalized Syllabus & Domain-Filtered Tavily Search
 *
 * Usage:
 *   node scripts/test-reconcile-curriculum.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env'), override: true });

const { generateChapters, cleanAndValidateRationalizedChapters } = require('../services/ai/curriculum');
const { searchCurriculumSyllabus } = require('../services/tavily-search');

async function verifyRationalizedSyllabus() {
  console.log('================================================================');
  console.log('🛡️ TESTING STRICT 2026-27 RATIONALIZED NCERT SYLLABUS PIPELINE');
  console.log('================================================================\n');

  // Test 1: Class 10 Mathematics (Should be EXACTLY 14 chapters, NO Constructions)
  console.log('1️⃣ Testing Class 10 CBSE Mathematics Rationalized Syllabus...');
  const mathSearch = await searchCurriculumSyllabus({ gradeLevel: '10', board: 'CBSE', subject: 'Mathematics' });
  console.log('🌐 Web Search Context snippet:\n', (mathSearch || '').substring(0, 300) + '...\n');

  const mathChapters = await generateChapters('10', 'CBSE', 'Mathematics');
  console.log(`\n📊 Class 10 Math Chapter Count: ${mathChapters.length} (Expected: 14)`);

  const hasConstructions = mathChapters.some(c => /construction/i.test(c.title));
  if (hasConstructions) {
    console.error('❌ FAIL: Chapter "Constructions" was detected in Class 10 Math!');
  } else {
    console.log('✅ PASS: Chapter "Constructions" is correctly EXCLUDED from Class 10 Math.');
  }

  console.log('\nChapters Generated for Class 10 Math:');
  mathChapters.forEach((c, idx) => console.log(`   ${idx + 1}. ${c.title}`));


  // Test 2: Class 10 Science (Should be EXACTLY 13 chapters, NO Sources of Energy, HAS Our Environment)
  console.log('\n\n2️⃣ Testing Class 10 CBSE Science Rationalized Syllabus...');
  const sciChapters = await generateChapters('10', 'CBSE', 'Science');
  console.log(`\n📊 Class 10 Science Chapter Count: ${sciChapters.length} (Expected: 13)`);

  const hasSourcesOfEnergy = sciChapters.some(c => /sources\s+of\s+energy/i.test(c.title));
  const hasPeriodicClass = sciChapters.some(c => /periodic\s+classification/i.test(c.title));
  const hasOurEnvironment = sciChapters.some(c => /our\s+environment/i.test(c.title));

  if (hasSourcesOfEnergy) {
    console.error('❌ FAIL: "Sources of Energy" was detected in Class 10 Science!');
  } else {
    console.log('✅ PASS: "Sources of Energy" is correctly EXCLUDED from Class 10 Science.');
  }

  if (hasPeriodicClass) {
    console.error('❌ FAIL: "Periodic Classification" was detected in Class 10 Science!');
  } else {
    console.log('✅ PASS: "Periodic Classification" is correctly EXCLUDED from Class 10 Science.');
  }

  if (hasOurEnvironment) {
    console.log('✅ PASS: "Our Environment" is correctly INCLUDED in Class 10 Science.');
  } else {
    console.warn('⚠️ WARNING: "Our Environment" was not found in chapter list.');
  }

  console.log('\nChapters Generated for Class 10 Science:');
  sciChapters.forEach((c, idx) => console.log(`   ${idx + 1}. ${c.title}`));

  console.log('\n================================================================');
  console.log('✅ RATIONALIZATION & DOMAIN FILTERING VERIFICATION COMPLETE');
  console.log('================================================================');
}

verifyRationalizedSyllabus();
