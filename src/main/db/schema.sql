-- recruitAI schema. Applied by migrate.ts when PRAGMA user_version < 1.
--
-- Conventions:
--   * TEXT ULID ids for user-facing entities (time-sortable, stable across export).
--   * INTEGER PRIMARY KEY for high-volume append-only tables (rowid alias — measured
--     ~3.6x smaller and 2x faster than a TEXT composite key at millions of rows).
--   * Unix epoch MILLISECONDS as INTEGER for all timestamps.
--   * STRICT on every table we control, so a type error fails loudly at write time.

-- ─────────────────────────────────────────────────────────────────────────────
-- Companies
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE company (
  id                TEXT PRIMARY KEY,
  domain            TEXT UNIQUE,            -- eTLD+1. Primary natural key.
  canonical_id      TEXT REFERENCES company(id),  -- non-null => merged away
  name              TEXT NOT NULL,
  name_norm         TEXT NOT NULL,          -- legal suffixes stripped, lowercased

  headcount         INTEGER,
  industry          TEXT,
  hq_location       TEXT,
  in_bay_area       INTEGER NOT NULL DEFAULT 0,
  funding_stage     TEXT,
  last_round_at     INTEGER,
  yc_batch          TEXT,

  ats_platform      TEXT,
  ats_token         TEXT,
  careers_url       TEXT,
  linkedin_url      TEXT,
  website           TEXT,

  -- Derived signals. Recomputed by the scoring job; never hand-edited.
  open_req_count    INTEGER NOT NULL DEFAULT 0,
  open_req_eng_count INTEGER NOT NULL DEFAULT 0,
  max_days_open     INTEGER,
  stale_req_count   INTEGER NOT NULL DEFAULT 0,
  recruiter_count   INTEGER,
  has_inhouse_ta    INTEGER,                -- 0/1/NULL(unknown)
  no_agency_policy  INTEGER NOT NULL DEFAULT 0,
  estimated_fee_usd INTEGER,

  quality_score     INTEGER,                -- 1-10, what the operator sorts by
  score_raw         INTEGER,                -- 0-100 internal
  score_breakdown   TEXT,                   -- JSON: ScoreComponent[]
  score_headline    TEXT,                   -- "14 open roles · 3 open >45d · no in-house recruiter"
  disqualified      TEXT,                   -- non-null => excluded from outreach

  status            TEXT NOT NULL DEFAULT 'discovered'
                      CHECK (status IN ('discovered','enriched','scored','approved','rejected','suppressed')),
  reviewed          INTEGER NOT NULL DEFAULT 0,
  reviewed_at       INTEGER,
  notes             TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000)
) STRICT;

CREATE INDEX company_score    ON company(quality_score DESC, open_req_count DESC) WHERE canonical_id IS NULL;
CREATE INDEX company_status   ON company(status, reviewed);
CREATE INDEX company_name     ON company(name_norm);
CREATE INDEX company_ats      ON company(ats_platform, ats_token);

-- ─────────────────────────────────────────────────────────────────────────────
-- Requisitions — the atomic unit of the sale. You don't pitch a company,
-- you pitch against a specific stuck req.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE req (
  id                INTEGER PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  external_id       TEXT NOT NULL,
  source            TEXT NOT NULL,
  title             TEXT NOT NULL,
  department        TEXT,
  team              TEXT,
  location          TEXT,
  is_remote         INTEGER,
  employment_type   TEXT,
  comp_min          INTEGER,
  comp_max          INTEGER,
  estimated_fee_usd INTEGER,
  description       TEXT,
  url               TEXT NOT NULL,

  first_seen_at     INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000),
  last_seen_at      INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000),
  published_at      INTEGER,
  closed_at         INTEGER,
  days_open         INTEGER,
  repost_count      INTEGER NOT NULL DEFAULT 0,

  -- Deterministically classified from description. Never produces contact values.
  function_family   TEXT,
  seniority         TEXT,
  no_agency_disclaimer INTEGER,
  named_contact     TEXT,

  UNIQUE (company_id, external_id, source)
) STRICT;

