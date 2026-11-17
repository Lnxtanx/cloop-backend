
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { PrismaClient } = require('../generated/prisma');

const prisma = new PrismaClient();

async function main() {
  console.log('Auditing CBSE board curriculum in database...');

  // Find all CBSE subjects
  const cbseSubjects = await prisma.global_subjects.findMany({
    where: {
      OR: [
        { board: { contains: 'CBSE', mode: 'insensitive' } },
        { board: { contains: 'Central Board', mode: 'insensitive' } }
      ]
    },
    select: {
      id: true,
      name: true,
      grade: true,
      board: true,
      _count: {
        select: { chapters: true }
      }
    },
    orderBy: [
      { grade: 'asc' },
      { name: 'asc' }
    ]
  });

  console.log(`Total CBSE Subjects: ${cbseSubjects.length}`);
  
  const subjectIds = cbseSubjects.map(s => s.id);

  // Group by grade
  const gradeSummary = {};
  cbseSubjects.forEach(s => {
    if (!gradeSummary[s.grade]) gradeSummary[s.grade] = [];
    gradeSummary[s.grade].push(`${s.name} (${s._count.chapters} ch)`);
  });
  console.log('CBSE Subjects by Grade:', JSON.stringify(gradeSummary, null, 2));

  // Count chapters, topics, goals
  const totalChapters = await prisma.global_chapters.count({
    where: { subject_id: { in: subjectIds } }
  });

  const totalTopics = await prisma.global_topics.count({
    where: { subject_id: { in: subjectIds } }
  });

  const topicsWithGoals = await prisma.global_topics.findMany({
    where: { subject_id: { in: subjectIds } },
    select: {
      id: true,
      chapter_id: true,
      subject_id: true,
      title: true,
      order: true,
      _count: {
        select: { goals: true }
      }
    }
  });

  // Goal count distribution
  const goalDistribution = {};
  let topicsWithMoreThan3Goals = 0;
  let totalGoalsInCbse = 0;

  topicsWithGoals.forEach(t => {
    const gc = t._count.goals;
    totalGoalsInCbse += gc;
    goalDistribution[gc] = (goalDistribution[gc] || 0) + 1;
    if (gc > 3) topicsWithMoreThan3Goals++;
  });

  console.log('\n--- CBSE Overall Stats ---');
  console.log(`Total Chapters: ${totalChapters}`);
  console.log(`Total Topics: ${totalTopics}`);
  console.log(`Total Goals: ${totalGoalsInCbse}`);
  console.log(`Topics with >3 goals: ${topicsWithMoreThan3Goals} (out of ${totalTopics})`);
  console.log('Goal count distribution per topic (goals count -> number of topics):');
  console.log(JSON.stringify(goalDistribution, null, 2));

}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
