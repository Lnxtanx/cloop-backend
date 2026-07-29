const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env'), override: true });
const { logTokenUsage } = require('../token-tracker');

const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

/**
 * Invoke DeepSeek API (OpenAI-compatible)
 * @param {string} systemPrompt - System instruction
 * @param {Array} messages - Array of { role: 'user'|'assistant', content: string|Array|Object }
 * @param {Object} options - Options (modelId, temperature, maxTokens, topP, userId, featureArea, subFeature, returnUsage, metadata)
 * @returns {Promise<string|Object>} - Generated text response (or { text, usage, durationMs } if options.returnUsage)
 */
async function invokeModel(systemPrompt, messages, options = {}) {
    const apiKey = (process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || '').trim();
    if (!apiKey) {
        throw new Error('DEEPSEEK_API_KEY is missing in environment variables (.env)');
    }

    // Default to deepseek-chat (V3), or deepseek-reasoner (R1)
    const model = options.modelId || process.env.DEEPSEEK_MODEL || 'deepseek-chat';

    // Format messages for OpenAI/DeepSeek API format
    const formattedMessages = [];
    
    if (systemPrompt && systemPrompt.trim()) {
        formattedMessages.push({
            role: 'system',
            content: systemPrompt.trim()
        });
    }

    for (const msg of messages) {
        let textContent = '';
        if (typeof msg.content === 'string') {
            textContent = msg.content.trim();
        } else if (Array.isArray(msg.content) && msg.content[0] && typeof msg.content[0].text === 'string') {
            textContent = msg.content[0].text.trim();
        } else if (msg.content && typeof msg.content === 'object' && typeof msg.content.text === 'string') {
            textContent = msg.content.text.trim();
        }

        if (!textContent) {
            textContent = '...';
        }

        formattedMessages.push({
            role: msg.role === 'ai' ? 'assistant' : msg.role,
            content: textContent
        });
    }

    const payload = {
        model,
        messages: formattedMessages,
        temperature: options.temperature !== undefined ? options.temperature : 0.7,
        max_tokens: options.maxTokens || 4096,
        top_p: options.topP || 0.9
    };

    console.log(`[DeepSeek] 🚀 Invoking model: ${model} (${formattedMessages.length} messages)`);

    const startTime = Date.now();
    const maxAttempts = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`DeepSeek API HTTP ${response.status}: ${errText}`);
            }

            const data = await response.json();
            const durationMs = Date.now() - startTime;

            if (data.choices && data.choices[0] && data.choices[0].message) {
                const messageObj = data.choices[0].message;
                if (messageObj.reasoning_content) {
                    console.log(`[DeepSeek] 🧠 Reasoning length: ${messageObj.reasoning_content.length} chars`);
                }
                const text = messageObj.content || '';
                
                // Extract usage statistics
                const rawUsage = data.usage || {};
                const promptTokens = rawUsage.prompt_tokens || 0;
                const completionTokens = rawUsage.completion_tokens || 0;
                const totalTokens = rawUsage.total_tokens || (promptTokens + completionTokens);
                const cachedPromptTokens = rawUsage.prompt_tokens_details?.cached_tokens || 0;
                const reasoningTokens = rawUsage.completion_tokens_details?.reasoning_tokens || 0;

                const usageDetails = {
                    promptTokens,
                    completionTokens,
                    totalTokens,
                    cachedPromptTokens,
                    reasoningTokens,
                    durationMs
                };

                // Automatically log token usage if featureArea was specified in call options
                if (options.featureArea) {
                    logTokenUsage({
                        userId: options.userId,
                        featureArea: options.featureArea,
                        subFeature: options.subFeature,
                        provider: 'deepseek',
                        modelName: model,
                        promptTokens,
                        completionTokens,
                        totalTokens,
                        cachedPromptTokens,
                        reasoningTokens,
                        requestDurationMs: durationMs,
                        status: 'success',
                        metadata: options.metadata || null
                    });
                }

                console.log(`[DeepSeek] ✅ Response received (${text.length} chars | ${totalTokens} tokens: ${promptTokens} in, ${completionTokens} out)`);

                if (options.returnUsage) {
                    return {
                        text,
                        usage: usageDetails,
                        durationMs
                    };
                }

                return text;
            }

            throw new Error('Unexpected response format from DeepSeek API');
        } catch (error) {
            lastError = error;
            console.error(`[DeepSeek] ❌ Attempt ${attempt}/${maxAttempts} failed:`, error.message);

            if (options.featureArea && attempt === maxAttempts) {
                logTokenUsage({
                    userId: options.userId,
                    featureArea: options.featureArea,
                    subFeature: options.subFeature,
                    provider: 'deepseek',
                    modelName: model,
                    status: 'failed',
                    requestDurationMs: Date.now() - startTime,
                    metadata: { error: error.message, ...(options.metadata || {}) }
                });
            }

            if (attempt < maxAttempts) {
                console.log(`[DeepSeek] 🔄 Retrying in 1 second...`);
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    throw lastError;
}

/**
 * Robust JSON extraction helper supporting reasoning tags (<think>...</think>)
 */
function extractJson(text) {
    if (!text) return null;

    // 1. Strip reasoning/thinking blocks (common in DeepSeek R1 models)
    let cleanedText = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    try {
        // 2. Find first { or [ and last } or ]
        const start = cleanedText.search(/\{|\[/);
        const end = cleanedText.lastIndexOf('}') > cleanedText.lastIndexOf(']') ? cleanedText.lastIndexOf('}') : cleanedText.lastIndexOf(']');

        if (start === -1 || end === -1) {
            return JSON.parse(cleanedText);
        }

        const jsonCandidate = cleanedText.substring(start, end + 1);

        // Remove trailing commas before } or ]
        const sanitized = jsonCandidate.replace(/,\s*([}\]])/g, '$1');

        return JSON.parse(sanitized);
    } catch (err) {
        console.error('[DeepSeek] ❌ JSON Parse Error:', err.message);
        console.error('[DeepSeek] Raw text:', text.substring(0, 300));
        return null;
    }
}

module.exports = {
    invokeModel,
    extractJson
};
