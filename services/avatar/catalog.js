/**
 * Avatar catalogue: the stock faces and languages offered in the UI.
 *
 * Served to the client through GET /api/avatar/config so there is one source of
 * truth. Face IDs come from Tavus' stock face library (Phoenix-4.5 unless noted).
 */

/** Tavus speaks 42 languages. These are the Indian ones, plus English. */
const INDIAN_LANGUAGES = [
  { code: 'hi', label: 'Hindi', native: 'हिन्दी' },
  { code: 'mr', label: 'Marathi', native: 'मराठी' },
  { code: 'bn', label: 'Bengali', native: 'বাংলা' },
  { code: 'gu', label: 'Gujarati', native: 'ગુજરાતી' },
  { code: 'pa', label: 'Punjabi', native: 'ਪੰਜਾਬੀ' },
  { code: 'ta', label: 'Tamil', native: 'தமிழ்' },
  { code: 'te', label: 'Telugu', native: 'తెలుగు' },
  { code: 'kn', label: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'ml', label: 'Malayalam', native: 'മലയാളം' },
  { code: 'en', label: 'English', native: 'English' },
];

const LANGUAGE_CODES = new Set(INDIAN_LANGUAGES.map((l) => l.code));

/**
 * Female stock faces. `note` flags which read as South Asian presenters, since
 * the name alone is not a reliable signal.
 */
const FEMALE_FACES = [
  { id: 'r4dc9377a68e', name: 'Priya', note: 'Indian', model: 'Phoenix-4.5' },
  { id: 'rf0a4c22b435', name: 'Gabby', note: 'Indian', model: 'Phoenix-4.5' },
  { id: 'r800fc6ba80d', name: 'Olivia', note: 'Indian', model: 'Phoenix-4.5' },
  { id: 'r213e42b45b3', name: 'Helen', note: 'casual', model: 'Phoenix-4.5' },
  { id: 'r0004b1b95e1', name: 'Helen', note: 'home', model: 'Phoenix-4.5' },
  { id: 'r4067604db72', name: 'Lucy', note: 'home', model: 'Phoenix-4.5' },
  { id: 'rd9b169b334e', name: 'Lucy', note: 'studio', model: 'Phoenix-4.5' },
  { id: 'rb32069a3012', name: 'Jackie', note: 'office', model: 'Phoenix-4.5' },
  { id: 'rca764a6a197', name: 'Olivia', note: 'office', model: 'Phoenix-4.5' },
  { id: 'r5d40691d88d', name: 'Celine', note: 'casual', model: 'Phoenix-4.5' },
  { id: 'r4f5b5ef55c8', name: 'Celine', note: 'studio', model: 'Phoenix-4' },
  { id: 'r5ad3b1690f0', name: 'Ivy', note: 'home', model: 'Phoenix-4.5' },
  { id: 'r0a8102ab353', name: 'Ivy', note: 'casual', model: 'Phoenix-4.5' },
  { id: 'r55e6793f10f', name: 'Mary', note: 'business', model: 'Phoenix-4.5' },
  { id: 'radb9683b0eb', name: 'Mary', note: 'home', model: 'Phoenix-4.5' },
  { id: 'red9211eea81', name: 'Mary', note: 'office', model: 'Phoenix-4.5' },
  { id: 'r862e3a3c5e0', name: 'Kelly', note: 'casual', model: 'Phoenix-4' },
  { id: 'r3f427f43c9d', name: 'Gloria', note: 'warm', model: 'Phoenix-4' },
  { id: 'r9664272580d', name: 'Gloria', note: 'studio', model: 'Phoenix-4' },
  { id: 'r5dc7c7d0bcb', name: 'Gloria', note: 'bright', model: 'Phoenix-4' },
];

const FACE_IDS = new Set(FEMALE_FACES.map((f) => f.id));

const DEFAULT_FACE_ID = 'r4dc9377a68e';
const DEFAULT_LANGUAGES = ['hi', 'en'];

/** Drop anything we do not offer rather than forwarding it to Tavus. */
function sanitizeLanguages(input) {
  if (!Array.isArray(input)) return null;
  const cleaned = input
    .filter((code) => typeof code === 'string' && LANGUAGE_CODES.has(code.trim()))
    .map((code) => code.trim());
  return cleaned.length ? Array.from(new Set(cleaned)).slice(0, 10) : null;
}

function sanitizeFaceId(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  return FACE_IDS.has(trimmed) ? trimmed : null;
}

function sanitizeText(input, maxLength) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

module.exports = {
  INDIAN_LANGUAGES,
  FEMALE_FACES,
  DEFAULT_FACE_ID,
  DEFAULT_LANGUAGES,
  sanitizeLanguages,
  sanitizeFaceId,
  sanitizeText,
};