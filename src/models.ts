// The model catalog: what the accounts advertise, as one list.
//
// Both the data plane's /v1/models and the console's Models page ask this, so the answer is
// the same everywhere and the upstreams are asked at most once per ttl.

import { availableAccounts, type Account } from "./accounts.js";
import type { UpstreamFetch } from "./curl.js";
import type { Db } from "./db.js";

export interface ModelEntry {
  id: string;
  ownedBy: string | null;
  displayName: string | null;
  context: number | null;
  output: number | null;
  reasoningLevels: string[];
  capabilities: string[];
  /** Labels of the accounts that offer this model, in routing order. */
  accounts: string[];
  /** The upstream's own entry, kept verbatim for the OpenAI-shaped answer. */
  raw: Record<string, unknown>;
}

export interface Catalog {
  fetchedAt: string;
  entries: ModelEntry[];
  failures: { account: string; error: string }[];
}

export interface CatalogSource {
  /** The union across the accounts that may serve now, cached for the ttl. */
  get(force?: boolean): Promise<Catalog>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  const flags = record(value);
  return flags ? Object.entries(flags).filter(([, on]) => on === true).map(([name]) => name) : [];
}

function entryOf(raw: Record<string, unknown>, id: string, account: string): ModelEntry {
  const limits = record(raw.limits);
  return {
    id,
    ownedBy: text(raw.owned_by),
    displayName: text(raw.display_name),
    context: count(limits?.context),
    output: count(limits?.output),
    reasoningLevels: list(raw.reasoning_levels),
    capabilities: list(raw.capabilities),
    accounts: [account],
    raw,
  };
}

function headersFor(account: Account): Headers {
  const headers = new Headers({ accept: "application/json" });
  if (account.extraHeaders) for (const [name, value] of Object.entries(account.extraHeaders)) headers.set(name, value);
  headers.set("authorization", `Bearer ${account.apiKey}`);
  return headers;
}

export function createCatalogSource(options: { db: Db; transport: UpstreamFetch; timeoutMs: number; ttlMs: number }): CatalogSource {
  let cached: Catalog | null = null;

  return {
    get: async (force = false) => {
      if (!force && cached && options.ttlMs > 0 && Date.now() - Date.parse(cached.fetchedAt) < options.ttlMs) return cached;
      const accounts = availableAccounts(options.db);
      const results = await Promise.allSettled(
        accounts.map(async (account) => {
          const response = await options.transport(`${account.baseUrl}/models`, {
            method: "GET",
            headers: headersFor(account),
            signal: AbortSignal.timeout(Math.min(options.timeoutMs, 30_000)),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return { account, payload: (await response.json()) as unknown };
        }),
      );

      const byId = new Map<string, ModelEntry>();
      const failures: Catalog["failures"] = [];
      results.forEach((result, index) => {
        const label = accounts[index]?.label ?? "unknown";
        if (result.status === "rejected") {
          failures.push({ account: label, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
          return;
        }
        const payload = record(result.value.payload);
        if (!payload || !Array.isArray(payload.data)) {
          failures.push({ account: label, error: "the catalog had no data" });
          return;
        }
        for (const raw of payload.data) {
          const entry = record(raw);
          if (!entry) continue;
          const id = text(entry.id);
          if (!id) continue;
          const existing = byId.get(id);
          // The first account to offer a model owns the row; the rest are listed on it.
          if (existing) existing.accounts.push(label);
          else byId.set(id, entryOf(entry, id, label));
        }
      });

      cached = { fetchedAt: new Date().toISOString(), entries: [...byId.values()], failures };
      return cached;
    },
  };
}
