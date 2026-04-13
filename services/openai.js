const OpenAI = require('openai');

let openai = null;
try {
  const apiKey = process.env.API_KEY_OPENAI || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY or API_KEY_OPENAI environment variable not set');
  }
  openai = new OpenAI({ 
    apiKey: apiKey,
    timeout: 35000, // 35 second timeout for API calls
    maxRetries: 2    // Retry failed requests up to 2 times
  });
  console.log('✅ OpenAI client initialized successfully');
} catch (err) {
  // Do not throw here to allow module to be required in environments without API key
  console.warn('⚠️ OpenAI client not initialized:', err.message);
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
 * Helper to clean and extract valid JSON from GPT-5 responses
 * GPT-5 often wraps JSON in markdown blocks or adds conversational text
 */
function cleanJsonResponse(text) {
  if (!text) return '{}';
  
  // 1. Remove markdown code blocks (```json ... ``` or ``` ... ```)
  let cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
  
  // 2. If it starts with { or [, return it
  if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
    return cleaned;
  }
  
  // 3. Try to extract JSON from mixed text
  const jsonMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    return jsonMatch[0];
  }
  
  // 4. Fallback: return original (will fail parsing but gives better error)
  return cleaned;
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
      model: 'gpt-5',
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
      temperature: 1,
      max_completion_tokens: 2000,
    });

    const rawContent = response.choices[0].message.content;
    console.log('📦 Raw GPT-5 response (first 200 chars):', rawContent?.substring(0, 200));
    
    const jsonContent = cleanJsonResponse(rawContent);
    console.log('🧹 Cleaned JSON (first 200 chars):', jsonContent?.substring(0, 200));
    
    if (!jsonContent || jsonContent === '{}' || jsonContent.length < 10) {
      throw new Error('GPT-5 returned empty or invalid JSON response');
    }
    
    const chapters = JSON.parse(jsonContent);

    if (!Array.isArray(chapters) || chapters.length === 0) {
      throw new Error('Generated chapters is not a valid array or empty');
    }

    console.log(`✓ Chapters generated | Count: ${chapters.length} | Tokens: ${response.usage.total_tokens}`);
    return chapters;
  } catch (error) {
    console.error('❌ Error generating chapters:', error.message);
    throw new Error(`Failed to generate chapters: ${error.message}`);
  }
}

/**
 * Generate topics/exercises for a specific chapter
 */
async function generateTopics(gradeLevel, board, subject, chapterTitle, chapterContent) {
  if (!openai) throw new Error('OpenAI client not initialized. Set API_KEY_OPENAI environment variable.');
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
      model: 'gpt-5',
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
      temperature: 1,
      max_completion_tokens: 2500,
    });

    const rawContent = response.choices[0].message.content;
    const jsonContent = cleanJsonResponse(rawContent);
    
    if (!jsonContent || jsonContent === '{}' || jsonContent.length < 10) {
      throw new Error('GPT-5 returned empty or invalid JSON response');
    }
    
    const topics = JSON.parse(jsonContent);

    if (!Array.isArray(topics) || topics.length === 0) {
      throw new Error('Generated topics is not a valid array or empty');
    }

    console.log(`✓ Topics generated | Count: ${topics.length} | Tokens: ${response.usage.total_tokens}`);
    return topics;
  } catch (error) {
    console.error('❌ Error generating topics:', error.message);
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

  const prompt = `You are an expert curriculum designer. For the following topic, generate a list of clear, measurable learning goals (minimum 4). Use specific action verbs (e.g., identify, describe, analyze, demonstrate). Provide the response as a JSON object with the shape:
{ "goals": [ { "title": "Goal title (short)", "description": "One-sentence measurable description" }, ... ] }

Topic: ${topicTitle}
Summary: ${topicSummary}

Return ONLY valid JSON.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-5',
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
      temperature: 1,
      max_completion_tokens: 1000,
    });

    const rawContent = response.choices[0].message.content;
    const jsonContent = cleanJsonResponse(rawContent);
    
    if (!jsonContent || jsonContent === '{}' || jsonContent.length < 10) {
      throw new Error('GPT-5 returned empty or invalid JSON response');
    }

    let parsed = null;
    try {
      parsed = JSON.parse(jsonContent);
    } catch (err) {
      // Recovery: try to extract JSON from mixed text
      const match = jsonContent.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw new Error(`Failed to parse JSON: ${err.message}`);
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

    if (goalsArray.length === 0) {
      throw new Error('No valid goals extracted from response');
    }

    console.log(`✓ Goals generated | Count: ${goalsArray.length} | Tokens: ${response.usage.total_tokens}`);
    return { goals: goalsArray };
  } catch (error) {
    console.error('❌ Error generating topic goals:', error.message);
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
