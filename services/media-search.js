/**
 * Media Search Service
 * Handles YouTube video search and Google Custom Search for images
 * Provides educational visual content for topic chat sessions
 */

const axios = require('axios');
const { isTrustedChannel, isTrustedImageItem, ytStrict, imageStrict } = require('./media-whitelist');

// Base URLs
const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const YOUTUBE_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';
const GOOGLE_CUSTOM_SEARCH_URL = 'https://www.googleapis.com/customsearch/v1';

// In-memory cache to reduce API calls (5 minute TTL)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Log API key status on load
console.log('[media-search] Service loaded');
console.log('[media-search] YOUTUBE_API_KEY:', process.env.YOUTUBE_API_KEY ? 'SET (' + process.env.YOUTUBE_API_KEY.substring(0, 10) + '...)' : 'NOT SET');
console.log('[media-search] GOOGLE_API_KEY:', process.env.GOOGLE_API_KEY ? 'SET (' + process.env.GOOGLE_API_KEY.substring(0, 10) + '...)' : 'NOT SET');
console.log('[media-search] GOOGLE_CX_ID:', process.env.GOOGLE_CX_ID ? 'SET (' + process.env.GOOGLE_CX_ID + ')' : 'NOT SET');

/**
 * Get from cache or fetch fresh
 */
async function getCached(key, fetchFn) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const data = await fetchFn();
  cache.set(key, { data, timestamp: Date.now() });
  return data;
}

/**
 * Search YouTube for educational videos
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum results to return (default 3)
 * @returns {Array} Array of video objects
 */
async function searchYouTube(query, maxResults = 3, options = {}) {
  // Read key at runtime from process.env
  const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

  if (!YOUTUBE_API_KEY) {
    console.warn('[media-search] YouTube API key not configured. Generating educational search video fallback.');
    return [
      {
        id: `yt-fallback-${Date.now()}`,
        title: `${query} — Educational Concept Lesson`,
        description: `Watch video explanations for ${query}`,
        thumbnail: `https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=500&auto=format&fit=crop&q=60`,
        channel: 'Educational Explanation',
        publishedAt: new Date().toISOString(),
        duration: '5:00',
        viewCount: 50000,
        url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query + ' animation')}`,
        embedUrl: `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(query + ' animation')}`,
      }
    ];
  }

  const cacheKey = `youtube:${query}:${maxResults}:${options.videoDuration || 'medium'}`;

  return getCached(cacheKey, async () => {
    try {
      console.log(`[media-search] 📺 Searching YouTube for: "${query}"`);

      const lowerQuery = query.toLowerCase();
      let queryParam = query;
      if (!lowerQuery.includes('animation') && !lowerQuery.includes('explained') && !lowerQuery.includes('lesson')) {
        queryParam = `${query} animation`;
      }

      const params = {
        part: 'snippet',
        q: queryParam,
        type: 'video',
        maxResults: 15, // Fetch a pool so relevance & trusted-channel filters have candidates
        videoDuration: options.videoDuration || 'medium', // 4 to 20 mins: strictly eliminates 1-2h coaching marathons!
        key: YOUTUBE_API_KEY,
        videoEmbeddable: 'true',
        safeSearch: 'strict',
        relevanceLanguage: 'en',
      };

      const response = await axios.get(YOUTUBE_SEARCH_URL, {
        params,
        timeout: 10000,
      });

      const allVideos = response.data.items || [];

      if (allVideos.length === 0) {
        console.log('[media-search] No YouTube videos found');
        return [];
      }

      // Keyword relevance scoring: ensure the video title actually relates to the topic
      const stopWords = new Set(['class', 'ncert', 'cbse', 'science', 'animation', 'video', 'explained', 'chapter', 'lesson', 'part', 'complete']);
      const queryKeywords = query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !stopWords.has(w));

      const scoredVideos = allVideos.map(v => {
        const title = (v.snippet?.title || '').toLowerCase();
        const desc = (v.snippet?.description || '').toLowerCase();
        let matches = 0;
        for (const kw of queryKeywords) {
          if (title.includes(kw)) matches += 3;
          else if (desc.includes(kw)) matches += 1;
        }
        const isTrusted = isTrustedChannel(v.snippet?.channelTitle);
        return { video: v, score: matches + (isTrusted ? 5 : 0), isTrusted, matches };
      });

      // Prefer videos that have at least 1 keyword match
      const relevant = queryKeywords.length > 0
        ? scoredVideos.filter(item => item.matches > 0)
        : scoredVideos;

      const candidates = relevant.length > 0 ? relevant : scoredVideos;
      candidates.sort((a, b) => b.score - a.score);

      // Prioritize trusted channels among relevant results
      let selected = candidates.filter(item => item.isTrusted).map(item => item.video);
      if (selected.length < maxResults) {
        const others = candidates.filter(item => !item.isTrusted).map(item => item.video);
        selected.push(...others);
      }
      if (selected.length === 0) {
        selected = allVideos;
      }
      const videos = selected.slice(0, maxResults);

      // Get video IDs to fetch additional details (duration, view count)
      const videoIds = videos.map(v => v.id.videoId).join(',');

      const detailsResponse = await axios.get(YOUTUBE_VIDEOS_URL, {
        params: {
          part: 'contentDetails,statistics',
          id: videoIds,
          key: YOUTUBE_API_KEY,
        },
        timeout: 10000,
      });

      const detailsMap = {};
      (detailsResponse.data.items || []).forEach(item => {
        detailsMap[item.id] = item;
      });

      // Format results
      const results = videos.slice(0, maxResults).map(video => {
        const videoId = video.id.videoId;
        const details = detailsMap[videoId] || {};
        const snippet = video.snippet || {};

        return {
          id: videoId,
          title: snippet.title || 'Educational Lesson',
          description: (snippet.description || '').substring(0, 200),
          thumbnail: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || '',
          channel: snippet.channelTitle || 'Educational Lesson',
          publishedAt: snippet.publishedAt,
          duration: details.contentDetails?.duration || '',
          viewCount: parseInt(details.statistics?.viewCount || '0'),
          url: `https://www.youtube.com/watch?v=${videoId}`,
          embedUrl: `https://www.youtube.com/embed/${videoId}`,
        };
      });

      console.log(`[media-search] ✅ YouTube search returned ${results.length} relevant educational videos`);
      return results;
    } catch (error) {
      console.error('[media-search] ❌ YouTube search error:', error.message);
      return [];
    }
  });
}

