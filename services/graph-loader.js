/**
 * Knowledge Graph Excel Loader Service
 * Loads chapter, topic, concept graph, prerequisite, and mastery data
 * directly from Cloop Academic Knowledge Graph v8.0 / v5.0 Excel workbooks.
 */

const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const V8_PATH = path.resolve(__dirname, '../../Cloop_Academic_Knowledge_Graph_v8.0_CLOOP_GRAPH_MASTERY_ENGINE.xlsx');
const V5_PATH = path.resolve(__dirname, '../../Cloop_Academic_Knowledge_Graph_v5.0_RECONCILED.xlsx');

let workbookV8 = null;

function getWorkbookV8() {
  if (!workbookV8) {
    const filePath = fs.existsSync(V8_PATH) ? V8_PATH : (fs.existsSync(V5_PATH) ? V5_PATH : null);
    if (!filePath) {
      throw new Error(`Knowledge Graph Excel file not found at ${V8_PATH} or ${V5_PATH}`);
    }
    console.log(`[graph-loader] 📖 Loading Knowledge Graph workbook: ${path.basename(filePath)}`);
    workbookV8 = XLSX.readFile(filePath);
  }
  return workbookV8;
}

/**
 * Get all available Science/Physics/Chemistry/Biology chapters in Class 9 and 10
 */
function getAvailableScienceChapters(classFilter = null) {
  const wb = getWorkbookV8();
  const sheetName = wb.SheetNames.includes('Concept_Master_v7') ? 'Concept_Master_v7' : 'Concept_Graph';
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet);

  const chaptersMap = new Map();

  for (const r of rows) {
    const sys = r['System'] || 'CBSE';
    const cls = String(r['Class'] || '').trim();
    const subj = String(r['Subject'] || '').trim();
    const chap = String(r['Chapter'] || '').trim();
    const topic = String(r['Topic'] || '').trim();

    if (!chap || !subj) continue;
    if (classFilter && cls !== String(classFilter)) continue;

    const isScience = /Science|Physics|Chemistry|Biology/i.test(subj);
    if (!isScience) continue;

    const key = `${cls} | ${subj} | ${chap}`;
    if (!chaptersMap.has(key)) {
      chaptersMap.set(key, {
        classLevel: cls,
        subject: subj,
        chapter: chap,
        topics: new Set(),
        conceptCount: 0
      });
    }

    const item = chaptersMap.get(key);
    if (topic) item.topics.add(topic);
    item.conceptCount++;
  }

  return Array.from(chaptersMap.values()).map(c => ({
    classLevel: c.classLevel,
    subject: c.subject,
    chapter: c.chapter,
    topics: Array.from(c.topics),
    conceptCount: c.conceptCount
  }));
}

/**
 * Load complete Knowledge Graph curriculum context & goals for a selected Chapter
 */
function loadChapterGraph(classLevel, chapterName) {
  const wb = getWorkbookV8();
  const sheetName = wb.SheetNames.includes('Concept_Master_v7') ? 'Concept_Master_v7' : 'Concept_Graph';
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet);

  // 1. Filter concept rows matching class and chapter
  const matchingConcepts = rows.filter(r => {
    const cls = String(r['Class'] || '').trim();
    const chap = String(r['Chapter'] || '').trim();
    const isClassMatch = !classLevel || cls.toLowerCase() === String(classLevel).toLowerCase();
    const isChapMatch = chap.toLowerCase().includes(String(chapterName).toLowerCase());
    return isClassMatch && isChapMatch;
  });

  if (matchingConcepts.length === 0) {
    throw new Error(`No concepts found in Knowledge Graph for Class '${classLevel}', Chapter '${chapterName}'`);
  }

  const first = matchingConcepts[0];
  const subject = first['Subject'] || 'Science';
  const fullChapterTitle = first['Chapter'] || chapterName;

  // Sort concepts by Concept Sequence if available
  matchingConcepts.sort((a, b) => {
    const seqA = parseInt(a['Concept Sequence'] || 999, 10);
    const seqB = parseInt(b['Concept Sequence'] || 999, 10);
    return seqA - seqB;
  });

  // 2. Build learning goals from concepts
  const topicGoals = matchingConcepts.map((c, idx) => {
    const conceptId = c['Concept ID'] || `GRAPH-GOAL-${idx + 1}`;
    const conceptName = c['Concept'] || c['Topic'] || `Concept ${idx + 1}`;
    const outcome = c['Learning Outcome'] || `Master concept: ${conceptName}`;
    const topicName = c['Topic'] || fullChapterTitle;

    return {
      id: idx + 1,
      concept_id: conceptId,
      title: `Goal ${idx + 1}: ${conceptName}`,
      raw_concept: conceptName,
      topic_name: topicName,
      learning_outcome: outcome,
      chat_goal_progress: [
        {
          num_questions: 0,
          num_correct: 0,
          is_completed: false
        }
      ]
    };
  });

  // 3. Load Prerequisite Edge Graph from Cloop_Concept_Graph_v8
  const prereqs = [];
  if (wb.SheetNames.includes('Cloop_Concept_Graph_v8')) {
    const edgeSheet = wb.Sheets['Cloop_Concept_Graph_v8'];
    const edgeRows = XLSX.utils.sheet_to_json(edgeSheet);
    const conceptIds = new Set(matchingConcepts.map(c => c['Concept ID']).filter(Boolean));

    for (const er of edgeRows) {
      if (conceptIds.has(er['Dependent Concept ID']) || conceptIds.has(er['Prerequisite Concept ID'])) {
        prereqs.push({
          edge_id: er['Edge ID'],
          prereq_id: er['Prerequisite Concept ID'],
          prereq_topic: er['Prerequisite Topic'],
          dependent_topic: er['Dependent Topic'],
          rationale: er['Rationale']
        });
      }
    }
  }

  // 4. Load Error Taxonomy & Remediation Rules
  const errorTaxonomy = [];
  if (wb.SheetNames.includes('Cloop_Error_Taxonomy_v1')) {
    const errSheet = wb.Sheets['Cloop_Error_Taxonomy_v1'];
    const errRows = XLSX.utils.sheet_to_json(errSheet);
    for (const er of errRows) {
      errorTaxonomy.push({
        tag: er['Error Tag'],
        name: er['Error Name'],
        definition: er['Definition'],
        family: er['Error Family']
      });
    }
  }

  const remediationPolicies = [];
  if (wb.SheetNames.includes('Remediation_Policy_v8')) {
    const remSheet = wb.Sheets['Remediation_Policy_v8'];
    const remRows = XLSX.utils.sheet_to_json(remSheet);
    for (const rr of remRows) {
      remediationPolicies.push({
        rule_id: rr['Rule ID'],
        trigger: rr['Trigger'],
        action: rr['Cloop Action']
      });
    }
  }

  return {
    topicId: 8888,
    title: fullChapterTitle,
    classLevel: first['Class'] || classLevel,
    subject,
    concepts: matchingConcepts,
    topicGoals,
    prerequisites: prereqs,
    errorTaxonomy,
    remediationPolicies
  };
}

module.exports = {
  getAvailableScienceChapters,
  loadChapterGraph
};
