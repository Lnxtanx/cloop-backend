/**
 * Test without searchType=image first
 */

require('dotenv').config();
const axios = require('axios');

async function testWebSearch() {
  console.log('\n🔍 Testing Google Custom Search (Web Search first)...\n');
  
  try {
    // Test 1: Basic web search (no image)
    console.log('Test 1: Basic web search (no image type)');
    const response1 = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: {
        q: 'photosynthesis diagram',
        cx: process.env.GOOGLE_CX_ID,
        key: process.env.GOOGLE_API_KEY,
        num: 2
      },
      timeout: 10000
    });
    
    console.log('✅ Web search works!');
    console.log('   Items:', response1.data.items?.length || 0);
    if (response1.data.items?.[0]) {
      console.log('   First result:', response1.data.items[0].title);
    }
  } catch (error) {
    console.log('❌ Web search failed:');
    if (error.response?.data?.error) {
      console.log('   Message:', error.response.data.error.message);
      console.log('   Errors:', JSON.stringify(error.response.data.error.errors, null, 2));
    } else {
      console.log('   Error:', error.message);
    }
  }
  
  // Test 2: Check if API key has Custom Search API enabled
  console.log('\n📝 Checking API key...');
  console.log('   Your API Key starts with:', process.env.GOOGLE_API_KEY?.substring(0, 15) + '...');
  console.log('   Your CX ID:', process.env.GOOGLE_CX_ID);
  
  // Test 3: Try image search with more details
  console.log('\nTest 2: Image search');
  try {
    const response2 = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: {
        q: 'photosynthesis',
        cx: process.env.GOOGLE_CX_ID,
        key: process.env.GOOGLE_API_KEY,
        searchType: 'image',
        num: 1
      },
      timeout: 10000
    });
    
    console.log('✅ Image search works!');
    console.log('   Items:', response2.data.items?.length || 0);
  } catch (error) {
    console.log('❌ Image search failed:');
    if (error.response?.data?.error) {
      console.log('   Message:', error.response.data.error.message);
      console.log('   Details:', JSON.stringify(error.response.data.error.errors, null, 2));
    }
  }
  
  console.log('\n📌 TROUBLESHOOTING:');
  console.log('1. Go to: https://console.cloud.google.com/apis/api/customsearch.googleapis.com');
  console.log('2. Make sure Custom Search API is ENABLED');
  console.log('3. Go to: https://programmablesearchengine.google.com/controlpanel/all');
  console.log('4. Click on your search engine → Edit');
  console.log('5. Scroll to "Image search" → Make sure it is ON');
  console.log('6. Save changes\n');
}

testWebSearch().catch(console.error);
