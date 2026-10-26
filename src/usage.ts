// Request log and the aggregates the admin API and the CLI report.

import type { Db } from "./db.js";
import { nowIso } from "./db.js";

export interface RequestRecord {
  keyId: number | null;
  accountId: number | null;
  method: string;
  path: string;
  model: string | null;
  status: number;
  stream: boolean;
  attempt: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number;
  error: string | null;
}

export interface UsageRow {
  group: string;
  requests: number;
  tokens: number;
  errors: number;
}

export interface RequestRow extends RequestRecord {
  id: number;
  at: string;
}

export type UsageGroup = "account" | "key" | "model";

export function recordRequest(db: Db, record: RequestRecord): void {
  db.prepare(
    `INSERT INTO requests (at, key_id, account_id, method, path, model, status, stream, attempt,
       prompt_tokens, completion_tokens, total_tokens, latency_ms, error)
     VALUES (@at, @key_id, @account_id, @method, @path, @model, @status, @stream, @attempt,
       @prompt_tokens, @completion_tokens, @total_tokens, @latency_ms, @error)`,
  ).run({
    at: nowIso(),
    key_id: record.keyId,
    account_id: record.accountId,
    method: record.method,
    path: record.path,
    model: record.model,
    status: record.status,
    stream: record.stream ? 1 : 0,
    attempt: record.attempt,
    prompt_tokens: record.promptTokens,
    completion_tokens: record.completionTokens,
    total_tokens: record.totalTokens,
    latency_ms: record.latencyMs,
    error: record.error,
  });
}

const AGGREGATE = `COUNT(*) AS requests,
       COALESCE(SUM(COALESCE(r.total_tokens, 0)), 0) AS tokens,
       COALESCE(SUM(CASE WHEN r.status >= 400 THEN 1 ELSE 0 END), 0) AS errors`;

export function usageSummary(db: Db, sinceIso: string, group: UsageGroup): UsageRow[] {
  if (group === "account") {
    return db
      .prepare<[string], UsageRow>(
        `SELECT COALESCE(a.label, '(deleted)') AS "group", ${AGGREGATE}
           FROM requests r LEFT JOIN accounts a ON a.id = r.account_id
          WHERE r.at >= ? GROUP BY r.account_id ORDER BY requests DESC`,
      )
      .all(sinceIso);
  }
  if (group === "key") {
    return db
      .prepare<[string], UsageRow>(
        `SELECT COALESCE(k.name, '(deleted)') AS "group", ${AGGREGATE}
           FROM requests r LEFT JOIN gateway_keys k ON k.id = r.key_id
          WHERE r.at >= ? GROUP BY r.key_id ORDER BY requests DESC`,
      )
      .all(sinceIso);
  }
  return db
    .prepare<[string], UsageRow>(
      `SELECT COALESCE(r.model, '(none)') AS "group", ${AGGREGATE}
         FROM requests r WHERE r.at >= ? GROUP BY r.model ORDER BY requests DESC`,
    )
    .all(sinceIso);
}

export function recentRequests(db: Db, limit: number): RequestRow[] {
  const rows = db
    .prepare<[number], {
      id: number;
      at: string;
      key_id: number | null;
      account_id: number | null;
      method: string;
      path: string;
      model: string | null;
      status: number;
      stream: number;
      attempt: number;
      prompt_tokens: number | null;
      completion_tokens: number | null;
      total_tokens: number | null;
      latency_ms: number;
      error: string | null;
    }>(
      `SELECT id, at, key_id, account_id, method, path, model, status, stream, attempt,
              prompt_tokens, completion_tokens, total_tokens, latency_ms, error
         FROM requests ORDER BY id DESC LIMIT ?`,
    )
    .all(limit);
  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    keyId: row.key_id,
    accountId: row.account_id,
    method: row.method,
    path: row.path,
    model: row.model,
    status: row.status,
    stream: row.stream === 1,
    attempt: row.attempt,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    latencyMs: row.latency_ms,
    error: row.error,
  }));
}
