# search_job

AI-powered job search pipeline built on [career-ops](https://github.com/santifer/career-ops) and Claude Code.
Evaluates job offers, generates tailored CVs, and scans LinkedIn, Indeed, and Stepstone automatically.

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| [Node.js](https://nodejs.org) | 18+ | Required by all scripts |
| [Claude Code](https://claude.ai/code) | Latest | The AI coding CLI |
| Anthropic API key | — | From [console.anthropic.com](https://console.anthropic.com) |
| Bright Data API key | — | Optional — needed for LinkedIn + Indeed scanning |

---

## Step-by-Step Setup

### 1. Clone the repository

```bash
git clone https://github.com/fkilicaslan/search_job_bycountry.git
cd search_job_bycountry
```

### 2. Install dependencies

```bash
cd career-ops
npm install
```

### 3. Install Playwright's browser (needed for PDF generation and Stepstone)

```bash
npx playwright install chromium
```

### 4. Configure your API keys

```bash
cp .env.example .env
```

Open `.env` and fill in your values:

```
ANTHROPIC_API_KEY=sk-ant-...        # Required
BRIGHTDATA_API_KEY=...              # Optional — for LinkedIn + Indeed
BRIGHTDATA_LINKEDIN_DATASET_ID=...  # Optional
BRIGHTDATA_INDEED_DATASET_ID=...    # Optional
```

### 5. Run the setup wizard

The wizard reads your CV, calls Claude to extract your profile, asks a few questions,
and writes `config/profile.yml`, `cv.md`, and `portals.yml` in one pass.

```bash
# With your CV file (recommended):
node setup.mjs --cv path/to/your_cv.pdf --country Germany

# Without a CV file (manual prompts):
node setup.mjs
```

When it completes, review and edit `config/profile.yml` if anything needs adjusting.

### 6. Verify everything is working

```bash
npm run doctor
```

This prints a checklist of prerequisites, missing files, and misconfigurations.

---

## Running the Pipeline

### Scan for new job postings

```bash
# All enabled boards (LinkedIn, Indeed, Stepstone):
node scan-boards.mjs

# Single board:
node scan-boards.mjs --site linkedin
node scan-boards.mjs --site indeed
node scan-boards.mjs --site stepstone

# Preview without writing anything:
node scan-boards.mjs --dry-run
```

Results land in `data/pipeline.md`.

### Scan company career pages

```bash
node scan.mjs
```

Hits Greenhouse, Ashby, and Lever APIs directly for companies in `portals.yml`. Zero LLM cost.

### Evaluate a job offer

Open Claude Code in the `career-ops/` directory:

```bash
claude
```

Then paste a job URL or the job description text. Claude evaluates fit, scores it, and generates a tailored CV + PDF automatically.

### Generate a PDF

```bash
node generate-pdf.mjs output/<company-role>/cv.html output/<company-role>/cv.pdf
```

### Check if postings are still active

```bash
node check-liveness.mjs
```

### Merge tracker additions after a batch run

```bash
node merge-tracker.mjs
```

---

## Key Files

| File | Purpose |
|------|---------|
| `career-ops/config/profile.yml` | Your candidate profile (not committed) |
| `career-ops/cv.md` | Your canonical CV in markdown (not committed) |
| `career-ops/portals.yml` | Job boards and company careers pages to scan (not committed) |
| `career-ops/data/pipeline.md` | Inbox of job postings to review |
| `career-ops/data/applications.md` | Full application tracker |
| `career-ops/.env` | API keys — never committed |

---

## What Is and Is Not Committed

Personal data is excluded from git via `career-ops/.gitignore`:

- `career-ops/.env` — API keys
- `career-ops/cv.md` — your CV
- `career-ops/config/profile.yml` — your profile
- `career-ops/portals.yml` — your company list
- `career-ops/data/` — your pipeline and tracker
- `career-ops/output/` — generated CVs and cover letters
- `career-ops/reports/` — evaluation reports

Use `career-ops/.env.example` as a template to share required env var names without values.

---

## Further Reading

- Full command reference: `career-ops/AGENTS.md`
- Scoring rubric: `career-ops/references/scoring-rubric.md`
- Batch processing: `career-ops/batch/README.md`
- Original project: [github.com/santifer/career-ops](https://github.com/santifer/career-ops)
