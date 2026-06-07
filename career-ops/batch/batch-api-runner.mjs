#!/usr/bin/env node
/**
 * batch-api-runner.mjs — Anthropic Batch API runner for career-ops
 *
 * Replaces batch-runner.sh (which used claude -p / claude.ai quota)
 * with the Anthropic Batch API. Uses ANTHROPIC_API_KEY; shares no quota
 * with claude.ai interactive chats.
 *
 * Usage:
 *   node batch/batch-api-runner.mjs                        # run all phases
 *   node batch/batch-api-runner.mjs --phase prefetch       # fetch JD pages only
 *   node batch/batch-api-runner.mjs --phase submit         # submit batch only
 *   node batch/batch-api-runner.mjs --phase collect        # collect results only
 *   node batch/batch-api-runner.mjs --collect-batch <id>   # collect a specific batch
 *   node batch/batch-api-runner.mjs --dry-run              # preview, no API calls
 *   node batch/batch-api-runner.mjs --start-from 100       # skip IDs < 100
 *
 * Env vars (in .env):
 *   ANTHROPIC_API_KEY      required
 *   BRIGHTDATA_API_KEY     optional — enables LinkedIn page fetching via Web Unlocker
 *   BATCH_MODEL            default: claude-sonnet-4-6
 *   BATCH_MAX_TOKENS       default: 8192
 *   FETCH_DELAY_MS         default: 2000 (ms between URL fetches to avoid rate limits)
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..');

// ─── Config ──────────────────────────────────────────────────────────────────

const MODEL          = process.env.BATCH_MODEL      || 'claude-sonnet-4-6';
const MAX_TOKENS     = parseInt(process.env.BATCH_MAX_TOKENS  || '8192');
const FETCH_DELAY_MS = parseInt(process.env.FETCH_DELAY_MS    || '2000');
const POLL_INTERVAL_MS = 60_000;

const P = {
  input:   path.join(__dirname, 'batch-input.tsv'),
  state:   path.join(__dirname, 'batch-state.tsv'),
  prompt:  path.join(__dirname, 'batch-api-prompt.md'),
  jdCache: path.join(__dirname, 'jd-cache'),
  tracker: path.join(__dirname, 'tracker-additions'),
  logs:    path.join(__dirname, 'logs'),
  apiState:path.join(__dirname, 'batch-api-state.json'),
  reports: path.join(PROJECT_DIR, 'reports'),
  apps:    path.join(PROJECT_DIR, 'data', 'applications.md'),
  cv:      path.join(PROJECT_DIR, 'cv.md'),
  digest:  path.join(PROJECT_DIR, 'article-digest.md'),
};

// ─── Args ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const arg  = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };

const PHASE      = arg('--phase') || 'all';
const DRY_RUN    = flag('--dry-run');
const COLLECT_ID = arg('--collect-batch');
const START_FROM = parseInt(arg('--start-from') || '0');

// ─── TSV helpers ──────────────────────────────────────────────────────────────

function parseTSV(text) {
  const [headerLine, ...rows] = text.trim().split('\n');
  const headers = headerLine.split('\t').map(h => h.trim());
  return rows
    .filter(r => r.trim())
    .map(row => {
      const cols = row.replace(/\r$/, '').split('\t');
      return Object.fromEntries(headers.map((h, i) => [h, (cols[i] ?? '').trim()]));
    });
}

async function readTSV(file) {
  try { return parseTSV(await fs.readFile(file, 'utf-8')); }
  catch { return []; }
}

async function updateStateRow(id, fields) {
  let text;
  try { text = await fs.readFile(P.state, 'utf-8'); }
  catch { return; }

  const lines = text.split('\n');
  const headers = lines[0].split('\t').map(h => h.trim());

  const updated = lines.map((line, i) => {
    if (i === 0) return line;
    const cols = line.split('\t');
    if ((cols[0] ?? '').trim() !== String(id)) return line;
    Object.entries(fields).forEach(([key, val]) => {
      const idx = headers.indexOf(key);
      if (idx >= 0) cols[idx] = val;
    });
    return cols.join('\t');
  });

  await fs.writeFile(P.state, updated.join('\n'), 'utf-8');
}

// ─── Report / tracker number helpers ─────────────────────────────────────────

async function getMaxReportNum() {
  let max = 0;
  try {
    const files = await fs.readdir(P.reports);
    for (const f of files) {
      const m = f.match(/^(\d+)-/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch { /* reports dir may not exist yet */ }
  return max;
}

async function getNextTrackerNum() {
  try {
    const text = await fs.readFile(P.apps, 'utf-8');
    const matches = [...text.matchAll(/^\|\s*(\d+)\s*\|/gm)];
    if (!matches.length) return 1;
    return Math.max(...matches.map(m => parseInt(m[1], 10))) + 1;
  } catch { return 1; }
}

