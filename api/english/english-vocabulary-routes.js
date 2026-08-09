const express = require('express');
const router = express.Router();
const prisma = require('../../lib/prisma');
const jwt = require('jsonwebtoken');

// Auth middleware
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
 * GET /api/english/vocabulary
 * Returns vocabulary items from user's actual practice sessions
 * Sources: corrections from learning_turns + key_vocabulary from practiced topics
 */
router.get('/', async (req, res) => {
  const userId = req.userId || 1;

  try {
    // 1. Get all English turns where user had corrections
    const correctedTurns = await prisma.learning_turns.findMany({
      where: {
        user_id: userId,
        subject_name: 'English',
        user_answer_raw: { not: null },
        corrected_answer: { not: null }
      },
      select: {
        user_answer_raw: true,
        corrected_answer: true,
        error_type: true,
        feedback_text: true,
        feedback_json: true,
        is_correct: true,
        score_percent: true,
        topic_title: true,
        created_at: true
      },
      orderBy: { created_at: 'desc' },
      take: 100
    }).catch(() => []);

    // 2. Extract vocabulary corrections (words that were wrong and got corrected)
    const vocabularyItems = [];
    const seen = new Set();

    for (const turn of correctedTurns) {
      if (!turn.is_correct && turn.corrected_answer && turn.user_answer_raw !== turn.corrected_answer) {
        const key = `${turn.user_answer_raw?.substring(0, 30)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        vocabularyItems.push({
          id: vocabularyItems.length + 1,
          original: turn.user_answer_raw,
          corrected: turn.corrected_answer,
          errorType: turn.error_type || 'Grammar',
          explanation: turn.feedback_text || (turn.feedback_json?.explanation) || '',
          score: turn.score_percent || 0,
          topicTitle: turn.topic_title || 'General Practice',
          practicedAt: turn.created_at
        });
      }
    }

    // 3. Get key vocabulary from practiced topics
    const practicedTopicIds = await prisma.user_english_progress.findMany({
      where: { user_id: userId },
      select: { topic_id: true }
    }).catch(() => []);

    const topicIds = practicedTopicIds.map(p => p.topic_id);
    let topicVocabulary = [];

    if (topicIds.length > 0) {
      const topics = await prisma.english_topics.findMany({
        where: { id: { in: topicIds } },
        select: {
          title: true,
          key_vocabulary: true
        }
      }).catch(() => []);

      for (const topic of topics) {
        if (topic.key_vocabulary && topic.key_vocabulary.length > 0) {
          for (const word of topic.key_vocabulary) {
            if (!seen.has(word.toLowerCase())) {
              seen.add(word.toLowerCase());
              topicVocabulary.push({
                id: vocabularyItems.length + topicVocabulary.length + 1,
                word: word,
                source: 'topic_vocabulary',
                topicTitle: topic.title
              });
            }
          }
        }
      }
    }

    return res.json({
      corrections: vocabularyItems,
      topicVocabulary: topicVocabulary,
      totalCorrections: vocabularyItems.length,
      totalVocabulary: topicVocabulary.length
    });
  } catch (err) {
    console.error('Error fetching English vocabulary:', err);
    return res.status(500).json({ error: 'Failed to fetch vocabulary' });
  }
});

module.exports = router;
