const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const prisma = require('../../lib/prisma');
const { generatePracticeQuestions } = require('../../services/ai/practice-test');

/**
 * POST /api/practice-tests/generate
 * Generates a 15-question MCQ test for a specific exam and subject
 */
router.post('/generate', authenticateToken, async (req, res) => {
    // Increase timeout for AI generation (5 minutes)
    req.setTimeout(300000);
    res.setTimeout(300000);
    
    const { exam_type, subject, chapter_ids } = req.body; // chapter_ids: [number]
    const user_id = req.user.user_id;

    if (!exam_type || !subject) {
        return res.status(400).json({ error: 'Exam type and subject are required' });
    }

    try {
        let chapterTitles = [];
        if (chapter_ids && Array.isArray(chapter_ids) && chapter_ids.length > 0) {
            const chapters = await prisma.standard_chapters.findMany({
                where: { id: { in: chapter_ids.map(id => parseInt(id)) } }
            });
            chapterTitles = chapters.map(c => c.title);
        }

        const questions = await generatePracticeQuestions(exam_type, subject, chapterTitles);

        // Save the test session and questions to the database
        const practiceTest = await prisma.practice_tests.create({
            data: {
                user_id: user_id,
                exam_type: exam_type,
                subject: subject,
                total_questions: questions.length,
                status: 'in_progress'
            }
        });

        // Link chapters if provided
        if (chapter_ids && chapter_ids.length > 0) {
            await prisma.practice_test_chapters.createMany({
                data: chapter_ids.map(cid => ({
                    test_id: practiceTest.id,
                    chapter_id: parseInt(cid)
                }))
            });
        }

        // Bulk insert questions linked to this test
        const savedQuestions = await prisma.practice_questions.createMany({
            data: questions.map(q => ({
                test_id: practiceTest.id,
                question_text: q.question_text,
                options: q.options,
                correct_answer: q.correct_answer,
                explanation: q.explanation
            }))
        });

        // Fetch back questions for the user (without correct_answer to prevent cheating)
        const userQuestions = await prisma.practice_questions.findMany({
            where: { test_id: practiceTest.id },
            select: {
                id: true,
                question_text: true,
                options: true
            }
        });

        return res.status(201).json({
            test_id: practiceTest.id,
            exam_type: exam_type,
            subject: subject,
            questions: userQuestions,
            time_limit_sec: 600 // 10 minutes
        });
    } catch (error) {
        console.error('Error generating practice test:', error);
        return res.status(500).json({ error: 'Failed to generate practice test' });
    }
});

/**
 * POST /api/practice-tests/:id/submit
 * Submits user answers and evaluates the final result
 */
router.post('/:id/submit', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { answers, time_taken_sec } = req.body; // answers: [{ question_id: number, user_answer: string }]
    const user_id = req.user.user_id;

    try {
        const practiceTest = await prisma.practice_tests.findFirst({
            where: { id: parseInt(id), user_id: user_id }
        });

        if (!practiceTest) {
            return res.status(404).json({ error: 'Practice test not found' });
        }

        if (practiceTest.status === 'completed') {
            return res.status(400).json({ error: 'Test has already been submitted' });
        }

        const dbQuestions = await prisma.practice_questions.findMany({
            where: { test_id: parseInt(id) }
        });

        let totalCorrect = 0;
        const evaluationDetails = [];

        // Evaluate each question
        for (const q of dbQuestions) {
            const userAnswer = answers.find(a => a.question_id === q.id)?.user_answer || null;
            const isCorrect = userAnswer === q.correct_answer;
            if (isCorrect) totalCorrect++;

            evaluationDetails.push({
                id: q.id,
                question_text: q.question_text,
                options: q.options,
                correct_answer: q.correct_answer,
                user_answer: userAnswer,
                is_correct: isCorrect,
                explanation: q.explanation
            });

            // Update user answer in database
            await prisma.practice_questions.update({
                where: { id: q.id },
                data: {
                    user_answer: userAnswer,
                    is_correct: isCorrect
                }
            });
        }

        // Finalize test in database
        const score = totalCorrect;
        const updatedTest = await prisma.practice_tests.update({
            where: { id: parseInt(id) },
            data: {
                score: score,
                time_taken_sec: time_taken_sec || 0,
                status: 'completed',
                completed_at: new Date()
            }
        });

        return res.status(200).json({
            score: score,
            total_questions: practiceTest.total_questions,
            time_taken_sec: time_taken_sec || 0,
            questions: evaluationDetails
        });
    } catch (error) {
        console.error('Error submitting practice test:', error);
        return res.status(500).json({ error: 'Failed to submit practice test' });
    }
});

/**
 * GET /api/practice-tests/history
 * Returns the history of tests taken by the user
 */
router.get('/history', authenticateToken, async (req, res) => {
    const user_id = req.user.user_id;
    console.log(`[PracticeHistory] 📋 Fetching history for user: ${user_id}`);

    try {
        const history = await prisma.practice_tests.findMany({
            where: { user_id: user_id },
            orderBy: { created_at: 'desc' }
        });

        console.log(`[PracticeHistory] ✅ Found ${history.length} records`);
        return res.status(200).json(history);
    } catch (error) {
        console.error('[PracticeHistory] ❌ Error:', error);
        return res.status(500).json({ error: 'Failed to fetch test history' });
    }
});

/**
 * GET /api/practice-tests/:id
 * Fetches the full details of a specific test (including questions and answers)
 */
router.get('/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const user_id = req.user.user_id;

    try {
        const practiceTest = await prisma.practice_tests.findFirst({
            where: { id: parseInt(id), user_id: user_id },
            include: {
                questions: {
                    orderBy: { id: 'asc' }
                }
            }
        });

        if (!practiceTest) {
            return res.status(404).json({ error: 'Practice test not found' });
        }

        return res.status(200).json({
            id: practiceTest.id,
            exam_type: practiceTest.exam_type,
            subject: practiceTest.subject,
            score: practiceTest.score,
            total_questions: practiceTest.total_questions,
            time_taken_sec: practiceTest.time_taken_sec,
            status: practiceTest.status,
            completed_at: practiceTest.completed_at,
            questions: practiceTest.questions.map(q => ({
                id: q.id,
                question_text: q.question_text,
                options: q.options,
                correct_answer: q.correct_answer,
                user_answer: q.user_answer,
                is_correct: q.is_correct,
                explanation: q.explanation
            }))
        });
    } catch (error) {
        console.error('Error fetching test details:', error);
        return res.status(500).json({ error: 'Failed to fetch test details' });
    }
});

module.exports = router;
