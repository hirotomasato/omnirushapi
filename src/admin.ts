// Admin API: accounts, client keys, usage. Guarded by the admin token, never exposed
// on the data plane.

import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  resetAccountCooldown,
  updateAccount,
  type AccountPatch,
} from "./accounts.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { DIALECTS, type Dialect } from "./dialects/index.js";
import type { QuotaRefresher } from "./quota.js";
import { createKey, deleteKey, listKeys, setKeyEnabled } from "./keys.js";
import { recentRequests, usageSummary, type UsageGroup } from "./usage.js";

export interface AdminDeps {
  db: Db;
  config: Config;
  /** Resolved at bootstrap: ADMIN_TOKEN or the token kept in settings. */
  adminToken: string;
  startedAt: number;
  version: string;
  /** Asks a provider what is left on an account. */
  quotas: QuotaRefresher;
}

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function givenToken(request: FastifyRequest): string | undefined {
  const header = request.headers["x-admin-token"];
  if (typeof header === "string" && header) return header;
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return undefined;
}

const ACCOUNT_BODY = {
  type: "object",
  required: ["label", "base_url", "api_key"],
  additionalProperties: false,
  properties: {
    label: { type: "string", minLength: 1, maxLength: 80 },
    base_url: { type: "string", minLength: 1 },
    api_key: { type: "string", minLength: 1 },
    provider: { type: "string", minLength: 1, maxLength: 40 },
    dialect: { type: "string", enum: [...DIALECTS] },
    force_stream: { type: "boolean" },
    strip_sampling: { type: "boolean" },
    refresh_token: { type: ["string", "null"] },
    token_expires_at: { type: ["string", "null"] },
    oauth_origin: { type: ["string", "null"] },
    priority: { type: "integer", minimum: 0 },
    weight: { type: "integer", minimum: 1 },
    quota_limit: { type: ["integer", "null"], minimum: 1 },
    quota_reset_at: { type: ["string", "null"] },
    extra_headers: { type: ["object", "null"], additionalProperties: { type: "string" } },
  },
} as const;

const PATCH_BODY = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    base_url: { type: "string", minLength: 1 },
    api_key: { type: "string", minLength: 1 },
    provider: { type: "string", minLength: 1, maxLength: 40 },
    dialect: { type: "string", enum: [...DIALECTS] },
    force_stream: { type: "boolean" },
    strip_sampling: { type: "boolean" },
    refresh_token: { type: ["string", "null"] },
    token_expires_at: { type: ["string", "null"] },
    oauth_origin: { type: ["string", "null"] },
    priority: { type: "integer", minimum: 0 },
    weight: { type: "integer", minimum: 1 },
    quota_limit: { type: ["integer", "null"], minimum: 1 },
    quota_reset_at: { type: ["string", "null"] },
    extra_headers: { type: ["object", "null"], additionalProperties: { type: "string" } },
    enabled: { type: "boolean" },
  },
} as const;

interface IdParams {
  id: number;
}

interface AccountBody {
  label: string;
  base_url: string;
  api_key: string;
  provider?: string;
  dialect?: Dialect;
  force_stream?: boolean;
  strip_sampling?: boolean;
  refresh_token?: string | null;
  token_expires_at?: string | null;
  oauth_origin?: string | null;
  priority?: number;
  weight?: number;
  quota_limit?: number | null;
  quota_reset_at?: string | null;
  extra_headers?: Record<string, string> | null;
}

interface AccountPatchBody {
  base_url?: string;
  api_key?: string;
  provider?: string;
  dialect?: Dialect;
  force_stream?: boolean;
  strip_sampling?: boolean;
  refresh_token?: string | null;
  token_expires_at?: string | null;
  oauth_origin?: string | null;
  priority?: number;
  weight?: number;
  quota_limit?: number | null;
  quota_reset_at?: string | null;
  extra_headers?: Record<string, string> | null;
  enabled?: boolean;
}

/** SQLite's `code` on a thrown constraint failure, when it has one. */
function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code: unknown = error.code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

