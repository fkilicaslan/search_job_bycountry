# Modo: pdf — Generación de PDF ATS-Optimizado

## Style preferences

This mode reads `config/profile.yml` `cv_style` section AND `data/corpus/identity/cv-style.md` and enforces:

- **Bullet count:** max 3 per role; use only bullet_ids listed in brief.json `bullets_to_include` for that role
- **Date format:** EN only — `Mar 2020 – Nov 2024` (en-dash, spaces, English month abbreviations)
- **Page layout:** page 1 = profile (summary, competencies, languages, skills grid); page 2+ = experience; hard limit 3 pages
- **Photo:** include only if brief.json `photo_policy` is `"include"`; default `exclude`
- **Hobbies & references:** never include
- **Anonymization:** all Türk client mentions use `data/corpus/identity/market-descriptors.yml`; `Türkiye/Turkey/Turkish` tokens absent from experience section bullet text (location metadata in job headers is permitted)

## Source dependencies

This mode reads from:
- `data/corpus/roles/*.md` — role content and bullets (via `bullets_to_include` in brief)
- `data/corpus/identity/contact.md`, `languages.md`, `mobility.md`, `compensation.md`
- `data/corpus/identity/cv-style.md` — style rules
- `data/corpus/identity/market-descriptors.yml` — client anonymization
- `data/corpus/identity/photo.jpg` — photo (only when `photo_policy: include`)
- `data/corpus/achievements/*` — proof points for Key Achievements section
- `data/corpus/skills/*` — competencies grid
- `data/corpus/narrative/swot.md` — gap awareness and summary tone
- `data/corpus/narrative/leadership-philosophy.md` — summary framing
- `config/profile.yml` `cv_style` section — authoritative style settings
- `output/{company-slug}/brief.json` — tier keywords, evidence map, bullet selection, photo policy

This mode does **NOT** read `cv.md` directly. `cv.md` is a derived view, not a source.

## Pipeline completo

1. Lee `cv.md` como fuentes de verdad
2. Pide al usuario el JD si no está en contexto (texto o URL)
2b. **Load brief (required):** Check `output/{company-slug}/brief.json` for a brief matching this company/role.
    - If found: load it. The brief replaces step 3 — use `tier1_required`, `tier2_preferred`, `tier3_context` directly as the keyword tiers. Use `requirements_evidence_map` as the writing checklist. Use `bullets_to_include` to select which bullet_ids to render per role (max 3 per role; order = similarity rank from brief generation). Use `photo_policy` to determine photo variant (see Photo section below).
    - If NOT found: run `modes/tailor-brief.md` first, wait for user confirmation, then continue here.
    - Pass the brief path as `--brief=<path>` when calling `generate-pdf.mjs` so the coverage audit runs automatically.
3. **Keywords from brief** (if brief loaded):
   - **Tier-1**: inject into Summary (top 5 terms), first bullet of each role, and Competencies — highest priority.
   - **Tier-2**: inject where natural, at least once each in Summary or Competencies.
   - **Tier-3** (culture/values): **≥50% of Tier-3 keywords must appear organically in the Summary OR the lead bullet of the most relevant role.** Do not invent facts — rephrase existing experience to use that vocabulary. Examples:
     - "Founded Raynet Türkiye from zero" → "With a founder's mindset, built Raynet Türkiye from the ground up"
     - "worked across adesso engineering and sales" → "collaborated cross-functionally across adesso Turkey's engineering, consulting, and sales teams"
     - "focus on enterprise SaaS" → "passionate about enterprise SaaS and how it transforms business operations"
     - If a Tier-3 keyword has no plausible evidence anchor at all, note it in the brief as unanchored and skip it — never invent.
4. Detecta idioma del JD → idioma del CV (EN default)
5. Detecta ubicación empresa → formato papel:
   - US/Canada → `letter`
   - Resto del mundo → `a4`
