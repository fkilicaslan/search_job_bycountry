# search_job — Session Instructions

## ALWAYS do this before any job search work

Before using WebSearch or any manual search approach, check what automation already exists:

```
node career-ops/scan-boards.mjs              # LinkedIn + Indeed (Bright Data) + Stepstone (Playwright)
node career-ops/scan-boards.mjs --site linkedin
node career-ops/scan-boards.mjs --site indeed
node career-ops/scan-boards.mjs --site stepstone
node career-ops/scan-boards.mjs --dry-run    # preview without writing
node career-ops/scan.mjs                     # company careers pages + Greenhouse API
```

Results land in `career-ops/data/pipeline.md`. Evaluate with `/career-ops pipeline`.

## Key scripts

| Script | What it does |
|--------|-------------|
| `career-ops/scan-boards.mjs` | LinkedIn + Indeed via Bright Data API; Stepstone via Playwright |
| `career-ops/scan.mjs` | Company careers pages + Greenhouse/Ashby/Lever API |
| `career-ops/generate-pdf.mjs <cv.html> <cv.pdf>` | HTML → PDF via Playwright |
| `career-ops/merge-tracker.mjs` | Merge TSV additions into applications.md |
| `career-ops/check-liveness.mjs` | Check if job postings are still active |

## CV and cover letter outputs

All application documents live in `career-ops/output/<company-role>/`:
- `cv.html` + `cv.pdf`
- `cover-letter.html` + `cover-letter.pdf`

## Environment

All API keys are in `career-ops/.env` — never commit this file.
- `BRIGHTDATA_API_KEY` — Bright Data (LinkedIn + Indeed)
- `ANTHROPIC_API_KEY` — Claude API
- `BRIGHTDATA_LINKEDIN_DATASET_ID=gd_lpfll7v5hcqtkxl6l`
- `BRIGHTDATA_INDEED_DATASET_ID=gd_l4dx9j9sscpvs7no2`

## Memory system

User memories are in `C:\Users\Fatih\.claude\projects\c--Users-Fatih-Desktop-May2026-Projects-search-job\memory\`.
Read MEMORY.md index at session start before doing any application work.
