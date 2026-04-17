const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

/**
 * Invoke a Bedrock model using the Converse API (Unified for most models)
 * @param {string} systemPrompt - System instruction
 * @param {Array} messages - Array of { role: 'user'|'assistant', content: [{ text: string }] }
 * @param {Object} options - Inference configuration (temperature, maxTokens, etc.)
 * @returns {Promise<string>} - Model response text
 */
async function invokeModel(systemPrompt, messages, options = {}) {
    const modelId = options.modelId || process.env.BEDROCK_MODEL_ID || 'deepseek.v3.2';
    
    // Format messages for Bedrock Converse API if they are just strings
    const formattedMessages = messages.map(msg => {
        if (typeof msg.content === 'string') {
            return {
                role: msg.role,
                content: [{ text: msg.content }]
            };
        }
        return msg;
    });

    const command = new ConverseCommand({
        modelId,
        messages: formattedMessages,
        system: systemPrompt ? [{ text: systemPrompt }] : undefined,
        inferenceConfig: {
            maxTokens: options.maxTokens || 4096,
            temperature: options.temperature !== undefined ? options.temperature : 0.7,
            topP: options.topP || 0.9
        }
    });

    try {
        console.log(`[Bedrock] 🚀 Invoking model: ${modelId}`);
        const response = await client.send(command);
        
        if (response.output && response.output.message) {
            const text = response.output.message.content[0].text;
            console.log(`[Bedrock] ✅ Response received (${text.length} chars)`);
            return text;
        }
        throw new Error('Unexpected response format from Bedrock Converse API');
    } catch (error) {
        console.error(`[Bedrock] ❌ Error invoking ${modelId}:`, error.message);
        throw error;
    }
}

/**
 * Helper to extract JSON from model response
 */
function extractJson(text) {
    if (!text) return null;
    try {
        // Find the first { or [ and last } or ]
        const start = text.search(/\{|\[/);
        const end = text.lastIndexOf('}') > text.lastIndexOf(']') ? text.lastIndexOf('}') : text.lastIndexOf(']');
        
        if (start === -1 || end === -1) {
            // Fallback: try parsing directly
            return JSON.parse(text);
        }
        
        const jsonStr = text.substring(start, end + 1);
        return JSON.parse(jsonStr);
    } catch (e) {
        console.error('[Bedrock] Failed to parse JSON from response:', e.message);
        console.debug('Raw text:', text);
        return null;
    }
}

module.exports = {
    invokeModel,
    extractJson,
    client
};
