/**
 * Web Search Logger & Audit Service
 * Persists all Tavily search queries, cited URLs, domains, snippets, and LLM grounding details to disk.
 */

const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '../logs');
const LOG_FILE_PATH = path.join(LOGS_DIR, 'tavily-search-history.log');
const RECENT_JSON_PATH = path.join(LOGS_DIR, 'tavily-search-history.json');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  } catch (err) {
    console.error('[tavily-logger] Could not create logs directory:', err.message);
  }
}

/**
 * Log a Tavily web search event with all cited links, snippets, and metadata
 */
function logWebSearch(searchData = {}) {
  const timestamp = new Date().toISOString();
  
  const sources = (searchData.results || []).map((r, i) => {
    let domain = '';
    try {
      if (r.url) domain = new URL(r.url).hostname.replace(/^www\./, '');
    } catch (_) {
      domain = 'unknown';
    }

    return {
      index: i + 1,
      title: r.title || 'Untitled',
      url: r.url || '',
      domain,
      snippet: r.content ? r.content.substring(0, 300) : '',
    };
  });

  const logRecord = {
    timestamp,
    query: searchData.query || '',
    featureArea: searchData.featureArea || 'curriculum_generation',
    gradeLevel: searchData.gradeLevel || null,
    board: searchData.board || null,
    subject: searchData.subject || null,
    chapterTitle: searchData.chapterTitle || null,
    userId: searchData.userId || null,
    durationMs: searchData.durationMs || 0,
    resultCount: sources.length,
    answerSummary: searchData.answerSummary ? searchData.answerSummary.substring(0, 400) : null,
    citedSourcesCount: sources.length,
    citedUrls: sources.map(s => s.url).filter(Boolean),
    sources,
  };

  // 1. Append JSON line to log file
  try {
    const jsonLine = JSON.stringify(logRecord) + '\n';
    fs.appendFileSync(LOG_FILE_PATH, jsonLine, 'utf8');
  } catch (err) {
    console.error('[tavily-logger] ❌ Failed to write to log file:', err.message);
  }

  // 2. Maintain rolling JSON file for easy inspection (last 50 searches)
  try {
    let history = [];
    if (fs.existsSync(RECENT_JSON_PATH)) {
      try {
        const content = fs.readFileSync(RECENT_JSON_PATH, 'utf8');
        history = JSON.parse(content);
        if (!Array.isArray(history)) history = [];
      } catch (_) {
        history = [];
      }
    }
    history.unshift(logRecord);
    if (history.length > 50) history = history.slice(0, 50);
    fs.writeFileSync(RECENT_JSON_PATH, JSON.stringify(history, null, 2), 'utf8');
  } catch (err) {
    console.error('[tavily-logger] Failed to update recent JSON file:', err.message);
  }

  // 3. Print formatted log output to PM2 / terminal console
  console.log(`\n===============================================================`);
  console.log(`[tavily-logger] 📜 WEB SEARCH AUDIT LOG | ${timestamp}`);
  console.log(`[tavily-logger] 🔎 Query: "${logRecord.query}"`);
  console.log(`[tavily-logger] 📚 Subject Context: Class ${logRecord.gradeLevel || '?'} ${logRecord.board || ''} ${logRecord.subject || ''}`);
  if (logRecord.chapterTitle) console.log(`[tavily-logger] 📖 Chapter: "${logRecord.chapterTitle}"`);
  console.log(`[tavily-logger] ⚡ Duration: ${logRecord.durationMs}ms | Results: ${logRecord.resultCount}`);
  
  if (sources.length > 0) {
    console.log(`[tavily-logger] 🔗 CITED WEB LINKS QUOTED FOR CURRICULUM:`);
    sources.forEach(s => {
      console.log(`   [${s.index}] ${s.title}`);
      console.log(`       URL: ${s.url}`);
    });
  }
  console.log(`===============================================================\n`);

  return logRecord;
}

/**
 * Retrieve recent web search logs from file
 */
function getRecentSearchLogs(limit = 20) {
  if (!fs.existsSync(LOG_FILE_PATH)) return [];

  try {
    const lines = fs.readFileSync(LOG_FILE_PATH, 'utf8').trim().split('\n').filter(Boolean);
    const records = lines.slice(-limit).map(line => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    }).filter(Boolean);

    return records.reverse();
  } catch (err) {
    console.error('[tavily-logger] Failed to read search log file:', err.message);
    return [];
  }
}

module.exports = {
  logWebSearch,
  getRecentSearchLogs,
  LOG_FILE_PATH,
  RECENT_JSON_PATH,
};
