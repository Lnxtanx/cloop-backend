/**
 * Direct test to Google Custom Search API
 */

require('dotenv').config();
const axios = require('axios');

async function directTest() {
  console.log('\n🔍 Direct Custom Search API Test\n');
  
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  const GOOGLE_CX_ID = process.env.GOOGLE_CX_ID;
  
  console.log('API Key:', GOOGLE_API_KEY ? `${GOOGLE_API_KEY.substring(0, 15)}...` : 'NOT SET');
  console.log('CX ID:', GOOGLE_CX_ID || 'NOT SET');
  console.log('');
  
  // Test URL directly
  const testUrl = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX_ID}&q=test&num=1`;
  
  console.log('Test URL:', testUrl.replace(GOOGLE_API_KEY, 'API_KEY_HIDDEN'));
  console.log('');
  
  try {
    const response = await axios.get(testUrl, { timeout: 10000 });
    console.log('✅ SUCCESS!');
    console.log('Response status:', response.status);
    console.log('Items found:', response.data.items?.length || 0);
  } catch (error) {
    console.log('❌ FAILED');
    console.log('Status:', error.response?.status);
    console.log('Status Text:', error.response?.statusText);
    
    if (error.response?.data) {
      const errorData = error.response.data;
      console.log('\nError Details:');
      console.log('  Code:', errorData.error?.code);
      console.log('  Message:', errorData.error?.message);
      console.log('  Status:', errorData.error?.status);
      
      if (errorData.error?.errors) {
        console.log('\n  Errors:');
        errorData.error.errors.forEach((err, i) => {
          console.log(`  ${i+1}. ${err.message}`);
          console.log(`     Domain: ${err.domain}`);
          console.log(`     Reason: ${err.reason}`);
          console.log(`     Extended Help: ${err.extendedHelp || 'N/A'}`);
        });
      }
    }
    
    console.log('\n📋 SOLUTION:');
    console.log('1. Go to: https://console.cloud.google.com/apis/library');
    console.log('2. Select your project (where API key was created)');
    console.log('3. Search for "Custom Search API"');
    console.log('4. Click ENABLE');
    console.log('5. Wait 1-2 minutes and try again');
  }
}

directTest().catch(console.error);
