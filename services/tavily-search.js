/**
 * Tavily Web Search Service
 * Provides live web search access to fetch the latest 2026 NCERT, CBSE, ICSE,
 * and Indian State Board curricula for curriculum generation.
 */

const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env'), override: true });

const TAVILY_API_URL = 'https://api.tavily.com/search';
const DEFAULT_API_KEY = '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';

function getApiKey() {
  return (process.env.TAVILY_API_KEY || DEFAULT_API_KEY).trim();
}

/**
 * Execute a Tavily web search query
 * @param {string} query - Search query
 * @param {Object} options - Search options (maxResults, searchDepth)
 * @returns {Promise<Object|null>} - Tavily API response
 */
async function executeTavilySearch(query, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn('[tavily-search] ⚠️ TAVILY_API_KEY is not configured.');
    return null;
  }

  const payload = {
    api_key: apiKey,
    query: query.trim(),
    search_depth: options.searchDepth || 'advanced',
    max_results: options.maxResults || 5,
    include_answer: true,
    include_raw_content: false,
  };

  try {
    console.log(`[tavily-search] 🌐 Querying Tavily Web Search for: "${query}"`);
    const startTime = Date.now();

    const response = await axios.post(TAVILY_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 12000,
    });

    const duration = Date.now() - startTime;
    const data = response.data;
    const resultCount = data.results?.length || 0;

    console.log(`[tavily-search] ✅ Tavily search complete (${duration}ms) | Results: ${resultCount}`);
    return data;
  } catch (error) {
    console.error('[tavily-search] ❌ Tavily API search failed:', error.message);
    return null;
  }
}

/**
 * Search live 2026 official curriculum table of contents for a Grade, Board, and Subject
 */
async function searchCurriculumSyllabus({ gradeLevel, board, subject }) {
  const query = `NCERT Class ${gradeLevel} ${subject} official 2026 syllabus chapter list table of contents ${board || 'CBSE'}`;
  const data = await executeTavilySearch(query, { maxResults: 5, searchDepth: 'advanced' });

  if (!data || (!data.answer && (!data.results || data.results.length === 0))) {
    return null;
  }

  let formattedText = '';
  if (data.answer) {
    formattedText += `OFFICIAL CURRICULUM SUMMARY:\n${data.answer.trim()}\n\n`;
  }

  if (data.results && data.results.length > 0) {
    formattedText += `OFFICIAL WEB SEARCH SNIPPETS (2026 CURRICULUM):\n`;
    data.results.forEach((res, idx) => {
      formattedText += `${idx + 1}. [${res.title}] (${res.url})\n   ${res.content}\n`;
    });
  }

  return formattedText.trim();
}

/**
 * Search live 2026 official topic list for a specific Chapter
 */
async function searchChapterTopics({ gradeLevel, board, subject, chapterTitle }) {
  const cleanChap = String(chapterTitle || '').replace(/^Chapter\s*\d+\s*[:\-.]*/i, '').trim();
  const query = `NCERT Class ${gradeLevel} ${subject} Chapter ${cleanChap} official topics subtopics list 2026 ${board || 'CBSE'}`;

  const data = await executeTavilySearch(query, { maxResults: 4, searchDepth: 'basic' });

  if (!data || (!data.answer && (!data.results || data.results.length === 0))) {
    return null;
  }

  let formattedText = '';
  if (data.answer) {
    formattedText += `CHAPTER TOPICS SUMMARY:\n${data.answer.trim()}\n\n`;
  }

  if (data.results && data.results.length > 0) {
    formattedText += `CHAPTER WEB SEARCH SNIPPETS:\n`;
    data.results.forEach((res, idx) => {
      formattedText += `${idx + 1}. [${res.title}]\n   ${res.content}\n`;
    });
  }

  return formattedText.trim();
}

module.exports = {
  executeTavilySearch,
  searchCurriculumSyllabus,
  searchChapterTopics,
};
