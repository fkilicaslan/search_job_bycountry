# Mode: tailor-brief — Pre-Generation Keyword Brief

Runs **before** `modes/pdf.md`. Produces a structured brief that replaces the vague "extract 15–20 keywords" step with an explicit, human-reviewable document.

## When to use

Run this mode when:
- The user pastes a JD or URL for a new application
- They say "generate brief", "make a brief", or "prep the brief for [company]"

Always run before generating a CV. The user reviews and optionally edits the brief before CV generation proceeds — this is a deliberate human-in-the-loop checkpoint.

## Inputs to read

1. The JD (from context, pasted text, or URL — use Playwright if URL)
2. `cv.md` — candidate experience and bullets
3. `config/profile.yml` — candidate profile
4. `data/corpus/narrative/swot.md` — strengths/weaknesses/caveats (read if present)
5. `data/corpus/narrative/interview-stories.md` — proof points (read if present)
6. `references/scoring-rubric.md` — scoring context

## Tier extraction rules

Read the JD carefully and classify every skill/requirement into three tiers:

| Tier | Where it appears in the JD | Field |
|------|---------------------------|-------|
| **Tier 1 — Required** | "required", "must have", "mandatory", "minimum qualifications", "you will need", "we require" | `tier1_required` |
| **Tier 2 — Preferred** | "preferred", "nice to have", "bonus", "ideally", "plus", "desired", "advantageous" | `tier2_preferred` |
| **Tier 3 — Culture/Context** | "about us", "how we work", "our values", "what we believe", "you are someone who" | `tier3_context` |

If the JD doesn't use these exact headings, infer tier from context: explicit gatekeeping language → Tier 1; hedging language → Tier 2; values/culture language → Tier 3.

Keep each keyword phrase as the JD phrases it (2–5 words). Do not paraphrase — ATS systems match exact JD vocabulary.

## Requirements–Evidence map

For each Tier-1 requirement, produce one entry in `requirements_evidence_map`:

- `jd_requirement`: the exact JD phrase
- `cv_evidence`: which role/bullet in `cv.md` covers it (be specific: "Raynet — 7-figure ARR from zero")
- `placements`: where in the CV it should appear — one or more of: `summary`, `raynet_role`, `adesso_role`, `smartiks_role`, `software_ag_role`, `earlier_career_role`, `key_achievements`, `competencies`
- `honest_caveat`: if the match is partial or the candidate's experience differs from the JD's ask, note it here honestly. Otherwise `null`.

## Bullet selection for bullets_to_include

For each role in the corpus, select up to 3 bullets using whole-JD embedding similarity:

```bash
node -e "
import('./lib/corpus.mjs').then(async ({ getAllBullets }) => {
  const { embed, cosine } = await import('./lib/embeddings.mjs');
  const jd = require('fs').readFileSync(process.env.JD_PATH, 'utf8');
  const jdVec = await embed(jd);
  const bullets = await getAllBullets();

  // Group by role id
  const byRole = {};
  for (const b of bullets) {
    if (!byRole[b.role]) byRole[b.role] = [];
    byRole[b.role].push(b);
  }

  const result = {};
  for (const [roleId, roleBullets] of Object.entries(byRole)) {
    const scored = await Promise.all(roleBullets.map(async b => ({
      ...b,
      score: cosine(jdVec, await embed(b.bullet_text))
    })));
    scored.sort((a, b) => b.score - a.score);
    result[roleId] = scored.slice(0, 3).map(b => b.bullet_id);
  }
  console.log(JSON.stringify(result, null, 2));
}).catch(e => { console.error(e); process.exit(1); });
" 2>/dev/null
```

Selection rules:
- Embed the full JD text once (not per-requirement); compute cosine similarity per bullet
- Pick top 3 per role (or all bullets if role has ≤ 3)
- Career break / transition roles (≤ 2 bullets): include all — the cap is "max 3", not "exactly 3"
- Store role corpus IDs as keys (e.g. `"roles_2020_2024_raynet"`) — not display names

## Output

