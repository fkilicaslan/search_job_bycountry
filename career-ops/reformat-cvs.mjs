#!/usr/bin/env node
/**
 * reformat-cvs.mjs — Batch-reformat all CVs in output/ to the new clean traditional format.
 *
 * What it does:
 *  1. Replaces the CSS block with the new template CSS (preserving page width)
 *  2. Replaces the header with the new centered format (name, subtitle, contact, languages, mobility)
 *  3. Injects the Key Achievements section between Summary and Core Competencies
 *  4. Transforms job entries: role title on first line, company on second, company desc on third
 *  5. Removes inline purple/teal accent color styles from education, certs, skills blocks
 *  6. Generates a new PDF for each reformatted HTML
 *
 * Usage:
 *   node reformat-cvs.mjs [--dry-run] [--html-only] [--file=filename.html]
 *
 *   --dry-run     Transform in memory only, print changes, write nothing
 *   --html-only   Write updated HTML files but skip PDF generation
 *   --file=X      Process only a specific file (basename, e.g. cv-fatih-salesforce.html)
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, basename, dirname } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR  = join(__dirname, 'output');
const TEMPLATE    = join(__dirname, 'templates', 'cv-template.html');

const DRY_RUN   = process.argv.includes('--dry-run');
const HTML_ONLY = process.argv.includes('--html-only');
const ONLY_FILE = (process.argv.find(a => a.startsWith('--file=')) || '').replace('--file=', '');

// ── Static header content (same for every CV) ─────────────────────────────────

const NEW_HEADER = `<div class="header avoid-break">
    <h1>FATIH KILICASLAN</h1>
    <div class="header-subtitle">Senior Sales &amp; Business Development Leader | Enterprise B2B SaaS and Services</div>
    <div class="contact-row">
      <span>Berlin, Germany</span>
      <span class="separator">|</span>
      <span>+49 176 754 18 961</span>
      <span class="separator">|</span>
      <span>fth.kilicaslan@gmail.com</span>
      <span class="separator">|</span>
      <a href="https://www.linkedin.com/in/fkilicaslan">linkedin.com/in/fkilicaslan</a>
    </div>
    <div class="header-meta">Languages: English (C1+) &middot; German (C1) &middot; Turkish (Native)</div>
    <div class="header-meta">Mobility: Berlin-based; open to relocation and travel</div>
  </div>`;

// ── Key Achievements section ──────────────────────────────────────────────────

const KEY_ACHIEVEMENTS = `  <div class="section avoid-break">
    <div class="section-title">Key Achievements</div>
    <ul class="achievements-list">
      <li>Established Raynet GmbH&rsquo;s T&uuml;rkiye branch from zero; built a 12-person technical team, generated seven-figure company-wide revenue in the first year, and secured six Tier-1 enterprise clients in Software Asset Management.</li>
      <li>Scaled adesso Turkey through a Managed Capacity service model, growing booked revenue to 258% of the prior year; secured the adesso Group&rsquo;s largest FSI managed services contract &mdash; a multi-year engagement with Akbank, displacing entrenched incumbents.</li>
      <li>Led market entry for beqom&rsquo;s Azure-based SaaS Compensation Management platform in T&uuml;rkiye; generated &euro;680K annual recurring revenue within two years from zero, with Garanti BBVA as first FSI customer via Accenture and Microsoft co-sell.</li>
    </ul>
  </div>`;

// ── Company description lookup ────────────────────────────────────────────────

const COMPANY_DESCS = [
  {
    match: /inha\s*GmbH/i,
    desc:  'Industrial technical distributor (B2B); &euro;5M revenue; 30 employees',
  },
  {
    match: /Raynet\s*GmbH/i,
    desc:  'IT solutions and services; Software Asset Management; &euro;14M revenue; 150 employees',
  },
  {
    match: /adesso\s*Turkey/i,
    desc:  'IT services and consulting; IT outsourcing, managed services; &euro;1.14B group revenue; 10,200 employees',
  },
  {
    match: /Smartiks/i,
    desc:  'Enterprise Software &amp; SaaS (Oracle, beqom, Microsoft); &euro;5.6M revenue; 130 employees',
  },
  {
    match: /Software\s*AG/i,
    desc:  'Enterprise software; webMethods B2B Integration, ARIS BPM; &euro;1.0B revenue; 5,000+ employees',
  },
  {
    match: /Broadcast\s*Systems\s*Engineering/i,
    desc:  'Digital TV, Internet TV, and Pay TV security solutions',
  },
  {
    match: /Verscom/i,
    desc:  'VoIP software solutions for EMEA telecom operators',
  },
  {
    match: /Airties|AirTies/i,
    desc:  'Wi-Fi access point hardware; R&amp;D collaboration with Taiwan-based engineering teams',
  },
  {
    match: /DNA\s*Internet/i,
    desc:  'Web application development for enterprise clients',
  },
  {
    match: /Indesit/i,
    desc:  'Home appliance manufacturer (Whirlpool Group); Fabriano, Italy',
  },
  {
    // Combined earlier-career entry: Broadcast · Verscom · Airties
    match: /Broadcast\s*Systems.*Verscom|Verscom.*Airties/i,
    desc:  'Product management across digital TV, VoIP, and Wi-Fi hardware; Istanbul, T&uuml;rkiye',
  },
  {
    // Career breaks: no description
    match: /Career\s*Break/i,
    desc:  '',
  },
];

function getDesc(companyHtml) {
  const plain = companyHtml
    .replace(/&amp;/g, '&')
    .replace(/&mdash;/g, '—')
    .replace(/&middot;/g, '·')
    .replace(/<[^>]+>/g, '');
  for (const c of COMPANY_DESCS) {
    if (c.match.test(plain)) return c.desc;
  }
  return '';
}

// ── CSS replacement ───────────────────────────────────────────────────────────

function replaceCSS(html, templateHtml) {
  // Preserve the page width from the original
  const widthMatch = html.match(/max-width:\s*([\d.]+(?:mm|in|px|cm))/);
  const pageWidth = widthMatch ? widthMatch[1] : '210mm';

  const cssMatch = templateHtml.match(/<style>([\s\S]*?)<\/style>/);
  if (!cssMatch) return html;

  const newCSS = cssMatch[1].replace('{{PAGE_WIDTH}}', pageWidth);

  // Also fix any ../fonts/ references in the new CSS (files in output/ need ./fonts/ for generate-pdf.mjs)
  return html.replace(/<style>[\s\S]*?<\/style>/, `<style>${newCSS}</style>`);
}

// ── Header replacement ────────────────────────────────────────────────────────

function replaceHeader(html) {
  // Match header from opening tag through its closing </div>, which comes just before
  // the first <!-- PROFESSIONAL SUMMARY --> comment or the first .section div
  return html.replace(
    /<div class="header[^"]*"[^>]*>[\s\S]*?<\/div>(?=\s*\n?\s*(?:<!--|<div class="section))/,
    NEW_HEADER,
  );
}

// ── Key Achievements injection ────────────────────────────────────────────────

function injectKeyAchievements(html) {
  if (/<div class="section-title">Key Achievements/.test(html)) return html; // already present

  // Insert before the Core Competencies section
  const inserted = html.replace(
    /(<!-- CORE COMPETENCIES -->)/,
    `${KEY_ACHIEVEMENTS}\n\n  $1`,
  );
  if (inserted !== html) return inserted;

  // Fallback: look for the competencies section div
  return html.replace(
    /(<div class="section">\s*\n?\s*<div class="section-title">(?:Core Competencies|Kernkompetenzen|Competencias Core))/,
    `${KEY_ACHIEVEMENTS}\n\n  $1`,
  );
}

// ── Job entry transformation ──────────────────────────────────────────────────

function isAlreadyReformatted(html) {
  return /class="job-title"/.test(html);
}

function transformJobs(html) {
  if (isAlreadyReformatted(html)) return html; // idempotent guard

  return html.replace(
    /<div class="(job[^"]*)">([\s\S]*?<\/ul>)\s*<\/div>/g,
    (_, jobClass, inner) => {
      const companyM = inner.match(/<span class="job-company">([\s\S]*?)<\/span>/);
      const periodM  = inner.match(/<span class="job-period">([\s\S]*?)<\/span>/);
      const roleM    = inner.match(/<div class="job-role">([\s\S]*?)<\/div>/);
      const ulM      = inner.match(/(<ul>[\s\S]*<\/ul>)/);

      if (!companyM || !roleM) {
        // Cannot parse — return as-is
        return `<div class="${jobClass}">${inner}</div>`;
      }

      const company  = companyM[1].trim();
      const period   = periodM  ? periodM[1].trim()  : '';
      const roleHtml = roleM[1];
      const ul       = ulM ? ulM[1] : '<ul></ul>';

      const isCareerBreak = /Career\s*Break/i.test(company);

      let titleHtml, employerHtml, descLine;

      if (isCareerBreak) {
        // Career break: the "company" label IS the title; role text gives the location context
        titleHtml    = company;
        employerHtml = roleHtml.replace(/<[^>]+>/g, '').trim();
        descLine     = '';
      } else {
        // Normal job entry
        // Role title = job-role text before the first em-dash, stripping the location span
        const roleTextNoLoc = roleHtml
          .replace(/<span class="job-location">[\s\S]*?<\/span>/g, '')
          .trim();
        const roleTitle = roleTextNoLoc
          .split(/\s*(?:&mdash;|&ndash;|—|–)\s*/)[0]
          .trim();

        // Location span from job-role (keep as-is for HTML fidelity)
        const locM    = roleHtml.match(/<span class="job-location">([\s\S]*?)<\/span>/);
        const locHtml = locM ? ` <span class="job-location">${locM[1]}</span>` : '';

        titleHtml    = roleTitle;
        employerHtml = `${company}${locHtml}`;

        const desc = getDesc(company);
        descLine   = desc ? `\n<div class="job-desc">${desc}</div>` : '';
      }

      return `<div class="${jobClass}">\n<div class="job-header"><span class="job-title">${titleHtml}</span><span class="job-period">${period}</span></div>\n<div class="job-employer">${employerHtml}</div>${descLine}\n${ul}</div>\n`;
    },
  );
}

