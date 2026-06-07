#!/usr/bin/env node
// filter-pipeline.mjs — Filter pipeline.md based on location and title criteria
// Run: node filter-pipeline.mjs [--dry-run]

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');
const PIPELINE = path.join(__dirname, 'data', 'pipeline.md');

// ─── Location: remove if clearly non-DACH/EMEA/Remote ────────────────────────

const LOCATION_EXCLUDE = [
  /\bUnited States\b/i, /\bUSA\b/, /\b(New York|NYC)\b/i, /\bSan Francisco\b/i,
  /\bChicago\b/i, /\bSeattle\b/i, /\bAustin\b/i, /\bBoston\b/i, /\bPalo Alto\b/i,
  /\bNortheast\b/i, /\bNorth America\b/i, /\bRemote \(.*US.*\)/i,
  /\bCanada\b/i, /\bToronto\b/i, /\bVancouver\b/i, /\bMontreal\b/i,
  /\bLATAM\b/i, /\bLatin America\b/i, /\bBrazil\b/i, /\bMexico\b/i, /\bArgentina\b/i,
  /\bIndia\b/i, /\bBangalore\b/i, /\bMumbai\b/i, /\bDelhi\b/i,
  /\bSouth Korea\b/i, /\bSeoul\b/i, /\bJapan\b/i, /\bTokyo\b/i,
  /\bSingapore\b/i, /\bAustralia\b/i, /\bSydney\b/i, /\bMelbourne\b/i,
  /\bANZ\b/i, /\bAsia\b/i, /\bAPAC\b/i, /\bOceania\b/i,
  /\bChina\b/i, /\bTaiwan\b/i, /\bHong Kong\b/i,
  /\bMiddle East\b/i, /\bDubai\b/i, /\bRiyadh\b/i,
  /\bAfrica\b/i, /\bSouth Africa\b/i,
];

// ─── Title: remove if matches these ──────────────────────────────────────────

const TITLE_EXCLUDE = [
  // Native German signals — C1 not sufficient
  /\bGerman[- ]speaking\b/i,
  /\bNative German\b/i,
  /\bGerman native speaker\b/i,
  /\bFluent German required\b/i,
  /\bGerman fluency required\b/i,
  /\bVerhandlungssicher(es|e)? Deutsch\b/i,
  /\bMuttersprachlich(es|e)? Deutsch\b/i,
  /\bDeutsch.*Muttersprachenniveau\b/i,
  /\bDeutsch C2\b/i,

  // Too junior
  /\bBDR\b/, /\bBusiness Development Representative\b/i,
  /\bSDR\b/, /\bSales Development Representative\b/i,
  /\bInside Sales Representative\b/i,
  /\bJunior Account Executive\b/i,
  /\bJunior Sales\b/i,
  /\bSales Trainee\b/i,
  /\bSales Development\b/i,

  // Engineering / technical (not sales)
  /\bMachine Learning Engineer\b/i,
  /\b\bML Engineer\b/i,
  /\bSoftware Engineer\b/i,
  /\bData Engineer\b/i,
  /\bResearch Engineer\b/i,
  /\bResearcher\b/i,
  /\bPrincipal Engineer\b/i,
  /\bStaff (Machine Learning|ML|Software|Data)\b/i,
  /\bSenior (Machine Learning|ML|Software|Data) Engineer\b/i,
  /\bLead (Machine Learning|ML|Software|Data) Engineer\b/i,
  /\bEngineering Manager\b/i,
  /\bForward Deployed.*Engineer\b/i,
  /\bGTM Engineer\b/i,

  // Pre-sales / solutions (unless explicitly AI Sales Engineer)
  /\bSolutions Engineer\b/i,
  /\bPresales\b/i, /\bPre-[Ss]ales [Ee]ngineer\b/i,
  /\bSolutions Consultant\b/i,
  /\bPre-Sales Consultant\b/i,

  // Operations / admin / support
  /\bRevenue Accountant\b/i,
  /\bRevenue Accounting\b/i,
  /\bRevenue Operations\b/i, /\bRevOps\b/i,
  /\bOperations Analyst\b/i,
  /\bProgram Analyst\b/i,
  /\bData Analyst\b/i,
  /\bGTM Data\b/i,
  /\bGTM Enablement\b/i,
  /\bGTM Recruiter\b/i,
  /\bRevenue Strategy\b/i,

  // HR / recruiting
  /\bRecruiter\b/i,
  /\bTalent\b/i,
  /\bExecutive Assistant\b/i,

  // Marketing
  /\bGrowth Marketing\b/i,
  /\bB2B Marketing\b/i,
  /\bContent Writer\b/i,
  /\bProduct Designer\b/i,
  /\bGrowth Performance\b/i,

  // Misc non-target
  /\bProduct Manager\b/i,
  /\bCustomer Success Manager\b/i,
  /\bCustomer Success\b/i,
  /\bScaled Customer Success\b/i,
  /\bGrowth Generalist\b/i,
  /\bGrowth Coordinator\b/i,
  /\bLegal Counsel\b/i,
  /\bSelbstständiger\b/i,
  /\bKey Account.*HoReCa\b/i,
  /\bInternship\b/i,
  /\bApprentice\b/i,
];

// ─── Title: keep if matches these ────────────────────────────────────────────

