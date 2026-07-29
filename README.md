# recruitAI

A local-first desktop app that finds Bay Area startups which are actively hiring, identifies the people who decide whether to engage a recruiting agency, verifies their email addresses, and helps you send individually-written outreach from your own Gmail at a human pace.

Everything runs on your machine. No server, no account, no telemetry. **Company and contact data never leaves your computer and is never committed to this repository** — it lives in a gitignored `data/` folder.

---

## Why this exists

Most lead-gen tooling sells you addresses. Addresses are a commodity that cost a cent each. What actually makes a recruiting-agency email land is a specific, checkable fact:

> You have a Staff Backend Engineer req that's been open 71 days, it's been reposted twice, and you have no in-house recruiter.

Every one of those facts is available for free from public job-board APIs. recruitAI is built around collecting them.

## What it does

**Discovery is free.** Greenhouse, Ashby, Lever, SmartRecruiters, Workable and Workday all publish every customer's open roles as unauthenticated JSON. Combined with Y Combinator's open company directory and the monthly Hacker News "Who is hiring?" thread, that's a complete hiring-signal layer at zero cost and with no API keys. All of it was verified live before being built — see [VERIFIED-SOURCES.md](VERIFIED-SOURCES.md).

**Ranking is opinionated.** Every company gets a 1–10 score built from expected fee (30% of first-year salary, computed from the structured comp ranges Ashby and Lever publish), how stuck their reqs are, and whether they have in-house recruiters — a company with 14 open reqs and no recruiter is a near-perfect buyer, while one with 14 reqs and six recruiters is hostile. Those two look identical in every firmographic filter, which is why the derived signal matters more than the firmographics.

**Review is keyboard-driven.** A two-pane inbox layout designed for 100–150 records/hour: `j`/`k` to move, `a` to approve and auto-advance, `e` to edit any field inline, `r` to mark reviewed. Every field shows where it came from, and disagreeing sources are flagged for you to resolve.

**Sending is paced and personal.** Drafts are generated from the real facts about each company, you edit them, and a governor sends them from your Gmail at a rate you set. Replies and bounces sync back and, when an address bounces, the app offers to draft the next decision-maker at that company.

## Screens

| Screen | What it's for |
|---|---|
| **Pipeline** | Run sources, watch progress, see spend |
| **Review** | The main surface — approve/reject/edit every record |
| **Outreach** | Drafts, the paced send queue, and replies |
| **Settings** | Gmail, keys, rate limits, ICP, templates, suppression |

Full interaction design in [UX.md](UX.md).

## Install

Requires **Node 24+** and **Bun**.

```bash
git clone https://github.com/lalalune/recruitai-claude.git && cd recruitai-claude && bun install && bun run dev
```

That starts Vite, the esbuild watcher and Electron together. First launch walks you through a four-step setup and drops you into Review with real records — **no API keys required**, because the entire discovery layer is free.

### Building binaries

```bash
bun run dist
```

Per-platform: `bun run dist:mac`, `dist:win`, `dist:linux`. Artifacts land in `release/`. Pushing a `v*` tag builds all three in CI and attaches them to a GitHub release.

**Builds are unsigned.** Code signing needs a $99/yr Apple Developer account and a Windows certificate, which is hard to justify for a single-operator tool. What that means in practice:

- **macOS** — Gatekeeper blocks the download. Clear the quarantine flag once:
  ```bash
  xattr -dr com.apple.quarantine /Applications/recruitAI.app
  ```
- **Windows** — SmartScreen shows "unrecognised app." Click *More info* → *Run anyway*.
- **Linux** — `chmod +x` the AppImage.

Building from source avoids all of this.

## Architecture

```
src/
├── main/           Electron main — the entire backend
│   ├── db/         node:sqlite, schema, migrations
│   ├── sources/    ATS adapters, YC, HN, careers-page resolution
│   ├── pipeline/   ingest, scoring, tasks, draft generation
│   ├── verify/     MX prefilter, pattern inference, verifier APIs
│   ├── gmail/      OAuth, send, inbox sync, bounce parsing
│   ├── linkedin/   optional, off by default
│   └── ipc/        one handler per RecruitApi method
├── renderer/       React 19 + Vite + Tailwind v4 + shadcn/ui
└── shared/         types, IPC contract, scoring engine
```