Create the company folder first: `mkdir -p output/{company-slug}`

Write brief to `output/{company-slug}/brief.json` (no date in name — one brief per company folder, overwrite when regenerating).

Also save the JD text to `jds/{company-slug}-{role-slug}.md` so `generate-pdf.mjs` can use it for similarity scoring.

```json
{
  "company": "Anthropic",
  "role": "Enterprise Account Executive – Munich",
  "jd_source": "https://...",
  "generated_at": "2026-05-14",
  "tier1_required": ["MEDDPICC", "DACH", "enterprise SaaS", "new logo acquisition"],
  "tier2_preferred": ["German C1", "AI fluency", "consumption-based pricing"],
  "tier3_context": ["founder mentality", "quota-carrying", "cross-functional"],
  "photo_policy": "exclude",
  "requirements_evidence_map": [
    {
      "jd_requirement": "7+ years enterprise SaaS sales",
      "cv_evidence": "20+ years, Raynet/adesso/Smartiks — all enterprise SaaS",
      "placements": ["summary", "raynet_role"],
      "honest_caveat": null
    },
    {
      "jd_requirement": "DACH market experience",
      "cv_evidence": "Raynet Paderborn HQ relationship, DACH cross-border deals",
      "placements": ["summary"],
      "honest_caveat": "Operated from Istanbul serving DACH HQ; direct DACH residency begins 2019"
    }
  ],
  "bullets_to_include": {
    "roles_2025_2026_inha": [
      "inha_delivered_four_production_ai_applications",
      "inha_stack_python__c_net"
    ],
    "roles_2020_2024_raynet": [
      "raynet_founded_and_scaled_raynet_turkiye",
      "raynet_secured_6_tier_1_enterprise_clients",
      "raynet_built_partner_ecosystem_oem_alliance"
    ],
    "roles_2016_2019_adesso": [
      "adesso_won_akbank_turkiye_s_4th_largest",
      "adesso_grew_booked_revenue_to_258",
      "adesso_repositioned_adesso_turkey_from_body_leasing_it"
    ],
    "roles_2011_2016_smartiks": [
      "smartiks_led_beqom_azure_saas_compensation",
      "smartiks_generated_680k_annual_recurring_revenue",
      "smartiks_exceeded_quota_for_5_consecutive"
    ],
    "roles_2009_2011_software_ag": [
      "software_transformed_near_zero_revenue_territory_into"
    ],
    "roles_2024_2025_sabbatical": [
      "sabbatical_2024_ai_pm_training_german_c1"
    ],
    "roles_2019_2020_germany_relocation": [
      "relocation_2019_goethe_b1_b2"
    ]
  }
}
```

### photo_policy decision logic

Set `photo_policy` during brief generation based on JD signals:

| Signal | Policy |
|--------|--------|
| SaaS, AI, fintech, cloud, dev tools, VC-backed, company age < 15 years | `exclude` |
| Banking, insurance, automotive, manufacturing, pharma, energy, public sector AND (>10,000 employees OR >50 years old) AND DACH-traditional context | `include` |
| Uncertain | `exclude` |

When in doubt: `exclude`. Modern preference is the safer default for Fatih's target market.

Naming: `{company-slug}` = lowercase company name, hyphens for spaces (e.g. `anthropic-munich`, `salesforce-dach`). `{date}` = `YYYY-MM-DD`.

## Human checkpoint

After writing the brief, present it to the user:

> "Brief written to `output/{company-slug}/brief.json`. Here's the summary:
>
> **Tier 1 (Required):** [list]
> **Tier 2 (Preferred):** [list]
> **Gaps / caveats:** [any honest_caveat entries]
>
> You can edit the brief file directly before I generate the CV. Ready to proceed, or do you want to adjust anything?"

**Do NOT start CV generation until the user confirms.**

## Quick audit (optional)

If a previous CV exists for this company, run coverage audit to compare:
```bash
node scripts/audit-coverage.mjs --brief output/{company-slug}/brief.json --cv output/{company-slug}/cv.pdf
```
Report coverage percentages before generating a new CV.
