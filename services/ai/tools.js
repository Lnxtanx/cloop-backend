/**
 * AI Tools for Voice Conversations
 * These tools allow the AI to query user data during voice conversations
 * Reorganized into services/ai/ folder
 */

const {
    getUserProfile,
    getRecentReports,
    getWeakAreas,
    getStudyStats,
    getTopicDetails
} = require('../user-context-builder');

/**
 * Definitions for OpenAI Realtime API (used as metadata)
 */
const toolDefinitions = [
    {
        type: "function",
        name: "get_user_profile",
        description: "Get basic information about the student like name, grade level, and enrolled subjects.",
        parameters: { type: "object", properties: {} }
    },
    {
        type: "function",
        name: "get_recent_performance",
        description: "Get the student's recent test scores and topic performance reports.",
        parameters: {
            type: "object",
            properties: {
                limit: { type: "integer", description: "Number of reports to fetch (default 5)" }
            }
        }
    },
    {
        type: "function",
        name: "get_weak_areas",
        description: "Get subjects or topics where the student is struggling and needs more practice.",
        parameters: { type: "object", properties: {} }
    },
    {
        type: "function",
        name: "get_study_stats",
        description: "Get study time statistics for the current week (minutes, days studied).",
        parameters: { type: "object", properties: {} }
    },
    {
        type: "function",
        name: "get_topic_info",
        description: "Get detailed information about a specific learning topic or its goals.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "The name or ID of the topic to look up" }
            },
            required: ["query"]
        }
    }
];

/**
 * Execute a tool by name with provided arguments
 */
async function executeTool(userId, toolName, args = {}) {
    try {
        console.log(`[AI Tools] Calling ${toolName} for user ${userId}`);
        
        switch (toolName) {
            case 'get_user_profile':
                return await getUserProfile(userId);

            case 'get_recent_performance':
                return await getRecentReports(userId, args.limit || 5);

            case 'get_weak_areas':
                return await getWeakAreas(userId);

            case 'get_study_stats':
                return await getStudyStats(userId);

            case 'get_topic_info':
                return await getTopicDetails(userId, args.query);

            default:
                console.warn(`[AI Tools] Unknown tool requested: ${toolName}`);
                return { error: `Tool ${toolName} not found` };
        }
    } catch (error) {
        console.error(`[AI Tools] Error executing tool ${toolName}:`, error);
        return { error: `Failed to execute ${toolName}: ${error.message}` };
    }
}

module.exports = {
    toolDefinitions,
    executeTool
};
