/**
 * Media Search Service
 * Handles YouTube video search and Google Custom Search for images
 * Provides educational visual content for topic chat sessions
 */

const axios = require('axios');

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
async function searchYouTube(query, maxResults = 3) {
  // Read key at runtime from process.env
  const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

  if (!YOUTUBE_API_KEY) {
    console.warn('[media-search] YouTube API key not configured');
    return [];
  }

  const cacheKey = `youtube:${query}:${maxResults}`;

  return getCached(cacheKey, async () => {
    try {
      console.log(`[media-search] 📺 Searching YouTube for: "${query}"`);

      // Educational-friendly search parameters
      const params = {
        part: 'snippet',
        q: `${query} explained for students educational`,
        type: 'video',
        maxResults: Math.min(maxResults * 2, 10), // Fetch extra to filter, max 10
        key: YOUTUBE_API_KEY,
        videoEmbeddable: 'true',
        safeSearch: 'strict',
        relevanceLanguage: 'en',
      };

      const response = await axios.get(YOUTUBE_SEARCH_URL, {
        params,
        timeout: 10000,
      });

      const videos = response.data.items || [];

      if (videos.length === 0) {
        console.log('[media-search] No YouTube videos found');
        return [];
      }

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
          title: snippet.title || 'Untitled',
          description: (snippet.description || '').substring(0, 200),
          thumbnail: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || '',
          channel: snippet.channelTitle || 'Unknown',
          publishedAt: snippet.publishedAt,
          duration: details.contentDetails?.duration || '',
          viewCount: parseInt(details.statistics?.viewCount || '0'),
          url: `https://www.youtube.com/watch?v=${videoId}`,
          embedUrl: `https://www.youtube.com/embed/${videoId}`,
        };
      });

      console.log(`[media-search] ✅ YouTube search returned ${results.length} videos`);
      return results;
    } catch (error) {
      console.error('[media-search] ❌ YouTube search error:', error.message);
      if (error.response) {
        console.error('[media-search] Response status:', error.response.status);
        console.error('[media-search] Response data:', JSON.stringify(error.response.data).substring(0, 300));
      }
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
/**
 * Search Wikimedia Commons for educational images (no API key required fallback)
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum results to return
 * @returns {Array} Array of image objects
 */
async function searchWikimediaImages(query, maxResults = 3) {
  try {
    console.log(`[media-search] 🌐 Querying Wikimedia Commons search for: "${query}"`);
    
    const response = await axios.get('https://commons.wikimedia.org/w/api.php', {
      params: {
        action: 'query',
        generator: 'search',
        gsrsearch: query,
        gsrnamespace: 6, // File/media namespace
        prop: 'imageinfo',
        iiprop: 'url|size',
        iiurlwidth: 600, // Request generated thumbnail URL with 600px width
        format: 'json',
        origin: '*',
        gsrlimit: maxResults * 2, // Fetch extra results to allow filtering
      },
      timeout: 10000,
      headers: {
        'User-Agent': 'CloopEducationalApp/1.0 (contact@cloop.edu; contact via app)'
      }
    });

    const pages = response.data?.query?.pages || {};
    const results = [];
    
    for (const pageId in pages) {
      const page = pages[pageId];
      const imageinfo = page.imageinfo?.[0];
      if (!imageinfo || !imageinfo.url) continue;

      const url = imageinfo.url;
      const lowerUrl = url.toLowerCase();
      // Only include common raster image formats (exclude SVG — causes CORS/rendering issues, and audio/video/pdf)
      if (!lowerUrl.endsWith('.jpg') && !lowerUrl.endsWith('.jpeg') && !lowerUrl.endsWith('.png') && !lowerUrl.endsWith('.gif')) {
        continue;
      }

      results.push({
        id: `wiki-${pageId}`,
        title: page.title ? page.title.replace(/^File:/i, '') : 'Untitled',
        url: url,
        thumbnail: imageinfo.thumburl || url, // Use actual thumbnail URL or fall back to full image URL
        width: imageinfo.width,
        height: imageinfo.height,
        sourceUrl: imageinfo.descriptionurl || 'https://commons.wikimedia.org',
        source: 'Wikimedia Commons',
      });

      if (results.length >= maxResults) break;
    }

    console.log(`[media-search] ✅ Wikimedia search returned ${results.length} images`);
    return results;
  } catch (error) {
    console.error('[media-search] ❌ Wikimedia search error:', error.message);
    return [];
  }
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
      console.log(`[media-search] 🖼️ Searching Google Custom Search for: "${query}"`);

      const params = {
        q: `${query} diagram illustration`,
        cx: GOOGLE_CX_ID,
        key: GOOGLE_API_KEY,
        searchType: 'image',
        num: maxResults,
        safe: 'active',
      };

      console.log('[media-search] Request params:', JSON.stringify({ q: params.q, cx: params.cx?.substring(0, 10) + '...', num: params.num }));

      const response = await axios.get(GOOGLE_CUSTOM_SEARCH_URL, {
        params,
        timeout: 10000,
      });

      const items = response.data.items || [];

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

module.exports = {
  searchYouTube,
  searchImages,
  formatDuration,
  formatViewCount,
};
