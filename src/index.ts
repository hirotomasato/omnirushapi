// Bootstrap: config, database, routes, listen, and a clean shutdown.

import { createRequire } from "node:module";
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { registerAdminRoutes } from "./admin.js";
import { loadConfig } from "./config.js";
import { createOutboundFetch, nativeFetch } from "./curl.js";
import { registerConsole } from "./console/index.js";
import { openDb, resolveAdminToken } from "./db.js";
import { registerDataPlane } from "./openai.js";
import { createCatalogSource } from "./models.js";
import { createQuotaRefresher } from "./quota.js";
import { createTokenRefresher } from "./refresh.js";
import { createRouteState } from "./routing.js";

const require = createRequire(import.meta.url);

function packageVersion(): string {
  const meta: unknown = require("../package.json");
  if (typeof meta === "object" && meta !== null && "version" in meta && typeof meta.version === "string") return meta.version;
  return "0.0.0";
}

const config = loadConfig();
const db = openDb(config.dbPath);
const { token: adminToken, minted } = resolveAdminToken(db, config.adminToken);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL?.trim() || "info" } });

app.setErrorHandler(async (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
  const status = error.statusCode ?? 500;
  if (status >= 500) request.log.error({ err: error }, "request failed");
  await reply.status(status).send({
    error: { type: error.name, message: error.message, ...(error.validation ? { validation: error.validation } : {}) },
  });
});

// Everything that leaves this process — the data plane, token renewal, quota checks — uses
// one route out, so a proxy is configured once.
const transport = config.outboundProxy ? createOutboundFetch({ bin: config.curlBin, proxy: config.outboundProxy }) : nativeFetch;
// The refresher talks to the same providers the data plane does, so it uses the same route out.
const refresher = createTokenRefresher({ db, transport });
// The provider's own quota, asked for on the console's behalf (cached, never on the hot path).
const quotas = createQuotaRefresher({ db, transport, refresher });
// One catalog for the data plane and the console, so an upstream is asked once per ttl.
const catalogSource = createCatalogSource({ db, transport, timeoutMs: config.upstreamTimeoutMs, ttlMs: config.catalogCacheMs });

registerAdminRoutes(app, { db, config, adminToken, startedAt: Date.now(), version: packageVersion(), quotas });

// The data plane keeps request bodies as raw bytes, so it lives in its own scope: the
// admin routes must keep the standard JSON parser.
await app.register(async (scope) => {
  registerDataPlane(scope, { db, config, routeState: createRouteState(), transport, refresher, catalogSource });
});

// The dashboard has its own body parser (form posts) and its own cookie session.
await app.register(async (scope) => {
  registerConsole(scope, { db, config, adminToken, startedAt: Date.now(), version: packageVersion(), transport, quotas, catalogSource });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}

const address = await app.listen({ host: config.host, port: config.port });
console.log(`omnirushapi ${packageVersion()} listening on ${address}`);
console.log(`  data plane : ${address}/v1   (Authorization: Bearer <gateway key>)`);
console.log(`  admin API  : ${address}/admin (x-admin-token: <admin token>)`);
console.log(`  database   : ${config.dbPath}   routing: ${config.strategy}`);
console.log(`  egress     : ${config.outboundProxy ? `via ${config.outboundProxy} (curl)` : "direct"}`);
if (minted) console.log(`  admin token (minted, kept in the database): ${adminToken}`);
