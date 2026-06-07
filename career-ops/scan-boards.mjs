#!/usr/bin/env node

/**
 * scan-boards.mjs — Job board scanner (LinkedIn + Indeed via Bright Data; Stepstone via Playwright)
 *
 * Applies the same title filter + dedup logic as scan.mjs and feeds results
 * into the same pipeline.md + scan-history.tsv.
 *
 * Prerequisites:
 *   - BRIGHTDATA_API_KEY in .env
 *   - BRIGHTDATA_LINKEDIN_DATASET_ID in .env  (from Bright Data Marketplace)
 *   - BRIGHTDATA_INDEED_DATASET_ID in .env    (from Bright Data Marketplace)
 *
 * Usage:
 *   node scan-boards.mjs                   # all enabled boards
 *   node scan-boards.mjs --dry-run         # preview without writing
 *   node scan-boards.mjs --site indeed     # single board (indeed|linkedin|stepstone)
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
import { chromium } from 'playwright';

const PORTALS_PATH      = 'portals.yml';
const PROFILE_PATH      = 'config/profile.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH     = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Country → Indeed domain mapping — used as fallback when portals.yml omits domain
const INDEED_DOMAIN_MAP = {
  'germany':        'de.indeed.com',
  'austria':        'at.indeed.com',
  'switzerland':    'ch.indeed.com',
  'united kingdom': 'uk.indeed.com',
  'uk':             'uk.indeed.com',
  'france':         'fr.indeed.com',
  'netherlands':    'nl.indeed.com',
  'spain':          'es.indeed.com',
  'italy':          'it.indeed.com',
  'sweden':         'se.indeed.com',
  'denmark':        'dk.indeed.com',
  'norway':         'no.indeed.com',
  'finland':        'fi.indeed.com',
  'belgium':        'be.indeed.com',
  'poland':         'pl.indeed.com',
  'portugal':       'pt.indeed.com',
  'canada':         'ca.indeed.com',
  'australia':      'au.indeed.com',
  'united states':  'www.indeed.com',
  'usa':            'www.indeed.com',
  'us':             'www.indeed.com',
  'india':          'www.indeed.co.in',
  'brazil':         'www.indeed.com.br',
};

function loadProfile() {
  if (!existsSync(PROFILE_PATH)) return {};
  try { return yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) ?? {}; } catch { return {}; }
}

function profileFallbacks(profile) {
  const country  = (profile?.location?.country ?? '').trim();
  const city     = (profile?.location?.city    ?? '').trim();
  const domain   = INDEED_DOMAIN_MAP[country.toLowerCase()] ?? 'www.indeed.com';
  return { country, city, linkedinLocation: country || 'Germany', indeedDomain: domain };
}

mkdirSync('data', { recursive: true });

const BRIGHTDATA_API_BASE = 'https://api.brightdata.com/datasets/v3';
const POLL_INTERVAL_MS    = 8_000;
const POLL_MAX_MS         = 480_000;  // 8 minutes — Indeed snapshots can take 4-6 min

// ── Title filter (verbatim from scan.mjs) ───────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());
  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Dedup (verbatim from scan.mjs) ──────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) {
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }
  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role    = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline + history writers (verbatim from scan.mjs) ─────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = existsSync(PIPELINE_PATH)
    ? readFileSync(PIPELINE_PATH, 'utf-8')
    : '# Pipeline\n\n## Pendientes\n\n';

  const marker = '## Pendientes';
  const idx    = text.indexOf(marker);
  if (idx === -1) {
    const procIdx  = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block    = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    const afterMarker  = idx + marker.length;
    const nextSection  = text.indexOf('\n## ', afterMarker);
    const insertAt     = nextSection === -1 ? text.length : nextSection;
    const block        = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }
  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Bright Data API ─────────────────────────────────────────────────

async function brightDataTrigger(apiKey, datasetId, searchObj) {
  const res = await fetch(
    `${BRIGHTDATA_API_BASE}/trigger?dataset_id=${encodeURIComponent(datasetId)}&type=discover_new&discover_by=keyword`,
    {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify([searchObj]),
    }
  );
  if (!res.ok) throw new Error(`trigger HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.snapshot_id;
}

async function brightDataTriggerUrl(apiKey, datasetId, urls) {
  const res = await fetch(
    `${BRIGHTDATA_API_BASE}/trigger?dataset_id=${encodeURIComponent(datasetId)}&type=discover_new&discover_by=url`,
    {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(urls.map(url => ({ url }))),
    }
  );
  if (!res.ok) throw new Error(`trigger HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.snapshot_id;
}

async function brightDataPoll(apiKey, snapshotId) {
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(
      `${BRIGHTDATA_API_BASE}/snapshot/${snapshotId}?format=json`,
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );
    if (res.status === 202) continue;
    if (!res.ok) throw new Error(`poll HTTP ${res.status}: ${await res.text()}`);
    return await res.json();
  }
  throw new Error(`snapshot ${snapshotId} timed out after ${POLL_MAX_MS / 1000}s`);
}

async function scrapeBrightData(boardConfigs, apiKey, fallbacks = {}) {
  const results = [];
  const errors  = [];

  for (const board of boardConfigs) {
    const datasetId = process.env[board.dataset_id_env];
    if (!datasetId) {
      errors.push({ site: board.site, error: `Missing env var: ${board.dataset_id_env}` });
      continue;
    }

    if (board.site === 'linkedin') {
      // LinkedIn dataset collects by URL — build search URLs from keywords
      const searchUrls = (board.keywords ?? []).map(kw => {
        const params = new URLSearchParams({
          keywords: kw,
          location: board.location || fallbacks.linkedinLocation || 'Germany',
          f_TPR:    'r86400',  // posted in last 24 hours
        });
        return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
      });

      try {
        process.stdout.write(`  [linkedin] ${searchUrls.length} search URLs — triggering...`);
        const snapshotId = await brightDataTriggerUrl(apiKey, datasetId, searchUrls);
        process.stdout.write(' polling...');
        const jobs = await brightDataPoll(apiKey, snapshotId);
        process.stdout.write(` ${(jobs ?? []).length} jobs\n`);

        for (const job of (jobs ?? [])) {
          const url = job.url || job.job_url || job.link || '';
          if (!url) continue;
          results.push({
            title:    job.title       || job.job_title    || '',
            company:  job.company     || job.company_name || '',
            location: job.location    || '',
            url,
            source: 'linkedin',
          });
        }
      } catch (err) {
        process.stdout.write('\n');
        errors.push({ site: 'linkedin', error: err.message });
      }

    } else {
      // Indeed — keyword-based discovery
      for (const keyword of (board.keywords ?? [])) {
        const searchObj = {
          keyword_search: keyword,
          location:       board.location || fallbacks.city    || '',
          country:        board.country  || '',
          domain:         board.domain   || fallbacks.indeedDomain || 'www.indeed.com',
        };

        try {
          process.stdout.write(`  [indeed] "${keyword}" — triggering...`);
          const snapshotId = await brightDataTrigger(apiKey, datasetId, searchObj);
          process.stdout.write(' polling...');
          const jobs = await brightDataPoll(apiKey, snapshotId);
          process.stdout.write(` ${(jobs ?? []).length} jobs\n`);

          for (const job of (jobs ?? [])) {
            const url = job.url || job.job_url || job.link || '';
            if (!url) continue;
            results.push({
              title:    job.title        || job.job_title     || '',
              company:  job.company      || job.company_name  || '',
              location: job.location     || '',
              url,
              source: 'indeed',
            });
          }
        } catch (err) {
          process.stdout.write('\n');
          errors.push({ site: 'indeed', keyword, error: err.message });
        }
      }
    }
  }

  return { results, errors };
}

// ── Stepstone Playwright ─────────────────────────────────────────────

async function scrapeStepstone(stepstoneConfig, browser) {
  const results = [];
  const errors  = [];

  for (const search of (stepstoneConfig.searches ?? [])) {
    const url = `https://www.stepstone.de/jobs?q=${encodeURIComponent(search.keywords)}&where=${encodeURIComponent(search.location)}`;
    process.stdout.write(`  [stepstone] "${search.keywords}" @ ${search.location} — scraping...`);

    // Fresh page per search to avoid rate-limit/session carryover
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8' });

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // Dismiss GDPR cookie banner (try multiple selectors)
      for (const sel of ['[data-at="cookie-consent-accept-all"]', '#onetrust-accept-btn-handler', 'button[id*="accept"]']) {
        try { await page.click(sel, { timeout: 2_500 }); break; } catch { /* no banner */ }
      }

      await page.waitForSelector(
        'article[data-at="job-item"], article[data-testid], [data-genesis-element="JOB_ITEM"]',
        { timeout: 15_000 }
      );

      const maxResults = stepstoneConfig.results_per_search ?? 30;
      const jobCards   = await page.$$eval(
        'article[data-at="job-item"], article[data-testid], [data-genesis-element="JOB_ITEM"]',
        (cards) => cards.map(card => {
          const titleEl  = card.querySelector('[data-at="job-item-title"], h2 a, h2');
          const title    = titleEl?.textContent?.trim() ?? '';
          const anchor   = titleEl?.tagName === 'A' ? titleEl : titleEl?.querySelector('a');
          const href     = anchor?.href ?? '';
          const coEl     = card.querySelector('[data-at="job-item-company-name"], [class*="company"]');
          const company  = coEl?.textContent?.trim() ?? '';
          const locEl    = card.querySelector('[data-at="job-item-location"], [class*="location"]');
          const location = locEl?.textContent?.trim() ?? '';
          return { title, url: href, company, location };
        })
      );

      const valid = jobCards.slice(0, maxResults).filter(j => j.title && j.url);
      process.stdout.write(` ${valid.length} jobs\n`);
      for (const job of valid) results.push({ ...job, source: 'stepstone' });

    } catch (err) {
      process.stdout.write('\n');
      errors.push({ site: 'stepstone', keyword: search.keywords, error: err.message });
    } finally {
      await page.close();
      // Polite delay between searches to avoid rate-limiting
      await new Promise(r => setTimeout(r, 4_000));
    }
  }

  return { results, errors };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args     = process.argv.slice(2);
  const dryRun   = args.includes('--dry-run');
  const siteIdx  = args.indexOf('--site');
  const siteFlag = siteIdx !== -1 ? args[siteIdx + 1] : null;

  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found.');
    process.exit(1);
  }

  const profile     = loadProfile();
  const fallbacks   = profileFallbacks(profile);
  const config      = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const boardSearch = (config.board_searches ?? []).filter(b =>
    b.enabled !== false && (!siteFlag || b.site === siteFlag)
  );

  if (boardSearch.length === 0) {
    console.log('No board_searches configured in portals.yml (or no match for --site flag).');
    process.exit(0);
  }

  const apiKey = process.env.BRIGHTDATA_API_KEY;
  const needsBd = boardSearch.some(b => ['linkedin', 'indeed'].includes(b.site));
  if (needsBd && !apiKey) {
    console.error('Error: BRIGHTDATA_API_KEY not set. Add it to your .env file.');
    console.error('Sign up at: https://brightdata.com (free trial: 1K records, no credit card)');
    process.exit(1);
  }

  const date             = new Date().toISOString().slice(0, 10);
  const titleFilter      = buildTitleFilter(config.title_filter);
  const seenUrls         = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  if (dryRun) console.log('(dry run — no files will be written)\n');

  const allRaw    = [];
  const allErrors = [];
  let   browser   = null;

  // ── Bright Data (LinkedIn + Indeed) ─────────────────────────────────
  const bdBoards = boardSearch.filter(b => ['linkedin', 'indeed'].includes(b.site));
  if (bdBoards.length > 0) {
    console.log(`\nBright Data — scanning ${[...new Set(bdBoards.map(b => b.site))].join(', ')}...`);
    const { results, errors } = await scrapeBrightData(bdBoards, apiKey, fallbacks);
    allRaw.push(...results);
    allErrors.push(...errors);
  }

  // ── Stepstone (Playwright) ───────────────────────────────────────────
  const stepstoneConfig = boardSearch.find(b => b.site === 'stepstone');
  if (stepstoneConfig) {
    console.log('\nStepstone — scraping via Playwright...');
    browser = await chromium.launch({ headless: true });
    try {
      const { results, errors } = await scrapeStepstone(stepstoneConfig, browser);
      allRaw.push(...results);
      allErrors.push(...errors);
    } finally {
      await browser.close();
    }
  }

  // ── Filter + dedup ───────────────────────────────────────────────────
  let totalFound    = allRaw.length;
  let totalFiltered = 0;
  let totalDupes    = 0;
  const newOffers   = [];

  for (const job of allRaw) {
    if (!job.url)                    { totalFiltered++; continue; }
    if (!titleFilter(job.title))     { totalFiltered++; continue; }
    if (seenUrls.has(job.url))       { totalDupes++;    continue; }
    const key = `${(job.company || '').toLowerCase()}::${job.title.toLowerCase()}`;
    if (seenCompanyRoles.has(key))   { totalDupes++;    continue; }

    seenUrls.add(job.url);
    seenCompanyRoles.add(key);
    newOffers.push(job);
  }

  // ── Write ────────────────────────────────────────────────────────────
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // ── Summary ──────────────────────────────────────────────────────────
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Board Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (allErrors.length > 0) {
    console.log(`\nErrors (${allErrors.length}):`);
    for (const e of allErrors) {
      console.log(`  ✗ ${e.site}${e.keyword ? `/${e.keyword}` : ''}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + [${o.source}] ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
