#!/usr/bin/env node
/**
 * audit-corpus.mjs — Corpus health reporting.
 *
 * Flags:
 *   --inventory          List every file with frontmatter + last_updated
 *   --completeness       Score 0-100, breakdown per bucket
 *   --missing-frontmatter List files missing required frontmatter fields
 *   --stale [--days N]   Files not updated in N days (default 90)
 *   --mojibake           Run 14-sequence CP437/latin-1 guard
 *   --anonymization      Check bullet bodies for forbidden Türkiye/Turkey/Turkish tokens
 *   --bullet-descriptor-sync  Check bullets for original client names or stale metrics
 *
 * Output: JSON to stdout (via safe-json), human summary to stderr.
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

// ── Directory layout ──────────────────────────────────────────────────

const REQUIRED_DIRS = [
  'identity', 'roles', 'achievements', 'skills',
  'education', 'narrative', 'languages-de',
];

const SECTION_FILES = {
  identity:     ['contact.md', 'languages.md', 'mobility.md'],
  achievements: ['client-stories.md', 'revenue-metrics.md', 'team-leadership.md'],
  skills:       ['platforms.md', 'methodologies.md', 'industries.md'],
  education:    ['degrees.md', 'certifications.md'],
  narrative:    ['swot.md', 'leadership-philosophy.md', 'interview-stories.md'],
  'languages-de': ['lebenslauf-anchors.md'],
};

// Required frontmatter fields per type
const REQUIRED_FIELDS = {
  role:             ['id', 'type', 'period', 'employer', 'last_updated', 'confidence'],
  narrative:        ['id', 'type', 'last_updated', 'confidence'],
  identity:         ['id', 'type', 'last_updated', 'confidence'],
  client_story:     ['id', 'type', 'last_updated', 'confidence'],
  revenue_metric:   ['id', 'type', 'last_updated', 'confidence'],
  team_leadership:  ['id', 'type', 'last_updated', 'confidence'],
  partnership:      ['id', 'type', 'last_updated', 'confidence'],
  recognition:      ['id', 'type', 'last_updated', 'confidence'],
  skill_platform:   ['id', 'type', 'last_updated', 'confidence'],
  skill_methodology:['id', 'type', 'last_updated', 'confidence'],
  skill_industry:   ['id', 'type', 'last_updated', 'confidence'],
  skill_tool:       ['id', 'type', 'last_updated', 'confidence'],
  skill_soft:       ['id', 'type', 'last_updated', 'confidence'],
  degree:           ['id', 'type', 'last_updated', 'confidence'],
  certification:    ['id', 'type', 'last_updated', 'confidence'],
  course:           ['id', 'type', 'last_updated', 'confidence'],
  language_de:      ['id', 'type', 'last_updated', 'confidence'],
};

// ── Anonymization guard ───────────────────────────────────────────────

// No entire files are exempt. Frontmatter is excluded by the body-only scan.
// The Smartiks employer name and location survive because they live in frontmatter
// and the role title heading (# ...) line — both excluded below.
const ANON_EXEMPT_FILES = [];

// Legal entity names that legitimately contain stop words.
// Strip these before checking for forbidden geographic tokens.
const ANON_WHITELIST = [
  'adesso Turkey Ltd.',
  'adesso Turkey',
  'BMW Türkiye',
  // Add future legal entity names here
];

const ANON_STOP_WORDS = ['Türkiye', 'Turkey', 'Turkish'];

function hasForbiddenToken(text) {
  let cleaned = text;
  for (const phrase of ANON_WHITELIST) {
    cleaned = cleaned.split(phrase).join('');
  }
  return ANON_STOP_WORDS.some(sw => cleaned.includes(sw));
}

// Role date/location header lines are structural metadata (not impact claims).
// Format: **Mar 2020 – Nov 2024 | Istanbul, Türkiye** — bold line with | separator + year.
// Per decision #15, these lines ARE allowed to contain "Türkiye"; only bullet bodies
// are subject to the anonymization constraint.
function isLocationHeaderLine(line) {
  const t = line.trim();
  return /^\*\*[^*]+\|\s*[^*]+\*\*/.test(t) && /\d{4}/.test(t);
}

