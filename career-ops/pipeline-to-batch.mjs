#!/usr/bin/env node
// pipeline-to-batch.mjs — Export pending pipeline.md items to batch-input.tsv

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

const PIPELINE   = path.join(__dirname, 'data', 'pipeline.md');
const BATCH_INPUT = path.join(__dirname, 'batch', 'batch-input.tsv');
const BATCH_STATE = path.join(__dirname, 'batch', 'batch-state.tsv');

// Read existing batch-input IDs and URLs to avoid duplicates
const inputContent = await fs.readFile(BATCH_INPUT, 'utf-8');
const inputLines = inputContent.trim().split('\n');
const existingUrls = new Set(inputLines.slice(1).map(l => l.split('\t')[1]?.trim()).filter(Boolean));
const lastId = inputLines.slice(1).reduce((max, l) => {
  const id = parseInt(l.split('\t')[0]);
  return isNaN(id) ? max : Math.max(max, id);
}, 0);

// Read already-evaluated URLs from batch-state
const stateContent = await fs.readFile(BATCH_STATE, 'utf-8').catch(() => '');
const evaluatedUrls = new Set(
  stateContent.split('\n').slice(1)
    .filter(l => l.includes('\tcompleted\t'))
    .map(l => l.split('\t')[1]?.trim())
    .filter(Boolean)
);

// Parse pipeline.md pending items
const pipelineContent = await fs.readFile(PIPELINE, 'utf-8');
const pendingLines = pipelineContent.split('\n').filter(l => l.startsWith('- [ ]'));

const newItems = [];
let nextId = lastId + 1;

for (const line of pendingLines) {
  const parts = line.replace('- [ ] ', '').split(' | ').map(p => p.trim());
  const url = parts[0];
  const company = parts[1] || '';
  const title = parts[2] || '';

  if (!url || !url.startsWith('http')) continue;
  if (existingUrls.has(url)) continue;
  if (evaluatedUrls.has(url)) continue;

  const notes = [company, title].filter(Boolean).join(' | ');
  newItems.push({ id: nextId++, url, notes });
}

console.log(`pipeline-to-batch:`);
console.log(`  Pending in pipeline.md: ${pendingLines.length}`);
console.log(`  Already in batch-input: ${existingUrls.size}`);
console.log(`  New to add:             ${newItems.length}`);
console.log(`  Starting ID:            ${lastId + 1}`);

if (DRY_RUN) {
  console.log(`\n[DRY RUN] First 5 items:`);
  newItems.slice(0, 5).forEach(i => console.log(`  #${i.id}: ${i.url}`));
  process.exit(0);
}

if (newItems.length === 0) {
  console.log('Nothing to add.');
  process.exit(0);
}

const newLines = newItems.map(i => `${i.id}\t${i.url}\tpipeline\t${i.notes}`);
await fs.appendFile(BATCH_INPUT, '\n' + newLines.join('\n'), 'utf-8');
console.log(`\n✅ Added ${newItems.length} items to batch-input.tsv (IDs ${lastId + 1}–${nextId - 1})`);
