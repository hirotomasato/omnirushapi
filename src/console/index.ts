// The console: sessions, pages and actions, one route each.
//
// Posts never render a page. They act, then send the browser to a GET (303), which is why a
// reload after an action does not repeat it. Feedback travels in the query string, so it
// survives a process restart, and the page strips it from the address bar once shown.

import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createAccount,
  deleteAccount,
  listAccounts,
  resetAccountCooldown,
  updateAccount,
  type AccountPatch,
} from "../accounts.js";
import { DIALECTS } from "../dialects/index.js";
import { FAVICON_SVG, faviconPng } from "../favicon.js";
import { createKey, deleteKey, listKeys, setKeyEnabled } from "../keys.js";
import { beginDeviceLogin, checkDeviceLogin, PROVIDERS, type DeviceLogin, type ProviderPreset, withOrigin } from "../providers.js";
import { optionalNumber, parseExtraHeaders } from "./tables.js";
import { accountsPage, keysPage, modelsPage, overviewPage, requestsPage, usagePage, type ConsoleDeps, type Flash, type PageMeta } from "./pages.js";
import { escapeHtml, formatNumber, loginPage, sendPage, type WaitingLogin } from "./shell.js";

const COOKIE = "gw_session";
const COOKIE_ATTRS = "HttpOnly; SameSite=Strict; Path=/";

/** The values a browser submits for a checked box, whichever flavour of HTML wrote it. */
const CHECKED_VALUES = ["1", "on", "true", "yes"];

/** Form posts arrive as urlencoded strings; every field may be missing. */
type FormBody = Record<string, string>;
type Query = Record<string, string | undefined>;

/** A device login somebody started in the console, waiting for its browser approval. */
interface PendingLogin {
  preset: ProviderPreset;
  login: DeviceLogin;
  label: string;
  expiresAt: number;
}

/** Constant-time compare: hashing both sides first keeps the length of the secret out of the timing. */
function safeEqual(given: string, expected: string): boolean {
  return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());
}

