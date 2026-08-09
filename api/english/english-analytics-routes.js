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
 * GET /api/english/analytics
 * Returns per-user English-only fluency analytics from real data
 */
router.get('/', async (req, res) => {
  const userId = req.userId || 1;

  try {
    // 1. Fetch all English learning_turns for this user
    const englishTurns = await prisma.learning_turns.findMany({
      where: {
        user_id: userId,
        subject_name: 'English',
        user_answer_raw: { not: null }
      },
      select: {
        score_percent: true,
        is_correct: true,
        error_type: true,
        created_at: true
      },
      orderBy: { created_at: 'asc' }
    }).catch(() => []);

    // 2. Fetch completed topics
    const progressRecords = await prisma.user_english_progress.findMany({
      where: { user_id: userId }
    }).catch(() => []);

    const completedTopics = progressRecords.filter(p => p.is_completed).length;
    const totalTimeSpent = progressRecords.reduce((sum, p) => sum + (p.time_spent_seconds || 0), 0);

    // 3. Compute grammar accuracy from actual scores
    const totalTurns = englishTurns.length;
    const correctTurns = englishTurns.filter(t => t.is_correct).length;
    const grammarAccuracy = totalTurns > 0 ? Math.round((correctTurns / totalTurns) * 100) : 0;

    // 4. Compute average fluency score
    const avgScore = totalTurns > 0
      ? Math.round(englishTurns.reduce((s, t) => s + (t.score_percent || 0), 0) / totalTurns)
      : 0;

    // 5. Calculate daily streak
    const uniqueDays = [...new Set(
      englishTurns.map(t => {
        const d = new Date(t.created_at);
        return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      })
    )].sort().reverse();

    let dailyStreak = 0;
    const today = new Date();
    for (let i = 0; i < uniqueDays.length; i++) {
      const checkDate = new Date(today);
      checkDate.setDate(checkDate.getDate() - i);
      const checkKey = `${checkDate.getFullYear()}-${checkDate.getMonth()}-${checkDate.getDate()}`;
      if (uniqueDays.includes(checkKey)) {
        dailyStreak++;
      } else {
        break;
      }
    }

    // 6. Weekly progress (last 7 days)
    const weeklyProgress = [];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

      const dayTurns = englishTurns.filter(t => {
        const td = new Date(t.created_at);
        return `${td.getFullYear()}-${td.getMonth()}-${td.getDate()}` === dayKey;
      });

      const dayCorrect = dayTurns.filter(t => t.is_correct).length;
      const dayAccuracy = dayTurns.length > 0 ? Math.round((dayCorrect / dayTurns.length) * 100) : 0;

      weeklyProgress.push({
        day: dayNames[d.getDay()],
        minutes: dayTurns.length * 2, // Approximate: ~2 min per turn
        accuracy: dayAccuracy,
        turns: dayTurns.length
      });
    }

    // 7. Category breakdown by error_type
    const errorTypeCounts = {};
    for (const t of englishTurns) {
      const type = t.error_type || 'None';
      if (!errorTypeCounts[type]) errorTypeCounts[type] = { total: 0, correct: 0 };
      errorTypeCounts[type].total++;
      if (t.is_correct) errorTypeCounts[type].correct++;
    }

    const categoryBreakdown = Object.entries(errorTypeCounts).map(([category, data]) => ({
      category,
      score: data.total > 0 ? Math.round((data.correct / data.total) * 100) : 0,
      total: data.total
    }));

    // 8. Unique corrected words count (rough estimate of words mastered)
    const wordsMastered = correctTurns;

    return res.json({
      fluencyScore: avgScore,
      dailyStreak,
      totalPracticeMinutes: Math.round(totalTimeSpent / 60) || (totalTurns * 2),
      wordsMastered,
      grammarAccuracy,
      completedTopics,
      totalTurns,
      weeklyProgress,
      categoryBreakdown
    });
  } catch (err) {
    console.error('Error fetching English analytics:', err);
    return res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

module.exports = router;
