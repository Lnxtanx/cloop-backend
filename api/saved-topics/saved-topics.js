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
                topic: {
                    include: {
                        chapter: {
                            include: {
                                subject: true
                            }
                        }
                    }
                },
            },
            orderBy: {
                created_at: 'desc',
            },
        });

        // Format to preserve compatibility with existing frontend expectations
        const formatted = savedTopics.map(st => ({
            id: st.id,
            user_id: st.user_id,
            topic_id: st.topic_id,
            created_at: st.created_at,
            topics: {
                id: st.topic?.id,
                title: st.topic?.title,
                content: st.topic?.content,
                chapter_id: st.topic?.chapter_id,
                subject_id: st.topic?.subject_id,
                chapters: st.topic?.chapter ? {
                    id: st.topic.chapter.id,
                    title: st.topic.chapter.title
                } : null,
                subjects: st.topic?.chapter?.subject ? {
                    id: st.topic.chapter.subject.id,
                    name: st.topic.chapter.subject.name
                } : null
            }
        }));

        res.json(formatted);
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
