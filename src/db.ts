// SQLite storage: schema, settings, and the admin token the gateway keeps in settings.

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  label          TEXT NOT NULL UNIQUE,
  provider       TEXT NOT NULL DEFAULT 'openai',
  dialect        TEXT NOT NULL DEFAULT 'openai-chat',
  force_stream   INTEGER NOT NULL DEFAULT 0,
  strip_sampling INTEGER NOT NULL DEFAULT 0,
  base_url       TEXT NOT NULL,
  api_key        TEXT NOT NULL,
  refresh_token  TEXT,
  token_expires_at TEXT,
  oauth_origin   TEXT,
  provider_usage TEXT,
  priority       INTEGER NOT NULL DEFAULT 100,
  weight         INTEGER NOT NULL DEFAULT 1,
  enabled        INTEGER NOT NULL DEFAULT 1,
  quota_limit    INTEGER,
  quota_used     INTEGER NOT NULL DEFAULT 0,
  quota_reset_at TEXT,
  status         TEXT NOT NULL DEFAULT 'ready',
  cooldown_until TEXT,
  last_error     TEXT,
  extra_headers  TEXT,
  served         INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  secret_hash  TEXT NOT NULL UNIQUE,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS requests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  at                TEXT NOT NULL,
  key_id            INTEGER REFERENCES gateway_keys(id) ON DELETE SET NULL,
  account_id        INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  method            TEXT NOT NULL,
  path              TEXT NOT NULL,
  model             TEXT,
  status            INTEGER NOT NULL,
  stream            INTEGER NOT NULL DEFAULT 0,
  attempt           INTEGER NOT NULL DEFAULT 1,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,
  latency_ms        INTEGER NOT NULL,
  error             TEXT
);

CREATE INDEX IF NOT EXISTS requests_at ON requests (at);
CREATE INDEX IF NOT EXISTS requests_account ON requests (account_id, at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(dbPath: string): Db {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  applyMigrations(db);
  return db;
}

/** Columns added after a table shipped: the CREATE above stays the fresh-start shape. */
const MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: "accounts", column: "dialect", ddl: "ALTER TABLE accounts ADD COLUMN dialect TEXT NOT NULL DEFAULT 'openai-chat'" },
  { table: "accounts", column: "force_stream", ddl: "ALTER TABLE accounts ADD COLUMN force_stream INTEGER NOT NULL DEFAULT 0" },
  { table: "accounts", column: "strip_sampling", ddl: "ALTER TABLE accounts ADD COLUMN strip_sampling INTEGER NOT NULL DEFAULT 0" },
  { table: "accounts", column: "refresh_token", ddl: "ALTER TABLE accounts ADD COLUMN refresh_token TEXT" },
  { table: "accounts", column: "token_expires_at", ddl: "ALTER TABLE accounts ADD COLUMN token_expires_at TEXT" },
  { table: "accounts", column: "oauth_origin", ddl: "ALTER TABLE accounts ADD COLUMN oauth_origin TEXT" },
  { table: "accounts", column: "provider_usage", ddl: "ALTER TABLE accounts ADD COLUMN provider_usage TEXT" },
];

function tableColumns(db: Db, table: string): string[] {
  const rows: unknown[] = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.flatMap((row) => (typeof row === "object" && row !== null && "name" in row && typeof row.name === "string" ? [row.name] : []));
}

function applyMigrations(db: Db): void {
  for (const migration of MIGRATIONS) {
    if (tableColumns(db, migration.table).includes(migration.column)) continue;
    db.exec(migration.ddl);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/**
 * The admin token: ADMIN_TOKEN from the environment wins, else the one minted on a
 * previous start, else a fresh one kept in settings. `minted` says it was just created,
 * so the caller can print it exactly once.
 */
export function resolveAdminToken(db: Db, fromEnv: string | null): { token: string; minted: boolean } {
  if (fromEnv) return { token: fromEnv, minted: false };
  const stored = getSetting(db, "admin_token");
  if (stored) return { token: stored, minted: false };
  const token = randomBytes(32).toString("hex");
  setSetting(db, "admin_token", token);
  return { token, minted: true };
}
