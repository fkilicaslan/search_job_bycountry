# career-ops: CV pipeline overhaul — Implementation Brief

You are Claude Code working in the `career-ops` repo at
`c:\Users\Fatih\Desktop\May2026\Projects\search_job\career-ops`.

This brief is the single source of truth for a 7-part addition to the pipeline.
Read this entire document before writing any code. Implement in the **exact order**
listed under "Sequencing". After each numbered step, run the existing pipeline
end-to-end on at least one real JD to verify nothing regressed, then proceed.

---

## 0. Context you must respect

The pipeline today:

- Reads JDs → evaluates fit → generates tailored CVs (HTML + PDF via Playwright)
  → tracks applications.
- Modes live in `modes/` (e.g. `modes/pdf.md`, `modes/oferta.md`, `modes/de/...`).
- Source of truth: `cv.md`, `config/profile.yml`, `data/corpus/narrative/*.md` (swot,
  interview-stories, leadership-philosophy), `references/scoring-rubric.md`.
- Outputs: `output/cv-{candidate}-{company}-{date}.{html,pdf}`,
  `output/reports/{###}-{company-slug}-{date}.md`.
- Tracker: `data/applications.md`.
- Utility scripts at repo root: `generate-pdf.mjs`, `scan.mjs`,
  `check-liveness.mjs`, `merge-tracker.mjs`, `verify-pipeline.mjs`,
  `dedup-tracker.mjs`, `normalize-statuses.mjs`, `analyze-patterns.mjs`,
  `followup-cadence.mjs`, `update-system.mjs`, `reformat-cvs.mjs`,
  `fix-earlier-career.mjs`, `generate-latex.mjs`.

**Hard rules — do not violate any of these:**

- Do NOT migrate `cv.md` to YAML or any other format. Markdown stays.
- Do NOT replace the Playwright PDF generator. It works.
- Do NOT delete, rename, or restructure any existing mode, script, or output
  naming convention. Add alongside.
- Do NOT add LangChain, LlamaIndex, CrewAI, AutoGen, or any agentic framework.
- Do NOT introduce a heavyweight vector DB (Chroma, Pinecone, Qdrant, Weaviate).
- Do NOT add auto-submit beyond what `apply` mode already does (stop-before-submit).
- Do NOT scrape LinkedIn or Indeed. Only public ATS APIs the project already uses
  (Greenhouse, Ashby, Lever, Workday board endpoints).
- Do NOT fine-tune any model.
- Keep cross-platform compatibility — this repo runs on Windows. Use `path.join`,
  not hardcoded slashes.

---

## 1. Why this work exists

The current CV-tailoring pipeline relies on a single LLM pass with instructions
to "extract 15–20 keywords and inject them in the right places." There is no
objective post-generation validation, no closed feedback loop from outcomes back
to CV features, and no defense against the failure modes that actually kill
applications in 2026: **parsing errors** (~23% of early-stage ATS rejections)
and **semantic mismatch** (modern ATS like Workday Illuminate, Greenhouse,
Lever use NLP semantic matching, not just exact keyword counts — but still
weight exact matches heavily).

We are adding seven capabilities, in two phases.

---

## 2. Dependencies

Add **only** these to `package.json`. Resist the urge to add more.

```bash
npm install @xenova/transformers pdf-parse better-sqlite3
```

If `better-sqlite3` fails native compilation on Windows, fall back to a
JSON-file-based outcome store with the same schema (see §2.1). Do not switch
to an ORM.

---

## PHASE 1 — Foundations

### 1.1 — Semantic similarity scoring

**Goal:** After generating a tailored CV, compute cosine similarity between
the JD text and the CV text. A score below 0.75 flags the CV for review.

**Files:**

- `lib/embeddings.mjs` — new
- `scripts/score-similarity.mjs` — new
- `generate-pdf.mjs` — hook in scoring at end

**Spec:**

`lib/embeddings.mjs` exposes:

