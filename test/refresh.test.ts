// The refresher is the piece with a rule behind it: providers rotate both tokens, and a
// second presentation of a superseded refresh token is what they treat as a shared
// credential. So a test that three concurrent callers cause ONE refresh is the point.
//
// The overlap is held open by a gate the test releases, not by a sleep: nothing here
// depends on how long anything takes.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createAccount, getAccount } from "../src/accounts.js";
import type { UpstreamFetch } from "../src/curl.js";
import { openDb } from "../src/db.js";
import { createTokenRefresher } from "../src/refresh.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Stub {
  transport: UpstreamFetch;
  calls: { url: string; body: unknown }[];
  /** Resolves once an attempt is inside the manager, so the test can assert on a real signal. */
  entered: Promise<void>;
  /** Lets a held attempt finish. */
  release: () => void;
}

/** A manager that hands out a fresh pair per refresh, optionally refusing or holding the call. */
function stubManager(options: { refuse?: number; hold?: boolean } = {}): Stub {
  const calls: { url: string; body: unknown }[] = [];
  const hold = options.hold ? Promise.withResolvers<void>() : null;
  const entered = Promise.withResolvers<void>();
  let announced = false;
  let issued = 0;
  const transport: UpstreamFetch = async (url, init) => {
    const parsed: unknown = init.body ? JSON.parse(init.body.toString("utf8")) : null;
    calls.push({ url, body: parsed });
    if (!announced) {
      announced = true;
      entered.resolve();
    }
    if (hold) await hold.promise;
    if (options.refuse) return json({ detail: "refresh_token_invalid_or_expired" }, options.refuse);
    issued += 1;
    return json({ access_token: `at-${issued}`, refresh_token: `rt-${issued}`, expires_in: 3600 });
  };
  return { transport, calls, entered: entered.promise, release: () => hold?.resolve() };
}

function seed(refreshToken: string | null, tokenExpiresAt: string | null) {
  const db = openDb(":memory:");
  const account = createAccount(db, {
    label: "omnirush",
    provider: "omnirush",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "at-0",
    refreshToken,
    tokenExpiresAt,
    oauthOrigin: "http://127.0.0.1:9/manager",
  });
  return { db, account };
}

test("a refresh rotates the pair and stores the new expiry", async () => {
  const { db, account } = seed("rt-0", null);
  const manager = stubManager();
  const refresher = createTokenRefresher({ db, transport: manager.transport });

  const outcome = await refresher.refresh(account);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.accessToken, "at-1");
  assert.equal(manager.calls.length, 1);
  assert.deepEqual(manager.calls[0]?.body, { refresh_token: "rt-0" });
  assert.match(manager.calls[0]?.url ?? "", /\/device\/refresh$/);

  const stored = getAccount(db, account.id);
  assert.equal(stored?.apiKey, "at-1");
  assert.equal(stored?.refreshToken, "rt-1");
  assert.equal(stored?.status, "ready");
  assert.ok(stored?.tokenExpiresAt);
  db.close();
});

test("three concurrent callers share one refresh", async () => {
  const { db, account } = seed("rt-0", null);
  const manager = stubManager({ hold: true });
  const refresher = createTokenRefresher({ db, transport: manager.transport });

  const pending = [refresher.refresh(account), refresher.refresh(account), refresher.refresh(account)];
  await manager.entered;
  assert.equal(manager.calls.length, 1, "only the first caller may reach the manager");
  assert.equal(refresher.inFlight(), 1);

  manager.release();
  const outcomes = await Promise.all(pending);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.accessToken),
    ["at-1", "at-1", "at-1"],
  );
  assert.equal(manager.calls.length, 1, "the manager must not see a second presentation");
  assert.equal(refresher.inFlight(), 0);
  db.close();
});

test("a later refresh starts fresh once the first one settled", async () => {
  const { db, account } = seed("rt-0", null);
  const manager = stubManager();
  const refresher = createTokenRefresher({ db, transport: manager.transport });

  await refresher.refresh(account);
  const second = getAccount(db, account.id);
  assert.ok(second);
  const outcome = await refresher.refresh(second);
  assert.equal(outcome.accessToken, "at-2");
  assert.equal(manager.calls.length, 2);
  db.close();
});

test("a snapshot that is already superseded adopts the stored pair", async () => {
  const { db, account } = seed("rt-0", null);
  const manager = stubManager();
  const refresher = createTokenRefresher({ db, transport: manager.transport });

  const first = await refresher.refresh(account);
  assert.equal(first.accessToken, "at-1");
  // The same stale snapshot again: the stored pair has moved on, so nothing is presented.
  const fromStaleSnapshot = await refresher.refresh(account);
  assert.equal(fromStaleSnapshot.ok, true);
  assert.equal(fromStaleSnapshot.accessToken, "at-1");
  assert.equal(manager.calls.length, 1, "a superseded snapshot must not reach the manager");

  // A genuinely current snapshot does refresh again.
  const current = getAccount(db, account.id);
  assert.ok(current);
  const later = await refresher.refresh(current);
  assert.equal(later.accessToken, "at-2");
  assert.equal(manager.calls.length, 2);
  db.close();
});

test("a refused refresh keeps what was stored and reports why", async () => {
  const { db, account } = seed("rt-0", null);
  const manager = stubManager({ refuse: 401 });
  const refresher = createTokenRefresher({ db, transport: manager.transport });

  const outcome = await refresher.refresh(account);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /refresh_token_invalid_or_expired/);
  const stored = getAccount(db, account.id);
  assert.equal(stored?.apiKey, "at-0");
  assert.equal(stored?.refreshToken, "rt-0");
  db.close();
});

test("an account without a refresh token is left alone", async () => {
  const { db, account } = seed(null, null);
  const manager = stubManager();
  const refresher = createTokenRefresher({ db, transport: manager.transport });

  assert.equal(refresher.canRefresh(account), false);
  const outcome = await refresher.refresh(account);
  assert.equal(outcome.ok, false);
  assert.equal(manager.calls.length, 0);
  db.close();
});

test("staleness is only claimed when the provider said when the token ends", () => {
  const { db, account } = seed("rt-0", null);
  const refresher = createTokenRefresher({ db, transport: stubManager().transport });
  const now = Date.parse("2026-10-26T00:00:00.000Z");

  assert.equal(refresher.isStale({ ...account, tokenExpiresAt: null }, now), false);
  assert.equal(refresher.isStale({ ...account, tokenExpiresAt: new Date(now + 600_000).toISOString() }, now), false);
  assert.equal(refresher.isStale({ ...account, tokenExpiresAt: new Date(now + 10_000).toISOString() }, now), true);
  assert.equal(refresher.isStale({ ...account, tokenExpiresAt: new Date(now - 1).toISOString() }, now), true);
  db.close();
});
