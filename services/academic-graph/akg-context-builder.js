/**
 * Academic Knowledge Graph (AKG) Context Builder
 * Normalizes intelligence objects and generates compact prompt injections
 * for tutor-generator (<80 words) and evaluator (<100 words).
 */

function safeParse(val, fallback) {
  if (val == null) return fallback;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }
  return val;
}

function cleanStringList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(item => (typeof item === 'string' ? item.trim() : item?.concept || item?.title || ''))
    .filter(Boolean);
}

function cleanMisconceptions(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(item => {
      if (typeof item === 'string') {
        return { misconception: item.trim(), correction_angle: '' };
      }
      if (item && typeof item === 'object') {
        const misconception = String(item.misconception || item.trap || '').trim();
        const correction_angle = String(item.correction_angle || item.correction || item.fact || '').trim();
        if (misconception) return { misconception, correction_angle };
      }
      return null;
    })
    .filter(Boolean);
}

function buildTutorSnippet({ preceding_anchor, succeeding_teaser, in_scope_concepts, out_of_scope_boundaries }) {
  const parts = [];
  if (preceding_anchor) {
    parts.push(`FOUNDATION: Anchor opening probe in: ${preceding_anchor}`);
  }
  if (in_scope_concepts.length) {
    parts.push(`IN-SCOPE: ${in_scope_concepts.slice(0, 5).join(', ')}`);
  }
  if (out_of_scope_boundaries.length) {
    parts.push(`FORBIDDEN (Out-of-scope for this grade): ${out_of_scope_boundaries.slice(0, 5).join(', ')}. DO NOT introduce, ask about, or mention these.`);
  }
  if (succeeding_teaser) {
    parts.push(`WRAP TEASER: Tease next topic: ${succeeding_teaser}`);
  }
  return parts.join('\n');
}

function buildEvaluatorSnippet({ in_scope_concepts, out_of_scope_boundaries, common_misconceptions }) {
  const parts = [];
  if (in_scope_concepts.length) {
    parts.push(`IN-SCOPE: ${in_scope_concepts.slice(0, 5).join(', ')}`);
  }
  if (out_of_scope_boundaries.length) {
    parts.push(`OUT-OF-SCOPE: ${out_of_scope_boundaries.slice(0, 5).join(', ')}. Never penalize students for omitting these, and never require higher-grade concepts/formulas.`);
  }
  if (common_misconceptions.length) {
    const traps = common_misconceptions
      .slice(0, 3)
      .map(m => `- Trap: "${m.misconception}" -> Scientific correction: "${m.correction_angle}"`)
      .join('\n');
    parts.push(`KNOWN MISCONCEPTIONS:\n${traps}`);
  }
  return parts.join('\n');
}

function buildAkgContext(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const preceding_anchor = typeof raw.preceding_anchor === 'string' ? raw.preceding_anchor.trim() : null;
  const succeeding_teaser = typeof raw.succeeding_teaser === 'string' ? raw.succeeding_teaser.trim() : null;
  const in_scope_concepts = cleanStringList(safeParse(raw.in_scope_concepts, []));
  const out_of_scope_boundaries = cleanStringList(safeParse(raw.out_of_scope_boundaries, []));
  const common_misconceptions = cleanMisconceptions(safeParse(raw.common_misconceptions, []));

  const tutorSnippet = buildTutorSnippet({
    preceding_anchor,
    succeeding_teaser,
    in_scope_concepts,
    out_of_scope_boundaries,
  });

  const evaluatorSnippet = buildEvaluatorSnippet({
    in_scope_concepts,
    out_of_scope_boundaries,
    common_misconceptions,
  });

  return {
    preceding_anchor,
    succeeding_teaser,
    in_scope_concepts,
    out_of_scope_boundaries,
    common_misconceptions,
    tutor_context: {
      preceding_anchor,
      succeeding_teaser,
      in_scope: in_scope_concepts,
      boundaries: out_of_scope_boundaries,
      prompt_snippet: tutorSnippet,
    },
    evaluator_context: {
      in_scope: in_scope_concepts,
      boundaries: out_of_scope_boundaries,
      misconceptions: common_misconceptions,
      prompt_snippet: evaluatorSnippet,
    },
  };
}

module.exports = {
  buildAkgContext,
  buildTutorSnippet,
  buildEvaluatorSnippet,
  safeParse,
  cleanStringList,
  cleanMisconceptions,
};