/**
 * Search Google Custom Search for educational images
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum results to return (default 3)
 * @returns {Array} Array of image objects
 */
async function searchImages(query, maxResults = 3) {
  const cacheKey = `images:${query}:${maxResults}`;

  return getCached(cacheKey, async () => {
    // Read keys at runtime from process.env
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    const GOOGLE_CX_ID = process.env.GOOGLE_CX_ID;

    if (!GOOGLE_API_KEY || !GOOGLE_CX_ID) {
      console.warn('[media-search] Google Custom Search API not configured. Falling back to Wikimedia Commons.');
      return searchWikimediaImages(query, maxResults);
    }

    try {
      const baseQuery = /diagram|illustration|labeled|labelled/i.test(query) ? query : `${query} diagram`;
      const params = {
        q: baseQuery,
        cx: GOOGLE_CX_ID,
        key: GOOGLE_API_KEY,
        searchType: 'image',
        num: 10, // fetch a pool so the trusted-domain filter has candidates
        safe: 'active',
      };

      console.log('[media-search] Request params:', JSON.stringify({ q: params.q, cx: params.cx?.substring(0, 10) + '...', num: params.num }));

      const response = await axios.get(GOOGLE_CUSTOM_SEARCH_URL, {
        params,
        timeout: 10000,
      });

      const allItems = response.data.items || [];

      // ── Trusted-domain whitelist (see services/media-whitelist.js) ──
      // PREFER trusted sources; if none match, still show the best on-topic result
      // (the query is already grounded in the topic). Set IMAGE_WHITELIST_STRICT=true
      // to instead show only trusted domains (Wikimedia fallback when none match).
      let items = allItems.filter(isTrustedImageItem);
      if (items.length === 0) {
        if (imageStrict()) {
          console.log('[media-search] ⚠️ No image from a trusted domain — falling back to Wikimedia (strict).');
          return searchWikimediaImages(query, maxResults);
        }
        console.log('[media-search] No trusted-domain match — using the best on-topic result.');
        items = allItems;
      }
      items = items.slice(0, maxResults);

      const results = items.map((item, index) => ({
        id: `img-${Date.now()}-${index}`,
        title: item.title || 'Untitled',
        url: item.link || '',
        thumbnail: item.image?.thumbnailLink || item.link,
        width: item.image?.width,
        height: item.image?.height,
        sourceUrl: item.image?.contextLink || item.displayLink || '',
        source: item.displayLink || 'Unknown',
      }));

      console.log(`[media-search] ✅ Image search returned ${results.length} images`);
      return results;
    } catch (error) {
      console.error('[media-search] ❌ Google Custom Search error:', error.message);
      if (error.response) {
        console.error('[media-search] Response status:', error.response.status);
        console.error('[media-search] Response data:', JSON.stringify(error.response.data).substring(0, 500));
      }
      
      console.log('[media-search] ⚠️ Falling back to Wikimedia Commons image search due to Google Custom Search error');
      return searchWikimediaImages(query, maxResults);
    }
  });
}

