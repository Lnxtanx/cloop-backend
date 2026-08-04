const express = require('express');
const router = express.Router();
const prisma = require('../../lib/prisma');

/**
 * GET /api/english/subjects
 * Returns all global English subjects with chapter & topic counts
 */
router.get('/subjects', async (req, res) => {
  try {
    const subjects = await prisma.english_subjects.findMany({
      orderBy: { order: 'asc' },
      include: {
        chapters: {
          select: {
            id: true,
            title: true,
            topics: {
              select: {
                id: true,
                title: true,
                difficulty: true,
                estimated_minutes: true
              }
            }
          }
        }
      }
    });

    // Format response for frontend
    const formatted = subjects.map(s => {
      const allScenarios = s.chapters.flatMap(c => c.topics);
      return {
        id: s.id,
        code: s.code,
        title: s.title,
        description: s.description,
        category: s.category || "ACADEMIC",
        icon: s.icon,
        totalChapters: s.chapters.length,
        totalScenarios: allScenarios.length,
        scenarios: allScenarios.map(sc => ({
          id: String(sc.id),
          title: sc.title,
          difficulty: sc.difficulty,
          estimatedMinutes: sc.estimated_minutes
        }))
      };
    });

    return res.json({ subjects: formatted });
  } catch (err) {
    console.error('Error fetching global English subjects:', err);
    return res.status(500).json({ error: 'Failed to fetch English subjects' });
  }
});

/**
 * GET /api/english/subjects/:subjectId/chapters
 * Returns all chapters and topics under a specific English subject
 */
router.get('/subjects/:subjectId/chapters', async (req, res) => {
  const { subjectId } = req.params;
  try {
    const isCode = isNaN(Number(subjectId));
    const subject = await prisma.english_subjects.findFirst({
      where: isCode ? { code: subjectId } : { id: Number(subjectId) },
      include: {
        chapters: {
          orderBy: { order: 'asc' },
          include: {
            topics: {
              orderBy: { order: 'asc' },
              include: {
                goals: {
                  orderBy: { order: 'asc' }
                }
              }
            }
          }
        }
      }
    });

    if (!subject) {
      return res.status(404).json({ error: 'English Subject not found' });
    }

    const formattedChapters = subject.chapters.map(ch => ({
      id: ch.id,
      title: ch.title,
      description: ch.description,
      badgeLevel: ch.badge_level,
      scenarios: ch.topics.map(tp => ({
        id: String(tp.id),
        title: tp.title,
        description: tp.description,
        category: tp.category,
        difficulty: tp.difficulty,
        estimatedMinutes: tp.estimated_minutes,
        keyVocabulary: tp.key_vocabulary || [],
        systemPromptGoal: tp.system_prompt_goal,
        goals: tp.goals.map(g => ({
          id: g.id,
          title: g.title,
          description: g.description
        }))
      }))
    }));

    return res.json({
      subject: {
        id: subject.id,
        code: subject.code,
        title: subject.title,
        description: subject.description,
        category: subject.category
      },
      chapters: formattedChapters
    });
  } catch (err) {
    console.error('Error fetching English chapters:', err);
    return res.status(500).json({ error: 'Failed to fetch English chapters' });
  }
});

/**
 * GET /api/english/topics/:topicId
 * Returns single topic/scenario details, goals, vocabulary, and system prompt
 */
router.get('/topics/:topicId', async (req, res) => {
  const { topicId } = req.params;
  try {
    const topic = await prisma.english_topics.findUnique({
      where: { id: Number(topicId) },
      include: {
        chapter: {
          include: {
            subject: true
          }
        },
        goals: {
          orderBy: { order: 'asc' }
        }
      }
    });

    if (!topic) {
      return res.status(404).json({ error: 'Topic scenario not found' });
    }

    return res.json({
      scenario: {
        id: String(topic.id),
        title: topic.title,
        description: topic.description,
        category: topic.category,
        difficulty: topic.difficulty,
        estimatedMinutes: topic.estimated_minutes,
        keyVocabulary: topic.key_vocabulary || [],
        systemPromptGoal: topic.system_prompt_goal,
        subjectTitle: topic.chapter?.subject?.title,
        chapterTitle: topic.chapter?.title,
        goals: topic.goals.map(g => ({
          id: g.id,
          title: g.title,
          description: g.description
        }))
      }
    });
  } catch (err) {
    console.error('Error fetching English topic:', err);
    return res.status(500).json({ error: 'Failed to fetch topic details' });
  }
});

module.exports = router;