```javascript
export async function embed(text)        // → Float32Array, uses Xenova/all-MiniLM-L6-v2
export function cosine(a, b)             // → number in [-1, 1]
```

Lazy-load the model on first call, cache the pipeline globally for the process.

`scripts/score-similarity.mjs`:

- Flags: `--jd <path>` `--cv <path>` (both can be .md, .html, or .pdf)
- For HTML: strip tags before embedding (use a minimal regex, not jsdom).
- For PDF: use `pdf-parse` to extract text.
- For .md: read raw.
- Print one line of JSON to stdout: `{ "similarity": 0.842, "threshold": 0.75, "pass": true }`.

`generate-pdf.mjs` hook:

- After the PDF is written, also write a sidecar file
  `output/cv-{candidate}-{company}-{date}.meta.json` containing
  `{ "similarity": { "score": 0.842, "pass": true } }`.
- The meta.json grows over the next steps — always merge, never overwrite.

**Acceptance:**

- Running the existing CV-gen flow now produces a `.meta.json` next to the PDF.
- Same JD + same CV → same score within 0.001 on reruns.
- Cold-start (first call) model load completes under 10s on a typical laptop;
  subsequent calls in the same process reuse the model with no reload.

---

### 1.2 — Parseability validation

**Goal:** After PDF generation, verify the PDF parses cleanly. A downstream
consumer (i.e., any ATS) must be able to extract structured fields without
garbling.

**Files:**

- `lib/parse-check.mjs` — new
- `generate-pdf.mjs` — hook in after PDF emit

**Spec:**

`lib/parse-check.mjs` exposes:

```javascript
export async function validateParseability(pdfPath)
// → { pass: boolean, issues: string[], sections: { summary: bool, experience: bool, ... } }
```

Checks performed (in this order, all must pass for `pass: true`):