**`node:sqlite`, no ORM, zero native dependencies.** Node 24 ships SQLite 3.51 with WAL, FTS5, STRICT tables and JSONB compiled in. That single choice removes native addon rebuilds, ABI matching and per-platform prebuilds from the project entirely — which is what makes cross-platform packaging painless. (Bun has no `node:sqlite`, so Bun is the package manager and task runner only; the backend always runs under Node.)

Long-running work runs in the main process. `node:sqlite` is synchronous, but the sweeps are network-bound rather than CPU-bound, so awaiting HTTP yields to the event loop and the UI stays responsive; the SQLite writes themselves are sub-millisecond at this scale.

## Design rules

A few constraints are enforced in code rather than left to discipline:

**An LLM never produces a contact value.** Title normalisation, persona classification and job-description analysis are all deterministic rule tables, not model calls — cheaper, auditable, and good enough. There is exactly one model call in the codebase: rewriting the prose of an outreach draft. It is handed a facts object that structurally cannot contain an address, the `draft` table has no recipient column, and any output containing an `@`, a URL or a phone-shaped run is rejected before it is stored. The recipient is always read from the contact row, which in turn carries a foreign key to the evidence it was observed from.

**Blocks are respected.** On a 429 or 403 the relevant source backs off and stops, and tells you. There is no proxy rotation and no CAPTCHA solving. Reading public data briskly is one thing; circumventing a deliberate block is another, and it would turn an operational annoyance into a legal argument.

**Money can't run away.** Every paid API call writes a ledger row *before* the request, keyed by `UNIQUE(provider, idempotency_key)`. A retry loop physically cannot double-charge. Spend caps are checked in the same transaction.

**Nothing is destroyed.** Field edits append a new observation with source `human`; the previous value stays in history and is visible in the provenance popover. Company merges are reversible.

## Costs

Discovery, scoring, review and sending are **free**. The only necessary spend is email verification, at roughly **$12 per 10,000 addresses** (Reoon; credits don't expire, which suits a one-off run).

Verification is genuinely necessary rather than optional: 93% of target domains sit behind Google Workspace or Microsoft 365, where SMTP probing gives no reliable answer, and residential ISPs block outbound port 25 anyway. A free local prefilter (MX presence, syntax, disposable and role-account detection) runs first so you never spend a credit on an address that was never going to work.

**Run the 500-row pilot before buying credits.** The share of catch-all addresses on a list like this is genuinely unmeasured — published figures range from 8% to 30% — and it's what the verification budget scales with. Measure yours, then buy.

## LinkedIn

Off by default. The module uses a persistent Electron browser session that **you** log into — the app never handles your password — and extracts identification fields only (name, title, company, profile URL). Email addresses always come from elsewhere, so losing a session costs you a scraping run rather than your contact database.

Worth knowing before enabling it: LinkedIn shut down Proxycurl in July 2025 under a permanent injunction, and issued a cease-and-desist to HeyReach in March 2026, deleting its company page and banning the founder's personal profile. If your LinkedIn network is load-bearing for your business, consider whether this module is worth it — buying the same graph from a data vendor typically costs less than the tooling to scrape it. See [PLAN.md §7](PLAN.md).

## Legal

Not legal advice, but three things shaped the design and are worth knowing:

- **Cal. B&P §17529.5** — $1,000 per email, private right of action. *Balsam v. Trancos* makes WHOIS-private throwaway sending domains a *per se* problem. Send from a domain whose WHOIS publicly resolves to you, and name your business in the body. The default template includes a one-line opt-out for the same reason; you can turn it off in Settings.
- **CCPA/CPRA** — the B2B exemption sunset on 2023-01-01, so business contact data about California residents is fully covered personal information. California is the only state whose privacy law reaches B2B contacts. Using data solely for your own outreach is not data brokering; *selling or transmitting it to clients* is a different question.
- **Scraping** — this app reads only public, unauthenticated endpoints by default. *hiQ v. LinkedIn* ended in a $500k consent judgment against hiQ on breach of contract, so the popular "hiQ won" framing is wrong. Logged-out public scraping is defensible; logged-in scraping is not.

More detail in [PLAN.md §5](PLAN.md).

## Documentation

| Document | Contents |
|---|---|
| [PLAN.md](PLAN.md) | Research findings, cost models, legal analysis, source evaluation |
| [UX.md](UX.md) | Every screen, field, shortcut and state transition |
| [VERIFIED-SOURCES.md](VERIFIED-SOURCES.md) | Endpoints tested live, with measured yields |
| [QUESTIONS.md](QUESTIONS.md) | Scoping questions and their answers |

## License

MIT. The code is open; your data is yours and stays on your machine.