function cookieValue(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerConsole(app: FastifyInstance, deps: ConsoleDeps): void {
  // The cookie binds the credentials to the admin token: rotating the token logs everyone out.
  const session = createHash("sha256")
    .update(`${deps.config.dashboardUser}\u0000${deps.config.dashboardPassword}\u0000${deps.adminToken}`)
    .digest("hex");

  // Fastify parses no urlencoded bodies by default; these forms are plain HTML posts, and
  // the admin API in its own scope keeps the standard JSON parser.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    const parsed: FormBody = {};
    for (const [key, value] of new URLSearchParams(String(body))) parsed[key] = value;
    done(null, parsed);
  });

  // Browsers ask for this unprompted and without credentials, so it is registered above the
  // session check and carries no state. /favicon.ico carries real image bytes because that is
  // what browsers expect at the conventional path; the SVG is offered alongside it.
  app.get("/favicon.ico", async (_request, reply) =>
    reply.type("image/png").header("cache-control", "public, max-age=86400").send(faviconPng()),
  );
  app.get("/favicon.svg", async (_request, reply) =>
    reply.type("image/svg+xml").header("cache-control", "public, max-age=86400").send(FAVICON_SVG),
  );

  /** The browser cookie, or the admin token when a script drives the UI. */
  const signedIn = (request: FastifyRequest): boolean => {
    if (cookieValue(request, COOKIE) === session) return true;
    const token = request.headers["x-admin-token"];
    return typeof token === "string" && safeEqual(token, deps.adminToken);
  };

  const requireSession = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (signedIn(request)) return;
    await sendPage(reply.status(401), loginPage(deps.version, false));
  };

  // A login started in the console lives here until its browser approval arrives, keyed by
  // the session so two browsers never share a flow. The page's own refresh is the poll.
  const pendingLogins = new Map<string, PendingLogin>();
  // A freshly minted key secret, held just long enough to be shown once on the next page.
  const pendingSecrets = new Map<string, string>();

  const flashOf = (query: Query): Flash | null =>
    typeof query.flash === "string" && query.flash !== "" ? { kind: query.kind === "bad" ? "bad" : "ok", text: query.flash } : null;

  const go = (reply: FastifyReply, path: string, kind: Flash["kind"], text: string | null = null): FastifyReply =>
    reply.header("cache-control", "no-store").redirect(text === null ? path : `${path}?flash=${encodeURIComponent(text)}&kind=${kind}`, 303);

  const send = (reply: FastifyReply, html: string): FastifyReply => sendPage(reply.header("cache-control", "no-store"), html);

  /** Providers are asked in the background: a slow one never holds a page. */
  const refreshStaleQuotas = (): void => {
    for (const account of listAccounts(deps.db)) {
      if (deps.quotas.canRefresh(account) && deps.quotas.isStale(account)) void deps.quotas.refresh(account).catch(() => undefined);
    }
  };

  /** Finished device logins become (or update) an account; this is the poll's other half. */
  const settlePendingLogin = async (key: string): Promise<{ flash: Flash | null; waiting: WaitingLogin | null }> => {
    const pending = pendingLogins.get(key);
    if (!pending) return { flash: null, waiting: null };
    const expired: Flash = { kind: "bad", text: `The ${pending.preset.id} code expired — start the login again.` };
    if (Date.now() > pending.expiresAt) {
      pendingLogins.delete(key);
      return { flash: expired, waiting: null };
    }
    try {
      const check = await checkDeviceLogin(pending.preset, { transport: deps.transport, deviceCode: pending.login.deviceCode });
      if (check.state === "pending") {
        return {
          flash: null,
          waiting: {
            label: pending.preset.label,
            userCode: pending.login.userCode,
            verificationUriComplete: pending.login.verificationUriComplete,
            expiresAt: pending.expiresAt,
            expiresInSec: pending.login.intervalSec,
          },
        };
      }
      pendingLogins.delete(key);
      if (check.state === "expired") return { flash: expired, waiting: null };

      const fields: AccountPatch = {
        provider: pending.preset.id,
        dialect: pending.preset.dialect,
        forceStream: pending.preset.forceStream,
        stripSampling: pending.preset.stripSampling,
        baseUrl: `${pending.preset.origin}${pending.preset.apiBase}`,
        apiKey: check.tokens.accessToken,
        refreshToken: check.tokens.refreshToken,
        tokenExpiresAt: check.tokens.expiresInSec === null ? null : new Date(Date.now() + check.tokens.expiresInSec * 1_000).toISOString(),
        oauthOrigin: pending.preset.origin,
        extraHeaders: pending.preset.accountHeaders,
      };
      const existing = listAccounts(deps.db).find((account) => account.label === pending.label);
      const account = existing
        ? updateAccount(deps.db, existing.id, fields)
        : createAccount(deps.db, { label: pending.label, baseUrl: fields.baseUrl ?? "", apiKey: fields.apiKey ?? "", ...fields });
      return {
        flash: { kind: "ok", text: `${existing ? "Signed in again:" : "Signed in:"} account "${account?.label ?? pending.label}" on ${pending.preset.label} — it renews itself.` },
        waiting: null,
      };
    } catch (error) {
      pendingLogins.delete(key);
      return { flash: { kind: "bad", text: `The login could not be finished: ${errorMessage(error)}` }, waiting: null };
    }
  };

  /** The frame every page is rendered into: session state in, one page out. */
  const meta = (query: Query, secret: string | null, waiting: WaitingLogin | null, refreshSeconds: number | null): PageMeta => {
    return { flash: flashOf(query), secret, waiting, refreshSeconds: secret === null ? refreshSeconds : null, hint: hintOf(secret, waiting, refreshSeconds) };
  };

  function hintOf(secret: string | null, waiting: WaitingLogin | null, refreshSeconds: number | null): string {
    if (secret !== null) return "holds a new key — no auto-refresh";
    if (waiting !== null) return "waiting for approval";
    return refreshSeconds === null ? "static page" : `auto-refresh ${refreshSeconds}s`;
  }

  /** Pull the one-shot secret out of the session, so a refresh cannot show it twice. */
  const takeSecret = (key: string): string | null => {
    const secret = pendingSecrets.get(key);
    if (secret !== undefined) pendingSecrets.delete(key);
    return secret ?? null;
  };

  // --- pages -----------------------------------------------------------------------------

  app.get<{ Querystring: Query }>("/dashboard", { preHandler: requireSession }, async (request, reply) => {
    refreshStaleQuotas();
    const settled = await settlePendingLogin(session);
    return send(reply, overviewPage(deps, { ...meta(request.query, takeSecret(session), settled.waiting, 15), flash: settled.flash ?? flashOf(request.query) }));
  });

  app.get<{ Querystring: Query }>("/dashboard/accounts", { preHandler: requireSession }, async (request, reply) => {
    refreshStaleQuotas();
    const settled = await settlePendingLogin(session);
    const secret = takeSecret(session);
    return send(reply, accountsPage(deps, { ...meta(request.query, secret, settled.waiting, settled.waiting === null ? 15 : 3), flash: settled.flash ?? flashOf(request.query) }));
  });

  app.get<{ Querystring: Query }>("/dashboard/models", { preHandler: requireSession }, async (request, reply) => {
    // The catalog the data plane serves is the same object, so this is at most one ask per ttl.
    const catalog = await deps.catalogSource.get();
    return send(reply, modelsPage(deps, meta(request.query, takeSecret(session), null, 15), catalog));
  });

  app.get<{ Querystring: Query }>("/dashboard/keys", { preHandler: requireSession }, async (request, reply) => {
    const secret = takeSecret(session);
    return send(reply, keysPage(deps, meta(request.query, secret, null, 15)));
  });

  app.get<{ Querystring: Query }>("/dashboard/usage", { preHandler: requireSession }, async (request, reply) => {
    const hours = Math.min(24 * 30, Math.max(1, optionalNumber(request.query.hours) ?? 24));
    return send(reply, usagePage(deps, meta(request.query, takeSecret(session), null, 15), hours));
  });

  app.get<{ Querystring: Query }>("/dashboard/requests", { preHandler: requireSession }, async (request, reply) => {
    const limit = Math.min(1_000, Math.max(10, optionalNumber(request.query.limit) ?? 100));
    return send(reply, requestsPage(deps, meta(request.query, takeSecret(session), null, 15), limit, request.query.errors === "1"));
  });

  // --- session ---------------------------------------------------------------------------

  app.get("/", async (request, reply) => {
    if (signedIn(request)) return reply.redirect("/dashboard", 303);
    return send(reply, loginPage(deps.version, false));
  });

  app.post<{ Body: FormBody }>("/login", async (request, reply) => {
    const form = request.body ?? {};
    // Both sides are hashed first, so neither the comparison nor the length of the
    // submitted value leaks anything about the configured ones.
    if (!safeEqual(form.user ?? "", deps.config.dashboardUser) || !safeEqual(form.password ?? "", deps.config.dashboardPassword)) {
      return send(reply.status(401), loginPage(deps.version, true));
    }
    return reply.header("set-cookie", `${COOKIE}=${session}; ${COOKIE_ATTRS}`).redirect("/dashboard", 303);
  });

  app.post("/logout", async (_request, reply) =>
    reply.header("set-cookie", `${COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`).redirect("/", 303),
  );

  // --- provider sign-in ------------------------------------------------------------------

  app.post<{ Params: { id: string }; Body: FormBody }>("/dashboard/accounts/providers/:id/start", { preHandler: requireSession }, async (request, reply) => {
    const base = PROVIDERS[request.params.id];
    if (!base) return go(reply, "/dashboard/accounts", "bad", `Unknown provider ${request.params.id}.`);
    const form = request.body ?? {};
    const origin = form.origin?.trim();
    const preset = origin ? withOrigin(base, origin) : base;
    const label = form.label?.trim() || preset.id;
    try {
      const login = await beginDeviceLogin(preset, { transport: deps.transport });
      pendingLogins.set(session, { preset, login, label, expiresAt: Date.now() + login.expiresInSec * 1_000 });
      return go(reply, "/dashboard/accounts", "ok", `Open the approval page below for ${preset.label}.`);
    } catch (error) {
      return go(reply, "/dashboard/accounts", "bad", errorMessage(error));
    }
  });

  // --- accounts --------------------------------------------------------------------------

  app.post<{ Body: FormBody }>("/dashboard/accounts", { preHandler: requireSession }, async (request, reply) => {
    const form = request.body ?? {};
    try {
      const account = createAccount(deps.db, {
        label: form.label ?? "",
        baseUrl: form.base_url ?? "",
        apiKey: form.api_key ?? "",
        provider: form.provider,
        dialect: DIALECTS.find((dialect) => dialect === form.dialect),
        forceStream: CHECKED_VALUES.includes(form.force_stream ?? ""),
        stripSampling: CHECKED_VALUES.includes(form.strip_sampling ?? ""),
        priority: optionalNumber(form.priority),
        weight: optionalNumber(form.weight),
        quotaLimit: optionalNumber(form.quota_limit) ?? null,
        quotaResetAt: form.quota_reset_at?.trim() || null,
        extraHeaders: parseExtraHeaders(form.extra_headers) ?? null,
      });
      return go(reply, "/dashboard/accounts", "ok", `Added account ${account.label}.`);
    } catch (error) {
      return go(reply, "/dashboard/accounts", "bad", errorMessage(error));
    }
  });

  app.post<{ Params: { id: string }; Body: FormBody }>("/dashboard/accounts/:id", { preHandler: requireSession }, async (request, reply) => {
    const id = Number(request.params.id);
    const form = request.body ?? {};
    try {
      // Only fields the form actually sent are touched, so a partial post cannot silently
      // blank out a checkbox that was never rendered.
      const updated = updateAccount(deps.db, id, {
        baseUrl: form.base_url?.trim() || undefined,
        apiKey: form.api_key?.trim() || undefined,
        provider: form.provider?.trim() || undefined,
        // An unknown or blank dialect on a partial post leaves the stored one alone.
        dialect: DIALECTS.find((dialect) => dialect === form.dialect),
        forceStream: "force_stream" in form ? CHECKED_VALUES.includes(form.force_stream ?? "") : undefined,
        stripSampling: "strip_sampling" in form ? CHECKED_VALUES.includes(form.strip_sampling ?? "") : undefined,
        priority: optionalNumber(form.priority),
        weight: optionalNumber(form.weight),
        quotaLimit: optionalNumber(form.quota_limit),
        quotaResetAt: form.quota_reset_at?.trim() || undefined,
        extraHeaders: parseExtraHeaders(form.extra_headers),
        enabled: "enabled" in form ? CHECKED_VALUES.includes(form.enabled ?? "") : undefined,
      });
      if (!updated) return go(reply, "/dashboard/accounts", "bad", "No such account.");
      return go(reply, "/dashboard/accounts", "ok", `Saved account ${updated.label}.`);
    } catch (error) {
      return go(reply, "/dashboard/accounts", "bad", errorMessage(error));
    }
  });

  const ACCOUNT_ACTIONS: Record<string, (id: number, form: FormBody) => string | null> = {
    enable: (id, form) => (updateAccount(deps.db, id, { enabled: (form.enabled ?? "1") === "1" }) ? null : "No such account."),
    reset: (id) => (resetAccountCooldown(deps.db, id) ? null : "No such account."),
    delete: (id) => (deleteAccount(deps.db, id) ? null : "No such account."),
  };
  for (const [action, run] of Object.entries(ACCOUNT_ACTIONS)) {
    app.post<{ Params: { id: string }; Body: FormBody }>(`/dashboard/accounts/:id/${action}`, { preHandler: requireSession }, async (request, reply) => {
      const failure = run(Number(request.params.id), request.body ?? {});
      return failure ? go(reply, "/dashboard/accounts", "bad", failure) : go(reply, "/dashboard/accounts", "ok", `Account ${request.params.id}: ${action} done.`);
    });
  }

  app.post<{ Params: { id: string }; Body: FormBody }>("/dashboard/accounts/:id/quota", { preHandler: requireSession }, async (request, reply) => {
    const account = listAccounts(deps.db).find((entry) => String(entry.id) === request.params.id);
    if (!account) return go(reply, "/dashboard/accounts", "bad", "No such account.");
    if (!deps.quotas.canRefresh(account)) return go(reply, "/dashboard/accounts", "bad", `${account.provider} does not report a quota.`);
    const snapshot = await deps.quotas.refresh(account);
    return snapshot.error
      ? go(reply, "/dashboard/accounts", "bad", `The quota could not be read: ${snapshot.error}`)
      : go(
          reply,
          "/dashboard/accounts",
          "ok",
          `Quota for ${account.label}: ${formatNumber(snapshot.used ?? 0)} of ${snapshot.limit === null ? "∞" : formatNumber(snapshot.limit)} used today${snapshot.pot === null ? "" : ` · pot ${formatNumber(snapshot.pot)}`}.`,
        );
  });

  // --- keys ------------------------------------------------------------------------------

  app.post<{ Body: FormBody }>("/dashboard/keys", { preHandler: requireSession }, async (request, reply) => {
    try {
      const created = createKey(deps.db, (request.body ?? {}).name ?? "");
      // Held in memory, not in the URL: a credential does not belong in history or a bookmark.
      pendingSecrets.set(session, created.secret);
      return go(reply, "/dashboard/keys", "ok", `Created key ${created.key.name}.`);
    } catch (error) {
      return go(reply, "/dashboard/keys", "bad", errorMessage(error));
    }
  });

  const KEY_ACTIONS: Record<string, (id: number, form: FormBody) => string | null> = {
    enable: (id, form) => (setKeyEnabled(deps.db, id, (form.enabled ?? "1") === "1") ? null : "No such key."),
    delete: (id) => (deleteKey(deps.db, id) ? null : "No such key."),
  };
  for (const [action, run] of Object.entries(KEY_ACTIONS)) {
    app.post<{ Params: { id: string }; Body: FormBody }>(`/dashboard/keys/:id/${action}`, { preHandler: requireSession }, async (request, reply) => {
      const failure = run(Number(request.params.id), request.body ?? {});
      return failure ? go(reply, "/dashboard/keys", "bad", failure) : go(reply, "/dashboard/keys", "ok", `Key ${request.params.id}: ${action} done.`);
    });
  }

  // --- catalog ---------------------------------------------------------------------------

  app.post("/dashboard/models/refresh", { preHandler: requireSession }, async (_request, reply) => {
    try {
      const catalog = await deps.catalogSource.get(true);
      return go(reply, "/dashboard/models", "ok", `${catalog.entries.length} model${catalog.entries.length === 1 ? "" : "s"}${catalog.failures.length === 0 ? "" : ` · ${catalog.failures.length} account(s) did not answer: ${escapeHtml(catalog.failures[0]?.error ?? "")}`}.`);
    } catch (error) {
      return go(reply, "/dashboard/models", "bad", errorMessage(error));
    }
  });
}
