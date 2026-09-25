/**
 * AI Resume Structuring Service
 * 
 * Uses DeepSeek (with Gemini fallback) to distill raw extracted resume text
 * into a structured, lightweight interview context JSON object (~1-2 KB).
 */

const { invokeModel, extractJson } = require('./ai/deepseek-client');

/**
 * Parses raw resume text into a structured interview context.
 * 
 * @param {string} rawText - Cleaned text extracted from the CV
 * @param {object} metadata - { targetRole, targetCompany, candidateName, userId }
 * @returns {Promise<object>} - Structured interview context
 */
async function structureResumeText(rawText, metadata = {}) {
  const targetRoleHint = metadata.targetRole ? `Target Role specified by candidate: "${metadata.targetRole}"` : '';
  const targetCompanyHint = metadata.targetCompany ? `Target Company specified by candidate: "${metadata.targetCompany}"` : '';

  const systemPrompt = `You are an expert Technical Recruiter and Senior Hiring Manager preparing for an in-depth job interview.
Your task is to analyze the candidate's resume text and extract a concise, structured interview briefing.

Analyze the resume and return ONLY a valid JSON object matching this exact structure:
{
  "candidate_name": "Full name if detected, or 'Candidate'",
  "primary_role": "e.g., Full Stack Engineer, Digital Marketer, Financial Analyst",
  "target_role": "Specific role they are interviewing for",
  "target_company": "Specific company if provided or empty string",
  "years_of_experience": "e.g., 3+ years, Fresher, 5 years",
  "top_skills": ["Up to 6-8 core technical or domain skills"],
  "key_projects_or_experience": [
    {
      "title": "Role or Project Title",
      "company_or_context": "Company name or institution",
      "highlights": "1-2 concise sentences summarizing what they built, their responsibility, and measurable impact",
      "tech_or_tools": "e.g. React, Node.js, AWS or Excel, SEO"
    }
  ],
  "education": "Degree, major, institution if found",
  "suggested_interview_questions": [
    "3 tailored questions specifically probing the candidate's real projects and technologies"
  ]
}

CRITICAL RULES:
1. Return ONLY the JSON object. Do not include markdown code block markers or conversational preamble.
2. Limit key_projects_or_experience to the 2 or 3 most prominent items so the output remains concise.
3. Keep descriptions factual, crisp, and aligned with what is written in the resume.`;

  const userMessage = [
    targetRoleHint,
    targetCompanyHint,
    '--- CANDIDATE RESUME TEXT ---',
    rawText.slice(0, 10000), // Cap to safe token limit
  ].filter(Boolean).join('\n\n');

  try {
    const rawResult = await invokeModel(systemPrompt, [
      { role: 'user', content: userMessage }
    ], {
      modelId: 'deepseek-chat',
      temperature: 0.2,
      maxTokens: 1200,
      userId: metadata.userId || null,
      featureArea: 'voice_interview_resume_parsing',
      subFeature: 'structure_cv'
    });

    const parsed = typeof rawResult === 'string' ? extractJson(rawResult) : rawResult;

    if (parsed && typeof parsed === 'object' && (parsed.primary_role || parsed.top_skills)) {
      return {
        candidate_name: parsed.candidate_name || metadata.candidateName || 'Candidate',
        primary_role: metadata.targetRole || parsed.primary_role || 'Professional',
        target_role: metadata.targetRole || parsed.target_role || parsed.primary_role || 'Job Candidate',
        target_company: metadata.targetCompany || parsed.target_company || '',
        years_of_experience: parsed.years_of_experience || 'Experienced',
        top_skills: Array.isArray(parsed.top_skills) ? parsed.top_skills.slice(0, 8) : [],
        key_projects_or_experience: Array.isArray(parsed.key_projects_or_experience)
          ? parsed.key_projects_or_experience.slice(0, 3)
          : [],
        education: parsed.education || '',
        suggested_interview_questions: Array.isArray(parsed.suggested_interview_questions)
          ? parsed.suggested_interview_questions.slice(0, 3)
          : [],
      };
    }
  } catch (err) {
    console.error('[ResumeStructurer] DeepSeek extraction error:', err.message);
  }

  // Fallback: graceful heuristic extraction if LLM is temporarily unreachable
  return createFallbackSummary(rawText, metadata);
}

/**
 * Basic heuristic fallback when AI model is temporarily unavailable
 */
function createFallbackSummary(rawText, metadata) {
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const detectedName = metadata.candidateName || lines[0] || 'Candidate';
  const role = metadata.targetRole || 'Professional';

  return {
    candidate_name: detectedName,
    primary_role: role,
    target_role: metadata.targetRole || role,
    target_company: metadata.targetCompany || '',
    years_of_experience: 'Professional Experience',
    top_skills: ['Communication', 'Problem Solving', 'Domain Expertise'],
    key_projects_or_experience: [
      {
        title: 'Work Experience',
        company_or_context: 'Past Organization',
        highlights: lines.slice(1, 4).join(' ').substring(0, 200),
        tech_or_tools: 'Relevant Tools'
      }
    ],
    education: 'Higher Education',
    suggested_interview_questions: [
      `Could you tell me about your background and experience as a ${role}?`,
      'What was the most challenging project you have worked on recently?'
    ]
  };
}

module.exports = {
  structureResumeText,
};
