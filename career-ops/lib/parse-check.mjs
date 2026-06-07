import { readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { PDFParse } from 'pdf-parse';

const SECTION_PATTERNS = {
  summary:          /\b(summary|professional summary|profil|zusammenfassung)\b/i,
  experience:       /\b(experience|professional experience|berufserfahrung)\b/i,
  skills:           /\b(skills|core competencies|kompetenzen|f[äa]higkeiten)\b/i,
  education:        /\b(education|ausbildung)\b/i,
  certifications:   /\b(certifications?|zertifikate)\b/i,
};

// Matches: 2018–2022 | 2018-Present | 01/2018–12/2022 | Mar 2020 - Nov 2024 | 2022–Heute
const DATE_RANGE_RE = /(?:\d{2}\/|[A-Z][a-z]{2,8}\s+)?(19|20)\d{2}\s*[-–—]\s*(?:(?:\d{2}\/|[A-Z][a-z]{2,8}\s+)?(19|20)\d{2}|[Pp]resent|[Cc]urrent|[Hh]eute|[Ll]aufend)/g;
const EMAIL_RE      = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE      = /\+?\d[\d\s\-().]{7,15}\d/g;
// U+FFFD replacement characters (classic mojibake)
const MOJIBAKE_REPLACEMENT_RE = /�{3,}/;

// CP437 garbling of common UTF-8 multi-byte sequences.
// UTF-8 bytes read through CP437 produce these specific character triples:
//   € (U+20AC, UTF-8 E2 82 AC) → Γé¼  (CP437: E2=Γ, 82=é, AC=¼)
//   — (U+2014, UTF-8 E2 80 94) → ΓÇö  (CP437: E2=Γ, 80=Ç, 94=ö)
//   – (U+2013, UTF-8 E2 80 93) → ΓÇô  (CP437: E2=Γ, 80=Ç, 93=ô)
//   " (U+201C, UTF-8 E2 80 9C) → ΓÇ£  (CP437: E2=Γ, 80=Ç, 9C=£)
const MOJIBAKE_CP437_RE = /Γ[éÇ][¼öô£]|â[€][¬]/;

function hasMojibake(text) {
  return MOJIBAKE_REPLACEMENT_RE.test(text) || MOJIBAKE_CP437_RE.test(text);
}

export async function validateParseability(pdfPath) {
  const issues = [];
  const sections = {};

  // Check 1: extract text
  let text;
  try {
    const buf = await readFile(pdfPath);
    const parser = new PDFParse({ data: buf });
    await parser.load();
    const result = await parser.getText();
    text = result.text ?? '';
  } catch (err) {
    return { pass: false, issues: [`PDF text extraction failed: ${err.message}`], sections: {} };
  }

  if (text.trim().length === 0) {
    return { pass: false, issues: ['PDF has no selectable text layer (image-only or corrupt)'], sections: {} };
  }

  // Check 2: required section headers
  for (const [key, pattern] of Object.entries(SECTION_PATTERNS)) {
    sections[key] = pattern.test(text);
  }
  for (const sec of ['summary', 'experience', 'skills', 'education']) {
    if (!sections[sec]) issues.push(`Missing required section: "${sec}"`);
  }
  if (!sections.certifications) {
    issues.push('Warning: certifications section not detected (optional)');
  }

  // Check 3: at least 3 dated job entries
  const dateMatches = [...text.matchAll(DATE_RANGE_RE)];
  if (dateMatches.length < 3) {
    issues.push(`Only ${dateMatches.length} dated job entr${dateMatches.length === 1 ? 'y' : 'ies'} found (need ≥ 3)`);
  }

  // Check 4: email exactly once, phone at least once
  const emails = [...new Set((text.match(EMAIL_RE) || []))];
  if (emails.length === 0) {
    issues.push('No email address detected');
  } else if (emails.length > 1) {
    issues.push(`Multiple distinct email addresses: ${emails.join(', ')}`);
  }

  const phones = text.match(PHONE_RE) || [];
  if (phones.length === 0) {
    issues.push('No phone number detected');
  }

  // Check 5: mojibake — U+FFFD replacements or CP437-garbled UTF-8 sequences
  if (hasMojibake(text)) {
    const which = MOJIBAKE_REPLACEMENT_RE.test(text)
      ? 'U+FFFD replacement characters'
      : 'CP437-garbled UTF-8 sequences (e.g. Γé¼ for €, ΓÇö for —)';
    issues.push(`Mojibake detected: ${which} — font-encoding failure`);
  }

  const failingIssues = issues.filter(i => !i.startsWith('Warning:'));
  return { pass: failingIssues.length === 0, issues, sections };
}

// ── validatePhoto ─────────────────────────────────────────────────────
// Validates photo.jpg before embedding in CV. Called when photo_policy=include.
// Uses sharp for dimension/aspect checks if available; falls back to size-only.

export async function validatePhoto(photoPath) {
  const issues = [];

  if (!existsSync(photoPath)) {
    return { pass: false, issues: [`Photo file not found: ${photoPath}`], skip_generation: true };
  }

  const fileStat = await stat(photoPath);
  const sizeKB = fileStat.size / 1024;

  if (fileStat.size > 2 * 1024 * 1024) {
    issues.push(`Photo too large: ${Math.round(sizeKB)}KB (max 2048KB) — resize before use`);
  } else if (sizeKB > 500) {
    issues.push(`Warning: photo is ${Math.round(sizeKB)}KB (recommended <500KB)`);
  }

  // Format check via magic bytes (JPG: FF D8 FF; PNG: 89 50 4E 47)
  const header = Buffer.alloc(4);
  const fd = await readFile(photoPath);
  fd.copy(header, 0, 0, 4);
  const isJpg = header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF;
  const isPng = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47;
  if (!isJpg && !isPng) {
    issues.push('Photo must be JPG or PNG format');
  }

  // Dimension and aspect ratio — try sharp; skip if not available
  try {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(photoPath).metadata();
    const { width = 0, height = 0 } = meta;
    if (width < 200 || height < 250) {
      issues.push(`Photo too small: ${width}×${height}px (minimum 200×250)`);
    }
    if (width > 800 || height > 1000) {
      issues.push(`Photo too large: ${width}×${height}px (maximum 800×1000)`);
    }
    if (width >= height) {
      issues.push(`Photo must be portrait orientation (taller than wide); got ${width}×${height}`);
    }
  } catch {
    issues.push('Warning: sharp not available — dimension/aspect ratio not checked');
  }

  const failingIssues = issues.filter(i => !i.startsWith('Warning:'));
  return { pass: failingIssues.length === 0, issues, skip_generation: false };
}

// ── validatePageCount ─────────────────────────────────────────────────
// Counts pages using the same regex-on-buffer approach used in generate-pdf.mjs
// (proven reliable; avoids an extra pdf-parse decode pass).

export async function validatePageCount(pdfPath, maxPages = 3) {
  const buf = await readFile(pdfPath);
  const pdfString = buf.toString('latin1');
  const pageCount = (pdfString.match(/\/Type\s*\/Page[^s]/g) || []).length;
  return {
    pass: pageCount <= maxPages,
    page_count: pageCount,
    max_allowed: maxPages,
    issue: pageCount > maxPages
      ? `PDF has ${pageCount} pages — max allowed is ${maxPages}`
      : null,
  };
}