/**
 * Parse ISO 8601 duration to human readable
 * @param {string} duration - ISO duration (PT5M30S)
 * @returns {string} Human readable (5:30)
 */
function formatDuration(duration) {
  if (!duration) return '';
  
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return '';

  const hours = match[1] ? parseInt(match[1]) : 0;
  const minutes = match[2] ? parseInt(match[2]) : 0;
  const seconds = match[3] ? parseInt(match[3]) : 0;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Format view count to human readable
 * @param {number} count - View count
 * @returns {string} Formatted count (1.2M views)
 */
function formatViewCount(count) {
  if (!count) return '0 views';
  
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M views`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K views`;
  }
  return `${count} views`;
}

/**
 * Get curated, educational YouTube video lessons for a revision sheet
 * @param {string} topicTitle - Name of the topic
 * @param {string|number} classLevel - Class/Grade level (e.g. 10)
 * @param {number} max - Maximum videos (default 2)
 * @returns {Promise<Array>} Array of video objects with clean fields
 */
async function getRevisionVideos(topicTitle, options = {}, max = 2) {
  try {
    const cleanTopic = String(topicTitle || '').trim();
    if (!cleanTopic) return [];

    let customQueries = [];
    let grade = '9';
    let chapterTitle = '';

    if (typeof options === 'string' || typeof options === 'number') {
      grade = String(options);
    } else if (typeof options === 'object' && options !== null) {
      grade = options.grade || '9';
      chapterTitle = options.chapterTitle || '';
      customQueries = Array.isArray(options.customQueries) ? options.customQueries : [];
    }

    const videos = [];

    // 1. Try AI-generated custom queries first (highest pedagogical relevance)
    for (const q of customQueries) {
      if (q && typeof q === 'string' && q.trim()) {
        const found = await searchYouTube(q.trim(), max, { videoDuration: 'medium' });
        if (Array.isArray(found) && found.length > 0) {
          videos.push(...found);
          if (videos.length >= max) break;
        }
      }
    }

    // 2. If needed, search with targeted curriculum query using real chapter and grade
    if (videos.length < max) {
      const needed = max - videos.length;
      const cleanGrade = grade.toLowerCase().includes('class') ? grade : `Class ${grade}`;
      const query = chapterTitle
        ? `${cleanTopic} ${chapterTitle} ${cleanGrade} animation`
        : `${cleanTopic} ${cleanGrade} Science concept animation`;
      const fallbackFound = await searchYouTube(query, needed, { videoDuration: 'medium' });
      if (Array.isArray(fallbackFound)) {
        videos.push(...fallbackFound);
      }
    }

    // Deduplicate by video ID
    const seen = new Set();
    const unique = [];
    for (const v of videos) {
      if (v && v.id && !seen.has(v.id)) {
        seen.add(v.id);
        unique.push(v);
      }
    }

    return unique.slice(0, max).map(v => {
      let durationStr = '';
      if (v.duration) {
        durationStr = /^\d+:\d+(:\d+)?$/.test(v.duration) ? v.duration : (formatDuration(v.duration) || v.duration);
      }
      return {
        id: v.id || `yt-${Date.now()}`,
        title: v.title || `${cleanTopic} — Video Lesson`,
        url: v.url || `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanTopic)}`,
        thumbnail: v.thumbnail || '',
        channel: v.channel || 'Educational Lesson',
        duration: durationStr
      };
    });
  } catch (err) {
    console.warn('[media-search] Failed to get revision videos:', err.message);
    return [];
  }
}

module.exports = {
  getRevisionVideos,
  searchYouTube,
  searchImages,
  formatDuration,
  formatViewCount,
};
