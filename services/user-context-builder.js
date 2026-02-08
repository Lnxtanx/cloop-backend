/**
 * User Context Builder for Voice AI
 * Builds comprehensive user context for personalized AI responses
 * Uses Prisma includes to resolve IDs to human-readable names
 */

const prisma = require('../lib/prisma')

/**
 * Get user profile with basic info
 */
async function getUserProfile(userId) {
    const user = await prisma.users.findUnique({
        where: { user_id: userId },
        select: {
            user_id: true,
            name: true,
            grade_level: true,
            board: true,
            subjects: true,
            preferred_language: true,
            study_goal: true,
            num_chats: true,
            num_lessons: true
        }
    })

    if (!user) return null

    return {
        name: user.name,
        gradeLevel: user.grade_level || 'Not set',
        board: user.board || 'Not set',
        subjects: user.subjects || [],
        preferredLanguage: user.preferred_language || 'English',
        studyGoal: user.study_goal || 'General learning',
        totalChats: user.num_chats || 0,
        totalLessons: user.num_lessons || 0
    }
}

/**
 * Get recent topic reports with scores and subject/topic names
 */
async function getRecentReports(userId, limit = 5) {
    const reports = await prisma.user_topic_reports.findMany({
        where: { user_id: userId },
        orderBy: { updated_at: 'desc' },
        take: limit,
        include: {
            topics: {
                select: {
                    title: true,
                    chapters: { select: { title: true } },
                    subjects: { select: { name: true } }
                }
            }
        }
    })

    return reports.map(r => ({
        topicName: r.topics?.title || 'Unknown Topic',
        chapterName: r.topics?.chapters?.title || 'Unknown Chapter',
        subjectName: r.topics?.subjects?.name || 'Unknown Subject',
        scorePercent: r.score_percent,
        starRating: r.star_rating,
        performanceLevel: r.performance_level,
        totalQuestions: r.total_questions,
        correctAnswers: r.correct_answers,
        date: r.updated_at
    }))
}

/**
 * Get subjects with average scores to identify weak areas
 */
async function getWeakAreas(userId) {
    // Get all reports grouped by subject
    const reports = await prisma.user_topic_reports.findMany({
        where: { user_id: userId },
        include: {
            topics: {
                select: {
                    subjects: { select: { id: true, name: true } }
                }
            }
        }
    })

    // Group by subject and calculate averages
    const subjectScores = {}
    for (const report of reports) {
        const subjectId = report.topics?.subjects?.id
        const subjectName = report.topics?.subjects?.name
        if (!subjectId) continue

        if (!subjectScores[subjectId]) {
            subjectScores[subjectId] = {
                name: subjectName,
                totalScore: 0,
                count: 0,
                scores: []
            }
        }
        subjectScores[subjectId].totalScore += report.score_percent
        subjectScores[subjectId].count++
        subjectScores[subjectId].scores.push(report.score_percent)
    }

    // Convert to array and sort by average score (ascending = weak first)
    const weakAreas = Object.entries(subjectScores)
        .map(([id, data]) => ({
            subjectId: parseInt(id),
            subjectName: data.name,
            averageScore: Math.round(data.totalScore / data.count),
            totalAttempts: data.count,
            recommendation: data.totalScore / data.count < 60
                ? 'Needs more practice'
                : data.totalScore / data.count < 80
                    ? 'Good progress, keep practicing'
                    : 'Excellent! Ready for advanced topics'
        }))
        .sort((a, b) => a.averageScore - b.averageScore)

    return weakAreas
}

/**
 * Get study session statistics
 */
async function getStudyStats(userId) {
    const today = new Date()
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)

    const sessions = await prisma.study_sessions.findMany({
        where: {
            user_id: userId,
            start_time: { gte: weekAgo }
        },
        include: {
            subjects: { select: { name: true } },
            topics: { select: { title: true } }
        }
    })

    const totalSeconds = sessions.reduce((sum, s) => sum + (s.duration_seconds || 0), 0)
    const studyDays = new Set(sessions.map(s =>
        new Date(s.start_time).toDateString()
    )).size

    return {
        totalMinutesThisWeek: Math.round(totalSeconds / 60),
        studyDaysThisWeek: studyDays,
        totalSessions: sessions.length,
        averageSessionMinutes: sessions.length > 0
            ? Math.round(totalSeconds / 60 / sessions.length)
            : 0
    }
}

/**
 * Get topic details by ID or title search
 */
async function getTopicDetails(userId, topicIdOrTitle) {
    let topic

    if (typeof topicIdOrTitle === 'number') {
        topic = await prisma.topics.findFirst({
            where: { id: topicIdOrTitle, user_id: userId },
            include: {
                chapters: { select: { title: true } },
                subjects: { select: { name: true } },
                topic_goals: { select: { title: true, description: true } }
            }
        })
    } else {
        // Search by title (partial match)
        topic = await prisma.topics.findFirst({
            where: {
                user_id: userId,
                title: { contains: topicIdOrTitle, mode: 'insensitive' }
            },
            include: {
                chapters: { select: { title: true } },
                subjects: { select: { name: true } },
                topic_goals: { select: { title: true, description: true } }
            }
        })
    }

    if (!topic) return null

    return {
        id: topic.id,
        title: topic.title,
        content: topic.content,
        chapterName: topic.chapters?.title,
        subjectName: topic.subjects?.name,
        isCompleted: topic.is_completed,
        completionPercent: topic.completion_percent,
        goals: topic.topic_goals?.map(g => g.title) || []
    }
}

/**
 * Build minimal context string for AI system prompt
 * Keep it concise to minimize token usage
 */
async function buildMinimalContext(userId) {
    const [profile, recentReports, weakAreas] = await Promise.all([
        getUserProfile(userId),
        getRecentReports(userId, 3),
        getWeakAreas(userId)
    ])

    if (!profile) return null

    // Build concise context
    let context = `Student: ${profile.name}, ${profile.gradeLevel} (${profile.board})\n`
    context += `Subjects: ${profile.subjects.join(', ') || 'None selected'}\n`

    if (recentReports.length > 0) {
        context += `Recent scores: `
        context += recentReports.map(r =>
            `${r.topicName}: ${r.scorePercent}%`
        ).join(', ')
        context += '\n'
    }

    if (weakAreas.length > 0 && weakAreas[0].averageScore < 70) {
        context += `Needs improvement: ${weakAreas[0].subjectName} (${weakAreas[0].averageScore}% avg)\n`
    }

    return context
}

module.exports = {
    getUserProfile,
    getRecentReports,
    getWeakAreas,
    getStudyStats,
    getTopicDetails,
    buildMinimalContext
}