1. `pdf-parse` returns non-empty text (PDF has a selectable text layer).
2. All required section headers are detected (case-insensitive, allow common
   variants and German equivalents):
   - Summary / Professional Summary / Profil / Zusammenfassung
   - Experience / Professional Experience / Berufserfahrung
   - Skills / Core Competencies / Kompetenzen / Fähigkeiten
   - Education / Ausbildung
   - Certifications / Zertifikate (optional — warn but don't fail if absent)
3. At least 3 dated job entries detected. Regex for `YYYY` ranges
   (e.g. `2018 – 2022`, `2018-Present`, `01/2018 – 12/2022`).
4. Email regex matches exactly once. Phone regex matches at least once.
5. No mojibake — flag if the extracted text contains stretches of replacement
   chars (`\uFFFD`) or runs of non-ASCII control bytes that suggest font-encoding
   failures.

Hook into `generate-pdf.mjs` after PDF emit. Write results into the same
`.meta.json` under key `parseability`. If `pass: false`, log a clear CLI warning
listing each issue, but do **not** block the run. Fatih reviews before
submitting.

**Acceptance:**

- Existing healthy CVs pass.
- Deliberately introducing (a) a two-column layout, (b) an icon-font character,
  or (c) renaming "Experience" to "My Journey" each produces a specific
  `issues[]` entry.

---

### 1.3 — Tiered keyword extraction + requirement-evidence map + coverage audit

**Goal:** Replace vague "extract 15–20 keywords" with a structured pre-generation
brief, then audit coverage after generation.

**Files:**

- `modes/tailor-brief.md` — new mode that runs before `modes/pdf.md`
- `modes/pdf.md` — modify to consume the brief
- `scripts/audit-coverage.mjs` — new
- `output/briefs/` — new directory

**Brief schema** — write to `output/briefs/{company-slug}-{date}.brief.json`:

```json
{
  "company": "Anthropic",
  "role": "Enterprise Account Executive – Munich",
  "tier1_required": ["MEDDPICC", "DACH", "enterprise SaaS", "new logo acquisition"],
  "tier2_preferred": ["German C1", "AI fluency", "consumption-based"],
  "tier3_context": ["founder mentality", "quota-carrying", "cross-functional"],
  "requirements_evidence_map": [
    {
      "jd_requirement": "7+ years enterprise SaaS sales",
      "cv_evidence": "15+ years, Raynet/adesso/Smartiks",
      "placements": ["summary", "raynet_role_first_bullet"],
      "honest_caveat": null
    },
    {
      "jd_requirement": "DACH market experience",
      "cv_evidence": "Raynet Paderborn HQ relationship, cross-border deals",
      "placements": ["summary"],
      "honest_caveat": "Operated from Türkiye serving DACH HQ; not resident in DACH"
    }
  ],
  "bullets_to_lead_with": {
    "raynet": "founded_raynet_turkiye_from_zero",
    "adesso": "akbank_competitive_displacement",
    "beqom": "tier1_telco_new_logo"
  }
}
```

Tier definitions:

- **Tier 1** = keywords appearing in "required", "must have", "mandatory",
  "minimum qualifications" sections of the JD.
- **Tier 2** = "preferred", "nice to have", "bonus", "ideally".
- **Tier 3** = culture/values language from "about us" / "how we work" /
  "our values" sections.

The `modes/tailor-brief.md` mode prompts Claude to produce this brief from the
JD + candidate context files. The user reviews the brief before CV generation
proceeds — this is a deliberate human-in-the-loop checkpoint.

`modes/pdf.md` is modified to:

- Take the brief.json as an explicit input (was implicit "extract keywords").
- Use `requirements_evidence_map` as the writing checklist — every requirement
  must be addressed somewhere in the CV.
- Use `bullets_to_lead_with` to force ordering — the named bullet appears first
  for that role, period.

`scripts/audit-coverage.mjs`:

- Flags: `--brief <path>` `--cv <path>`
- Output to stdout as JSON:
  ```json
  {
    "tier1": { "present": ["MEDDPICC", "DACH"], "missing": ["enterprise SaaS"], "coverage": 0.75 },
    "tier2": { ... },
    "tier3": { ... },
    "requirements_addressed": [{ "requirement": "...", "found_in": ["summary", "raynet_role"] }],
    "requirements_unaddressed": []
  }
  ```
- Tier-1 missing keywords trigger a loud CLI warning but do **not** block —
  Fatih decides whether to regenerate.
- Coverage matching is case-insensitive and tolerates plural/singular and
  hyphen variants (`new-logo` matches `new logo`). Don't get clever with
  stemming — keep it simple.

Hook the audit into `generate-pdf.mjs` so the meta.json gains a `coverage` key.

**Acceptance:**

- Every CV generation produces both a brief.json and a coverage report in
  meta.json.
- Tier-1 missing surfaces with the specific term, not a generic warning.
- brief.json is human-readable and Fatih can edit it manually then regenerate
  to force a different ordering.

---

### 1.4 — Two-stage bullet selection via vector retrieval

**Goal:** Stop relying on LLM intuition for "which bullet goes first." Use
semantic retrieval to rank every available bullet against each JD requirement,
then let the LLM pick + rewrite the strongest one to mirror JD vocabulary.

**Files:**

- `scripts/build-bullet-index.mjs` — new
- `lib/bullet-retrieval.mjs` — new
- `data/bullet-index.json` — new artifact, gitignored if it gets large
- `modes/pdf.md` — modify the bullet-ordering step

**Spec:**

`scripts/build-bullet-index.mjs`:

- Parses `cv.md` and extracts every bullet under every role.
- For each bullet, captures: `{ role, company, bullet_text, bullet_id }`.
  `bullet_id` is a stable slug (e.g. `adesso_akbank_competitive_displacement`).
- Embeds each bullet using `lib/embeddings.mjs`.
- Writes `data/bullet-index.json` as
  `[{ role, company, bullet_id, bullet_text, embedding: [floats...] }, ...]`.
- Idempotent. Skips bullets whose text hash hasn't changed.

`lib/bullet-retrieval.mjs`:

```javascript
export async function topK(requirement, role, k = 5)
// → [{ bullet_id, bullet_text, score: 0.0–1.0 }, ...] sorted desc by score
```

`modes/pdf.md` modification — in the bullet-ordering step:

For each role in the CV, for each Tier-1 requirement most relevant to that role,
call `topK(requirement, role, 3)`. Surface the top-3 to the LLM along with
the role's full bullet list and the JD requirement, then prompt:

> Pick the strongest bullet to lead with for this role, and rewrite it to
> mirror the JD's vocabulary without inventing facts.

Persist the chosen `bullet_id` per role in the brief.json under
`bullets_to_lead_with` so the choice is explicit and auditable.

**Acceptance:**

- For a JD requiring "competitive displacement experience", the Akbank bullet
  at adesso lands in the top-3 returned for that role reliably.
- Index rebuilds in under 30s for the current cv.md size.
- The chosen bullet_id appears in the generated brief.json.

---

## End of Phase 1 — STOP HERE

Ship Phase 1. Use it on at least 10 real applications over 1–2 weeks. Confirm:

- meta.json is populated for every generation.
- briefs are useful in practice (Fatih can read and edit them).
- Similarity, parseability, and coverage warnings are catching real issues.
- Bullet retrieval is surfacing the right stories.

Only after that, proceed to Phase 2.

---

## PHASE 2 — Intelligence layer

### 2.1 — Outcome feedback loop

**Goal:** Connect generated-CV features to application outcomes so the system
gets measurably better over time. This is the moat — no commercial tool does
this for an individual.

**Files:**

- `data/career-ops.db` — new SQLite database
- `scripts/db-sync.mjs` — new
- `scripts/analyze-outcomes.mjs` — new
- `lib/db.mjs` — new (thin wrapper around better-sqlite3)

**Schema:**

```sql
CREATE TABLE applications (
  id INTEGER PRIMARY KEY,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  jd_url TEXT,
  applied_at TEXT,                  -- ISO 8601
  status TEXT,                      -- Applied | Rejected | Phone Screen | Interview | Offer | Withdrawn
  status_updated_at TEXT,
  cv_path TEXT,
  cover_path TEXT,
  brief_path TEXT,
  meta_path TEXT
);

CREATE TABLE cv_features (
  application_id INTEGER PRIMARY KEY REFERENCES applications(id),
  similarity_score REAL,
  tier1_coverage REAL,
  tier2_coverage REAL,
  tier3_coverage REAL,
  parseability_pass INTEGER,        -- 0 or 1
  bullet_lead_raynet TEXT,
  bullet_lead_adesso TEXT,
  bullet_lead_beqom TEXT,
  bullet_lead_smartiks TEXT,
  summary_template_hash TEXT,
  ats_target TEXT,                  -- workday | greenhouse | lever | ashby | unknown
  generated_at TEXT
);

CREATE TABLE outcomes (
  id INTEGER PRIMARY KEY,
  application_id INTEGER REFERENCES applications(id),
  outcome_event TEXT,               -- callback | rejection | no_response_30d | no_response_60d | interview_scheduled | offer
  outcome_at TEXT
);

CREATE INDEX idx_applications_status ON applications(status);
CREATE INDEX idx_applications_applied_at ON applications(applied_at);
CREATE INDEX idx_outcomes_application ON outcomes(application_id);
```

`scripts/db-sync.mjs`:

- Reads `data/applications.md` and reconciles every row into the `applications`
  table. Use `jd_url` as the natural key for upserts.
- For each application, locates the matching `meta.json` sidecar in `output/`
  and populates `cv_features`.
- Auto-creates `no_response_30d` outcomes for applications still in "Applied"
  status 30+ days after `applied_at`. Same for `no_response_60d`.
- Idempotent. Safe to run on a cron / pre-commit / manually.

`scripts/analyze-outcomes.mjs`:

- Groups applications by feature buckets and reports callback rate per bucket.
- Buckets to report:
  - Similarity: `<0.70`, `0.70–0.79`, `0.80–0.89`, `≥0.90`
  - Tier-1 coverage: `<60%`, `60–79%`, `80–99%`, `100%`
  - Parseability: pass vs. fail
  - Bullet lead per role (group by `bullet_lead_<role>`)
  - ATS target (workday/greenhouse/lever/ashby/unknown)
- Minimum sample size: `n ≥ 8`. Below that, report "insufficient data — n=X".
- Output as a markdown table to stdout. Example:
  ```
  | Bucket             | Callback rate | n   |
  | ------------------ | ------------- | --- |
  | Similarity ≥0.90   | 31%           | 16  |
  | Similarity 0.80–89 | 18%           | 33  |
  | Similarity 0.70–79 | 11%           | 27  |
  | Similarity <0.70   | insufficient  | 4   |
  ```

**Acceptance:**

- DB syncs from existing `applications.md` with no manual data entry.
- Analysis script runs and produces a clean report.
- After a new application via the normal pipeline, running `db-sync.mjs`
  auto-populates the new row's `cv_features` from the meta.json.

---

### 2.2 — Hallucination guard

**Goal:** Verify every quantitative claim, named entity, and specific metric
in the generated CV traces back to source-of-truth files (`cv.md`,
`config/profile.yml`, `data/corpus/narrative/*.md`).

**Files:**

- `scripts/verify-claims.mjs` — new
- `generate-pdf.mjs` — hook in after generation

**Spec:**

`scripts/verify-claims.mjs`:

- Parses generated CV HTML.
- Extracts these claim types:
  - **Numbers**: percentages (`23%`), currency (`€1.2M`, `$50K`), counts
    (`15+ years`, `Six Tier-1 clients`), multipliers (`3x`).
  - **Named entities**: company names that are NOT the target employer,
    named tools/platforms, named programs/certifications, named individuals.
  - **Dates**: years and year ranges.
- For each extracted claim, searches the source-of-truth corpus
  (`cv.md` + `config/profile.yml` + `data/corpus/narrative/*.md` concatenated).
- Match rules:
  - Numbers: exact match OR fuzzy ("15+" matches "over 15", "fifteen", "15");
    percentages must match within ±1 point.
  - Company/tool names: case-insensitive exact match.
  - Dates: exact year match.
- Output JSON to meta.json under `verification`:
  ```json
  {
    "verified": ["Akbank", "MEDDPICC", "15+ years", "€1.2M"],
    "unverified": [
      { "claim": "47% YoY growth at Acme", "location": "summary", "claim_type": "percentage" }
    ],
    "confidence": "high"
  }
  ```
- `confidence`: `high` if 0 unverified, `medium` if 1–2, `low` if 3+.
- Emit CLI warning if any unverified.

**Acceptance:**

- A clean CV with all metrics drawn from cv.md returns zero unverified.
- Deliberately injecting "Achieved 47% YoY growth at Acme Corp" (not in any
  source) is caught.
- False positive rate stays low. If `cv.md` says "over 15 years" and the
  generated CV says "15+ years", that is verified, not flagged.

---

### 2.3 — DACH conventions audit for `modes/de/`

**Goal:** Ensure German-language output respects Lebenslauf conventions and
isn't a translated US-style resume.

**Files:**

- `modes/de/conventions-check.md` — new
- `scripts/audit-coverage.mjs` — extend with `--locale=de` flag

**Conventions to enforce:**

- Reverse-chronological order of experience and education.
- German section headers: `Berufserfahrung`, `Ausbildung`, `Persönliche Daten`,
  `Sprachen`, `Zertifikate`, `Kompetenzen`. Not "Work Experience" etc.
- Two-page maximum is a hard constraint. If output exceeds two pages,
  fail the check.
- Personal info block: full name, contact, optionally city. NOT full street
  address by default. Photo, if used, as a separate file — not embedded
  in the PDF (ATS-incompatible).
- Date format `MM/YYYY` or `DD.MM.YYYY`. Not "Month YYYY" US-style.
- Languages section uses CEFR levels (`Türkisch (Muttersprache)`,
  `Deutsch (C1)`, `Englisch (C2)`).

`modes/de/conventions-check.md` is a checklist Claude reads when generating
in DE mode. The audit script implements automatic checks where feasible
(headers, date format, page count) and lists manual review items for the rest.

**Acceptance:**

- Generating in German mode produces a doc that passes the conventions check.
- Existing German-mode CVs are audited; failures are listed but not
  auto-fixed (Fatih reviews).

---

### 2.4 — Submission-timing prioritization

**Goal:** Surface freshness in the scan pipeline. Applications submitted within
24h of posting get materially more recruiter attention.

**Files:**

- `scan.mjs` — extend
- `data/pipeline.md` — format change (additive columns)
- `modes/pipeline.md` — sort order change

**Spec:**

- Extend `scan.mjs` to extract `posted_at` (or `updated_at` / `created_at`
  depending on API) from Greenhouse, Ashby, and Lever responses. All three
  expose this in their JSON.
- Compute `age_bucket` at scan time:
  - `🔥 <24h`
  - `✓ <72h`
  - `↓ <14d`
  - `🪨 ≥14d`
- Add `posted_at` and `age_bucket` columns to `data/pipeline.md` (additive —
  preserve existing columns).
- Update `pipeline process` mode to drain by age bucket: 🔥 first, then ✓,
  then ↓. Skip 🪨 unless explicitly requested with a `--include-stale` flag.

**Acceptance:**

- Postings scanned today show 🔥.
- Re-running `pipeline process` on a mixed-age queue handles 🔥 entries first.
- `--include-stale` flag works.

---

## 3. Sequencing — strict order, no parallelization

1. `lib/embeddings.mjs` (foundation for §1.1 and §1.4)
2. Similarity scoring hook into `generate-pdf.mjs` (§1.1)
3. Parseability validation (§1.2) — independent, fast win
4. Bullet index + retrieval (§1.4)
5. Tiered keyword brief + coverage audit (§1.3)
6. **STOP. Ship Phase 1. Use for 1–2 weeks before continuing.**
7. SQLite DB + sync from applications.md (§2.1)
8. Hallucination guard (§2.2)
9. DACH audit (§2.3)
10. Submission timing (§2.4)

After each step, run the existing pipeline end-to-end on one real JD.
If anything regresses, stop and fix before continuing.

---

## 4. Definition of done

- All seven additions implemented and individually testable from the CLI.
- Existing modes (`oferta`, `quick-eval`, `pipeline`, `scan`, `apply`,
  all language modes) work identically — no observable behavior change in
  the baseline flow.
- `npm install` succeeds on a clean clone with no manual native-build steps
  (or with documented fallback to JSON store if better-sqlite3 fails).
- One real-world end-to-end test: fresh JD → full pipeline run → generated
  CV ships with a complete `.meta.json` containing keys `similarity`,
  `parseability`, `coverage`, and (after Phase 2) `verification`.
- README updated with a "What's new" section listing the new artifacts
  (`.meta.json`, `brief.json`, `bullet-index.json`, `career-ops.db`) and
  where they live.

---

## 5. Style guide for this work

- Small, debuggable scripts. No 500-line files.
- Each script does one thing and prints structured JSON to stdout.
- Hook scripts emit human-readable CLI warnings in addition to writing JSON.
- All new code in ES modules (`.mjs`), matching the repo's existing style.
- No global state except the embedding model cache.
- No silent failures. If a check fails, log it clearly with the input that
  caused it.

Start with §1 step 1. Confirm `lib/embeddings.mjs` works in isolation with a
two-line test (`embed("hello world")` returns a Float32Array of length 384)
before moving on.