// ── Mojibake sequences ────────────────────────────────────────────────

const MOJIBAKE_SEQUENCES = [
  '├╝', '├╢', '├ñ', '├£',
  'Γé¼', 'ΓÇö', 'ΓÇô', 'ΓÇ£', 'ΓÇ¥', 'ΓÇÿ',
  'Ã¼', 'Ã¶', 'Ã¤', 'Ã©', 'TÃ¼rkiye',
];

// ── File walker ───────────────────────────────────────────────────────

async function walkCorpus() {
  const files = [];
  for (const dir of REQUIRED_DIRS) {
    const absDir = join(CORPUS, dir);
    let entries;
    try { entries = await readdir(absDir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.md') || f.startsWith('_')) continue;
      const absPath = join(absDir, f);
      const raw     = await readText(absPath);
      const { data: fm, content } = matter(raw);
      files.push({
        rel:     relative(ROOT, absPath).replace(/\\/g, '/'),
        abs:     absPath,
        dir,
        file:    f,
        fm,
        content,
        raw,
      });
    }
  }
  return files;
}

// ── Helpers ───────────────────────────────────────────────────────────

function isStub(content) {
  // A stub has ≤3 meaningful (non-empty, non-comment) lines after frontmatter
  const lines = content.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('<!--'));
  return lines.length <= 3;
}

function countBulletIds(raw) {
  return (raw.match(/<!--\s*bullet_id:/g) || []).length;
}

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const d = new Date(dateStr);
  if (isNaN(d)) return Infinity;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

// ── --inventory ───────────────────────────────────────────────────────

async function cmdInventory(files) {
  const rows = files.map(f => ({
    file:         f.rel,
    id:           f.fm.id    ?? null,
    type:         f.fm.type  ?? null,
    confidence:   f.fm.confidence ?? null,
    last_updated: f.fm.last_updated ?? null,
    stub:         isStub(f.content),
    bullet_ids:   f.dir === 'roles' ? countBulletIds(f.raw) : null,
  }));

  process.stdout.write(safeStringify({ inventory: rows }, 2) + '\n');
  process.stderr.write(`Inventory: ${rows.length} files across ${REQUIRED_DIRS.length} dirs\n`);
}

// ── --missing-frontmatter ─────────────────────────────────────────────

async function cmdMissingFrontmatter(files) {
  const issues = [];
  for (const f of files) {
    const required = REQUIRED_FIELDS[f.fm.type] ?? ['id', 'type', 'last_updated', 'confidence'];
    const missing  = required.filter(k => f.fm[k] == null);
    if (missing.length) issues.push({ file: f.rel, missing });
  }

  process.stdout.write(safeStringify({ missing_frontmatter: issues }, 2) + '\n');
  if (issues.length === 0) {
    process.stderr.write('✓ All files have required frontmatter fields.\n');
  } else {
    process.stderr.write(`✗ ${issues.length} file(s) with missing frontmatter:\n`);
    for (const i of issues) process.stderr.write(`  ${i.file}: ${i.missing.join(', ')}\n`);
  }
}

// ── --stale ───────────────────────────────────────────────────────────

async function cmdStale(files, days) {
  const stale = files
    .map(f => ({ file: f.rel, last_updated: f.fm.last_updated ?? null, days_since: daysSince(f.fm.last_updated) }))
    .filter(f => f.days_since >= days);

  process.stdout.write(safeStringify({ stale_threshold_days: days, stale_files: stale }, 2) + '\n');
  if (stale.length === 0) {
    process.stderr.write(`✓ No files stale (>${days} days).\n`);
  } else {
    process.stderr.write(`${stale.length} file(s) stale (not updated in >${days} days).\n`);
  }
}

// ── --mojibake ────────────────────────────────────────────────────────

