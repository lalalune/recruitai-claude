# recruitAI — Hiring-Partner Lead Engine
## Research findings + implementation plan

*Prepared 2026-07-28. Based on 15 parallel research agents (~1.5M tokens), three adversarial fact-check passes, and direct empirical testing of every free data source named below.*

---

## 0. Bottom line up front

Five findings change the shape of what you asked for. Each is defended in detail below.

**1. The hiring-signal layer is free, and it's the part worth building.** I tested this live today, not from documentation. Greenhouse, Ashby, Lever, SmartRecruiters, Workable and Workday all serve unauthenticated JSON of every customer's open roles. Anthropic's board returns 415 jobs with per-role location and timestamps; Ramp's Ashby board returns 121 jobs with full descriptions and structured comp inline. No key, no auth, no CAPTCHA, no ToS problem. This gives you `days_open`, repost detection, and comp — the fields that make an email land — for $0.

**2. Buy the contacts. Don't build the enrichment waterfall.** The research's own arithmetic argues against itself: DIY waterfall $2,400–5,600 vs. Clay $5,400–9,000, a ~$3,400 spread consumed several times over by the 2–4 weeks of your time to build and then maintain 5–8 provider adapters against APIs that reprice quarterly. Build the signal layer (nobody sells it); buy the addresses (everybody sells them).

**3. Don't scrape LinkedIn with your account — and this is the one place I'm pushing back on your brief.** You asked for cookie injection. The architecture works, and I can build it, but the economics are inverted: Coresignal or Bright Data sell the same person+company graph for $250–$1,500 at your volume, which is *less* than the tooling you'd buy to scrape it yourself. Meanwhile LinkedIn shut down Proxycurl in July 2025 (permanent injunction, data deletion) and hit HeyReach with a cease-and-desist in March 2026 — deleting its company page and banning the founder's personal profile. For a recruiting agency, your LinkedIn network, Recruiter seat and InMail history *are* the business. Risking them to save ~$1,500 is a catastrophic trade. Note the legal asymmetry: *Meta v. Bright Data* (2024) held logged-**out** scraping isn't bound by ToS, but the moment you inject `li_at` you're logged in, contractually bound, and in hiQ's losing posture — hiQ consented to a $500k judgment. If you want it anyway, §7 specifies the burner-account architecture.

**4. There is a California statute that breaks the standard cold-email playbook.** Cal. Bus. & Prof. Code §17529.5: **$1,000 per email, private right of action, class actions available.** *Balsam v. Trancos* makes WHOIS-private throwaway sending domains a *per se* violation. Every "buy 10 lookalike domains with privacy protection" guide is describing a $1,000-per-message liability in your home state. Fix is cheap — public WHOIS resolving to the agency, agency named in the body — but it must be decided before you buy domains.

**5. 10,000 is probably the wrong number.** BLS QCEW 2025Q1 shows ~20,840 tech establishments in the 10-county Bay Area, but establishments ≠ firms and average size in computer-systems-design is 15.6 people. Filter to "venture-backed, 20+ headcount, actively hiring" and the real population is **3,000–5,000**. You can reach 10,000 only by loosening the definition until the list stops being an ICP. I'd rather build you 800 companies where we know the req is 71 days stale and they have no in-house recruiter. See §2.

---

## 1. What I verified empirically today

Everything in this table I tested with live requests, not documentation.

| Source | Result | Cost |
|---|---|---|
| `boards-api.greenhouse.io/v1/boards/{t}/jobs` | 200. Anthropic 415 jobs / 321 SF. Has `updated_at`, `first_published`, per-job location. `?content=true` adds full JD. Also `/departments`, `/offices`. | $0 |
| `api.ashbyhq.com/posting-api/job-board/{t}` | 200. Ramp 121 jobs. **Full `descriptionPlain` + structured comp inline.** `publishedAt`, `isRemote`, `team`. | $0 |
| `api.lever.co/v0/postings/{t}?mode=json` | 200 valid / 404 invalid | $0 |
| `api.smartrecruiters.com/v1/companies/{t}/postings` | 200, paginated | $0 |
| `apply.workable.com/api/v1/widget/accounts/{t}` | 200, resolves account | $0 |
| Workday `POST /wday/cxs/{t}/{site}/jobs` | 200. NVIDIA total=2000. | $0 |
| `yc-oss.github.io/api/companies/all.json` | **6,087 YC companies. 3,046 SF. 1,493 hiring. 801 SF+hiring+active.** Includes `team_size`, `website`, `industry`. | $0 |
| HN Algolia `?tags=story,author_whoishiring` → `/items/{id}` | July 2026 thread: **276 postings, 42 SF, 76 emails published inline by the hiring party.** | $0 |
| SEC EDGAR FTS `efts.sec.gov/LATEST/search-index?forms=D` | 525 SF Form D hits in 3 months. Research agent independently pulled 16 quarters → **3,055 Bay Area operating companies + 10,823 named officers.** Caveat: skews to investment funds, needs filtering. | $0 |