CREATE INDEX req_company ON req(company_id, closed_at);
CREATE INDEX req_open    ON req(closed_at, days_open DESC);

-- Daily snapshot. How repost_count and true days_open are derived: a req that
-- disappears and returns was a failed search, which is the strongest pitch there is.
CREATE TABLE req_daily (
  req_id    INTEGER NOT NULL REFERENCES req(id) ON DELETE CASCADE,
  day       INTEGER NOT NULL,               -- days since epoch
  present   INTEGER NOT NULL,
  PRIMARY KEY (req_id, day)
) STRICT, WITHOUT ROWID;

-- ─────────────────────────────────────────────────────────────────────────────
-- Contacts
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE contact (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  first_name        TEXT,
  last_name         TEXT,
  full_name         TEXT NOT NULL,
  title             TEXT,
  persona           TEXT,
  seniority         TEXT,

  email             TEXT,
  email_source      TEXT,
  email_verdict     TEXT NOT NULL DEFAULT 'unverified'
                      CHECK (email_verdict IN ('valid','invalid','catch_all','unknown','role','disposable','unverified')),
  email_verified_at INTEGER,
  email_pattern     TEXT,                   -- which pattern produced it, if inferred
  phone             TEXT,
  linkedin_url      TEXT,

  is_primary        INTEGER NOT NULL DEFAULT 0,
  contact_score     INTEGER,
  status            TEXT NOT NULL DEFAULT 'candidate'
                      CHECK (status IN ('candidate','approved','rejected','contacted','replied','bounced')),
  reviewed          INTEGER NOT NULL DEFAULT 0,
  notes             TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000)
) STRICT;

CREATE INDEX contact_company ON contact(company_id, contact_score DESC);
CREATE UNIQUE INDEX contact_email ON contact(email) WHERE email IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Provenance. Append-only observations, resolved into a small winners table.
-- Every contact value in the app traces to a row here with an evidence FK.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE field_observation (
  id          INTEGER PRIMARY KEY,
  entity      TEXT NOT NULL CHECK (entity IN ('company','contact','req')),
  entity_id   TEXT NOT NULL,
  field       TEXT NOT NULL,
  value       TEXT,
  source      TEXT NOT NULL,
  evidence_id INTEGER REFERENCES raw_response(id),
  confidence  TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
  observed_at INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000)
) STRICT;

CREATE INDEX fo_entity ON field_observation(entity, entity_id, field, observed_at DESC);

-- Winner per (entity, id, field). Resolved at write time — the UI reads this
-- with one b-tree seek instead of a window function over history.
CREATE TABLE field_resolved (
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  field       TEXT NOT NULL,
  value       TEXT,
  source      TEXT NOT NULL,
  confidence  TEXT NOT NULL,
  obs_id      INTEGER NOT NULL REFERENCES field_observation(id),
  conflicting INTEGER NOT NULL DEFAULT 0,   -- 1 => sources disagree, surface in UI
  resolved_at INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000),
  PRIMARY KEY (entity, entity_id, field)
) STRICT, WITHOUT ROWID;

CREATE INDEX fr_conflicts ON field_resolved(conflicting) WHERE conflicting = 1;

-- ─────────────────────────────────────────────────────────────────────────────
-- Evidence: raw responses (gzipped, deduped by hash) and screenshots (on disk)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE raw_response (
  id              INTEGER PRIMARY KEY,
  sha256          TEXT NOT NULL UNIQUE,     -- of the UNCOMPRESSED body
  source          TEXT NOT NULL,
  url             TEXT,
  status_code     INTEGER,
  encoding        TEXT NOT NULL DEFAULT 'gzip',
  body            BLOB,
  bytes_raw       INTEGER NOT NULL DEFAULT 0,
  bytes_stored    INTEGER NOT NULL DEFAULT 0,
  cost_usd_micros INTEGER NOT NULL DEFAULT 0,
  fetched_at      INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000)
) STRICT;

