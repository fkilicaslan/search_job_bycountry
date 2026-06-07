#!/usr/bin/env node
/**
 * fix-cv-ordering.mjs
 * Fixes experience ordering in CV HTML files:
 * 1. Moves inha GmbH + Career Break (Dec 2024) to the top
 * 2. Inserts Career Break (Aug 2019–Feb 2020) between Raynet and adesso
 * 3. Removes "mycareernow" references
 * 4. Adds page-break-before:always to Work Experience section
 */

import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';

const CAREER_BREAK_AUG2019 = `    <div class="job">
      <div class="job-header">
        <span class="job-company">Career Break — Language Studies and Relocation</span>
        <span class="job-period">Aug 2019 – Feb 2020</span>
      </div>
      <div class="job-role">Self-directed · Istanbul, Turkiye and Berlin, Germany</div>
      <ul>
        <li>B1 and B2 level German language courses at Goethe-Institut; relocation from Istanbul to Germany.</li>
      </ul>
    </div>`;

const CAREER_BREAK_DEC2024 = `    <div class="job">
      <div class="job-header">
        <span class="job-company">Career Break — Professional Development</span>
        <span class="job-period">Dec 2024 – Dec 2025</span>
      </div>
      <div class="job-role">Self-directed · Berlin, Germany</div>
      <ul>
        <li>German language to C1 (Sprachwerkstatt); Scrum PSM I/II and Product Owner PSPO I/II; AI application courses (grade 1.0 and 1.5); LLMs, NLP, agentic AI, and AI deployment in business contexts.</li>
      </ul>
    </div>`;

// Extract all <div class="job">...</div> blocks (handles nested divs)
function extractJobBlocks(html) {
  const blocks = [];
  let i = 0;
  while (i < html.length) {
    const start = html.indexOf('<div class="job">', i);
    if (start === -1) break;
    // Find matching closing div by counting depth
    let depth = 0;
    let j = start;
    while (j < html.length) {
      const nextOpen = html.indexOf('<div', j + 1);
      const nextClose = html.indexOf('</div>', j + 1);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        j = nextOpen;
      } else {
        if (depth === 0) {
          const end = nextClose + '</div>'.length;
          blocks.push({ start, end, html: html.slice(start, end) });
          i = end;
          break;
        }
        depth--;
        j = nextClose;
      }
    }
    if (j >= html.length) break;
  }
  return blocks;
}

function getCompany(block) {
  const m = block.match(/class="job-company">([^<]+)</);
  return m ? m[1].replace(/&amp;/g, '&').trim() : '';
}

function canonicalOrder(company) {
  if (company.includes('inha GmbH')) return 0;
  if (company.includes('Career Break') && (company.includes('Professional Development') || company.includes('Dec 2024'))) return 1;
  if (company.includes('Raynet')) return 2;
  if (company.includes('Career Break') && (company.includes('Language') || company.includes('Aug 2019') || company.includes('Relocation'))) return 3;
  if (company.includes('adesso')) return 4;
  if (company.includes('Smartiks')) return 5;
  if (company.includes('Software AG')) return 6;
  // Everything else (Earlier Career, Broadcast, Verscom, etc.)
  return 7;
}

