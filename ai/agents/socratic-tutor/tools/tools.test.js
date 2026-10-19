const test = require('node:test');
const assert = require('node:assert/strict');

const tools = require('./index');

test('TL1: Socratic tools export all 5 tool definitions for LLM tool calling', () => {
  assert.equal(tools.definitions.length, 5);
  const names = tools.definitions.map(d => d.name);
  assert.ok(names.includes('generate_concept_diagram'));
  assert.ok(names.includes('fetch_educational_video'));
  assert.ok(names.includes('curriculum_search'));
  assert.ok(names.includes('akg_intelligence_lookup'));
  assert.ok(names.includes('misconception_memory_lookup'));
});

test('TL2: diagramTool generates or retrieves Mermaid code structure', () => {
  const result = tools.diagramTool.execute({
    topicTitle: 'Human Eye',
    goalTitle: 'Power of Accommodation',
  });
  assert.equal(result.success, true);
  assert.ok(result.diagram);
  assert.ok(result.diagram.code.includes('graph TD') || result.diagram.code.includes('-->'));
});

test('TL3: memoryTool extracts and formats past misconceptions', () => {
  const mockState = {
    perGoal: [
      { errors: ['Conceptual: confused focal length with distance'] },
      { errors: [] },
    ],
  };
  const mockGoals = [{ title: 'Power of Accommodation' }, { title: 'Defects of Vision' }];

  const history = tools.memoryTool.getMisconceptionHistory(mockState, mockGoals);
  assert.equal(history.length, 1);
  assert.equal(history[0].goalTitle, 'Power of Accommodation');

  const context = tools.memoryTool.formatMisconceptionPromptContext(history);
  assert.ok(context.includes('STUDENT PAST MISCONCEPTIONS'));
  assert.ok(context.includes('confused focal length'));
});

test('TL4: videoTool returns verified educational video structure', async () => {
  const result = await tools.videoTool.execute({
    conceptQuery: 'Power of Accommodation eye lens',
    classLevel: 'Class 10 CBSE',
  });
  assert.equal(result.success, true);
  assert.ok(Array.isArray(result.videos));
  assert.ok(result.videos.length > 0);
  assert.ok(result.videos[0].embedUrl);
});

test('TL5: Dynamic tool dispatcher executes tools by name', async () => {
  const diagResult = await tools.executeTool('generate_concept_diagram', {
    topicTitle: 'Optics',
    goalTitle: 'Refraction of Light',
  });
  assert.equal(diagResult.success, true);

  const unknownResult = await tools.executeTool('non_existent_tool', {});
  assert.equal(unknownResult.success, false);
});
