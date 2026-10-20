const { createHash } = require('node:crypto');

// A curriculum answer containing "image" or "video" is not a media request.
// The agent and HTTP adapter share this detector; neither infers media from IDK.
function mediaRequests(text) {
  const value = String(text || '').trim().replace(/[’]/g, "'");
  function requested(noun, canDraw = false) {
    if (new RegExp(`\\b(?:no|not|don't|do not|without)\\s+(?:(?:want|need|show|send|play)\\s+)?(?:(?:me|a|the|any|another)\\s+){0,2}(?:${noun})\\b`, 'i').test(value)) return false;
    const request = new RegExp(`\\b(?:show|send|share|play|replay|watch|display|give|find|open|see)\\b[^.!?]{0,55}\\b(?:${noun})\\b`, 'i');
    const want = new RegExp(`\\b(?:want|need|like)\\s+(?:(?:a|an|the|another|that|same|to watch|to see)\\s+){0,2}(?:${noun})\\b`, 'i');
    const explain = new RegExp(`\\b(?:explain|teach|learn)\\b[^.!?]{0,30}\\b(?:with|using|through|via)\\s+(?:(?:a|an|the)\\s+)?(?:${noun})\\b`, 'i');
    const direct = new RegExp(`^(?:(?:please|pls|another|same|a|an|the)\\s+)*(?:${noun})(?:\\s+(?:please|pls|again))?[.!?]*$`, 'i');
    return request.test(value) || want.test(value) || explain.test(value) || direct.test(value) ||
      (canDraw && /^(?:(?:please|pls|can you|could you)\s+)*draw\s+(?:it|this|a\b|an\b|the\b)/i.test(value));
  }
  return {
    video: requested('videos?|vidoe|vedio|vids?|youtube|yt|clips?|animations?'),
    diagram: requested('diagrams?|drawings?|pictures?|visuals?|charts?|figures?|images?', true),
  };
}

// The final agent attachment plan owns media. The adapter must not add media
// independently because an answer was incorrect, HELP, or IDK.
function finalMediaPlan({ attachments = [], phase, helpSubtype, stateInstruction } = {}) {
  const allowed = !['ROUNDUP', 'WRAP', 'DONE'].includes(phase) &&
    helpSubtype !== 'question_clarification' && stateInstruction !== 'clarify_question';
  return {
    video: allowed && attachments.includes('video'),
    diagram: allowed && attachments.includes('diagram'),
  };
}

function videoId(asset) {
  const id = asset?.video_id || asset?.id?.videoId || asset?.id;
  if (typeof id === 'string' && id.trim() && !id.startsWith('yt-fallback-')) return id.trim();
  for (const value of [asset?.url, asset?.embedUrl]) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.searchParams.get('v')) return url.searchParams.get('v');
      if (url.hostname.replace(/^www\./, '') === 'youtu.be') return url.pathname.slice(1);
      const match = url.pathname.match(/\/(?:embed|shorts)\/([^/]+)/);
      if (match) return match[1];
      // Search-link fallback assets have no video ID; still deduplicate by URL.
      return url.toString();
    } catch {}
  }
  return null;
}

function mediaAssetId(kind, asset) {
  if (kind === 'video') {
    const id = videoId(asset);
    return id ? `video:${id}` : null;
  }
  if (kind === 'diagram' && typeof asset?.code === 'string' && asset.code.trim()) {
    const code = asset.code.replace(/\r\n/g, '\n').trim();
    return `diagram:${createHash('sha256').update(code).digest('hex')}`;
  }
  return null;
}

function previouslyShown(rows = []) {
  const seen = new Set();
  for (const row of rows) {
    const kind = row.message_type === 'youtube_video' ? 'video' : row.message_type === 'mermaid_diagram' ? 'diagram' : null;
    if (!kind) continue;
    let metadata = row.diff_html;
    if (typeof metadata === 'string') {
      try { metadata = JSON.parse(metadata); } catch { continue; }
    }
    const key = mediaAssetId(kind, metadata);
    if (key) seen.add(key);
  }
  return seen;
}

function shouldDeliverMedia({ kind, asset, seen, explicitRequest = false }) {
  const key = mediaAssetId(kind, asset);
  if (!key) return false;
  // If history is unavailable, avoid an automatic duplicate. Explicit requests
  // remain usable, and can deliberately replay the same existing resource.
  return explicitRequest || (seen instanceof Set && !seen.has(key));
}

module.exports = { mediaRequests, finalMediaPlan, mediaAssetId, previouslyShown, shouldDeliverMedia };
