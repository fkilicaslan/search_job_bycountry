/**
 * lib/corpus.mjs — Programmatic API for the career corpus.
 *
 * All I/O via safe-fs (utf8 guaranteed).
 * Corpus is parsed once and cached for the process lifetime.
 */
import { readdir } from 'fs/promises';
import { resolve, dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import { readText } from './safe-fs.mjs';
import { embed, cosine } from './embeddings.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT   = resolve(__dirname, '..');
const CORPUS = resolve(ROOT, 'data/corpus');

let _cache = null;

// ── Date normalisation ────────────────────────────────────────────────
// gray-matter auto-parses ISO date strings as Date objects.
// We want plain "YYYY-MM-DD" strings everywhere in the corpus API.

const DATE_FIELDS = ['last_updated', 'period_start', 'period_end'];

function normalizeDates(frontmatter) {
  const out = { ...frontmatter };
  for (const key of DATE_FIELDS) {
    if (out[key] instanceof Date) {
      out[key] = out[key].toISOString().slice(0, 10);
    }
  }
  return out;
}

// ── Bullet extraction ─────────────────────────────────────────────────
// Parses the HTML comment / bullet pair pattern from role files:
//   <!-- bullet_id: some_id -->
//   - Bullet text here

function extractBullets(raw, frontmatter) {
  const bullets = [];
  const lines   = raw.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const commentMatch = lines[i].match(/<!--\s*bullet_id:\s*(\S+)\s*-->/);
    if (!commentMatch) continue;
    const bulletLine = lines[i + 1];
    if (!bulletLine.startsWith('- ')) continue;
    bullets.push({
      bullet_id:   commentMatch[1],
      bullet_text: bulletLine.slice(2).trim(),
      role:        frontmatter.id       ?? null,
      employer:    frontmatter.employer ?? null,
      period:      frontmatter.period   ?? null,
    });
  }
  return bullets;
}

// ── Period sort key ───────────────────────────────────────────────────
// Extracts the start year from period strings like "2020-2024" or "2025-2026"

function periodStart(period) {
  if (!period) return 0;
  const m = String(period).match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : 0;
}

// ── Walk one corpus directory ─────────────────────────────────────────

async function readDir(dirName) {
  const absDir = join(CORPUS, dirName);
  let entries;
  try { entries = await readdir(absDir); } catch { return []; }

  const files = [];
  for (const f of entries) {
    if (!f.endsWith('.md') || f.startsWith('_')) continue;
    const absPath    = join(absDir, f);
    const raw        = await readText(absPath);
    const parsed     = matter(raw);
    const frontmatter = normalizeDates(parsed.data);
    files.push({
      file: relative(ROOT, absPath).replace(/\\/g, '/'),
      frontmatter,
      content: parsed.content,
      raw,
    });
  }
  return files;
}

// ── loadCorpus ────────────────────────────────────────────────────────

export async function loadCorpus() {
  if (_cache) return _cache;

  const [
    identityFiles,
    roleFiles,
    achievementFiles,
    skillFiles,
    educationFiles,
    narrativeFiles,
    deFiles,
  ] = await Promise.all([
    readDir('identity'),
    readDir('roles'),
    readDir('achievements'),
    readDir('skills'),
    readDir('education'),
    readDir('narrative'),
    readDir('languages-de'),
  ]);

  // Helper: turn a list of files into a keyed object by filename stem
  const bySlug = files => Object.fromEntries(
    files.map(f => [f.file.split('/').pop().replace('.md', '').replace(/-/g, '_'), f])
  );

  // Roles: add extracted bullets, sort reverse-chronological
  const roles = roleFiles
    .map(f => ({ ...f, bullets: extractBullets(f.raw, f.frontmatter) }))
    .sort((a, b) => periodStart(b.frontmatter.period) - periodStart(a.frontmatter.period));

  _cache = {
    identity:     bySlug(identityFiles),
    roles,
    achievements: bySlug(achievementFiles),
    skills:       bySlug(skillFiles),
    education:    bySlug(educationFiles),
    narrative:    bySlug(narrativeFiles),
    languages_de: bySlug(deFiles),
    // flat index: id → file entry (for getById)
    _byId: Object.fromEntries(
      [...identityFiles, ...roleFiles, ...achievementFiles,
       ...skillFiles, ...educationFiles, ...narrativeFiles, ...deFiles]
        .filter(f => f.frontmatter.id)
        .map(f => [f.frontmatter.id, f])
    ),
  };

  return _cache;
}

// ── getById ───────────────────────────────────────────────────────────

export async function getById(id) {
  const corpus = await loadCorpus();
  const entry  = corpus._byId[id];
  if (!entry) return null;
  return { frontmatter: entry.frontmatter, content: entry.content, file: entry.file };
}

// ── getAllBullets ─────────────────────────────────────────────────────

export async function getAllBullets() {
  const corpus = await loadCorpus();
  return corpus.roles.flatMap(r =>
    r.bullets.map(b => ({ ...b, source_file: r.file }))
  );
}

// ── searchCorpus ──────────────────────────────────────────────────────

export async function searchCorpus(query, { mode = 'hybrid', topK = 10, minScore = 0.70 } = {}) {
  const corpus = await loadCorpus();

  // Build searchable line segments across all corpus files
  const segments = [];
  const allFiles = [
    ...Object.values(corpus.identity),
    ...corpus.roles,
    ...Object.values(corpus.achievements),
    ...Object.values(corpus.skills),
    ...Object.values(corpus.education),
    ...Object.values(corpus.narrative),
    ...Object.values(corpus.languages_de),
  ];

  for (const entry of allFiles) {
    const lines = entry.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t.length < 10) continue;
      segments.push({ file: entry.file, line: i + 1, text: t });
    }
  }

  const results = [];

  // Exact mode: case-insensitive substring
  if (mode === 'exact' || mode === 'hybrid') {
    const q = query.toLowerCase();
    for (const seg of segments) {
      if (seg.text.toLowerCase().includes(q)) {
        results.push({ ...seg, snippet: seg.text, score: 1.0, matchType: 'exact' });
      }
    }
  }

  // Semantic mode: embed + cosine similarity
  if (mode === 'semantic' || mode === 'hybrid') {
    const qVec  = await embed(query);
    const scored = [];
    for (const seg of segments) {
      const sVec  = await embed(seg.text);
      const score = cosine(qVec, sVec);
      if (score >= minScore) scored.push({ ...seg, snippet: seg.text, score, matchType: 'semantic' });
    }
    scored.sort((a, b) => b.score - a.score);
    const exactKeys = new Set(results.map(r => `${r.file}:${r.line}`));
    for (const s of scored) {
      if (!exactKeys.has(`${s.file}:${s.line}`)) results.push(s);
    }
  }

  // Dedupe by file:line, prefer exact over semantic
  const seen = new Map();
  for (const r of results) {
    const key = `${r.file}:${r.line}`;
    if (!seen.has(key) || r.matchType === 'exact') seen.set(key, r);
  }

  return [...seen.values()]
    .sort((a, b) => {
      if (a.matchType === 'exact' && b.matchType !== 'exact') return -1;
      if (b.matchType === 'exact' && a.matchType !== 'exact') return  1;
      return b.score - a.score;
    })
    .slice(0, topK);
}

// ── clearCache ────────────────────────────────────────────────────────

export function clearCache() {
  _cache = null;
}
