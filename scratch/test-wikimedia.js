const axios = require('axios');

async function searchWikimedia(query, maxResults = 2) {
  try {
    const url = 'https://commons.wikimedia.org/w/api.php';
    const response = await axios.get(url, {
      params: {
        action: 'query',
        generator: 'search',
        gsrsearch: query,
        gsrnamespace: 6, // File/media namespace
        prop: 'imageinfo',
        iiprop: 'url|size',
        iiurlwidth: 600,
        format: 'json',
        origin: '*',
        gsrlimit: maxResults * 2,
      },
      timeout: 10000,
      headers: {
        'User-Agent': 'CloopEducationalApp/1.0 (contact@cloop.edu; contact via app)'
      }
    });

    const pages = response.data?.query?.pages || {};
    const results = [];
    console.log("Pages returned by Wikimedia:", Object.keys(pages).length);
    
    for (const pageId in pages) {
      const page = pages[pageId];
      const imageinfo = page.imageinfo?.[0];
      if (!imageinfo || !imageinfo.url) {
        console.log(`Page ${pageId} has no imageinfo or url:`, page);
        continue;
      }

      const imageUrl = imageinfo.url;
      const lowerUrl = imageUrl.toLowerCase();
      console.log(`Checking page ${pageId}: ${page.title} - url: ${imageUrl}`);
      
      if (!lowerUrl.endsWith('.jpg') && !lowerUrl.endsWith('.jpeg') && !lowerUrl.endsWith('.png') && !lowerUrl.endsWith('.gif')) {
        console.log(`Skipped SVG or other non-raster: ${lowerUrl}`);
        continue;
      }

      results.push({
        id: `wiki-${pageId}`,
        title: page.title ? page.title.replace(/^File:/i, '') : 'Untitled',
        url: imageUrl,
        thumbnail: imageinfo.thumburl || imageUrl,
      });
    }

    console.log("Final results:", results);
  } catch (err) {
    console.error("Wikimedia search failed:", err.message);
  }
}

searchWikimedia('photosynthesis');