// ── Remove inline accent colors ───────────────────────────────────────────────

function removeAccentColors(html) {
  // Purple hsl(270, 70%, 45%) — may appear with or without spaces
  html = html.replace(/\s*color:\s*hsl\(\s*270\s*,\s*70%\s*,\s*45%\s*\)\s*;?/g, '');
  // Teal hsl(187, 74%, 32%) and similar
  html = html.replace(/\s*color:\s*hsl\(\s*187[^)]*\)\s*;?/g, '');
  // Leftover gray date color #777
  html = html.replace(/\s*color:\s*#777\s*;?/g, '');
  // Clean up style attributes that are now empty or only contain whitespace/semicolons
  html = html.replace(/\s*style="[\s;]*"/g, '');
  return html;
}

// ── Fix font path for generate-pdf.mjs compatibility ─────────────────────────

function fixFontPaths(html) {
  // generate-pdf.mjs only resolves ./fonts/ → absolute. Normalise ../fonts/ as well.
  return html.replace(/url\(['"]?\.\.\/fonts\//g, "url('./fonts/");
}

// ── Main ─────────────────────────────────────────────────────────────────────

const templateHtml = readFileSync(TEMPLATE, 'utf-8');

let files = readdirSync(OUTPUT_DIR)
  .filter(f => f.startsWith('cv-') && f.endsWith('.html'))
  .sort();

if (ONLY_FILE) {
  files = files.filter(f => f === ONLY_FILE);
  if (files.length === 0) {
    console.error(`File not found in output/: ${ONLY_FILE}`);
    process.exit(1);
  }
}

const mode = DRY_RUN ? ' [DRY RUN]' : HTML_ONLY ? ' [HTML ONLY]' : '';
console.log(`Reformatting ${files.length} CVs to new template format${mode}...\n`);

let success = 0, failed = 0;

for (const filename of files) {
  const htmlPath = join(OUTPUT_DIR, filename);
  const pdfPath  = htmlPath.replace('.html', '.pdf');

  try {
    let html = readFileSync(htmlPath, 'utf-8');

    html = replaceCSS(html, templateHtml);
    html = fixFontPaths(html);
    html = replaceHeader(html);
    html = injectKeyAchievements(html);
    html = transformJobs(html);
    html = removeAccentColors(html);

    if (!DRY_RUN) {
      writeFileSync(htmlPath, html, 'utf-8');

      if (!HTML_ONLY) {
        execSync(
          `node "${join(__dirname, 'generate-pdf.mjs')}" "${htmlPath}" "${pdfPath}" --format=a4`,
          { stdio: ['ignore', 'pipe', 'pipe'], cwd: __dirname },
        );
      }
    }

    const tag = DRY_RUN ? '~' : '✓';
    console.log(`${tag}  ${filename}`);
    success++;
  } catch (err) {
    console.error(`✗  ${filename}: ${err.message}`);
    failed++;
  }
}

console.log(`\n${success} reformatted${DRY_RUN ? ' (dry run)' : ''}, ${failed} failed.`);
if (!DRY_RUN && !HTML_ONLY) {
  console.log('PDFs regenerated in output/');
}
