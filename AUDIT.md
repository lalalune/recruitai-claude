# AUDIT.md — the prompt for auditing, smoketesting, and bugfixing this repo to "working flawlessly"

This file is an operational prompt. Hand it verbatim to an engineering agent (or
a disciplined human) when the instruction is some variant of *"clean this up,
audit it, smoketest it, fix every bug, make sure it actually works."* It is the
distillation of three full audit rounds of this codebase (2026-07-28/29) that
found and fixed ~120 verified defects in a repo whose typecheck and test suite
were green the whole time. Green CI is where this process starts, not where it
ends.

---

## The prompt

You are auditing **recruitAI**, a local-first Electron desktop app that finds
Bay Area startups that are hiring, identifies decision-makers, verifies their
addresses, and paces individually-reviewed outreach from the operator's own
Gmail. Architecture: Electron 43 main process (esbuild-bundled CJS, `node:sqlite`,
no ORM), Vite/React 19 renderer, a zod-validated IPC boundary, and a shared
`src/shared/` contract layer. Bun is the task runner; **Node runs everything**
(tests are `node:test` over esbuild bundles — see `scripts/run-tests.mjs`).

Your goal is not "find some bugs." It is: **every feature reachable, every
barrier enforced, every claim in code comments and docs true, every
high-consequence path directly tested, and live smoketests passing against
real endpoints** — with evidence for each. Work until you can produce the
Definition of Flawless table at the bottom with every row green, or a written
justification for any exception.

### Phase 0 — Baseline and map (never skip)

1. Read the project memory/docs first: `PLAN.md`, `UX.md`, `VERIFIED-SOURCES.md`,
   `QUESTIONS.md`, `README.md`, and this file. UX.md is a *spec* — every claim
   in it is an assertion to verify against the code, in both directions.
2. Record the baseline before touching anything:
   ```
   bun run typecheck
   bun run test          # note exact counts: total / pass / fail / skipped
   bun run build
   ```
   If the baseline is red, fix nothing else until you understand why — a red
   baseline invalidates every later "my change broke it" judgment.
3. Map the surface: list every IPC channel (`src/shared/schemas.ts`), every
   pipeline source (`src/main/pipeline/run.ts` SOURCES), every screen and
   hotkey (UX.md), every background timer (drainer, sender tick, auto-sync),
   and every external endpoint (VERIFIED-SOURCES.md).

### Phase 1 — Adversarial audit (fan out, verify, then believe)

Run parallel *report-only* reviewers over disjoint scopes. Each reviewer must
read every file in scope completely, and every finding must carry
**severity, file:line, a quoted snippet, why it is wrong, and a concrete
failure scenario**. Findings without a reproducible scenario are hypotheses,
not findings. Re-verify each one yourself against current code before fixing —
reviewers are wrong sometimes, and the tree may have moved.

Scope split that works for this repo: (1) main-process core (db/ipc/preload/
settings/index), (2) pipeline+sources+verify+http, (3) gmail+linkedin,
(4) renderer+shared, (5) tests+scripts+configs+docs. On later passes, focus the
fan-out on **the diff since the last audit** — new code carries the new bugs,
and fixes breed their own (three of our worst round-2 bugs were inside round-1
fixes).

Hunt these classes explicitly — every one of them has actually shipped here:

1. **Dead safety layers.** A module can be complete, unit-tested, and imported
   by nothing but its own tests. Grep who imports every boundary/bridge module
   in *production* code, then write a runtime probe (e.g. every IPC channel
   must reject an over-arity call; see `tests/e2e/ipc-contract.test.ts`).
   Shipped examples: the entire zod guard, the renderer event bridge,
   `setGmailEventSink`, `measuredPatternAccuracy`.
2. **Dual enforcement drift.** One rule, two enforcement points, guaranteed
   divergence: hand-rolled key lists vs schemas, UI caps vs schema caps vs
   read-clamps, two field resolvers, two primary electors, two opt-out lines.
   Collapse to one source of truth and add a test that parses both sides.
