const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env'), override: true });

const { invokeModel } = require('../services/ai/deepseek-client');
const { executeTavilySearch } = require('../services/tavily-search');

async function testKeys() {
    console.log('======================================================');
    console.log('🔑 TESTING UPDATED API KEYS');
    console.log('======================================================\n');

    // 1. Test DeepSeek API
    console.log('1️⃣ Testing DeepSeek API key...');
    try {
        const deepseekRes = await invokeModel(
            'You are a helpful learning assistant.',
            [{ role: 'user', content: 'Say hello in exactly 3 words.' }],
            { maxTokens: 20 }
        );
        console.log('   ✅ DeepSeek SUCCESS! Response:', deepseekRes.trim());
    } catch (err) {
        console.error('   ❌ DeepSeek FAILED:', err.message);
    }

    // 2. Test Tavily API
    console.log('\n2️⃣ Testing Tavily Web Search API key...');
    try {
        const tavilyRes = await executeTavilySearch('NCERT Class 10 Science syllabus 2026');
        if (tavilyRes && tavilyRes.results && tavilyRes.results.length > 0) {
            console.log(`   ✅ Tavily SUCCESS! Found ${tavilyRes.results.length} results.`);
            console.log('   Top Result Title:', tavilyRes.results[0].title);
            console.log('   Top Result URL:  ', tavilyRes.results[0].url);
        } else {
            console.log('   ⚠️ Tavily returned no results.');
        }
    } catch (err) {
        console.error('   ❌ Tavily FAILED:', err.message);
    }

    console.log('\n======================================================\n');
}

testKeys();
