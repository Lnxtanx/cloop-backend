/**
 * DeepSeek Native Search & Fetch Provider
 * Official web search tool powered by api.deepseek.com/v1/tools/search
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env'), override: true });

const { ENDPOINTS, TIMEOUTS } = require('./constants');

/**
 * Execute a live web search using DeepSeek Search API
 *
 * @param {string} query - The search query
 * @param {Object} options - Search options:
 *   - count: number (default: 10, max: 50)
 *   - needContent: boolean (fetch full page content into result)
 *   - oriQuestion: string (context of user's query)
 *   - domains: string[] (domains to restrict, e.g. ['ncert.nic.in', 'cbse.gov.in'])
 *   - timeoutMs: number (default: 15000)
 * @returns {Promise<{ results: Array, query: string, durationMs: number }>}
 */
async function executeSearch(query, options = {}) {
  const apiKey = (process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || '').trim();
  if (!apiKey) {
    throw new Error('[DeepSeek Search] DEEPSEEK_API_KEY is missing in environment variables');
  }

  let finalQuery = String(query || '').trim();
  if (Array.isArray(options.domains) && options.domains.length > 0) {
    const domainFilters = options.domains.map(d => `site:${d.trim()}`).join(' OR ');
    finalQuery = `(${domainFilters}) ${finalQuery}`;
  }

  const payload = {
    query: finalQuery,
    count: Math.min(50, Math.max(1, options.count || 10)),
  };

  if (options.needContent) payload.need_content = true;
  if (options.oriQuestion) payload.ori_question = String(options.oriQuestion);

  const timeoutMs = options.timeoutMs || TIMEOUTS.SEARCH_MS;
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('[DeepSeek Search] Request timed out')), timeoutMs);

  try {
    const response = await fetch(ENDPOINTS.SEARCH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`DeepSeek Search HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const durationMs = Date.now() - startTime;
    const rawResults = Array.isArray(data.results) ? data.results : [];

    const normalizedResults = rawResults.map(item => ({
      title: item.title || '',
      url: item.url || '',
      summary: item.summary || item.snippet || item.content || '',
      siteName: item.site_name || '',
      rerankScore: item.rerank_score || 0,
      authority: item.authority || 0,
      date: item.date || null,
    }));

    return {
      results: normalizedResults,
      query: finalQuery,
      durationMs,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    console.warn('[DeepSeek Search] Search failed:', error.message);
    return {
      results: [],
      query: finalQuery,
      durationMs: Date.now() - startTime,
      error: error.message,
    };
  }
}

/**
 * Fetch and convert a single web page to clean Markdown using DeepSeek Fetch API
 *
 * @param {string} url - Target URL
 * @param {Object} options - Fetch options
 * @returns {Promise<{ url: string, content: string, durationMs: number }>}
 */
async function fetchWebPage(url, options = {}) {
  const apiKey = (process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || '').trim();
  if (!apiKey) {
    throw new Error('[DeepSeek Fetch] DEEPSEEK_API_KEY is missing');
  }

  const timeoutMs = options.timeoutMs || TIMEOUTS.FETCH_MS;
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('[DeepSeek Fetch] Request timed out')), timeoutMs);

  try {
    const response = await fetch(ENDPOINTS.FETCH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`DeepSeek Fetch HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();
    return {
      url,
      content: data.content || data.markdown || '',
      title: data.title || '',
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    console.warn(`[DeepSeek Fetch] Fetch failed for ${url}:`, error.message);
    return {
      url,
      content: '',
      title: '',
      durationMs: Date.now() - startTime,
      error: error.message,
    };
  }
}

/**
 * Specialized syllabus search helper (drops-in for curriculum pipelines)
 *
 * @param {Object} params
 * @param {string} params.board - 'CBSE', 'ICSE'
 * @param {string|number} params.gradeLevel - e.g. 10
 * @param {string} params.subject - e.g. 'Science'
 * @param {string} [params.chapter] - e.g. 'Light Reflection and Refraction'
 */
async function searchCurriculumSyllabus({ board = 'CBSE', gradeLevel = '10', subject = '', chapter = '' }) {
  const baseQuery = `${board} Class ${gradeLevel} ${subject} ${chapter} rationalized syllabus 2026-27 learning outcomes`;
  const domains = board === 'CBSE'
    ? ['cbse.gov.in', 'cbseacademic.nic.in', 'ncert.nic.in']
    : ['cisce.org'];

  return executeSearch(baseQuery, {
    count: 8,
    domains,
    oriQuestion: `Official syllabus curriculum for ${board} Class ${gradeLevel} ${subject}`,
  });
}

module.exports = {
  executeSearch,
  fetchWebPage,
  searchCurriculumSyllabus,
};
