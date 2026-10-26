// Renewing device-flow credentials.
//
// Providers rotate both halves on every refresh, and present a superseded refresh token as
// a sign that the credentials are shared. Two requests meeting an expired token must
// therefore share one refresh, never race into two: the second presentation is exactly
// what gets a device signed out. One in-flight refresh per account, and everyone else
// waits for that same promise.

import { getAccount, saveAccountTokens, type Account } from "./accounts.js";
import type { UpstreamFetch } from "./curl.js";
import type { Db } from "./db.js";
import { PROVIDERS, refreshDeviceTokens, type ProviderPreset } from "./providers.js";

export interface RefreshOutcome {
  ok: boolean;
  accessToken: string;
  error: string | null;
}

export interface TokenRefresher {
  /** True when this account carries what a refresh needs (a preset and a refresh token). */
  canRefresh(account: Account): boolean;
  /** True when the stored access token has expired, or is about to. */
  isStale(account: Account, now?: number): boolean;
  /** Renews the account, sharing a single attempt between concurrent callers. */
  refresh(account: Account): Promise<RefreshOutcome>;
  /** How many refreshes are running — read by tests and by the console. */
  inFlight(): number;
}

export function createTokenRefresher(options: { db: Db; transport: UpstreamFetch; stillValidMs?: number }): TokenRefresher {
  const running = new Map<number, Promise<RefreshOutcome>>();
  const stillValidMs = options.stillValidMs ?? 60_000;

  const presetFor = (account: Account): ProviderPreset | null => PROVIDERS[account.provider] ?? null;

  const renew = async (account: Account): Promise<RefreshOutcome> => {
    // The snapshot a caller holds can be superseded already: it was read before another
    // request rotated the pair. Re-read here, inside the single flight, and adopt the stored
    // credential — presenting the superseded refresh token is what gets a device signed out.
    const stored = getAccount(options.db, account.id) ?? account;
    if (account.refreshToken && stored.refreshToken && stored.refreshToken !== account.refreshToken) {
      return { ok: true, accessToken: stored.apiKey, error: null };
    }
    const preset = presetFor(stored);
    const refreshToken = stored.refreshToken;
    if (!preset || !refreshToken) return { ok: false, accessToken: stored.apiKey, error: "no refresh token" };
    try {
      const tokens = await refreshDeviceTokens(preset, {
        transport: options.transport,
        refreshToken,
        ...(stored.oauthOrigin ? { origin: stored.oauthOrigin } : {}),
      });
      saveAccountTokens(options.db, stored.id, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresInSec === null ? null : new Date(Date.now() + tokens.expiresInSec * 1_000).toISOString(),
      });
      return { ok: true, accessToken: tokens.accessToken, error: null };
    } catch (error) {
      return { ok: false, accessToken: stored.apiKey, error: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    canRefresh: (account) => Boolean(account.refreshToken) && presetFor(account) !== null,
    isStale: (account, now = Date.now()) => {
      if (!account.tokenExpiresAt) return false;
      const expires = Date.parse(account.tokenExpiresAt);
      return Number.isFinite(expires) && expires - now <= stillValidMs;
    },
    inFlight: () => running.size,
    refresh: (account) => {
      const already = running.get(account.id);
      if (already) return already;
      const attempt = renew(account).finally(() => running.delete(account.id));
      running.set(account.id, attempt);
      return attempt;
    },
  };
}
