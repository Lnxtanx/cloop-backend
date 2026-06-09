/**
 * Test script to verify API keys for YouTube and Google Custom Search
 */

require('dotenv').config();
const axios = require('axios');

async function testAPIs() {
  console.log('\n========================================');
  console.log('🔑 API KEY VALIDATION TEST');
  console.log('========================================\n');

  // Check environment variables
  console.log('📋 Environment Variables:');
  console.log(`  YOUTUBE_API_KEY: ${process.env.YOUTUBE_API_KEY ? '✅ SET' : '❌ MISSING'}`);
  console.log(`  GOOGLE_API_KEY: ${process.env.GOOGLE_API_KEY ? '✅ SET' : '❌ MISSING'}`);
  console.log(`  GOOGLE_CX_ID: ${process.env.GOOGLE_CX_ID ? '✅ SET' : '❌ MISSING'}`);
  console.log('');

  // Test 1: YouTube Data API v3
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📺 TEST 1: YouTube Data API v3');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!process.env.YOUTUBE_API_KEY) {
    console.log('❌ SKIPPED: YOUTUBE_API_KEY not set\n');
  } else {
    try {
      const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
        params: {
          part: 'snippet',
          q: 'photosynthesis explained',
          type: 'video',
          maxResults: 2,
          key: process.env.YOUTUBE_API_KEY
        },
        timeout: 10000
      });

      if (response.data.items && response.data.items.length > 0) {
        console.log('✅ SUCCESS: YouTube API is working!');
        console.log(`   Found ${response.data.items.length} videos:`);
        response.data.items.slice(0, 2).forEach((item, i) => {
          console.log(`   ${i + 1}. ${item.snippet.title.substring(0, 50)}...`);
        });
      } else {
        console.log('⚠️ PARTIAL: API responded but no results');
      }
    } catch (error) {
      console.log('❌ FAILED:');
      if (error.response) {
        console.log(`   Status: ${error.response.status}`);
        console.log(`   Error: ${error.response.data?.error?.message || JSON.stringify(error.response.data)}`);
      } else {
        console.log(`   Error: ${error.message}`);
      }
    }
    console.log('');
  }

  // Test 2: Google Custom Search API (Images)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🖼️ TEST 2: Google Custom Search API (Images)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!process.env.GOOGLE_API_KEY || !process.env.GOOGLE_CX_ID) {
    console.log('❌ SKIPPED: GOOGLE_API_KEY or GOOGLE_CX_ID not set\n');
  } else {
    try {
      const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
        params: {
          q: 'photosynthesis diagram',
          cx: process.env.GOOGLE_CX_ID,
          key: process.env.GOOGLE_API_KEY,
          searchType: 'image',
          num: 2
        },
        timeout: 10000
      });

      if (response.data.items && response.data.items.length > 0) {
        console.log('✅ SUCCESS: Google Custom Search API is working!');
        console.log(`   Found ${response.data.items.length} images:`);
        response.data.items.slice(0, 2).forEach((item, i) => {
          console.log(`   ${i + 1}. ${item.title.substring(0, 50)}...`);
          console.log(`      URL: ${item.link}`);
        });
      } else {
        console.log('⚠️ PARTIAL: API responded but no results');
      }
    } catch (error) {
      console.log('❌ FAILED:');
      if (error.response) {
        console.log(`   Status: ${error.response.status}`);
        console.log(`   Error: ${error.response.data?.error?.message || JSON.stringify(error.response.data)}`);
      } else {
        console.log(`   Error: ${error.message}`);
      }
    }
    console.log('');
  }

  // Test 3: Media Search Service
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔧 TEST 3: Media Search Service Module');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  try {
    const { searchYouTube, searchImages } = require('./services/media-search');

    // Test YouTube search via service
    console.log('\n📚 Testing searchYouTube()...');
    const videos = await searchYouTube('friction explained for students', 2);
    if (videos && videos.length > 0) {
      console.log(`✅ searchYouTube returned ${videos.length} videos`);
      videos.forEach((v, i) => {
        console.log(`   ${i + 1}. ${v.title}`);
        console.log(`      URL: ${v.url}`);
      });
    } else {
      console.log('⚠️ searchYouTube returned empty array (API key may be missing or quota exceeded)');
    }

    // Test Image search via service
    console.log('\n🖼️ Testing searchImages()...');
    const images = await searchImages('friction diagram', 2);
    if (images && images.length > 0) {
      console.log(`✅ searchImages returned ${images.length} images`);
      images.forEach((img, i) => {
        console.log(`   ${i + 1}. ${img.title}`);
        console.log(`      URL: ${img.url}`);
      });
    } else {
      console.log('⚠️ searchImages returned empty array (API key may be missing or quota exceeded)');
    }

  } catch (error) {
    console.log('❌ ERROR:', error.message);
  }

  console.log('\n========================================');
  console.log('🏁 TEST COMPLETE');
  console.log('========================================\n');
}

testAPIs().catch(console.error);
