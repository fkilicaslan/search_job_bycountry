#!/usr/bin/env node
/**
 * audit-anonymization.mjs — Corpus-wide anonymization guard.
 *
 * Walks all data/corpus/**\/*.md files.
 *   cv_bound: false  → skip (interview prep / docs; real names intentional)
 *   cv_bound: true   → scan (default when field is missing)
 *
 * Two violation types:
 *   stop_word          — Türkiye / Turkey / Turkish in body content
 *   client_original_name — original client names from market-descriptors.yml
 *                          where anonymize: true
 *
 * Body exclusions (never flagged):
 *   - YAML frontmatter block (between --- delimiters)
 *   - H1 headings (lines starting with # followed by space)
 *   - Role date/location header lines (**date | location** bold format)
 *   - Whitelisted legal entity names (for stop_word check only)
 *
 * Exit 0: clean. Exit 1: one or more violations found.
 *
 * Output (stdout): JSON  { anonymization_findings, total, files_scanned,
 *                           files_skipped_cv_bound_false }
 * Human summary (stderr).
 */
import { readdir } from 'fs/promises';
import { resolve, dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import jsyaml from 'js-yaml';
import { readText } from '../lib/safe-fs.mjs';
import { safeStringify } from '../lib/safe-json.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const CORPUS    = resolve(ROOT, 'data/corpus');
const DESC_PATH = join(CORPUS, 'identity/market-descriptors.yml');

// ── Stop-word config ──────────────────────────────────────────────────

// Phrases stripped before the stop-word check so they don't trigger false positives.
// Covers legal entity names AND canonical patterns where a stop word is not geographic context.
const ANON_WHITELIST  = [
  'adesso Turkey Ltd.',
  'adesso Turkey',
  'BMW Türkiye',
  '| Turkish |',   // language table row — language name, not a geographic reference
];
const ANON_STOP_WORDS = ['Türkiye', 'Turkey', 'Turkish'];

function cleanWhitelist(text) {
  let s = text;
  for (const phrase of ANON_WHITELIST) s = s.split(phrase).join('');
  return s;
}

function matchedStopWord(line) {
  const cleaned = cleanWhitelist(line);
  return ANON_STOP_WORDS.find(sw => cleaned.includes(sw)) ?? null;
}

// ── Line-type exclusions ──────────────────────────────────────────────

function isH1Line(line) {
  return line.trimStart().startsWith('# ');
}

function isLocationHeaderLine(line) {
  const t = line.trim();
  // Role date/location headers: **Mar 2020 – Nov 2024 | Istanbul, Türkiye**
  const isRoleHeader = /^\*\*[^*]+\|\s*[^*]+\*\*/.test(t) && /\d{4}/.test(t);
  // Degree/education location lines: **University Name** | City, Türkiye | YYYY–YYYY
  // Bold wraps the institution name; pipe-separated city and year follow.
  const isDegreeHeader = /^\*\*[^*]+\*\*\s*\|/.test(t) && /\d{4}/.test(t);
  return isRoleHeader || isDegreeHeader;
}

// ── Recursive file walker ─────────────────────────────────────────────

async function walkAll(dir, acc = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) await walkAll(abs, acc);
    else if (e.name.endsWith('.md')) acc.push(abs);
  }
  return acc;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  // Load market-descriptors
  let descriptors;
  try {
    descriptors = jsyaml.load(await readText(DESC_PATH));
  } catch (err) {
    process.stderr.write(`✗ Cannot load market-descriptors.yml: ${err.message}\n`);
    process.exit(1);
  }

  // Build client-name check list: entries where anonymize: true
  const clientEntries = Object.entries(descriptors)
    .filter(([, v]) => v && typeof v === 'object' && v.anonymize === true)
    .map(([, v]) => ({ original_name: v.original_name, should_use: v.descriptor_quantified }))
    .filter(e => e.original_name);

  const allFiles = await walkAll(CORPUS);
  const findings = [];
  let scanned = 0;
  let skipped = 0;

  for (const abs of allFiles) {
    const raw = await readText(abs);
    const { data: fm } = matter(raw);

    // cv_bound: false → skip; missing → default true
    if (fm.cv_bound === false) { skipped++; continue; }
    scanned++;

    const rel      = relative(ROOT, abs).replace(/\\/g, '/');
    const rawLines = raw.split('\n');

    // Locate end of frontmatter (second --- line) for absolute line numbering
    let fmEndIdx = 0;
    if (rawLines.length > 0 && rawLines[0].trim() === '---') {
      for (let i = 1; i < rawLines.length; i++) {
        if (rawLines[i].trim() === '---') { fmEndIdx = i; break; }
      }
    }

    // Scan body lines with absolute (1-based) line numbers
    for (let i = fmEndIdx + 1; i < rawLines.length; i++) {
      const line = rawLines[i];

      if (isH1Line(line))             continue;
      if (isLocationHeaderLine(line)) continue;

      // Check 1: stop words
      const sw = matchedStopWord(line);
      if (sw) {
        findings.push({ file: rel, line: i + 1, violation: 'stop_word', match: sw });
      }

      // Check 2: client original names
      for (const { original_name, should_use } of clientEntries) {
        if (line.includes(original_name)) {
          findings.push({ file: rel, line: i + 1, violation: 'client_original_name',
            match: original_name, should_use });
        }
      }
    }
  }

  process.stdout.write(safeStringify({
    anonymization_findings: findings,
    total: findings.length,
    files_scanned: scanned,
    files_skipped_cv_bound_false: skipped,
  }, 2) + '\n');

  if (findings.length === 0) {
    process.stderr.write(
      `✓ PASS — anonymization clean. ${scanned} file(s) scanned, ` +
      `${skipped} skipped (cv_bound: false).\n`
    );
    process.exit(0);
  } else {
    process.stderr.write(`✗ FAIL — ${findings.length} finding(s) across ${scanned} scanned files:\n`);
    for (const f of findings) {
      const detail = f.should_use ? ` → use: "${f.should_use}"` : '';
      process.stderr.write(
        `  ${f.file}:${f.line}  [${f.violation}] "${f.match}"${detail}\n`
      );
    }
    process.exit(1);
  }
}

main().catch(err => { process.stderr.write(`Error: ${err.message}\n`); process.exit(1); });
