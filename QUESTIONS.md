# Questions to answer before implementation

Answer inline under each question. Full reasoning for why each matters is in [PLAN.md](PLAN.md) §9.
The first four are blocking — I can't finalize the implementation plan without them.

---

## BLOCKING

### Q1. Delivery capacity → how big should the list actually be?
How many searches can your recruiters run and fill per quarter? Which functions and seniority levels can you genuinely deliver on? How many *new* client conversations per month would saturate you?

> **A:**

*Why it's blocking: this likely sizes the list at 500–1,500 rather than 10,000, which changes the entire enrichment architecture and cost model.*

---

### Q2. What does the email actually say?
Pick one:
- **(a) MPC / candidate-led** — "I have a Staff Backend eng, 6 yrs at Stripe, interviewing now, $260k target; you have a Staff Backend req open 71 days." *Highest converting. Requires candidate-side data we currently have none of.*
- **(b) Req-specific market intel** — days open, comp drift, competing employers. *Buildable entirely from free data.*
- **(c) Generic capability pitch.* *What VP Engs delete on sight.*

**Do you have a candidate bench right now?**

> **A:**

*Why it's blocking: if (a), we build candidate-side first and the email waterfall is premature.*

---

### Q3. Who is the buyer, by company size?
Confirm or correct:

| Headcount | Buyer | Note |
|---|---|---|
| <20 | Founder | Decides instantly; may not pay 20–25% |
| 20–75, no in-house TA | Founder or VP Eng | **Best segment** |
| 20–75, has first Head of Talent | ⚠️ Often a **blocker**, not a buyer | Agency spend competes with their headcount budget |
| 75–300 | Head of Talent owns budget | VP Eng is the pain-generator |
| 300+ | Deprioritize / PSL motion | Cold email rarely works |

> **A:**

---

### Q4. Own use only, or does data reach clients?
Will contact records, candidate profiles, or lists ever be transmitted to client companies?

- [ ] Own outbound only
- [ ] Data/profiles go to clients

> **A:**

*Why it's blocking: own-use triggers nothing. Client delivery potentially triggers data-broker registration in 4 states, FCRA exposure, and vendor resale prohibitions.*

---

## IMPORTANT

### Q5. Minimum viable placement fee?
Below what fee is an engagement not worth running? (Prunes the universe harder than any firmographic filter.)

> **A:**

### Q6. Geography, precisely?
SF city / 9-county Bay Area / 10-county / anything a Bay Area candidate could fill including remote?

> **A:**

### Q7. Sending identity + reply handling?
Who does mail come from? Who handles replies, and at what SLA?
⚠️ Whatever you choose: **public WHOIS resolving to the agency** — Cal. B&P §17529.5 is $1,000/email with a private right of action, and WHOIS-private throwaway domains are per se violative. Decide before buying domains.

> **A:**

### Q8. System of record?
Bullhorn / Loxo / Recruiterflow / Crelate / Attio / Airtable / Postgres+Metabase?

> **A:**

*The most common way this project dies is landing in a database recruiters never open.*

### Q9. LinkedIn — accept the recommendation, or proceed?
Recommendation: don't scrape with any account you care about; buy the graph for $250–1,500. If proceeding anyway: burner accounts only, or risk the agency account?

> **A:**

### Q10. Existing relationships to suppress?
Current clients, active contracts, past rejections, placed-candidate employers, competitor agencies, companies under exclusivity. Can you export these from your ATS/CRM on day one?

> **A:**

---

## EARLY BUT NOT URGENT

### Q11. Budget ceiling for data (one-time and monthly)?
Sets a hard `spend_caps` value instead of a guess.

> **A:**

### Q12. Warm paths?
Have you placed people at VC portfolio companies? Anything with a warm path should be routed to a human intro and removed from the cold sequence. VC talent partners are a ~50-person list gating hundreds of companies — plausibly higher ROI than the whole cold program.

> **A:**

### Q13. Refresh cadence — one-time build or living database?
Changes orchestration choice and whether an annual data license ever makes sense.

> **A:**
