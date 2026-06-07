#!/usr/bin/env node

/**
 * generate-pdf.mjs — HTML → PDF via Playwright
 *
 * Usage:
 *   node career-ops/generate-pdf.mjs <input.html> <output.pdf> [--format=letter|a4]
 *
 * Requires: @playwright/test (or playwright) installed.
 * Uses Chromium headless to render the HTML and produce a clean, ATS-parseable PDF.
 */

import { chromium } from 'playwright';
import { resolve, dirname, extname } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { PDFParse } from 'pdf-parse';
import { embed, cosine } from './lib/embeddings.mjs';
import { validateParseability, validatePageCount, validatePhoto } from './lib/parse-check.mjs';
import { auditCoverage } from './scripts/audit-coverage.mjs';
import { safeStringify } from './lib/safe-json.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Ensure output directory exists (fresh setup)
mkdirSync(resolve(__dirname, 'output'), { recursive: true });

/**
 * Normalize text for ATS compatibility by converting problematic Unicode.
 *
 * ATS parsers and legacy systems often fail on em-dashes, smart quotes,
 * zero-width characters, and non-breaking spaces. These cause mojibake,
 * parsing errors, or display issues. See issue #1.
 *
 * Only touches body text — preserves CSS, JS, tag attributes, and URLs.
 * Returns { html, replacements } so the caller can log what was changed.
 */
function normalizeTextForATS(html) {
  const replacements = {};
  const bump = (key, n) => { replacements[key] = (replacements[key] || 0) + n; };

  const masks = [];
  const masked = html.replace(
    /<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi,
    (match) => {
      const token = `\u0000MASK${masks.length}\u0000`;
      masks.push(match);
      return token;
    }
  );

  let out = '';
  let i = 0;
  while (i < masked.length) {
    const lt = masked.indexOf('<', i);
    if (lt === -1) { out += sanitizeText(masked.slice(i)); break; }
    out += sanitizeText(masked.slice(i, lt));
    const gt = masked.indexOf('>', lt);
    if (gt === -1) { out += masked.slice(lt); break; }
    out += masked.slice(lt, gt + 1);
    i = gt + 1;
  }

  const restored = out.replace(/\u0000MASK(\d+)\u0000/g, (_, n) => masks[Number(n)]);
  return { html: restored, replacements };

  function sanitizeText(text) {
    if (!text) return text;
    let t = text;
    t = t.replace(/\u2014/g, () => { bump('em-dash', 1); return '-'; });
    t = t.replace(/\u2013/g, () => { bump('en-dash', 1); return '-'; });
    t = t.replace(/[\u201C\u201D\u201E\u201F]/g, () => { bump('smart-double-quote', 1); return '"'; });
    t = t.replace(/[\u2018\u2019\u201A\u201B]/g, () => { bump('smart-single-quote', 1); return "'"; });
    t = t.replace(/\u2026/g, () => { bump('ellipsis', 1); return '...'; });
    t = t.replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, () => { bump('zero-width', 1); return ''; });
    t = t.replace(/\u00A0/g, () => { bump('nbsp', 1); return ' '; });
    return t;
  }
}

const SIMILARITY_THRESHOLD = 0.75;

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', mdash: ' ', ndash: ' ', middot: ' ',
  rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"',
  euro: '€', copy: '©', reg: '®', trade: '™',
  hellip: '...', bull: '·', rarr: '→', larr: '←',
  auml: 'ä', Auml: 'Ä', ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü',
  szlig: 'ß', eacute: 'é', Eacute: 'É', ecirc: 'ê', egrave: 'è',
  iacute: 'í', icirc: 'î', oacute: 'ó', ocirc: 'ô', uacute: 'ú',
  ccedil: 'ç', Ccedil: 'Ç', ntilde: 'ñ', Ntilde: 'Ñ',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', aring: 'å',
};

function decodeHtmlEntities(str) {
  return str
    .replace(/&([a-zA-Z]+);/g, (m, name) => HTML_ENTITIES[name.toLowerCase()] ?? ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

async function extractTextFromFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    const buf = await readFile(filePath);
    const parser = new PDFParse({ data: buf });
    await parser.load();
    const result = await parser.getText();
    return result.text;
  }
  const raw = await readFile(filePath, 'utf-8');
  if (ext === '.html' || ext === '.htm') {
    return decodeHtmlEntities(
      raw
        .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    ).replace(/\s+/g, ' ').trim();
  }
  return raw;
}

async function mergeMetaJson(metaPath, patch) {
  let existing = {};
  if (existsSync(metaPath)) {
    try { existing = JSON.parse(await readFile(metaPath, 'utf-8')); } catch {}
  }
  await writeFile(metaPath, safeStringify({ ...existing, ...patch }, 2));
}

