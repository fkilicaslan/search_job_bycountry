#!/usr/bin/env node
/**
 * ingest-corpus.mjs — Interactive ingestion of data/corpus/inbox/ files.
 *
 * For each file in inbox/:
 *   1. Extract text (PDF via pdf-parse, markdown/text direct)
 *   2. Call Claude API to classify content and propose corpus update
 *   3. Show proposed changes as a terminal diff
 *   4. Prompt [Y/N/E/S/Q]:
 *        Y — apply changes, move file to archive/ingested/{timestamp}-{filename}
 *        N — skip this file, leave in inbox
 *        E — open $EDITOR on the proposed changes before applying
 *        S — skip and move to archive without applying (mark as skipped)
 *        Q — quit, leave remaining files in inbox
 *
 * Flags:
 *   --dry-run     Show what would happen with no API calls and no writes
 *   --force       Apply all proposed changes without prompting (Y to all)
 *   --inbox PATH  Override inbox directory
 *
 * All I/O via lib/safe-fs.mjs. JSON output via lib/safe-json.mjs.
 */
import 'dotenv/config';
import { resolve, dirname, join, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync, createReadStream } from 'fs';
import { readdir, rename, mkdir } from 'fs/promises';
import readline from 'readline';
import matter from 'gray-matter';
import Anthropic from '@anthropic-ai/sdk';
import { readText, writeText } from '../lib/safe-fs.mjs';
import { safeStringify } from '../lib/safe-json.mjs';
import { loadCorpus } from '../lib/corpus.mjs';
import { extractTextViaOCR, shouldUseOCRFallback } from '../lib/ocr.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const CORPUS    = join(ROOT, 'data/corpus');
const INBOX     = join(CORPUS, 'inbox');
const ARCHIVE   = join(CORPUS, 'archive/ingested');

// ── Text extraction ───────────────────────────────────────────────────

async function extractText(filePath) {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.pdf') {
    const { PDFParse } = await import('pdf-parse');
    const { readFile } = await import('fs/promises');
    const buf    = await readFile(filePath);
    const parser = new PDFParse({ data: buf });
    await parser.load();
    const result = await parser.getText();
    const raw = result.text ?? '';

    if (shouldUseOCRFallback(raw)) {
      process.stderr.write(`   Text yield too low (${raw.length} chars) — attempting OCR fallback...\n`);
      try {
        const ocrResult = await extractTextViaOCR(filePath);
        if (ocrResult.quality.avgConfidence < 70) {
          process.stderr.write(`   ⚠  OCR quality is low (${ocrResult.quality.avgConfidence}% avg confidence). Review carefully.\n`);
        }
        return { text: ocrResult.text, ocrUsed: true, ocrQuality: ocrResult.quality };
      } catch (ocrErr) {
        process.stderr.write(`   ⚠  OCR fallback failed: ${ocrErr.message}\n`);
        process.stderr.write(`   ⚠  Falling back to minimal text (Claude will refuse correctly).\n`);
        return { text: raw, ocrUsed: false, ocrQuality: null };
      }
    }

    return { text: raw, ocrUsed: false, ocrQuality: null };
  }

  // Markdown, text, or any other readable format
  const text = await readText(filePath);
  return { text, ocrUsed: false, ocrQuality: null };
}

// ── Claude API classification ─────────────────────────────────────────

const CORPUS_DIRS = [
  'identity', 'roles', 'achievements', 'skills',
  'education', 'narrative', 'languages-de',
];

