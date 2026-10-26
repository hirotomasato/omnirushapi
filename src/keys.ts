// Client keys: what callers present to the gateway (Authorization: Bearer sk-gw-...).
//
// Only a SHA-256 hash is stored, so a dump of the database cannot be used against the
// gateway. The secret is shown once, by whoever created it.

import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";
import { nowIso } from "./db.js";

export interface GatewayKey {
  id: number;
  name: string;
  /** First characters of the secret, for telling keys apart in listings. */
  prefix: string;
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface Row {
  id: number;
  name: string;
  prefix: string;
  enabled: number;
  created_at: string;
  last_used_at: string | null;
}

const COLUMNS = "id, name, prefix, enabled, created_at, last_used_at";

function toKey(row: Row): GatewayKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export const KEY_PREFIX = "sk-gw-";

export function createKey(db: Db, name: string): { key: GatewayKey; secret: string } {
  const secret = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  const info = db
    .prepare("INSERT INTO gateway_keys (name, prefix, secret_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(name.trim(), secret.slice(0, 12), hashSecret(secret), nowIso());
  const row = db.prepare<[number], Row>(`SELECT ${COLUMNS} FROM gateway_keys WHERE id = ?`).get(Number(info.lastInsertRowid));
  if (!row) throw new Error("key insert did not read back");
  return { key: toKey(row), secret };
}

export function listKeys(db: Db): GatewayKey[] {
  return db.prepare<[], Row>(`SELECT ${COLUMNS} FROM gateway_keys ORDER BY id`).all().map(toKey);
}

export function findKeyBySecret(db: Db, secret: string): GatewayKey | null {
  if (!secret.startsWith(KEY_PREFIX)) return null;
  const row = db.prepare<[string], Row>(`SELECT ${COLUMNS} FROM gateway_keys WHERE secret_hash = ?`).get(hashSecret(secret));
  return row ? toKey(row) : null;
}

export function deleteKey(db: Db, id: number): boolean {
  return db.prepare("DELETE FROM gateway_keys WHERE id = ?").run(id).changes > 0;
}

export function setKeyEnabled(db: Db, id: number, enabled: boolean): boolean {
  return db.prepare("UPDATE gateway_keys SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id).changes > 0;
}

/** Note that a key was used, at most once a minute (this is a row write on every request otherwise). */
export function touchKey(db: Db, id: number, now = Date.now()): void {
  db.prepare("UPDATE gateway_keys SET last_used_at = @at WHERE id = @id AND (last_used_at IS NULL OR last_used_at < @stale)").run({
    at: new Date(now).toISOString(),
    id,
    stale: new Date(now - 60_000).toISOString(),
  });
}
