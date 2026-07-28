# recruitAI — UX & interaction design

*Companion to [PLAN.md](PLAN.md). This document specifies every screen, pane, field, control, keyboard shortcut and state transition.*

---

## 1. Design constraints, from your answers

| Constraint | Consequence for the UI |
|---|---|
| You review **every** record, ~5,000 companies | The review loop must run at 100–150 records/hour. That means keyboard-first, near-zero mouse, no modal dialogs in the hot path. |
| Every email is **individually tailored** | Drafting is a first-class screen, not an export. Generated draft → you edit → you send. |
| **20/hour, 400/day**, personal Gmail | A paced send queue with a visible governor. The UI must make "how many left today" obvious at all times. |
| Quality score **1–10**, best first | Score is the default sort everywhere and appears on every row. |
| Sources disagree → **highlight conflicts** | Field-level provenance is a core primitive, not a debug view. |
| Screenshots as evidence | An evidence viewer, inline in the review pane. |
| Single local operator, no auth, no roles | No login, no permissions, no sharing. Deleting all of that is the biggest complexity win available. |
| Edit any sourced field | Every field is inline-editable, with the original value preserved as history. |

---

## 2. Three routes considered

### Route A — Spreadsheet
One dense table, 5,000 rows, every field a column, inline edit, filters, bulk actions. Airtable-like.

**Pros.** Immediately familiar. Maximum density. Bulk edits are trivial. One screen to build.

**Cons.** The evidence you need to judge a record — job description text, screenshots, three conflicting source values, two or three contacts — does not fit in a cell. You would be opening a drawer for nearly every row, which is the two-pane layout with extra steps. Email drafting has no home at all. Horizontal scroll across 25 columns at 5,000 rows is miserable, and it quietly encourages mouse-driven work, which caps you around 40 records/hour.

### Route B — Kanban pipeline
Columns as stages (Discovered → Enriched → Verified → Reviewed → Queued → Sent → Replied), drag cards between them.

**Pros.** Pipeline state is visible at a glance. Satisfying.

**Cons.** Wrong at this scale and wrong in principle. Dragging 5,000 cards is absurd, and the stage transitions here are *machine-driven* — the pipeline moves records, not you. Kanban's core gesture implies human agency that doesn't exist in this workflow. It also spends enormous screen area per record to show three fields. **Rejected outright.**

### Route C — Inbox / two-pane ✅ **CHOSEN**
Left: ranked virtualized list. Right: focus pane with full evidence, inline editing, and actions. Keyboard-driven. Think Superhuman or Linear rather than a dashboard.

**Pros.** It matches the actual loop — look at one record, decide, advance. Evidence gets real space. Keyboard-first genuinely reaches the throughput target. Most importantly: **the same two-pane primitive composes every screen in the app.** Review, Outreach and Replies are the same component with different content, which is the single largest reduction in code and in things you have to learn.

**Cons.** Weaker for bulk edits than a spreadsheet. Mitigated by multi-select plus a contextual bulk action bar — enough for the real bulk cases (reject a batch, re-run verification, suppress a domain).

**Decision: Route C.** The deciding factor is component reuse. One list, one detail pane, one action bar, one field primitive — used four times instead of four bespoke screens.

---

## 3. Information architecture

Four screens. That's the whole app.

```
┌──────────┬────────────────────────────────────────────────┐
│          │                                                │
│ Pipeline │   run sources, watch progress, see spend        │
│ Review   │   ← the main surface, ~90% of your time         │
│ Outreach │   drafts │ queue │ replies                      │
│ Settings │   keys, limits, ICP, templates, suppression     │
│          │                                                │
├──────────┴────────────────────────────────────────────────┤
│ status bar: 1,204 reviewed · 47/400 today · 3/20 this hour │
└───────────────────────────────────────────────────────────┘
```

First run shows a **Setup** overlay that writes into Settings, then never appears again.

---

## 4. Shared component inventory

Eighteen primitives compose every screen. Build these once.

