/**
 * Central allow-lists for trusted educational media sources — YouTube channels
 * and image domains. Only media from these sources is shown to students, so
 * shared videos/images are fact-checked and curriculum-appropriate (Grades 6–10,
 * CBSE/ICSE + reputable science/education).
 *
 * Extend WITHOUT a code change via env (comma-separated):
 *   YOUTUBE_CHANNEL_WHITELIST="Channel Name,Another Channel"   (channel-name substrings)
 *   IMAGE_DOMAIN_WHITELIST="example.org,another.edu"           (source domains)
 * By default the whitelist PREFERS trusted sources but still shares the best
 * on-topic result when none match (so media is always shown — the query is
 * already grounded in the topic for relevance). To BLOCK anything untrusted
 * (show nothing / Wikimedia-only instead), enable strict mode:
 *   YOUTUBE_WHITELIST_STRICT=true
 *   IMAGE_WHITELIST_STRICT=true
 */

// Trusted YouTube channels (matched as case-insensitive substrings of channelTitle).
const DEFAULT_YT_CHANNELS = [
  'Khan Academy', 'BYJU', 'Vedantu', 'Physics Wallah', 'PhysicsWallah', 'Magnet Brains',
  'LearnoHub', 'ExamFear', 'Manocha Academy', "Don't Memorise", 'Dont Memorise',
  'Infinity Learn', 'Toppr', 'Unacademy', 'NCERT', 'CBSE', 'Doubtnut', 'Extramarks',
  'CrashCourse', 'Crash Course', 'TED-Ed', 'TED Ed', 'Amoeba Sisters', 'Bozeman Science',
  'National Geographic', 'Peekaboo Kidz', 'Dr. Binocs', 'Dr Binocs', 'Free Animated Education',
  'Science ABC', 'FuseSchool', 'Kurzgesagt', 'SciShow', "It's AumSum", 'AumSum', 'Sprouts',
];

// Trusted image domains (matched as case-insensitive substrings of the source host).
const DEFAULT_IMAGE_DOMAINS = [
  'wikipedia.org', 'wikimedia.org', 'ncert.nic.in', 'nios.ac.in',
  'khanacademy.org', 'kastatic.org', 'byjus.com', 'vedantu.com', 'toppr.com',
  'britannica.com', 'nasa.gov', 'noaa.gov', 'nationalgeographic.com',
  'geeksforgeeks.org', 'ck12.org', 'openstax.org', 'biologydictionary.net',
  'sciencefacts.net', 'sciencing.com', 'study.com', 'fuseschool.org', 'embibe.com',
  'nih.gov', 'nhs.uk',
];

function envList(name) {
  return String(process.env[name] || '').split(',').map((s) => s.trim()).filter(Boolean);
}
function ytChannels() {
  return [...DEFAULT_YT_CHANNELS, ...envList('YOUTUBE_CHANNEL_WHITELIST')];
}
function imageDomains() {
  return [...DEFAULT_IMAGE_DOMAINS, ...envList('IMAGE_DOMAIN_WHITELIST')];
}
function ytStrict() {
  return process.env.YOUTUBE_WHITELIST_STRICT === 'true'; // prefer-trusted by default; opt-in to block
}
function imageStrict() {
  return process.env.IMAGE_WHITELIST_STRICT === 'true'; // prefer-trusted by default; opt-in to block
}

function isTrustedChannel(channelTitle) {
  const t = String(channelTitle || '').toLowerCase();
  return ytChannels().some((w) => t.includes(String(w).toLowerCase()));
}

function hostname(url) {
  const s = String(url || '');
  try {
    return new URL(s).hostname.toLowerCase();
  } catch {
    return s.toLowerCase();
  }
}

/**
 * A Google Custom Search image item is trusted if its source site OR the page it
 * lives on OR the image host matches a whitelisted domain.
 */
function isTrustedImageItem(item) {
  const doms = imageDomains();
  const hosts = [
    String(item && item.displayLink || '').toLowerCase(),
    hostname(item && item.image && item.image.contextLink),
    hostname(item && item.link),
  ].filter(Boolean);
  return hosts.some((h) => doms.some((d) => h.includes(String(d).toLowerCase())));
}

module.exports = {
  isTrustedChannel,
  isTrustedImageItem,
  ytStrict,
  imageStrict,
  ytChannels,
  imageDomains,
  DEFAULT_YT_CHANNELS,
  DEFAULT_IMAGE_DOMAINS,
};
