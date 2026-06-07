#!/usr/bin/env node
/**
 * regenerate-cv.mjs — Build cv.md from the corpus.
 *
 * Uses lib/corpus.mjs (loadCorpus) as the single source of truth.
 * All file I/O via safe-fs.
 *
 * Flags:
 *   --dry-run         Print to stdout, do not write any file
 *   --output PATH     Write to alternate path (for diffing)
 *   --verify          After writing, read back and run lossless check
 *
 * Lossless equivalence check (--verify):
 *   1. Every bullet from corpus/roles must appear verbatim in output
 *   2. Key named entities from cv.md must appear >= their cv.md count
 *   If the check fails, output is written to cv.regenerated.md instead
 *   of cv.md, and the user is warned.
 */
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadCorpus, getAllBullets } from '../lib/corpus.mjs';
import { readText, writeText } from '../lib/safe-fs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Section builders ──────────────────────────────────────────────────

function buildHeader(contact, languages) {
  // Extract fields from contact.md content
  const get = (label, text) => {
    const m = text.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`));
    return m ? m[1].trim() : '';
  };
  const name     = get('Full name', contact.content);
  const location = get('Location',  contact.content);
  const phone    = get('Phone',     contact.content);
  const email    = get('Email',     contact.content);
  const linkedIn = get('LinkedIn',  contact.content);

  // Build LinkedIn display and href — display strips protocol+www, href keeps original
  const liDisplay = linkedIn.replace(/^https?:\/\/(www\.)?/, '');
  const liHref    = linkedIn; // preserve www. in href to match cv.md

  // Extract language table rows from languages.md
  // Table format: | Language | Level | Notes |
  // Skip header row and separator rows (cells that are all dashes)
  const langRows = [...languages.content.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm)]
    .filter(m => !/^[-\s]+$/.test(m[1].trim()) && m[1].trim() !== 'Language')
    .map(m => `${m[1].trim()} (${m[2].trim()})`);

  // Sort: English first, German second, Turkish last (native) — match cv.md order
  const order = { 'English': 0, 'German': 1, 'Turkish': 2 };
  langRows.sort((a, b) => {
    const la = Object.keys(order).find(k => a.startsWith(k)) ?? 'z';
    const lb = Object.keys(order).find(k => b.startsWith(k)) ?? 'z';
    return (order[la] ?? 9) - (order[lb] ?? 9);
  });

  return [
    `# ${name}`,
    '',
    `**Location:** ${location} | **Phone:** ${phone} | **Email:** ${email}`,
    `**LinkedIn:** [${liDisplay}](${liHref})`,
    `**Languages:** ${langRows.join(' · ')}`,
    '',
    '---',
  ].join('\n');
}

// Extract a named H2 section from markdown content.
// Stops at the next H2 heading. Safe with blank lines and multiline content.
function extractH2Section(content, heading) {
  const lines = content.split('\n');
  let capturing = false;
  const out = [];
  for (const line of lines) {
    if (!capturing) {
      if (line === `## ${heading}`) capturing = true;
      continue;
    }
    if (line.startsWith('## ')) break;
    out.push(line);
  }
  return out.join('\n').trimStart();
}

function buildSummary(whyThisCareer) {
  const text = extractH2Section(whyThisCareer.content, 'Professional Summary').trim();
  return ['## Summary', '', text, '', '---'].join('\n');
}

function buildExperience(roles) {
  const sections = ['## Experience'];

  for (const role of roles) {
    const roleLines = role.content.split('\n');
    const processed = [];
    for (const line of roleLines) {
      if (/^\s*<!--.*-->\s*$/.test(line)) continue; // strip bullet_id comments
      if (line.startsWith('# ')) {
        processed.push('### ' + line.slice(2));      // H1 → H3
      } else {
        processed.push(line);
      }
    }
    // Collapse artefact blank lines introduced by stripping bullet_id comments.
    // A blank line between two bullet lines (- ...) should be removed; blank lines
    // elsewhere (between header/desc and first bullet) are kept.
    const collapsed = processed.join('\n')
      .replace(/\n{3,}/g, '\n\n')                // collapse 3+ newlines → 2
      .replace(/(^- .+)\n\n(?=- )/gm, '$1\n')   // collapse blank lines between bullets
      .trimEnd();
    sections.push('', collapsed);
  }

  sections.push('', '---');
  return sections.join('\n');
}

