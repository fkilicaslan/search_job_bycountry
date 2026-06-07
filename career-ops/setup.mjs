#!/usr/bin/env node

/**
 * setup.mjs — First-run wizard for career-ops
 *
 * Parses your CV, calls Claude to extract structured data, asks a few
 * targeted questions, then writes config/profile.yml, cv.md, and portals.yml.
 *
 * Usage:
 *   node setup.mjs                          # interactive, no CV
 *   node setup.mjs --cv path/to/cv.pdf      # parse CV first
 *   node setup.mjs --cv cv.pdf --country UK
 *   node setup.mjs --dry-run                # preview without writing
 *   node setup.mjs --force                  # overwrite existing files
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { createInterface } from 'readline';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import Anthropic from '@anthropic-ai/sdk';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROFILE_PATH         = join(__dir, 'config/profile.yml');
const PROFILE_TEMPLATE     = join(__dir, 'config/profile.template.yml');
const CV_PATH              = join(__dir, 'cv.md');
const PORTALS_PATH         = join(__dir, 'portals.yml');
const PORTALS_TEMPLATE     = join(__dir, 'templates/portals.template.yml');
const PORTALS_EXAMPLE      = join(__dir, 'templates/portals.example.yml');
const PROFILE_MD_PATH      = join(__dir, 'modes/_profile.md');
const PROFILE_MD_TEMPLATE  = join(__dir, 'modes/_profile.template.md');
const APPLICATIONS_PATH    = join(__dir, 'data/applications.md');
const PIPELINE_PATH        = join(__dir, 'data/pipeline.md');
const COMPANY_LISTS_DIR    = join(__dir, 'data/company-lists');

// ── Country config ────────────────────────────────────────────────────────────

const INDEED_DOMAIN_MAP = {
  'germany':        { domain: 'de.indeed.com', code: 'DE', location: 'Germany' },
  'austria':        { domain: 'at.indeed.com', code: 'AT', location: 'Austria' },
  'switzerland':    { domain: 'ch.indeed.com', code: 'CH', location: 'Switzerland' },
  'united kingdom': { domain: 'uk.indeed.com', code: 'GB', location: 'United Kingdom' },
  'uk':             { domain: 'uk.indeed.com', code: 'GB', location: 'United Kingdom' },
  'france':         { domain: 'fr.indeed.com', code: 'FR', location: 'France' },
  'netherlands':    { domain: 'nl.indeed.com', code: 'NL', location: 'Netherlands' },
  'spain':          { domain: 'es.indeed.com', code: 'ES', location: 'Spain' },
  'italy':          { domain: 'it.indeed.com', code: 'IT', location: 'Italy' },
  'sweden':         { domain: 'se.indeed.com', code: 'SE', location: 'Sweden' },
  'denmark':        { domain: 'dk.indeed.com', code: 'DK', location: 'Denmark' },
  'norway':         { domain: 'no.indeed.com', code: 'NO', location: 'Norway' },
  'finland':        { domain: 'fi.indeed.com', code: 'FI', location: 'Finland' },
  'belgium':        { domain: 'be.indeed.com', code: 'BE', location: 'Belgium' },
  'poland':         { domain: 'pl.indeed.com', code: 'PL', location: 'Poland' },
  'portugal':       { domain: 'pt.indeed.com', code: 'PT', location: 'Portugal' },
  'canada':         { domain: 'ca.indeed.com', code: 'CA', location: 'Canada' },
  'australia':      { domain: 'au.indeed.com', code: 'AU', location: 'Australia' },
  'united states':  { domain: 'www.indeed.com', code: 'US', location: 'United States' },
  'usa':            { domain: 'www.indeed.com', code: 'US', location: 'United States' },
  'us':             { domain: 'www.indeed.com', code: 'US', location: 'United States' },
  'india':          { domain: 'www.indeed.co.in', code: 'IN', location: 'India' },
  'brazil':         { domain: 'www.indeed.com.br', code: 'BR', location: 'Brazil' },
};

function countryConfig(rawCountry) {
  const key = (rawCountry ?? '').trim().toLowerCase();
  return INDEED_DOMAIN_MAP[key] ?? { domain: 'www.indeed.com', code: '', location: rawCountry || '' };
}

function countrySlug(rawCountry) {
  const key = (rawCountry ?? '').trim().toLowerCase();
  if (key === 'united kingdom' || key === 'uk') return 'uk';
  if (key === 'united states' || key === 'usa' || key === 'us') return 'usa';
  return key.replace(/\s+/g, '-');
}

// ── Readline helpers ──────────────────────────────────────────────────────────

function createRl() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, question, defaultValue = '') {
  const hint = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise(resolve => {
    rl.question(`${question}${hint}: `, answer => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

function askYN(rl, question, defaultYes = true) {
  const hint = defaultYes ? ' [Y/n]' : ' [y/N]';
  return new Promise(resolve => {
    rl.question(`${question}${hint}: `, answer => {
      const a = answer.trim().toLowerCase();
      resolve(a === '' ? defaultYes : a === 'y' || a === 'yes');
    });
  });
}

// ── PDF parsing ───────────────────────────────────────────────────────────────

async function parsePdf(cvPath) {
  const abs = resolve(cvPath);
  if (!existsSync(abs)) {
    console.error(`Error: CV file not found: ${abs}`);
    process.exit(1);
  }
  try {
    const { default: pdfParse } = await import('pdf-parse');
    const data = await pdfParse(readFileSync(abs));
    return data.text;
  } catch (err) {
    console.warn(`  Warning: PDF parse failed (${err.message}). Proceeding without CV text.`);
    return '';
  }
}

// ── Claude extraction ─────────────────────────────────────────────────────────

async function extractWithClaude(cvText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('  Warning: ANTHROPIC_API_KEY not set — skipping Claude extraction.');
    return null;
  }

  console.log('  Calling Claude to extract structured data from CV...');
  const client = new Anthropic({ apiKey });

  const prompt = `Extract structured career data from the CV text below.
Return ONLY valid JSON matching this schema — no markdown, no explanation:
{
  "full_name": "string",
  "email": "string or empty",
  "phone": "string or empty",
  "linkedin": "string or empty",
  "location": "City, Country",
  "headline": "one-sentence professional headline",
  "roles": [{"title": "...", "company": "...", "start": "YYYY-MM", "end": "YYYY-MM or present", "bullets": ["..."]}],
  "skills": ["..."],
  "education": [{"degree": "...", "school": "...", "year": "YYYY"}],
  "languages": [{"language": "...", "level": "Native|C2|C1|B2|B1"}],
  "inferred_target_roles": ["up to 4 job titles matching the candidate's trajectory"],
  "top_achievement": "single most impressive quantified achievement"
}

CV TEXT:
${cvText.slice(0, 12000)}`;

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = msg.content[0]?.text ?? '';
    const jsonStart = raw.indexOf('{');
    const jsonEnd   = raw.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) throw new Error('No JSON in response');
    return JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
  } catch (err) {
    console.warn(`  Warning: Claude extraction failed (${err.message}). Will use manual prompts.`);
    return null;
  }
}

// ── Interactive prompts ───────────────────────────────────────────────────────

async function promptUser(extracted, countryFlag) {
  const rl = createRl();
  console.log('\n── Personal details ─────────────────────────────────────────────');

  const fullName = await ask(rl, 'Full name', extracted?.full_name ?? '');
  const email    = await ask(rl, 'Email', extracted?.email ?? '');
  const phone    = await ask(rl, 'Phone (with country code)', extracted?.phone ?? '');
  const linkedin = await ask(rl, 'LinkedIn URL', extracted?.linkedin ?? '');

  // Location
  const defaultLoc = extracted?.location ?? '';
  const rawLocation = await ask(rl, 'Location (City, Country)', defaultLoc);
  const [city, ...countryParts] = rawLocation.split(',').map(s => s.trim());
  const country = countryFlag || countryParts.join(', ') || '';

  console.log('\n── Target roles ─────────────────────────────────────────────────');
  const suggestedRoles = (extracted?.inferred_target_roles ?? []).join(', ');
  if (suggestedRoles) console.log(`  Suggested: ${suggestedRoles}`);
  const rolesRaw = await ask(rl, 'Target roles (comma-separated)', suggestedRoles);
  const targetRoles = rolesRaw.split(',').map(r => r.trim()).filter(Boolean);

  console.log('\n── Compensation ─────────────────────────────────────────────────');
  const currency    = await ask(rl, 'Currency (EUR/USD/GBP/…)', country.toLowerCase().includes('uk') ? 'GBP' : country.toLowerCase().includes('us') ? 'USD' : 'EUR');
  const targetRange = await ask(rl, `Target comp range (e.g. 90 000–120 000 OTE in ${currency})`, '');
  const minimum     = await ask(rl, `Minimum acceptable (e.g. 75 000 ${currency})`, '');

  console.log('\n── Visa & work preferences ──────────────────────────────────────');
  const visaStatus      = await ask(rl, 'Visa / work authorization', 'No sponsorship needed');
  const workArrangement = await ask(rl, 'Work arrangement (remote/hybrid/onsite/any)', 'hybrid');

  console.log('\n── Languages ────────────────────────────────────────────────────');
  const defaultLangs = (extracted?.languages ?? []).map(l => `${l.language} (${l.level})`).join(', ');
  const langsRaw     = await ask(rl, 'Languages (e.g. "English C2, German C1, Turkish Native")', defaultLangs);

  const languages = langsRaw.split(',').map(l => {
    const m = l.trim().match(/^(.+?)\s+([A-Z][12]|Native|native|C1|C2|B1|B2|A1|A2)$/);
    if (m) return { language: m[1].trim(), level: m[2] };
    return { language: l.trim(), level: '' };
  }).filter(l => l.language);

  rl.close();

  return { fullName, email, phone, linkedin, city, country, targetRoles, currency, targetRange, minimum, visaStatus, workArrangement, languages };
}

// ── File generators ───────────────────────────────────────────────────────────

function generateProfileYml(answers, extracted) {
  const cfg = countryConfig(answers.country);

  const archetypes = answers.targetRoles.slice(0, 4).map((role, i) => ({
    name:  role,
    level: 'Senior',
    fit:   i === 0 ? 'primary' : i <= 1 ? 'primary' : 'secondary',
  }));

  const proofPoints = (extracted?.roles ?? []).slice(0, 2).map(r => ({
    name:       `${r.title} at ${r.company}`,
    url:        '',
    hero_metric: r.bullets?.[0] ?? '',
  }));

  const obj = {
    candidate: {
      full_name:     answers.fullName,
      email:         answers.email,
      phone:         answers.phone,
      location:      `${answers.city}, ${answers.country}`,
      linkedin:      answers.linkedin,
      portfolio_url: '',
      github:        '',
    },
    target_roles: {
      primary:    answers.targetRoles,
      archetypes,
    },
    narrative: {
      headline:    extracted?.headline ?? '',
      exit_story:  '',
      superpowers: [],
      proof_points: proofPoints.length ? proofPoints : [{ name: '', url: '', hero_metric: '' }],
    },
    compensation: {
      target_range: answers.targetRange ? `${answers.targetRange} ${answers.currency}` : '',
      currency:     answers.currency,
      minimum:      answers.minimum ? `${answers.minimum} ${answers.currency}` : '',
      notes:        '',
    },
    location: {
      country:            answers.country,
      city:               answers.city,
      timezone:           '',
      visa_status:        answers.visaStatus,
      onsite_availability: '',
      relocation_open:    false,
    },
    languages: answers.languages.length ? answers.languages : [{ language: 'English', level: 'C2', notes: '' }],
    preferences: {
      work_arrangement: answers.workArrangement,
      min_remote_days:  answers.workArrangement === 'remote' ? 5 : 2,
      deal_breakers:    [],
      nice_to_haves:    [],
    },
    cv: {
      output_format: 'html',
    },
    language: {
      modes_dir: cfg.code === 'DE' || cfg.code === 'AT' || cfg.code === 'CH' ? 'modes/de' : 'modes',
    },
  };

  return `# config/profile.yml — generated by setup.mjs
# Edit freely. This file is gitignored — your data stays local.
# See config/profile.template.yml for full documentation of every field.

${yaml.dump(obj, { lineWidth: 100, quotingType: '"' })}`;
}

function generateCvMd(extracted) {
  if (!extracted) return '# CV\n\n<!-- Paste your CV content here -->\n';

  const lines = ['# CV', ''];

  if (extracted.headline) lines.push(`> ${extracted.headline}`, '');

  // Experience
  if (extracted.roles?.length) {
    lines.push('## Experience', '');
    for (const r of extracted.roles) {
      lines.push(`### ${r.title} — ${r.company}`);
      lines.push(`*${r.start} → ${r.end}*`, '');
      for (const b of (r.bullets ?? [])) lines.push(`- ${b}`);
      lines.push('');
    }
  }

  // Education
  if (extracted.education?.length) {
    lines.push('## Education', '');
    for (const e of extracted.education) {
      lines.push(`- **${e.degree}** — ${e.school} (${e.year})`);
    }
    lines.push('');
  }

  // Skills
  if (extracted.skills?.length) {
    lines.push('## Skills', '');
    lines.push(extracted.skills.join(' · '), '');
  }

  // Languages
  if (extracted.languages?.length) {
    lines.push('## Languages', '');
    for (const l of extracted.languages) lines.push(`- ${l.language}: ${l.level}`);
    lines.push('');
  }

  return lines.join('\n');
}

function generatePortalsYml(answers, companies) {
  const cfg       = countryConfig(answers.country);
  const keywords  = answers.targetRoles.slice(0, 5);

  // Build board_searches
  const boardSearches = [
    {
      site:            'linkedin',
      dataset_id_env:  'BRIGHTDATA_LINKEDIN_DATASET_ID',
      enabled:         true,
      location:        cfg.location || answers.country,
      keywords,
    },
    {
      site:           'indeed',
      dataset_id_env: 'BRIGHTDATA_INDEED_DATASET_ID',
      enabled:        true,
      location:       answers.city,
      country:        cfg.code,
      domain:         cfg.domain,
      keywords,
    },
    {
      site:    'stepstone',
      enabled: cfg.code === 'DE' || cfg.code === 'AT',
      searches: keywords.slice(0, 3).map(kw => ({ keywords: kw, location: answers.city })),
      results_per_search: 30,
    },
  ];

  // Build title_filter from target roles
  const positive = keywords;
  const negative = ['Junior', 'Intern', 'Trainee', 'SDR', 'BDR'];

  const obj = {
    title_filter:   { positive, negative, seniority_boost: ['Senior', 'Lead', 'Head', 'Director', 'VP'] },
    board_searches: boardSearches,
    tracked_companies: companies,
  };

  return `# portals.yml — generated by setup.mjs on ${new Date().toISOString().slice(0, 10)}
# Edit freely. Add companies, tune title_filter, set enabled: false to pause entries.
# Full annotated template: templates/portals.template.yml
# Batteries-included company list: templates/portals.example.yml

${yaml.dump(obj, { lineWidth: 120, quotingType: '"' })}`;
}

// ── Load starter company list ─────────────────────────────────────────────────

function loadCompanyList(country) {
  const slug = countrySlug(country);
  const candidates = [
    join(COMPANY_LISTS_DIR, slug, 'saas-ai.yml'),
    join(COMPANY_LISTS_DIR, slug.split('-')[0], 'saas-ai.yml'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const list = yaml.load(readFileSync(p, 'utf-8'));
        if (Array.isArray(list)) return list;
      } catch { /* skip */ }
    }
  }
  return [];
}

