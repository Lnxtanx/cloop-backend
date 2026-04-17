const { invokeModel } = require('../services/ai/bedrock-client');

async function runTest() {
    try {
        console.log('Testing Bedrock model...');
        const response = await invokeModel(
            'You are a helpful assistant.',
            [{ role: 'user', content: 'Say hello and tell me your model name.' }],
            { maxTokens: 100 }
        );
        console.log('--- Response ---');
        console.log(response);
        console.log('----------------');
    } catch (error) {
        console.error('Test failed:', error.message);
    }
}

runTest();
