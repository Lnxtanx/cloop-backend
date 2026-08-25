const { invokeModel } = require('../services/ai/deepseek-client');

async function test() {
    try {
        console.log('Testing normal chat prompt invocation with DeepSeek...');
        const response = await invokeModel(
            'You are a helpful learning tutor for students.',
            [{ role: 'user', content: 'What is photosynthesis in 1 sentence?' }],
            {
                maxTokens: 100,
                temperature: 0.7,
                featureArea: 'normal_chat',
                subFeature: 'test'
            }
        );
        console.log('✅ Response:', response);
    } catch (err) {
        console.error('❌ Error:', err.message);
    }
}

test();
