/**
 * Production Migration CLI: Split all CBSE topics into 2-3 goals
 * 
 * Usage:
 *   # Dry run preview (no writes):
 *   node backend/scripts/split_cbse_curriculum.js --dry-run
 * 
 *   # Test a single grade / subject:
 *   node backend/scripts/split_cbse_curriculum.js --grade "Class 10" --subject "Science"
 * 
 *   # Run a full grade:
 *   node backend/scripts/split_cbse_curriculum.js --grade "Class 8"
 * 
 *   # Run for all CBSE classes and subjects:
 *   node backend/scripts/split_cbse_curriculum.js --all
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { PrismaClient } = require('../generated/prisma');

const prisma = new PrismaClient();

// Parse CLI arguments
const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}
const isDryRun = args.includes('--dry-run');
const runAll = args.includes('--all');
const gradeFilter = getArg('--grade');
const subjectFilter = getArg('--subject');
const chapterFilter = getArg('--chapter');

function chunkGoals(goals) {
  const n = goals.length;
  if (n <= 3) return [goals];
  if (n === 4) return [goals.slice(0, 2), goals.slice(2, 4)];
  if (n === 5) return [goals.slice(0, 2), goals.slice(2, 5)];
  if (n === 6) return [goals.slice(0, 3), goals.slice(3, 6)];
  if (n === 7) return [goals.slice(0, 2), goals.slice(2, 4), goals.slice(4, 7)];
  if (n === 8) return [goals.slice(0, 3), goals.slice(3, 6), goals.slice(6, 8)];

  // Fallback for >8 goals
  const chunks = [];
  let i = 0;
  while (i < n) {
    const remaining = n - i;
    const chunkSize = remaining === 4 ? 2 : Math.min(3, remaining);
    chunks.push(goals.slice(i, i + chunkSize));
    i += chunkSize;
  }
  return chunks;
}

function cleanTopicTitle(title) {
  if (!title) return '';
  return title
    .replace(/^Topic\s*\d+\s*:\s*/i, '')
    .replace(/^Concept\s*\d+\s*:\s*/i, '')
    .replace(/\s*\(Part\s*\d+\)\s*$/i, '')
    .trim();
}