**Measured discovery yield** (60-company random sample of YC SF+hiring+active):

| Method | Resolved |
|---|---|
| Naive slug guess (name, hyphenated, domain root) | 22/60 = 37% |
| Careers-page crawl for ATS links (incremental) | +4 = +7pp |
| **Union** | **26/60 = 43%**, 603 open roles |

Separate test on 40 well-known larger companies: **62% hit rate**, ~3,800 roles. ATS split among YC startups was **Ashby 15, Greenhouse 8, Lever 2** — Ashby dominates early-stage, Greenhouse dominates growth-stage, Lever is in decline. Build Ashby and Greenhouse first.

Honest read: ~43% of early-stage and ~62% of growth-stage companies expose a free machine-readable board. Budget for the remaining 40–50% needing an LLM careers-page reader or a paid aggregator (TheirStack, $0.0169/posting, verified).

**The constraint that shapes the whole email design.** I ran `dig MX` across 120 target domains:

| Mail provider | Share |
|---|---|
| **Google Workspace** | **91.7%** |
| Other / self-hosted | 4.2% |
| No MX at all | 2.5% |
| Microsoft 365 | 1.7% |

**93% sit behind Google/Microsoft, where classic SMTP `RCPT TO` probing returns no reliable verdict.** Consequences: self-hosted verification (Reacher, truemail) is not viable as the primary path — port 25 is blocked on AWS/GCP/Azure anyway and your IP reputation collapses within days at volume, silently converting to false "invalid" verdicts. A paid verifier is **mandatory, not optional**. Catch-all handling isn't an edge case here — it's the main path. Free win: no-MX domains are instant rejects before you spend a credit.

---

## 2. The premise challenge: 10,000 companies vs. 800 good ones

You asked for 10,000 companies and all their decision-makers. I want to argue for a different number, and you should overrule me if the business reasons point elsewhere.

The atomic unit of a recruiting agency's sale is **not the company — it's the requisition.** You don't sell to Stripe; you sell against *"Staff Backend Engineer, open 71 days, reposted twice, comp band $220–260k, and you have no in-house recruiter."* A company-keyed schema cannot express that sentence, and that sentence is the entire pitch.

This has a hard consequence: **reply-handling capacity, not list size, sets your ceiling.** At a 2% reply rate and 15 substantive conversations per person per day, the whole agency can absorb ~750 sends/day. 30,000 emails at 1% positive reply is 300 live conversations — most cold programs die of their own success, replies go stale for four days, and in a market this small the brand damage is permanent.

The single highest-value derived field nobody asked for: **`has_inhouse_ta`.** A company with 14 open eng reqs and zero Recruiter/Talent/Sourcer titles is a near-perfect buyer. A company with 6 in-house recruiters and 14 reqs is *hostile* — the Head of Talent's job security is threatened by your pitch. **These two look identical in every firmographic filter.** Computing `open_reqs / max(recruiter_count, 0.5)` is a one-day build and should be the primary sort key of the entire database. It's worth more than the whole email waterfall.

Also free, from JDs you're already downloading: **agency-friendliness classification.** A large share of JDs carry "we do not accept unsolicited resumes from agencies." Emailing those is a guaranteed zero with negative brand value. Others name the recruiting coordinator or hiring manager outright — a free contact with perfect provenance.

My recommendation: **build the pipeline to scale to 10,000, but target the first run at 500–1,500 companies ranked by `estimated_fee × staleness × fillable_by_us × no_inhouse_ta`.** The infrastructure is identical. Only the enrichment spend changes, and that's the part that costs money.