async function cmdMojibake(files) {
  const hits = [];
  for (const f of files) {
    for (const seq of MOJIBAKE_SEQUENCES) {
      if (f.raw.includes(seq)) hits.push({ file: f.rel, sequence: seq });
    }
  }

  process.stdout.write(safeStringify({ mojibake_sequences_checked: MOJIBAKE_SEQUENCES.length, files_scanned: files.length, hits }, 2) + '\n');
  if (hits.length === 0) {
    process.stderr.write(`✓ Mojibake scan clean — ${files.length} files, 0 hits.\n`);
  } else {
    process.stderr.write(`✗ Mojibake detected in ${hits.length} location(s):\n`);
    for (const h of hits) process.stderr.write(`  ${h.file}: "${h.sequence}"\n`);
  }
  return hits.length;
}

// ── --completeness ────────────────────────────────────────────────────

async function cmdCompleteness(files) {
  const buckets = {};
  let score = 0;

  // +20: all required directories populated with non-stub files
  const dirHasReal = {};
  for (const dir of REQUIRED_DIRS) {
    dirHasReal[dir] = files.some(f => f.dir === dir && !isStub(f.content));
  }
  const allDirsPopulated = REQUIRED_DIRS.every(d => dirHasReal[d]);
  const dirScore = allDirsPopulated ? 20 : Math.round(20 * Object.values(dirHasReal).filter(Boolean).length / REQUIRED_DIRS.length);
  score += dirScore;
  buckets['all_required_dirs_populated'] = { score: dirScore, max: 20, detail: dirHasReal };

  // +15: all role files have ≥5 bullets with bullet_id
  const roleFiles = files.filter(f => f.dir === 'roles');
  // career-break / transition roles are exempt (1 bullet by design)
  const BREAK_EMPLOYERS = ['career break', 'self-directed', 'goethe-institut'];
  const isBreakRole = f => BREAK_EMPLOYERS.some(e => (f.fm.employer ?? '').toLowerCase().includes(e));
  const careerBreaks   = roleFiles.filter(f => isBreakRole(f));
  const substantiveRoles = roleFiles.filter(f => !isBreakRole(f));
  const allSubstantiveHave5 = substantiveRoles.every(f => countBulletIds(f.raw) >= 5);
  const roleScore = allSubstantiveHave5 ? 15 : Math.round(15 * substantiveRoles.filter(f => countBulletIds(f.raw) >= 5).length / Math.max(1, substantiveRoles.length));
  score += roleScore;
  buckets['role_files_have_5_bullets'] = {
    score: roleScore, max: 15,
    detail: roleFiles.map(f => ({ file: f.file, bullet_ids: countBulletIds(f.raw), exempt: f.fm.employer?.toLowerCase().includes('career break') })),
  };

  // +20: skills/, education/, narrative/, identity/, achievements/ populated
  const sectionDirs = ['skills', 'education', 'narrative', 'identity', 'achievements'];
  const sectionPopulated = {};
  for (const dir of sectionDirs) {
    const required = SECTION_FILES[dir] ?? [];
    sectionPopulated[dir] = required.every(reqFile =>
      files.some(f => f.dir === dir && f.file === reqFile && !isStub(f.content))
    );
  }
  const sectionScore = sectionDirs.every(d => sectionPopulated[d])
    ? 20
    : Math.round(20 * sectionDirs.filter(d => sectionPopulated[d]).length / sectionDirs.length);
  score += sectionScore;
  buckets['core_sections_populated'] = { score: sectionScore, max: 20, detail: sectionPopulated };

  // +10: no file has confidence=low
  const lowConf = files.filter(f => f.fm.confidence === 'low');
  const confScore = lowConf.length === 0 ? 10 : 0;
  score += confScore;
  buckets['no_confidence_low'] = { score: confScore, max: 10, detail: lowConf.map(f => f.rel) };

  // +10: every file has last_updated within 12 months
  const stale12 = files.filter(f => daysSince(f.fm.last_updated) > 365);
  const freshScore = stale12.length === 0 ? 10 : Math.round(10 * (files.length - stale12.length) / files.length);
  score += freshScore;
  buckets['all_files_updated_12mo'] = { score: freshScore, max: 10, stale_count: stale12.length };

  // +10: languages-de populated
  const deFiles = files.filter(f => f.dir === 'languages-de' && !isStub(f.content));
  const deScore = deFiles.length >= 2 ? 10 : deFiles.length * 5;
  score += deScore;
  buckets['languages_de_populated'] = { score: deScore, max: 10, files_count: deFiles.length };

  // +15: no mojibake
  let mojiHits = 0;
  for (const f of files) {
    for (const seq of MOJIBAKE_SEQUENCES) {
      if (f.raw.includes(seq)) { mojiHits++; break; }
    }
  }
  const mojiScore = mojiHits === 0 ? 15 : 0;
  score += mojiScore;
  buckets['no_mojibake'] = { score: mojiScore, max: 15, files_with_hits: mojiHits };

  const result = { total_score: score, max_score: 100, files_scanned: files.length, buckets };
  process.stdout.write(safeStringify(result, 2) + '\n');
  process.stderr.write(`Completeness score: ${score}/100\n`);
  for (const [k, v] of Object.entries(buckets)) {
    const mark = v.score === v.max ? '✓' : v.score > 0 ? '▶' : '✗';
    process.stderr.write(`  ${mark} ${k}: ${v.score}/${v.max}\n`);
  }
}

