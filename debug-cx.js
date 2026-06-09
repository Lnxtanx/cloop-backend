/**
 * Debug Google Custom Search CX ID
 */

require('dotenv').config();
const axios = require('axios');

async function debugCX() {
  console.log('\n🔍 Debugging Google Custom Search...\n');
  
  console.log('Current CX ID:', process.env.GOOGLE_CX_ID);
  console.log('Current API Key:', process.env.GOOGLE_API_KEY?.substring(0, 10) + '...');
  
  // Try different variations
  const tests = [
    { name: 'With searchType=image', params: { searchType: 'image', num: 1 } },
    { name: 'Without searchType (web search)', params: { num: 1 } },
    { name: 'With safe=active', params: { searchType: 'image', num: 1, safe: 'active' } },
  ];
  
  for (const test of tests) {
    console.log(`\n━━━ Test: ${test.name} ━━━`);
    
    try {
      const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
        params: {
          q: 'test',
          cx: process.env.GOOGLE_CX_ID,
          key: process.env.GOOGLE_API_KEY,
          ...test.params
        },
        timeout: 10000
      });
      
      console.log('✅ SUCCESS');
      console.log('Response keys:', Object.keys(response.data));
      if (response.data.items) {
        console.log('Items found:', response.data.items.length);
      }
    } catch (error) {
      console.log('❌ FAILED');
      if (error.response) {
        console.log('Status:', error.response.status);
        const errorData = error.response.data;
        if (errorData.error) {
          console.log('Error code:', errorData.error.code);
          console.log('Error message:', errorData.error.message);
          if (errorData.error.errors) {
            console.log('Detailed errors:', JSON.stringify(errorData.error.errors, null, 2));
          }
        }
      } else {
        console.log('Error:', error.message);
      }
    }
  }
  
  console.log('\n📌 HOW TO FIX:');
  console.log('1. Go to: https://programmablesearchengine.google.com/');
  console.log('2. Click on your search engine (or create a new one)');
  console.log('3. Copy the "Search engine ID" (NOT the HTML code)');
  console.log('4. Make sure "Image search" is enabled in settings');
  console.log('5. Update GOOGLE_CX_ID in .env with the correct ID\n');
}

debugCX().catch(console.error);
