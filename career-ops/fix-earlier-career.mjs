#!/usr/bin/env node
/**
 * fix-earlier-career.mjs — Normalise the "Earlier Career" job block in every CV.
 *
 * Correct values (per candidate instruction):
 *   Title  : Earlier Career — Product & Technical Roles
 *   Period : 2002 – 2009
 *   Employer: Broadcast Systems Engineering · Verscom · Airties · Istanbul, Türkiye
 *
 * Usage:
 *   node fix-earlier-career.mjs [--dry-run] [--html-only]
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, 'output');
const DRY_RUN   = process.argv.includes('--dry-run');
const HTML_ONLY = process.argv.includes('--html-only');

const NEW_TITLE    = 'Earlier Career &mdash; Product &amp; Technical Roles';
const NEW_PERIOD   = '2002 &ndash; 2009';
const NEW_EMPLOYER = 'Broadcast Systems Engineering &middot; Verscom &middot; Airties <span class="job-location">&middot; Istanbul, T&uuml;rkiye</span>';

function fixBlock(html) {
  return html.replace(
    /<div class="(job[^"]*)">([\s\S]*?<\/ul>)\s*<\/div>/g,
    (fullMatch, jobClass, inner) => {
      // Only touch the block that contains Broadcast Systems Engineering
      if (!inner.includes('Broadcast Systems Engineering')) return fullMatch;

      let out = inner;

      // Handle both new format (job-title) and old format (job-company)
      const hasNewFormat = /<span class="job-title">/.test(out);

      if (hasNewFormat) {
        // New format: replace job-title and job-employer
        out = out.replace(
          /(<span class="job-title">)[^<]*(<\/span>)/,
          `$1${NEW_TITLE}$2`,
        );
        out = out.replace(
          /(<span class="job-period">)[^<]*(<\/span>)/,
          `$1${NEW_PERIOD}$2`,
        );
        out = out.replace(
          /<div class="job-employer">[\s\S]*?<\/div>/,
          `<div class="job-employer">${NEW_EMPLOYER}</div>`,
        );
      } else {
        // Old format: replace job-company content, job-period, and reconstruct
        // as new format so the new CSS applies correctly
        const periodM = out.match(/<span class="job-period">([\s\S]*?)<\/span>/);
        const ulM     = out.match(/(<ul>[\s\S]*<\/ul>)/);
        const ul      = ulM ? ulM[1] : '<ul></ul>';

        out = `\n<div class="job-header"><span class="job-title">${NEW_TITLE}</span><span class="job-period">${NEW_PERIOD}</span></div>\n<div class="job-employer">${NEW_EMPLOYER}</div>\n${ul}\n`;
      }

      return `<div class="${jobClass}">${out}</div>`;
    },
  );
}

const files = readdirSync(OUTPUT_DIR)
  .filter(f => f.startsWith('cv-') && f.endsWith('.html'))
  .sort();

console.log(`Fixing Earlier Career blocks${DRY_RUN ? ' [DRY RUN]' : ''}...\n`);

let fixed = 0, skipped = 0, failed = 0;

for (const filename of files) {
  const htmlPath = join(OUTPUT_DIR, filename);
  const pdfPath  = htmlPath.replace('.html', '.pdf');

  try {
    const original = readFileSync(htmlPath, 'utf-8');

    if (!original.includes('Broadcast Systems Engineering')) {
      skipped++;
      continue;
    }

    const updated = fixBlock(original);

    if (updated === original) {
      console.log(`=  ${filename} (already correct)`);
      skipped++;
      continue;
    }

    if (!DRY_RUN) {
      writeFileSync(htmlPath, updated, 'utf-8');

      if (!HTML_ONLY) {
        execSync(
          `node "${join(__dirname, 'generate-pdf.mjs')}" "${htmlPath}" "${pdfPath}" --format=a4`,
          { stdio: ['ignore', 'pipe', 'pipe'], cwd: __dirname },
        );
      }
    }

    console.log(`${DRY_RUN ? '~' : '✓'}  ${filename}`);
    fixed++;
  } catch (err) {
    console.error(`✗  ${filename}: ${err.message}`);
    failed++;
  }
}

console.log(`\n${fixed} fixed, ${skipped} skipped, ${failed} failed.`);
