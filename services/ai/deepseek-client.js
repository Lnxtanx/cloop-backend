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
    // Normalise if invoked as invokeModel(messages, options) with systemInstruction in options
    if (Array.isArray(systemPrompt)) {
        options = messages || {};
        messages = systemPrompt;
        systemPrompt = options.systemInstruction || options.systemPrompt || '';
    }

    const apiKey = (process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || '').trim();
    if (!apiKey) {
        throw new Error('DEEPSEEK_API_KEY is missing in environment variables (.env)');
    }

    // Default to deepseek-chat (V3), or deepseek-reasoner (R1)
    const model = options.modelId || process.env.DEEPSEEK_MODEL || 'deepseek-chat';

    // Format messages for OpenAI/DeepSeek API format
    const formattedMessages = [];
    
    if (typeof systemPrompt === 'string' && systemPrompt.trim()) {
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

    if (options.responseFormat) {
        payload.response_format = options.responseFormat;
    } else if (options.jsonFormat === true && !model.includes('reasoner')) {
        payload.response_format = { type: 'json_object' };
        // DeepSeek requires the word 'json' to appear in the prompt when using response_format: { type: 'json_object' }
        const hasJsonWord = formattedMessages.some(m => /json/i.test(m.content));
        if (!hasJsonWord) {
            if (formattedMessages.length > 0 && formattedMessages[0].role === 'system') {
                formattedMessages[0].content += '\nRespond in valid JSON format.';
            } else {
                formattedMessages.unshift({ role: 'system', content: 'Respond in valid JSON format.' });
            }
        }
    }

    console.log(`[DeepSeek] 🚀 Invoking model: ${model} (${formattedMessages.length} messages)`);

    const startTime = Date.now();
    const maxAttempts = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(new Error('DeepSeek API request timed out after 30s')), 30000);

        try {
            const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

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
            clearTimeout(timeoutId);
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
        // 2. Prefer a JSON OBJECT ({...}) since the chat pipeline returns an object shape.
        //    Only fall back to arrays/other when there is genuinely no object in the text.
        const openBrace = cleanedText.search(/\{/);
        if (openBrace !== -1) {
            // Find the matching closing brace using a depth count (tolerates nested {} and
            // string-embedded braces roughly). Then try to parse that slice; back off to the
            // last brace if trailing junk remains.
            let depth = 0, inString = false, escaped = false, closeBrace = -1;
            for (let i = openBrace; i < cleanedText.length; i++) {
                const ch = cleanedText[i];
                if (inString) {
                    if (escaped) escaped = false;
                    else if (ch === '\\') escaped = true;
                    else if (ch === '"') inString = false;
                    continue;
                }
                if (ch === '"') { inString = true; continue; }
                if (ch === '{') depth++;
                else if (ch === '}') { depth--; if (depth === 0) { closeBrace = i; break; } }
            }
            if (closeBrace !== -1) {
                return parseSlice(cleanedText.substring(openBrace, closeBrace + 1));
            }
        }

        // 3. No JSON object found. Only accept a bare JSON array if the ENTIRE trimmed
        //    response parses as one (avoid slicing prose/mermaid that happens to contain
        //    "[" ... "]"). Otherwise treat the response as plain text.
        if (cleanedText.startsWith('[')) {
            try {
                return JSON.parse(cleanedText);
            } catch (e) {
                // fall through to text wrapper
            }
        }
        throw new ParseFailure();
    } catch (err) {
        console.error('[DeepSeek] ⚠️ JSON Parse Error:', err.message);
        if (cleanedText && cleanedText.length > 0) {
            console.log('[DeepSeek] 💡 Using raw text fallback wrapper for invalid JSON output');
            return {
                messages: [
                    { message: cleanRawText(cleanedText), message_type: "text" }
                ]
            };
        }
        return null;
    }
}

class ParseFailure extends Error {}

function parseSlice(slice) {
    // Remove trailing commas before } or ]
    const sanitized = slice.replace(/,\s*([}\]])/g, '$1');
    try {
        return JSON.parse(sanitized);
    } catch (parseErr) {
        // Trailing content after the real JSON object (e.g. model appended prose/number
        // after the array). Walk backward to the nearest position that parses cleanly.
        const closeBrace = sanitized.lastIndexOf('}');
        const closeBracket = sanitized.lastIndexOf(']');
        const far = Math.max(closeBrace, closeBracket);
        let cut = far;
        while (cut > 0) {
            try {
                return JSON.parse(sanitized.substring(0, cut + 1));
            } catch (inner) {
                cut = Math.max(sanitized.lastIndexOf('}', cut - 1), sanitized.lastIndexOf(']', cut - 1));
                if (cut === -1) break;
            }
        }
        throw parseErr;
    }
}

function cleanRawText(text) {
    return String(text || '').trim();
}

module.exports = {
    invokeModel,
    extractJson
};
