const deepseekClient = require('./deepseek-client');

/**
 * Delegate invokeModel to DeepSeek Client (Direct API)
 */
async function invokeModel(systemPrompt, messages, options = {}) {
    return deepseekClient.invokeModel(systemPrompt, messages, options);
}

/**
 * Delegate extractJson to DeepSeek Client helper
 */
function extractJson(text) {
    return deepseekClient.extractJson(text);
}

module.exports = {
    invokeModel,
    extractJson
};
