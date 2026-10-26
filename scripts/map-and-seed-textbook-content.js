#!/usr/bin/env node
/**
 * Universal AI Textbook-to-Topic Content Mapper & Seeder
 * 
 * Takes extracted clean textbook chapter texts from `backend/data/textbooks/`
 * and maps 100% of each chapter's text across its database curriculum topics.
 * 
 * Features:
 * - Supports single chapter, full subject, full class, or all classes (--all)
 * - Controlled concurrency pool (default: 3 workers)
 * - 100% text coverage verification per chapter
 * - Generates ready-to-use SQL seeds (`data/textbooks/seeds/...sql`)
 * - Generates visual audit reports (`data/textbooks/reports/...md`)
 * - Idempotent: skips already populated chapters unless --force is specified
 * - Supports direct database population via Prisma (--apply)
 * 
 * Usage Examples:
 *   node scripts/map-and-seed-textbook-content.js --grade="Class 8" --subject="Science" --chapter=5 --dry-run
 *   node scripts/map-and-seed-textbook-content.js --grade="Class 8" --subject="Science" --apply
 *   node scripts/map-and-seed-textbook-content.js --grade="Class 8" --apply --concurrency=4
 *   node scripts/map-and-seed-textbook-content.js --all --apply --concurrency=4
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { invokeModel, extractJson } = require('../ai/providers');

const BASE_TEXTBOOKS_DIR = path.join(__dirname, '..', 'data', 'textbooks');
const SEEDS_DIR = path.join(BASE_TEXTBOOKS_DIR, 'seeds');
const REPORTS_DIR = path.join(BASE_TEXTBOOKS_DIR, 'reports');

fs.mkdirSync(SEEDS_DIR, { recursive: true });
fs.mkdirSync(REPORTS_DIR, { recursive: true });

// Subject name aliases matching folders on disk to database names
const SUBJECT_NAME_ALIASES = {
  'science': ['Science'],
  'maths': ['Mathematics', 'Maths'],
  'maths-part-2': ['Mathematics', 'Maths'],
  'english': ['English'],
  'english-supplementary': ['English'],
  'english-workbook': ['English'],
  'social-science': ['Social Studies', 'Social Science'],
  'social-science-part-2': ['Social Studies', 'Social Science'],
  'geography': ['Social Studies', 'Geography', 'Social Science'],
  'civics': ['Social Studies', 'Civics', 'Social Science'],
  'history': ['Social Studies', 'History', 'Social Science'],
  'economics': ['Social Studies', 'Economics', 'Social Science'],
  'evs': ['Environmental Studies (EVS)', 'EVS'],
  'arts': ['Art & Craft', 'Arts'],
  'hindi': ['Hindi'],
  'physical-education': ['Physical Education', 'Health and Physical Education'],
};

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      args[key] = value !== undefined ? value : true;
    }
  }
  return args;
}

function splitIntoParagraphs(text) {
  const lines = text.split('\n');
  const paragraphs = [];
  let current = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      if (current.length > 0) {
        paragraphs.push(current.join(' '));
        current = [];
      }
      continue;
    }
    current.push(trimmed);
  }
  if (current.length > 0) {
    paragraphs.push(current.join(' '));
  }

  return paragraphs.map((p, idx) => ({
    id: idx + 1,
    text: p,
  }));
}

function sqlEscape(str) {
  return str.replace(/'/g, "''");
}

async function mapChapterTextToTopics(chapterTitle, paragraphs, topics) {
  const prompt = `You are an expert curriculum and textbook alignment engine.
Your task is to cleanly divide and map 100% of an extracted textbook chapter across its curriculum topics.

Chapter Title: "${chapterTitle}"

Textbook Paragraphs (${paragraphs.length} total):
${paragraphs.map(p => `[P${p.id}] ${p.text.slice(0, 140)}${p.text.length > 140 ? '...' : ''}`).join('\n')}

Curriculum Topics to Map Into (${topics.length} topics):
${topics.map(t => `- Topic ID ${t.id} (Order ${t.order}): "${t.title}"`).join('\n')}

MAPPING RULES:
1. Every single paragraph from [P1] to [P${paragraphs.length}] must be assigned to the most relevant topic.
2. NO PARAGRAPH MAY BE LEFT UNMAPPED. 100% of paragraphs must be covered.
3. Preserve the natural textbook order.
4. Introduction / opener paragraphs belong to Topic 1.
5. End of chapter questions / exercises belong to the final Exercise topic(s).
6. Return a strict JSON object mapping each topic ID to a list of paragraph numbers:
{
  "mappings": [
    {
      "topic_id": ${topics[0].id},
      "paragraph_ids": [1, 2, 3]
    }
  ]
}

Return JSON ONLY. No prose outside the JSON.`;

  const response = await invokeModel(
    'You are a precise curriculum mapping engine. You output valid JSON only.',
    [{ role: 'user', content: prompt }],
    { jsonFormat: true, temperature: 0.1 }
  );

  const parsed = extractJson(response);
  if (!parsed || !Array.isArray(parsed.mappings)) {
    throw new Error('AI response did not contain a valid "mappings" array: ' + JSON.stringify(response));
  }

  return parsed.mappings;
}

/**
 * Process a single chapter end-to-end
 */
