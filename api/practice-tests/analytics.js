const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const prisma = require('../../lib/prisma');

/**
 * GET /api/practice-tests/analytics/overview
 * Returns an overview of practice test performance across different exams
 */
router.get('/overview', authenticateToken, async (req, res) => {
    const user_id = req.user.user_id;

    try {
        const tests = await prisma.practice_tests.findMany({
            where: { user_id: user_id, status: 'completed' },
            orderBy: { created_at: 'desc' },
            take: 10,
            include: { questions: true }
        });

        if (tests.length === 0) {
            return res.status(200).json({ has_data: false });
        }

        // Aggregate by Exam Type
        const by_exam = {};
        const allTests = await prisma.practice_tests.findMany({
            where: { user_id: user_id, status: 'completed' }
        });

        allTests.forEach(test => {
            if (!by_exam[test.exam_type]) {
                by_exam[test.exam_type] = {
                    exam_type: test.exam_type,
                    total_correct: 0,
                    total_questions: 0,
                    subjects: {}
                };
            }
            
            const exam = by_exam[test.exam_type];
            exam.total_correct += test.score || 0;
            exam.total_questions += test.total_questions || 0;
        });

        const formattedExams = Object.values(by_exam).map(e => ({
            exam_type: e.exam_type,
            avg_score_percent: Math.round((e.total_correct / e.total_questions) * 100)
        }));

        return res.status(200).json({
            has_data: true,
            recent_tests: tests.map(t => ({
                id: t.id,
                title: `${t.exam_type}: ${t.subject}`,
                score_percent: Math.round((t.score / t.total_questions) * 100),
                correct_answers: t.score,
                incorrect_answers: t.total_questions - t.score,
                total_questions: t.total_questions,
                created_at: t.created_at
            })),
            exams: formattedExams
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

        // 1. Summary
        let total_q = 0, total_c = 0, total_sec = 0;
        tests.forEach(t => {
            total_q += t.total_questions;
            total_c += t.score || 0;
            total_sec += t.time_taken_sec || 0;
        });

        // 2. Error Analysis
        const error_types = { Conceptual: 0, Application: 0, Calculation: 0 };
        tests.forEach(t => {
            t.questions.forEach(q => {
                if (!q.is_correct && q.explanation) {
                    const text = q.explanation.toLowerCase();
                    if (text.includes('calculate') || text.includes('math')) error_types.Calculation++;
                    else if (text.includes('apply') || text.includes('method')) error_types.Application++;
                    else error_types.Conceptual++;
                }
            });
        });

        // 3. Chapter Mastery
        const chapter_mastery = {};
        tests.forEach(t => {
            t.selected_chapters.forEach(sc => {
                if (!chapter_mastery[sc.chapter.title]) {
                    chapter_mastery[sc.chapter.title] = { title: sc.chapter.title, correct: 0, total: 0 };
                }
                chapter_mastery[sc.chapter.title].correct += (t.score / t.total_questions);
                chapter_mastery[sc.chapter.title].total += 1;
            });
        });

        return res.status(200).json({
            exam_code: examCode,
            summary: {
                average_score: Math.round((total_c / total_q) * 100) || 0,
                total_questions: total_q,
                correct_answers: total_c
            },
            time_analytics: {
                total_seconds: total_sec,
                daily_seconds: Math.round(total_sec / 30), // Simulated averages
                weekly_seconds: Math.round(total_sec / 4)
            },
            error_analysis: { error_types },
            chapter_mastery: Object.values(chapter_mastery).map(c => ({
                title: c.title,
                score_percent: Math.round((c.correct / c.total) * 100)
            })).sort((a, b) => a.score_percent - b.score_percent)
        });
    } catch (error) {
        console.error('[PracticeAnalytics] Exam deep-dive error:', error);
        return res.status(500).json({ error: 'Failed to fetch exam analytics' });
    }
});

module.exports = router;