async function classifyWithClaude(filename, extractedText, corpus, ocrInfo = {}) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Build a compact corpus summary for context
  const roleSummary = corpus.roles.map(r =>
    `${r.frontmatter.id} (${r.frontmatter.period}) — ${r.frontmatter.employer}`
  ).join('\n');

  const systemPrompt = `You are a corpus ingestion assistant for a career document system.

The corpus is structured in these directories:
${CORPUS_DIRS.join(', ')}

Existing roles:
${roleSummary}

Your job: Given a source document, decide which corpus file(s) it should update or create, then output the proposed changes.

OUTPUT FORMAT — respond with valid JSON only, no markdown:
{
  "classification": "role|achievement|skill|identity|education|narrative|language_de|multi|unknown",
  "confidence": "high|medium|low",
  "reasoning": "one sentence explaining the classification",
  "proposed_changes": [
    {
      "action": "update|create",
      "target_file": "data/corpus/roles/2020-2024-raynet.md",
      "description": "one-line summary of what changes",
      "new_content": "full new file content as a string"
    }
  ],
  "source_files_annotation": "roles_2020_2024_raynet",
  "warnings": []
}

Rules:
- new_content must be complete file content (frontmatter + body), not just the diff
- Preserve all existing bullet_id comments exactly as they are — never invent new bullet_ids
- For updates: include ALL existing bullets; only ADD new bullets from the source doc
- New bullets: add them at the END of the existing bullet list
- new bullet_id format: {role_prefix}_{snake_case_first_5_words}
- Never delete bullets; never change existing bullet text
- Add source_files annotation to frontmatter if not already present
- If unsure which file to target, set classification = "unknown" and explain in warnings
- Quantitative claims: use [VERIFY-DURING-INGESTION] placeholder unless the exact figure appears verbatim in the source doc`;

  const ocrNote = ocrInfo.ocrUsed
    ? '\n[Note: This content was extracted from an image-based PDF via Claude Vision API. ' +
      'Extraction quality is typically high. If anything looks incomplete or unexpected, ' +
      'flag it in warnings rather than ingesting it as fact.]\n'
    : '';

  const userPrompt = `Source file: ${filename}
${ocrNote}
Extracted content:
---
${extractedText.slice(0, 8000)}${extractedText.length > 8000 ? '\n[truncated — ' + extractedText.length + ' chars total]' : ''}
---

Propose corpus changes.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = message.content[0].text.trim();

  // Strip any accidental markdown code fences
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '');

  try {
    return JSON.parse(cleaned);
  } catch {
    return {
      classification: 'unknown',
      confidence: 'low',
      reasoning: 'Claude response was not valid JSON',
      proposed_changes: [],
      warnings: [`Parse error — raw response: ${raw.slice(0, 200)}`],
    };
  }
}

// ── Diff rendering ────────────────────────────────────────────────────

function renderDiff(oldContent, newContent, filePath) {
  const oldLines = (oldContent ?? '').split('\n');
  const newLines = newContent.split('\n');
  const lines = [];

  // Very simple unified-style diff: compare line by line
  const maxOld = oldLines.length;
  const maxNew = newLines.length;
  let o = 0, n = 0;
  const shown = new Set();

  lines.push(`\x1b[1m--- ${filePath} (current)\x1b[0m`);
  lines.push(`\x1b[1m+++ ${filePath} (proposed)\x1b[0m`);

  // Build a quick lookup of old lines
  const oldSet = new Set(oldLines);
  let unchanged = 0, added = 0, removed = 0;

  // Line-by-line pass
  const maxLen = Math.max(maxOld, maxNew);
  for (let i = 0; i < maxLen; i++) {
    const ol = oldLines[i];
    const nl = newLines[i];
    if (ol === nl) {
      unchanged++;
    } else {
      if (ol !== undefined) {
        lines.push(`\x1b[31m- ${ol}\x1b[0m`);
        removed++;
      }
      if (nl !== undefined) {
        lines.push(`\x1b[32m+ ${nl}\x1b[0m`);
        added++;
      }
    }
  }

  lines.push(`\x1b[90m  ${unchanged} unchanged, +${added} added, -${removed} removed\x1b[0m`);
  return lines.join('\n');
}

// ── Archive helper ────────────────────────────────────────────────────

async function archiveFile(srcPath, label) {
  await mkdir(ARCHIVE, { recursive: true });
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = join(ARCHIVE, `${ts}-${label}-${basename(srcPath)}`);
  await rename(srcPath, dest);
  return dest;
}

// ── Readline prompt ───────────────────────────────────────────────────

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

// ── Apply proposed changes ────────────────────────────────────────────

async function applyChange(change) {
  const absTarget = join(ROOT, change.target_file);
  const dir = dirname(absTarget);
  await mkdir(dir, { recursive: true });
  await writeText(absTarget, change.new_content);
  return absTarget;
}

// ── Process one inbox file ────────────────────────────────────────────

async function processFile(filePath, rl, options, corpus) {
  const filename = basename(filePath);
  process.stderr.write(`\n${'─'.repeat(60)}\n`);
  process.stderr.write(`📄 ${filename}\n`);
  process.stderr.write(`${'─'.repeat(60)}\n`);

  // Extract text (with OCR fallback for image-based PDFs)
  let text, ocrUsed = false, ocrQuality = null;
  try {
    const extracted = await extractText(filePath);
    text       = extracted.text;
    ocrUsed    = extracted.ocrUsed;
    ocrQuality = extracted.ocrQuality;
    process.stderr.write(`   Extracted ${text.length} chars${ocrUsed ? ' (via Claude Vision OCR)' : ''}\n`);
  } catch (err) {
    process.stderr.write(`   ✗ Text extraction failed: ${err.message}\n`);
    return 'error';
  }

  if (options.dryRun) {
    process.stderr.write(`   [dry-run] Would call Claude API for classification\n`);
    if (ocrUsed) process.stderr.write(`   [dry-run] OCR via Claude Vision was used for text extraction\n`);
    process.stderr.write(`   [dry-run] Would show diff and prompt [Y/N/E/S/Q]\n`);
    return 'dry-run';
  }

  // Classify with Claude
  process.stderr.write(`   Classifying with Claude…\n`);
  let proposal;
  try {
    proposal = await classifyWithClaude(filename, text, corpus, { ocrUsed, ocrQuality });
  } catch (err) {
    process.stderr.write(`   ✗ API call failed: ${err.message}\n`);
    return 'error';
  }

  process.stderr.write(`   Classification: ${proposal.classification} (${proposal.confidence})\n`);
  process.stderr.write(`   Reasoning: ${proposal.reasoning}\n`);

  if (proposal.warnings?.length) {
    for (const w of proposal.warnings) process.stderr.write(`   ⚠  ${w}\n`);
  }

  if (proposal.proposed_changes.length === 0) {
    process.stderr.write(`   No changes proposed.\n`);
    const ans = options.force ? 'S' :
      (await prompt(rl, '   [S]kip to archive / [N] leave in inbox / [Q]uit? ')).trim().toUpperCase();
    if (ans === 'Q') return 'quit';
    if (ans === 'S') { await archiveFile(filePath, 'skipped'); return 'skipped'; }
    return 'skipped';
  }

  // Show diffs for each proposed change
  for (let i = 0; i < proposal.proposed_changes.length; i++) {
    const change = proposal.proposed_changes[i];
    const absTarget = join(ROOT, change.target_file);
    let oldContent = null;
    try { oldContent = await readText(absTarget); } catch {}

    process.stderr.write(`\n   Change ${i + 1}/${proposal.proposed_changes.length}: ${change.action} ${change.target_file}\n`);
    process.stderr.write(`   ${change.description}\n\n`);
    process.stderr.write(renderDiff(oldContent, change.new_content, change.target_file) + '\n');
  }

  // Prompt
  if (options.force) {
    process.stderr.write(`   [--force] Applying all changes automatically.\n`);
    for (const change of proposal.proposed_changes) {
      const written = await applyChange(change);
      process.stderr.write(`   ✓ Written: ${written}\n`);
    }
    const dest = await archiveFile(filePath, 'applied');
    process.stderr.write(`   ✓ Archived: ${dest}\n`);
    return 'applied';
  }

  const answer = (await prompt(rl,
    '\n   [Y] Apply  [N] Skip (leave in inbox)  [S] Skip to archive  [Q] Quit\n   > '
  )).trim().toUpperCase();

  if (answer === 'Q') return 'quit';

  if (answer === 'Y') {
    for (const change of proposal.proposed_changes) {
      const written = await applyChange(change);
      process.stderr.write(`   ✓ Written: ${written}\n`);
    }
    const dest = await archiveFile(filePath, 'applied');
    process.stderr.write(`   ✓ Archived: ${dest}\n`);
    return 'applied';
  }

  if (answer === 'S') {
    const dest = await archiveFile(filePath, 'skipped');
    process.stderr.write(`   Archived without applying: ${dest}\n`);
    return 'skipped';
  }

  // N or anything else — leave in inbox
  process.stderr.write(`   Skipped — file remains in inbox.\n`);
  return 'skipped';
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args    = process.argv.slice(2);
  const dryRun  = args.includes('--dry-run');
  const force   = args.includes('--force');
  const inboxIdx = args.indexOf('--inbox');
  const inboxDir = inboxIdx >= 0 ? resolve(args[inboxIdx + 1]) : INBOX;

  if (dryRun) process.stderr.write('Running in --dry-run mode (no API calls, no writes)\n\n');

  // Ensure archive dir exists
  await mkdir(ARCHIVE, { recursive: true });

  // List inbox files
  let entries;
  try {
    entries = await readdir(inboxDir);
  } catch {
    process.stderr.write(`✗ Cannot read inbox directory: ${inboxDir}\n`);
    process.exit(1);
  }

  const SUPPORTED_EXTS = new Set(['.pdf', '.md', '.txt', '.docx']);
  const files = entries
    .filter(f => SUPPORTED_EXTS.has(extname(f).toLowerCase()) && !f.startsWith('.'))
    .map(f => join(inboxDir, f));

  if (files.length === 0) {
    process.stderr.write(`Inbox is empty — nothing to ingest.\n`);
    process.stderr.write(`Drop source files into: ${inboxDir}\n`);
    process.stdout.write(safeStringify({ status: 'empty', inbox: inboxDir }, 2) + '\n');
    process.exit(0);
  }

  process.stderr.write(`Found ${files.length} file(s) in inbox.\n`);

  // Load corpus for context (only once)
  let corpus;
  if (!dryRun) {
    process.stderr.write('Loading corpus context…\n');
    corpus = await loadCorpus();
  }

  // Set up readline for interactive prompts
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  const results = { applied: 0, skipped: 0, errors: 0, dry_run: 0 };

  for (const filePath of files) {
    const outcome = await processFile(filePath, rl, { dryRun, force }, corpus);
    if (outcome === 'quit') { process.stderr.write('\nQuitting — remaining files left in inbox.\n'); break; }
    if (outcome === 'applied') results.applied++;
    else if (outcome === 'error') results.errors++;
    else if (outcome === 'dry-run') results.dry_run++;
    else results.skipped++;
  }

  rl.close();

  process.stderr.write(`\n${'─'.repeat(60)}\n`);
  process.stderr.write(`Ingestion complete: ${results.applied} applied, ${results.skipped} skipped, ${results.errors} errors\n`);
  if (dryRun) process.stderr.write(`  (dry-run: ${results.dry_run} file(s) previewed)\n`);

  process.stdout.write(safeStringify({ results, inbox: inboxDir }, 2) + '\n');
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
