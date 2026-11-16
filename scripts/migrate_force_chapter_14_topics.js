/**
 * Migration Script: Split Class 8 Science Chapter 5 ("Exploring Forces") into 14 topics
 * 
 * Caps goals to 2-3 goals per topic while preserving:
 * - 100% of all 35 existing goals (IDs 12887..12949)
 * - All 689 records in chat_goal_progress and 94 records in learning_turns
 * - All 317 paragraphs of NCERT textbook content
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const fs = require('fs');
const { PrismaClient } = require('../generated/prisma');

const prisma = new PrismaClient();

async function main() {
  console.log('🚀 Starting Class 8 Science Chapter 5 Topic Split Migration...');

  // 1. Fetch Chapter 329
  const chapter = await prisma.global_chapters.findUnique({
    where: { id: 329 },
    include: {
      topics: {
        orderBy: { order: 'asc' },
        include: { goals: { orderBy: { order: 'asc' } } }
      }
    }
  });

  if (!chapter) {
    throw new Error('Chapter 329 (Exploring Forces) not found!');
  }

  console.log(`Found Chapter: [${chapter.id}] ${chapter.title} with ${chapter.topics.length} topics.`);

  if (chapter.topics.length === 14) {
    console.log('✅ Chapter 329 already has 14 topics! Migration already applied.');
    return;
  }

  const baseIds = [3474, 3475, 3476, 3477, 3478, 3479, 3480];

  // Clean up any stray topics from aborted run
  const strayTopics = await prisma.global_topics.findMany({
    where: {
      chapter_id: 329,
      id: { notIn: baseIds }
    }
  });
  if (strayTopics.length > 0) {
    console.log(`Cleaning up ${strayTopics.length} stray topics from aborted run...`);
    for (const st of strayTopics) {
      await prisma.global_topics.delete({ where: { id: st.id } });
    }
  }

  // Load existing textbook content from seed sql
  const sqlPath = path.join(__dirname, '../data/textbooks/seeds/class-8_science_ch05.sql');
  const sqlContent = fs.readFileSync(sqlPath, 'utf8');
  const rawBlocks = sqlContent.split(/UPDATE global_topics SET textbook_content = '/);
  
  const textByTopicId = {};
  for (let i = 1; i < rawBlocks.length; i++) {
    const marker = "' WHERE id = ";
    const endIdx = rawBlocks[i].lastIndexOf(marker);
    const tId = parseInt(rawBlocks[i].substring(endIdx + marker.length).replace(/;[\s\S]*/, '').trim(), 10);
    const text = rawBlocks[i].substring(0, endIdx);
    textByTopicId[tId] = text;
  }

  // Split textbook content cleanly into pairs
  const t3474Text = textByTopicId[3474] || '';
  const t3474SplitIdx = t3474Text.indexOf('Activity 5.1: Let us explore');
  const textTopic1 = t3474SplitIdx !== -1 ? t3474Text.substring(0, t3474SplitIdx).trim() : t3474Text;
  const textTopic2 = t3474SplitIdx !== -1 ? t3474Text.substring(t3474SplitIdx).trim() : t3474Text;

  const t3475Text = textByTopicId[3475] || '';
  const t3475SplitIdx = t3475Text.indexOf('3. Pressing an inflated balloon');
  const textTopic3 = t3475SplitIdx !== -1 ? t3475Text.substring(0, t3475SplitIdx).trim() : t3475Text;
  const textTopic4 = t3475SplitIdx !== -1 ? t3475Text.substring(t3475SplitIdx).trim() : t3475Text;

  const t3476Text = textByTopicId[3476] || '';
  const t3476SplitIdx = t3476Text.indexOf('A step further');
  const textTopic5 = t3476SplitIdx !== -1 ? t3476Text.substring(0, t3476SplitIdx).trim() : t3476Text;
  const textTopic6 = t3476SplitIdx !== -1 ? t3476Text.substring(t3476SplitIdx).trim() : t3476Text;

  const t3477Text = textByTopicId[3477] || '';
  const t3477SplitIdx = t3477Text.indexOf('5.4.2 Non-contact forces');
  const textTopic7 = t3477SplitIdx !== -1 ? t3477Text.substring(0, t3477SplitIdx).trim() : t3477Text;
  const textTopic8 = t3477SplitIdx !== -1 ? t3477Text.substring(t3477SplitIdx).trim() : t3477Text;

  const t3478Text = textByTopicId[3478] || '';
  const t3478SplitIdx = t3478Text.indexOf('What is the difference between weight and mass?');
  const textTopic9 = t3478SplitIdx !== -1 ? t3478Text.substring(0, t3478SplitIdx).trim() : t3478Text;
  const textTopic10 = t3478SplitIdx !== -1 ? t3478Text.substring(t3478SplitIdx).trim() : t3478Text;

  const t3479Text = textByTopicId[3479] || '';
  const t3479SplitIdx = t3479Text.indexOf('A step further');
  const textTopic11 = t3479SplitIdx !== -1 ? t3479Text.substring(0, t3479SplitIdx).trim() : t3479Text;
  const textTopic12 = t3479SplitIdx !== -1 ? t3479Text.substring(t3479SplitIdx).trim() : t3479Text;

  const t3480Text = textByTopicId[3480] || '';
  const t3480SplitIdx = t3480Text.indexOf('Why not? Prepare some questions');
  const textTopic13 = t3480SplitIdx !== -1 ? t3480Text.substring(0, t3480SplitIdx).trim() : t3480Text;
  const textTopic14 = t3480SplitIdx !== -1 ? t3480Text.substring(t3480SplitIdx).trim() : t3480Text;

  // Execute database updates inside a Prisma transaction with extended timeout
  console.log('\nBeginning transaction with extended timeout...');
  await prisma.$transaction(async (tx) => {
    // 1. Create the 7 new sub-topics
    console.log('Creating 7 new sub-topics in global_topics...');
    const [newTopic2, newTopic4, newTopic6, newTopic8, newTopic10, newTopic12, newTopic14] = await Promise.all([
      tx.global_topics.create({
        data: {
          chapter_id: 329,
          subject_id: 44,
          order: 2,
          title: 'Topic 2: Applying Force and Changes in Motion',
          textbook_content: textTopic2,
          content: 'Understand how applying force changes the motion of objects in speed and direction.'
        }
      }),
      tx.global_topics.create({
        data: {
          chapter_id: 329,
          subject_id: 44,
          order: 4,
          title: 'Topic 4: Effects of Force on Direction and Shape',
          textbook_content: textTopic4,
          content: 'Explore how force causes shape deformation (stretching, compressing) and direction changes.'
        }
      }),
      tx.global_topics.create({
        data: {
          chapter_id: 329,
          subject_id: 44,
          order: 6,
          title: 'Topic 6: Analyzing Force Pairs and Motion Outcomes',
          textbook_content: textTopic6,
          content: 'Analyze interaction force pairs and predict motion outcomes when bodies exert forces on each other.'
        }
      }),
      tx.global_topics.create({
        data: {
          chapter_id: 329,
          subject_id: 44,
          order: 8,
          title: 'Topic 8: Non-Contact Forces: Magnetic, Electrostatic, and Gravity',
          textbook_content: textTopic8,
          content: 'Learn about non-contact forces: magnetic attraction/repulsion, electrostatic charges, and universal gravity.'
        }
      }),
      tx.global_topics.create({
        data: {
          chapter_id: 329,
          subject_id: 44,
          order: 10,
          title: 'Topic 10: Mass versus Weight and Gravitational Variation',
          textbook_content: textTopic10,
          content: 'Distinguish between constant mass and variable weight across different celestial bodies.'
        }
      }),
      tx.global_topics.create({
        data: {
          chapter_id: 329,
          subject_id: 44,
          order: 12,
          title: 'Topic 12: Floating, Sinking, and Fluid Pressure Applications',
          textbook_content: textTopic12,
          content: 'Explore density comparisons, Archimedes principle applications in ships, submarines, and buoyant force.'
        }
      }),
      tx.global_topics.create({
        data: {
          chapter_id: 329,
          subject_id: 44,
          order: 14,
          title: 'Topic 14: Forces Review: Measurement, Analysis, and Experiments',
          textbook_content: textTopic14,
          content: 'Review force measurement, analyze everyday force scenarios, and design experiments.'
        }
      })
    ]);

    console.log(`Created new topics: Topic 2 (${newTopic2.id}), Topic 4 (${newTopic4.id}), Topic 6 (${newTopic6.id}), Topic 8 (${newTopic8.id}), Topic 10 (${newTopic10.id}), Topic 12 (${newTopic12.id}), Topic 14 (${newTopic14.id})`);

    // 2. Update existing 7 topics to their new titles, orders, and content
    console.log('Updating existing 7 topics to their respective titles, orders (1, 3, 5, 7, 9, 11, 13)...');
    await Promise.all([
      tx.global_topics.update({
        where: { id: 3474 },
        data: {
          order: 1,
          title: 'Topic 1: What Is a Force: Push and Pull',
          textbook_content: textTopic1,
        }
      }),
      tx.global_topics.update({
        where: { id: 3475 },
        data: {
          order: 3,
          title: 'Topic 3: Effects of Force on Motion and Speed',
          textbook_content: textTopic3,
        }
      }),
      tx.global_topics.update({
        where: { id: 3476 },
        data: {
          order: 5,
          title: 'Topic 5: Forces as Interactions Between Objects',
          textbook_content: textTopic5,
        }
      }),
      tx.global_topics.update({
        where: { id: 3477 },
        data: {
          order: 7,
          title: 'Topic 7: Contact Forces: Muscular Force and Friction',
          textbook_content: textTopic7,
        }
      }),
      tx.global_topics.update({
        where: { id: 3478 },
        data: {
          order: 9,
          title: 'Topic 9: Weight and Its Measurement',
          textbook_content: textTopic9,
        }
      }),
      tx.global_topics.update({
        where: { id: 3479 },
        data: {
          order: 11,
          title: 'Topic 11: Buoyancy and Archimedes\' Principle',
          textbook_content: textTopic11,
        }
      }),
      tx.global_topics.update({
        where: { id: 3480 },
        data: {
          order: 13,
          title: 'Topic 13: Forces Review: Classification, Effects, and Net Force',
          textbook_content: textTopic13,
        }
      })
    ]);

    // 3. Re-point and re-order all 35 goals in parallel batches
    console.log('Re-pointing all 35 goals to target topics and updating orders...');
    await Promise.all([
      // Topic 1 (ID 3474): 2 goals
      tx.global_topic_goals.update({ where: { id: 12887 }, data: { topic_id: 3474, order: 1, title: 'Goal 1: Define force' } }),
      tx.global_topic_goals.update({ where: { id: 12888 }, data: { topic_id: 3474, order: 2, title: 'Goal 2: Identify examples of forces' } }),

      // Topic 2 (newTopic2.id): 3 goals
      tx.global_topic_goals.update({ where: { id: 12889 }, data: { topic_id: newTopic2.id, order: 1, title: 'Goal 1: Describe effects of force' } }),
      tx.global_topic_goals.update({ where: { id: 12890 }, data: { topic_id: newTopic2.id, order: 2, title: 'Goal 2: Demonstrate force application' } }),
      tx.global_topic_goals.update({ where: { id: 12891 }, data: { topic_id: newTopic2.id, order: 3, title: 'Goal 3: Analyze force scenarios' } }),

      // Topic 3 (ID 3475): 2 goals
      tx.global_topic_goals.update({ where: { id: 12896 }, data: { topic_id: 3475, order: 1, title: 'Goal 1: Identify effects of force' } }),
      tx.global_topic_goals.update({ where: { id: 12897 }, data: { topic_id: 3475, order: 2, title: 'Goal 2: Describe force-induced motion changes' } }),

      // Topic 4 (newTopic4.id): 3 goals
      tx.global_topic_goals.update({ where: { id: 12898 }, data: { topic_id: newTopic4.id, order: 1, title: 'Goal 1: Analyze force and speed/direction' } }),
      tx.global_topic_goals.update({ where: { id: 12899 }, data: { topic_id: newTopic4.id, order: 2, title: 'Goal 2: Demonstrate shape deformation' } }),
      tx.global_topic_goals.update({ where: { id: 12900 }, data: { topic_id: newTopic4.id, order: 3, title: 'Goal 3: Classify force effects' } }),

      // Topic 5 (ID 3476): 2 goals
      tx.global_topic_goals.update({ where: { id: 12905 }, data: { topic_id: 3476, order: 1, title: 'Goal 1: Identify force interactions' } }),
      tx.global_topic_goals.update({ where: { id: 12906 }, data: { topic_id: 3476, order: 2, title: 'Goal 2: Describe force pairs' } }),

      // Topic 6 (newTopic6.id): 3 goals
      tx.global_topic_goals.update({ where: { id: 12907 }, data: { topic_id: newTopic6.id, order: 1, title: 'Goal 1: Analyze force scenarios' } }),
      tx.global_topic_goals.update({ where: { id: 12908 }, data: { topic_id: newTopic6.id, order: 2, title: 'Goal 2: Demonstrate force interactions' } }),
      tx.global_topic_goals.update({ where: { id: 12909 }, data: { topic_id: newTopic6.id, order: 3, title: 'Goal 3: Predict motion outcomes' } }),

      // Topic 7 (ID 3477): 2 goals
      tx.global_topic_goals.update({ where: { id: 12915 }, data: { topic_id: 3477, order: 1, title: 'Goal 1: Identify types of forces' } }),
      tx.global_topic_goals.update({ where: { id: 12916 }, data: { topic_id: 3477, order: 2, title: 'Goal 2: Describe contact forces' } }),

      // Topic 8 (newTopic8.id): 3 goals
      tx.global_topic_goals.update({ where: { id: 12917 }, data: { topic_id: newTopic8.id, order: 1, title: 'Goal 1: Describe non-contact forces' } }),
      tx.global_topic_goals.update({ where: { id: 12918 }, data: { topic_id: newTopic8.id, order: 2, title: 'Goal 2: Classify forces in scenarios' } }),
      tx.global_topic_goals.update({ where: { id: 12919 }, data: { topic_id: newTopic8.id, order: 3, title: 'Goal 3: Compare and contrast force types' } }),

      // Topic 9 (ID 3478): 2 goals
      tx.global_topic_goals.update({ where: { id: 12925 }, data: { topic_id: 3478, order: 1, title: 'Goal 1: Define weight' } }),
      tx.global_topic_goals.update({ where: { id: 12926 }, data: { topic_id: 3478, order: 2, title: 'Goal 2: Measure weight with a spring balance' } }),

      // Topic 10 (newTopic10.id): 2 goals
      tx.global_topic_goals.update({ where: { id: 12927 }, data: { topic_id: newTopic10.id, order: 1, title: 'Goal 1: Distinguish between mass and weight' } }),
      tx.global_topic_goals.update({ where: { id: 12928 }, data: { topic_id: newTopic10.id, order: 2, title: 'Goal 2: Analyze the effect of gravity on weight' } }),

      // Topic 11 (ID 3479): 2 goals
      tx.global_topic_goals.update({ where: { id: 12934 }, data: { topic_id: 3479, order: 1, title: 'Goal 1: Define density and buoyancy' } }),
      tx.global_topic_goals.update({ where: { id: 12935 }, data: { topic_id: 3479, order: 2, title: 'Goal 2: State Archimedes\' principle' } }),

      // Topic 12 (newTopic12.id): 3 goals
      tx.global_topic_goals.update({ where: { id: 12936 }, data: { topic_id: newTopic12.id, order: 1, title: 'Goal 1: Predict floating or sinking' } }),
      tx.global_topic_goals.update({ where: { id: 12937 }, data: { topic_id: newTopic12.id, order: 2, title: 'Goal 2: Apply Archimedes\' principle to real-world examples' } }),
      tx.global_topic_goals.update({ where: { id: 12938 }, data: { topic_id: newTopic12.id, order: 3, title: 'Goal 3: Calculate buoyant force' } }),

      // Topic 13 (ID 3480): 3 goals
      tx.global_topic_goals.update({ where: { id: 12944 }, data: { topic_id: 3480, order: 1, title: 'Goal 1: Identify force types' } }),
      tx.global_topic_goals.update({ where: { id: 12945 }, data: { topic_id: 3480, order: 2, title: 'Goal 2: Describe force effects' } }),
      tx.global_topic_goals.update({ where: { id: 12946 }, data: { topic_id: 3480, order: 3, title: 'Goal 3: Calculate net force' } }),

      // Topic 14 (newTopic14.id): 3 goals
      tx.global_topic_goals.update({ where: { id: 12947 }, data: { topic_id: newTopic14.id, order: 1, title: 'Goal 1: Demonstrate force measurement' } }),
      tx.global_topic_goals.update({ where: { id: 12948 }, data: { topic_id: newTopic14.id, order: 2, title: 'Goal 2: Analyze force scenarios' } }),
      tx.global_topic_goals.update({ where: { id: 12949 }, data: { topic_id: newTopic14.id, order: 3, title: 'Goal 3: Design force experiment' } })
    ]);

    console.log('✅ Transaction operations completed successfully.');
  }, { maxWait: 30000, timeout: 120000 });

  // Verification step
  console.log('\n🔎 Verifying migration results on live database...');
  const updatedTopics = await prisma.global_topics.findMany({
    where: { chapter_id: 329 },
    orderBy: { order: 'asc' },
    include: {
      goals: { orderBy: { order: 'asc' } }
    }
  });

  console.log(`\n======================================================`);
  console.log(`Total Topics in Chapter 329: ${updatedTopics.length}`);
  console.log(`======================================================`);
  
  let totalGoals = 0;
  for (const t of updatedTopics) {
    totalGoals += t.goals.length;
    console.log(`Topic [${t.id}] Order ${t.order}: "${t.title}" -> ${t.goals.length} goals (Textbook: ${t.textbook_content?.length || 0} chars)`);
    t.goals.forEach(g => {
      console.log(`   Goal [${g.id}] Order ${g.order}: "${g.title}"`);
    });
  }

  console.log(`\nTotal Goals across all 14 topics: ${totalGoals}`);
  if (totalGoals === 35 && updatedTopics.length === 14) {
    console.log('🎉 VERIFICATION SUCCESS: All 14 topics created and all 35 goals preserved with 2-3 goals per topic!');
  } else {
    console.error(`⚠️ VERIFICATION WARNING: Expected 14 topics and 35 goals, got ${updatedTopics.length} topics and ${totalGoals} goals.`);
  }

  // Verify chat_goal_progress and learning_turns
  const goalIds = [
    12887,12888,12889,12890,12891,
    12896,12897,12898,12899,12900,
    12905,12906,12907,12908,12909,
    12915,12916,12917,12918,12919,
    12925,12926,12927,12928,
    12934,12935,12936,12937,12938,
    12944,12945,12946,12947,12948,12949
  ];
  const progressCount = await prisma.chat_goal_progress.count({ where: { goal_id: { in: goalIds } } });
  const turnsCount = await prisma.learning_turns.count({ where: { goal_id: { in: goalIds } } });
  console.log(`\nRelations verification:`);
  console.log(`  chat_goal_progress count: ${progressCount} (Expected: 689)`);
  console.log(`  learning_turns count: ${turnsCount} (Expected: 94)`);
}

main()
  .catch((err) => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