---

## 3. Architecture

Two loops, not one line. This distinction is what prevents paying to enrich 10,000 companies when 2,000 are in-ICP.

```
DISCOVERY LOOP (free, wide, daily)          ENRICHMENT LOOP (paid, narrow, on-demand)
─────────────────────────────────          ──────────────────────────────────────────
YC / Form D / HN / VC portfolios            contact discovery (buy)
  ↓                                          ↓
ATS token sweep → reqs + JDs                email waterfall (buy)
  ↓                                          ↓
domain validation (DNS/MX — free)           verification cascade (buy)
  ↓                                          ↓
entity resolution                            QA + LLM review
  ↓                                          ↓
disqualification (competitors,              human review queue
  no-agency JDs, existing clients)           ↓
  ↓                                         CRM sync
scoring ─────────── GATE ─────────────────→ (only entities past the gate)
```

**Hard rule: `enrich_*` tasks are only ever created by a scoring job, never by a discovery job.** The discovery loop runs at zero marginal cost forever.

### Stack

| Layer | Choice | Why |
|---|---|---|
| Store | **Postgres 18** | Single source of truth. `uuidv7()`, `pg_trgm`. |
| Queue | **Postgres `SELECT … FOR UPDATE SKIP LOCKED`** | No extra infra. State lives in tables, so the orchestrator stays swappable. |
| Orchestration | **cron + Python for v0**, Windmill later | Windmill is AGPLv3, self-hosted, $0, and doubles as scheduler + secrets + review UI. But don't need it on day one. |
| Fetching | **httpx + asyncio.** No browser for the ATS tier. | ~55–70% of the signal needs no browser, no proxy, and never sees a CAPTCHA. Playwright only for the long-tail careers-page reader. |
| LLM | **Haiku 4.5 bulk → Sonnet 5 on ~15%** | ~$35–60 for 30k contacts with Batch API + prompt caching. Trap: Haiku 4.5's minimum cacheable prefix is 4096 tokens — a short system prompt silently never caches. |
| Secrets | **1Password CLI or macOS Keychain**, never `.env` in repo | Session cookies especially. |

### Entity resolution

Three-tier cascade, not one technique.

- **Tier 1 (~85–90%):** deterministic key on registered domain (eTLD+1 via Public Suffix List, `tldextract`, refreshed weekly — a static PSL snapshot mis-splits newer TLDs). Secondary keys: LinkedIn company ID, ATS board token.
- **Tier 2:** RapidFuzz `token_set_ratio ≥ 88` against a `pg_trgm` GIN index for candidate blocking.
- **Tier 3:** Splink 4 probabilistic linkage for the domainless remainder.

**Critical:** maintain a blocklist of ~3–5k non-company domains you must never key on — free mail, `wixsite.com`, `webflow.io`, `myshopify.com`, `github.io`, `notion.site`, ATS-hosted subdomains. Keying on these silently merges hundreds of unrelated companies into one row.

**Never destructively merge.** Set `canonical_id` on the loser, keep the row, write an `entity_merges` audit row. You *will* merge wrongly and find out two months later. Subsidiaries and acquisitions are time-ranged `company_relationships`, not merges — a subsidiary often has its own hiring team and its own ATS board.

People key on the LinkedIn `/in/` slug (user-mutable, so store the numeric URN too), then normalized email, then `(last_name_norm, company_id, persona)` — deliberately not first name, because Bob/Robert and Kate/Katherine break first-name matching.

### The anti-blowup constraint

Cost control belongs in the database, not application code:

```sql
CREATE TABLE api_calls (
  call_id uuid PRIMARY KEY DEFAULT uuidv7(),
  provider text NOT NULL, endpoint text NOT NULL,
  idempotency_key text NOT NULL,
  entity_type text, entity_id uuid,
  state text NOT NULL DEFAULT 'reserved',  -- reserved|succeeded|failed|skipped_dryrun
  est_cost_usd numeric(10,6) NOT NULL DEFAULT 0,
  actual_cost_usd numeric(10,6), credits_used int,
  http_status int, error text, run_id uuid,
  started_at timestamptz DEFAULT now(), finished_at timestamptz,
  UNIQUE (provider, idempotency_key)   -- ← physically prevents re-charging for the same entity
);
```

