const express = require('express');
const router = express.Router();
const prisma = require('../../lib/prisma');
const jwt = require('jsonwebtoken');

// Middleware to extract user from JWT token (optional fallback)
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
      req.userId = decoded.userId || decoded.id || decoded.user_id;
    } catch {
      req.userId = null;
    }
  }
  next();
}

router.use(authMiddleware);

/**
 * GET /api/english/subjects
 * Returns all global English subjects with chapter & topic counts
 */
router.get('/subjects', async (req, res) => {
  const userId = req.userId || 1;
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

    // Fetch all user scenario progress records
    const userProgress = await prisma.user_english_progress.findMany({
      where: { user_id: userId },
      select: { topic_id: true, is_completed: true, completion_percent: true }
    }).catch(() => []);

    const progressMap = new Map();
    userProgress.forEach(p => {
      progressMap.set(p.topic_id, {
        is_completed: p.is_completed || false,
        percent: Number(p.completion_percent) || (p.is_completed ? 100 : 0)
      });
    });

    const formatted = subjects.map(s => {
      const allScenarios = s.chapters.flatMap(c => c.topics);
      const totalCount = allScenarios.length;
      
      let completedCount = 0;
      let totalPercentSum = 0;

      allScenarios.forEach(sc => {
        const prog = progressMap.get(sc.id);
        if (prog) {
          if (prog.is_completed) completedCount++;
          totalPercentSum += Math.min(100, Math.max(0, prog.percent));
        }
      });

      const progressPercent = totalCount > 0 ? Math.round(totalPercentSum / totalCount) : 0;

      return {
        id: s.id,
        code: s.code,
        title: s.title,
        description: s.description,
        category: s.category || "ACADEMIC",
        icon: s.icon,
        totalChapters: s.chapters.length,
        totalScenarios: totalCount,
        completedScenarios: completedCount,
        progressPercent: progressPercent,
        scenarios: allScenarios.map(sc => ({
          id: String(sc.id),
          title: sc.title,
          difficulty: sc.difficulty,
          estimatedMinutes: sc.estimated_minutes,
          is_completed: progressMap.get(sc.id)?.is_completed || false
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
 * Returns all chapters and topics under a specific English subject with completion status
 */
router.get('/subjects/:subjectId/chapters', async (req, res) => {
  const { subjectId } = req.params;
  const userId = req.userId || 1;

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

    // Fetch user progress for all topics under this subject
    const userProgress = await prisma.user_english_progress.findMany({
      where: { user_id: userId }
    }).catch(() => []);

    const progressMap = new Map();
    userProgress.forEach(p => progressMap.set(p.topic_id, p));

    const formattedChapters = subject.chapters.map(ch => ({
      id: ch.id,
      title: ch.title,
      description: ch.description,
      badgeLevel: ch.badge_level,
      scenarios: ch.topics.map(tp => {
        const prog = progressMap.get(tp.id);
        return {
          id: String(tp.id),
          title: tp.title,
          description: tp.description,
          category: tp.category,
          difficulty: tp.difficulty,
          estimatedMinutes: tp.estimated_minutes,
          keyVocabulary: tp.key_vocabulary || [],
          systemPromptGoal: tp.system_prompt_goal,
          is_completed: prog?.is_completed || false,
          completion_percent: prog ? Number(prog.completion_percent) : 0,
          goals: tp.goals.map(g => ({
            id: g.id,
            title: g.title,
            description: g.description
          }))
        };
      })
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
  const userId = req.userId || 1;

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

    const prog = await prisma.user_english_progress.findUnique({
      where: { user_id_topic_id: { user_id: userId, topic_id: Number(topicId) } }
    }).catch(() => null);

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
        is_completed: prog?.is_completed || false,
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
