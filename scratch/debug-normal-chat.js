const { invokeModel } = require('../services/ai/bedrock-client');

async function debugChat() {
    const message = "Hello, how are you?";
    const systemPrompt = `You are Cloop AI, a helpful and friendly educational assistant. You help students with their studies across various subjects. 
						
			Key traits:
			- Be encouraging and supportive
			- Provide clear, easy-to-understand explanations
			- Ask follow-up questions to ensure understanding
			- Relate concepts to real-world examples when possible
			- Maintain a positive, learning-focused tone
			- Keep responses concise but comprehensive
			- If you don't know something, admit it and suggest how to find the answer`;

    console.log('--- Debugging Normal Chat invokeModel ---');
    console.log('Model ID from env:', process.env.BEDROCK_MODEL_ID);
    
    try {
        const aiResponseText = await invokeModel(systemPrompt, [{ role: 'user', content: message }], {
            maxTokens: 2048,
            temperature: 0.7
        });
        console.log('✅ Success! Response:');
        console.log(aiResponseText);
    } catch (error) {
        console.error('❌ Failed! Error details:');
        console.error({
            message: error.message,
            code: error.code,
            name: error.name,
            stack: error.stack ? 'present' : 'missing'
        });
    }
}

debugChat();
