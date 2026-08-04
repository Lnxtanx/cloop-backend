/**
 * Standalone AI Curriculum Generator Script for English Learning
 * Uses DeepSeek AI client to populate the PostgreSQL database once with global English chapters & topics.
 * 
 * Usage:
 *   node scripts/seed-english-curriculum.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const prisma = require('../lib/prisma');
const { invokeModel, extractJson } = require('../services/ai/deepseek-client');

// ============================================================================
// AI PROMPT TEMPLATES (Customize prompts here as needed)
// ============================================================================

const PROMPTS = {
  // System instruction for curriculum generation
  systemPrompt: `You are a world-class English Fluency Curriculum Specialist and AI Content Architect. 
Always respond with valid JSON only.`,

  // Chapter generation prompt per subject
  chapterPrompt: (subjectTitle, subjectDesc) => `
You are designing a structured English learning course for: "${subjectTitle}".
Description: "${subjectDesc}"

Generate 4 comprehensive chapters for this subject.
Return ONLY a valid JSON object with the key "chapters", containing an array of objects:
{
  "chapters": [
    {
      "title": "Chapter Title",
      "description": "2-sentence overview of what learners will master in this chapter.",
      "badge_level": "Intermediate" // Beginner, Intermediate, or Advanced
    }
  ]
}
`,

  // Topic/Scenario generation prompt per chapter
  topicPrompt: (subjectTitle, chapterTitle, chapterDesc) => `
Subject: "${subjectTitle}"
Chapter: "${chapterTitle}"
Chapter Summary: "${chapterDesc}"

Generate 4 realistic conversation scenarios / practice topics for this chapter.
Return ONLY a valid JSON object with the key "topics", containing an array of objects:
{
  "topics": [
    {
      "title": "Scenario / Topic Title",
      "description": "Detailed description of the interactive roleplay scenario.",
      "category": "Practical Speaking",
      "difficulty": "Intermediate", // Beginner, Intermediate, or Advanced
      "estimated_minutes": 10,
      "key_vocabulary": ["Word1", "Word2", "Word3", "Word4"],
      "system_prompt_goal": "Act as [Persona] guiding the user through [Scenario Goal]. Provide live feedback on grammar, tone, and vocabulary.",
      "goals": [
        { "title": "Goal 1", "description": "Specific measurable objective 1" },
        { "title": "Goal 2", "description": "Specific measurable objective 2" }
      ]
    }
  ]
}
`
};

// ============================================================================
// 4 CORE FIXED ENGLISH SUBJECTS
// ============================================================================

const CORE_ENGLISH_SUBJECTS = [
  {
    code: "mod-business",
    title: "Business & Professional English",
    description: "Master workplace communication, salary negotiations, project presentations, and executive email etiquette.",
    category: "ACADEMIC",
    icon: "Briefcase",
    order: 1
  },
  {
    code: "mod-interview",
    title: "Job Interview Preparation",
    description: "Practice behavioral interview questions, STAR method responses, technical role pitches, and salary negotiations.",
    category: "ACADEMIC",
    icon: "Target",
    order: 2
  },
  {
    code: "mod-everyday",
    title: "Everyday Social & Small Talk",
    description: "Build confidence ordering at restaurants, making friends at social events, and chatting with colleagues.",
    category: "ACADEMIC",
    icon: "MessageSquare",
    order: 3
  },
  {
    code: "mod-grammar",
    title: "Grammar & Sentence Enhancement",
    description: "Eliminate common grammatical errors, master complex tenses, and use natural idioms correctly.",
    category: "ACADEMIC",
    icon: "BookOpen",
    order: 4
  }
];

async function generateCurriculum() {
  console.log('🚀 Starting Global English Curriculum Generation Pipeline via DeepSeek AI...\n');

  for (const subjectData of CORE_ENGLISH_SUBJECTS) {
    console.log(`\n==================================================`);
    console.log(`📌 Processing Subject: ${subjectData.title}`);
    console.log(`==================================================`);

    // 1. Upsert Subject in DB
    const subject = await prisma.english_subjects.upsert({
      where: { code: subjectData.code },
      update: {
        title: subjectData.title,
        description: subjectData.description,
        category: subjectData.category,
        icon: subjectData.icon,
        order: subjectData.order
      },
      create: {
        code: subjectData.code,
        title: subjectData.title,
        description: subjectData.description,
        category: subjectData.category,
        icon: subjectData.icon,
        order: subjectData.order
      }
    });

    console.log(`✓ Subject upserted in DB (ID: ${subject.id})`);

    // 2. Generate Chapters using DeepSeek AI
    try {
      console.log(`🤖 Generating Chapters via DeepSeek for "${subject.title}"...`);
      const chapterPromptText = PROMPTS.chapterPrompt(subject.title, subject.description);
      const chapterResponse = await invokeModel(
        PROMPTS.systemPrompt,
        [{ role: 'user', content: chapterPromptText }],
        { temperature: 0.7, featureArea: 'english_curriculum', subFeature: 'chapter_gen' }
      );

      const parsedChapters = extractJson(chapterResponse);
      const chaptersList = parsedChapters?.chapters || (Array.isArray(parsedChapters) ? parsedChapters : []);

      if (!chaptersList || chaptersList.length === 0) {
        console.error(`⚠️ No chapters returned by AI for subject "${subject.title}". Skipping.`);
        continue;
      }

      console.log(`✓ Generated ${chaptersList.length} chapters.`);

      // 3. Process each Chapter and generate Topics/Scenarios
      let chapOrder = 1;
      for (const chData of chaptersList) {
        const chapter = await prisma.english_chapters.create({
          data: {
            subject_id: subject.id,
            title: chData.title || `Chapter ${chapOrder}`,
            description: chData.description || "",
            badge_level: chData.badge_level || "Intermediate",
            order: chapOrder++
          }
        });

        console.log(`  └─ Created Chapter: "${chapter.title}" (ID: ${chapter.id})`);

        // 4. Generate Topics/Scenarios for this Chapter via AI
        console.log(`     🤖 Generating Scenarios for Chapter "${chapter.title}"...`);
        const topicPromptText = PROMPTS.topicPrompt(subject.title, chapter.title, chapter.description || "");
        const topicResponse = await invokeModel(
          PROMPTS.systemPrompt,
          [{ role: 'user', content: topicPromptText }],
          { temperature: 0.7, featureArea: 'english_curriculum', subFeature: 'topic_gen' }
        );

        const parsedTopics = extractJson(topicResponse);
        const topicsList = parsedTopics?.topics || (Array.isArray(parsedTopics) ? parsedTopics : []);

        if (!topicsList || topicsList.length === 0) {
          console.log(`     ⚠️ No topics returned for chapter "${chapter.title}".`);
          continue;
        }

        let topOrder = 1;
        for (const tData of topicsList) {
          const topic = await prisma.english_topics.create({
            data: {
              chapter_id: chapter.id,
              title: tData.title || `Scenario ${topOrder}`,
              description: tData.description || "",
              category: tData.category || "Practical Speaking",
              difficulty: tData.difficulty || "Intermediate",
              estimated_minutes: tData.estimated_minutes || 10,
              key_vocabulary: Array.isArray(tData.key_vocabulary) ? tData.key_vocabulary : [],
              system_prompt_goal: tData.system_prompt_goal || `Practice conversation for ${tData.title}`,
              order: topOrder++
            }
          });

          console.log(`        └─ Created Scenario: "${topic.title}" (ID: ${topic.id})`);

          // 5. Save Topic Goals
          if (Array.isArray(tData.goals) && tData.goals.length > 0) {
            let goalOrder = 1;
            for (const gData of tData.goals) {
              await prisma.english_topic_goals.create({
                data: {
                  topic_id: topic.id,
                  title: gData.title || `Goal ${goalOrder}`,
                  description: gData.description || "",
                  order: goalOrder++
                }
              });
            }
            console.log(`           ✓ Saved ${tData.goals.length} goals for scenario.`);
          }
        }
      }
    } catch (err) {
      console.error(`❌ Error generating curriculum for subject "${subject.title}":`, err.message);
    }
  }

  console.log(`\n🎉 Global English Curriculum Generation Pipeline Finished Successfully!`);
  process.exit(0);
}

// Execute generator
generateCurriculum().catch((err) => {
  console.error("Fatal Error in Curriculum Generation:", err);
  process.exit(1);
});
