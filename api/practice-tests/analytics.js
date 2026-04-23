const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const prisma = require('../../lib/prisma');

/**
 * GET /api/practice-tests/analytics/overview
 */
router.get('/overview', authenticateToken, async (req, res) => {
    const user_id = req.user.user_id;

    try {
        const allExams = await prisma.standard_exams.findMany();
        const tests = await prisma.practice_tests.findMany({
            where: { user_id, status: 'completed' },
            orderBy: { created_at: 'desc' }
        });

        // 1. Format Recent Tests
        const recent_tests = tests.slice(0, 5).map(t => ({
            id: t.id,
            title: `${t.exam_type}: ${t.subject}`,
            score_percent: Math.round((t.score / t.total_questions) * 100),
            correct_answers: t.score,
            incorrect_answers: t.total_questions - t.score,
            total_questions: t.total_questions,
            created_at: t.created_at
        }));

        // 2. Calculate Predicted Score for ALL exams
        const exams_data = allExams.map(exam => {
            const examTests = tests.filter(t => t.exam_type === exam.code);
            
            let predicted_score = 0;
            if (examTests.length > 0) {
                // Weighted Logic: Recent tests carry more weight (60% weight for last 3 tests)
                const recentTests = examTests.slice(0, 3);
                const recentAvg = (recentTests.reduce((s, t) => s + (t.score / t.total_questions), 0) / recentTests.length) * 100;
                const overallAvg = (examTests.reduce((s, t) => s + (t.score / t.total_questions), 0) / examTests.length) * 100;
                
                predicted_score = Math.round((recentAvg * 0.6) + (overallAvg * 0.4));
            }

            return {
                exam_type: exam.code,
                name: exam.name,
                predicted_score: predicted_score || 0,
                total_tests: examTests.length
            };
        });

        return res.status(200).json({
            has_data: tests.length > 0,
            recent_tests,
            exams: exams_data
        });
    } catch (error) {
        console.error('[PracticeAnalytics] Overview error:', error);
        return res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

/**
 * GET /api/practice-tests/analytics/exam/:examCode
 */
router.get('/exam/:examCode', authenticateToken, async (req, res) => {
    const user_id = req.user.user_id;
    const { examCode } = req.params;

    try {
        const tests = await prisma.practice_tests.findMany({
            where: { user_id, exam_type: examCode, status: 'completed' },
            include: { questions: true, selected_chapters: { include: { chapter: true } } }
        });

        const examMeta = await prisma.standard_exams.findFirst({
            where: { code: examCode },
            include: { subjects: true }
        });

        if (!examMeta) return res.status(404).json({ error: 'Exam not found' });

        // 1. REAL Time Analytics (Actual calculations)
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));
        const oneWeekAgo = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));

        let daily_sec = 0, weekly_sec = 0, total_sec = 0;
        let total_q = 0, total_c = 0;

        tests.forEach(t => {
            total_sec += (t.time_taken_sec || 0);
            total_q += t.total_questions;
            total_c += (t.score || 0);
            
            const testDate = new Date(t.created_at);
            if (testDate > oneDayAgo) daily_sec += (t.time_taken_sec || 0);
            if (testDate > oneWeekAgo) weekly_sec += (t.time_taken_sec || 0);
        });

        // 2. Subject Breakdown
        const uniqueSubjects = new Set(examMeta.subjects.map(s => s.name));
        tests.forEach(t => { if(t.subject) uniqueSubjects.add(t.subject); });

        const subject_stats = Array.from(uniqueSubjects).map(subName => {
            const subTests = tests.filter(t => t.subject === subName);
            let sub_score = 0;
            if (subTests.length > 0) {
                sub_score = Math.round((subTests.reduce((sum, t) => sum + (t.score || 0), 0) / subTests.reduce((sum, t) => sum + (t.total_questions || 0), 0)) * 100);
            }
            return { name: subName, score_percent: sub_score || 0 };
        });

        // 3. Error Analysis
        const error_types = { Conceptual: 0, Application: 0, Calculation: 0 };
        tests.forEach(t => {
            t.questions.forEach(q => {
                if (!q.is_correct && q.explanation) {
                    const text = q.explanation.toLowerCase();
                    if (text.includes('calculate') || text.includes('math') || text.includes('value')) error_types.Calculation++;
                    else if (text.includes('apply') || text.includes('formula') || text.includes('method')) error_types.Application++;
                    else error_types.Conceptual++;
                }
            });
        });

        // 4. Chapter Mastery
        const chapter_mastery = {};
        tests.forEach(t => {
            t.selected_chapters.forEach(sc => {
                const title = sc.chapter.title;
                if (!chapter_mastery[title]) chapter_mastery[title] = { title, correct: 0, total: 0 };
                chapter_mastery[title].correct += (t.score / t.total_questions);
                chapter_mastery[title].total += 1;
            });
        });

        const sortedChapters = Object.values(chapter_mastery)
            .map(c => ({ title: c.title, score_percent: Math.round((c.correct / c.total) * 100) }))
            .sort((a, b) => a.score_percent - b.score_percent);

        return res.status(200).json({
            exam_code: examCode,
            summary: {
                average_score: Math.round((total_c / (total_q || 1)) * 100),
                total_questions: total_q,
                correct_answers: total_c
            },
            subjects: subject_stats,
            time_analytics: {
                total_seconds: total_sec,
                daily_seconds: daily_sec,
                weekly_seconds: weekly_sec
            },
            error_analysis: { error_types },
            chapter_mastery: sortedChapters
        });
    } catch (error) {
        console.error('[PracticeAnalytics] Exam deep-dive error:', error);
        return res.status(500).json({ error: 'Failed to fetch exam analytics' });
    }
});

module.exports = router;