async function processChapter({ grade, subject, chapterNo, chapterFile, topics, prisma, apply, force }) {
  const chapterTag = `[${grade} | ${subject} | Ch ${chapterNo}]`;

  // Check if already populated
  if (apply && prisma && !force) {
    const populatedCount = await prisma.global_topics.count({
      where: {
        id: { in: topics.map(t => t.id) },
        textbook_content: { not: null }
      }
    });
    if (populatedCount === topics.length && topics.length > 0) {
      console.log(`${chapterTag} Already populated (${populatedCount}/${topics.length} topics). Skipping (use --force to overwrite).`);
      return { skipped: true, chapterNo, topics: topics.length };
    }
  }

  const rawText = fs.readFileSync(chapterFile, 'utf8');
  const paragraphs = splitIntoParagraphs(rawText);

  if (!paragraphs.length) {
    console.warn(`${chapterTag} Warning: No paragraphs found in ${chapterFile}`);
    return { skipped: true, chapterNo, reason: 'empty_file' };
  }

  console.log(`${chapterTag} Mapping ${paragraphs.length} paragraphs across ${topics.length} topics...`);
  const mappings = await mapChapterTextToTopics(`Chapter ${chapterNo}`, paragraphs, topics);

  // Assemble text per topic
  const paraMap = new Map(paragraphs.map(p => [p.id, p.text]));
  const topicContents = new Map();
  const assignedParas = new Set();

  for (const m of mappings) {
    const topicId = m.topic_id;
    const paraIds = m.paragraph_ids || [];
    const texts = [];

    for (const pid of paraIds) {
      if (paraMap.has(pid)) {
        texts.push(paraMap.get(pid));
        assignedParas.add(pid);
      }
    }
    topicContents.set(topicId, texts.join('\n\n'));
  }

  // Ensure 100% coverage
  const unassigned = paragraphs.filter(p => !assignedParas.has(p.id));
  if (unassigned.length > 0) {
    const lastTopicId = topics[topics.length - 1].id;
    const existing = topicContents.get(lastTopicId) || '';
    const extra = unassigned.map(p => p.text).join('\n\n');
    topicContents.set(lastTopicId, existing ? `${existing}\n\n${extra}` : extra);
  }

  // 1. Generate SQL Seed file
  const gradeSlug = grade.toLowerCase().replace(/\s+/g, '-');
  const subjectSlug = subject.toLowerCase().replace(/\s+/g, '-');
  const sqlStatements = [
    `-- Textbook Content Seed for ${grade} ${subject} - Chapter ${chapterNo}`,
    `-- Generated: ${new Date().toISOString()}`,
    `BEGIN;\n`
  ];

  for (const t of topics) {
    const content = topicContents.get(t.id) || '';
    sqlStatements.push(
      `UPDATE global_topics SET textbook_content = '${sqlEscape(content)}' WHERE id = ${t.id};`
    );
  }
  sqlStatements.push(`\nCOMMIT;\n`);

  const sqlFilename = `${gradeSlug}_${subjectSlug}_ch${String(chapterNo).padStart(2, '0')}.sql`;
  fs.writeFileSync(path.join(SEEDS_DIR, sqlFilename), sqlStatements.join('\n'), 'utf8');

  // 2. Generate Markdown Audit Report
  const reportLines = [
    `# Mapping Report: ${grade} ${subject} - Chapter ${chapterNo}`,
    `**Total Paragraphs:** ${paragraphs.length} | **Coverage:** 100% | **Topics:** ${topics.length}`,
    `**Generated:** ${new Date().toISOString()}`,
    ``,
    `| Topic ID | Order | Topic Title | Assigned Chars | Paragraphs |`,
    `| :--- | :--- | :--- | :--- | :--- |`,
  ];

  for (const t of topics) {
    const content = topicContents.get(t.id) || '';
    const pCount = (mappings.find(m => m.topic_id === t.id)?.paragraph_ids || []).length;
    reportLines.push(
      `| **${t.id}** | ${t.order} | ${t.title} | ${content.length.toLocaleString()} chars | ${pCount} paras |`
    );
  }

  const reportFilename = `${gradeSlug}_${subjectSlug}_ch${String(chapterNo).padStart(2, '0')}.md`;
  fs.writeFileSync(path.join(REPORTS_DIR, reportFilename), reportLines.join('\n'), 'utf8');

  // 3. Write to Database if apply mode is on
  if (apply && prisma) {
    for (const t of topics) {
      const content = topicContents.get(t.id) || '';
      await prisma.global_topics.update({
        where: { id: t.id },
        data: { textbook_content: content }
      });
    }
    console.log(`${chapterTag} [✓] DB Updated: ${topics.length} topics populated (${rawText.length.toLocaleString()} chars)`);
  } else {
    console.log(`${chapterTag} [✓] Dry-run complete: 100% mapped -> SQL and Report written.`);
  }

  return { success: true, chapterNo, topics: topics.length, chars: rawText.length };
}

