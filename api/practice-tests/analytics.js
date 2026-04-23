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
        // 1. Get all standard exams
        const allExams = await prisma.standard_exams.findMany();
        
        // 2. Get user's completed tests
        const tests = await prisma.practice_tests.findMany({
            where: { user_id: user_id, status: 'completed' },
            orderBy: { created_at: 'desc' }
        });

        // 3. Format Recent Tests (top 5)
        const recent_tests = tests.slice(0, 5).map(t => ({
            id: t.id,
            title: `${t.exam_type}: ${t.subject}`,
            score_percent: Math.round((t.score / t.total_questions) * 100),
            correct_answers: t.score,
            incorrect_answers: t.total_questions - t.score,
            total_questions: t.total_questions,
            created_at: t.created_at
        }));

        // 4. Calculate Readiness for ALL exams
        const exams_readiness = allExams.map(exam => {
            const examTests = tests.filter(t => t.exam_type === exam.code);
            let avg_score = 0;
            if (examTests.length > 0) {
                const totalCorrect = examTests.reduce((sum, t) => sum + (t.score || 0), 0);
                const totalQ = examTests.reduce((sum, t) => sum + (t.total_questions || 0), 0);
                avg_score = Math.round((totalCorrect / totalQ) * 100);
            }

            return {
                exam_type: exam.code,
                name: exam.name,
                avg_score_percent: avg_score || 0, // Fallback to 0 if no tests
                total_tests: examTests.length
            };
        });

        return res.status(200).json({
            has_data: true,
            recent_tests,
            exams: exams_readiness
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

        // 2. Subject Breakdown - Get subjects from standard syllabus OR from test history
        const uniqueSubjects = new Set();
        if (examMeta && examMeta.subjects.length > 0) {
            examMeta.subjects.forEach(s => uniqueSubjects.add(s.name));
        }
        // Fallback: Add any subjects found in actual tests
        tests.forEach(t => { if(t.subject) uniqueSubjects.add(t.subject); });

        const subject_stats = Array.from(uniqueSubjects).map(subName => {
            const subTests = tests.filter(t => t.subject === subName);
            let sub_score = 0;
            if (subTests.length > 0) {
                const sCorrect = subTests.reduce((sum, t) => sum + (t.score || 0), 0);
                const sTotal = subTests.reduce((sum, t) => sum + (t.total_questions || 0), 0);
                sub_score = Math.round((sCorrect / sTotal) * 100);
            }
            return {
                name: subName,
                score_percent: sub_score || 0,
                has_data: subTests.length > 0
            };
        });

        // 3. Error Analysis
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

        // 4. Chapter Mastery
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
            subjects: subject_stats,
            time_analytics: {
                total_seconds: total_sec,
                daily_seconds: Math.round(total_sec / 30),
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
