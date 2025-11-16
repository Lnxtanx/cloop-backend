const OpenAI = require('openai');

let openai = null;
try {
  openai = new OpenAI({ apiKey: process.env.API_KEY_OPENAI });
} catch (err) {
  // Do not throw here to allow module to be required in environments without API key
  console.warn('OpenAI client not initialized. Set API_KEY_OPENAI to enable API calls.');
  openai = null;
}

/**
 * Truncate content to save tokens while keeping essential info
 * @param {string} content - Full content text
 * @param {number} maxLength - Maximum character length (default: 200)
 * @returns {string} Truncated content
 */
function truncateContent(content, maxLength = 200) {
  if (!content) return '';
  if (content.length <= maxLength) return content;
  return content.substring(0, maxLength) + '...';
}

/**
 * Generate chapters for a specific subject, grade, and board
 */
async function generateChapters(gradeLevel, board, subject) {
  if (!openai) throw new Error('OpenAI client not initialized. Set API_KEY_OPENAI environment variable.');
  const prompt = `You are an educational content expert. Generate a comprehensive list of chapters for the following:
- Grade/Class: ${gradeLevel}
- Board: ${board}
- Subject: ${subject}

Please provide a JSON array of chapters with the following structure:
[
  {
    "title": "Chapter title",
    "content": "Brief description of what this chapter covers"
  }
]

Make sure the chapters follow the official ${board} curriculum for ${gradeLevel} ${subject}.
Return ONLY the JSON array, no additional text.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo', // Cost-effective for structured content generation
      messages: [
        {
          role: 'system',
          content: 'You are an expert educational content generator that creates structured curriculum content. Always respond with valid JSON only.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: 1500, // Reduced from 2000 - sufficient for chapter list
    });

    const content = response.choices[0].message.content.trim();
    // Remove markdown code blocks if present
    const jsonContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const chapters = JSON.parse(jsonContent);
    
    // Log token usage for monitoring
    console.log(`✓ Chapters generated | Tokens: ${response.usage.total_tokens} (input: ${response.usage.prompt_tokens}, output: ${response.usage.completion_tokens})`);
    
    return chapters;
  } catch (error) {
    console.error('Error generating chapters:', error);
    throw new Error(`Failed to generate chapters: ${error.message}`);
  }
}

/**
 * Generate topics/exercises for a specific chapter
 */
async function generateTopics(gradeLevel, board, subject, chapterTitle, chapterContent) {
  if (!openai) throw new Error('OpenAI client not initialized. Set API_KEY_OPENAI environment variable.');
  // Truncate chapter content to save tokens - we only need a brief summary
  const chapterSummary = truncateContent(chapterContent, 150);
  
  const prompt = `You are an educational content expert. Generate a comprehensive list of topics and exercises for the following chapter:
- Grade/Class: ${gradeLevel}
- Board: ${board}
- Subject: ${subject}
- Chapter: ${chapterTitle}
- Chapter Summary: ${chapterSummary}

Please provide a JSON array of topics/exercises with the following structure:
[
  {
    "title": "Topic/Exercise title",
    "content": "Brief description of the topic (2-3 sentences)"
  }
]

Make sure the topics follow the official ${board} curriculum and cover all important aspects of this chapter.
Return ONLY the JSON array, no additional text.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo', // Cost-effective for structured content generation
      messages: [
        {
          role: 'system',
          content: 'You are an expert educational content generator that creates structured curriculum content. Always respond with valid JSON only.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: 2000, // Reduced from 3000 - sufficient for topic list
    });

    const content = response.choices[0].message.content.trim();
    // Remove markdown code blocks if present
    const jsonContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const topics = JSON.parse(jsonContent);
    
    // Log token usage for monitoring
    console.log(`✓ Topics generated | Tokens: ${response.usage.total_tokens} (input: ${response.usage.prompt_tokens}, output: ${response.usage.completion_tokens})`);
    
    return topics;
  } catch (error) {
    console.error('Error generating topics:', error);
    throw new Error(`Failed to generate topics: ${error.message}`);
  }
}

/**
 * Generate clear, measurable learning goals for a topic
 * Returns: { goals: [ { title: string, description: string }, ... ] }
 */
async function generateTopicGoals(topicTitle, topicContent) {
  if (!openai) throw new Error('OpenAI client not initialized. Set API_KEY_OPENAI environment variable.');
  const topicSummary = truncateContent(topicContent, 250);

  const prompt = `You are an expert curriculum designer. For the following topic, generate a list of clear, measurable learning goals (minimum 4). Use specific action verbs (e.g., identify, describe, analyze, demonstrate). Provide the response as a JSON object with the shape:\n{ "goals": [ { "title": "Goal title (short)", "description": "One-sentence measurable description" }, ... ] }\n\nTopic: ${topicTitle}\nSummary: ${topicSummary}\n\nReturn ONLY valid JSON.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'You are an expert educational content generator that creates clear, measurable learning objectives. Always respond with valid JSON only.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: 800,
    });

    const content = response.choices[0].message.content.trim();
    const jsonContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    let parsed = null;
    try {
      parsed = JSON.parse(jsonContent);
    } catch (err) {
      // If parsing fails, try to recover by extracting the first JSON-looking substring
      const match = jsonContent.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw err;
      }
    }

    // Normalise to { goals: [...] }
    let goalsArray = [];
    if (Array.isArray(parsed)) {
      goalsArray = parsed;
    } else if (parsed && Array.isArray(parsed.goals)) {
      goalsArray = parsed.goals;
    } else if (parsed && parsed.items && Array.isArray(parsed.items)) {
      goalsArray = parsed.items;
    }

    // Ensure each goal has title & description
    goalsArray = goalsArray.map(g => ({
      title: (g.title || g.name || '').toString().trim(),
      description: (g.description || g.desc || '').toString().trim(),
    })).filter(g => g.title || g.description);

    console.log(`✓ Goals generated | Tokens: ${response.usage.total_tokens} (input: ${response.usage.prompt_tokens}, output: ${response.usage.completion_tokens})`);

    return { goals: goalsArray };
  } catch (error) {
    console.error('Error generating topic goals:', error);
    throw new Error(`Failed to generate topic goals: ${error.message}`);
  }
}

// Topic chat conversation functions moved to topic_chat.js service
// This file now focuses only on content generation (chapters and topics)

module.exports = {
  generateChapters,
  generateTopics,
  generateTopicGoals,
};
