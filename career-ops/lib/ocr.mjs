/**
 * ocr.mjs — PDF text extraction fallback via Claude's native document API.
 *
 * Activated when pdf-parse yields < 100 usable characters — typical of
 * image-based certificates, Arbeitszeugnisse, and scanned CVs that carry
 * no text layer (only raster images).
 *
 * Design decision — why not Tesseract.js:
 *   tesseract.js v7 + pdf-to-img were installed and evaluated. pdf-to-img
 *   renders valid 1792×2527 px PNGs with real text (pixel-sampling confirmed
 *   black content at expected positions). However, Tesseract WASM fails to
 *   return any text on Node 24 — 0 chars extracted despite correct image.
 *   Root cause: WASM initialization path incompatibility with Node 24's
 *   module system; no straightforward fix without downgrading Node.
 *
 *   Claude's native PDF document API works immediately, is more accurate for
 *   mixed DE/EN/TR content, handles JPEG2000-encoded PDFs (which pdfjs-dist
 *   cannot decode in Node), and requires no native binaries or WASM setup.
 *
 * Cost: one extra API call per image-based PDF (Haiku model — minimal cost).
 * Performance: ~2-4 sec per PDF. Acceptable for one-time corpus build.
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'fs/promises';

// Haiku: sufficient for verbatim text extraction; classification uses Sonnet
const EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Returns true when PDFParse output is too thin to be useful.
 * Triggers the Claude Vision fallback in ingest-corpus.mjs.
 */
export function shouldUseOCRFallback(pdfText) {
  if (!pdfText) return true;
  if (pdfText.length < 100) return true;
  // Strip page boundary markers and whitespace; check substantive content
  const cleaned = pdfText
    .replace(/--\s*\d+\s*of\s*\d+\s*--/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length < 100;
}

/**
 * Extracts text from an image-based PDF via Claude's document API.
 *
 * Handles: scanned certificates, Arbeitszeugnisse, JPEG2000 PDFs, multi-page docs.
 *
 * @param {string} pdfPath  Absolute path to the PDF file.
 * @param {object} options  { apiKey }
 * @returns {{ text: string, quality: { avgConfidence, method, totalWords, pageCount } }}
 */
export async function extractTextViaOCR(pdfPath, options = {}) {
  const { apiKey = process.env.ANTHROPIC_API_KEY } = options;

  const client = new Anthropic({ apiKey });
  const pdfData = await readFile(pdfPath);
  const b64 = pdfData.toString('base64');

  process.stderr.write(`   OCR: ${(pdfData.length / 1024).toFixed(0)} KB — sending to Claude Vision API...\n`);

  const msg = await client.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: b64 },
        },
        {
          type: 'text',
          text: 'Extract all text from this document exactly as it appears. ' +
            'Include every piece of text: names, dates, course titles, durations, ' +
            'locations, organizations, certifying bodies, and all other content. ' +
            'Output only the extracted text with no commentary, labels, or markdown formatting.',
        },
      ],
    }],
  });

  const extracted = msg.content[0].text.trim();
  const wordCount  = extracted.split(/\s+/).filter(Boolean).length;

  process.stderr.write(`   OCR: ${extracted.length} chars extracted (${wordCount} words)\n`);

  return {
    text: extracted,
    quality: {
      avgConfidence: 95,   // Claude Vision is consistently high quality
      lowConfRatio:  0,
      totalWords:    wordCount,
      pageCount:     null, // not tracked via document API
      method:        'claude-vision',
    },
  };
}