Reserve-then-commit: write the row *before* the HTTP call. This is the single most important design decision against the "$3k Apollo blowup" failure mode.

### Provenance

Append-only `field_observations` (source, value, retrieved_at, confidence, evidence FK), resolved at **write time** into a `current_values` table — not a materialized view. At ~550k live values and millions of historical observations within a year, `REFRESH MATERIALIZED VIEW CONCURRENTLY` becomes a multi-minute operation you run constantly. A resolved table is O(1) to read and can be selectively recomputed when you change source trust weights.

---

## 4. The review layer

You asked for a second pass that checks everything is actually correct. This is the design.

### The one architectural rule that matters

**The LLM may SELECT among retrieved candidate values. It may never GENERATE a contact value.**

Asked "what is this person's email?", a model will emit a plausible, well-formed, entirely invented address. It passes syntax validation, sometimes passes MX validation, and can be a real stranger's address. Enforce structurally, in five layers:

1. **Schema-level:** the output schema contains no free-form email/phone/URL field. Shape is `{"selected_candidate_id": <int>, "confidence": <0-1>, "reasoning": <str>}` with `selected_candidate_id` constrained by a JSON Schema `enum` of exactly the retrieved candidate IDs. The model is physically unable to emit an unlisted value.
2. **Code-level:** selection and value-resolution live in different functions.
3. **DB-level:** `NOT NULL` evidence FK — no contact value can exist without a row pointing at where it came from.
4. **Post-validation:** fail-closed byte-equality check against the candidate set.
5. **Abstention:** `null` is always a legal answer.

### Confidence score (0–100, additive)

Starting weights — a cold-start prior, not truth:

| Component | Max |
|---|---|
| Verification verdict | 35 |
| Independent source corroboration | 20 |
| Email pattern conformance | 15 |
| Tenure recency | 15 |
| Role–ICP fit | 10 |
| Domain health | 5 |
| Hiring-signal freshness | 5 |

**Source independence must be defined by upstream lineage, not vendor name.** Two vendors deriving from the same profile graph count as *one* source family. Maintain an explicit `source_family` map or you'll score correlated errors as corroboration.

**Calibration:** Phase 1 (pre-send) validate *ordering only* against the golden set via Spearman correlation — absolute values don't matter yet. Phase 2 (post-send) fit logistic regression on `P(hard_bounce)` using real outcomes, then isotonic regression so "score 80" means a measured bounce probability. Phase 3, refit monthly, watch for per-decile drift.

### Gates

- Send at score **≥70**; **≥80** for catch-all addresses
- **1.8%** per-inbox bounce → auto-pause; **2%** campaign-wide → stop
- Spam complaints under **0.10%**, hard stop at **0.30%**
- **2%** stratified sample per batch, 20–40 seed inboxes
- Hard **12-month** employment-evidence age gate (this is also the recycled-spamtrap guard)

### Spamtraps

Pristine traps are *seeded strings* that must be harvested verbatim. An address constructed from an independently-verified identity plus the domain's observed pattern is structurally very unlikely to be one — this is a real argument *for* pattern inference over scraping `mailto:` links. Recycled-trap exposure is a direct function of staleness, hence the 12-month gate. Permanently suppress anything that has ever hard-bounced; auto-suppress zero-engagement addresses after 3 complete sequences.

### Human review

Keyboard-driven queue, zero tab-switching, evidence panel inline. Target 100–150 records/hour. Golden set of 300–500 records stratified by score decile / source / catch-all status, with a **30% blind holdout** and a deliberate below-threshold burner-domain cohort — that cohort is the only way to measure gate *recall* rather than just precision. A VA can do tenure/title verification after hitting 95% agreement on gold; a VA should not make ICP judgments.

### Scraper QA

The failure mode fixtures alone can't catch: a site changes its HTML and you silently collect empty strings forever. You need frozen golden-file fixtures **plus** live canary records **plus** selector-match-rate drift detection **plus** per-source yield and field-null-rate control charts.

---

## 5. Legal constraints that shape the build

Not a disclaimer section — these become schema.

