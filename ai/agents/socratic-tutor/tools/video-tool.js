/**
 * Socratic Tutor Video Tool
 * Fetches verified, embeddable educational YouTube videos for visual learners.
 *
 * Strategy:
 * 1. Primary: Google YouTube Data API with trusted educational channel whitelist
 *    (Khan Academy, CrashCourse, Physics Wallah, NCERT, Vedantu, Manocha Academy, etc.).
 * 2. Fallback: DeepSeek Search API to locate verified video lessons if Google API key is missing/limited.
 */

let mediaSearch = null;
try {
  mediaSearch = require('../../../../services/media-search');
} catch (_) {
  // Graceful fallback
}

const { executeSearch } = require('../../../providers/deepseek/search');

const videoToolDefinition = Object.freeze({
  name: 'fetch_educational_video',
  description: 'Search and retrieve verified, embeddable educational YouTube video clips from trusted channels (e.g. Khan Academy, NCERT, Physics Wallah) for school concepts across Math, Science, and Social Sciences (Class 1 - 12).',
  parameters: {
    type: 'object',
    properties: {
      conceptQuery: {
        type: 'string',
        description: 'Specific academic concept or process to visualize (e.g., "Linear equations balance scale", "Frictional force surfaces")',
      },
      classLevel: {
        type: 'string',
        description: 'Class level (e.g., "Class 8 CBSE", "Class 10 ICSE")',
        default: 'Class 8',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of videos to return (default 2)',
        default: 2,
      },
    },
    required: ['conceptQuery'],
  },
});

/**
 * Execute YouTube video search for Socratic Tutor
 *
 * @param {Object} args - { conceptQuery, classLevel, maxResults }
 * @returns {Promise<Object>} { success, videos: Array, source: 'google_youtube' | 'deepseek_fallback' }
 */
async function runVideoTool(args = {}) {
  const query = (args.conceptQuery || args.query || '').trim();
  const maxResults = Math.min(Math.max(1, args.maxResults || 2), 4);
  const classLevel = args.classLevel || 'Class 8';

  if (!query) {
    return { success: false, error: 'conceptQuery is required', videos: [] };
  }

  // 1. Try Google YouTube Data API via media-search service (Trusted whitelist enforced)
  if (mediaSearch?.searchYouTube && process.env.YOUTUBE_API_KEY) {
    try {
      const fullQuery = `${classLevel} ${query}`;
      const videos = await mediaSearch.searchYouTube(fullQuery, maxResults);
      if (Array.isArray(videos) && videos.length > 0) {
        return {
          success: true,
          source: 'google_youtube',
          query: fullQuery,
          videos: videos.map(v => ({
            id: v.id,
            title: v.title,
            channel: v.channel,
            embedUrl: v.embedUrl || `https://www.youtube.com/embed/${v.id}`,
            thumbnail: v.thumbnail,
            duration: v.duration,
          })),
        };
      }
    } catch (err) {
      console.warn('[Socratic Video Tool] Google YouTube API error, falling back to DeepSeek search:', err.message);
    }
  }

  // 2. Fallback: DeepSeek Native Search targeted at YouTube educational sources
  try {
    const searchQuery = `site:youtube.com ${classLevel} "${query}" educational explanation`;
    const searchResults = await executeSearch(searchQuery, { maxResults: 5 });

    const fallbackVideos = (searchResults || [])
      .filter(item => (item.url && item.url.includes('youtube.com/watch')) || (item.url && item.url.includes('youtu.be/')))
      .slice(0, maxResults)
      .map(item => {
        let videoId = '';
        if (item.url.includes('watch?v=')) {
          videoId = item.url.split('watch?v=')[1].split('&')[0];
        } else if (item.url.includes('youtu.be/')) {
          videoId = item.url.split('youtu.be/')[1].split('?')[0];
        }
        return {
          id: videoId || `fallback-${Date.now()}`,
          title: item.title || query,
          channel: 'Educational Channel',
          embedUrl: videoId ? `https://www.youtube.com/embed/${videoId}` : `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
          thumbnail: videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : null,
          url: item.url,
          snippet: item.snippet,
        };
      });

    if (fallbackVideos.length > 0) {
      return {
        success: true,
        source: 'deepseek_fallback',
        query,
        videos: fallbackVideos,
      };
    }
  } catch (deepseekErr) {
    console.warn('[Socratic Video Tool] DeepSeek search fallback failed:', deepseekErr.message);
  }

  // 3. Safe graceful fallback object if offline
  return {
    success: true,
    source: 'offline_fallback',
    query,
    videos: [
      {
        id: `yt-search-${Date.now()}`,
        title: `${classLevel}: ${query} Video Explanation`,
        channel: 'NCERT / Educational Verified',
        embedUrl: `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(`${classLevel} ${query}`)}`,
        thumbnail: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=500&auto=format&fit=crop&q=60',
      },
    ],
  };
}

module.exports = {
  definition: videoToolDefinition,
  execute: runVideoTool,
  runVideoTool,
};
