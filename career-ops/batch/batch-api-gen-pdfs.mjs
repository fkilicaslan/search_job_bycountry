#!/usr/bin/env node
/**
 * batch-api-gen-pdfs.mjs — Generate PDFs for high-scoring offers after Batch API collect
 *
 * Reads batch-state.tsv, finds completed offers above --min-score threshold,
 * then calls `claude -p` for each one to generate the tailored PDF.
 * Reuses the original batch-prompt.md (which already has the full PDF pipeline).
 *
 * Usage:
 *   node batch/batch-api-gen-pdfs.mjs                  # default: score >= 3.5
 *   node batch/batch-api-gen-pdfs.mjs --min-score 4.0  # stricter filter
 *   node batch/batch-api-gen-pdfs.mjs --dry-run        # list matches, no claude calls
 *   node batch/batch-api-gen-pdfs.mjs --parallel 2     # run 2 at a time
 */

import 'dotenv/config';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..');

const P = {
  state:   path.join(__dirname, 'batch-state.tsv'),
  input:   path.join(__dirname, 'batch-input.tsv'),
  prompt:  path.join(__dirname, 'batch-prompt.md'),      // original prompt with PDF steps
  logs:    path.join(__dirname, 'logs'),
  reports: path.join(PROJECT_DIR, 'reports'),
  output:  path.join(PROJECT_DIR, 'output'),
};

// ─── Args ─────────────────────────────────────────────────────────────────────

const argv     = process.argv.slice(2);
const flag     = (n) => argv.includes(n);
const arg      = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const MIN_SCORE = parseFloat(arg('--min-score') || '3.5');
const DRY_RUN   = flag('--dry-run');
const PARALLEL  = parseInt(arg('--parallel') || '1');

// ─── TSV helpers ──────────────────────────────────────────────────────────────

function parseTSV(text) {
  const [headerLine, ...rows] = text.trim().split('\n');
  const headers = headerLine.split('\t').map(h => h.trim());
  return rows
    .filter(r => r.trim())
    .map(row => {
      const cols = row.split('\t');
      return Object.fromEntries(headers.map((h, i) => [h, (cols[i] ?? '').trim()]));
    });
}

async function readTSV(file) {
  try { return parseTSV(await fs.readFile(file, 'utf-8')); }
  catch { return []; }
}

// ─── PDF check ────────────────────────────────────────────────────────────────

async function pdfExists(reportNum) {
  try {
    const files = await fs.readdir(P.output);
    return files.some(f => f.includes(reportNum));
  } catch { return false; }
}

// ─── Claude PDF worker ────────────────────────────────────────────────────────

function runClaudeWorker(item, resolvedPromptPath) {
  return new Promise((resolve) => {
    const date = new Date().toISOString().split('T')[0];
    const logFile = path.join(P.logs, `pdf-${item.report_num}-${item.id}.log`);

    const prompt = [
      `Genera el PDF para esta oferta. Solo ejecuta Paso 4 (Generar PDF) y Paso 5 (Tracker Line — actualizar emoji PDF a ✅).`,
      `El report ya existe en: reports/${item.report_num}-*.md`,
      `URL: ${item.url}`,
      `Report number: ${item.report_num}`,
      `Date: ${date}`,
      `Batch ID: ${item.id}`,
    ].join('\n');

    console.log(`  #${item.id} (${item.report_num}): score ${item.score} — launching PDF worker`);

    const child = spawn('claude', [
      '-p',
      '--dangerously-skip-permissions',
      '--append-system-prompt-file', resolvedPromptPath,
      prompt,
    ], { cwd: PROJECT_DIR });

    let output = '';
    child.stdout.on('data', d => output += d);
    child.stderr.on('data', d => output += d);

    child.on('close', async (code) => {
      await fs.writeFile(logFile, output, 'utf-8').catch(() => {});
      if (code === 0) {
        console.log(`  #${item.id} (${item.report_num}): ✅ PDF done`);
        resolve({ ok: true, id: item.id });
      } else {
        const errLine = output.split('\n').filter(l => l.trim()).slice(-3).join(' | ');
        console.error(`  #${item.id} (${item.report_num}): ❌ failed — ${errLine.slice(0, 120)}`);
        resolve({ ok: false, id: item.id });
      }
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(P.prompt)) {
    console.error(`ERROR: ${P.prompt} not found`);
    process.exit(1);
  }

  const stateRows = await readTSV(P.state);
  const inputRows = await readTSV(P.input);
  const urlById   = Object.fromEntries(inputRows.map(r => [r.id, r.url]));

  // Find completed rows above score threshold without a PDF yet
  const candidates = [];
  for (const row of stateRows) {
    if (row.status !== 'completed') continue;
    const score = parseFloat(row.score);
    if (isNaN(score) || score < MIN_SCORE) continue;
    if (await pdfExists(row.report_num)) continue;

    candidates.push({
      id:         row.id,
      url:        urlById[row.id] || row.url,
      report_num: row.report_num,
      score:      row.score,
    });
  }

  candidates.sort((a, b) => parseFloat(b.score) - parseFloat(a.score)); // highest first

  console.log(`career-ops PDF generator`);
  console.log(`Min score: ${MIN_SCORE} | Found: ${candidates.length} candidates | Parallel: ${PARALLEL}`);

  if (!candidates.length) {
    console.log('No offers need PDFs. All above threshold already have one, or none completed yet.');
    return;
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would generate PDFs for:');
    candidates.forEach(c => console.log(`  #${c.id} (${c.report_num}): ${c.score}/5 — ${c.url}`));
    return;
  }

  // Check claude CLI is available
  try { execSync('claude --version', { stdio: 'pipe' }); }
  catch {
    console.error('ERROR: claude CLI not found. PDF generation requires Claude Code.');
    process.exit(1);
  }

  await fs.mkdir(P.logs, { recursive: true });

  // Resolve prompt placeholders (just date — URL/ID/etc come from the user message)
  const date = new Date().toISOString().split('T')[0];
  const promptText = (await fs.readFile(P.prompt, 'utf-8'))
    .replace(/{{DATE}}/g, date);

  const resolvedPath = path.join(__dirname, '.resolved-pdf-prompt.md');
  await fs.writeFile(resolvedPath, promptText, 'utf-8');

  let success = 0, failed = 0;

  // Process with parallelism
  for (let i = 0; i < candidates.length; i += PARALLEL) {
    const batch = candidates.slice(i, i + PARALLEL);
    const results = await Promise.all(batch.map(item => runClaudeWorker(item, resolvedPath)));
    for (const r of results) {
      if (r.ok) success++; else failed++;
    }
  }

  await fs.unlink(resolvedPath).catch(() => {});

  console.log(`\nDone: ${success} PDFs generated, ${failed} failed`);
  if (failed > 0) console.log(`Check batch/logs/pdf-*.log for details`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
