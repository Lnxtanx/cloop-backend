const express = require('express');
const prisma = require('../../lib/prisma');

const router = express.Router();

// Get saved topics for a user
router.get('/', async (req, res) => {
    try {
        const userId = parseInt(req.query.userId);

        if (!userId || isNaN(userId)) {
            return res.status(400).json({ error: 'Valid userId is required' });
        }

        const savedTopics = await prisma.saved_topics.findMany({
            where: {
                user_id: userId,
            },
            include: {
                topics: {
                    include: {
                        subjects: true,
                        chapters: true,
                    }
                },
            },
            orderBy: {
                created_at: 'desc',
            },
        });

        res.json(savedTopics);
    } catch (error) {
        console.error('Error fetching saved topics:', error);
        res.status(500).json({ error: 'Failed to fetch saved topics' });
    }
});

// Save a topic
router.post('/save', async (req, res) => {
    try {
        const { userId, topicId } = req.body;

        if (!userId || !topicId) {
            return res.status(400).json({ error: 'userId and topicId are required' });
        }

        const validUserId = parseInt(userId);
        const validTopicId = parseInt(topicId);

        const savedTopic = await prisma.saved_topics.create({
            data: {
                user_id: validUserId,
                topic_id: validTopicId,
            },
        });

        res.status(201).json(savedTopic);
    } catch (error) {
        // Check for unique constraint violation (P2002 in Prisma)
        if (error.code === 'P2002') {
            return res.status(409).json({ error: 'Topic already saved' });
        }
        console.error('Error saving topic:', error);
        res.status(500).json({ error: 'Failed to save topic' });
    }
});

// Unsave a topic
router.delete('/unsave', async (req, res) => {
    try {
        const { userId, topicId } = req.body;

        if (!userId || !topicId) {
            return res.status(400).json({ error: 'userId and topicId are required' });
        }

        const validUserId = parseInt(userId);
        const validTopicId = parseInt(topicId);

        // Using deleteMany to handle cases where it might not exist without throwing P2025
        await prisma.saved_topics.deleteMany({
            where: {
                user_id: validUserId,
                topic_id: validTopicId,
            },
        });

        res.json({ message: 'Topic unsaved successfully' });
    } catch (error) {
        console.error('Error unsaving topic:', error);
        res.status(500).json({ error: 'Failed to unsave topic' });
    }
});

module.exports = router;