// ── --anonymization ───────────────────────────────────────────────────

async function cmdAnonymization(files) {
  const roleFiles = files.filter(f => f.dir === 'roles');
  const hits = [];

  for (const f of roleFiles) {
    // Check body only (everything after the second ---)
    // Frontmatter exclusion preserves employer names and location fields
    // (including Smartiks / Istanbul, Türkiye) without any special-case logic.
    const parts = f.raw.split('---');
    const body  = parts.slice(2).join('---');

    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // Skip role H1 title heading — structural, contains employer name
      if (lines[i].trimStart().startsWith('# ')) continue;
      // Skip role date/location header lines — metadata, allowed to carry "Türkiye"
      // per decision #15
      if (isLocationHeaderLine(lines[i])) continue;
      if (hasForbiddenToken(lines[i])) {
        hits.push({ file: f.rel, line: i + 1, text: lines[i].trim() });
      }
    }
  }

  const total = hits.length;
  process.stdout.write(safeStringify({ anonymization_hits: hits, total }, 2) + '\n');

  if (total === 0) {
    process.stderr.write(`✓ Anonymization clean — 0 forbidden tokens in ${roleFiles.length} role files (all scanned; frontmatter + H1 headings excluded).\n`);
  } else {
    process.stderr.write(`✗ ${total} forbidden token(s) found:\n`);
    for (const h of hits) process.stderr.write(`  ${h.file}:${h.line}  "${h.text}"\n`);
    process.stderr.write('\nFAIL — anonymization incomplete\n');
  }

  return total;
}

// ── --bullet-descriptor-sync ──────────────────────────────────────────
// Guards against anonymization omissions and metric drift across all
// cv_bound: true corpus files (not just role files). Scans all body
// content — bullets, tables, paragraphs — not only "- " prefixed lines.

const DESCRIPTORS_PATH = join(CORPUS, 'identity/market-descriptors.yml');

// Returns the content of the first (...) immediately following `phrase` in `text`.
// e.g. extractParenAfter("top 3 private bank (~€70B assets)", "top 3 private bank") → "~€70B assets"
function extractParenAfter(text, phrase) {
  const idx = text.indexOf(phrase);
  if (idx === -1) return null;
  const after = text.slice(idx + phrase.length).trimStart();
  const m = after.match(/^\(([^)]+)\)/);
  return m ? m[1].trim() : null;
}