/** The unique-constraint failure, which the API answers as a 409. */
function isUniqueViolation(error: unknown): boolean {
  return errorCode(error)?.startsWith("SQLITE_CONSTRAINT") ?? false;
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { db } = deps;

  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith("/admin/")) return;
    if (!tokenMatches(givenToken(request), deps.adminToken)) {
      await reply.status(401).send({ error: { type: "unauthorized", message: "Missing or wrong admin token" } });
      return reply;
    }
    return undefined;
  });

  app.get("/admin/health", async () => ({
    ok: true,
    version: deps.version,
    uptime_ms: Date.now() - deps.startedAt,
    accounts: listAccounts(db).length,
    keys: listKeys(db).length,
  }));

  app.get("/admin/accounts", async () => ({ data: listAccounts(db) }));

  app.post<{ Body: AccountBody }>("/admin/accounts", { schema: { body: ACCOUNT_BODY } }, async (request, reply) => {
    const body = request.body;
    try {
      const account = createAccount(db, {
        label: body.label,
        baseUrl: body.base_url,
        apiKey: body.api_key,
        provider: body.provider,
        dialect: body.dialect,
        forceStream: body.force_stream,
        stripSampling: body.strip_sampling,
        refreshToken: body.refresh_token ?? null,
        tokenExpiresAt: body.token_expires_at ?? null,
        oauthOrigin: body.oauth_origin ?? null,
        priority: body.priority,
        weight: body.weight,
        quotaLimit: body.quota_limit ?? null,
        quotaResetAt: body.quota_reset_at ?? null,
        extraHeaders: body.extra_headers ?? null,
      });
      return await reply.status(201).send({ data: account });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.status(409).send({ error: { type: "conflict", message: `label already used: ${body.label}` } });
      throw error;
    }
  });

  app.post<{ Params: IdParams }>("/admin/accounts/:id/quota", async (request, reply) => {
    const account = getAccount(db, request.params.id);
    if (!account) return reply.status(404).send({ error: { type: "not_found", message: "no such account" } });
    if (!deps.quotas.canRefresh(account)) {
      return reply.status(400).send({ error: { type: "unsupported", message: `${account.provider} does not report a quota` } });
    }
    return { data: await deps.quotas.refresh(account) };
  });

  app.get<{ Params: IdParams }>("/admin/accounts/:id", async (request, reply) => {
    const account = getAccount(db, request.params.id);
    if (!account) return reply.status(404).send({ error: { type: "not_found", message: "no such account" } });
    return { data: account };
  });

  app.patch<{ Params: IdParams; Body: AccountPatchBody }>("/admin/accounts/:id", { schema: { body: PATCH_BODY } }, async (request, reply) => {
    const body = request.body;
    const patch: AccountPatch = {
      baseUrl: body.base_url,
      apiKey: body.api_key,
      provider: body.provider,
      dialect: body.dialect,
      forceStream: body.force_stream,
      stripSampling: body.strip_sampling,
      refreshToken: body.refresh_token,
      tokenExpiresAt: body.token_expires_at,
      oauthOrigin: body.oauth_origin,
      priority: body.priority,
      weight: body.weight,
      quotaLimit: body.quota_limit,
      quotaResetAt: body.quota_reset_at,
      extraHeaders: body.extra_headers,
      enabled: body.enabled,
    };
    const account = updateAccount(db, request.params.id, patch);
    if (!account) return reply.status(404).send({ error: { type: "not_found", message: "no such account" } });
    return { data: account };
  });

  app.delete<{ Params: IdParams }>("/admin/accounts/:id", async (request, reply) => {
    if (!deleteAccount(db, request.params.id)) return reply.status(404).send({ error: { type: "not_found", message: "no such account" } });
    return { data: { deleted: request.params.id } };
  });

  app.post<{ Params: IdParams; Body: { enabled: boolean } }>(
    "/admin/accounts/:id/enable",
    { schema: { body: { type: "object", required: ["enabled"], additionalProperties: false, properties: { enabled: { type: "boolean" } } } } },
    async (request, reply) => {
      const account = updateAccount(db, request.params.id, { enabled: request.body.enabled });
      if (!account) return reply.status(404).send({ error: { type: "not_found", message: "no such account" } });
      return { data: account };
    },
  );

  app.post<{ Params: IdParams }>("/admin/accounts/:id/reset", async (request, reply) => {
    if (!resetAccountCooldown(db, request.params.id)) return reply.status(404).send({ error: { type: "not_found", message: "no such account" } });
    return { data: getAccount(db, request.params.id) };
  });

  app.get("/admin/keys", async () => ({ data: listKeys(db) }));

  app.post<{ Body: { name: string } }>(
    "/admin/keys",
    { schema: { body: { type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: "string", minLength: 1, maxLength: 80 } } } } },
    async (request, reply) => {
      try {
        const created = createKey(db, request.body.name);
        // The only time the secret is ever readable: it is stored as a hash.
        return await reply.status(201).send({ data: created.key, secret: created.secret });
      } catch (error) {
        if (isUniqueViolation(error)) return reply.status(409).send({ error: { type: "conflict", message: `name already used: ${request.body.name}` } });
        throw error;
      }
    },
  );

  app.delete<{ Params: IdParams }>("/admin/keys/:id", async (request, reply) => {
    if (!deleteKey(db, request.params.id)) return reply.status(404).send({ error: { type: "not_found", message: "no such key" } });
    return { data: { deleted: request.params.id } };
  });

  app.post<{ Params: IdParams; Body: { enabled: boolean } }>(
    "/admin/keys/:id/enable",
    { schema: { body: { type: "object", required: ["enabled"], additionalProperties: false, properties: { enabled: { type: "boolean" } } } } },
    async (request, reply) => {
      if (!setKeyEnabled(db, request.params.id, request.body.enabled)) return reply.status(404).send({ error: { type: "not_found", message: "no such key" } });
      return { data: listKeys(db).find((key) => key.id === request.params.id) ?? null };
    },
  );

  app.get<{ Querystring: { since?: string; group?: UsageGroup } }>(
    "/admin/usage",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            since: { type: "string" },
            group: { type: "string", enum: ["account", "key", "model"] },
          },
        },
      },
    },
    async (request) => {
      const group = request.query.group ?? "account";
      const since = request.query.since ?? new Date(Date.now() - 86_400_000).toISOString();
      return { since, group, data: usageSummary(db, since, group) };
    },
  );

  app.get<{ Querystring: { limit?: number } }>(
    "/admin/requests",
    { schema: { querystring: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 500 } } } } },
    async (request) => ({ data: recentRequests(db, request.query.limit ?? 50) }),
  );
}
