# search_job — Session Instructions

## ALWAYS do this before any job search work

All job board scanning (LinkedIn, Indeed, Stepstone) is done by Claude via the
Chrome DevTools Protocol MCP server connected to the user's real Chrome session.

**To scan job boards, the user says:**
- "scan LinkedIn" / "scan Indeed" / "scan Stepstone" / "scan all boards"

**Claude then:**
1. Uses `cdp_navigate` to open each search URL
2. Uses `cdp_evaluate` to extract job cards from the DOM
3. Deduplicates against pipeline.md, scan-history.tsv, and applications.md
4. Writes new results to `career-ops/data/pipeline.md` and `career-ops/data/scan-history.tsv`

**Prerequisite — Chrome must be running with remote debugging:**
```
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\Google\Chrome\User Data"
```
The user logs into LinkedIn, Indeed, and Stepstone manually in that Chrome window.

For company careers pages (Greenhouse/Ashby/Lever APIs — no login needed):
```
node career-ops/scan.mjs
```

Results land in `career-ops/data/pipeline.md`. Evaluate with `/career-ops pipeline`.

## Key scripts

| Script | What it does |
|--------|-------------|
| `career-ops/scan.mjs` | Company careers pages + Greenhouse/Ashby/Lever API |
| `career-ops/mcp-cdp.mjs` | CDP MCP server — started automatically by Claude Code |
| `career-ops/generate-pdf.mjs <cv.html> <cv.pdf>` | HTML → PDF via Playwright |
| `career-ops/merge-tracker.mjs` | Merge TSV additions into applications.md |
| `career-ops/check-liveness.mjs` | Check if job postings are still active |

## CDP MCP tools available to Claude

| Tool | What it does |
|------|-------------|
| `cdp_navigate(url)` | Navigate Chrome to a URL, wait for load |
| `cdp_snapshot()` | Get page title + URL + visible text |
| `cdp_evaluate(script)` | Run JS in the page, return JSON result |
| `cdp_click(selector)` | Click a CSS selector (e.g. cookie banners) |
| `cdp_scroll(pixels)` | Scroll down to load more results |
| `cdp_list_tabs()` | List all open Chrome tabs |

## Job board scan — output format

When writing scan results to pipeline.md, append under `## Pendientes`:
```
- [ ] <url> | <company> | <title>
```
Append one TSV line per job to scan-history.tsv (create header if missing):
```
url\tfirst_seen\tportal\ttitle\tcompany\tstatus
<url>\t<YYYY-MM-DD>\t<linkedin|indeed|stepstone>\t<title>\t<company>\tadded
```
Skip any URL already in pipeline.md, scan-history.tsv, or applications.md.
Apply the title filter from portals.yml (`title_filter.positive` / `title_filter.negative`).

## CV and cover letter outputs

All application documents live in `career-ops/output/<company-role>/`:
- `cv.html` + `cv.pdf`
- `cover-letter.html` + `cover-letter.pdf`

## Environment

All API keys are in `career-ops/.env` — never commit this file.
- `ANTHROPIC_API_KEY` — Claude API

## Memory system

User memories are in `C:\Users\Fatih\.claude\projects\c--Users-Fatih-Desktop-May2026-Projects-search-job\memory\`.
Read MEMORY.md index at session start before doing any application work.
