const { invokeModel } = require('../services/ai/bedrock-client');

async function testClaude() {
    try {
        console.log('Testing Claude 3 Haiku...');
        const response = await invokeModel(
            'You are a helpful assistant.',
            [{ role: 'user', content: 'Say hello.' }],
            { modelId: 'anthropic.claude-3-haiku-20240307-v1:0', maxTokens: 100 }
        );
        console.log('--- Response ---');
        console.log(response);
    } catch (error) {
        console.error('Claude test failed:', error.message);
    }
}

testClaude();
