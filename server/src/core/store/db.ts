import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

/**
 * Versioned migrations. Request types and statuses are validated in code
 * (see requests/request-types.ts), not with CHECK constraints, so adding a
 * request type never needs a schema migration.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    patient_number TEXT NOT NULL,
    clinic_number TEXT NOT NULL,
    started_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    seq INTEGER NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    author TEXT NOT NULL CHECK (author IN ('patient', 'clinic_staff', 'agent')),
    from_number TEXT NOT NULL,
    to_number TEXT NOT NULL,
    body TEXT NOT NULL,
    in_reply_to TEXT REFERENCES messages(id),
    meta TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    UNIQUE (conversation_id, seq)
  );
  CREATE TABLE requests (
    id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL,
    conversation_id TEXT REFERENCES conversations(id),
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'routine',
    summary TEXT NOT NULL,
    details TEXT NOT NULL,
    source_message_ids TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    staff_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_requests_patient ON requests(patient_id, status);
  CREATE TABLE request_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL REFERENCES requests(id),
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    message_id TEXT,
    changes TEXT NOT NULL DEFAULT '{}',
    note TEXT
  );
  CREATE INDEX idx_request_events_request ON request_events(request_id, id);
  CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    inbound_message_id TEXT NOT NULL REFERENCES messages(id),
    reply_message_id TEXT REFERENCES messages(id),
    mode TEXT NOT NULL,
    trace TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL
  );
  `,
];

const depth = new WeakMap<DatabaseSync, number>();

/** Runs `fn` atomically. Nested calls join the outer transaction. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  if (d > 0) {
    depth.set(db, d + 1);
    try {
      return fn();
    } finally {
      depth.set(db, d);
    }
  }
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

function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version),
  );
  MIGRATIONS.forEach((sql, i) => {
    const version = i + 1;
    if (applied.has(version)) return;
    transaction(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
    });
  });
}

/** Opens (creating if needed) the SQLite database. Use ":memory:" for tests and evals. */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  migrate(db);
  return db;
}

/** Deletes every record (demo reset) but keeps the schema. */
export function wipeDatabase(db: DatabaseSync): void {
  transaction(db, () => {
    for (const table of ['agent_runs', 'request_events', 'requests', 'messages', 'conversations', 'counters', 'settings']) {
      db.exec(`DELETE FROM ${table}`);
    }
  });
}