| Constraint | Reality | Build consequence |
|---|---|---|
| **Cal. B&P §17529.5** | **$1,000/email, private right of action, class actions.** *Balsam v. Trancos*: WHOIS-private throwaway domains are per se violative. | Public WHOIS resolving to the agency. Agency named in body. Decide **before** buying domains. |
| **CCPA/CPRA** | B2B and HR exemptions sunset 2023-01-01. Work email/title/direct dial of a CA resident is full personal information. **California is the only state whose privacy law reaches B2B contact data.** | Two escape hatches to engineer for: §1798.140(v)(2) "publicly available," and Reg §7012(h) which removes Notice-at-Collection entirely if you neither collect directly nor sell/share. **Both close the moment you upload to LinkedIn/Meta custom audiences.** |
| **Data broker / DELETE Act** | Own-use prospecting is **not** brokering (§1798.99.80(c) requires collect *and* sell). But submitting sourced candidates to clients for a fee is plausibly a "sale." Genuinely open — three unaddressed defenses, no CPPA guidance across 600+ registrants. | Fact-check verdict: the "four-day fuse" is **manufactured** — Aug 1 obligations bind *registered* brokers; a non-operating business accrues nothing. Resolve before the first candidate submission and before Jan 31, 2027. But build the DROP suppression table now — retrofitting is impossible. |
| **FCRA** | Assembling third-party dossiers on candidates and furnishing to employers is the classic CRA fact pattern. Private right of action. | Larger candidate-side risk than broker registration. Apollo's ToS separately forbids FCRA-governed use. |
| **CAN-SPAM** | $53,088/violation (no 2026 adjustment — OMB M-26-11 cancelled the multiplier). No prior consent required. | Accurate headers, physical address, opt-out honored in 10 business days. |
| **Scraping** | *hiQ* consented to $500k judgment on breach of contract, CFAA, §502, trespass, misappropriation **and spoliation**. Logged-out public scraping is defensible (*Meta v. Bright Data*); logged-in is not. | Stay logged out. Cal. Penal Code **§502** is broader than CFAA and has its own private right of action. |
| **Vendor contracts** | *Meta v. Bright Data* left a tortious-interference theory alive. | Any data vendor contract needs a rep/warranty that data wasn't obtained in breach of a platform agreement, **plus indemnity**. Otherwise "buy it from a licensed vendor" inherits the exposure. |
| **Phones** | Federal DNC genuinely not required for true B2B (TSR exemption) — but the exemption evaporates for personal mobiles, which is exactly what you'd be buying. | Trestle litigator-check at $0.005/query. Skip the $22,626/yr registry. |

**One product decision moots most of the candidate-side risk:** no candidate profile is transmitted to a client until that candidate has affirmatively opted in. Build it regardless of the answer.

**Enumeration ethics.** The ATS token sweep reads only data companies published publicly and bypasses no authentication. But it *is* high-volume probing. Seed from real company names rather than generating permutations, cap concurrency at 10–20 with jitter, send a truthful User-Agent with a contact URL, cache negatives. **The line not to cross: on a 429 or 403, back off — do not rotate proxies to evade it.** Reading public data briskly is defensible; circumventing a deliberate block converts an operational annoyance into a contract and §502 argument.

---

## 6. Cost model — read the caveat first

**The adversarial fact-check found systematic pricing errors in the research, and every one was labeled HIGH confidence.** Documented misreads: BetterContact off by ~4x (a price-slider base mistaken for a volume band — $399/10k credits, not the claimed $0.010/credit); Coresignal's annual column shifted a full row; Icypeas per-email rates copied from marketing rather than divided; a cited "20,000-contact hard bounce test" that was actually 5,000 contacts with **no bounces measured at all** (estimated from vendor consensus); and Findymail's "best in benchmark" claim omitting that the benchmark's *publisher* scored higher on both axes.

**Treat every number below as an estimate to verify with a quote. Do not commit spend off this table.**

Also unpriced and load-bearing: **Apollo's API requires a Custom plan** ("API Access on our Custom plans" — verbatim from their pricing page), so the entire sourcing layer's cost is an unpriced sales negotiation, not $49–99/mo. Findymail Enterprise and FullEnrich Scale are likewise unpublished.

