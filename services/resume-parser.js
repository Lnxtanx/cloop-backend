/**
 * In-Memory Resume / CV Text Extraction Service
 * 
 * Extracts plain text from PDF, DOCX, and TXT files held in memory.
 * No files are saved to S3 or local disk.
 */

/**
 * Extracts plain text from a file buffer based on mimetype or file extension.
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
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buffer);
      rawText = data.text || '';
    } catch (err) {
      console.error('[ResumeParser] Error extracting PDF text:', err.message);
      throw new Error('Failed to parse PDF document. Please ensure it is not password protected.');
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
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buffer);
      rawText = data.text || '';
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