3. **Contradictory policies.** For every state machine, name the path *back*
   for each path in. Shipped: suppressed status with no un-suppress path; a
   freshness window that queues re-verification the idempotency ledger then
   refuses forever (fabricating verdicts).
4. **Inert safety tables.** Case mismatches (lowercased values vs uppercase
   ULIDs), identity mismatches (UI collects a *name*, backend matches an *id*),
   and gates that skip a kind entirely. Test every identity at every barrier —
   `tests/e2e/suppression.test.ts` is the pattern.
5. **Absence-as-signal corruption.** In a differ, missing data closes records.
   A *partial* fetch (pagination broke) must never reach a differ; a 404 is an
   outage until it repeats. Shipped: partial SmartRecruiters boards mass-closing
   live reqs, then minting fake "reposted" claims destined for outreach copy.
6. **Await-window races.** Every `read → await → write` in the main process is
   a candidate: pause flags checked once then awaited past; select-then-claim
   without a state-guarded UPDATE; force keys interleaving. The fix pattern is
   claim-before-await plus `WHERE state = ?` conditional updates with a
   `changes` check — and a test that runs two callers concurrently against a
   deferred fake (see `tests/e2e/sendpath.test.ts`).
7. **Ledger arithmetic vs deletion.** Count-based idempotency suffixes are
   wrong wherever rows can be deleted (released reservations) — use
   max-suffix+1. LIKE patterns over keys need `ESCAPE` when values can carry
   `_`/`%` (email local parts do).
8. **Liveness of resumable scans.** Any capped, restart-from-top pagination
   must cap on *fresh* work, not listed work, or a backlog larger than one cap
   stalls forever while looking healthy. Test the SECOND pass, not just the
   first.
9. **Opaque-origin URL checks.** Node's `URL` gives every custom scheme
   (`app://`, `file://`, `data:`) origin `'null'` — an origin equality check
   in the main process silently allows them all. For an SPA, deny-by-default
   top-frame navigation; compare real origins only for http(s).
10. **Benign business states in retry machinery.** A deterministic refusal
    (`DraftNotPossible`) must be a recorded skip, not five retries into
    dead-letter noise. Distinguish transient vs deterministic at the throw
    site with typed errors, and match on the class, never the message.
11. **Destructive scripts on shared env vars.** Any script that deletes a
    directory must own a dedicated env var and refuse to delete a directory it
    did not create (marker file). `scripts/smoke.ts` once rm-rf'd the
    operator's real data dir.
12. **Docs as fiction.** Every command in every doc must run verbatim; every
    env var documented must be read by code; every feature claim must point at
    reachable code. Fix the doc or the code, never leave the lie.
