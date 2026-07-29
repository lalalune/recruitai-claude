# Empirically verified 2026-07-28 (live curl, not documentation claims)

## ATS public JSON endpoints — ALL FREE, NO AUTH, NO KEY

| ATS | Endpoint template | Verified | Notes |
|---|---|---|---|
| Greenhouse | `https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | 200 ✓ | Anthropic=415 jobs (321 SF). Fields: `title, location.name, updated_at, first_published, absolute_url, id, requisition_id, metadata, company_name`. Also `/departments`, `/offices`. |
| Ashby | `https://api.ashbyhq.com/posting-api/job-board/{token}` | 200 ✓ | Ramp=121 jobs. **Includes full `descriptionHtml`/`descriptionPlain` inline.** Fields: `title, department, team, location, address, isRemote, workplaceType, employmentType, publishedAt, jobUrl`. |
| Lever | `https://api.lever.co/v0/postings/{token}?mode=json` | 200 ✓ | Valid token → 200 + array; invalid → 404 `{"ok":false}`. |
| SmartRecruiters | `https://api.smartrecruiters.com/v1/companies/{token}/postings` | 200 ✓ | Paginated envelope `{offset,limit,totalFound,content[]}`. |
| Workable | `https://apply.workable.com/api/v1/widget/accounts/{token}` | 200 ✓ | Resolves account display name. |
| Workday | POST `https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` body `{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}` | 200 ✓ | NVIDIA total=2000. Fields: `title, externalPath, locationsText, postedOn`. Offset pagination. |

**Key consequences:**
1. The entire hiring-signal layer costs **$0**. This is the highest-ROI part of the system and needs no vendor.
2. `updated_at` / `first_published` / `publishedAt` give **job posting age** → the "stuck req open >45 days" signal, which is the single best pitch hook for a recruiting agency.
3. **404-vs-200 tells you cheaply whether a company you already know about uses a given ATS.** Note what the implementation deliberately does *not* do with that: it never generates token permutations to enumerate an ATS vendor's customer list. Every token probed is derived from a company already discovered from YC, Form D or HN — so we only ever ask an ATS about companies we have independent reason to believe exist. That is both more effective (a real name resolves faster than a dictionary) and more defensible.
4. Ashby returning full job descriptions inline means LLM parsing of requirements/seniority costs one API call, not two.

### Per-host rate-limit behaviour (measured 2026-07-28, during a live 1,444-company sweep)

Hosts differ sharply, and this materially changes the sweep design:

| Platform | Miss response | Behaviour under rapid probing |
|---|---|---|
| Greenhouse | `404` | Served hundreds of probes without complaint |
| Ashby | `404` | Served hundreds of probes without complaint |
| Lever | `404` | No issues observed |
| **Workable** | `404` | **429s after ~a handful of rapid misses** |
| SmartRecruiters | **`200`** (empty envelope) | No 429s, but cannot be used as a cheap miss-probe — must check `totalFound` |

**Consequence:** blocks must be tracked **per platform, not globally.** The first implementation treated any 429 as a terminal signal for the whole sweep, so a single Workable 429 aborted all 1,444 companies and yielded zero boards. The fix is to drop the blocking host for the rest of the run and keep talking to the ones that are serving us — still never retrying or evading, just no longer asking that host.

## Other free sources verified

**HN "Ask HN: Who is hiring?"** — Algolia API, free, no key.
- Threads: `https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring`
- Thread body: `https://hn.algolia.com/api/v1/items/{id}`
- July 2026 thread (id 48747976): **276 postings, 42 mention SF, 76 distinct emails embedded in the post text.**
- ~76 hand-delivered hiring-manager emails/month, ~900/yr from archives. Highest-intent free email source found.

**YC company directory (yc-oss mirror)** — free, no key, single GET, 10 MB.
- `https://yc-oss.github.io/api/companies/all.json`
- **6,087 companies. 3,046 SF-located. 1,493 currently hiring. 801 SF + hiring + active.**
- Fields include `name, website, team_size, batch, industry, industries, all_locations, isHiring, status, one_liner, long_description, regions`.
- `team_size` directly satisfies the "company size" requirement. `isHiring` is a first-class intent flag.
- Official YC Algolia keys are rotated/403 — use the yc-oss mirror, but treat it as a third-party mirror (pin + monitor for staleness).

### MEASURED end-to-end yield (60-company random sample of YC SF+hiring+active)
| Method | Boards resolved |
|---|---|
| Naive slug guess (name, name-hyphenated, domain root) | 22 / 60 = **37%** |
| Careers-page crawl for ATS links (incremental) | +4 = **+7pp** |
| **Union** | **26 / 60 = 43%**, 603 open roles across 24 countable boards |

ATS split among YC startups: **Ashby 15, Greenhouse 8, Lever 2, Teamtailor 1.**
→ **Ashby dominates early-stage; Greenhouse dominates later-stage** (separate 40-large-company test: 62% hit rate, almost all Greenhouse). Build Ashby + Greenhouse first; Lever is in decline.

**Honest coverage conclusion:** ~43% early-stage / ~62% growth-stage of companies expose a free machine-readable board. Budget for the remaining ~40–50% needing either an LLM careers-page reader or a paid aggregator. Do NOT assume the free path covers the whole universe.

## MX distribution — THE dominant constraint on email verification
Measured across 120 YC SF hiring-company domains (`dig MX`):

| Mail provider | Count | Share |
|---|---|---|
| **Google Workspace** | 110 | **91.7%** |
| Other / self-hosted | 5 | 4.2% |
| No MX record at all | 3 | 2.5% |
| Microsoft 365 | 2 | 1.7% |

**93% sit behind Google/Microsoft, where classic SMTP `RCPT TO` probing does not return a reliable verdict** (Google accepts-all at RCPT for most tenants and rate-limits/blocks probers).

Consequences for the design:
1. Self-hosted/OSS SMTP verification (Reacher, truemail) will return *unknown/risky/catch-all* for the overwhelming majority of this list. **Do not build the verification layer on it.**
2. A paid verifier with a working Google-specific method is effectively **mandatory**, not optional. This is a hard budget line.
3. The "catch-all handling policy" is not an edge case here — it is the **main path** for ~9 in 10 records. Whatever the plan says about catch-alls governs the whole list.
4. Free wins that need no vendor: **no-MX domains (2.5%) are instant rejects**; do this filter before spending a single verification credit.

**SEC EDGAR full-text search** — free, requires descriptive `User-Agent` header.
- `https://efts.sec.gov/LATEST/search-index?q="San Francisco"&forms=D&startdt=..&enddt=..`
- 525 Form D hits for SF, May–Jul 2026. **Caveat: results skew heavily to investment funds (Farallon etc.), not operating companies — needs aggressive filtering.** Form D does carry related-persons (exec) names + addresses.
