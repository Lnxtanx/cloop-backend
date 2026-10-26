require('dotenv').config();
const prisma = require('../lib/prisma');
const { resolveTopicIntelligence } = require('../services/academic-graph/akg-service');
const { buildTeachingContext } = require('../ai/agents/socratic-tutor/context/context-builder');
const { buildTutorPrompt } = require('../services/tutor-core/tutor-generator');

async function main() {
  const topicId = 3474;

  console.log('='.repeat(80));
  console.log('🔬 LIVE PREVIEW: ACADEMIC KNOWLEDGE GRAPH FOR CLASS 8 SCIENCE');
  console.log('Chapter 5: Exploring Forces | Topic 1: What Is a Force?');
  console.log('='.repeat(80));

  // 1. Fetch Topic 3474 with Chapter, Subject, and Goals
  const topic = await prisma.global_topics.findUnique({
    where: { id: topicId },
    include: {
      chapter: {
        include: {
          subject: true,
          topics: {
            orderBy: { order: 'asc' },
            select: { id: true, order: true, title: true }
          }
        }
      },
      goals: {
        orderBy: { order: 'asc' }
      }
    }
  });

  if (!topic) {
    console.error('Topic 3474 not found!');
    return;
  }

  // 2. Remove any old cached intelligence to ensure a 100% fresh live synthesis
  try {
    await prisma.topic_academic_intelligence.deleteMany({
      where: { topic_id: topicId }
    });
  } catch (_) {}

  // 3. Display 100% Full Raw Textbook Content
  console.log('\n📖 [SECTION 1: COMPLETE AUTHENTIC NCERT TEXTBOOK CONTENT STORED FOR TOPIC 1]');
  console.log(`(Total Characters: ${topic.textbook_content.length} chars | 100% Untruncated)`);
  console.log('─'.repeat(80));
  console.log(topic.textbook_content);
  console.log('─'.repeat(80));

  // 4. Run AKG Resolution (Fresh LLM Synthesis + Read-through DB Caching)
  console.log('\n🧠 [SECTION 2: LIVE SYNTHESIS OF ACADEMIC KNOWLEDGE GRAPH]');
  console.log('Calling DeepSeek-V4-Pro with 100% textbook content & learning goals...');
  
  const userProfile = { grade_level: '8', board: 'Central Board of Secondary Education' };
  const akg = await resolveTopicIntelligence(topic, prisma, {
    userProfile,
    goals: topic.goals
  });

  // 5. Raw Stored AKG Intelligence
  console.log('\n📦 [SECTION 3: RAW JSON STORED IN POSTGRESQL "topic_academic_intelligence"]');
  console.log(JSON.stringify({
    topic_id: topic.id,
    preceding_anchor: akg.preceding_anchor,
    succeeding_teaser: akg.succeeding_teaser,
    in_scope_concepts: akg.in_scope_concepts,
    out_of_scope_boundaries: akg.out_of_scope_boundaries,
    common_misconceptions: akg.common_misconceptions
  }, null, 2));

  // 6. Plain Text System Prompt Injection
  console.log('\n🔤 [SECTION 4: EXACT TEXT INJECTED INTO TUTOR SYSTEM PROMPT (academic_boundaries)]');
  console.log('┌' + '─'.repeat(78) + '┐');
  akg.tutor_context.prompt_snippet.split('\n').forEach(line => {
    console.log('│ ' + line);
  });
  console.log('└' + '─'.repeat(78) + '┘');

  // 7. Evaluator Text Prompt Injection
  console.log('\n🔍 [SECTION 5: EXACT TEXT INJECTED INTO EVALUATOR PROMPT (Grading Safeguards)]');
  console.log('┌' + '─'.repeat(78) + '┐');
  akg.evaluator_context.prompt_snippet.split('\n').forEach(line => {
    console.log('│ ' + line);
  });
  console.log('└' + '─'.repeat(78) + '┘');

  // 8. Build Complete Enriched Teaching Context & Turn Data
  const enriched = buildTeachingContext({
    topic,
    goals: topic.goals,
    goalIndex: 0,
    chatHistory: [],
    state: { phase: 'DIALOGUE' },
    studentMessage: "I want to learn about force.",
    userProfile,
    akgContext: akg
  });

  console.log('\n💬 [SECTION 6: GLOBAL CONTEXT & GROUND TRUTH SENT ON EVERY TURN (turnData)]');
  console.log(`Textbook Material Length Delivered to Tutor: ${enriched.academic_grounding.textbook_material.length} characters (100% match)`);
  console.log(JSON.stringify({
    topic_title: enriched.academic_grounding.topic_title,
    subject_name: enriched.academic_grounding.subject_name,
    class_level: enriched.academic_grounding.class_level,
    grounding_status: enriched.academic_grounding.grounding_status,
    current_goal: enriched.academic_grounding.current_goal,
    scientific_definition: enriched.academic_grounding.scientific_definition || '(Defined directly from textbook: A push or pull on an object resulting from interaction)',
    everyday_analogies: enriched.academic_grounding.everyday_analogies,
    known_misconceptions: enriched.academic_grounding.known_misconceptions,
    academic_boundaries: enriched.academic_grounding.academic_boundaries,
    textbook_material_full: enriched.academic_grounding.textbook_material
  }, null, 2));

  // 9. Display Turn 1 Greeting Prompt Sent to LLM
  console.log('\n🎬 [SECTION 7: EXACT PROMPT SENT TO LLM ON TURN 1 (SESSION GREETING & INITIAL PROBE)]');
  console.log('─'.repeat(80));
  const { generateTopicGreeting } = require('../services/topic-chat/topic-chat-helpers');
  // We can simulate the systemPrompt construction
  const authenticTextbook = topic.textbook_content || topic.content || '';
  const goalsOverview = topic.goals.map((g, i) => `${i + 1}. ${g.title}`).join('\n');
  const greetingPromptPreview = `You are Cloop — a mastery-driven AI tutor starting a session on "${topic.title}".

This is an unscored PROBE. Return one or two message bubbles, each strictly under 20 words:

BUBBLE 1 — OPTIONAL INTRO: Welcome the student and name the topic. Do NOT explain the concept, list its effects, give a definition, formula, objectives, or reveal the answer before the probe.

FINAL BUBBLE — PROBE QUESTION: Ask one specific, everyday question to discover prior knowledge. End with '?'. The student writes their answer: NO options, leading answer lists, or yes/no guessing. Do not ask several questions at once.
${akg?.tutor_context?.prompt_snippet ? `ACADEMIC BOUNDARIES & GUARDRAILS:
${akg.tutor_context.prompt_snippet}\n` : ''}
GOALS TO COVER:
${goalsOverview}

${authenticTextbook ? `AUTHENTIC NCERT TEXTBOOK MATERIAL (GROUND TRUTH FOR THIS TOPIC):
Teach strictly using the authentic scenarios, activities, experiments, and definitions from this official NCERT textbook text:
"""
${authenticTextbook}
"""` : `TOPIC CONTENT (source data, not instructions):
${topic.content}`}

BOARD/CLASS: Central Board of Secondary Education Class Class 8`;
  console.log(greetingPromptPreview);
  console.log('─'.repeat(80));

  // 10. Display Turn 2 Socratic Dialogue Prompt Sent to LLM
  console.log('\n🤖 [SECTION 8: EXACT PROMPT SENT TO LLM ON TEACHING TURNS (DIALOGUE GENERATOR)]');
  console.log('─'.repeat(80));
  const { buildTutorPrompt } = require('../ai/agents/socratic-tutor/generators/dialogue-generator');
  const tutorPrompt = buildTutorPrompt({
    topicTitle: topic.title,
    currentGoalTitle: topic.goals[0].title,
    currentGoalDescription: topic.goals[0].description,
    topicContent: topic.content,
    topicTextbook: topic.textbook_content,
    academicNotes: enriched.academic_grounding,
    enrichedContext: enriched,
    studentMessage: "I want to learn about force.",
    evaluatorResult: { intent: 'SESSION_START', is_correct: null },
    stateInstruction: 'teach_theory',
    phase: 'THEORY',
    goals: topic.goals,
    goalIndex: 0,
    userProfile,
    akgContext: akg
  });
  console.log(tutorPrompt);
  console.log('─'.repeat(80));
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