async function fixFile(filePath) {
  let html = await readFile(filePath, 'utf-8');
  const original = html;
  let changes = [];

  // 1. Remove mycareernow
  if (html.includes('mycareernow')) {
    html = html.replace(/ at mycareernow/g, '');
    html = html.replace(/<span class="cert-org">\s*·\s*mycareernow\s*<\/span>/g, '');
    html = html.replace(/,\s*mycareernow/g, '');
    changes.push('removed mycareernow');
  }

  // 2. Add page-break-before to Work Experience section if missing
  if (!html.includes('page-break-before: always') && html.includes('Work Experience')) {
    html = html.replace(
      /<div class="section">\s*\n\s*<div class="section-title">Work Experience/,
      '<div class="section" style="page-break-before: always;">\n    <div class="section-title">Work Experience'
    );
    changes.push('added page-break-before to Work Experience');
  }

  // 3. Find the experience section boundaries
  const expStart = html.indexOf('<div class="section-title">Work Experience');
  if (expStart === -1) {
    console.log(`  SKIP: no Work Experience section found`);
    return { changed: false };
  }

  // Find the next section after Work Experience
  const afterExp = html.indexOf('<div class="section', expStart + 1);
  const expEnd = afterExp !== -1 ? afterExp : html.lastIndexOf('</div>');

  const expRegion = html.slice(expStart, expEnd);
  const blocks = extractJobBlocks(expRegion);

  if (blocks.length === 0) {
    console.log(`  SKIP: no job blocks found`);
    return { changed: false };
  }

  const companies = blocks.map(b => getCompany(b.html));
  const orders = blocks.map(b => canonicalOrder(getCompany(b.html)));

  // Check if already in correct order
  const hasInhaFirst = orders[0] === 0;
  const hasCareerBreakDec = companies.some(c => c.includes('Professional Development') || (c.includes('Career Break') && !c.includes('Language')));
  const hasCareerBreakAug = companies.some(c => c.includes('Language') || c.includes('Aug 2019'));
  const alreadySorted = orders.every((v, i, a) => i === 0 || v >= a[i - 1]);

  if (alreadySorted && hasCareerBreakAug) {
    console.log(`  OK: already in correct order with both career breaks`);
    if (html !== original) {
      await writeFile(filePath, html, 'utf-8');
      console.log(`  SAVED: ${changes.join(', ')}`);
    }
    return { changed: html !== original, changes };
  }

  // Sort blocks into canonical order
  const sorted = [...blocks].sort((a, b) => canonicalOrder(getCompany(a.html)) - canonicalOrder(getCompany(b.html)));

  // Remove duplicate career breaks (keep only one of each)
  const seen = new Set();
  const deduped = sorted.filter(b => {
    const order = canonicalOrder(getCompany(b.html));
    if (seen.has(order)) return false;
    seen.add(order);
    return true;
  });

  // Build new experience section
  let newBlocks = '';
  let prevOrder = -1;
  for (const block of deduped) {
    const order = canonicalOrder(getCompany(block.html));

    // Insert Career Break Aug 2019 between Raynet (2) and adesso (4) if missing
    if (prevOrder === 2 && order === 4 && !hasCareerBreakAug) {
      newBlocks += '\n\n' + CAREER_BREAK_AUG2019;
      changes.push('inserted Career Break Aug 2019');
    }

    // Insert Career Break Dec 2024 after inha (0) if missing
    if (prevOrder === 0 && order !== 1 && !hasCareerBreakDec) {
      newBlocks += '\n\n' + CAREER_BREAK_DEC2024;
      changes.push('inserted Career Break Dec 2024');
    }

    newBlocks += '\n\n' + block.html;
    prevOrder = order;
  }

  // Replace all job blocks in the experience region
  const firstBlock = blocks[0];
  const lastBlock = blocks[blocks.length - 1];
  const blockRegionStart = expStart + firstBlock.start;
  const blockRegionEnd = expStart + lastBlock.end;

  html = html.slice(0, blockRegionStart) + newBlocks + '\n\n  ' + html.slice(blockRegionEnd);
  changes.push('reordered experience blocks');

  await writeFile(filePath, html, 'utf-8');
  console.log(`  FIXED: ${changes.join(', ')}`);
  return { changed: true, changes };
}

// Files to process
const files = [
  'cv-candidate-advisca-gmbh.html',
  'cv-candidate-delve-search-2026-05-12.html',
  'cv-candidate-doctolib-2026-05-12.html',
  'cv-candidate-rimini-street.html',
  'cv-candidate-trust-in-soda.html',
  'cv-dandelion-payments-2026-05-12.html',
  'cv-fatih-ap-systems-gmbh.html',
  'cv-fatih-crossley-scott.html',
  'cv-fatih-ferrero.html',
  'cv-fatih-flair-hamburg.html',
  'cv-fatih-katapult.html',
  'cv-fatih-kilicaslan-abb.html',
  'cv-fatih-kilicaslan-abnormal-ai.html',
  'cv-fatih-kilicaslan-britax-child-safety.html',
  'cv-fatih-kilicaslan-cbre-2026-05-12.html',
  'cv-fatih-kilicaslan-cynet-security.html',
  'cv-fatih-kilicaslan-dymatrix.html',
  'cv-fatih-kilicaslan-french-selection.html',
  'cv-fatih-kilicaslan-huntsman.html',
  'cv-fatih-kilicaslan-jobgether.html',
  'cv-fatih-kilicaslan-legartis.html',
  'cv-fatih-kilicaslan-lesico-process-piping.html',
  'cv-fatih-kilicaslan-levr.html',
  'cv-fatih-kilicaslan-mercor.html',
  'cv-fatih-kilicaslan-salesforce.html',
  'cv-fatih-kilicaslan-salesforce-2026-05-12.html',
  'cv-fatih-oculai.html',
  'cv-fatih-opentext.html',
  'cv-fatih-qlik-2026-05-12.html',
];

const outputDir = resolve('C:/Users/Fatih/Desktop/May2026/Projects/search_job/career-ops/output');
let fixed = 0;

for (const file of files) {
  const filePath = resolve(outputDir, file);
  try {
    console.log(`Processing ${file}...`);
    const result = await fixFile(filePath);
    if (result.changed) fixed++;
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log(`  SKIP: file not found`);
    } else {
      console.log(`  ERROR: ${e.message}`);
    }
  }
}

console.log(`\nDone. Fixed ${fixed} files.`);