| Item | Est. | Confidence |
|---|---|---|
| ATS sweep + YC + HN + Form D + WARN + DOL LCA | **$0** | **Verified by me today** |
| JD classification (LLM, ~100k JDs) | ~$500 | Medium |
| Contact data — 500–1,500 co. path | $500–1,500 | Low, get quotes |
| Contact data — full 10k path | $4,300+ confirmed list prices, three items unpriced | Low |
| Email verification (~$0.005–0.01 ea) | $300–700 | Medium |
| Phones (top 10–20% only) | $500–1,000 | Medium |
| **Data subtotal (recommended scope)** | **~$1,500–3,500** | |
| Your time, v0 | 2–3 days | |
| Your time, full system | 5–6 weeks | |

Phones deserve their own warning. The best independent benchmark (1,400 US B2B contacts, 7 personas) found that across *all* providers only **~60% of returned mobiles belong to the right person** — 25% belong to someone else, 15% unconfirmable. Best single vendor was Wiza at 51% net. Expect 45–55% from one vendor, 60–65% from a waterfall. Never 90%. **Don't phone-enrich 30,000 people.** Build the schema, enrich the top 10–20%, lead with email.

---

## 7. If you still want LinkedIn

Your call, and the architecture is sound if you accept the risk. Non-negotiables:

1. **Burner accounts only. Never the agency identity, never your personal profile.**
2. **LinkedIn for identification only** — name, title, company, profile URL. Emails come from a separate provider. This single split is the highest-leverage mitigation, because it means a lost account costs you a scraping session, not your contact database.
3. Residential proxy in the account's usual geography; one persistent profile per account per proxy.
4. Per-account daily budgets well under the commercial-search limit, human pacing, session persistence.
5. Cookies in Keychain or 1Password, never in the repo. Detect expiry and prompt for refresh rather than retrying into a lockout.
6. **Never solve a CAPTCHA** — treat it as a stop signal and route to the paid API fallback.

Note the residual exposure even if you buy instead of scrape: LinkedIn ToS 8.2.4 purports to bind you as a *buyer* of scraped data ("whether directly or through third parties (such as … data aggregators or brokers)") for as long as you hold a LinkedIn account.

---

## 8. Build sequence

**v0 — 2–3 days. One Python file. No orchestrator, no UI.**
YC dump → ATS token sweep (Greenhouse + Ashby first) → reqs with `days_open` → domain/MX validation → email pattern inference → verify. Ships 100 real, usable, verified leads in week one. Everything after this is scale and polish.

**Phase 1 — week 1–2. The differentiated part.**
Full ATS sweep across all six platforms. Req-level schema with daily snapshots (`days_open`, `repost_count`, comp midpoint, `estimated_fee`). JD classification for no-agency disclaimers and named contacts. `has_inhouse_ta`. Free government ingests: Form D, DOL H-1B LCA (free CSVs with employer, exact title, worksite, offered wage — validates roles *and* gives comp), CA EDD WARN.

**Phase 2 — week 3–4. Buy contacts.**
Entity resolution. Per-segment contact recipes (§9 Q3). Purchased enrichment on gated entities only. Verification cascade. Cost ledger live from the first paid call.

**Phase 3 — week 4–5. Review.**
Scoring, golden set, LLM select-never-generate pass, human review queue, gates.

**Phase 4 — week 5–6. Ship it where recruiters work.**
CRM sync, suppression, feedback loop from real bounce/reply data.

**The most common way this project dies:** the data lands in Postgres, recruiters won't run SQL, it gets used for one campaign and abandoned. Name the destination system before building — the integration is often more work than the enrichment.

---

## 9. Questions I need answered

These are ordered by how much they change the build. The first four are blocking.

### Blocking

**Q1 — Scope. What's your actual delivery capacity?** How many searches can your recruiters run and fill per quarter? Which functions and seniority can you genuinely deliver on? How many *new* client conversations per month would saturate you?
→ This almost certainly sizes the list at 500–1,500 rather than 10,000, and it invalidates the entire cost model and waterfall architecture downstream of the bigger number. If you want 10,000 anyway, tell me why and I'll build for it.

