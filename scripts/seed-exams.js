const prisma = require('../lib/prisma');
const { invokeModel, extractJson } = require('../services/ai/bedrock-client');

const EXAMS = [
  {
    code: 'NEET',
    name: 'NEET (UG)',
    description: 'National Eligibility cum Entrance Test for medical aspirants.',
    subjects: ['Biology', 'Physics', 'Chemistry']
  },
  {
    code: 'JEE_MAIN',
    name: 'IIT-JEE (Main)',
    description: 'Joint Entrance Examination for engineering aspirants.',
    subjects: ['Mathematics', 'Physics', 'Chemistry']
  },
  {
    code: 'KCET',
    name: 'KCET',
    description: 'Karnataka Common Entrance Test.',
    subjects: ['Mathematics', 'Physics', 'Chemistry', 'Biology']
  }
];

async function generateChaptersForSubject(examName, subjectName) {
  const prompt = `You are an expert education consultant. 
  Provide a list of all official major chapters/topics in the current syllabus for ${examName} ${subjectName}.
  Return ONLY a JSON object with a "chapters" array of strings.
  Example: {"chapters": ["Cell Biology", "Genetics", "Plant Physiology"]}
  Ensure the list is comprehensive for competitive exam preparation.`;

  try {
    const response = await invokeModel(prompt, [{ role: 'user', content: `Generate ${examName} ${subjectName} chapters.` }]);
    const parsed = extractJson(response);
    return parsed?.chapters || [];
  } catch (error) {
    console.error(`Error generating chapters for ${examName} ${subjectName}:`, error.message);
    return [];
  }
}

async function seed() {
  console.log('🚀 Starting Competitive Exam Seeding...');

  for (const examData of EXAMS) {
    console.log(`\n📦 Processing Exam: ${examData.name}`);
    
    // 1. Upsert Exam
    const exam = await prisma.standard_exams.upsert({
      where: { code: examData.code },
      update: { name: examData.name, description: examData.description },
      create: { code: examData.code, name: examData.name, description: examData.description }
    });

    for (const subName of examData.subjects) {
      console.log(`  - Subject: ${subName}`);
      
      // 2. Upsert Subject
      let subject = await prisma.standard_subjects.findFirst({
        where: { exam_id: exam.id, name: subName }
      });

      if (!subject) {
        subject = await prisma.standard_subjects.create({
          data: { exam_id: exam.id, name: subName }
        });
      }

      // 3. Check if chapters exist, if not generate them
      const chapterCount = await prisma.standard_chapters.count({
        where: { subject_id: subject.id }
      });

      if (chapterCount === 0) {
        console.log(`    💡 Generating syllabus for ${subName} via AI...`);
        const chapterTitles = await generateChaptersForSubject(exam.name, subName);
        
        if (chapterTitles.length > 0) {
          await prisma.standard_chapters.createMany({
            data: chapterTitles.map((title, index) => ({
              subject_id: subject.id,
              title: title,
              order: index + 1
            }))
          });
          console.log(`    ✅ Created ${chapterTitles.length} chapters.`);
        } else {
          console.log(`    ⚠️ No chapters generated.`);
        }
      } else {
        console.log(`    ⏭️ Chapters already exist, skipping generation.`);
      }
    }
  }

  console.log('\n✨ Seeding completed successfully!');
}

seed()
  .catch(e => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
