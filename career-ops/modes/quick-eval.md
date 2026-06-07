# Mode: quick-eval — Fast Job Triage

One-paragraph score. No report saved. No tracker update.
Trigger: "quick eval", "quick score", "just give me a number", "is this worth looking at".

Use before committing to a full evaluation. Saves tokens on obvious weak fits.

---

## Step 0: Load profile

Read `config/profile.yml`. If missing, tell the user to run setup first.
Also read `data/corpus/narrative/swot.md` if it exists — for gap awareness.

## Step 1: Get the JD

Accept: pasted text, URL (fetch with Playwright or WebFetch), or file path.
Extract: title, company, location, hard requirements, seniority signals, language requirements.

## Step 2: Score (1.0–5.0)

Weight:
- Hard requirement coverage vs. profile: 40%
- Seniority alignment: 25%
- Location / work arrangement fit: 20%
- Domain / language fit: 15%

Apply instant SKIP flags:
- Language required that candidate doesn't have → cap at 2.0
- Geography hard blocker (US-only, visa required, no remote) → cap at 2.5
- Wrong seniority by more than 2 levels → flag prominently

## Step 3: Output

```
**{Score}/5.0** — {Company}: {Role}

{One honest paragraph. What matches, what doesn't, and whether it's worth
a full evaluation. Reference 1–2 specific requirements from the JD and how
the candidate's background maps. Be direct, not generic.}

Worth a full eval? {Yes / No / Depends on [X]}
```

No file saved. No tracker update.

If score ≥ 3.5:
> "Solid signal. Say **'evaluate'** to run the full A–F report and generate a tailored CV."

If score < 3.0:
> "Weak fit — main blocker is {X}. Skip unless you have a specific reason to override."
