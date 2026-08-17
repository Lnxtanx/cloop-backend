/**
 * Verification Script for Web Search Audit Logging & Cited Link Tracker
 *
 * Usage:
 *   node scripts/test-tavily-logger.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env'), override: true });

const { generateChapters } = require('../services/ai/curriculum');
const { getRecentSearchLogs, LOG_FILE_PATH, RECENT_JSON_PATH } = require('../services/tavily-logger');
const fs = require('fs');

async function testWebSearchLogger() {
  console.log('================================================================');
  console.log('📜 TESTING WEB SEARCH QUERY & CITED LINK AUDIT LOGGER');
  console.log('================================================================\n');

  // 1. Run live chapter generation for Class 10 Science
  console.log('1️⃣ Triggering live search & curriculum generation for Class 10 CBSE Science...');
  const chapters = await generateChapters('10', 'CBSE', 'Science');
  console.log(`\n✅ Generated ${chapters.length} Chapters for Class 10 Science.`);

  // 2. Check if log files exist
  console.log('\n2️⃣ Verifying log files on disk...');
  const logFileExists = fs.existsSync(LOG_FILE_PATH);
  const jsonFileExists = fs.existsSync(RECENT_JSON_PATH);

  console.log(`   📄 JSON Lines Log File (${LOG_FILE_PATH}): ${logFileExists ? '✅ EXISTS' : '❌ MISSING'}`);
  console.log(`   📄 Recent Search JSON (${RECENT_JSON_PATH}): ${jsonFileExists ? '✅ EXISTS' : '❌ MISSING'}`);

  // 3. Inspect recent search audit logs
  console.log('\n3️⃣ Retrieving recent web search logs via getRecentSearchLogs()...');
  const recentLogs = getRecentSearchLogs(5);
  console.log(`\n📊 Total Recent Search Log Records Retrieved: ${recentLogs.length}`);

  if (recentLogs.length > 0) {
    const latest = recentLogs[0];
    console.log('\n--- LATEST SEARCH AUDIT LOG RECORD ---');
    console.log(`📅 Timestamp: ${latest.timestamp}`);
    console.log(`🔎 Search Query: "${latest.query}"`);
    console.log(`📚 Subject Context: Class ${latest.gradeLevel} ${latest.board} ${latest.subject}`);
    console.log(`⚡ Duration: ${latest.durationMs}ms`);
    console.log(`🔗 Cited URLs (${latest.citedUrls.length}):`);
    latest.sources.forEach((s, idx) => {
      console.log(`   ${idx + 1}. [${s.title}] (${s.domain})\n      URL: ${s.url}`);
    });
  }

  console.log('\n================================================================');
  console.log('✅ WEB SEARCH AUDIT LOGGER VERIFICATION COMPLETE');
  console.log('================================================================');
}

testWebSearchLogger();
