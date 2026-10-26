// Upstream accounts: the credentials the gateway fronts, plus their quota and health.
//
// One account is one upstream credential (its own base URL and key). Many accounts
// may share a provider; the routing policy in routing.ts decides which one serves.

import type { Db } from "./db.js";
import { nowIso } from "./db.js";
import { dialectOrDefault, parseDialect, type Dialect } from "./dialects/index.js";

export type AccountStatus = "ready" | "cooling" | "dead";

/** What a provider says about the account's own quota (not what came through this gateway). */
export interface ProviderUsage {
  used: number | null;
  limit: number | null;
  resetsAt: string | null;
  pot: number | null;
  weekLimit: number | null;
  weekUsed: number | null;
}

export interface QuotaSnapshot extends ProviderUsage {
  checkedAt: string;
  error: string | null;
}

export interface Account {
  id: number;
  label: string;
  provider: string;
  /** What this upstream speaks: how to render a request for it, and how to read its answer. */
  dialect: Dialect;
  /** Set when the upstream only answers streamed (the gateway collapses it for plain callers). */
  forceStream: boolean;
  /** Set when the upstream rejects temperature/top_p outright. */
  stripSampling: boolean;
  baseUrl: string;
  apiKey: string;
  /** Present when the account came from a device login: lets the gateway renew itself. */
  refreshToken: string | null;
  /** ISO time the access token stops being valid, when the provider said so. */
  tokenExpiresAt: string | null;
  /** The manager origin this account's refresh token belongs to. */
  oauthOrigin: string | null;
  /** The provider's own quota, as last reported; null until something asked. */
  providerUsage: QuotaSnapshot | null;
  /** Lower wins: accounts of the best available priority are tried first. */
  priority: number;
  /** Relative share within the same priority. */
  weight: number;
  enabled: boolean;
  /** Token allowance per window, or null for unlimited. */
  quotaLimit: number | null;
  quotaUsed: number;
  /** When the counter goes back to zero; the window then repeats daily. */
  quotaResetAt: string | null;
  status: AccountStatus;
  cooldownUntil: string | null;
  lastError: string | null;
  /** Extra headers to send upstream (added to, never replacing, the OpenAI ones). */
  extraHeaders: Record<string, string> | null;
  served: number;
  createdAt: string;
  updatedAt: string;
}

export interface AccountInput {
  label: string;
  baseUrl: string;
  apiKey: string;
  provider?: string;
  dialect?: Dialect;
  forceStream?: boolean;
  stripSampling?: boolean;
  refreshToken?: string | null;
  tokenExpiresAt?: string | null;
  oauthOrigin?: string | null;
  priority?: number;
  weight?: number;
  quotaLimit?: number | null;
  quotaResetAt?: string | null;
  extraHeaders?: Record<string, string> | null;
}

export interface AccountPatch {
  baseUrl?: string;
  apiKey?: string;
  provider?: string;
  dialect?: Dialect;
  forceStream?: boolean;
  stripSampling?: boolean;
  refreshToken?: string | null;
  tokenExpiresAt?: string | null;
  oauthOrigin?: string | null;
  priority?: number;
  weight?: number;
  quotaLimit?: number | null;
  quotaResetAt?: string | null;
  extraHeaders?: Record<string, string> | null;
  enabled?: boolean;
}

interface Row {
  id: number;
  label: string;
  provider: string;
  dialect: string;
  force_stream: number;
  strip_sampling: number;
  base_url: string;
  api_key: string;
  refresh_token: string | null;
  token_expires_at: string | null;
  oauth_origin: string | null;
  provider_usage: string | null;
  priority: number;
  weight: number;
  enabled: number;
  quota_limit: number | null;
  quota_used: number;
  quota_reset_at: string | null;
  status: string;
  cooldown_until: string | null;
  last_error: string | null;
  extra_headers: string | null;
  served: number;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  "id, label, provider, dialect, force_stream, strip_sampling, base_url, api_key, refresh_token, token_expires_at, oauth_origin, provider_usage, priority, weight, enabled, quota_limit, quota_used, quota_reset_at, status, cooldown_until, last_error, extra_headers, served, created_at, updated_at";

function toAccount(row: Row): Account {
  let extraHeaders: Record<string, string> | null = null;
  if (row.extra_headers) {
    try {
      const parsed: unknown = JSON.parse(row.extra_headers);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) extraHeaders = parsed as Record<string, string>;
    } catch {
      extraHeaders = null;
    }
  }
  return {
    id: row.id,
    label: row.label,
    provider: row.provider,
    dialect: dialectOrDefault(row.dialect),
    forceStream: row.force_stream === 1,
    stripSampling: row.strip_sampling === 1,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    refreshToken: row.refresh_token,
    tokenExpiresAt: row.token_expires_at,
    oauthOrigin: row.oauth_origin,
    providerUsage: readUsage(row.provider_usage),
    priority: row.priority,
    weight: row.weight,
    enabled: row.enabled === 1,
    quotaLimit: row.quota_limit,
    quotaUsed: row.quota_used,
    quotaResetAt: row.quota_reset_at,
    status: (row.status === "cooling" || row.status === "dead" ? row.status : "ready") as AccountStatus,
    cooldownUntil: row.cooldown_until,
    lastError: row.last_error,
    extraHeaders,
    served: row.served,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The stored usage snapshot, or null when it is missing or no longer readable. */
function readUsage(raw: string | null): QuotaSnapshot | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("checkedAt" in parsed)) return null;
    return parsed as QuotaSnapshot;
  } catch {
    return null;
  }
}

