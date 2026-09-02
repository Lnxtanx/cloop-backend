/**
 * Standalone CLI Test Runner for AI Tutor with Knowledge Graph v8.0 & v5.0
 * Run turn-by-turn AI tutor sessions directly in terminal using Excel graph context.
 *
 * Usage:
 *   node scripts/test-graph-tutor.js
 *   node scripts/test-graph-tutor.js --class=X --chapter="Light"
 *   node scripts/test-graph-tutor.js --class=X --chapter="Chemical Reactions"
 */

const readline = require('readline');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env'), override: true });

const { loadChapterGraph, getAvailableScienceChapters } = require('../services/graph-loader');
const { buildSystemPrompt, analyzeChatHistory } = require('../services/topic-chat/topic-chat-helpers');
const { invokeModel, extractJson } = require('../services/ai/deepseek-client');
const { searchYouTube, searchImages } = require('../services/media-search');

// Terminal colors for clean CLI UX
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  bgBlue: '\x1b[44m',
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach(arg => {
    if (arg.startsWith('--')) {
      const [key, val] = arg.slice(2).split('=');
      args[key] = val ? val.replace(/^["']|["']$/g, '') : true;
    }
  });
  return args;
}

async function selectChapterInteractive(args) {
  const available = getAvailableScienceChapters();
  if (available.length === 0) {
    throw new Error('No Science chapters found in Knowledge Graph Excel file.');
  }

  let selectedClass = args.class || 'X';
  let selectedChapter = args.chapter || null;

  if (selectedChapter) {
    const match = available.find(c =>
      (!selectedClass || c.classLevel.toLowerCase() === selectedClass.toLowerCase()) &&
      c.chapter.toLowerCase().includes(selectedChapter.toLowerCase())
    );
    if (match) return match;
    console.log(`${colors.yellow}⚠️ Chapter '${selectedChapter}' not found directly. Showing available chapters:${colors.reset}`);
  }

  console.log(`\n${colors.cyan}${colors.bright}====================================================${colors.reset}`);
  console.log(`${colors.cyan}${colors.bright} 📚 CLOOP KNOWLEDGE GRAPH AI TUTOR - TEST RUNNER 📚 ${colors.reset}`);
  console.log(`${colors.cyan}${colors.bright}====================================================${colors.reset}\n`);

  console.log(`${colors.yellow}Available Science Chapters in Knowledge Graph:${colors.reset}`);
  available.forEach((item, idx) => {
    console.log(`  ${colors.bright}${idx + 1}.${colors.reset} Class ${item.classLevel} [${item.subject}] - ${colors.green}${item.chapter}${colors.reset} (${item.conceptCount} concepts)`);
  });

  const choiceStr = await askQuestion(`\nSelect a chapter number (1-${available.length}) [Default: 1]: `);
  const choiceNum = parseInt(choiceStr.trim(), 10) || 1;
  const chosen = available[Math.min(Math.max(choiceNum - 1, 0), available.length - 1)];

  return chosen;
}

async function runSession() {
  try {
    const args = parseArgs();
    const selection = await selectChapterInteractive(args);

    console.log(`\n${colors.cyan}Loading Knowledge Graph for Chapter: "${selection.chapter}" (Class ${selection.classLevel})...${colors.reset}`);
    const graphData = loadChapterGraph(selection.classLevel, selection.chapter);

    console.log(`\n${colors.green}✅ Loaded Knowledge Graph:${colors.reset}`);
    console.log(`   - Title: ${colors.bright}${graphData.title}${colors.reset}`);
    console.log(`   - Learning Goals/Concepts: ${colors.bright}${graphData.topicGoals.length}${colors.reset}`);
    console.log(`   - Prerequisite Links: ${colors.bright}${graphData.prerequisites.length}${colors.reset}`);
    console.log(`   - Error Taxonomy Tags: ${colors.bright}${graphData.errorTaxonomy.length}${colors.reset}`);
    console.log(`   - Remediation Policies: ${colors.bright}${graphData.remediationPolicies.length}${colors.reset}\n`);

    console.log(`${colors.dim}Type your answers to converse with the AI Tutor. Commands: /goals, /skip, /exit${colors.reset}\n`);

    const chatHistory = [];
    let currentGoalIndex = 0;

    while (currentGoalIndex < graphData.topicGoals.length) {
      const currentGoal = graphData.topicGoals[currentGoalIndex];
      const completedGoalsCount = graphData.topicGoals.filter(g => g.chat_goal_progress[0].is_completed).length;
      const totalQuestionsTarget = graphData.topicGoals.length * 2;

      const {
        userResponses,
        allQuestions,
        questionsAsked,
        lastAIMessage,
        lastQuestion,
        hasAskedQuestion
      } = analyzeChatHistory(chatHistory);

      const isFirstMessage = chatHistory.length === 0;
      const lastUserMsgObj = chatHistory.filter(m => m.sender === 'user').pop();
      const lastUserMessageStr = lastUserMsgObj ? lastUserMsgObj.message : 'Hello, I am ready to start!';

      const shouldEndSession = completedGoalsCount >= graphData.topicGoals.length;

      // 1. Build System Prompt with Knowledge Graph context
      const systemPrompt = buildSystemPrompt(
        graphData.title,
        `Concepts: ${graphData.concepts.map(c => c['Concept']).join(', ')}`,
        graphData.topicGoals,
        currentGoal,
        completedGoalsCount,
        totalQuestionsTarget,
        questionsAsked,
        userResponses,
        allQuestions,
        lastQuestion,
        hasAskedQuestion,
        shouldEndSession,
        isFirstMessage,
        lastUserMessageStr,
        lastAIMessage
      );

      // Prepare Messages array for LLM
      const formattedChatHistory = chatHistory.slice(-10).map(m => ({
        role: m.sender === 'ai' ? 'assistant' : 'user',
        content: m.message
      }));

      if (formattedChatHistory.length === 0) {
        formattedChatHistory.push({
          role: 'user',
          content: `Let's start the session for ${graphData.title}.`
        });
      }

      console.log(`${colors.dim}🤖 [DeepSeek] Generating AI Tutor turn...${colors.reset}`);
      const rawLlmOutput = await invokeModel(systemPrompt, formattedChatHistory);
      const aiResponse = extractJson(rawLlmOutput);

      if (!aiResponse) {
        console.log(`${colors.red}❌ Could not parse JSON from model output:${colors.reset}\n${rawLlmOutput}`);
        break;
      }

      // 2. Parse AI Messages
      const textMessages = (aiResponse.messages || []).filter(m => m.message_type === 'text' || !m.message_type);
      const aiResponseText = textMessages.map(m => m.message).join('\n\n');

      console.log(`\n${colors.cyan}${colors.bright}🤖 Cloop AI Tutor:${colors.reset}`);
      console.log(`${aiResponseText}\n`);

      // Display evaluation metrics if model evaluated answer
      if (aiResponse.evaluation) {
        const ev = aiResponse.evaluation;
        console.log(`${colors.dim}📊 [Evaluation] Status: ${ev.understanding_status || 'N/A'} | Clarity Score: ${ev.concept_clarity_score ?? 'N/A'} | Mode: ${ev.question_mode || 'concept'} | Tech: ${ev.technique || 'N/A'}${colors.reset}`);
      }

      if (aiResponse.user_correction?.feedback) {
        const fb = aiResponse.user_correction.feedback;
        const color = fb.is_correct ? colors.green : colors.yellow;
        console.log(`${color}📝 [Feedback] Correct: ${fb.is_correct} | Score: ${fb.score_percent}% | Error Type: ${fb.error_type || 'None'}${colors.reset}`);
      }

      // Display Mermaid / Text Diagrams if generated
      if (aiResponse.mermaid_diagram) {
        console.log(`\n${colors.magenta}📐 [Mermaid Diagram Generated]: ${aiResponse.mermaid_diagram.title || 'Diagram'}${colors.reset}`);
        console.log(`${colors.dim}${aiResponse.mermaid_diagram.code}${colors.reset}\n`);
      }

      if (aiResponse.text_diagram) {
        console.log(`\n${colors.magenta}📊 [Text Diagram]: ${aiResponse.text_diagram.title || 'Table'}${colors.reset}`);
        console.log(`${colors.dim}${aiResponse.text_diagram.code}${colors.reset}\n`);
      }

      // Proactive / Remedial Media Fetching
      const fb = aiResponse.user_correction?.feedback;
      const isFailing = fb && fb.is_correct === false && (typeof fb.score_percent !== 'number' || fb.score_percent < 60);

      if (aiResponse.youtube_video?.search_query) {
        console.log(`${colors.blue}🎬 [YouTube Video Suggested]: "${aiResponse.youtube_video.search_query}"${colors.reset}`);
        const vids = await searchYouTube(aiResponse.youtube_video.search_query, 1);
        if (vids.length > 0) {
          console.log(`   🔗 Watch: ${vids[0].title} (${vids[0].url})`);
        }
      } else if (isFailing) {
        console.log(`${colors.blue}🎬 [Remedial Video Search for Struggling Student]: "${currentGoal.raw_concept}"${colors.reset}`);
        const vids = await searchYouTube(`${currentGoal.raw_concept} ${graphData.title}`, 1);
        if (vids.length > 0) {
          console.log(`   🔗 Remedial Video: ${vids[0].title} (${vids[0].url})`);
        }
      }

      if (aiResponse.google_image?.search_query) {
        console.log(`${colors.blue}🖼️ [Google Image Suggested]: "${aiResponse.google_image.search_query}"${colors.reset}`);
      }

      // Record AI turn in chat history
      chatHistory.push({
        sender: 'ai',
        message: aiResponseText,
        message_type: 'text'
      });

      // Goal Progress Update Logic
      const goalProg = currentGoal.chat_goal_progress[0];
      goalProg.num_questions += 1;
      if (fb?.is_correct) {
        goalProg.num_correct += 1;
      }

      // Advance goal if accuracy is high or enough questions answered
      if (goalProg.num_questions >= 3 || (fb && fb.score_percent >= 80)) {
        goalProg.is_completed = true;
        console.log(`${colors.green}🎉 [Goal Completed]: ${currentGoal.title}${colors.reset}\n`);
        currentGoalIndex += 1;
      }

      if (currentGoalIndex >= graphData.topicGoals.length) {
        console.log(`${colors.green}${colors.bright}🎉 Session Complete! All ${graphData.topicGoals.length} Knowledge Graph learning goals achieved! 🎉${colors.reset}`);
        break;
      }

      // Prompt user input
      const userInput = await askQuestion(`${colors.bright}💬 You: ${colors.reset}`);
      const trimmed = userInput.trim();

      if (trimmed === '/exit' || trimmed === 'exit') {
        console.log(`\n${colors.yellow}Session ended by user. Good job studying! 👋${colors.reset}`);
        break;
      }

      if (trimmed === '/goals') {
        console.log(`\n${colors.yellow}🎯 Learning Goals Status:${colors.reset}`);
        graphData.topicGoals.forEach((g, i) => {
          const prog = g.chat_goal_progress[0];
          const st = prog.is_completed ? '✅ COMPLETED' : i === currentGoalIndex ? '⏳ ACTIVE' : '⭕ NOT STARTED';
          console.log(`   ${i + 1}. ${g.title} [${st}] (${prog.num_questions} questions)`);
        });
        console.log('');
        continue;
      }

      if (trimmed === '/skip') {
        console.log(`${colors.yellow}⏩ Skipping to next goal...${colors.reset}`);
        goalProg.is_completed = true;
        currentGoalIndex += 1;
        continue;
      }

      chatHistory.push({
        sender: 'user',
        message: trimmed,
        message_type: 'text'
      });
    }

    rl.close();
  } catch (err) {
    console.error(`${colors.red}❌ Error running graph tutor session:${colors.reset}`, err);
    rl.close();
  }
}

runSession();