| # | Component | Used by | Notes |
|---|---|---|---|
| 1 | `AppShell` | all | Sidebar + status bar + toast host |
| 2 | `SplitView` | Review, Outreach ×3 | Resizable, persists width. **The core primitive.** |
| 3 | `RankedList` | Review, Outreach ×3 | Virtualized, keyboard nav, multi-select |
| 4 | `ListRow` | RankedList | Score · title · subtitle · chips |
| 5 | `DetailPane` | Review, Outreach | Scroll container with section anchors |
| 6 | `Section` | DetailPane | Titled, collapsible, remembers state |
| 7 | `Field` | everywhere | **Label + value + inline edit + provenance.** The key data primitive. |
| 8 | `ProvenanceBadge` | Field | Source + date + confidence; click opens evidence |
| 9 | `EvidenceViewer` | Field, Section | Screenshot / raw JSON / source URL / extracted text |
| 10 | `ConflictPicker` | Field | Shown when sources disagree; radio list of candidate values |
| 11 | `ScoreBadge` | ListRow, DetailPane | 1–10, colour-ramped, hover shows breakdown |
| 12 | `StatusChip` | ListRow, DetailPane | Pipeline state, verification verdict, send state |
| 13 | `ActionBar` | all | Contextual buttons with inline keyboard hints |
| 14 | `CommandPalette` | global | `cmd+k` — every action reachable |
| 15 | `ConfirmDialog` | destructive only | Used sparingly; never in the review hot path |
| 16 | `ProgressPanel` | Pipeline | Per-source progress, counts, live log tail |
| 17 | `EmailComposer` | Outreach | Subject + body + variable chips + preview |
| 18 | `EmptyState` | all | Icon + one line + primary action |

**Rule: no screen introduces a new primitive without deleting one.**

---

## 5. Screen: Review

The main surface. Everything else is support.

### 5.1 Layout

```
┌─ filters ──────────────────┬─ Ramp ─────────────── [9] ──┐
│ [All][Unreviewed][Conflicts]│  ramp.com · 850 people      │
│ [Approved][Rejected]        │  ┌ WHY THIS COMPANY ──────┐ │
│ 🔍 search…                  │  │ 14 open eng reqs       │ │
├────────────────────────────┤  │ 3 open >45 days        │ │
│ [9] Ramp          14 reqs ●│  │ No in-house recruiter  │ │
│ [9] Sierra AI      8 reqs ●│  │ Series D, 4mo ago      │ │
│ [8] Decagon        6 reqs  │  └────────────────────────┘ │
│ [8] Baseten       11 reqs ⚠│  ┌ COMPANY ───────────────┐ │
│ [7] Modal          4 reqs  │  │ Domain    ramp.com  ⓘ  │ │
│ …4,995 more                │  │ Headcount 850       ⚠  │ │
│                            │  │ Industry  Fintech   ⓘ  │ │
│                            │  └────────────────────────┘ │
│                            │  ┌ OPEN REQS (14) ────────┐ │
│                            │  ┌ DECISION MAKERS (2) ───┐ │
│                            │  ┌ EVIDENCE ──────────────┐ │
├────────────────────────────┴─────────────────────────────┤
│ [a] Approve  [x] Reject  [r] Reviewed  [c] Compose  [?]  │
└──────────────────────────────────────────────────────────┘
```

### 5.2 Left list

**Filter chips** (single-select, `1`–`5` to switch): All · Unreviewed · Conflicts · Approved · Rejected.
A second row of toggle chips (multi-select): Has verified email · No in-house TA · Reqs >45 days · Recently funded.

**Search** (`/` to focus): matches company name, domain, contact name, req title. Debounced 150 ms, FTS5-backed.

**Sort** (`s` cycles): Quality score ↓ *(default)* · Open reqs ↓ · Days open ↓ · Recently discovered · Name A–Z.

**Row anatomy:** `[score] CompanyName · headcount · N reqs · [chips]`
Chips: `●` unreviewed, `⚠` has conflict, `✉` email verified, `⛔` suppressed, `↩` replied.

**Interactions:** `j`/`k` or ↑/↓ move; click selects; `shift+click` range-selects; `cmd+click` toggles; `space` peeks without advancing. Selection persists across filter changes. Multi-select reveals a bulk `ActionBar`: Approve all · Reject all · Re-verify · Suppress domain · Export CSV.

### 5.3 Right pane sections

**① Header** — company name (editable), domain (link), `ScoreBadge` (hover → weight breakdown), and status chips. Buttons: Approve · Reject · Reviewed ☑.

**② Why this company** — the score explanation in plain language, generated from the score components. This is what makes the record judgeable in two seconds:
> 14 open engineering reqs · 3 open >45 days · **no in-house recruiter** · Series D 4 months ago · ATS: Ashby

**③ Company** — `Field` rows: Domain, Headcount, Industry, HQ location, Funding stage, Last round date, ATS platform, Careers URL, LinkedIn URL. Each shows a `ProvenanceBadge`; each is inline-editable; conflicts render a `ConflictPicker`.