async function cmdBulletDescriptorSync(files) {
  let descriptorRaw;
  try {
    descriptorRaw = await readText(DESCRIPTORS_PATH);
  } catch {
    process.stderr.write(`✗ Cannot read market-descriptors.yml at ${DESCRIPTORS_PATH}\n`);
    process.exit(1);
  }

  let descriptors;
  try {
    descriptors = jsyaml.load(descriptorRaw);
  } catch (err) {
    process.stderr.write(`✗ YAML parse error in market-descriptors.yml: ${err.message}\n`);
    process.exit(1);
  }

  // Only real entries (not comments-turned-null)
  const entries = Object.entries(descriptors).filter(([, v]) => v && typeof v === 'object');

  // Scan all cv_bound: true files (default true when field is absent)
  const cvBoundFiles = files.filter(f => f.fm.cv_bound !== false);
  const findings     = [];

  for (const f of cvBoundFiles) {
    // f.content is the post-frontmatter body (gray-matter already stripped
    // the frontmatter block). Scan all non-empty lines — bullets, tables,
    // paragraphs — not only "- " prefixed lines.
    const bodyLines = f.content.split('\n').filter(l => l.trim());

    for (const lineText of bodyLines) {
      for (const [key, entry] of entries) {
        if (!entry.anonymize) continue;

        // Check 1 — anonymization_omission: line uses original_name
        // instead of descriptor. Catches clients never anonymised or
        // re-introduced after a corpus edit.
        if (entry.original_name && lineText.includes(entry.original_name)) {
          findings.push({
            file: f.rel,
            violation_type: 'anonymization_omission',
            detail: `Contains original_name "${entry.original_name}" — use descriptor "${entry.descriptor_quantified}"`,
            descriptor_key: key,
            line_snippet: lineText.trim().slice(0, 80),
          });
          continue; // don't also run drift check on the same line
        }

        // Check 2 — metric_drift: line uses descriptor_short but the
        // parenthetical metrics no longer match the current descriptor_quantified.
        // Catches cases where market-descriptors.yml was updated with new
        // verified figures but the corpus line was not refreshed.
        if (entry.descriptor_short && lineText.includes(entry.descriptor_short)) {
          const lineMetrics       = extractParenAfter(lineText, entry.descriptor_short);
          const descriptorMetrics = extractParenAfter(entry.descriptor_quantified, entry.descriptor_short);

          if (lineMetrics && descriptorMetrics && lineMetrics !== descriptorMetrics) {
            findings.push({
              file: f.rel,
              violation_type: 'metric_drift',
              detail: `Content has "(${lineMetrics})" but descriptor now says "(${descriptorMetrics})"`,
              descriptor_key: key,
              line_snippet: lineText.trim().slice(0, 80),
            });
          }
        }
      }
    }
  }

  process.stdout.write(safeStringify({ findings, total: findings.length, files_checked: cvBoundFiles.length }, 2) + '\n');

  if (findings.length === 0) {
    process.stderr.write(`✓ PASS — 0 descriptor sync findings across ${cvBoundFiles.length} cv_bound file(s)\n`);
  } else {
    process.stderr.write(`✗ FAIL — ${findings.length} finding(s):\n`);
    for (const fd of findings) {
      process.stderr.write(`  ${fd.file} [${fd.descriptor_key}/${fd.violation_type}]\n    ${fd.detail}\n    Content: "${fd.line_snippet}"\n`);
    }
  }

  return findings.length;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const has  = f => args.includes(f);

  const files = await walkCorpus();

  if (has('--inventory'))           { await cmdInventory(files); return; }
  if (has('--missing-frontmatter')) { await cmdMissingFrontmatter(files); return; }
  if (has('--stale')) {
    const days = has('--days') ? parseInt(args[args.indexOf('--days') + 1], 10) : 90;
    await cmdStale(files, days);
    return;
  }
  if (has('--mojibake')) {
    const hits = await cmdMojibake(files);
    process.exit(hits > 0 ? 1 : 0);
  }
  if (has('--completeness')) { await cmdCompleteness(files); return; }
  if (has('--anonymization')) {
    const hits = await cmdAnonymization(files);
    process.exit(hits > 0 ? 1 : 0);
  }
  if (has('--bullet-descriptor-sync')) {
    const hits = await cmdBulletDescriptorSync(files);
    process.exit(hits > 0 ? 1 : 0);
  }

  process.stderr.write('Usage: audit-corpus.mjs [--inventory|--completeness|--missing-frontmatter|--stale [--days N]|--mojibake|--anonymization|--bullet-descriptor-sync]\n');
  process.exit(1);
}

main().catch(err => { console.error(err.message); process.exit(1); });
