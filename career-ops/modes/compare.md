# Mode: compare — Side-by-Side Opportunity Comparison

Compare evaluated job opportunities and get a clear recommendation.
Trigger: "compare my options", "which should I apply to", "rank these", "compare {A} vs {B}".

---

## Step 0: Load data

1. Read `data/applications.md` — source of scores, statuses, report links
2. Read `config/profile.yml` — for compensation target and context

## Step 1: Select opportunities to compare

- If user named specific companies/roles: match from applications.md (fuzzy OK)
- If "compare my top options" or no argument: select top 3–5 entries where:
  - Score ≥ 3.5/5
  - Status is `Evaluated`, `Applied`, `Interview`, or `Responded`
  - Not `SKIP`, `Discarded`, or `Rejected`
- If fewer than 2 qualifying entries: tell the user to evaluate more first

For each selected entry, read the corresponding report from `reports/` to get full detail (summary, gaps, compensation, notes).

## Step 2: Comparison table

```
## Opportunity Comparison

| Dimension | {Company A — Role} | {Company B — Role} | {Company C — Role} |
|---|---|---|---|
| **Score** | X.X/5 | X.X/5 | X.X/5 |
| **Role type** | AE / BD / CSM / etc. | … | … |
| **Seniority** | IC / Manager / Director | … | … |
| **Location** | City / Remote | … | … |
| **Compensation** | €X–Y or "Not disclosed" | … | … |
| **Strongest match** | {top evidence} | … | … |
| **Biggest gap** | {main risk} | … | … |
| **Status** | Evaluated / Applied / etc. | … | … |
```

## Step 3: Pros and cons per opportunity

For each opportunity, list **3 specific pros** and **2 specific cons** drawn from the report — not generic observations.

```
### {Company A} — {Role}
**Pros:**
- {specific strength from report — e.g. "Berlin-based, no relocation"}
- {compensation or trajectory advantage}
- {strategic career fit}

**Cons:**
- {specific gap or risk from report}
- {location, domain, or framing concern}
```

## Step 4: Recommendation

```
## Recommendation

**Best overall match:** {Company — Role} (X.X/5)
{2–3 sentences: why this stands out, what makes it the strongest fit right now}

**Best growth opportunity:** {Company — Role}
{1–2 sentences: highest upside if gaps can be closed}

**Safest option (most likely to convert):** {Company — Role}
{1–2 sentences: most likely to result in an offer given current profile}
```

If top two scores are within 0.3 of each other:
> "These are genuinely close. The tiebreaker is which company and role energizes you most — the numbers can't measure that."

## Step 5: Next steps

> "Want me to:
> - **Generate a CV + cover letter** for your top pick? Say 'apply to {company}'
> - **Evaluate more options** before deciding? Paste a JD or share a URL
> - **Research** any of these companies deeper before applying?"

---

## Rules

- Base pros/cons on actual report content — never generic statements
- If a report is missing for an entry, note it and base analysis on tracker notes only
- Compensation misalignment vs. profile.yml target must be flagged in pros/cons
- Career Break entries (inha, language studies) are excluded from comparison automatically
- If all top options have significant blockers (geo, language, domain), say so clearly and suggest running a scan
