#!/usr/bin/env node
/**
 * Verify that every bullet from cv.md is present verbatim in data/corpus/roles/*.md
 * Also checks all corpus files for CP437/Latin-1 mojibake sequences.
 *
 * Usage:
 *   node scripts/verify-corpus-completeness.mjs --against cv.md
 *   node scripts/verify-corpus-completeness.mjs --mojibake-only
 */
import { readdir } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readText } from '../lib/safe-fs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Mojibake detection ────────────────────────────────────────────────
//
// These are SEQUENCES, not individual characters.  Individual Latin chars
// like é (U+00E9) or ö (U+00F6) are legitimate in French loanwords and
// German text.  The sequences below can ONLY appear when UTF-8 bytes were
// misread as CP437 or Latin-1/Windows-1252.
//
// CP437 mojibake (UTF-8 multi-byte sequences misread byte-by-byte as CP437):
//   ü  UTF-8 0xC3 0xBC → CP437 ├╝
//   ö  UTF-8 0xC3 0xB6 → CP437 ├╢
//   ä  UTF-8 0xC3 0xA4 → CP437 ├ñ
//   Ü  UTF-8 0xC3 0x9C → CP437 ├£
//   Ö  UTF-8 0xC3 0x96 → CP437 ├û  (approx — varies by CP437 variant)
//   €  UTF-8 0xE2 0x82 0xAC → CP437 Γé¼
//   —  UTF-8 0xE2 0x80 0x94 → CP437 ΓÇö
//   –  UTF-8 0xE2 0x80 0x93 → CP437 ΓÇô
//   "  UTF-8 0xE2 0x80 0x9C → CP437 ΓÇ£
//   "  UTF-8 0xE2 0x80 0x9D → CP437 ΓÇ¥
//   '  UTF-8 0xE2 0x80 0x98 → CP437 ΓÇÿ
//   Türkiye: T + ├╝ + rkiye  (most specific real-world pattern)
//
// Latin-1 / Windows-1252 mojibake (UTF-8 C3-prefix chars misread as latin-1):
//   ü  UTF-8 0xC3 0xBC → latin-1 Ã¼
//   ö  UTF-8 0xC3 0xB6 → latin-1 Ã¶
//   ä  UTF-8 0xC3 0xA4 → latin-1 Ã¤
//   é  UTF-8 0xC3 0xA9 → latin-1 Ã©
//   Türkiye → TÃ¼rkiye

const MOJIBAKE_SEQUENCES = [
  // CP437 sequences
  '├╝',    // ü
  '├╢',    // ö
  '├ñ',    // ä
  '├£',    // Ü
  'Γé¼',   // €
  'ΓÇö',   // —
  'ΓÇô',   // –
  'ΓÇ£',   // "
  'ΓÇ¥',   // "
  'ΓÇÿ',   // '
  // Latin-1 sequences
  'Ã¼',    // ü
  'Ã¶',    // ö
  'Ã¤',    // ä
  'Ã©',    // é
  'TÃ¼rkiye', // Türkiye (most specific)
];

const CORPUS_DIRS = [
  'data/corpus/roles',
  'data/corpus/narrative',
  'data/corpus/identity',
  'data/corpus/achievements',
  'data/corpus/skills',
  'data/corpus/education',
  'data/corpus/languages-de',
];

// ── Mojibake scan ─────────────────────────────────────────────────────

async function scanMojibake() {
  let totalFiles = 0;
  let totalHits  = 0;
  const failures = [];

  for (const dir of CORPUS_DIRS) {
    const absDir = resolve(ROOT, dir);
    let files;
    try { files = await readdir(absDir); } catch { continue; }

    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const p    = join(absDir, f);
      const text = await readText(p);
      totalFiles++;

      for (const seq of MOJIBAKE_SEQUENCES) {
        if (text.includes(seq)) {
          const relPath = join(dir, f).replace(/\\/g, '/');
          failures.push({ file: relPath, sequence: seq });
          totalHits++;
        }
      }
    }
  }

  return { totalFiles, totalHits, failures };
}

// ── Bullet completeness check ─────────────────────────────────────────

function parseBulletsFromCV(markdown) {
  const bullets = [];
  const lines = markdown.split('\n');
  let inExperience = false;

  for (const line of lines) {
    if (/^## Experience/.test(line)) { inExperience = true;  continue; }
    if (/^## /.test(line) && inExperience) { inExperience = false; continue; }
    if (inExperience && line.startsWith('- ')) {
      const text = line.slice(2).trim();
      if (text.length > 15) bullets.push(text);
    }
  }
  return bullets;
}

async function checkCompleteness() {
  const cvPath  = resolve(ROOT, 'cv.md');
  const rolesDir = resolve(ROOT, 'data/corpus/roles');

  const cvText  = await readText(cvPath);
  const cvBullets = parseBulletsFromCV(cvText);

  const roleFiles = (await readdir(rolesDir)).filter(f => f.endsWith('.md') && !f.startsWith('_'));
  let corpusText = '';
  for (const f of roleFiles) corpusText += await readText(join(rolesDir, f)) + '\n';

  const missing = cvBullets.filter(b => !corpusText.includes(b));
  return { cv_bullets_total: cvBullets.length, found_in_corpus: cvBullets.length - missing.length, missing_count: missing.length, missing_bullets: missing };
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const mojiOnly = process.argv.includes('--mojibake-only');

  // Always run mojibake scan
  const moji = await scanMojibake();
  if (moji.failures.length > 0) {
    process.stderr.write(`✗ MOJIBAKE detected in ${moji.failures.length} file/sequence pair(s):\n`);
    for (const { file, sequence } of moji.failures) {
      process.stderr.write(`  ${file}: "${sequence}"\n`);
    }
  } else {
    process.stderr.write(`✓ Mojibake scan clean — ${moji.totalFiles} files, 0 matches.\n`);
  }

  if (mojiOnly) {
    process.exit(moji.failures.length > 0 ? 1 : 0);
  }

  // Bullet completeness
  const result = await checkCompleteness();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (result.missing_count === 0) {
    process.stderr.write(`✓ All ${result.cv_bullets_total} cv.md bullets present in corpus roles.\n`);
  } else {
    process.stderr.write(`✗ ${result.missing_count} bullets from cv.md NOT found in corpus roles:\n`);
    for (const b of result.missing_bullets) {
      process.stderr.write(`  - ${b.slice(0, 80)}…\n`);
    }
  }

  const exitCode = (moji.failures.length > 0 || result.missing_count > 0) ? 1 : 0;
  process.exit(exitCode);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