**Q2 — Payload. What does the email actually say?** Three options, and they invert the build order:
- **(a) MPC / candidate-led** — "I have a Staff Backend eng, 6 yrs at Stripe, interviewing now, $260k target; you have a Staff Backend req open 71 days." Highest converting by far. Requires candidate-side data the plan currently has *zero* of.
- **(b) Req-specific market intelligence** — days open, comp drift, competing employers. Buildable entirely from free data.
- **(c) Generic capability pitch** — what VP Engs delete on sight.
→ If (a), we're building the wrong half of the database first and the email waterfall is premature. Do you have a bench?

**Q3 — Who's the buyer, by segment?** This varies enormously, and in one band the obvious title is your *enemy*:
- <20 headcount: founder decides instantly, may not pay 20–25%
- 20–75, no in-house TA: founder or VP Eng
- 20–75, *has* a first Head of Talent: **they're frequently a blocker, not a buyer** — agency spend competes with their headcount budget and implies they're failing
- 75–300: Head of Talent genuinely owns the budget; VP Eng is the pain-generator
- 300+: probably deprioritize, or route to a PSL-application motion rather than cold email
→ Confirm or correct this, and I'll encode it as per-segment contact recipes instead of a flat "3 contacts per company."

**Q4 — Own use only, or does data reach clients?** Single largest legal fork. Own-use triggers nothing. Transmitting contact records or candidate profiles to client companies potentially triggers data-broker registration in four states (Texas has *no* knowledge requirement), FCRA consumer-reporting exposure with a private right of action, and vendor resale prohibitions requiring an Apollo Reseller agreement or a PDL/Coresignal bulk license.

### Important

**Q5 — Minimum viable placement fee?** A 20–25% fee on a $180k Staff Eng req is $36–45k; on a $95k junior role it's $19–24k and may not clear cost-to-serve. This one threshold prunes the universe harder than any firmographic filter, and it's computable for free from Ashby's structured comp and DOL LCA wage data.

**Q6 — Geography, precisely?** SF city only, the 9-county Bay Area, the 10-county definition BLS uses, or any req a Bay Area candidate could fill including remote? Determines whether 10,000 is even reachable.

**Q7 — Sending identity, and who handles replies?** A named senior recruiter converts far better than a lookalike domain but puts a real person's reputation at stake. Reply SLA sets the daily volume ceiling. And per §5 — **public WHOIS, decided before you buy any domains.**

**Q8 — System of record?** Bullhorn, Loxo, Recruiterflow, Crelate, Attio, Airtable, or Postgres + Metabase? Budget the integration as part of the build.

**Q9 — LinkedIn: accept my recommendation, or proceed?** If proceeding: burner accounts only, or are you willing to risk the agency account? (Strong recommendation: burner, identification-only.)

**Q10 — Existing relationships to suppress?** Current clients, active contracts, past rejections, placed-candidate employers, competitor agencies, portfolio companies under exclusivity. Every one of these is an unforced brand injury in a market where everyone talks. Can you export this from your ATS/CRM on day one?

### Worth deciding early

**Q11 — Budget ceiling** for data, monthly and one-time, so I can set a hard `spend_caps` value rather than guessing.

**Q12 — Warm paths.** Have you placed people at VC portfolio companies? An investor→portfolio edge table plus your placement history yields a `warm_path_score`; anything with a warm path should be routed to a human intro and *removed from the cold sequence entirely*. VC talent partners are themselves a ~50-person target list that gates hundreds of companies — plausibly higher ROI than the entire cold program.

**Q13 — Refresh cadence.** One-time build, or a living database? Changes the orchestration choice and whether a Coresignal/PDL annual data license ($10–30k/yr) ever makes sense.

---

## 10. What I'd do on your go-ahead

Assuming answers land roughly where I expect (scope ~800 companies, payload (b) moving to (a), own-use only):

1. v0 in 2–3 days: YC + Greenhouse/Ashby sweep → 100 verified leads with `days_open` and `has_inhouse_ta`
2. You look at those 100 and tell me whether the ICP is right *before* I spend a dollar on enrichment
3. Then build outward

The riskiest assumption in this whole plan is not technical — it's that cold email to SF engineering leaders is the right channel at all. They are the most recruiter-saturated inbox population on earth. Before committing the full budget there, it's worth testing the VC talent-partner path and the placed-candidate referral loop, both of which are nearly free and plausibly convert an order of magnitude better.