13. **Undo scoped to what the action created.** An undo that matches by value
    can delete pre-existing rows (including a recipient's opt-out). Snapshot →
    act → diff → undo only the diff, and await the undo before telling the
    operator "Undone".

### Phase 2 — Fix protocol

- Verify each finding against the current tree, then fix it at the *root*
  (the single source of truth), not at the symptom.
- One writer per file: if you parallelize fixes across agents, give each a
  disjoint file list and forbid edits outside it; integrate cross-file needs
  yourself. Two agents building against different assumptions of the same seam
  is a documented source of shipped blank-window bugs here.
- Every fix that closes a behavioral bug gets a regression test that fails on
  the pre-fix code. If you cannot write that test, say so and why.
- Every schema change is a delta in `MIGRATIONS` (`src/main/db/index.ts`);
  `schema.sql` stays the v1 baseline. Prove both the fresh path and the
  upgrade path in a test (see `tests/e2e/followups.test.ts`).
- New IPC channels update all mirrors in one commit: `src/shared/ipc.ts`,
  `src/shared/schemas.ts`, `src/main/preload.ts`, `CHANNELS` in
  `src/main/ipc/index.ts`, the handler, and `EXPECTED_CHANNELS` in
  `tests/unit/schemas.test.ts`. The contract tests will catch you if you miss
  one — run them.
- Anything unreachable gets removed (git history keeps it) or *wired to a real
  consumer*, never left floating. Leave a comment at the removal site saying
  why, so it does not get "helpfully" re-added.

### Phase 3 — Test protocol (what "tested" means here)

- **The money path gets direct tests.** Anything that sends email, spends an
  API credit, or mutates the suppression table is tested through its real
  code path against an injectable fake at the network seam — the codebase has
  two precedents to copy: `clientFactory` on `syncInbox` and `SendGateway` on
  `sendOne`. New seams get their e2e the same day they are created.
- **Tests must be able to fail.** No mocking the thing under test; no
  asserting the inline copy of production SQL (drive the real function); no
  pinning tuning constants (assert "a flush happened mid-run", not
  "exactly 25 rows"); no wall-clock decay (derive test dates from one frozen
  NOW); second-order paths (pass two of a resumable scan, re-verification
  after staleness, undo after a concurrent change) are where the wedges live.
- **Boot for real.** `bun run test:boot` launches actual Electron with the
  real preload, the real migrations, and probes `window.api` over live IPC —
  including a garbage call that must be rejected *by the validator, with a
  validation message*, not by a downstream crash. Keep it green on every
  platform CI runs.
- Whole-repo typecheck includes `tests/` and `scripts/` (`tsconfig.json`
  `include`) — do not narrow it back.

### Phase 4 — Smoketest against reality

Unit green is necessary, not sufficient. Run, in order, and paste the output
as evidence:

```
bun run typecheck
bun run test                       # expect 0 fail; exactly 1 gated skip
bun run build
bun run test:boot                  # real Electron boot e2e
bun run test:loop                  # PRIMARY LOOP: seeded DB, real keystrokes (j/k/a), approval → drainer → draft
RECRUITAI_NET=1 bun run test "parses a real Greenhouse"   # live API
bun run smoke                      # live YC directory → live ATS probes → scored reqs
```

`bun run smoke` uses `RECRUITAI_SMOKE_DATA` (never `RECRUITAI_DATA`) and owns
its directory via a marker file — keep it that way. If a live endpoint drifted,
update `VERIFIED-SOURCES.md` with the measured reality, then fix the adapter.

The primary-loop drive is automated: `bun run test:loop` seeds a fresh
database, boots the real app, and sends real keystrokes through Chromium's
input pipeline — j/k must move the selection, `a` must approve (verified in
the database from a second WAL connection), and the approval must flow
through the task queue into a drainer-generated draft visible over live IPC.
A feature that demos is a different thing from a feature that compiles; this
harness is the demo, headless. For anything the harness doesn't cover, launch
`bun run dev` and drive it by hand.

### Phase 5 — Close the loop

- Reconcile the docs: UX.md and README must describe the app that now exists,
  including defaults and caps (sending 20/hr, 150/day default, 500 hard cap;
  jitter ≤90; the send-time compliance footer; the two-bump follow-up ceiling).
- Update the project memory (defect-classes file) with any *new* failure class
  this pass discovered — the classes list above should grow, not reset.
- Produce the final report: what was found (by severity), what was fixed, what
  was added/removed, and the evidence table. Numbers, not adjectives.

### Definition of Flawless (the exit gate)

| Gate | Requirement |
|---|---|
| Typecheck | Whole repo (src + tests + scripts), zero errors |
| Suite | Zero failures; the only skip is the `RECRUITAI_NET` gate |
| Boot e2e | Passes: DOM mounts, api surface complete, validator rejects garbage with a validation message, zero console errors |
| Loop e2e | Passes: real keystrokes move/approve; approval → task queue → drainer → draft, DB-verified |
| Live API | Gated Greenhouse test passes against the real endpoint |
| Live smoke | Real YC → real boards → scored reqs, end to end |
| Reachability | Every exported production symbol has a caller or a removal justification |
| Contracts | ipc-contract + schemas tests prove all channel mirrors agree; no raw `ipcMain.handle` outside the guard |
| Barriers | Suppression suite proves every identity blocks at every barrier, including the last gate before Gmail |
| Docs | Every documented command runs verbatim; every documented var is read by code |
| CI | Matrix green on macOS, Linux (xvfb boot), Windows |

Do not report "done" while any row is red. Do not weaken a gate to make it
pass. When a gate is impossible (e.g. no network), say exactly which row is
unproven and why.
