const test = require('node:test');
const assert = require('node:assert/strict');
const { mediaRequests, finalMediaPlan, mediaAssetId, previouslyShown, shouldDeliverMedia } = require('./media-policy');

test('scientific uses of image and ordinary HELP/IDK never request media', () => {
  for (const text of ['The image is real and inverted.', 'The retina forms an image.', 'I do not know', 'Explain the answer', 'What do you mean by image?', 'Motion can be seen in a video recording.']) {
    assert.deepEqual(mediaRequests(text), { video: false, diagram: false }, text);
  }
});

test('explicit visual/video requests, replay, and typo variants are recognized', () => {
  for (const text of ['Show me a diagram', 'Explain using a picture', 'diagram please', 'Draw it', 'Can you show that image again?']) {
    assert.equal(mediaRequests(text).diagram, true, text);
  }
  for (const text of ['Show a video', 'Can I watch a video?', 'vedio please', 'Replay the same video', 'I want another video']) {
    assert.equal(mediaRequests(text).video, true, text);
  }
  assert.deepEqual(mediaRequests('No video please'), { video: false, diagram: false });
  assert.deepEqual(mediaRequests("I don't want a video"), { video: false, diagram: false });
});

test('only the final attachment plan controls media and ROUNDUP stays assessment-only', () => {
  assert.deepEqual(finalMediaPlan({ attachments: [], phase: 'DIALOGUE' }), { video: false, diagram: false });
  assert.deepEqual(finalMediaPlan({ attachments: ['diagram'], phase: 'DIALOGUE' }), { video: false, diagram: true });
  for (const phase of ['ROUNDUP', 'WRAP', 'DONE']) {
    assert.deepEqual(finalMediaPlan({ attachments: ['diagram', 'video'], phase }), { video: false, diagram: false });
  }
  assert.deepEqual(finalMediaPlan({ attachments: ['diagram', 'video'], phase: 'DIALOGUE', stateInstruction: 'clarify_question' }), { video: false, diagram: false });
});

test('stable video IDs work across old persisted metadata, watch URLs and embed URLs', () => {
  const video = { id: 'abc123', url: 'https://www.youtube.com/watch?v=abc123' };
  const seen = previouslyShown([{ message_type: 'youtube_video', diff_html: JSON.stringify({ video_id: 'abc123' }) }]);
  assert.equal(mediaAssetId('video', video), mediaAssetId('video', { embedUrl: 'https://www.youtube.com/embed/abc123' }));
  assert.equal(shouldDeliverMedia({ kind: 'video', asset: video, seen }), false);
  assert.equal(shouldDeliverMedia({ kind: 'video', asset: video, seen, explicitRequest: true }), true);
  assert.equal(shouldDeliverMedia({ kind: 'video', asset: { id: 'different' }, seen }), true);
});

test('fallback search links are deduplicated despite timestamp-based fallback IDs', () => {
  const url = 'https://www.youtube.com/results?search_query=force';
  assert.equal(mediaAssetId('video', { id: 'yt-fallback-100', url }), mediaAssetId('video', { id: 'yt-fallback-200', url }));
});

test('diagram dedup uses the diagram itself, ignoring different titles and triggers', () => {
  const diagram = { code: 'graph TD\n A-->B', title: 'Force', trigger: 'teaching' };
  const seen = previouslyShown([{ message_type: 'mermaid_diagram', diff_html: JSON.stringify(diagram) }]);
  assert.equal(shouldDeliverMedia({ kind: 'diagram', asset: { ...diagram, title: 'Again', trigger: 'visual_explanation' }, seen }), false);
  assert.equal(shouldDeliverMedia({ kind: 'diagram', asset: diagram, seen, explicitRequest: true }), true);
});

test('missing history suppresses automatic assets while explicit replay remains available', () => {
  assert.equal(shouldDeliverMedia({ kind: 'video', asset: { id: 'abc123' }, seen: null }), false);
  assert.equal(shouldDeliverMedia({ kind: 'video', asset: { id: 'abc123' }, seen: null, explicitRequest: true }), true);
  assert.doesNotThrow(() => previouslyShown([{ message_type: 'youtube_video', diff_html: '{broken' }]));
});