CREATE INDEX raw_source ON raw_response(source, fetched_at DESC);

CREATE TABLE screenshot (
  id          TEXT PRIMARY KEY,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  rel_path    TEXT NOT NULL UNIQUE,         -- relative to <dataDir>/blobs
  sha256      TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  width       INTEGER,
  height      INTEGER,
  url         TEXT,
  captured_at INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000)
) STRICT;

CREATE INDEX shot_entity ON screenshot(entity, entity_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Outreach
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE draft (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  contact_id   TEXT NOT NULL REFERENCES contact(id) ON DELETE CASCADE,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  -- Which reqs the copy references. Lets us regenerate if the req closes.
  req_ids      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(req_ids)),
  template     TEXT,
  generated_by TEXT,
  edited       INTEGER NOT NULL DEFAULT 0,
  state        TEXT NOT NULL DEFAULT 'draft'
                 CHECK (state IN ('draft','queued','sending','sent','failed','skipped')),
  scheduled_at INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000)
) STRICT;

CREATE INDEX draft_state ON draft(state, scheduled_at);
CREATE UNIQUE INDEX draft_contact ON draft(contact_id) WHERE state != 'skipped';

CREATE TABLE send (
  id             TEXT PRIMARY KEY,          -- also the X-RecruitAI-Send-Id header
  draft_id       TEXT NOT NULL REFERENCES draft(id),
  company_id     TEXT NOT NULL REFERENCES company(id),
  contact_id     TEXT NOT NULL REFERENCES contact(id),
  to_email       TEXT NOT NULL,
  subject        TEXT NOT NULL,
  body           TEXT NOT NULL,
  gmail_id       TEXT,
  gmail_thread_id TEXT,
  message_id     TEXT,                      -- RFC 5322, read back after send
  sent_at        INTEGER,
  -- 'silent' is the expected majority: most non-delivery produces no DSN at all.
  outcome        TEXT NOT NULL DEFAULT 'pending'
                   CHECK (outcome IN ('pending','sent','bounced','replied','silent','failed')),
  outcome_at     INTEGER,
  error          TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000)
) STRICT;

CREATE INDEX send_thread  ON send(gmail_thread_id);
CREATE INDEX send_outcome ON send(outcome, sent_at DESC);
CREATE INDEX send_day     ON send(sent_at);

CREATE TABLE inbound (
  id           TEXT PRIMARY KEY,
  gmail_id     TEXT NOT NULL UNIQUE,
  thread_id    TEXT,
  send_id      TEXT REFERENCES send(id),
  from_email   TEXT,
  subject      TEXT,
  snippet      TEXT,
  kind         TEXT NOT NULL DEFAULT 'unmatched'
                 CHECK (kind IN ('reply','bounce','auto_reply','unmatched')),
  bounce_recipient TEXT,
  bounce_status TEXT,                       -- e.g. '5.1.1'
  handled      INTEGER NOT NULL DEFAULT 0,
  received_at  INTEGER NOT NULL,
  raw_id       INTEGER REFERENCES raw_response(id)
) STRICT;

CREATE INDEX inbound_handled ON inbound(handled, received_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Suppression. The send path is physically unable to emit to anything here.
-- Reasons are typed because "why didn't we email them" gets asked constantly.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE suppression (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('domain','email','company')),
  value      TEXT NOT NULL,
  reason     TEXT NOT NULL
               CHECK (reason IN ('existing_client','active_contract','past_rejection',
                                 'placed_candidate_employer','competitor','no_agency_policy',
                                 'replied_no','bounced','manual','opt_out')),
  note       TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000),
  UNIQUE (kind, value)
) STRICT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Durable task queue. Claim pattern is a single UPDATE ... RETURNING, which is
-- atomic in SQLite and therefore race-free across the main process and worker.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE task (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,
  dedupe_key   TEXT,
  payload      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  priority     INTEGER NOT NULL DEFAULT 100,
  state        TEXT NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','running','done','failed','dead')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after    INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000),
  started_at   INTEGER,
  finished_at  INTEGER
) STRICT;