// Normalise corpus education/certification content to cv.md inline format:
//   - Drop H1 title lines (corpus file headings)
//   - Drop horizontal-rule separators (---)
//   - Convert H2 headings → **bold** (cv.md style)
//   - Strip bold markers from institution/company lines that follow H2 headings
function formatCorpusContent(content) {
  const lines = content.split('\n');
  const out   = [];
  let prevWasH2 = false;
  for (const line of lines) {
    if (/^# /.test(line))       continue;  // H1 file title
    if (/^---$/.test(line))     continue;  // horizontal rule
    if (line.startsWith('## ')) {
      out.push(`**${line.slice(3)}**`);
      prevWasH2 = true;
      continue;
    }
    // Institution lines after H2: corpus uses **bold**, cv.md does not
    if (prevWasH2 && /^\*\*[^*]+\*\*/.test(line)) {
      out.push(line.replace(/^\*\*([^*]+)\*\*/, '$1'));
      prevWasH2 = false;
      continue;
    }
    out.push(line);
    prevWasH2 = false;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildEducation(degrees) {
  const body = degrees ? formatCorpusContent(degrees.content) : '';
  return ['## Education', '', body, '', '---'].join('\n');
}

function buildCertifications(certifications) {
  const body = certifications ? formatCorpusContent(certifications.content) : '';
  return ['## Certifications & Training', '', body, '', '---'].join('\n');
}

function buildSkills(whyThisCareer) {
  const text = extractH2Section(whyThisCareer.content, 'Skills Block').trim();
  return ['## Skills', '', text, '', '---'].join('\n');
}

function buildKeyAchievements(whyThisCareer) {
  // Verbatim from corpus — guarantees exact entity counts match cv.md
  const text = extractH2Section(whyThisCareer.content, 'Key Achievements Block').trim();
  return ['## Key Achievements', '', text].join('\n');
}

// ── Lossless verification ─────────────────────────────────────────────

// Entities whose counts in the generated cv.md must be ≥ their counts in the
// current cv.md. Only include entities that should be fully preserved.
// Excluded intentionally:
//   'Akbank'  — anonymised to descriptor in corpus (style-preferences, May 2026)
//   'Türkiye' — removed from bullet text by anonymisation pass
//   'Raynet'  — "Raynet Türkiye" → "regional entity" in one bullet (intentional)
const NAMED_ENTITIES = ['adesso', 'Berlin', 'Smartiks', 'beqom'];

function countEntity(text, entity) {
  return (text.match(new RegExp(entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
}

async function verifyLossless(generated, currentCvPath, bullets) {
  const failures = [];

  // Check 1: all bullets present verbatim
  const missingBullets = bullets.filter(b => !generated.includes(b.bullet_text));
  if (missingBullets.length > 0) {
    failures.push(`Missing ${missingBullets.length} bullets: ${missingBullets.map(b => b.bullet_id).join(', ')}`);
  }

  // Check 2: named entity counts vs current cv.md
  let currentCv;
  try { currentCv = await readText(currentCvPath); } catch { currentCv = ''; }

  if (currentCv) {
    for (const entity of NAMED_ENTITIES) {
      const inCv  = countEntity(currentCv, entity);
      const inGen = countEntity(generated, entity);
      if (inGen < inCv) {
        failures.push(`Entity "${entity}": cv.md has ${inCv}, generated has ${inGen}`);
      }
    }
  }

  return failures;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args    = process.argv.slice(2);
  const dryRun  = args.includes('--dry-run');
  const verify  = args.includes('--verify');
  const outIdx  = args.indexOf('--output');
  const outPath = outIdx >= 0 ? resolve(args[outIdx + 1]) : resolve(ROOT, 'cv.md');

  const corpus  = await loadCorpus();
  const bullets = await getAllBullets();

  const contact   = corpus.identity['contact'];
  const languages = corpus.identity['languages'];
  const whyCareer = corpus.narrative['why_this_career'];
  const degrees   = corpus.education['degrees'];
  const certs     = corpus.education['certifications'];

  if (!contact)   { process.stderr.write('ERROR: identity/contact.md not found in corpus\n'); process.exit(1); }
  if (!languages) { process.stderr.write('ERROR: identity/languages.md not found in corpus\n'); process.exit(1); }
  if (!whyCareer) { process.stderr.write('ERROR: narrative/why-this-career.md not found in corpus\n'); process.exit(1); }

  const sections = [
    buildHeader(contact, languages),
    '',
    buildSummary(whyCareer),
    '',
    buildExperience(corpus.roles),
    '',
    buildEducation(degrees),
    '',
    buildCertifications(certs),
    '',
    buildSkills(whyCareer),
    '',
    buildKeyAchievements(whyCareer),
    '',
  ];

  const output = sections.join('\n');

  if (dryRun) {
    process.stdout.write(output + '\n');
    if (verify) {
      const failures = await verifyLossless(output, resolve(ROOT, 'cv.md'), bullets);
      if (failures.length === 0) {
        process.stderr.write('✓ --verify: lossless check passed.\n');
      } else {
        process.stderr.write(`✗ --verify: ${failures.length} issue(s):\n`);
        failures.forEach(f => process.stderr.write(`  - ${f}\n`));
        process.exit(1);
      }
    }
    return;
  }

  // Write mode
  if (verify) {
    const failures = await verifyLossless(output, resolve(ROOT, 'cv.md'), bullets);
    if (failures.length > 0) {
      const fallback = resolve(ROOT, 'cv.regenerated.md');
      process.stderr.write(`✗ Lossless check failed (${failures.length} issue(s)) — writing to cv.regenerated.md instead of cv.md:\n`);
      failures.forEach(f => process.stderr.write(`  - ${f}\n`));
      await writeText(fallback, output);
      process.stderr.write(`Written: ${fallback}\n`);
      process.exit(1);
    }
    process.stderr.write('✓ Lossless check passed.\n');
  }

  await writeText(outPath, output);
  process.stderr.write(`Written: ${outPath}\n`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
