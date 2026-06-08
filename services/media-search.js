/**
 * Media Search Service
 * Handles YouTube video search and Google Custom Search for images
 * Provides educational visual content for topic chat sessions
 */

const axios = require('axios');

// API Keys from environment
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CX_ID = process.env.GOOGLE_CX_ID;

// Base URLs
const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const YOUTUBE_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';
const GOOGLE_CUSTOM_SEARCH_URL = 'https://www.googleapis.com/customsearch/v1';

// In-memory cache to reduce API calls (5 minute TTL)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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
  if (!YOUTUBE_API_KEY) {
    console.warn('[media-search] YouTube API key not configured');
    return [];
  }

  const cacheKey = `youtube:${query}:${maxResults}`;
  
  return getCached(cacheKey, async () => {
    try {
      // Educational-friendly search parameters
      const params = {
        part: 'snippet',
        q: `${query} explained for students educational`,
        type: 'video',
        maxResults: maxResults * 2, // Fetch extra to filter
        key: YOUTUBE_API_KEY,
        videoEmbeddable: 'true',
        videoDuration: 'medium', // 4-20 minutes
        safeSearch: 'strict',
        relevanceLanguage: 'en',
      };

      const response = await axios.get(YOUTUBE_SEARCH_URL, {
        params,
        timeout: 5000,
      });

      const videos = response.data.items || [];
      
      if (videos.length === 0) {
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
        timeout: 5000,
      });

      const detailsMap = {};
      (detailsResponse.data.items || []).forEach(item => {
        detailsMap[item.id] = item;
      });

      // Format results
      return videos.slice(0, maxResults).map(video => {
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
    } catch (error) {
      console.error('[media-search] YouTube search error:', error.message);
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
  if (!GOOGLE_API_KEY || !GOOGLE_CX_ID) {
    console.warn('[media-search] Google Custom Search API not configured');
    return [];
  }

  const cacheKey = `images:${query}:${maxResults}`;
  
  return getCached(cacheKey, async () => {
    try {
      const params = {
        q: `${query} diagram illustration educational`,
        cx: GOOGLE_CX_ID,
        key: GOOGLE_API_KEY,
        searchType: 'image',
        num: maxResults,
        safe: 'active',
        imgSize: 'large',
        imgType: 'clipart|photo|illustration',
      };

      const response = await axios.get(GOOGLE_CUSTOM_SEARCH_URL, {
        params,
        timeout: 5000,
      });

      const items = response.data.items || [];

      return items.map((item, index) => ({
        id: `img-${Date.now()}-${index}`,
        title: item.title || 'Untitled',
        url: item.link || '',
        thumbnail: item.image?.thumbnailLink || item.link,
        width: item.image?.width,
        height: item.image?.height,
        sourceUrl: item.image?.contextLink || item.displayLink || '',
        source: item.displayLink || 'Unknown',
      }));
    } catch (error) {
      console.error('[media-search] Google Custom Search error:', error.message);
      return [];
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
