// Everything the gateway reads from its environment, resolved once at start.

import type { Strategy } from "./routing.js";

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  /** How the accounts inside one priority tier share the load. */
  strategy: Strategy;
  /** Admin token from the environment; null when the gateway must mint one and keep it in the DB. */
  adminToken: string | null;
  /** How long one upstream call may take before it is abandoned. */
  upstreamTimeoutMs: number;
  /** How many accounts a single client request may try before it gives up. */
  maxAttempts: number;
  /** Cooldown after a recoverable upstream failure (5xx, 429, network). */
  cooldownMs: number;
  /**
   * Cooldown after a connection never answered at all. Short on purpose: nothing about the
   * account was refused, and a single blip on the way out must not cost a minute of service.
   */
  transportCooldownMs: number;
  /**
   * Attempts one account gets when the connection itself fails. A flaky edge or an inspecting
   * proxy drops a request without answering; the same request usually goes through next try.
   */
  transportAttempts: number;
  /** Cooldown after an upstream rejection that will not fix itself (401, 403). */
  deadCooldownMs: number;
  /** How long the /v1/models union is cached. */
  catalogCacheMs: number;
  /** Proxy for upstream calls; when set, curl carries them (Node's fetch ignores proxy env). */
  outboundProxy: string | null;
  /** curl's path, used by the proxied transport. */
  curlBin: string;
  /** Dashboard sign-in; the default is a placeholder and is meant to be changed. */
  dashboardUser: string;
  dashboardPassword: string;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be a number >= ${min} (got ${JSON.stringify(raw)})`);
  }
  return value;
}

/** Whatever ships as a default is not a password: refuse the obvious ones off loopback. */
const PLACEHOLDER_PASSWORDS = ["admin", "password", "changeme", "change-me", "secret", "masantoid"];
const LOOPBACK_HOST = /^(127(?:\.\d{1,3}){3}|localhost|::1|\[::1\])$/;

/** True when the console would be reachable from outside this machine. */
export function exposedToNetwork(host: string): boolean {
  return !LOOPBACK_HOST.test(host.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const routing = (env.ROUTING ?? "").trim();
  if (routing && routing !== "round-robin" && routing !== "least-used") {
    throw new Error(`ROUTING must be round-robin or least-used (got ${JSON.stringify(routing)})`);
  }
  const host = env.HOST?.trim() || "127.0.0.1";
  // An empty or whitespace password in the environment means "not set", not "no password":
  // an empty one would otherwise be a valid session for anyone who finds the console.
  const givenPassword = env.DASHBOARD_PASSWORD;
  const dashboardPassword = givenPassword === undefined || givenPassword.trim() === "" ? "admin" : givenPassword;
  // A console that anyone on the network can sign into with the shipped password is worse
  // than not starting: it can create, edit and delete credentials.
  if (PLACEHOLDER_PASSWORDS.includes(dashboardPassword) && exposedToNetwork(host)) {
    throw new Error(
      `DASHBOARD_PASSWORD is still the placeholder ${JSON.stringify(dashboardPassword)} while HOST is ${host}: ` +
        "set a real password (or listen on 127.0.0.1) before the console is reachable from the network",
    );
  }
  return {
    host,
    port: num(env, "PORT", 8787, 0),
    dbPath: env.DB_PATH?.trim() || "data/gateway.db",
    strategy: routing === "least-used" ? "least-used" : "round-robin",
    adminToken: env.ADMIN_TOKEN?.trim() || null,
    upstreamTimeoutMs: num(env, "UPSTREAM_TIMEOUT_MS", 600_000, 1_000),
    maxAttempts: num(env, "MAX_ATTEMPTS", 3, 1),
    cooldownMs: num(env, "COOLDOWN_MS", 60_000, 0),
    transportCooldownMs: num(env, "TRANSPORT_COOLDOWN_MS", 5_000, 0),
    transportAttempts: num(env, "TRANSPORT_ATTEMPTS", 3, 1),
    deadCooldownMs: num(env, "DEAD_COOLDOWN_MS", 3_600_000, 0),
    catalogCacheMs: num(env, "CATALOG_CACHE_MS", 60_000, 0),
    outboundProxy:
      (env.UPSTREAM_PROXY || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || "").trim() || null,
    curlBin: env.CURL_BIN?.trim() || "curl",
    dashboardUser: env.DASHBOARD_USER?.trim() || "admin",
    dashboardPassword,
  };
}
