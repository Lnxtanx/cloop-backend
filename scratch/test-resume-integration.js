const { extractResumeText } = require('../services/resume-parser')
const { buildSessionPrompt } = require('../services/voice-to-voice/voice-session-prompts')

async function runTest() {
  console.log('🧪 Starting Resume & Voice Prompt Integration Test...')

  // 1. Test Text Extraction (In-memory text)
  const sampleResume = `
Vivek Sharma
Senior Frontend Engineer | React & TypeScript Specialist
Bangalore, India | vivek@example.com

SUMMARY:
Results-driven software engineer with 4+ years of experience designing scalable web architectures, micro-frontends, and real-time WebSocket applications.

EXPERIENCE:
Senior Frontend Developer - TechNova Solutions (2022 - Present)
- Architected a high-concurrency real-time collaboration engine using React, WebSockets, and Zustand.
- Decreased initial bundle load time by 42% through code-splitting and dynamic imports.
- Mentored a team of 5 junior engineers and led code review standards.

SKILLS:
React, TypeScript, Next.js, Node.js, WebSockets, Tailwind CSS, Performance Optimization, Jest

EDUCATION:
B.Tech in Computer Science - VTU (2018 - 2022)
  `

  const buffer = Buffer.from(sampleResume, 'utf-8')
  const extracted = await extractResumeText(buffer, 'text/plain', 'vivek_resume.txt')
  console.log(`✅ Text Extracted: ${extracted.length} chars`)
  if (!extracted.includes('TechNova Solutions') || !extracted.includes('WebSockets')) {
    throw new Error('Extraction failed to find expected content')
  }

  // 2. Test Voice Session Prompt Builder with Resume Data
  const mockResumeData = {
    fileName: 'vivek_resume.pdf',
    targetRole: 'Lead Frontend Engineer',
    targetCompany: 'Google India',
    data: {
      candidate_name: 'Vivek Sharma',
      primary_role: 'Senior Frontend Engineer',
      target_role: 'Lead Frontend Engineer',
      target_company: 'Google India',
      years_of_experience: '4+ years',
      top_skills: ['React', 'TypeScript', 'WebSockets', 'Next.js', 'Performance Optimization'],
      key_projects_or_experience: [
        {
          title: 'Senior Frontend Developer',
          company_or_context: 'TechNova Solutions',
          highlights: 'Architected high-concurrency real-time collaboration engine, cutting bundle time by 42%',
          tech_or_tools: 'React, WebSockets, Zustand'
        }
      ],
      education: 'B.Tech in Computer Science',
      suggested_interview_questions: [
        'How did you design the real-time WebSocket collaboration engine at TechNova?',
        'What specific techniques did you use to cut bundle load time by 42%?'
      ]
    }
  }

  const prompt = buildSessionPrompt(
    'interview_prep',
    'talking_about_experience',
    'interview',
    {
      name: 'Vivek Sharma',
      englishLevel: 'Intermediate',
      resumeData: mockResumeData
    }
  )

  console.log('✅ Generated Prompt Length:', prompt.length)
  
  // Verify that prompt contains candidate dossier and resume specifics
  const assertions = [
    'CANDIDATE DOSSIER',
    'Vivek Sharma',
    'Lead Frontend Engineer for a position at Google India',
    'TechNova Solutions',
    'WebSockets',
    'HOW TO CONDUCT THIS RESUME-BASED INTERVIEW'
  ]

  for (const check of assertions) {
    if (!prompt.includes(check)) {
      throw new Error(`Prompt missing expected assertion: "${check}"`)
    }
    console.log(`  ✓ Prompt contains "${check}"`)
  }

  console.log('\n🎉 ALL INTEGRATION TESTS PASSED!')
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err)
  process.exit(1)
})
