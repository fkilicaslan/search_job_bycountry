#!/usr/bin/env node
/**
 * corpus-search.mjs — CLI search across the career corpus.
 *
 * Usage:
 *   node scripts/corpus-search.mjs "Akbank"
 *   node scripts/corpus-search.mjs "Türkiye" --mode exact
 *   node scripts/corpus-search.mjs "market entry" --mode semantic --top-k 5
 *   node scripts/corpus-search.mjs "beqom" --json
 *
 * Flags:
 *   --mode exact|semantic|hybrid   (default: hybrid)
 *   --top-k N                      (default: 10)
 *   --json                         Machine-readable output to stdout
 */
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { searchCorpus } from '../lib/corpus.mjs';
import { safeStringify } from '../lib/safe-json.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args  = argv.slice(2);
  const query = args.find(a => !a.startsWith('--'));
  if (!query) {
    process.stderr.write([
      'Usage: corpus-search.mjs <query> [options]',
      '',
      'Options:',
      '  --mode exact|semantic|hybrid   Match mode (default: hybrid)',
      '  --top-k N                      Max results (default: 10)',
      '  --min-score N                  Semantic similarity threshold 0-1 (default: 0.55)',
      '  --json                         JSON output to stdout',
    ].join('\n') + '\n');
    process.exit(1);
  }
  const modeIdx     = args.indexOf('--mode');
  const mode        = modeIdx >= 0 ? args[modeIdx + 1] : 'hybrid';
  const topKIdx     = args.indexOf('--top-k');
  const topK        = topKIdx >= 0 ? parseInt(args[topKIdx + 1], 10) : 10;
  const minScoreIdx = args.indexOf('--min-score');
  const minScore    = minScoreIdx >= 0 ? parseFloat(args[minScoreIdx + 1]) : 0.55;
  const json        = args.includes('--json');
  return { query, mode, topK, minScore, json };
}

async function main() {
  const { query, mode, topK, minScore, json } = parseArgs(process.argv);

  const results = await searchCorpus(query, { mode, topK, minScore });

  if (json) {
    process.stdout.write(safeStringify({ query, mode, topK, minScore, results }, 2) + '\n');
    return;
  }

  // Human-readable output
  const exact    = results.filter(r => r.matchType === 'exact');
  const semantic = results.filter(r => r.matchType === 'semantic');

  process.stdout.write(`\n${results.length} match${results.length !== 1 ? 'es' : ''} (${mode}):\n\n`);

  if (exact.length > 0) {
    process.stdout.write('EXACT MATCHES:\n');
    for (const r of exact) {
      process.stdout.write(`  ${r.file}:${r.line}\n`);
      process.stdout.write(`    "${r.snippet.slice(0, 100)}${r.snippet.length > 100 ? '…' : ''}"\n`);
    }
  }

  if (semantic.length > 0) {
    if (exact.length > 0) process.stdout.write('\n');
    process.stdout.write(`SEMANTIC NEIGHBORS (≥${minScore}):\n`);
    for (const r of semantic) {
      process.stdout.write(`  ${r.file}:${r.line}  (${r.score.toFixed(2)})\n`);
      process.stdout.write(`    "${r.snippet.slice(0, 100)}${r.snippet.length > 100 ? '…' : ''}"\n`);
    }
  }

  if (results.length === 0) {
    process.stdout.write('  No matches found.\n');
  }

  process.stdout.write('\n');
}

main().catch(err => { console.error(err.message); process.exit(1); });