async function main() {
  console.log('================================================================');
  console.log('🚀 CBSE 2–3 GOALS BATCH SPLITTER');
  console.log('================================================================');
  console.log(`Execution Mode : ${isDryRun ? 'DRY-RUN (Simulate only, no DB writes)' : 'LIVE DATABASE MIGRATION'}`);
  console.log(`Grade Filter   : ${gradeFilter || '(All)'}`);
  console.log(`Subject Filter : ${subjectFilter || '(All)'}`);
  console.log(`Chapter Filter : ${chapterFilter || '(All)'}`);
  console.log('----------------------------------------------------------------\n');

  if (!isDryRun && !runAll && !gradeFilter && !subjectFilter && !chapterFilter) {
    console.error('❌ Error: You must specify --all, --grade, --subject, --chapter, or --dry-run.');
    console.error('Example: node backend/scripts/split_cbse_curriculum.js --grade "Class 10" --subject Science');
    process.exit(1);
  }

  // 1. Fetch matching CBSE subjects
  const subjectWhere = {
    OR: [
      { board: { contains: 'CBSE', mode: 'insensitive' } },
      { board: { contains: 'Central Board', mode: 'insensitive' } }
    ]
  };
  if (gradeFilter) {
    subjectWhere.grade = { contains: gradeFilter, mode: 'insensitive' };
  }
  if (subjectFilter) {
    subjectWhere.name = { contains: subjectFilter, mode: 'insensitive' };
  }

  const subjects = await prisma.global_subjects.findMany({
    where: subjectWhere,
    select: {
      id: true,
      name: true,
      grade: true,
      board: true,
      chapters: {
        where: chapterFilter ? { id: parseInt(chapterFilter, 10) } : {},
        orderBy: { order: 'asc' },
        select: {
          id: true,
          title: true,
          order: true
        }
      }
    },
    orderBy: [
      { grade: 'asc' },
      { name: 'asc' }
    ]
  });

  const totalChapters = subjects.reduce((sum, s) => sum + s.chapters.length, 0);
  console.log(`Found ${subjects.length} subjects containing ${totalChapters} chapters to examine.\n`);

  let chaptersProcessed = 0;
  let chaptersSkipped = 0;
  let topicsCreated = 0;
  let goalsRepointed = 0;
  let failedChapters = [];

  const startTime = Date.now();

  for (const sub of subjects) {
    for (const chap of sub.chapters) {
      chaptersProcessed++;
      const tag = `[${chaptersProcessed}/${totalChapters}] [${sub.grade} - ${sub.name}]`;

      // Fetch topics and goals for this chapter
      const topics = await prisma.global_topics.findMany({
        where: { chapter_id: chap.id },
        orderBy: { order: 'asc' },
        include: {
          goals: {
            orderBy: { order: 'asc' }
          }
        }
      });

      // Check if any topic needs splitting
      const needsSplit = topics.some(t => t.goals.length > 3);
      if (!needsSplit) {
        // console.log(`${tag} "${chap.title}": Skipped (all topics <= 3 goals)`);
        chaptersSkipped++;
        continue;
      }

      console.log(`${tag} "${chap.title}": Splitting ${topics.length} topics...`);

      if (isDryRun) {
        // Calculate dry-run statistics
        let simNewTopics = 0;
        let simRepointed = 0;
        topics.forEach(t => {
          const chunks = chunkGoals(t.goals);
          if (chunks.length > 1) {
            simNewTopics += chunks.length - 1;
            for (let c = 1; c < chunks.length; c++) {
              simRepointed += chunks[c].length;
            }
          }
        });
        topicsCreated += simNewTopics;
        goalsRepointed += simRepointed;
        console.log(`   [DRY-RUN] Would create ${simNewTopics} new topics, re-point ${simRepointed} goals.`);
        continue;
      }

      // Execute live migration inside an isolated transaction for this chapter
      try {
        await prisma.$transaction(async (tx) => {
          const allResultingTopics = [];

          for (const topic of topics) {
            const chunks = chunkGoals(topic.goals);
            const baseTitle = cleanTopicTitle(topic.title);

            if (chunks.length === 1) {
              // No split needed: keep topic as is, keep in order list
              allResultingTopics.push({
                isNew: false,
                id: topic.id,
                title: baseTitle,
                content: topic.content,
                textbook_content: topic.textbook_content,
                goals: chunks[0]
              });
              continue;
            }

            // Split into multiple parts
            for (let c = 0; c < chunks.length; c++) {
              const partGoals = chunks[c];
              const partNumber = c + 1;
              const partTitle = `${baseTitle} (Part ${partNumber})`;

              if (c === 0) {
                // Keep original topic record for Part 1
                await tx.global_topics.update({
                  where: { id: topic.id },
                  data: {
                    title: `Topic ${topic.order}: ${partTitle}`
                  }
                });

                allResultingTopics.push({
                  isNew: false,
                  id: topic.id,
                  title: partTitle,
                  goals: partGoals
                });
              } else {
                // Create new topic for Part 2, Part 3, etc.
                const newTopic = await tx.global_topics.create({
                  data: {
                    chapter_id: chap.id,
                    subject_id: sub.id,
                    order: 9999, // temporary, will be re-sequenced
                    title: partTitle,
                    content: topic.content,
                    textbook_content: topic.textbook_content
                  }
                });

                topicsCreated++;
                allResultingTopics.push({
                  isNew: true,
                  id: newTopic.id,
                  title: partTitle,
                  goals: partGoals
                });
              }
            }
          }

          // Update goals and sequential topic ordering
          for (let i = 0; i < allResultingTopics.length; i++) {
            const resTopic = allResultingTopics[i];
            const newOrder = i + 1;
            const finalTitle = `Topic ${newOrder}: ${resTopic.title}`;

            // Re-order topic
            await tx.global_topics.update({
              where: { id: resTopic.id },
              data: {
                order: newOrder,
                title: finalTitle
              }
            });

            // Re-order goals and update topic_id if necessary
            for (let gIdx = 0; gIdx < resTopic.goals.length; gIdx++) {
              const goal = resTopic.goals[gIdx];
              const newGoalOrder = gIdx + 1;
              const cleanGoalTitle = goal.title.replace(/^Goal\s*\d+\s*:\s*/i, '').trim();
              const finalGoalTitle = `Goal ${newGoalOrder}: ${cleanGoalTitle}`;

              await tx.global_topic_goals.update({
                where: { id: goal.id },
                data: {
                  topic_id: resTopic.id,
                  order: newGoalOrder,
                  title: finalGoalTitle
                }
              });

              goalsRepointed++;
            }
          }
        }, { maxWait: 20000, timeout: 60000 });

        console.log(`   ✓ Completed: Chapter ${chap.id} re-sequenced to ${topics.length + (topicsCreated)} concepts.`);
      } catch (err) {
        console.error(`   ✗ Error migrating Chapter [${chap.id}] "${chap.title}":`, err.message);
        failedChapters.push({ id: chap.id, title: chap.title, error: err.message });
      }
    }
  }

  const durationSec = Math.round((Date.now() - startTime) / 1000);

  console.log('\n================================================================');
  console.log('🏁 BATCH MIGRATION FINISHED');
  console.log('================================================================');
  console.log(`Total Chapters Examined : ${chaptersProcessed}`);
  console.log(`Chapters Split          : ${chaptersProcessed - chaptersSkipped}`);
  console.log(`Chapters Skipped        : ${chaptersSkipped}`);
  console.log(`New Topics Created      : ${topicsCreated}`);
  console.log(`Goals Re-pointed        : ${goalsRepointed}`);
  console.log(`Failed Chapters         : ${failedChapters.length}`);
  console.log(`Total Time Taken        : ${durationSec}s`);

  if (failedChapters.length > 0) {
    console.log('\nFailed Chapters List:');
    failedChapters.forEach(f => console.log(`  - [${f.id}] "${f.title}": ${f.error}`));
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
