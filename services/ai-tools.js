/**
 * AI Tools for OpenAI Realtime API Function Calling
 * These tools allow the AI to query user data during voice conversations
 */

const {
    getUserProfile,
    getRecentReports,
    getWeakAreas,
    getStudyStats,
    getTopicDetails
} = require('./user-context-builder')

/**
 * Tool definitions for OpenAI function calling
 */
const toolDefinitions = [
    {
        type: 'function',
        name: 'get_user_profile',
        description: 'Get the student\'s profile including name, grade level, board, and subjects they are studying',
        parameters: {
            type: 'object',
            properties: {},
            required: []
        }
    },
    {
        type: 'function',
        name: 'get_recent_scores',
        description: 'Get the student\'s recent topic scores and performance. Use this when asked about recent performance, last score, how they did recently, etc.',
        parameters: {
            type: 'object',
            properties: {
                limit: {
                    type: 'number',
                    description: 'Number of recent scores to fetch (default 5, max 10)'
                }
            },
            required: []
        }
    },
    {
        type: 'function',
        name: 'get_weak_areas',
        description: 'Identify subjects where the student needs improvement based on their scores. Use when asked about what to improve, weak subjects, or study recommendations.',
        parameters: {
            type: 'object',
            properties: {},
            required: []
        }
    },
    {
        type: 'function',
        name: 'get_study_stats',
        description: 'Get study session statistics like time spent, number of sessions, and study streak for the past week.',
        parameters: {
            type: 'object',
            properties: {},
            required: []
        }
    },
    {
        type: 'function',
        name: 'get_topic_details',
        description: 'Get details about a specific topic by name. Use when user asks about a particular topic or subject matter.',
        parameters: {
            type: 'object',
            properties: {
                topic_name: {
                    type: 'string',
                    description: 'Name or partial name of the topic to search for'
                }
            },
            required: ['topic_name']
        }
    },
    {
        type: 'function',
        name: 'create_study_plan',
        description: 'Generate a personalized study plan based on weak areas and available time. Use when asked for a study plan, roadmap, or what to study next.',
        parameters: {
            type: 'object',
            properties: {
                days_available: {
                    type: 'number',
                    description: 'Number of days for the study plan (default 7)'
                },
                hours_per_day: {
                    type: 'number',
                    description: 'Hours available per day for study (default 2)'
                }
            },
            required: []
        }
    }
]

/**
 * Execute a tool call and return the result
 */
async function executeTool(userId, toolName, args = {}) {
    try {
        switch (toolName) {
            case 'get_user_profile':
                return await getUserProfile(userId)

            case 'get_recent_scores':
                const limit = Math.min(args.limit || 5, 10)
                return await getRecentReports(userId, limit)

            case 'get_weak_areas':
                return await getWeakAreas(userId)

            case 'get_study_stats':
                return await getStudyStats(userId)

            case 'get_topic_details':
                if (!args.topic_name) {
                    return { error: 'Topic name is required' }
                }
                return await getTopicDetails(userId, args.topic_name)

            case 'create_study_plan':
                const weakAreas = await getWeakAreas(userId)
                const days = args.days_available || 7
                const hoursPerDay = args.hours_per_day || 2

                // Generate simple study plan based on weak areas
                const plan = {
                    duration: `${days} days`,
                    dailyTime: `${hoursPerDay} hours`,
                    focus: weakAreas.slice(0, 3).map((area, idx) => ({
                        priority: idx + 1,
                        subject: area.subjectName,
                        currentScore: `${area.averageScore}%`,
                        recommendation: area.recommendation,
                        suggestedTime: `${Math.round(hoursPerDay * 60 / (idx + 2))} mins/day`
                    })),
                    tips: [
                        'Start with your weakest subject when your mind is fresh',
                        'Take short breaks every 25 minutes (Pomodoro technique)',
                        'Review what you learned before sleeping'
                    ]
                }
                return plan

            default:
                return { error: `Unknown tool: ${toolName}` }
        }
    } catch (error) {
        console.error(`Error executing tool ${toolName}:`, error)
        return { error: `Failed to execute ${toolName}: ${error.message}` }
    }
}

module.exports = {
    toolDefinitions,
    executeTool
}
