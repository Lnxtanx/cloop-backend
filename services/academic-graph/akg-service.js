const { buildAkgContext } = require('./akg-context-builder');
const { synthesizeTopicIntelligence, buildFallbackIntelligence } = require('./akg-synthesizer');

/**
 * Resolve academic intelligence for a topic using a Just-In-Time read-through cache:
 * 1. Check topic_academic_intelligence table for topic_id.
 * 2. If present -> return built context directly.
 * 3. If missing -> query sequence context (preceding/succeeding topic), synthesize via LLM,
 *    save to topic_academic_intelligence table, and return built context.
 */
async function resolveTopicIntelligence(topicOrId, prismaClient = null, options = {}) {
  let prisma = prismaClient;
  if (!prisma) {
    try {
      prisma = require('../../lib/prisma');
    } catch {
      prisma = null;
    }
  }

  const topicId = typeof topicOrId === 'object' && topicOrId ? topicOrId.id : parseInt(topicOrId, 10);
  if (!topicId || isNaN(topicId)) {
    return null;
  }

  // 1. Read-through cache check
  try {
    if (prisma?.topic_academic_intelligence?.findUnique) {
      const cached = await prisma.topic_academic_intelligence.findUnique({
        where: { topic_id: topicId },
      });
      if (cached) {
        return buildAkgContext(cached);
      }
    }
  } catch (readErr) {
    console.warn(`[AKG Service] Cache lookup error for topic ${topicId}:`, readErr.message);
  }

  // 2. Cache miss: Fetch surrounding curriculum context
  let topicRecord = typeof topicOrId === 'object' && topicOrId ? topicOrId : null;
  const needsFetch = !topicRecord || !topicRecord.chapter?.topics ||
    typeof topicRecord.chapter?.order !== 'number' || typeof topicRecord.order !== 'number';
  try {
    if (needsFetch && prisma?.global_topics?.findUnique) {
      const fullTopic = await prisma.global_topics.findUnique({
        where: { id: topicId },
        include: {
          chapter: {
            include: {
              subject: { select: { id: true, name: true } },
              topics: {
                orderBy: { order: 'asc' },
                select: { id: true, title: true, order: true },
              },
            },
          },
        },
      });
      if (fullTopic) {
        topicRecord = fullTopic;
      }
    }
  } catch (topicFetchErr) {
    console.warn(`[AKG Service] Topic fetch error for topic ${topicId}:`, topicFetchErr.message);
  }

  const currentTopic = topicRecord || { id: topicId, title: `Topic ${topicId}` };
  let precedingTopic = null;
  let succeedingTopic = null;

  // Determine preceding and succeeding topics from chapter topics array
  if (topicRecord?.chapter?.topics && Array.isArray(topicRecord.chapter.topics)) {
    const sorted = topicRecord.chapter.topics;
    const currentOrder = typeof topicRecord.order === 'number'
      ? topicRecord.order
      : sorted.find(t => t.id === topicId)?.order;
    if (typeof currentOrder === 'number' && Number.isInteger(currentOrder)) {
      precedingTopic = sorted.find(t => t.order === currentOrder - 1) || null;
      succeedingTopic = sorted.find(t => t.order === currentOrder + 1) || null;
    }
  }

  const chapterOrder = typeof topicRecord?.chapter?.order === 'number' && Number.isInteger(topicRecord.chapter.order)
    ? topicRecord.chapter.order
    : null;
  const topicOrder = typeof topicRecord?.order === 'number' && Number.isInteger(topicRecord.order)
    ? topicRecord.order
    : null;
  const subjectId = topicRecord?.chapter?.subject_id;

  // If opening topic of chapter, look up last topic of previous chapter
  if (!precedingTopic && subjectId && chapterOrder !== null && chapterOrder > 1 && topicOrder !== null && topicOrder <= 1) {
    try {
      if (prisma?.global_chapters?.findFirst) {
        const prevChapter = await prisma.global_chapters.findFirst({
          where: {
            subject_id: subjectId,
            order: chapterOrder - 1,
          },
          include: {
            topics: {
              orderBy: { order: 'desc' },
              take: 1,
              select: { id: true, title: true, order: true },
            },
          },
        });
        if (prevChapter?.topics?.length) {
          precedingTopic = prevChapter.topics[0];
        }
      }
    } catch (prevErr) {
      console.warn('[AKG Service] Preceding chapter lookup skipped:', prevErr.message);
    }
  }

  // If last topic of chapter, look up first topic of next chapter
  if (!succeedingTopic && subjectId && chapterOrder !== null && prisma?.global_chapters?.findFirst) {
    try {
      const nextChapter = await prisma.global_chapters.findFirst({
        where: {
          subject_id: subjectId,
          order: chapterOrder + 1,
        },
        include: {
          topics: {
            orderBy: { order: 'asc' },
            take: 1,
            select: { id: true, title: true, order: true },
          },
        },
      });
      if (nextChapter?.topics?.length) {
        succeedingTopic = nextChapter.topics[0];
      }
    } catch (nextErr) {
      console.warn('[AKG Service] Succeeding chapter lookup skipped:', nextErr.message);
    }
  }

  // 3. Synthesize intelligence
  const classLevel = options.classLevel ||
    (options.userProfile?.grade_level ? `Class ${options.userProfile.grade_level}` : 'Class 10');
  const board = options.board || options.userProfile?.board || 'CBSE';

  let synthesized = null;
  try {
    synthesized = await synthesizeTopicIntelligence({
      topic: currentTopic,
      chapter: topicRecord?.chapter || null,
      precedingTopic,
      succeedingTopic,
      classLevel,
      board,
    });
  } catch (synthErr) {
    console.warn(`[AKG Service] Synthesis failed for topic ${topicId}:`, synthErr.message);
    synthesized = buildFallbackIntelligence({
      topic: currentTopic,
      chapter: topicRecord?.chapter || null,
      precedingTopic,
      succeedingTopic,
      classLevel,
    });
  }

  // 4. Persist to database (JIT caching)
  if (prisma?.topic_academic_intelligence?.upsert) {
    try {
      const saved = await prisma.topic_academic_intelligence.upsert({
        where: { topic_id: topicId },
        update: {
          preceding_anchor: synthesized.preceding_anchor,
          succeeding_teaser: synthesized.succeeding_teaser,
          in_scope_concepts: synthesized.in_scope_concepts,
          out_of_scope_boundaries: synthesized.out_of_scope_boundaries,
          common_misconceptions: synthesized.common_misconceptions,
          updated_at: new Date(),
        },
        create: {
          topic_id: topicId,
          preceding_anchor: synthesized.preceding_anchor,
          succeeding_teaser: synthesized.succeeding_teaser,
          in_scope_concepts: synthesized.in_scope_concepts,
          out_of_scope_boundaries: synthesized.out_of_scope_boundaries,
          common_misconceptions: synthesized.common_misconceptions,
        },
      });
      return buildAkgContext(saved);
    } catch (saveErr) {
      console.warn(`[AKG Service] JIT persistence failed for topic ${topicId} (non-fatal):`, saveErr.message);
    }
  }

  return buildAkgContext(synthesized);
}

module.exports = {
  resolveTopicIntelligence,
  buildAkgContext,
};
