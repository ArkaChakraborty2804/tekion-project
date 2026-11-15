import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;
type Param = string | number | bigint | null | undefined;

/**
 * Schema is append-only: add new migrations at the end, never edit a shipped one.
 * Every business table carries tenant_id (dealer group). Repositories always filter by it.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE rooftops (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, tz TEXT NOT NULL, phone TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE users (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, sub TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('group_admin','rooftop_manager','service_advisor','approver','analyst','support')),
    rooftop_ids TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE customers (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, rooftop_id TEXT NOT NULL, party_id TEXT,
    full_name TEXT NOT NULL, phone TEXT, email TEXT, language TEXT NOT NULL DEFAULT 'en',
    tz TEXT NOT NULL, phone_hash TEXT, email_hash TEXT, created_at TEXT NOT NULL,
    UNIQUE (tenant_id, party_id)
  );
  CREATE INDEX customers_phone ON customers (tenant_id, phone_hash);
  CREATE TABLE vehicles (
    vin TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, make TEXT NOT NULL, model TEXT NOT NULL, year INTEGER NOT NULL,
    odometer INTEGER, odometer_at TEXT, warranty_end_date TEXT, warranty_end_miles INTEGER,
    loan_end_date TEXT, insurance_renewal_date TEXT, annual_miles INTEGER NOT NULL DEFAULT 12000
  );
  CREATE TABLE ownerships (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, rooftop_id TEXT NOT NULL, vin TEXT NOT NULL REFERENCES vehicles(vin),
    customer_id TEXT NOT NULL REFERENCES customers(id),
    state TEXT NOT NULL CHECK (state IN ('active','snoozed','possibly_sold','sold','dormant','closed')),
    started_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT, snooze_until TEXT,
    unanswered_count INTEGER NOT NULL DEFAULT 0, last_service_at TEXT, last_service_odometer INTEGER,
    last_ro_csat INTEGER, last_declined TEXT NOT NULL DEFAULT '[]', last_outbound_at TEXT,
    version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX ownerships_one_open ON ownerships (vin) WHERE state IN ('active','snoozed','dormant');
  CREATE TABLE opportunities (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, rooftop_id TEXT NOT NULL, ownership_id TEXT NOT NULL REFERENCES ownerships(id),
    type TEXT NOT NULL, need TEXT NOT NULL, tier TEXT NOT NULL, score REAL NOT NULL, dedupe_key TEXT NOT NULL,
    status TEXT NOT NULL, rule_id TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '[]', bundle TEXT NOT NULL DEFAULT '[]',
    purpose TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', facts TEXT NOT NULL DEFAULT '{}', draft TEXT, draft_by TEXT,
    suppressed_by TEXT, due_at TEXT, expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX opportunities_dedupe ON opportunities (ownership_id, dedupe_key) WHERE status IN ('candidate','pending_approval');
  CREATE INDEX opportunities_status ON opportunities (tenant_id, status);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, opportunity_id TEXT NOT NULL, actor TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('approve','edit','reject','snooze')), reason_code TEXT, detail TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, rooftop_id TEXT NOT NULL, customer_id TEXT NOT NULL,
    ownership_id TEXT, opportunity_id TEXT, direction TEXT NOT NULL CHECK (direction IN ('out','in')),
    purpose TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, provider_msg_id TEXT,
    channel TEXT NOT NULL DEFAULT 'sms', created_at TEXT NOT NULL,
    UNIQUE (provider_msg_id, direction)
  );
  CREATE INDEX messages_customer ON messages (tenant_id, customer_id, created_at);
  CREATE TABLE consents (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, customer_id TEXT NOT NULL, purpose TEXT NOT NULL,
    consent_type TEXT NOT NULL CHECK (consent_type IN ('granted','revoked')), source TEXT NOT NULL,
    disclosure_version TEXT NOT NULL, captured_at TEXT NOT NULL
  );
  CREATE INDEX consents_lookup ON consents (tenant_id, customer_id, purpose, captured_at);
  CREATE TABLE cases (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, rooftop_id TEXT NOT NULL, ownership_id TEXT, customer_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('safety','problem','callback','question')),
    priority TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('open','acknowledged','resolved')),
    summary TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, acked_by TEXT, acked_at TEXT,
    resolved_at TEXT, resolution TEXT
  );
  CREATE INDEX cases_status ON cases (tenant_id, status, created_at);
  CREATE TABLE media (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, case_id TEXT NOT NULL REFERENCES cases(id), kind TEXT NOT NULL,
    path TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, mime TEXT NOT NULL,
    created_at TEXT NOT NULL, retention_until TEXT NOT NULL, deleted_at TEXT
  );
  CREATE TABLE capability_links (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, ownership_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL, revoked_at TEXT, uses INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, source TEXT NOT NULL, source_event_id TEXT NOT NULL, type TEXT NOT NULL,
    vin TEXT, payload TEXT NOT NULL, occurred_at TEXT NOT NULL, received_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','done','dead')) DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, processed_at TEXT,
    UNIQUE (source, source_event_id)
  );
  CREATE INDEX events_pending ON events (status, occurred_at);
  CREATE TABLE rule_versions (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft','published','retired')), created_by TEXT NOT NULL,
    created_at TEXT NOT NULL, published_at TEXT, UNIQUE (tenant_id, version)
  );
  CREATE TABLE recall_findings (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, vin TEXT NOT NULL, campaign TEXT NOT NULL, component TEXT NOT NULL,
    summary TEXT NOT NULL, remedy TEXT NOT NULL DEFAULT '', as_of TEXT NOT NULL, source TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open','closed')) DEFAULT 'open', UNIQUE (vin, campaign)
  );
  CREATE TABLE recall_cache (vin TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at TEXT NOT NULL, source TEXT NOT NULL);
  CREATE TABLE ai_calls (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, capability TEXT NOT NULL, prompt_id TEXT NOT NULL, model TEXT NOT NULL,
    input_hash TEXT NOT NULL, output TEXT NOT NULL, validation TEXT NOT NULL, latency_ms INTEGER NOT NULL,
    used_fallback INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE audit_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, actor TEXT NOT NULL,
    action TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER consents_no_update BEFORE UPDATE ON consents BEGIN SELECT RAISE(ABORT, 'consents is append-only'); END;
  CREATE TRIGGER consents_no_delete BEFORE DELETE ON consents BEGIN SELECT RAISE(ABORT, 'consents is append-only'); END;
  `,
  // 2: Continuum - RO history, closed-loop technician stories, vector index, AI diagnostics and media triage.
  `
  CREATE TABLE ro_history (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, rooftop_id TEXT NOT NULL, ownership_id TEXT NOT NULL, vin TEXT NOT NULL,
    ro_id TEXT NOT NULL, closed_at TEXT NOT NULL, odometer INTEGER, csat INTEGER, declined TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL, UNIQUE (tenant_id, ro_id)
  );
  CREATE INDEX ro_history_own ON ro_history (tenant_id, ownership_id, closed_at);
  CREATE TABLE technician_stories (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, rooftop_id TEXT NOT NULL, ro_id TEXT NOT NULL, vin TEXT NOT NULL,
    make TEXT NOT NULL, model TEXT NOT NULL, customer_complaint TEXT NOT NULL, ai_predicted TEXT,
    ai_predicted_source TEXT CHECK (ai_predicted_source IN ('payload','diagnostic')),
    technician_diagnosis TEXT NOT NULL, technician_action TEXT NOT NULL, override_occurred INTEGER NOT NULL,
    labor_code TEXT NOT NULL, closed_at TEXT NOT NULL,
    embed_status TEXT NOT NULL CHECK (embed_status IN ('pending','embedded','failed')) DEFAULT 'pending',
    embed_attempts INTEGER NOT NULL DEFAULT 0, embed_model TEXT, embed_error TEXT, created_at TEXT NOT NULL,
    UNIQUE (tenant_id, ro_id)
  );
  CREATE INDEX technician_stories_embed ON technician_stories (embed_status, created_at);
  CREATE TABLE vector_entries (
    id TEXT NOT NULL, tenant_id TEXT NOT NULL, collection TEXT NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL,
    text TEXT NOT NULL, embedding BLOB NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, collection, model, id)
  );
  CREATE TABLE diagnostics (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, rooftop_id TEXT NOT NULL, ownership_id TEXT, vin TEXT NOT NULL,
    case_id TEXT, source_kind TEXT NOT NULL CHECK (source_kind IN ('text','image','audio')), complaint TEXT NOT NULL,
    hypothesis TEXT NOT NULL, labor_code TEXT, confidence REAL NOT NULL, method TEXT NOT NULL,
    retrieval TEXT NOT NULL, precedents TEXT NOT NULL DEFAULT '[]', resolved_story_id TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX diagnostics_vin ON diagnostics (tenant_id, vin, created_at);
  CREATE TABLE triage_results (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, case_id TEXT NOT NULL REFERENCES cases(id), media_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('image','audio')), symbol TEXT NOT NULL, sound TEXT, system TEXT NOT NULL,
    urgency TEXT NOT NULL CHECK (urgency IN ('P1','P2','P3')), description TEXT, transcript TEXT,
    safety INTEGER NOT NULL, safety_reasons TEXT NOT NULL DEFAULT '[]', overridden INTEGER NOT NULL,
    confidence REAL NOT NULL, source TEXT NOT NULL, prompt_id TEXT NOT NULL, customer_message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX triage_case ON triage_results (tenant_id, case_id);
  `,
  // 3: text-only triage (customer describes the problem in words, no media). SQLite cannot alter a CHECK, so rebuild.
  `
  CREATE TABLE triage_results_v3 (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, case_id TEXT NOT NULL REFERENCES cases(id), media_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('image','audio','text')), symbol TEXT NOT NULL, sound TEXT, system TEXT NOT NULL,
    urgency TEXT NOT NULL CHECK (urgency IN ('P1','P2','P3')), description TEXT, transcript TEXT,
    safety INTEGER NOT NULL, safety_reasons TEXT NOT NULL DEFAULT '[]', overridden INTEGER NOT NULL,
    confidence REAL NOT NULL, source TEXT NOT NULL, prompt_id TEXT NOT NULL, customer_message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  INSERT INTO triage_results_v3 SELECT * FROM triage_results;
  DROP TABLE triage_results;
  ALTER TABLE triage_results_v3 RENAME TO triage_results;
  CREATE INDEX triage_case ON triage_results (tenant_id, case_id);
  `,
  // 4: quiet hours schedule approved messages instead of blocking them. NULL = send as soon as dispatched.
  `
  ALTER TABLE messages ADD COLUMN send_after TEXT;
  CREATE INDEX messages_outbox ON messages (status, send_after);
  `,
];

const depth = new WeakMap<Db, number>();

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Runs fn atomically. Nested calls join the outer transaction. */
export function tx<T>(db: Db, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  if (d > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth.set(db, 0);
  }
}

const norm = (xs: Param[]): Param[] => xs.map((x) => (x === undefined ? null : x));

export function run(db: Db, sql: string, ...params: Param[]): number {
  return Number(db.prepare(sql).run(...(norm(params) as never[])).changes);
}

export function get<T = Record<string, unknown>>(db: Db, sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...(norm(params) as never[])) as T | undefined;
}

export function all<T = Record<string, unknown>>(db: Db, sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...(norm(params) as never[])) as T[];
}
