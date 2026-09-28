/**
 * In-Memory Resume / CV Text Extraction Service
 * 
 * Extracts plain text from PDF, DOCX, and TXT files held in memory.
 * No files are saved to S3 or local disk.
 */

/**
 * Extract plain text from a PDF buffer.
 *
 * Supports both pdf-parse module shapes:
 *   v1.x — module.exports is the function itself:  await pdfParse(buffer)
 *   v2.x — module.exports is an object exposing PDFParse:
 *          new PDFParse({ data }).getText() -> { text }
 *
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function extractPdfText(buffer) {
  const mod = require('pdf-parse')

  if (typeof mod === 'function') {
    const data = await mod(buffer)
    return (data && data.text) || ''
  }

  if (mod && typeof mod.PDFParse === 'function') {
    const parser = new mod.PDFParse({ data: buffer })
    try {
      const result = await parser.getText()
      return (result && result.text) || ''
    } finally {
      try {
        await parser.destroy()
      } catch {
        // best-effort cleanup of the internal worker
      }
    }
  }

  throw new Error('Unrecognised pdf-parse module shape')
}

/**
 * True only for a genuinely password-protected PDF, so we do not blame the
 * user's file when the real problem is something else entirely.
 */
function isPasswordError(err) {
  if (!err) return false
  const name = err.name || (err.cause && err.cause.name)
  if (name === 'PasswordException') return true
  return /password|encrypted/i.test(String(err.message || ''))
}

/**
 * Extract plain text from a file buffer based on mimetype or file extension.
 * 
 * @param {Buffer} buffer - File buffer from multer memory storage
 * @param {string} mimetype - File mimetype (e.g. 'application/pdf')
 * @param {string} originalName - Original file name (e.g. 'my_resume.pdf')
 * @returns {Promise<string>} - Extracted, normalized text
 */
async function extractResumeText(buffer, mimetype = '', originalName = '') {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('Invalid file buffer provided');
  }

  const nameLower = (originalName || '').toLowerCase();
  const mimeLower = (mimetype || '').toLowerCase();

  let rawText = '';

  // 1. PDF Documents
  if (mimeLower.includes('pdf') || nameLower.endsWith('.pdf')) {
    try {
      rawText = await extractPdfText(buffer);
    } catch (err) {
      console.error('[ResumeParser] Error extracting PDF text:', err && err.message);
      if (isPasswordError(err)) {
        throw new Error('This PDF is password protected. Please remove the password and upload it again.');
      }
      throw new Error('Could not read this PDF. It may be corrupted or contain no selectable text — try re-saving it, or upload a DOCX/TXT version.');
    }
  }
  // 2. DOCX Documents (Word)
  else if (
    mimeLower.includes('wordprocessingml') ||
    mimeLower.includes('msword') ||
    nameLower.endsWith('.docx')
  ) {
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      rawText = result.value || '';
    } catch (err) {
      console.error('[ResumeParser] Error extracting DOCX text:', err.message);
      throw new Error('Failed to parse Word document.');
    }
  }
  // 3. Plain Text / Markdown
  else if (
    mimeLower.includes('text') ||
    nameLower.endsWith('.txt') ||
    nameLower.endsWith('.md')
  ) {
    try {
      rawText = buffer.toString('utf-8');
    } catch (err) {
      console.error('[ResumeParser] Error reading text file:', err.message);
      throw new Error('Failed to read text file.');
    }
  } else {
    // Attempt PDF first as common fallback if unknown mimetype, else string
    try {
      rawText = await extractPdfText(buffer);
    } catch {
      rawText = buffer.toString('utf-8');
    }
  }

  // Normalize whitespace: collapse multiple blank lines and tabs
  let cleaned = rawText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!cleaned || cleaned.length < 20) {
    throw new Error('Could not extract readable text from the uploaded file. Please ensure it is not a scanned image.');
  }

  // Cap length to ~12,000 characters (sufficient for 1-3 page resumes)
  if (cleaned.length > 12000) {
    cleaned = cleaned.substring(0, 12000) + '\n...[truncated for length]';
  }

  return cleaned;
}

module.exports = {
  extractResumeText,
};
