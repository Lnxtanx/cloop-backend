/**
 * Web Search Logger & Audit Service
 * Persists all Tavily search queries, cited URLs, domains, snippets, and LLM grounding details
 * directly to the PostgreSQL `web_search_logs` Prisma database table as well as disk log files.
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../lib/prisma');

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
 * Log a Tavily web search event to both PostgreSQL (prisma.web_search_logs) and disk files
 */
async function logWebSearch(searchData = {}) {
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
    gradeLevel: searchData.gradeLevel ? String(searchData.gradeLevel) : null,
    board: searchData.board ? String(searchData.board) : null,
    subject: searchData.subject ? String(searchData.subject) : null,
    chapterTitle: searchData.chapterTitle ? String(searchData.chapterTitle) : null,
    userId: searchData.userId ? parseInt(searchData.userId, 10) || null : null,
    durationMs: searchData.durationMs || 0,
    resultCount: sources.length,
    answerSummary: searchData.answerSummary ? searchData.answerSummary.substring(0, 500) : null,
    citedSourcesCount: sources.length,
    citedUrls: sources.map(s => s.url).filter(Boolean),
    sources,
  };

  // 1. Insert record into PostgreSQL database via Prisma (prisma.web_search_logs)
  try {
    if (prisma && prisma.web_search_logs) {
      await prisma.web_search_logs.create({
        data: {
          user_id: logRecord.userId,
          feature_area: logRecord.featureArea,
          search_query: logRecord.query,
          grade_level: logRecord.gradeLevel,
          board: logRecord.board,
          subject: logRecord.subject,
          chapter_title: logRecord.chapterTitle,
          duration_ms: logRecord.durationMs,
          result_count: logRecord.resultCount,
          answer_summary: logRecord.answerSummary,
          cited_urls: logRecord.citedUrls,
          sources: logRecord.sources,
          status: 'success',
        },
      });
      console.log(`[tavily-logger] 🗄️ Saved web search audit record to database table (web_search_logs)`);
    }
  } catch (dbErr) {
    // Non-blocking fallback if local DB is unreachable during dev/tests
    console.warn('[tavily-logger] ⚠️ Note: DB insertion skipped/failed (will persist to log file):', dbErr.message);
  }

  // 2. Append JSON line to disk log file
  try {
    const jsonLine = JSON.stringify(logRecord) + '\n';
    fs.appendFileSync(LOG_FILE_PATH, jsonLine, 'utf8');
  } catch (err) {
    console.error('[tavily-logger] ❌ Failed to write to log file:', err.message);
  }

  // 3. Maintain rolling JSON file for easy inspection (last 50 searches)
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

  // 4. Print formatted log output to PM2 / terminal console
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
 * Retrieve recent web search logs (tries Prisma DB first, falls back to disk file)
 */
async function getRecentSearchLogs(limit = 20) {
  try {
    if (prisma && prisma.web_search_logs) {
      const records = await prisma.web_search_logs.findMany({
        take: limit,
        orderBy: { created_at: 'desc' },
      });
      if (records && records.length > 0) {
        return records;
      }
    }
  } catch (_) {
    // Fall back to reading from disk file below
  }

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