/** The provider's answer replaces the stored snapshot; a failed check keeps the numbers. */
export function saveAccountUsage(db: Db, id: number, snapshot: QuotaSnapshot): void {
  db.prepare("UPDATE accounts SET provider_usage = @usage, updated_at = @at WHERE id = @id").run({
    usage: JSON.stringify(snapshot),
    at: nowIso(),
    id,
  });
}

/** A base URL the gateway can actually call: absolute http(s), no trailing slash. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`base_url must be http(s): ${raw}`);
  return trimmed;
}

export function listAccounts(db: Db): Account[] {
  return db.prepare<[], Row>(`SELECT ${COLUMNS} FROM accounts ORDER BY priority, id`).all().map(toAccount);
}

export function getAccount(db: Db, id: number): Account | null {
  const row = db.prepare<[number], Row>(`SELECT ${COLUMNS} FROM accounts WHERE id = ?`).get(id);
  return row ? toAccount(row) : null;
}

export function createAccount(db: Db, input: AccountInput): Account {
  const at = nowIso();
  const info = db
    .prepare(
      `INSERT INTO accounts (label, provider, dialect, force_stream, strip_sampling, base_url, api_key, refresh_token, token_expires_at, oauth_origin, priority, weight, quota_limit, quota_reset_at, extra_headers, created_at, updated_at)
       VALUES (@label, @provider, @dialect, @force_stream, @strip_sampling, @base_url, @api_key, @refresh_token, @token_expires_at, @oauth_origin, @priority, @weight, @quota_limit, @quota_reset_at, @extra_headers, @at, @at)`,
    )
    .run({
      label: input.label.trim(),
      provider: (input.provider ?? "openai").trim() || "openai",
      dialect: input.dialect ? parseDialect(input.dialect) : "openai-chat",
      force_stream: input.forceStream ? 1 : 0,
      strip_sampling: input.stripSampling ? 1 : 0,
      base_url: normalizeBaseUrl(input.baseUrl),
      api_key: input.apiKey.trim(),
      refresh_token: input.refreshToken ?? null,
      token_expires_at: input.tokenExpiresAt ?? null,
      oauth_origin: input.oauthOrigin ?? null,
      priority: input.priority ?? 100,
      weight: input.weight ?? 1,
      quota_limit: input.quotaLimit ?? null,
      quota_reset_at: input.quotaResetAt ?? null,
      extra_headers: input.extraHeaders ? JSON.stringify(input.extraHeaders) : null,
      at,
    });
  const created = getAccount(db, Number(info.lastInsertRowid));
  if (!created) throw new Error("account insert did not read back");
  return created;
}

export function updateAccount(db: Db, id: number, patch: AccountPatch): Account | null {
  const current = getAccount(db, id);
  if (!current) return null;
  const next = {
    provider: patch.provider?.trim() || current.provider,
    dialect: patch.dialect ? parseDialect(patch.dialect) : current.dialect,
    force_stream: (patch.forceStream === undefined ? current.forceStream : patch.forceStream) ? 1 : 0,
    strip_sampling: (patch.stripSampling === undefined ? current.stripSampling : patch.stripSampling) ? 1 : 0,
    base_url: patch.baseUrl === undefined ? current.baseUrl : normalizeBaseUrl(patch.baseUrl),
    api_key: patch.apiKey?.trim() || current.apiKey,
    refresh_token: patch.refreshToken === undefined ? current.refreshToken : patch.refreshToken,
    token_expires_at: patch.tokenExpiresAt === undefined ? current.tokenExpiresAt : patch.tokenExpiresAt,
    oauth_origin: patch.oauthOrigin === undefined ? current.oauthOrigin : patch.oauthOrigin,
    priority: patch.priority ?? current.priority,
    weight: patch.weight ?? current.weight,
    quota_limit: patch.quotaLimit === undefined ? current.quotaLimit : patch.quotaLimit,
    quota_reset_at: patch.quotaResetAt === undefined ? current.quotaResetAt : patch.quotaResetAt,
    extra_headers:
      patch.extraHeaders === undefined
        ? current.extraHeaders && JSON.stringify(current.extraHeaders)
        : patch.extraHeaders && JSON.stringify(patch.extraHeaders),
    enabled: (patch.enabled === undefined ? current.enabled : patch.enabled) ? 1 : 0,
    updated_at: nowIso(),
    id,
  };
  db.prepare(
    `UPDATE accounts SET provider = @provider, dialect = @dialect, force_stream = @force_stream, strip_sampling = @strip_sampling, base_url = @base_url,
       api_key = @api_key, refresh_token = @refresh_token, token_expires_at = @token_expires_at, oauth_origin = @oauth_origin,
       priority = @priority, weight = @weight, quota_limit = @quota_limit,
       quota_reset_at = @quota_reset_at, extra_headers = @extra_headers, enabled = @enabled, updated_at = @updated_at
     WHERE id = @id`,
  ).run(next);
  return getAccount(db, id);
}

export function deleteAccount(db: Db, id: number): boolean {
  return db.prepare("DELETE FROM accounts WHERE id = ?").run(id).changes > 0;
}

/** Mark an upstream failure: `cooldownMs` of rest, or dead when the credential itself was refused. */
export function recordAccountFailure(db: Db, id: number, error: string, cooldownMs: number, dead: boolean): void {
  const until = cooldownMs > 0 ? new Date(Date.now() + cooldownMs).toISOString() : null;
  db.prepare("UPDATE accounts SET status = @status, cooldown_until = @until, last_error = @error, updated_at = @at WHERE id = @id").run({
    status: dead ? "dead" : cooldownMs > 0 ? "cooling" : "ready",
    until,
    error: error.slice(0, 500),
    at: nowIso(),
    id,
  });
}

