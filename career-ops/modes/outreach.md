# Mode: outreach — LinkedIn & Email Outreach Drafting

Draft personalized outreach for hiring managers, recruiters, or connectors.
Trigger: "draft outreach", "message the recruiter", "reach out to", "write a LinkedIn message", "cold email to".

Structure: Hook (about them) → Proof (one number about you) → Ask (low-pressure).

---

## Step 0: Load context

1. Read `config/profile.yml` — for proof points and positioning
2. Read `data/corpus/narrative/leadership-philosophy.md` if it exists — for named stories
3. Check `reports/` for any existing evaluation of this company — for company-specific hooks
4. If user named a specific contact, note name + title + company

## Step 1: Identify message type

| Type | When to use | Hard limit |
|---|---|---|
| LinkedIn connection request | No existing connection | 300 characters |
| LinkedIn message (connected) | Already connected | 100–200 words |
| Cold email | Have their email | 100–150 words |
| Follow-up | No response after 5+ days | 50–75 words |

If not clear from context, ask: "LinkedIn connection request, message, email, or follow-up?"

## Step 2: Build the 3-part message

### Part 1 — Hook (about THEM, not you)

Reference something specific: a role they're hiring for, a recent company announcement, their team's work, or their own background.

- Bad: "I'm really interested in your company"
- Bad: "I'd love to connect"
- Good: "I noticed {company} is building out DACH enterprise sales from Berlin"
- Good: "Your team's approach to [specific product/GTM motion] caught my attention"

Pull hooks from the evaluation report if one exists for this company.

### Part 2 — Proof (one quantifiable thing)

One sentence. One number. Directly relevant to their world.

- Bad: "I have 15 years of enterprise sales experience"
- Good: "I built Raynet's Turkish operation from zero — 6 Tier-1 clients and seven-figure revenue in year one"
- Good: "At adesso I displaced entrenched incumbents to win the Group's largest FSI contract — a multi-year engagement with Akbank"

Match the proof point to the role's core requirement. Pull from `config/profile.yml` proof_points or `data/corpus/narrative/leadership-philosophy.md` named stories.

### Part 3 — Ask (low-pressure)

- Bad: "Can you refer me?" (presumptuous)
- Bad: "I'd love to pick your brain" (vague)
- Good: "Would you be open to a 15-minute call about what the team looks for?"
- Good: "If there's a fit, I'd welcome a conversation — happy to share more context"

## Step 3: Output

```
## Outreach — {Contact Name / "Hiring Team"} at {Company}

**Type:** {LinkedIn connection / LinkedIn message / Cold email / Follow-up}
**Role context:** {role being applied for or targeted team}

---

{the message}

---

**Word/character count:** {n}
**Tone:** {Professional / Direct / Warm}
```

## Step 4: Offer variants

> "Want me to:
> - Adjust tone (more formal / more direct / warmer)?
> - Write a follow-up for if there's no response in a week?
> - Draft for a different contact at {company}?"

---

## Rules

- Never misrepresent Fatih's background or claim connections that don't exist
- Never use sycophantic openers ("I'm a huge fan of…", "I've been following you for years…")
- LinkedIn connection requests: hard 300-character limit — count before output
- Every message must contain something specific — no pure templates
- German C1 note: if the contact is at a German company and the message is in German, frame German as "C1-certified, actively used" — not "fluent" or "native"
- If no company report exists and no web search available, flag: "This would be stronger with specific company context — want me to look them up first?"