6. Detecta arquetipo del rol → adapta framing
7. Reescribe Professional Summary inyectando keywords del JD + exit narrative bridge ("Built and sold a business. Now applying systems thinking to [domain del JD].")
8. Selecciona top 3-4 proyectos más relevantes para la oferta
9. Bullet ordering via vector retrieval:
   a. Ensure the bullet index exists: `node scripts/build-bullet-index.mjs` (idempotent — safe to always run; skips unchanged bullets)
   b. For each main role (Raynet, adesso, Smartiks, Software AG), identify the 1–2 JD Tier-1 requirements most relevant to that role
   c. For each (role, requirement) pair, run:
      `node lib/bullet-retrieval.mjs --requirement="<JD requirement phrase>" --role="<company name>" --k=3`
   d. The output is JSON: `[{ bullet_id, bullet_text, score }, ...]` — these are the top-3 candidate bullets
   e. From those 3 candidates (and aware of the role's full bullet list), pick the strongest bullet to lead with and rewrite it to mirror the JD's vocabulary WITHOUT inventing facts
   f. Note the chosen `bullet_id` — it will be stored in the brief under `bullets_to_lead_with` (see tailor-brief mode)
   **IMPORTANT:** Pass the full JD requirement sentence as `--requirement`, not a single abstracted keyword. The retrieval is vocabulary-based — richer phrases produce better candidates.
   **If `bullets_to_include` is present in the brief:** use those bullet_ids as the full bullet list for each role — skip retrieval entirely. The list is already ranked by JD similarity (first = strongest fit). Render them in order, max 3 per role.
10. Construye competency grid desde requisitos del JD (6-8 keyword phrases)
11. Inyecta keywords naturalmente en logros existentes (NUNCA inventa)
12. Genera HTML completo desde template + contenido personalizado
13. Determine output folder: `output/{company-slug}/` where `{company-slug}` = company name lowercase with hyphens (e.g. "Mistral AI" → `mistral`, "Pigment" → `pigment`, "Salesforce DACH" → `salesforce`). Create the folder if it doesn't exist: `mkdir -p output/{company-slug}`.
14. Escribe HTML a `output/{company-slug}/cv.html`
15. Ejecuta: `node generate-pdf.mjs output/{company-slug}/cv.html output/{company-slug}/cv.pdf --format={letter|a4} --jd=jds/{company-slug}-{role-slug}.md --brief=output/{company-slug}/brief.json`
    - The brief.json is written to `output/{company-slug}/brief.json` by `tailor-brief` mode (step 2b above)
    - The JD is saved to `jds/{company-slug}-{role-slug}.md` at brief-generation time
    - meta.json is auto-written to `output/{company-slug}/meta.json` by generate-pdf.mjs
16. Cover letter: write to `output/{company-slug}/cover.html` and `output/{company-slug}/cover.pdf`
17. Reporta: rutas de los archivos generados en `output/{company-slug}/`

## Reglas ATS (parseo limpio)

- Layout single-column (sin sidebars, sin columnas paralelas)
- Headers estándar: "Professional Summary", "Work Experience", "Education", "Skills", "Certifications", "Projects"
- Sin texto en imágenes/SVGs
- Sin info crítica en headers/footers del PDF (ATS los ignora)
- UTF-8, texto seleccionable (no rasterizado)
- **NUNCA uses HTML entities para caracteres UTF-8.** Escribe los caracteres directamente: `Türkiye` no `T&uuml;rkiye`, `ü` no `&uuml;`, `ı` no `&#305;`, `Ş` no `&#350;`, `€` no `&euro;`, `·` no `&middot;`, `–` no `&ndash;`, `—` no `&mdash;`. El archivo es UTF-8 con `<meta charset="UTF-8">` — no hay necesidad de escapes.
- Sin tablas anidadas
- Keywords del JD distribuidas: Summary (top 5), primer bullet de cada rol, Skills section

## Diseño del PDF

- **Fonts**: Space Grotesk (headings, 700) + DM Sans (body, 400-600)
- **Fonts self-hosted**: `fonts/`
- **Header**: centered; name in Space Grotesk 22px bold uppercase + border-bottom 2px solid #111; subtitle line (role/title); contact row (centered); languages line; mobility line
- **Section headers**: Space Grotesk 11px bold, uppercase, letter-spacing 0.06em, **color #111 (black)**, border-bottom 1.5px solid #333 — NO accent colors
- **Body**: DM Sans 11px, line-height 1.5, color #111/#222
- **NO color accents**: do NOT use `hsl(270,70%,45%)` (purple) or `hsl(187,74%,32%)` (teal) anywhere — all text black/dark gray
- **CRÍTICO**: Never use inline `color:hsl(...)` or `color:#...` for any colored accent. Use CSS classes from the template (`job-title`, `job-employer`, `edu-org`, `cert-org`, `skill-category`, etc.) and let the stylesheet control appearance
- **Márgenes**: 0.6in
- **Background**: blanco puro

## Orden de secciones (optimizado "6-second recruiter scan")

**Page 1 — profile only:**
1. Header (name centered uppercase, subtitle, contact, languages, mobility)
2. Professional Summary (3-4 líneas, keyword-dense)
3. Key Achievements (3 bullets, optional — include when strong proof points exist)
4. Core Competencies (8-12 keyword phrases as inline semicolon-separated list)
5. Skills grid (platforms, languages, tools)

**Page 2+ — experience:**
6. Work Experience (cronológico inverso) — MUST start on page 2 (forced page break; see below)
7. Projects (optional — only if genuinely relevant to the JD; otherwise omit)
8. Education & Certifications

**Page break rule:** The `{{EXPERIENCE}}` placeholder block MUST be wrapped in a `<div>` with `style="page-break-before: always;"`. This forces Professional Experience to always start at the top of page 2, regardless of how much space remains on page 1.

**Photo rule:** Read `photo_policy` from `brief.json`.
- `"include"` → place a `<img src="data/corpus/identity/photo.jpg">` in the top-right corner of the page 1 header, 100×125px. If the file is absent, log an error and skip (do not fail generation).
- `"exclude"` or `"default"` → no photo element in the HTML at all.
- When `"include"`, generate two output files: canonical name (with photo) AND `{basename}-no-photo.pdf` (without). When `"exclude"`, generate only the canonical name.

## Estrategia de keyword injection (ético, basado en verdad)

Ejemplos de reformulación legítima:
- JD dice "RAG pipelines" y CV dice "LLM workflows with retrieval" → cambiar a "RAG pipeline design and LLM orchestration workflows"
- JD dice "MLOps" y CV dice "observability, evals, error handling" → cambiar a "MLOps and observability: evals, error handling, cost monitoring"
- JD dice "stakeholder management" y CV dice "collaborated with team" → cambiar a "stakeholder management across engineering, operations, and business"

**NUNCA añadir skills que el candidato no tiene. Solo reformular experiencia real con el vocabulario exacto del JD.**

## Template HTML

Usar el template en `cv-template.html`. Reemplazar los placeholders `{{...}}` con contenido personalizado:

| Placeholder | Contenido |
|-------------|-----------|
| `{{LANG}}` | `en` o `es` |
| `{{PAGE_WIDTH}}` | `8.5in` (letter) o `210mm` (A4) |
| `{{NAME}}` | Full name from profile.yml |
| `{{TITLE}}` | Professional title/subtitle line (e.g. "Senior Sales & Business Development Leader \| Enterprise B2B SaaS and Services") — from profile.yml `narrative.headline` or tailored to JD |
| `{{LOCATION}}` | from profile.yml |
| `{{PHONE}}` | from profile.yml — when non-empty, replace as literal phone number (the surrounding `<span>` and `<span class="separator">` are already in the template; if phone is empty, remove both the `<span>{{PHONE}}</span>` and the adjacent `<span class="separator">\|</span>`) |
| `{{EMAIL}}` | from profile.yml |
| `{{LINKEDIN_URL}}` | from profile.yml |
| `{{LINKEDIN_DISPLAY}}` | from profile.yml |
| `{{PORTFOLIO}}` | If profile.yml `portfolio_url` is non-empty: `<span class="separator">\|</span><a href="URL">DISPLAY</a>`; otherwise empty string |
| `{{LANGUAGES}}` | "Languages: German (C1) · English (C1+) · Turkish (Native)" — from profile.yml `skills.languages`; omit div if empty |
| `{{MOBILITY}}` | "Mobility: Berlin-based; open to relocation and travel" — from profile.yml or leave empty string to hide |
| `{{SECTION_SUMMARY}}` | "Professional Summary" / "Resumen Profesional" |
| `{{SUMMARY_TEXT}}` | Summary personalizado con keywords del JD |
| `{{KEY_ACHIEVEMENTS_SECTION}}` | Full `<div class="section avoid-break"><div class="section-title">Key Achievements</div><ul class="achievements-list"><li>…</li>…</ul></div>` with 3 strongest proof-point bullets — OR empty string to omit section |
| `{{SECTION_COMPETENCIES}}` | "Core Competencies" / "Kernkompetenzen" |
| `{{COMPETENCIES}}` | `<span class="competency-tag">keyword</span>` × 8-12 — CSS renders them inline with "; " separators automatically |
| `{{SECTION_EXPERIENCE}}` | "Professional Experience" / "Berufserfahrung" |
| `{{EXPERIENCE}}` | HTML blocks per job (see structure below) |
| `{{PROJECTS_SECTION}}` | Full `<div class="section">…</div>` with top 3-4 relevant projects — OR empty string to omit |
| `{{SECTION_EDUCATION}}` | "Education" / "Ausbildung" |
| `{{EDUCATION}}` | HTML de educación (use CSS classes `edu-title`, `edu-org`, `edu-year`, `edu-desc` — no inline color styles) |
| `{{SECTION_CERTIFICATIONS}}` | "Certifications & Professional Development" |
| `{{CERTIFICATIONS}}` | HTML de certificaciones (use CSS classes `cert-group-title`, `cert-item`, `cert-title`, `cert-org`, `cert-year` — no inline color styles) |
| `{{SECTION_SKILLS}}` | "Skills" |
| `{{SKILLS}}` | HTML de skills (use `<div class="skills-row"><span class="skill-category">Category:</span> item · item · item</div>` — no inline color styles) |

## Job HTML Structure

Each work experience entry MUST use this 3-line header format — role title · location on line 1, display_name_full on line 2, industry descriptor on line 3:

```html
<div class="job">
  <div class="job-header">
    <span class="job-title">Regional Director · Paderborn, Germany & Istanbul (Power of Attorney)</span>
    <span class="job-period">Mar 2020 – Nov 2024</span>
  </div>
  <div class="job-employer">Raynet GmbH · Paderborn, Germany</div>
  <div class="job-desc">IT Asset Management SaaS | €14M revenue, 150 employees</div>
  <ul>
    <li>bullet one</li>
    <li>bullet two</li>
    <li>bullet three</li>
  </ul>
</div>
```

Rules:
- `.job-title` = `{role_title} · {location}` from corpus frontmatter — use `location` field value directly (first line, left — bold, black). For Raynet: append `(Power of Attorney)` from `location_modifier`.
- `.job-period` = date range from `period_start`/`period_end` frontmatter, formatted as `Mar 2020 – Nov 2024` (EN, en-dash)
- `.job-employer` = `display_name_full` from corpus frontmatter (second line — bold, black)
- `.job-desc` = industry descriptor and size from corpus body italic line (third line — italic, smaller, optional)
- Bullet list: only bullet_ids listed in `bullets_to_include[role_id]` from brief.json; render in the order given; max 3
- Never use inline `color:` on any of these elements
- Career break / transition entries use the same structure: `role_title` from frontmatter, `display_name_full` from frontmatter

**adesso example:**
```html
<div class="job">
  <div class="job-header">
    <span class="job-title">Sales & Marketing Director · Istanbul</span>
    <span class="job-period">Aug 2016 – Jul 2019</span>
  </div>
  <div class="job-employer">adesso Turkey Ltd. (subsidiary of adesso SE, Dortmund)</div>
  <div class="job-desc">IT Consulting & Managed Services | €1.14B group revenue, 10,200 employees</div>
  <ul>...</ul>
</div>
```

## Canva CV Generation (optional)

If `config/profile.yml` has `cv.canva_resume_design_id` set, offer the user a choice before generating:
- **"HTML/PDF (fast, ATS-optimized)"** — existing flow above
- **"Canva CV (visual, design-preserving)"** — new flow below

If the user has no `cv.canva_resume_design_id`, skip this prompt and use the HTML/PDF flow.

### Canva workflow

#### Step 1 — Duplicate the base design

a. `export-design` the base design (using `cv.canva_resume_design_id`) as PDF → get download URL
b. `import-design-from-url` using that download URL → creates a new editable design (the duplicate)
c. Note the new `design_id` for the duplicate

#### Step 2 — Read the design structure

a. `get-design-content` on the new design → returns all text elements (richtexts) with their content
b. Map text elements to CV sections by content matching:
   - Look for the candidate's name → header section
   - Look for "Summary" or "Professional Summary" → summary section
   - Look for company names from cv.md → experience sections
   - Look for degree/school names → education section
   - Look for skill keywords → skills section
c. If mapping fails, show the user what was found and ask for guidance

#### Step 3 — Generate tailored content

Same content generation as the HTML flow (Steps 1-11 above):
- Rewrite Professional Summary with JD keywords + exit narrative
- Reorder experience bullets by JD relevance
- Select top competencies from JD requirements
- Inject keywords naturally (NEVER invent)

**IMPORTANT — Character budget rule:** Each replacement text MUST be approximately the same length as the original text it replaces (within ±15% character count). If tailored content is longer, condense it. The Canva design has fixed-size text boxes — longer text causes overlapping with adjacent elements. Count the characters in each original element from Step 2 and enforce this budget when generating replacements.

#### Step 4 — Apply edits

a. `start-editing-transaction` on the duplicate design
b. `perform-editing-operations` with `find_and_replace_text` for each section:
   - Replace summary text with tailored summary
   - Replace each experience bullet with reordered/rewritten bullets
   - Replace competency/skills text with JD-matched terms
   - Replace project descriptions with top relevant projects
c. **Reflow layout after text replacement:**
   After applying all text replacements, the text boxes auto-resize but neighboring elements stay in place. This causes uneven spacing between work experience sections. Fix this:
   1. Read the updated element positions and dimensions from the `perform-editing-operations` response
   2. For each work experience section (top to bottom), calculate where the bullets text box ends: `end_y = top + height`
   3. The next section's header should start at `end_y + consistent_gap` (use the original gap from the template, typically ~30px)
   4. Use `position_element` to move the next section's date, company name, role title, and bullets elements to maintain even spacing
   5. Repeat for all work experience sections
d. **Verify layout before commit:**
   - `get-design-thumbnail` with the transaction_id and page_index=1
   - Visually inspect the thumbnail for: text overlapping, uneven spacing, text cut off, text too small
   - If issues remain, adjust with `position_element`, `resize_element`, or `format_text`
   - Repeat until layout is clean
d. Show the user the final preview and ask for approval
e. `commit-editing-transaction` to save (ONLY after user approval)

#### Step 5 — Export and download PDF

a. `export-design` the duplicate as PDF (format: a4 or letter based on JD location)
b. **IMMEDIATELY** download the PDF using Bash:
   ```bash
   curl -sL -o "output/cv-{candidate}-{company}-canva-{YYYY-MM-DD}.pdf" "{download_url}"
   ```
   The export URL is a pre-signed S3 link that expires in ~2 hours. Download it right away.
c. Verify the download:
   ```bash
   file output/cv-{candidate}-{company}-canva-{YYYY-MM-DD}.pdf
   ```
   Must show "PDF document". If it shows XML or HTML, the URL expired — re-export and retry.
d. Report: PDF path, file size, Canva design URL (for manual tweaking)

#### Error handling

- If `import-design-from-url` fails → fall back to HTML/PDF pipeline with message
- If text elements can't be mapped → warn user, show what was found, ask for manual mapping
- If `find_and_replace_text` finds no matches → try broader substring matching
- Always provide the Canva design URL so the user can edit manually if auto-edit fails

## Cover Letter Generation

Every CV generation must also produce a matching cover letter unless the user says otherwise.

### Format rule (non-negotiable)
Cover letters use the **business letter format** defined in `templates/cover-letter-reference.html`. Never use the CV header/gradient style for cover letters.

### Pipeline

1. Read `templates/cover-letter-reference.html`
2. Substitute all placeholders:
   - `{{COMPANY}}` — company name
   - `{{COMPANY_TEAM}}` — "Hiring Team" (default) or specific team from JD
   - `{{COMPANY_CITY}}` — city/country from JD
   - `{{ROLE_TITLE}}` — exact role title from JD
   - `{{DATE}}` — current date formatted as "DD Month YYYY" (e.g. "13 May 2026")
   - `{{SALUTATION}}` — "Dear [Company] Hiring Team," (or "Dear [Company] Team,")
   - `{{BODY_PARAGRAPHS}}` — 3–4 `<p>` elements (see structure below)
3. Write HTML to `output/cover-{candidate}-{company}-{YYYY-MM-DD}.html`
4. Execute: `node generate-pdf.mjs output/cover-{candidate}-{company}-{YYYY-MM-DD}.html output/cover-{candidate}-{company}-{YYYY-MM-DD}.pdf`
5. The template already includes the closing "Thank you" paragraph — do NOT add it again in `{{BODY_PARAGRAPHS}}`

### Cover letter body structure (4 paragraphs max, 300 words max)

- **Para 1 (hook):** What makes THIS role at THIS company relevant to this specific candidate — not generic enthusiasm
- **Para 2 (proof point 1):** One specific achievement directly relevant to the JD's primary requirement
- **Para 3 (proof point 2):** One specific achievement relevant to the JD's secondary requirement or differentiator
- **Para 4 (bridge):** One sentence connecting candidate's current position/skills to what the role needs (optional if word count is tight)

### Hard rules for cover letter content

- ≤ 300 words in body (excluding salutation and closing)
- No "MEDDPICC certified" — write "MEDDPICC-trained" or "MEDDPICC and Command of the Message training"
- Never claim use of platforms not in cv.md (Arize AI, LangChain, LangSmith, Vapi, Deepgram API as tool used)
- Do not summarise the CV — add information the CV cannot show (context, motivation, pattern)
- Output path: `output/cover-{candidate}-{company}-{YYYY-MM-DD}.html` and `.pdf`

---

## Canonical Work Experience Order

When writing experience HTML for CVs, always use this order (corpus role_id → display):

| # | Corpus role_id | Display title | Period |
|---|---|---|---|
| 1 | `roles_2025_2026_inha` | Digital Transformation and Business Development Consultant · Berlin | Oct 2025 – Apr 2026 |
| 2 | `roles_2024_2025_sabbatical` | Professional Development Sabbatical · Berlin | Dec 2024 – Dec 2025 |
| 3 | `roles_2020_2024_raynet` | Regional Director · Paderborn, Germany & Istanbul (Power of Attorney) | Mar 2020 – Nov 2024 |
| 4 | `roles_2019_2020_germany_relocation` | Germany Relocation — Language Studies · Berlin | Aug 2019 – Feb 2020 |
| 5 | `roles_2016_2019_adesso` | Sales & Marketing Director · Istanbul | Aug 2016 – Jul 2019 |
| 6 | `roles_2011_2016_smartiks` | Regional Business Development Director · Istanbul | Jul 2011 – Jul 2016 |
| 7 | `roles_2009_2011_software_ag` | Regional Sales Manager · Istanbul | Sep 2009 – Jun 2011 |
| 8 | `roles_2002_2009_earlier_career` | Earlier Career — Product & Technical Roles · Istanbul | 2002 – 2009 |

The Work Experience `<div>` must carry `style="page-break-before: always;"` so it always starts on page 2.

### Earlier Career entry (MANDATORY rule)

The pre-2009 work history is **always** rendered as a single grouped entry — never as individual Broadcast Systems Engineering / Verscom / Airties entries:

```html
<div class="job">
<div class="job-header"><span class="job-title">Earlier Career &mdash; Product &amp; Technical Roles</span><span class="job-period">2002 &ndash; 2009</span></div>
<div class="job-employer">Broadcast Systems Engineering · Verscom · Airties <span class="job-location">· Istanbul</span></div>
<div class="job-desc">Digital TV, Internet TV, Pay TV security; VoIP; Wi-Fi hardware R&amp;D</div>
<ul>
  <li>Generated &euro;700K+ revenue across Internet TV, digital TV, and Pay TV security solutions; managed multi-vendor consortiums (Conax, Ericsson Television, Bridge Technology, Witbe)</li>
  <li>Optional second bullet tailored to JD (e.g. technical bridge between engineering delivery and commercial models)</li>
</ul>
</div>
```

Rules:
- Period is always **2002 – 2009**, never "Jan 2006 – Aug 2009" or "2003 – 2009"
- Title is always **Earlier Career — Product & Technical Roles**, never "Product Manager" alone
- Employer always lists all three companies: Broadcast Systems Engineering · Verscom · Airties

---

## Post-generación

Actualizar tracker si la oferta ya está registrada: cambiar PDF de ❌ a ✅.