export function recordAccountSuccess(db: Db, id: number): void {
  db.prepare("UPDATE accounts SET status = 'ready', cooldown_until = NULL, last_error = NULL, served = served + 1, updated_at = @at WHERE id = @id").run({
    at: nowIso(),
    id,
  });
}

export function resetAccountCooldown(db: Db, id: number): boolean {
  return (
    db.prepare("UPDATE accounts SET status = 'ready', cooldown_until = NULL, last_error = NULL, updated_at = @at WHERE id = @id").run({
      at: nowIso(),
      id,
    }).changes > 0
  );
}

/**
 * The refresher's only write: a rotated pair, and the account is usable again — a fresh
 * credential is the one thing that clears a park.
 */
export function saveAccountTokens(
  db: Db,
  id: number,
  tokens: { accessToken: string; refreshToken: string | null; expiresAt: string | null },
): void {
  db.prepare(
    `UPDATE accounts SET api_key = @access, refresh_token = @refresh, token_expires_at = @expires,
       status = 'ready', cooldown_until = NULL, last_error = NULL, updated_at = @at
     WHERE id = @id`,
  ).run({ access: tokens.accessToken, refresh: tokens.refreshToken, expires: tokens.expiresAt, at: nowIso(), id });
}

/** Add a request's tokens to the account's rolling counter. */
export function addAccountUsage(db: Db, id: number, totalTokens: number): void {
  if (totalTokens <= 0) return;
  db.prepare("UPDATE accounts SET quota_used = quota_used + @tokens, updated_at = @at WHERE id = @id").run({ tokens: totalTokens, at: nowIso(), id });
}

/** Counters whose window has passed go back to zero, and the window repeats daily. */
export function applyQuotaResets(db: Db, now = Date.now()): void {
  const due = db
    .prepare<[string], { id: number; quota_reset_at: string }>("SELECT id, quota_reset_at FROM accounts WHERE quota_reset_at IS NOT NULL AND quota_reset_at <= ?")
    .all(new Date(now).toISOString());
  const reset = db.prepare("UPDATE accounts SET quota_used = 0, quota_reset_at = @next, status = 'ready', cooldown_until = NULL, updated_at = @at WHERE id = @id");
  for (const row of due) {
    const previous = Date.parse(row.quota_reset_at);
    const next = new Date((Number.isFinite(previous) ? previous : now) + 86_400_000).toISOString();
    reset.run({ next, at: new Date(now).toISOString(), id: row.id });
  }
}

/** Every account that may serve right now. */
export function availableAccounts(db: Db, now = Date.now()): Account[] {
  applyQuotaResets(db, now);
  return listAccounts(db).filter((account) => {
    if (!account.enabled || account.status === "dead") return false;
    if (account.cooldownUntil && Date.parse(account.cooldownUntil) > now) return false;
    if (account.quotaLimit !== null && account.quotaUsed >= account.quotaLimit) return false;
    return true;
  });
}
