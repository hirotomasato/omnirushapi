// The provider's own quota, as it reports it.
//
// The counter the gateway keeps is what went through *this* gateway; the provider knows the
// whole account (another client, another machine, the daily reset). Both are shown, labelled,
// because they answer different questions: "how much did I spend here" and "how much is left".

import { saveAccountUsage, type Account, type ProviderUsage, type QuotaSnapshot } from "./accounts.js";
import type { UpstreamFetch } from "./curl.js";
import type { Db } from "./db.js";
import { PROVIDERS, type ProviderPreset } from "./providers.js";
import type { TokenRefresher } from "./refresh.js";

export interface QuotaRefresher {
  /** True when this account's provider reports a quota we know how to read. */
  canRefresh(account: Account): boolean;
  /** True when the stored snapshot is older than the ttl (or missing). */
  isStale(account: Account, now?: number): boolean;
  /** Asks the provider, stores the answer, and shares one call between concurrent askers. */
  refresh(account: Account): Promise<QuotaSnapshot>;
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Reads the manager's identity answer: `usage.day`, `usage.week`, `usage.pot`. */
export function parseProviderUsage(payload: unknown): ProviderUsage | null {
  const usage = recordOf(recordOf(payload)?.usage);
  if (!usage) return null;
  const day = recordOf(usage.day);
  const week = recordOf(usage.week);
  const pot = recordOf(usage.pot);
  const parsed: ProviderUsage = {
    used: numberOf(day?.used),
    limit: numberOf(day?.allowance) ?? numberOf(day?.limit),
    resetsAt: textOf(day?.resets_at) ?? textOf(usage.resets_at),
    pot: numberOf(pot?.balance),
    weekLimit: numberOf(week?.limit),
    weekUsed: numberOf(week?.used),
  };
  return parsed.limit === null && parsed.used === null && parsed.pot === null ? null : parsed;
}

export function createQuotaRefresher(options: { db: Db; transport: UpstreamFetch; refresher?: TokenRefresher; ttlMs?: number }): QuotaRefresher {
  const running = new Map<number, Promise<QuotaSnapshot>>();
  const ttlMs = options.ttlMs ?? 300_000;

  const presetFor = (account: Account): ProviderPreset | null => PROVIDERS[account.provider] ?? null;

  const ask = async (account: Account): Promise<QuotaSnapshot> => {
    const preset = presetFor(account);
    const checkedAt = new Date().toISOString();
    if (!preset?.usagePath) return { used: null, limit: null, resetsAt: null, pot: null, weekLimit: null, weekUsed: null, checkedAt, error: "this provider does not report a quota" };
    const origin = (account.oauthOrigin ?? preset.origin).replace(/\/+$/, "");
    const failed = (error: string): QuotaSnapshot => {
      // A failed check keeps the numbers we had: stale is better than blank.
      const kept: QuotaSnapshot = {
        used: account.providerUsage?.used ?? null,
        limit: account.providerUsage?.limit ?? null,
        resetsAt: account.providerUsage?.resetsAt ?? null,
        pot: account.providerUsage?.pot ?? null,
        weekLimit: account.providerUsage?.weekLimit ?? null,
        weekUsed: account.providerUsage?.weekUsed ?? null,
        checkedAt,
        error: error.slice(0, 300),
      };
      saveAccountUsage(options.db, account.id, kept);
      return kept;
    };
    const usagePath = preset.usagePath;
    const request = (accessToken: string): Promise<Response> =>
      options.transport(`${origin}${usagePath}`, {
        method: "GET",
        headers: new Headers({ ...preset.managerHeaders, authorization: `Bearer ${accessToken}`, accept: "application/json" }),
        signal: AbortSignal.timeout(20_000),
      });

    try {
      // The manager can already have thrown this token away — another client on the same
      // device rotates the pair — so spend a stale one on nothing: renew first, and again if
      // the manager refuses it anyway. Same rule the data plane follows.
      let accessToken = account.apiKey;
      if (options.refresher?.canRefresh(account) && options.refresher.isStale(account)) {
        const renewed = await options.refresher.refresh(account);
        if (renewed.ok) accessToken = renewed.accessToken;
      }
      let response = await request(accessToken);
      if ((response.status === 401 || response.status === 403) && options.refresher?.canRefresh(account)) {
        await response.body?.cancel();
        const renewed = await options.refresher.refresh(account);
        if (renewed.ok && renewed.accessToken !== accessToken) response = await request(renewed.accessToken);
      }
      if (!response.ok) return failed(`HTTP ${response.status}`);
      const parsed = parseProviderUsage(await response.json().catch(() => null));
      if (!parsed) return failed("the provider's answer carried no usage");
      saveAccountUsage(options.db, account.id, { ...parsed, checkedAt, error: null });
      return { ...parsed, checkedAt, error: null };
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
  };

  return {
    canRefresh: (account) => Boolean(presetFor(account)?.usagePath),
    isStale: (account, now = Date.now()) => {
      const checkedAt = account.providerUsage?.checkedAt;
      if (!checkedAt) return true;
      const checked = Date.parse(checkedAt);
      return !Number.isFinite(checked) || now - checked > ttlMs;
    },
    refresh: (account) => {
      const already = running.get(account.id);
      if (already) return already;
      const attempt = ask(account).finally(() => running.delete(account.id));
      running.set(account.id, attempt);
      return attempt;
    },
  };
}
