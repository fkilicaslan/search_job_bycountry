#!/usr/bin/env node
/**
 * audit-descriptors.mjs — Validates market-descriptors.yml entries.
 *
 * Reports FAIL for any descriptor that still contains [VERIFY] placeholders
 * in descriptor_quantified or descriptor_short (unverified quantitative claims).
 * Reports PASS only when all descriptors have been personally verified by Fatih.
 *
 * This is an intentional gate: CV generation MUST NOT use descriptors with
 * [VERIFY] placeholders. Fatih fills these during the ingestion phase.
 *
 * Exit codes:
 *   0 — all entries verified (or only warnings)
 *   1 — one or more entries have unverified [VERIFY] placeholders
 */
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import jsyaml from 'js-yaml';
import { readText } from '../lib/safe-fs.mjs';
import { safeStringify } from '../lib/safe-json.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const DESC_PATH = join(ROOT, 'data/corpus/identity/market-descriptors.yml');

const REQUIRED_FIELDS = [
  'original_name',
  'anonymization_strategy',
  'descriptor_short',
  'descriptor_quantified',
  'segment',
  'brand_anchors',
  'anonymize',
  'geographic_reference_allowed',
];

const VALID_STRATEGIES = ['pure_anonymous', 'brand_leveraged', 'size_only'];

const VERIFY_RE = /\[VERIFY[^\]]*\]/;

async function main() {
  let raw;
  try {
    raw = await readText(DESC_PATH);
  } catch (err) {
    process.stderr.write(`✗ Cannot read market-descriptors.yml: ${err.message}\n`);
    process.exit(1);
  }

  let data;
  try {
    data = jsyaml.load(raw);
  } catch (err) {
    process.stderr.write(`✗ YAML parse error: ${err.message}\n`);
    process.exit(1);
  }

  if (!data || typeof data !== 'object') {
    process.stderr.write('✗ market-descriptors.yml is empty or not a mapping\n');
    process.exit(1);
  }

  // Filter out non-entry keys (e.g., top-level comments become nulls in some parsers)
  const entries = Object.entries(data).filter(([, v]) => v && typeof v === 'object');

  const results = [];
  let failCount = 0;

  for (const [key, entry] of entries) {
    const issues = [];

    // Schema completeness
    const missingFields = REQUIRED_FIELDS.filter(f => !(f in entry));
    if (missingFields.length) {
      issues.push(`missing fields: ${missingFields.join(', ')}`);
    }

    // Strategy enum
    if (entry.anonymization_strategy && !VALID_STRATEGIES.includes(entry.anonymization_strategy)) {
      issues.push(`unknown anonymization_strategy: "${entry.anonymization_strategy}"`);
    }

    // brand_anchors must be array for brand_leveraged
    if (entry.anonymization_strategy === 'brand_leveraged') {
      if (!Array.isArray(entry.brand_anchors) || entry.brand_anchors.length === 0) {
        issues.push('brand_leveraged strategy requires non-empty brand_anchors');
      }
    }

    // VERIFY placeholder check
    const unverified = [];
    for (const field of ['descriptor_short', 'descriptor_quantified']) {
      if (entry[field] && VERIFY_RE.test(entry[field])) {
        unverified.push(field);
      }
    }

    const status = unverified.length > 0 ? 'UNVERIFIED' : issues.length > 0 ? 'SCHEMA_ERROR' : 'VERIFIED';
    if (status !== 'VERIFIED') failCount++;

    results.push({ key, status, unverified_fields: unverified, schema_issues: issues });
  }

  // Output
  process.stdout.write(safeStringify({ entries: results, total: entries.length, fail_count: failCount }, 2) + '\n');

  process.stderr.write(`\nDescriptor audit: ${entries.length} entries\n`);
  for (const r of results) {
    const icon = r.status === 'VERIFIED' ? '✓' : '✗';
    const detail = r.status === 'UNVERIFIED'
      ? `unverified fields: ${r.unverified_fields.join(', ')}`
      : r.schema_issues.length
        ? r.schema_issues.join('; ')
        : '';
    process.stderr.write(`  ${icon} ${r.key}: ${r.status}${detail ? ' — ' + detail : ''}\n`);
  }

  if (failCount === 0) {
    process.stderr.write(`\n✓ PASS — all ${entries.length} descriptors verified\n`);
    process.exit(0);
  } else {
    process.stderr.write(`\n✗ FAIL — ${failCount} descriptor(s) have unverified [VERIFY] placeholders\n`);
    process.stderr.write(`  Fill these manually during the ingestion phase before generating CVs.\n`);
    process.exit(1);
  }
}

main().catch(err => { process.stderr.write(`Error: ${err.message}\n`); process.exit(1); });