// ─── JD fetching ──────────────────────────────────────────────────────────────

async function fetchDirect(url) {
  return new Promise((resolve) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,de;q=0.8',
      },
    };

    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const loc = res.headers.location;
          const absolute = loc.startsWith('http') ? loc : new URL(loc, url).href;
          resolve(fetchDirect(absolute));
        } catch {
          resolve({ ok: false, status: res.statusCode, text: '', error: 'bad redirect' });
        }
        return;
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, text: body }));
    });

    req.on('error', err => resolve({ ok: false, status: 0, text: '', error: err.message }));
    req.setTimeout(15_000, () => { req.destroy(); resolve({ ok: false, status: 0, text: '', error: 'timeout' }); });
  });
}

async function fetchWithBrightData(url) {
  const apiKey = process.env.BRIGHTDATA_API_KEY;
  if (!apiKey) return null;

  return new Promise((resolve) => {
    const body = JSON.stringify({ url, format: 'raw' });
    const options = {
      hostname: 'api.brightdata.com',
      path: '/request',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, text: data }));
    });

    req.on('error', err => resolve({ ok: false, status: 0, text: '', error: err.message }));
    req.setTimeout(30_000, () => { req.destroy(); resolve({ ok: false, status: 0, text: '', error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function isLoginWall(text) {
  if (!text || text.length < 500) return true;
  const lower = text.toLowerCase();
  return (
    lower.includes('join now to see') ||
    lower.includes('sign in to view') ||
    lower.includes('authwall') ||
    (lower.includes('linkedin') && lower.includes('sign in') && text.length < 5000)
  );
}

function htmlToText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchJD(id, url) {
  const cacheFile = path.join(P.jdCache, `${id}.txt`);

  if (existsSync(cacheFile)) {
    process.stdout.write(`  #${id}: cached\n`);
    return fs.readFile(cacheFile, 'utf-8');
  }

  url = url.trim();
  process.stdout.write(`  #${id}: fetching...`);

  let result = await fetchDirect(url);

  if (!result.ok || isLoginWall(result.text)) {
    if (process.env.BRIGHTDATA_API_KEY) {
      process.stdout.write(` login wall, trying Bright Data...`);
      const bd = await fetchWithBrightData(url);
      if (bd?.ok && !isLoginWall(bd.text)) result = bd;
    }
  }

  let content;
  if (!result.ok || isLoginWall(result.text)) {
    content = `[JD_FETCH_FAILED: Could not retrieve job posting content. HTTP ${result.status}. ${result.error || 'Login wall or empty response'}. Evaluate based on URL and company signals only.]`;
    process.stdout.write(` FAILED (${result.status})\n`);
  } else {
    const text = htmlToText(result.text).slice(0, 20_000);
    content = text;
    process.stdout.write(` ok (${text.length} chars)\n`);
  }

  await fs.writeFile(cacheFile, content, 'utf-8');
  return content;
}

// ─── Prompt building ──────────────────────────────────────────────────────────

async function buildSystemPrompt() {
  const [template, cvContent, digestContent] = await Promise.all([
    fs.readFile(P.prompt, 'utf-8'),
    fs.readFile(P.cv, 'utf-8').catch(() => '(cv.md not found)'),
    fs.readFile(P.digest, 'utf-8').catch(() => '(article-digest.md not found)'),
  ]);

  return template
    .replace('{{CV_CONTENT}}', cvContent)
    .replace('{{ARTICLE_DIGEST_CONTENT}}', digestContent);
}

function buildUserMessage(item, jdContent) {
  const date = new Date().toISOString().split('T')[0];
  return `Evalúa esta oferta de empleo.

**URL:** ${item.url}
**Batch ID:** ${item.id}
**Report Number:** ${item.report_num}
**Date:** ${date}

---

**JD Content:**
${jdContent}`;
}

// ─── Phase 1: Prefetch ────────────────────────────────────────────────────────

async function phasePrefetch(items) {
  await fs.mkdir(P.jdCache, { recursive: true });
  console.log(`\n=== Phase 1: Prefetch (${items.length} items) ===`);

  let fetched = 0, cached = 0, failed = 0;

  for (const item of items) {
    const cacheFile = path.join(P.jdCache, `${item.id}.txt`);
    if (existsSync(cacheFile)) { cached++; continue; }

    const content = await fetchJD(item.id, item.url);
    if (content.startsWith('[JD_FETCH_FAILED')) failed++;
    else fetched++;

    await new Promise(r => setTimeout(r, FETCH_DELAY_MS));
  }

  console.log(`Prefetch complete: ${fetched} fetched, ${cached} cached, ${failed} failed`);
}

// ─── Phase 2: Submit ──────────────────────────────────────────────────────────

async function phaseSubmit(items) {
  console.log(`\n=== Phase 2: Submit (${items.length} items) ===`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  const client = new Anthropic();
  const systemPrompt = await buildSystemPrompt();
  console.log(`System prompt: ~${Math.round(systemPrompt.length / 4)} tokens | Model: ${MODEL} | max_tokens: ${MAX_TOKENS}`);

  const maxNum = await getMaxReportNum();
  let nextNum = maxNum + 1;

  const requests = [];
  const itemMap = {};

  for (const item of items) {
    const jdFile = path.join(P.jdCache, `${item.id}.txt`);
    const jdContent = existsSync(jdFile)
      ? await fs.readFile(jdFile, 'utf-8')
      : `[JD not prefetched. Evaluate based on URL: ${item.url}]`;

    item.report_num = String(nextNum++).padStart(3, '0');

    requests.push({
      custom_id: String(item.id),
      params: {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' }, // prompt cache — same system prompt for all requests
          },
        ],
        messages: [
          { role: 'user', content: buildUserMessage(item, jdContent) },
        ],
      },
    });

    itemMap[String(item.id)] = { ...item };
  }

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would submit ${requests.length} requests`);
    console.log(`  Sample IDs: ${requests.slice(0, 3).map(r => r.custom_id).join(', ')}...`);
    console.log(`  Report numbers: ${items[0]?.report_num} → ${items[items.length - 1]?.report_num}`);
    return null;
  }

  console.log(`Submitting ${requests.length} requests to Anthropic Batch API...`);
  const batch = await client.messages.batches.create({ requests });

  const apiState = {
    batch_id: batch.id,
    submitted_at: new Date().toISOString(),
    model: MODEL,
    item_count: requests.length,
    items: itemMap,
  };
  await fs.writeFile(P.apiState, JSON.stringify(apiState, null, 2), 'utf-8');

  const now = new Date().toISOString();
  for (const item of items) {
    await updateStateRow(item.id, {
      status: 'processing',
      started_at: now,
      report_num: item.report_num,
    });
  }

  console.log(`✅ Submitted. Batch ID: ${batch.id}`);
  console.log(`   Status: ${batch.processing_status}`);
  console.log(`   State saved to batch/batch-api-state.json`);
  console.log(`   Poll with: node batch/batch-api-runner.mjs --phase collect`);

  return batch.id;
}

// ─── Phase 3: Collect ─────────────────────────────────────────────────────────

function parseResponseJSON(text) {
  // Look for trailing ```json ... ``` block
  const m = text.match(/```json\s*([\s\S]*?)\s*```\s*$/);
  if (m) {
    try { return JSON.parse(m[1]); } catch { /* fall through */ }
  }
  // Fallback: last JSON object in text
  const last = text.lastIndexOf('}');
  const first = text.lastIndexOf('{', last);
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch { /* fall through */ }
  }
  return {};
}

async function writeReport(item, responseText, meta) {
  await fs.mkdir(P.reports, { recursive: true });

  const slug = (meta.company || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const date = new Date().toISOString().split('T')[0];
  const filename = `${item.report_num}-${slug}-${date}.md`;
  const filepath = path.join(P.reports, filename);

  // Add header if Claude's response doesn't start with one
  const header = responseText.trimStart().startsWith('#') ? '' :
    `# Evaluación: ${meta.company || '?'} — ${meta.role || '?'}\n\n` +
    `**Fecha:** ${date}  \n` +
    `**Score:** ${meta.score ?? '?'}/5  \n` +
    `**Legitimacy:** ${meta.legitimacy || '?'}  \n` +
    `**URL:** ${item.url}  \n` +
    `**Report:** ${item.report_num}\n\n---\n\n`;

  await fs.writeFile(filepath, header + responseText, 'utf-8');
  return path.relative(PROJECT_DIR, filepath).replace(/\\/g, '/');
}

async function writeTrackerLine(item, meta, reportPath) {
  await fs.mkdir(P.tracker, { recursive: true });

  const nextNum   = await getNextTrackerNum();
  const date      = new Date().toISOString().split('T')[0];
  const scoreStr  = meta.score != null ? `${Number(meta.score).toFixed(2)}/5` : 'N/A';
  const reportLink = `[${item.report_num}](${reportPath})`;
  const notes     = (meta.tracker?.notes || '').slice(0, 120);

  const line = [
    nextNum,
    date,
    meta.company  || 'Unknown',
    meta.role     || 'Unknown',
    meta.tracker?.status || 'Evaluada',
    scoreStr,
    '❌',           // PDF not generated in API mode
    reportLink,
    notes,
  ].join('\t');

  await fs.writeFile(path.join(P.tracker, `${item.id}.tsv`), line + '\n', 'utf-8');
}

async function phaseCollect(batchId) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  let apiState = {};
  try {
    apiState = JSON.parse(await fs.readFile(P.apiState, 'utf-8'));
  } catch {
    if (!batchId) {
      console.error('ERROR: batch-api-state.json not found. Run --phase submit first, or pass --collect-batch <id>.');
      process.exit(1);
    }
  }

  const targetId = batchId || apiState.batch_id;
  if (!targetId) {
    console.error('ERROR: No batch ID available.');
    process.exit(1);
  }

  console.log(`\n=== Phase 3: Collect (batch ${targetId}) ===`);

  const client = new Anthropic();

  // Poll until ended
  while (true) {
    const batch = await client.messages.batches.retrieve(targetId);
    const { processing, succeeded, errored, canceled, expired } = batch.request_counts;
    process.stdout.write(`\r  Status: ${batch.processing_status} — processing:${processing} done:${succeeded} errored:${errored} canceled:${canceled} expired:${expired}   `);

    if (batch.processing_status === 'ended') { console.log(''); break; }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  console.log('Processing results...');

  let success = 0, errors = 0;
  const now = new Date().toISOString();

  for await (const result of await client.messages.batches.results(targetId)) {
    const customId = result.custom_id;
    const item = apiState.items?.[customId];

    if (!item) {
      console.warn(`  WARN: unknown custom_id ${customId}`);
      continue;
    }

    if (result.result.type !== 'succeeded') {
      const msg = result.result.error?.message || result.result.type;
      console.error(`  #${item.id}: ${result.result.type.toUpperCase()} — ${msg}`);
      await updateStateRow(item.id, { status: 'failed', completed_at: now, error: msg.slice(0, 200) });
      errors++;
      continue;
    }

    const responseText = result.result.message.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    const meta = parseResponseJSON(responseText);

    try {
      const reportPath  = await writeReport(item, responseText, meta);
      await writeTrackerLine(item, meta, reportPath);
      await updateStateRow(item.id, {
        status: 'completed',
        completed_at: now,
        score: meta.score != null ? String(meta.score) : '-',
        error: '-',
      });
      console.log(`  #${item.id}: ✅ ${meta.company || '?'} — ${meta.role || '?'} (${meta.score ?? '?'}/5)`);
      success++;
    } catch (err) {
      console.error(`  #${item.id}: ❌ post-processing: ${err.message}`);
      await updateStateRow(item.id, { status: 'failed', completed_at: now, error: `post-processing: ${err.message.slice(0, 150)}` });
      errors++;
    }
  }

  console.log(`\nCollect complete: ${success} succeeded, ${errors} failed`);

  if (success > 0) {
    console.log('\n=== Merging tracker additions ===');
    try {
      execSync(`node "${path.join(PROJECT_DIR, 'merge-tracker.mjs')}"`, { cwd: PROJECT_DIR, stdio: 'inherit' });
    } catch (err) {
      console.warn('WARN: merge-tracker.mjs failed:', err.message);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (COLLECT_ID) {
    await phaseCollect(COLLECT_ID);
    return;
  }

  // collect-only: skip pending check, go straight to collect
  if (PHASE === 'collect') {
    await phaseCollect(null);
    return;
  }

  const inputItems = await readTSV(P.input);
  const stateItems = await readTSV(P.state);
  const stateById  = Object.fromEntries(stateItems.map(r => [r.id, r]));

  const pending = inputItems.filter(item => {
    if (!item.id || !item.url) return false;
    if (parseInt(item.id, 10) < START_FROM) return false;
    const st = stateById[item.id];
    return !st || st.status === 'pending';
  });

  if (!pending.length) {
    console.log('No pending items. To collect an in-flight batch: node batch/batch-api-runner.mjs --phase collect');
    return;
  }

  console.log(`career-ops batch-api-runner — model: ${MODEL} | pending: ${pending.length}`);

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would process ${pending.length} items:`);
    pending.slice(0, 5).forEach(i => console.log(`  #${i.id}: ${i.url}`));
    if (pending.length > 5) console.log(`  ... and ${pending.length - 5} more`);
    return;
  }

  if (PHASE === 'all' || PHASE === 'prefetch') await phasePrefetch(pending);
  if (PHASE === 'all' || PHASE === 'submit')   await phaseSubmit(pending);
  if (PHASE === 'all' || PHASE === 'collect')  await phaseCollect(null);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
