const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

console.log(`[Bedrock] Initializing client in region: ${process.env.AWS_REGION || 'us-east-1'}`);
if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.warn('[Bedrock] ⚠️ WARNING: AWS credentials missing in environment variables!');
} else {
    console.log('[Bedrock] ✅ AWS credentials found (ID starts with: ' + process.env.AWS_ACCESS_KEY_ID.substring(0, 5) + '...)');
}

const client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID?.trim(),
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY?.trim()
    }
});

/**
 * Helper to wrap a promise with a timeout
 */
function withTimeout(promise, ms, errorMessage) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(errorMessage));
        }, ms);
    });
    return Promise.race([
        promise.then((res) => {
            clearTimeout(timeoutId);
            return res;
        }),
        timeoutPromise
    ]);
}

/**
 * Invoke a Bedrock model using the Converse API (Unified for most models)
 * @param {string} systemPrompt - System instruction
 * @param {Array} messages - Array of { role: 'user'|'assistant', content: [{ text: string }] }
 * @param {Object} options - Inference configuration (temperature, maxTokens, etc.)
 * @returns {Promise<string>} - Model response text
 */
async function invokeModel(systemPrompt, messages, options = {}) {
    const modelId = options.modelId || process.env.BEDROCK_MODEL_ID || 'deepseek.v3.2';
    
    // Format messages for Bedrock Converse API and safeguard against empty/blank content
    const formattedMessages = messages.map(msg => {
        let textContent = '';
        if (typeof msg.content === 'string') {
            textContent = msg.content.trim();
        } else if (Array.isArray(msg.content) && msg.content[0] && typeof msg.content[0].text === 'string') {
            textContent = msg.content[0].text.trim();
        } else if (msg.content && typeof msg.content === 'object' && typeof msg.content.text === 'string') {
            textContent = msg.content.text.trim();
        }

        // Bedrock Converse API throws an error if any message has empty/blank text content
        if (!textContent) {
            textContent = '...';
        }

        return {
            role: msg.role,
            content: [{ text: textContent }]
        };
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
        
        // Wrap Bedrock Converse command send with a 60-second timeout to prevent indefinite hangs
        const response = await withTimeout(
            client.send(command),
            60000,
            `AWS Bedrock call to ${modelId} timed out after 60 seconds`
        );
        
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
 * Helper to extract JSON from model response, robust against thinking blocks and trailing commas
 */
function extractJson(text) {
    if (!text) return null;
    
    // 1. Strip reasoning/thinking blocks (common in DeepSeek R1 models)
    let cleanedText = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    
    try {
        // 2. Find the first { or [ and last } or ]
        const start = cleanedText.search(/\{|\[/);
        const end = cleanedText.lastIndexOf('}') > cleanedText.lastIndexOf(']') ? cleanedText.lastIndexOf('}') : cleanedText.lastIndexOf(']');
        
        if (start === -1 || end === -1) {
            // Fallback: try parsing directly
            return JSON.parse(cleanedText);
        }
        
        const jsonStr = cleanedText.substring(start, end + 1);
        
        // 3. Sanitize common JSON errors like trailing commas or invalid control characters
        const sanitizedJsonStr = jsonStr
            .replace(/,\s*([\]}])/g, '$1') // Remove trailing commas
            .replace(/[\u0000-\u001F\u007F-\u009F]/g, ""); // Remove invalid control characters
            
        return JSON.parse(sanitizedJsonStr);
    } catch (e) {
        console.error('[Bedrock] Failed to parse JSON from response:', e.message);
        console.debug('Raw text was:', text);
        return null;
    }
}

module.exports = {
    invokeModel,
    extractJson,
    client
};