const TITLE_INCLUDE = [
  // Account Executive family
  /\bAccount Executive\b/i,

  // Account Manager family
  /\bAccount Manager\b/i,
  /\bKey Account Manager\b/i,
  /\bKAM\b/,

  // Sales Manager family
  /\bSales Manager\b/i,
  /\bSolution Sales\b/i,
  /\bNew Business Sales\b/i,

  // Sales Director / Head of Sales
  /\bSales Director\b/i,
  /\bHead of Sales\b/i,
  /\bHead of Enterprise Sales\b/i,
  /\bDirector.*(Sales|Enterprise Sales|Strategic Accounts|International Sales)\b/i,
  /\b(VP|RVP|SVP).*(Sales|Revenue|Partnerships)\b/i,

  // Partnership & Alliance family
  /\bPartnership[s]? Manager\b/i,
  /\bAlliance[s]? Manager\b/i,
  /\bChannel Partner[s]? Manager\b/i,
  /\bChannel (Sales|Account) Manager\b/i,
  /\bISV Alliance\b/i,
  /\bTechnology Alliance\b/i,
  /\bCloud Alliance\b/i,
  /\bHyperscaler Alliance\b/i,
  /\bEcosystem (Manager|Partnerships|Lead)\b/i,
  /\bPartner (Account|Sales) Manager\b/i,
  /\bHead of Partnerships\b/i,
  /\bHead of Alliances\b/i,
  /\bDirector of Partnerships\b/i,
  /\bDirector of Alliances\b/i,
  /\bGSI Partnership\b/i,
  /\bSenior Manager.*Partnership\b/i,
  /\bManager.*Partnership\b/i,
  /\bGTM.*Partnership\b/i,

  // Business Development family
  /\bBusiness Development Manager\b/i,
  /\bBusiness Development Executive\b/i,
  /\bBusiness Development Director\b/i,
  /\bHead of Business Development\b/i,
  /\bBD Lead\b/i,
  /\bTeam Lead.*Business Development\b/i,

  // Early-stage / GTM
  /\bFounding (Account|Sales|Partnerships)\b/i,
  /\bFirst Sales Hire\b/i,
  /\bCountry (Manager|Lead)\b/i,
  /\bGTM Lead\b/i,
  /\bHead of GTM\b/i,
  /\bMarket (Launch|Expansion) Manager\b/i,
  /\bRegional Director\b/i,

  // Location/territory helpers
  /\bRegional (Sales|Account|Business)\b/i,
  /\bTerritory (Sales|Account|Manager)\b/i,
  /\bCountry Sales\b/i,
  /\bEnterprise Sales\b/i,
  /\bStrategic Account\b/i,
  /\bClient Partner\b/i,
  /\bNamed Account\b/i,
  /\bGlobal Account\b/i,
  /\bField (Sales|Account)\b/i,
  /\bCommercial Account\b/i,
  /\bNew Logo\b/i,

  // Engineering + Sales hybrid (EE/IS background)
  /\bSales Engineer\b/i,
  /\bSenior Sales Engineer\b/i,

  // AI/ML entry-level (deliberate career pivot)
  /\b(Junior|Entry.Level|Associate).*(AI|Generative AI|LLM|Agentic)\b/i,
  /\bAI (Developer|Engineer|Implementation Engineer|Customer Engineer)\b/i,
  /\bAI Sales Engineer\b/i,
  /\bLLM Application Engineer\b/i,
  /\bGenerative AI Developer\b/i,
  /\bApplied AI (Developer|Engineer)\b/i,
];

// ─── Filter logic ─────────────────────────────────────────────────────────────

function shouldKeep(line) {
  // Only filter pending items
  if (!line.startsWith('- [ ]')) return { keep: true, reason: 'not-pending' };

  const parts = line.split('|').map(p => p.trim());
  const title = parts[2] || '';
  const company = parts[1] || '';
  // Location is often embedded in title or after the title in some entries
  // For scan.mjs entries, location is usually in the title field
  const fullText = line;

  // Check location exclusions
  for (const re of LOCATION_EXCLUDE) {
    if (re.test(fullText)) {
      return { keep: false, reason: `location: ${re.source}` };
    }
  }

  // Check title exclusions
  for (const re of TITLE_EXCLUDE) {
    if (re.test(title)) {
      return { keep: false, reason: `title-exclude: ${re.source}` };
    }
  }

  // Check title inclusions
  for (const re of TITLE_INCLUDE) {
    if (re.test(title)) {
      return { keep: true, reason: `title-include: ${re.source}` };
    }
  }

  // If title doesn't match any inclusion pattern, exclude
  return { keep: false, reason: `title-no-match: "${title}"` };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const content = await fs.readFile(PIPELINE, 'utf-8');
const lines = content.split('\n');

let kept = 0, removed = 0;
const removedLines = [];
const filteredLines = lines.map(line => {
  const { keep, reason } = shouldKeep(line);
  if (!keep) {
    removed++;
    removedLines.push(`  REMOVED [${reason}]: ${line.slice(0, 100)}`);
    return null;
  }
  if (line.startsWith('- [ ]')) kept++;
  return line;
}).filter(l => l !== null);

console.log(`Filter results:`);
console.log(`  Kept:    ${kept} pending items`);
console.log(`  Removed: ${removed} pending items`);

if (DRY_RUN) {
  console.log(`\n[DRY RUN] Removed lines:`);
  removedLines.slice(0, 50).forEach(l => console.log(l));
  if (removedLines.length > 50) console.log(`  ... and ${removedLines.length - 50} more`);
} else {
  // Remove consecutive blank lines left by removals
  const cleaned = filteredLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  await fs.writeFile(PIPELINE, cleaned, 'utf-8');
  console.log(`\npipeline.md updated.`);
  console.log(`\nRemoved items (first 30):`);
  removedLines.slice(0, 30).forEach(l => console.log(l));
}