**④ Open requisitions** *(collapsible, count in header)* — per req: title, department, location, **days open**, repost count, comp band, and a `⌄` to expand the full job description. Flags: `no-agency` (JD contains an unsolicited-resume disclaimer — record auto-deprioritised), `named-contact` (JD names a recruiter or hiring manager — free contact with perfect provenance).

**⑤ Decision makers** *(the part that matters)* — per contact: name, title, seniority/persona, email + verification verdict chip, phone, LinkedIn URL, and a `★` to mark primary. All inline-editable. Buttons: Add contact · Find more · Re-verify.
Verification chips: `valid` green · `catch-all` amber · `unknown` grey · `invalid` red · `unverified` outline.

**⑥ Evidence** — thumbnails of captured screenshots, source URLs with fetch timestamps, and a raw-JSON viewer per source. Click any thumbnail for a lightbox.

**⑦ Notes & history** — free-text notes, plus an append-only audit trail (`headcount 400 → 850, edited by you, 2026-07-28`).

### 5.4 Keyboard map

| Key | Action |
|---|---|
| `j` / `k` | Next / previous record |
| `space` | Peek (preview without advancing) |
| `e` | Edit focused field |
| `tab` / `shift+tab` | Next / previous field |
| `enter` | Commit edit · `esc` cancel |
| `a` | Approve **and advance** |
| `x` | Reject and advance |
| `r` | Toggle reviewed |
| `c` | Compose email for this company |
| `f` | Find more contacts |
| `v` | Re-verify emails |
| `g` | Open evidence lightbox |
| `1`–`5` | Switch filter |
| `s` | Cycle sort |
| `/` | Focus search |
| `cmd+k` | Command palette |
| `cmd+z` | Undo last action (10-deep) |
| `?` | Shortcut overlay |

**Approve advances automatically.** That single behaviour is most of the throughput difference — no return trip to the list.

---

## 6. Screen: Outreach

Three tabs, all reusing `SplitView`.

### 6.1 Drafts

Left: approved companies with a generated draft, ranked by score.
Right: `EmailComposer`.

- **To** — primary contact, with a dropdown to switch to another decision-maker at the company. Shows the verification chip beside the address.
- **Subject** — editable single line.
- **Body** — editable rich text. Generated variables render as subtle chips (`{{first_name}}`, `{{req_title}}`, `{{days_open}}`) and resolve live in the preview.
- **Preview toggle** — rendered exactly as it will send.
- **Regenerate** — re-runs generation; a variant selector keeps the previous draft so you can compare.

Actions: `⌘↵` Queue for sending · `s` Skip · `x` Reject · `n` Next.

**Generation happens in the background** as soon as a company is approved, so drafts are waiting when you arrive rather than spinning.

### 6.2 Queue

The paced sender. This screen is mostly a governor readout.

- **Header:** `47 / 400 today · 3 / 20 this hour · next send in 2m 14s`
- **Controls:** ▶ Start · ⏸ Pause · ⏭ Send next now
- **List:** ordered queue with scheduled send time per item; drag to reorder; `x` removes.
- **Settings inline:** sends per hour (default 20), sends per day (default 400), active window (default 9am–5pm local), jitter (default ±40%), weekend sending (default off).

Sends fire on a jittered timer inside the active window. Closing the app pauses the queue; reopening resumes without double-sending (each send is guarded by a unique idempotency key).

### 6.3 Replies

Left: inbound messages matched to companies, newest first, with type chips: `reply` · `bounce` · `auto-reply` · `unmatched`.
Right: the message thread plus the company card.

Actions: `p` Mark positive → prompts to create a follow-up task · `n` Mark negative → suppresses the domain · `b` Confirm bounce → marks the address invalid and, if another decision-maker exists at that company, **offers to draft the next one** · `o` Open in Gmail.

This closes the loop you asked for: a bounce or a no becomes the trigger to advance to the next contact at the same company.

---

## 7. Screen: Pipeline

One card per source. Each card: name, enabled toggle, last run time, records found, [Run] button, and a progress bar while running.

**Sources:** YC directory · ATS sweep (Greenhouse, Ashby, Lever, SmartRecruiters, Workable, Workday) · Careers-page crawler · HN Who's Hiring · SEC Form D · LinkedIn *(off by default)* · Email discovery · Email verification · Scoring · Draft generation.

