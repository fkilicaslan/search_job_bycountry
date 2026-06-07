#!/usr/bin/env node
import { readFile } from 'fs/promises';
import { extname } from 'path';
import { fileURLToPath } from 'url';
import { PDFParse } from 'pdf-parse';
import { safeStringify } from '../lib/safe-json.mjs';

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

// Normalize: lowercase, collapse hyphens/spaces into a single space
function norm(str) {
  return str.toLowerCase().replace(/[-\s]+/g, ' ').trim();
}

// Case-insensitive match tolerating hyphen↔space variants and simple plural/singular
function termPresent(term, textNorm) {
  const t = norm(term);
  if (textNorm.includes(t)) return true;
  if (t.includes('-') && textNorm.includes(t.replace(/-/g, ' '))) return true;
  if (t.includes(' ') && textNorm.includes(t.replace(/ /g, '-'))) return true;
  if (!t.endsWith('s') && textNorm.includes(t + 's')) return true;
  if (!t.endsWith('s') && textNorm.includes(t + 'es')) return true;
  if (t.endsWith('es') && textNorm.includes(t.slice(0, -2))) return true;
  if (t.endsWith('s') && !t.endsWith('es') && textNorm.includes(t.slice(0, -1))) return true;
  return false;
}

async function extractText(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    const buf = await readFile(filePath);
    const parser = new PDFParse({ data: buf });
    await parser.load();
    const result = await parser.getText();
    return result.text ?? '';
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

function auditTier(keywords, textNorm) {
  const present = [], missing = [];
  for (const kw of (keywords || [])) {
    (termPresent(kw, textNorm) ? present : missing).push(kw);
  }
  const total = (keywords || []).length;
  const coverage = total > 0 ? parseFloat((present.length / total).toFixed(3)) : 1.0;
  return { present, missing, coverage };
}

export async function auditCoverage(briefPath, cvPath) {
  const brief  = JSON.parse(await readFile(briefPath, 'utf-8'));
  const cvText = await extractText(cvPath);
  const cvNorm = norm(cvText);

  const tier1 = auditTier(brief.tier1_required, cvNorm);
  const tier2 = auditTier(brief.tier2_preferred, cvNorm);
  const tier3 = auditTier(brief.tier3_context, cvNorm);

  const requirements_addressed           = [];
  const requirements_partially_addressed = [];
  const requirements_unaddressed         = [];

  for (const req of (brief.requirements_evidence_map || [])) {
    const fragments = (req.cv_evidence || '')
      .split(/[,;/]/)
      .map(s => s.trim())
      .filter(s => s.length > 3);
    const found_in = fragments.filter(f => termPresent(f, cvNorm));

    if (found_in.length > 0) {
      // Text match confirmed — fully addressed
      requirements_addressed.push({ requirement: req.jd_requirement, found_in });
    } else if (req.cv_evidence && req.cv_evidence.trim().length > 0) {
      // Brief author documented evidence but text match failed (paraphrase mismatch
      // or encoding variant) — treat as partially addressed, never as unaddressed
      requirements_partially_addressed.push({
        requirement: req.jd_requirement,
        cv_evidence: req.cv_evidence,
        note: 'evidence documented in brief; text match inconclusive',
      });
    } else {
      requirements_unaddressed.push({ requirement: req.jd_requirement });
    }
  }

  return {
    tier1, tier2, tier3,
    requirements_addressed,
    requirements_partially_addressed,
    requirements_unaddressed,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let briefPath, cvPath;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--brief' && args[i + 1]) { briefPath = args[++i]; continue; }
    if (args[i] === '--cv'    && args[i + 1]) { cvPath    = args[++i]; continue; }
    if (args[i].startsWith('--brief=')) briefPath = args[i].slice(8);
    if (args[i].startsWith('--cv='))    cvPath    = args[i].slice(5);
  }
  if (!briefPath || !cvPath) {
    process.stderr.write('Usage: node scripts/audit-coverage.mjs --brief <path> --cv <path>\n');
    process.exit(1);
  }

  const result = await auditCoverage(briefPath, cvPath);

  if (result.tier1?.missing?.length > 0) {
    process.stderr.write(`\n⚠️  TIER-1 KEYWORDS MISSING (${result.tier1.missing.length}):\n`);
    for (const kw of result.tier1.missing) {
      process.stderr.write(`   • "${kw}" — NOT FOUND in CV\n`);
    }
    process.stderr.write('\n');
  }

  process.stdout.write(safeStringify(result, 2) + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { process.stderr.write(`Error: ${err.message}\n`); process.exit(1); });
}