async function generatePDF() {
  const args = process.argv.slice(2);

  // Parse arguments
  let inputPath, outputPath, format = 'a4', jdPath = null, briefPath = null, photoPolicy = null;

  for (const arg of args) {
    if (arg.startsWith('--format=')) {
      format = arg.split('=')[1].toLowerCase();
    } else if (arg.startsWith('--jd=')) {
      jdPath = arg.slice(5);
    } else if (arg.startsWith('--brief=')) {
      briefPath = arg.slice(8);
    } else if (arg.startsWith('--photo-policy=')) {
      photoPolicy = arg.slice(15).toLowerCase();
    } else if (!inputPath) {
      inputPath = arg;
    } else if (!outputPath) {
      outputPath = arg;
    }
  }

  // Photo policy: --photo-policy flag overrides; fallback to brief.json; default exclude
  if (!photoPolicy && briefPath) {
    try {
      const brief = JSON.parse(await readFile(resolve(briefPath), 'utf-8'));
      photoPolicy = brief.photo_policy ?? 'exclude';
    } catch { photoPolicy = 'exclude'; }
  }
  if (!photoPolicy) photoPolicy = 'exclude';

  if (!inputPath || !outputPath) {
    console.error('Usage: node generate-pdf.mjs <input.html> <output.pdf> [--format=letter|a4]');
    process.exit(1);
  }

  inputPath = resolve(inputPath);
  outputPath = resolve(outputPath);

  // Validate format
  const validFormats = ['a4', 'letter'];
  if (!validFormats.includes(format)) {
    console.error(`Invalid format "${format}". Use: ${validFormats.join(', ')}`);
    process.exit(1);
  }

  console.log(`📄 Input:  ${inputPath}`);
  console.log(`📁 Output: ${outputPath}`);
  console.log(`📏 Format: ${format.toUpperCase()}`);

  // Read HTML to inject font paths as absolute file:// URLs
  let html = await readFile(inputPath, 'utf-8');

  // Resolve font paths relative to career-ops/fonts/
  const fontsDir = resolve(__dirname, 'fonts');
  html = html.replace(
    /url\(['"]?\.\/fonts\//g,
    `url('file://${fontsDir}/`
  );
  // Close any unclosed quotes from the replacement (handles all font formats)
  html = html.replace(
    /file:\/\/([^'")]+)\.(woff2?|ttf|otf)['"]?\)/g,
    `file://$1.$2')`
  );

  // Normalize text for ATS compatibility (issue #1)
  const normalized = normalizeTextForATS(html);
  html = normalized.html;
  const totalReplacements = Object.values(normalized.replacements).reduce((a, b) => a + b, 0);
  if (totalReplacements > 0) {
    const breakdown = Object.entries(normalized.replacements).map(([k, v]) => `${k}=${v}`).join(', ');
    console.log(`🧹 ATS normalization: ${totalReplacements} replacements (${breakdown})`);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    // Set content with file base URL for any relative resources
    await page.setContent(html, {
      waitUntil: 'networkidle',
      baseURL: `file://${dirname(inputPath)}/`,
    });

    // Wait for fonts to load
    await page.evaluate(() => document.fonts.ready);

    // Generate PDF
    const pdfBuffer = await page.pdf({
      format: format,
      printBackground: true,
      margin: {
        top: '0.6in',
        right: '0.6in',
        bottom: '0.6in',
        left: '0.6in',
      },
      preferCSSPageSize: false,
    });

    // Write PDF
    await writeFile(outputPath, pdfBuffer);

    // Page count guard
    const pageCountResult = await validatePageCount(outputPath, 3);
    const { page_count: pageCount } = pageCountResult;

    console.log(`✅ PDF generated: ${outputPath}`);
    console.log(`📊 Pages: ${pageCount}`);
    console.log(`📦 Size: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);

    if (!pageCountResult.pass) {
      console.warn(`\n⚠️  PAGE COUNT WARNING: ${pageCountResult.issue}`);
      console.warn(`   Review the CV layout — check for missing page breaks or excess content.`);
      console.warn(`   Generation continues but the PDF needs manual review before sending.\n`);
    }

    // Similarity scoring
    const metaPath = outputPath.replace(/\.pdf$/, '.meta.json');
    if (jdPath) {
      try {
        const jdText = await extractTextFromFile(resolve(jdPath));
        const cvText = decodeHtmlEntities(
          html
            .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
        ).replace(/\s+/g, ' ').trim();
        const [jdVec, cvVec] = await Promise.all([embed(jdText), embed(cvText)]);
        const score = parseFloat(cosine(jdVec, cvVec).toFixed(3));
        const pass = score >= SIMILARITY_THRESHOLD;
        await mergeMetaJson(metaPath, { similarity: { score, pass } });
        const flag = pass ? '✅' : '⚠️ BELOW THRESHOLD';
        console.log(`📐 Similarity: ${score} (threshold ${SIMILARITY_THRESHOLD}) ${flag}`);
        if (!pass) console.warn(`   Review CV — similarity ${score} < ${SIMILARITY_THRESHOLD}`);
      } catch (err) {
        console.warn(`⚠️  Similarity scoring failed: ${err.message}`);
      }
    } else {
      console.log(`ℹ️  No --jd= provided; skipping similarity scoring`);
    }

    // Coverage audit
    if (briefPath) {
      try {
        const coverage = await auditCoverage(resolve(briefPath), outputPath);
        await mergeMetaJson(metaPath, { coverage });
        const t1 = coverage.tier1;
        if (t1.missing.length > 0) {
          console.warn(`⚠️  Coverage: Tier-1 missing (${t1.missing.length}): ${t1.missing.map(k => `"${k}"`).join(', ')}`);
        } else {
          console.log(`✅ Coverage: Tier-1 ${Math.round(t1.coverage * 100)}% · Tier-2 ${Math.round(coverage.tier2.coverage * 100)}%`);
        }
      } catch (err) {
        console.warn(`⚠️  Coverage audit failed: ${err.message}`);
      }
    }

    // Photo policy — validate and generate no-photo variant if needed
    const photoPath = resolve(__dirname, 'data/corpus/identity/photo.jpg');
    if (photoPolicy === 'include') {
      const photoResult = await validatePhoto(photoPath);
      if (!photoResult.pass) {
        console.warn(`⚠️  Photo validation failed:`);
        for (const issue of photoResult.issues.filter(i => !i.startsWith('Warning:'))) {
          console.warn(`   • ${issue}`);
        }
        if (photoResult.skip_generation) {
          console.warn(`   Skipping photo — continuing with no-photo version only.`);
          photoPolicy = 'exclude';
        }
      }
      for (const w of (photoResult.issues || []).filter(i => i.startsWith('Warning:'))) {
        console.log(`   ℹ️  ${w}`);
      }

      // Generate no-photo variant alongside the canonical (with-photo) version
      if (!photoResult.skip_generation) {
        const noPhotoPath = outputPath.replace(/\.pdf$/, '-no-photo.pdf');
        const htmlNoPhoto = html.replace(/<img[^>]+class="[^"]*cv-photo[^"]*"[^>]*>/gi, '');
        const page2 = await browser.newPage();
        try {
          await page2.setContent(htmlNoPhoto, { waitUntil: 'networkidle', baseURL: `file://${dirname(inputPath)}/` });
          await page2.evaluate(() => document.fonts.ready);
          const pdfNoPhoto = await page2.pdf({ format, printBackground: true, margin: { top: '0.6in', right: '0.6in', bottom: '0.6in', left: '0.6in' }, preferCSSPageSize: false });
          await writeFile(noPhotoPath, pdfNoPhoto);
          console.log(`📷 No-photo variant: ${noPhotoPath}`);
        } finally {
          await page2.close();
        }
      }
    }
    await mergeMetaJson(metaPath, { photo_policy: photoPolicy });

    // Persist page count to meta.json
    await mergeMetaJson(metaPath, { page_count: pageCountResult });

    // Parseability validation
    try {
      const parseResult = await validateParseability(outputPath);
      await mergeMetaJson(metaPath, { parseability: parseResult });
      if (parseResult.pass) {
        console.log(`✅ Parseability: pass`);
      } else {
        const failingIssues = parseResult.issues.filter(i => !i.startsWith('Warning:'));
        console.warn(`⚠️  Parseability FAILED (${failingIssues.length} issue${failingIssues.length > 1 ? 's' : ''}):`);
        for (const issue of failingIssues) console.warn(`   • ${issue}`);
      }
      const warnings = parseResult.issues.filter(i => i.startsWith('Warning:'));
      for (const w of warnings) console.log(`   ℹ️  ${w}`);
    } catch (err) {
      console.warn(`⚠️  Parseability check failed: ${err.message}`);
    }

    return { outputPath, pageCount, size: pdfBuffer.length };
  } finally {
    await browser.close();
  }
}

generatePDF().catch((err) => {
  console.error('❌ PDF generation failed:', err.message);
  process.exit(1);
});