**Global controls:** ▶ Run all · ⏹ Stop · a live log tail (last 200 lines, filterable by source) · a spend counter showing per-source and total cost.

**Rules:**
- Discovery sources are free and run unattended.
- Paid steps (verification) show an estimated cost and require one confirmation before starting.
- A hard spend cap in Settings stops everything when reached.
- Every run is idempotent and resumable — stopping mid-run and restarting never re-charges or duplicates.

---

## 8. Screen: Settings

Single scrolling page, sectioned. No tabs.

**Gmail** — connect / disconnect, connected address, token status, test-send button.
**API keys** — verification provider key, LLM key. Masked, with a test button each.
**Rate limits** — sends/hour, sends/day, active window, jitter, crawl concurrency, LinkedIn profiles/day.
**ICP** — headcount min/max (default 3–1000), geography (Bay Area counties, multi-select), included industries, **excluded keywords**, minimum open reqs, exclude companies with in-house TA above N recruiters.
**Templates** — email templates per company-size band (<20, 20–75, 75–300, 300+), each with variable autocomplete and a live preview.
**Suppression** — table of suppressed domains and addresses with typed reasons (existing client · competitor · no-agency policy · replied no · bounced · manual). Import CSV, add manually.
**Data** — data folder path, DB size, [Backup now], [Export CSV], [Open data folder].

---

## 9. Setup (first run only)

Four steps, skippable, resumable. Reuses Settings components.

1. **Welcome** — where data will live; confirm folder.
2. **Connect Gmail** — OAuth in a browser window; test send to yourself.
3. **Your ICP** — headcount range, geography, exclusions. Pre-filled with sensible defaults so `Next` works.
4. **First run** — "Fetch YC + ATS sources now?" → runs the free discovery pass and drops you into Review with real records.

Goal: **from launch to first reviewable record in under five minutes, with zero API keys required** — because the entire discovery layer is free.

---

## 10. Cross-cutting behaviour

**Editing.** Every `Field` is inline-editable. Committing writes a new `field_observations` row with source `human` and never destroys the prior value. The provenance popover shows full history. `cmd+z` undoes.

**Conflicts.** When two sources disagree, the field renders amber with a `⚠`. Clicking opens a `ConflictPicker` listing each candidate with its source, date and confidence. Picking one records your choice as a human observation. The `Conflicts` filter collects every such record.

**Optimistic updates.** Approve/reject/reviewed apply instantly and reconcile in the background. On failure, a toast offers retry. The list never blocks on the network — the API is on localhost, but correctness shouldn't depend on that.

**Undo.** A 10-deep undo stack covering approve, reject, field edits and suppression. Toast confirms with an inline Undo.

**Empty and error states.** Every list has an `EmptyState` with one clear action. Source failures surface as a dismissible banner on Pipeline, never a modal.

**Theme.** Dark by default, light available, follows OS. One accent colour. Score ramp is the only other colour scale, and it's colour-blind safe (viridis-like, not red-green).

---

## 11. What is deliberately excluded

Naming these matters as much as the feature list — each one is complexity that would earn nothing here.

- **No login, users, roles or SSO.** Single local operator.
- **No drag-and-drop pipeline.** Stage transitions are machine-driven.
- **No charts or analytics dashboard.** The status bar carries the three numbers that matter.
- **No bulk email editor.** Every email is individually reviewed — that's the point.
- **No mobile layout.** Desktop tool; minimum window 1024×700.
- **No real-time collaboration, comments or mentions.**
- **No in-app browser for LinkedIn.** It opens a real, visible browser window you control.
- **No unsubscribe-link management.** Low-volume personal outreach. *(One note: a plain "reply and I'll stop" line in the template body costs nothing and materially reduces both complaint risk and Cal. B&P §17529.5 exposure — see PLAN.md §5. Recommended as template default; you can delete it.)*

---

## 12. Throughput sanity check

The design targets **~2,400 reviewed records/day** at a sustained 150/hour over 16 working hours — but that's the ceiling, not the plan. Realistically:

| Phase | Volume | Time |
|---|---|---|
| Discovery (unattended) | 5,000 companies | ~2–4 hours of machine time |
| Review at 120/hr | 5,000 companies | ~42 hours ≈ 5–6 working days |
| Drafting + sending at 400/day | ~5,000 emails | ~13 days |

The review pass is the bottleneck, which is exactly why the keyboard loop is the highest-leverage thing in this document. **Every interaction in the hot path (`j`, `a`, `x`, `r`) is one keystroke, and approve auto-advances.**
