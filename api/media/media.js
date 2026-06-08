/**
 * Media Search API Endpoints
 * Routes for fetching YouTube videos and Google images
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const { searchYouTube, searchImages } = require('../../services/media-search');

/**
 * GET /api/media/youtube
 * Search YouTube videos for educational content
 * 
 * Query params:
 *   - q: Search query (required)
 *   - topic: Topic name for better context (optional)
 *   - maxResults: Max results to return (default 3)
 */
router.get('/youtube', authenticateToken, async (req, res) => {
  try {
    const { q, topic, maxResults } = req.query;
    
    if (!q && !topic) {
      return res.status(400).json({ 
        error: 'Search query (q) or topic name is required' 
      });
    }

    // Build search query - add educational context
    const searchQuery = topic 
      ? `${topic} ${q || ''} explained`
      : q;

    const max = parseInt(maxResults) || 3;
    
    console.log(`[media-api] YouTube search: "${searchQuery}" (max: ${max})`);
    
    const videos = await searchYouTube(searchQuery, max);
    
    return res.status(200).json({
      success: true,
      query: searchQuery,
      results: videos,
      total: videos.length,
    });
  } catch (err) {
    console.error('[media-api] YouTube search error:', err);
    return res.status(500).json({ 
      error: 'Failed to search YouTube',
      details: err.message 
    });
  }
});

/**
 * GET /api/media/images
 * Search Google Custom Search for educational images
 * 
 * Query params:
 *   - q: Search query (required)
 *   - topic: Topic name for better context (optional)
 *   - maxResults: Max results to return (default 3)
 */
router.get('/images', authenticateToken, async (req, res) => {
  try {
    const { q, topic, maxResults } = req.query;
    
    if (!q && !topic) {
      return res.status(400).json({ 
        error: 'Search query (q) or topic name is required' 
      });
    }

    // Build search query - add educational context
    const searchQuery = topic 
      ? `${topic} ${q || ''} diagram`
      : q;

    const max = parseInt(maxResults) || 3;
    
    console.log(`[media-api] Image search: "${searchQuery}" (max: ${max})`);
    
    const images = await searchImages(searchQuery, max);
    
    return res.status(200).json({
      success: true,
      query: searchQuery,
      results: images,
      total: images.length,
    });
  } catch (err) {
    console.error('[media-api] Image search error:', err);
    return res.status(500).json({ 
      error: 'Failed to search images',
      details: err.message 
    });
  }
});

/**
 * GET /api/media/search
 * Combined endpoint - search both YouTube and images
 * 
 * Query params:
 *   - q: Search query (required)
 *   - topic: Topic name (optional)
 *   - type: 'youtube' | 'images' | 'both' (default: 'both')
 */
router.get('/search', authenticateToken, async (req, res) => {
  try {
    const { q, topic, type = 'both' } = req.query;
    
    if (!q && !topic) {
      return res.status(400).json({ 
        error: 'Search query (q) or topic name is required' 
      });
    }

    const searchQuery = q || topic;
    const results = {};

    // Run searches in parallel
    const searchPromises = [];
    
    if (type === 'youtube' || type === 'both') {
      searchPromises.push(
        searchYouTube(`${searchQuery} educational explained`, 2)
          .then(videos => { results.videos = videos; })
          .catch(err => { 
            console.error('[media-api] YouTube error:', err);
            results.videos = []; 
          })
      );
    }
    
    if (type === 'images' || type === 'both') {
      searchPromises.push(
        searchImages(`${searchQuery} diagram illustration`, 2)
          .then(images => { results.images = images; })
          .catch(err => { 
            console.error('[media-api] Images error:', err);
            results.images = []; 
          })
      );
    }

    await Promise.all(searchPromises);

    return res.status(200).json({
      success: true,
      query: searchQuery,
      ...results,
    });
  } catch (err) {
    console.error('[media-api] Combined search error:', err);
    return res.status(500).json({ 
      error: 'Failed to search media',
      details: err.message 
    });
  }
});

module.exports = router;