CREATE UNIQUE INDEX task_dedupe ON task(kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('pending','running');
CREATE INDEX task_claim ON task(state, priority, run_after, id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Cost ledger. Reserve-then-commit: the row is written BEFORE the HTTP call, and
-- the UNIQUE constraint makes it physically impossible for a runaway loop to
-- re-charge for the same entity.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE api_call (
  id              INTEGER PRIMARY KEY,
  provider        TEXT NOT NULL,
  endpoint        TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       TEXT,
  state           TEXT NOT NULL DEFAULT 'reserved'
                    CHECK (state IN ('reserved','succeeded','failed','skipped_dryrun')),
  est_cost_micros INTEGER NOT NULL DEFAULT 0,
  actual_cost_micros INTEGER,
  http_status     INTEGER,
  error           TEXT,
  started_at      INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000),
  finished_at     INTEGER,
  UNIQUE (provider, idempotency_key)
) STRICT;

CREATE INDEX api_provider ON api_call(provider, started_at DESC);

CREATE TABLE spend_cap (
  provider        TEXT PRIMARY KEY,
  cap_usd_micros  INTEGER NOT NULL,
  spent_usd_micros INTEGER NOT NULL DEFAULT 0
) STRICT, WITHOUT ROWID;

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit log — every operator edit and every automated write worth explaining.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  at          INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000),
  actor       TEXT NOT NULL,                -- 'operator' | 'job:<kind>' | 'system'
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  note        TEXT
) STRICT;

CREATE INDEX audit_entity ON audit_log(entity, entity_id, at DESC);
CREATE INDEX audit_at     ON audit_log(at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Settings + secrets. Secrets are encrypted with Electron safeStorage (OS
-- keychain-backed) before they land here; the column holds ciphertext.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  is_secret  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000)
) STRICT, WITHOUT ROWID;

-- Email patterns observed per domain. The biggest cost lever in the pipeline:
-- a confirmed pattern turns one verified seed into N candidate addresses.
CREATE TABLE email_pattern (
  domain       TEXT PRIMARY KEY,
  pattern      TEXT NOT NULL,               -- 'first.last' | 'flast' | 'first' | ...
  sample_count INTEGER NOT NULL DEFAULT 0,
  confidence   REAL NOT NULL DEFAULT 0,
  mx_provider  TEXT,
  is_catch_all INTEGER,
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000)
) STRICT, WITHOUT ROWID;

-- ─────────────────────────────────────────────────────────────────────────────
-- Full-text search. External-content tables so we don't duplicate the bodies.
-- Bulk loaders drop these triggers and rebuild (measured ~6.4x faster).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE VIRTUAL TABLE req_fts USING fts5(
  title, location, description,
  content='req', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER req_ai AFTER INSERT ON req BEGIN
  INSERT INTO req_fts(rowid, title, location, description)
  VALUES (new.id, new.title, new.location, new.description);
END;
CREATE TRIGGER req_ad AFTER DELETE ON req BEGIN
  INSERT INTO req_fts(req_fts, rowid, title, location, description)
  VALUES ('delete', old.id, old.title, old.location, old.description);
END;
CREATE TRIGGER req_au AFTER UPDATE ON req BEGIN
  INSERT INTO req_fts(req_fts, rowid, title, location, description)
  VALUES ('delete', old.id, old.title, old.location, old.description);
  INSERT INTO req_fts(rowid, title, location, description)
  VALUES (new.id, new.title, new.location, new.description);
END;
