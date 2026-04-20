const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const prisma = require('../../lib/prisma');

/**
 * GET /api/standard-exams
 * Returns all available competitive exams
 */
router.get('/', authenticateToken, async (req, res) => {
    try {
        const exams = await prisma.standard_exams.findMany({
            orderBy: { name: 'asc' }
        });
        return res.status(200).json(exams);
    } catch (error) {
        console.error('[StandardExams] Error fetching exams:', error);
        return res.status(500).json({ error: 'Failed to fetch exams' });
    }
});

/**
 * GET /api/standard-exams/:id/subjects
 * Returns subjects for a specific exam
 */
router.get('/:id/subjects', authenticateToken, async (req, res) => {
    try {
        const subjects = await prisma.standard_subjects.findMany({
            where: { exam_id: parseInt(req.params.id) },
            orderBy: { name: 'asc' }
        });
        return res.status(200).json(subjects);
    } catch (error) {
        console.error('[StandardExams] Error fetching subjects:', error);
        return res.status(500).json({ error: 'Failed to fetch subjects' });
    }
});

/**
 * GET /api/standard-exams/subjects/:id/chapters
 * Returns chapters for a specific subject
 */
router.get('/subjects/:id/chapters', authenticateToken, async (req, res) => {
    try {
        const chapters = await prisma.standard_chapters.findMany({
            where: { subject_id: parseInt(req.params.id) },
            orderBy: { order: 'asc' }
        });
        return res.status(200).json(chapters);
    } catch (error) {
        console.error('[StandardExams] Error fetching chapters:', error);
        return res.status(500).json({ error: 'Failed to fetch chapters' });
    }
});

module.exports = router;
