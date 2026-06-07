# Mode: format — CV & Cover Letter Format Audit and Fix

## Purpose

Audits existing CV or cover letter HTML output files for structural and compliance issues, fixes them in place, and regenerates the PDF. This mode exists because CVs and cover letters are handcrafted HTML — without a systematic check, formatting bugs accumulate silently.

---

## Canonical Experience Order

Every CV must list Work Experience in this exact order:

1. **inha GmbH** — Oct 2025 – Apr 2026
2. **Career Break — Professional Development** — Dec 2024 – Dec 2025
3. **Raynet GmbH** — Mar 2020 – Nov 2024
4. **Career Break — Language Studies and Relocation** — Aug 2019 – Feb 2020
5. **adesso Turkey Ltd.** — Aug 2016 – Jul 2019
6. **Smartiks Yazılım A.Ş.** — Jul 2011 – Jul 2016
7. **Software AG** — Sep 2009 – Jun 2011
8. **Earlier Career** (Broadcast Systems Engineering / Verscom / Airties) — 2003 – 2009

---

## CV Audit Checklist

When given a CV HTML file to audit, check every item:

- [ ] **Experience order** — entries match the canonical order above
- [ ] **Page break** — Work Experience section has `style="page-break-before: always;"` so it starts on page 2
- [ ] **Both career breaks present** — Dec 2024–Dec 2025 AND Aug 2019–Feb 2020
- [ ] **No "mycareernow"** — search and remove all occurrences from bullets and training sections
- [ ] **No "MEDDPICC certified"** — must be "MEDDPICC-trained" or "MEDDPICC and Command of the Message training"
- [ ] **No fabricated platform claims** — the following must NOT appear unless in cv.md: Arize AI platform, LangChain, LangSmith, Vapi, Deepgram API (as used tool)
- [ ] **Training section labels** — section header must be "Training & Professional Development", not "Certifications"

### CV Fix Procedure

1. Read the HTML file
2. Check each item in the audit checklist
3. Fix all failures in the HTML
4. Regenerate PDF: `node career-ops/generate-pdf.mjs <input.html> <output.pdf>`
5. Report: which items were fixed, PDF page count

---

## Cover Letter Audit Checklist

When given a cover letter HTML file to audit:

- [ ] **Business letter format** — must have `.header-row` with `.recipient` (left) and `.sender` (right) blocks
- [ ] **Sender block** — Name, Rieflerstrasse 6, 12307 Berlin, phone, email (right-aligned)
- [ ] **Recipient block** — Company name (bold), team/department, city (left-aligned)
- [ ] **Date line** — right-aligned, format: "Berlin, DD Month YYYY"
- [ ] **Subject line** — bold, format: "Re: [Role Title]"
- [ ] **Salutation** — "Dear [Company] Hiring Team," or "Dear [Company] Team,"
- [ ] **Closing** — "Kind regards," followed by bold name on next line
- [ ] **No modern header** — no `.header h1` (name in large font), no `.header-gradient` bar, no `.role-line`
- [ ] **No "MEDDPICC certified"** — must be "MEDDPICC-trained" or "training"
- [ ] **No fabricated platform usage** — same rule as CV
- [ ] **Word count** — body text ≤ 300 words (exclude salutation and closing)

### Cover Letter Fix Procedure

1. Read the HTML file
2. If the format is modern (header/gradient style), **rewrite from scratch** using `templates/cover-letter-reference.html` as the base — preserve the body text content, reframe into the business letter structure
3. If the format is already business letter, fix individual checklist failures only
4. Regenerate PDF: `node career-ops/generate-pdf.mjs <input.html> <output.pdf>`
5. Report: which items were fixed, whether a full rewrite was needed

---

## Invocation

```
/career-ops format cv-sierra
/career-ops format cover-deepgram
/career-ops format all          ← audits every file in output/
```

When `all` is specified:
1. List all `output/cv-*.html` and `output/cover-*.html` files
2. Run both audit checklists on each
3. Fix all failures
4. Regenerate all PDFs
5. Report a summary table: filename | issues found | issues fixed | pages

---

## Cover Letter Reference Template

Path: `career-ops/templates/cover-letter-reference.html`

Placeholders to substitute when generating a new cover letter:
- `{{COMPANY}}` — company name (e.g. "Arize AI")
- `{{COMPANY_TEAM}}` — team or department (e.g. "Hiring Team")
- `{{COMPANY_CITY}}` — city/country (e.g. "San Francisco, CA, USA")
- `{{ROLE_TITLE}}` — full role title (e.g. "Enterprise Account Executive, EMEA")
- `{{DATE}}` — formatted date (e.g. "12 May 2026")
- `{{SALUTATION}}` — opening line (e.g. "Dear Arize AI Hiring Team,")
- `{{BODY_PARAGRAPHS}}` — 3–4 `<p>` elements with letter body (closing "Thank you" paragraph is already in the template — do not duplicate it)

---

## Rules That Always Apply

- **Never invent experience or metrics** — all claims must trace to cv.md or article-digest.md
- **Never claim use of a specific platform unless it appears verbatim in cv.md** — this includes Arize AI, LangChain, LangSmith, Vapi, and Deepgram API as a tool the candidate used
- **Always regenerate the PDF after fixing** — never leave HTML fixed but PDF stale
- **If a PDF file is locked** (EBUSY), report this and ask user to close the file before retrying
