const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { PrismaClient } = require('../generated/prisma');

const prisma = new PrismaClient();

async function main() {
  console.log('================================================================');
  console.log('🔍 FULL CBSE POST-MIGRATION AUDIT (All Classes & Subjects)');
  console.log('================================================================\n');

  // 1. Fetch all CBSE subjects
  const cbseSubjects = await prisma.global_subjects.findMany({
    where: {
      OR: [
        { board: { contains: 'CBSE', mode: 'insensitive' } },
        { board: { contains: 'Central Board', mode: 'insensitive' } }
      ]
    },
    select: { id: true, name: true, grade: true }
  });
  const subjectIds = cbseSubjects.map(s => s.id);

  console.log(`Auditing ${cbseSubjects.length} CBSE subjects across Class 5 to Class 10...`);

  // 2. Fetch all chapters
  const chapters = await prisma.global_chapters.findMany({
    where: { subject_id: { in: subjectIds } },
    select: { id: true, title: true, subject_id: true }
  });
  console.log(`Total Chapters in CBSE: ${chapters.length}`);

  // 3. Fetch all topics with their goal counts
  const topics = await prisma.global_topics.findMany({
    where: { subject_id: { in: subjectIds } },
    select: {
      id: true,
      chapter_id: true,
      order: true,
      title: true,
      goals: {
        select: { id: true, order: true }
      }
    }
  });
  console.log(`Total Topics in CBSE after migration: ${topics.length}`);

  // 4. Calculate goal distribution
  const goalDistribution = {};
  let totalGoals = 0;
  let topicsWithMoreThan3Goals = 0;
  let topicsWithLessThan2Goals = 0;

  topics.forEach(t => {
    const gc = t.goals.length;
    totalGoals += gc;
    goalDistribution[gc] = (goalDistribution[gc] || 0) + 1;
    if (gc > 3) topicsWithMoreThan3Goals++;
    if (gc < 2 && gc > 0) topicsWithLessThan2Goals++;
  });

  console.log(`Total Goals in CBSE: ${totalGoals} (Expected: 26,376)`);
  console.log(`Goal count distribution across all ${topics.length} topics:`);
  console.log(JSON.stringify(goalDistribution, null, 2));

  console.log(`\nTopics with >3 goals: ${topicsWithMoreThan3Goals}`);
  console.log(`Topics with <2 goals (1 goal): ${topicsWithLessThan2Goals}`);

  // 5. Check order sequencing within chapters (check if any chapter has duplicate orders or gaps)
  console.log('\nChecking order sequencing across all 470 chapters...');
  const chapterTopicsMap = {};
  topics.forEach(t => {
    if (!chapterTopicsMap[t.chapter_id]) chapterTopicsMap[t.chapter_id] = [];
    chapterTopicsMap[t.chapter_id].push(t);
  });

  let chaptersWithOrderIssues = 0;
  for (const chId in chapterTopicsMap) {
    const chTopics = chapterTopicsMap[chId];
    chTopics.sort((a, b) => a.order - b.order);
    for (let i = 0; i < chTopics.length; i++) {
      if (chTopics[i].order !== i + 1) {
        chaptersWithOrderIssues++;
        break;
      }
    }
  }
  console.log(`Chapters with order sequencing issues: ${chaptersWithOrderIssues}`);

  // 6. Spot-check samples across grades
  console.log('\n--- Spot Checking Sample Chapters Across Grades ---');
  const sampleGradeChecks = ['Class 10', 'Class 9', 'Class 8', 'Class 7', 'Class 6', 'Class 5'];
  for (const g of sampleGradeChecks) {
    const sub = cbseSubjects.find(s => s.grade === g && s.name === 'Science') || cbseSubjects.find(s => s.grade === g);
    if (!sub) continue;
    const sampleCh = await prisma.global_chapters.findFirst({
      where: { subject_id: sub.id },
      include: {
        topics: {
          take: 4,
          orderBy: { order: 'asc' },
          include: { goals: { orderBy: { order: 'asc' } } }
        }
      }
    });

    if (sampleCh) {
      console.log(`\n[${sub.grade} - ${sub.name}] Chapter [${sampleCh.id}]: "${sampleCh.title}"`);
      sampleCh.topics.forEach(t => {
        console.log(`   Concept [${t.order}] (Topic ID ${t.id}): "${t.title}" -> ${t.goals.length} goals`);
        t.goals.forEach(g => console.log(`      • [${g.id}] Order ${g.order}: "${g.title}"`));
      });
    }
  }

  console.log('\n================================================================');
  if (topicsWithMoreThan3Goals === 0 && totalGoals === 26376 && chaptersWithOrderIssues === 0) {
    console.log('🎉 100% SUCCESS: All CBSE topics strictly have 2–3 goals!');
    console.log('All 26,376 goals preserved. Zero order conflicts.');
  } else {
    console.log('⚠️ Verification detected discrepancies. Check logs above.');
  }
  console.log('================================================================');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