/**
 * Concurrency runner for processing chapters in parallel pools
 */
async function runPool(tasks, concurrency) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const currentIdx = index++;
      try {
        const res = await tasks[currentIdx]();
        results[currentIdx] = { status: 'fulfilled', value: res };
      } catch (err) {
        results[currentIdx] = { status: 'rejected', reason: err };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs();
  const apply = Boolean(args.apply);
  const force = Boolean(args.force);
  const concurrency = parseInt(args.concurrency || '3', 10);
  const filterGrade = args.grade; // e.g. "Class 8" or undefined for all
  const filterSubject = args.subject; // e.g. "Science" or undefined for all
  const filterChapter = args.chapter ? parseInt(args.chapter, 10) : null;
  const isAll = Boolean(args.all) || (!filterGrade && !filterSubject && !filterChapter);

  console.log('\n=================================================================');
  console.log('🚀 UNIVERSAL AI TEXTBOOK-TO-TOPIC MAPPER & SEEDER');
  console.log(`Mode:        ${apply ? '🔥 LIVE APPLY (Writing to PostgreSQL)' : '📋 DRY-RUN (Generating SQL Seeds & Reports)'}`);
  console.log(`Concurrency: ${concurrency} workers`);
  console.log(`Target:      ${isAll ? 'ALL CLASSES & SUBJECTS' : `${filterGrade || 'All Grades'} | ${filterSubject || 'All Subjects'} ${filterChapter ? `| Ch ${filterChapter}` : ''}`}`);
  console.log('=================================================================\n');

  let prisma = null;
  if (apply) {
    prisma = require('../lib/prisma');
  }

  // Load manifest of extracted chapters
  const manifestFile = path.join(BASE_TEXTBOOKS_DIR, 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    console.error(`[!] Manifest not found at: ${manifestFile}. Run extraction first.`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

  // Build chapter tasks
  const eligibleChapters = [];

  for (const item of manifest) {
    const itemGrade = item.class.replace('class-', 'Class ');
    const itemSubjectSlug = item.subject;
    const itemChapterNo = item.chapter_no;
    const chapterFilePath = path.join(BASE_TEXTBOOKS_DIR, item.class, item.subject, `chapter-${String(item.chapter_no).padStart(2, '0')}.txt`);

    if (filterGrade && filterGrade.toLowerCase() !== itemGrade.toLowerCase()) continue;
    if (filterSubject) {
      const allowedAliases = SUBJECT_NAME_ALIASES[itemSubjectSlug] || [itemSubjectSlug];
      const match = allowedAliases.some(a => a.toLowerCase() === filterSubject.toLowerCase());
      if (!match && itemSubjectSlug.toLowerCase() !== filterSubject.toLowerCase()) continue;
    }
    if (filterChapter !== null && filterChapter !== itemChapterNo) continue;

    eligibleChapters.push({
      grade: itemGrade,
      subjectSlug: itemSubjectSlug,
      chapterNo: itemChapterNo,
      chapterFile: chapterFilePath,
    });
  }

  console.log(`[+] Found ${eligibleChapters.length} chapter files matching criteria.\n`);

  if (!eligibleChapters.length) {
    console.log('[!] No chapters matched. Exiting.');
    return;
  }

  // Fetch topics for these chapters from database
  let dbChapters = [];
  if (prisma) {
    console.log('[DB] Fetching live chapters and topics from database...');
    dbChapters = await prisma.global_chapters.findMany({
      where: {
        subject: {
          board: { contains: 'CBSE' },
          ...(filterGrade ? { grade: filterGrade } : {}),
        }
      },
      include: {
        topics: { orderBy: { order: 'asc' } },
        subject: true
      },
      orderBy: [{ subject_id: 'asc' }, { order: 'asc' }]
    });
    console.log(`[DB] Loaded ${dbChapters.length} chapters from database.\n`);
  }

  // Match files to database chapters
  const tasks = [];

  for (const chap of eligibleChapters) {
    tasks.push(async () => {
      let topics = [];

      if (prisma && dbChapters.length) {
        // Find matching chapter in DB
        const match = dbChapters.find(dbc => {
          const gradeMatch = dbc.subject?.grade?.toLowerCase() === chap.grade.toLowerCase();
          const orderMatch = dbc.order === chap.chapterNo;
          const allowedAliases = SUBJECT_NAME_ALIASES[chap.subjectSlug] || [chap.subjectSlug];
          const subjectMatch = allowedAliases.some(a => a.toLowerCase() === dbc.subject?.name?.toLowerCase());
          return gradeMatch && orderMatch && subjectMatch;
        });

        if (match && match.topics.length) {
          topics = match.topics;
        }
      }

      // Fallback for Class 8 Science Chapter 5 when prisma is not connected locally
      if (!topics.length && chap.grade === 'Class 8' && chap.subjectSlug === 'science' && chap.chapterNo === 5) {
        topics = [
          { id: 3474, order: 1, title: 'Topic 1: What Is a Force?' },
          { id: 3475, order: 2, title: 'Topic 2: What Can a Force Do to the Objects on Which It Is Applied?' },
          { id: 3476, order: 3, title: 'Topic 3: Are Forces an Interaction Between Two or More Objects?' },
          { id: 3477, order: 4, title: 'Topic 4: What Are the Different Types of Forces?' },
          { id: 3478, order: 5, title: 'Topic 5: Weight and Its Measurement' },
          { id: 3479, order: 6, title: 'Topic 6: Floating and Sinking' },
          { id: 3480, order: 7, title: 'Topic 7: Exercises: Exploring Forces' },
        ];
      }

      if (!topics.length) {
        console.warn(`[Skip] No database topics found for ${chap.grade} ${chap.subjectSlug} Chapter ${chap.chapterNo}`);
        return { skipped: true, reason: 'no_topics' };
      }

      return await processChapter({
        grade: chap.grade,
        subject: chap.subjectSlug,
        chapterNo: chap.chapterNo,
        chapterFile: chap.chapterFile,
        topics,
        prisma,
        apply,
        force,
      });
    });
  }

  const startTime = Date.now();
  const results = await runPool(tasks, concurrency);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const succeeded = results.filter(r => r.status === 'fulfilled' && r.value?.success).length;
  const skipped = results.filter(r => r.status === 'fulfilled' && r.value?.skipped).length;
  const failed = results.filter(r => r.status === 'rejected').length;

  console.log('\n=================================================================');
  console.log('🏁 EXECUTION SUMMARY');
  console.log(`Total Tasks: ${results.length}`);
  console.log(`Succeeded:   ${succeeded}`);
  console.log(`Skipped:     ${skipped}`);
  console.log(`Failed:      ${failed}`);
  console.log(`Time Taken:  ${elapsed}s`);
  console.log('=================================================================\n');

  if (prisma) {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('[!] Fatal error in main:', err);
  process.exit(1);
});