// ── Write helpers ─────────────────────────────────────────────────────────────

function writeIfMissing(path, content, label) {
  if (!existsSync(path)) {
    writeFileSync(path, content, 'utf-8');
    console.log(`  ✓ Created ${label}`);
  } else {
    console.log(`  · Skipped ${label} (already exists — use --force to overwrite)`);
  }
}

function writeAlways(path, content, label) {
  writeFileSync(path, content, 'utf-8');
  console.log(`  ✓ Wrote ${label}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv    = process.argv.slice(2);
  const dryRun  = argv.includes('--dry-run');
  const force   = argv.includes('--force');
  const cvIdx   = argv.indexOf('--cv');
  const cvPath  = cvIdx !== -1 ? argv[cvIdx + 1] : null;
  const ctryIdx = argv.indexOf('--country');
  const countryFlag = ctryIdx !== -1 ? argv[ctryIdx + 1] : null;

  console.log('career-ops setup wizard');
  console.log('━'.repeat(45));

  // Check existing files
  const existing = [];
  if (existsSync(PROFILE_PATH))  existing.push('config/profile.yml');
  if (existsSync(CV_PATH))       existing.push('cv.md');
  if (existsSync(PORTALS_PATH))  existing.push('portals.yml');

  if (existing.length > 0 && !force) {
    console.log(`\nFound existing files: ${existing.join(', ')}`);
    console.log('These will be left untouched. Use --force to overwrite them.\n');
  }

  // Parse CV
  let cvText = '';
  if (cvPath) {
    process.stdout.write(`Parsing CV: ${cvPath} ... `);
    cvText = await parsePdf(cvPath);
    console.log(cvText ? `${cvText.length} chars extracted` : 'empty');
  }

  // Extract with Claude
  let extracted = null;
  if (cvText) {
    extracted = await extractWithClaude(cvText);
    if (extracted) {
      console.log(`  Found: ${extracted.full_name} — ${extracted.inferred_target_roles?.join(', ')}`);
    }
  }

  // Interactive prompts
  console.log('\nA few questions to personalize the system:');
  const answers = await promptUser(extracted, countryFlag);

  // Load company list
  const companies = loadCompanyList(answers.country);
  if (companies.length) {
    console.log(`\n  Loaded ${companies.length} starter companies for ${answers.country} from data/company-lists/`);
  }

  // Generate content
  const profileYml  = generateProfileYml(answers, extracted);
  const cvMd        = generateCvMd(extracted);
  const portalsYml  = generatePortalsYml(answers, companies);

  // Write files
  console.log('\nWriting files:');
  mkdirSync(join(__dir, 'config'), { recursive: true });
  mkdirSync(join(__dir, 'data'),   { recursive: true });

  if (dryRun) {
    console.log('  (dry run — no files written)\n');
    console.log('=== config/profile.yml preview ===');
    console.log(profileYml.slice(0, 800) + (profileYml.length > 800 ? '\n...' : ''));
    return;
  }

  const write = force ? writeAlways : writeIfMissing;
  write(PROFILE_PATH,      profileYml,  'config/profile.yml');
  write(CV_PATH,           cvMd,        'cv.md');
  write(PORTALS_PATH,      portalsYml,  'portals.yml');

  // _profile.md — always copy from template if missing
  if (!existsSync(PROFILE_MD_PATH) && existsSync(PROFILE_MD_TEMPLATE)) {
    const templateContent = readFileSync(PROFILE_MD_TEMPLATE, 'utf-8');
    writeFileSync(PROFILE_MD_PATH, templateContent, 'utf-8');
    console.log('  ✓ Created modes/_profile.md');
  }

  // Tracker and pipeline stubs
  writeIfMissing(
    APPLICATIONS_PATH,
    '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n',
    'data/applications.md'
  );
  writeIfMissing(
    PIPELINE_PATH,
    '# Pipeline\n\n## Pendientes\n\n',
    'data/pipeline.md'
  );

  console.log('\n━'.repeat(45));
  console.log('Setup complete! Next steps:\n');
  console.log('  1. Review config/profile.yml and fill in any gaps');
  console.log('  2. node scan-boards.mjs          # discover new job postings');
  console.log('  3. Open data/pipeline.md and paste a job URL to evaluate it');
  if (!existsSync(join(__dir, '.env'))) {
    console.log('\n  ⚠  No .env file found. Create one with:');
    console.log('     ANTHROPIC_API_KEY=your_key_here');
    console.log('     BRIGHTDATA_API_KEY=your_key_here     # optional, for LinkedIn+Indeed scan');
  }
  console.log('\n  See AGENTS.md for the full command reference.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
