/**
 * Standalone Test Script for Tavily Web Search & Live 2026 Curriculum Generation
 *
 * Usage:
 *   node scripts/test-tavily-curriculum.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env'), override: true });

const { searchCurriculumSyllabus, searchChapterTopics } = require('../services/tavily-search');
const { generateChapters, generateTopics } = require('../services/ai/curriculum');

async function testTavilyCurriculumGen() {
  console.log('===========================================================');
  console.log('🌐 TESTING TAVILY WEB SEARCH & LIVE 2026 CURRICULUM PIPELINE');
  console.log('===========================================================\n');

  const gradeLevel = '10';
  const board = 'CBSE';
  const subject = 'Science';

  // 1. Test Tavily API Direct Search
  console.log(`1️⃣ Testing Tavily Search API for ${board} Class ${gradeLevel} ${subject}...`);
  const syllabusSearch = await searchCurriculumSyllabus({ gradeLevel, board, subject });

  if (syllabusSearch) {
    console.log('\n--- TAVILY SYLLABUS SEARCH SAMPLE (First 400 chars) ---');
    console.log(syllabusSearch.substring(0, 400) + '...\n');
  } else {
    console.log('⚠️ Tavily search returned no results or failed.\n');
  }

  // 2. Test Live Chapter Generation
  console.log(`2️⃣ Generating Live 2026 Chapters for Class ${gradeLevel} ${board} ${subject}...`);
  try {
    const chapters = await generateChapters(gradeLevel, board, subject);
    console.log(`\n✅ Generated ${chapters.length} Chapters for ${subject}:`);
    chapters.forEach((chap, idx) => {
      console.log(`   ${idx + 1}. ${chap.title} - ${chap.content.substring(0, 80)}...`);
    });

    if (chapters.length > 0) {
      const sampleChap = chapters[0];
      console.log(`\n3️⃣ Generating Live 2026 Topics for Chapter: "${sampleChap.title}"...`);
      const topics = await generateTopics(gradeLevel, board, subject, sampleChap.title, sampleChap.content);
      console.log(`\n✅ Generated ${topics.length} Topics for Chapter "${sampleChap.title}":`);
      topics.forEach((top, idx) => {
        console.log(`   ${idx + 1}. ${top.title} - ${top.content.substring(0, 80)}...`);
      });
    }
  } catch (err) {
    console.error('❌ Error during curriculum generation test:', err);
  }

  console.log('\n===========================================================');
  console.log('✅ TEST COMPLETE');
  console.log('===========================================================');
}

testTavilyCurriculumGen();
