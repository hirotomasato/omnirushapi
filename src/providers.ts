// Provider presets and the device-flow login they use.
//
// A login that opens the browser once and hands the gateway tokens is the difference
// between "paste a key" and a gateway someone can hand to a colleague. The refresh token
// comes along, so the account keeps working after the access token expires.

import { spawn } from "node:child_process";
import os from "node:os";
import type { UpstreamFetch } from "./curl.js";
import type { Dialect } from "./dialects/index.js";

export interface ProviderPreset {
  id: string;
  /** Human name for the console and the CLI. */
  label: string;
  /** Where the provider's manager lives; the gateway base is `${origin}/v1`. */
  origin: string;
  /** The version segment the account's base URL ends with. */
  apiBase: string;
  dialect: Dialect;
  /** True when the upstream only answers streamed requests. */
  forceStream: boolean;
  /** True when the upstream refuses temperature/top_p (measured: omnirush answers 400). */
  stripSampling: boolean;
  /** Headers the upstream demands on every model call (some gateways identify clients). */
  accountHeaders: Record<string, string>;
  /** Headers the manager's device endpoints expect. */
  managerHeaders: Record<string, string>;
  /** Paths under the origin, relative and absolute both fine. */
  paths: { authorize: string; token: string; refresh: string };
  /** Where the manager reports this account's quota, when it does. */
  usagePath: string | null;
}

const OMNI_CLIENT_VERSION = "2.7.0";

export const PROVIDERS: Record<string, ProviderPreset> = {
  omnirush: {
    id: "omnirush",
    label: "omnirush.ai (free daily tokens)",
    origin: "https://omnirush.ai/omnirush",
    apiBase: "/v1",
    dialect: "openai-responses",
    // Measured: this upstream serves only the Responses API, only streamed, and only to a
    // client whose User-Agent is the bare product name.
    forceStream: true,
    // "Unsupported parameter: temperature" — the backend refuses them, so they are dropped.
    stripSampling: true,
    accountHeaders: { "user-agent": "omnirush", "x-omnirush-client": `cli/${OMNI_CLIENT_VERSION}` },
    managerHeaders: {
      "user-agent": `omnirush/${OMNI_CLIENT_VERSION} (${process.platform}; ${process.arch === "x64" ? "x64" : process.arch})`,
      "x-omnirush-client": `cli/${OMNI_CLIENT_VERSION}`,
    },
    paths: { authorize: "/device/authorize", token: "/device/token", refresh: "/device/refresh" },
    // GET /device/me answers with the device identity *and* the account's usage box.
    usagePath: "/device/me",
  },
};

export function providerPreset(id: string): ProviderPreset {
  const preset = PROVIDERS[id];
  if (!preset) throw new Error(`unknown provider ${JSON.stringify(id)} — known: ${Object.keys(PROVIDERS).join(", ")}`);
  return preset;
}

/** A preset with the origin (and thus every URL) pointed somewhere else, for tests or a self-hosted manager. */
export function withOrigin(preset: ProviderPreset, origin: string): ProviderPreset {
  return { ...preset, origin: origin.replace(/\/+$/, "") };
}

export interface DeviceLogin {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresInSec: number;
  intervalSec: number;
}

export interface LoginTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Seconds the access token stays valid, when the manager says. */
  expiresInSec: number | null;
  gatewayUrl: string | null;
}

async function postJson(
  transport: UpstreamFetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; payload: Record<string, unknown> | null }> {
  const response = await transport(url, {
    method: "POST",
    headers: new Headers({ ...headers, "content-type": "application/json", accept: "application/json" }),
    body: Buffer.from(JSON.stringify(body)),
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  return { status: response.status, payload: typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null };
}

function text(payload: Record<string, unknown> | null, key: string): string {
  const value = payload?.[key];
  return typeof value === "string" ? value : "";
}

function count(payload: Record<string, unknown> | null, key: string): number | null {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Step one: a code the person approves in their browser. */
export async function beginDeviceLogin(
  preset: ProviderPreset,
  options: { transport: UpstreamFetch; deviceName?: string },
): Promise<DeviceLogin> {
  const { status, payload } = await postJson(
    options.transport,
    `${preset.origin}${preset.paths.authorize}`,
    preset.managerHeaders,
    { device_name: options.deviceName ?? os.hostname().split(".")[0] ?? "omnirushapi", platform: process.platform },
  );
  if (status !== 200 || !payload) throw new Error(`${preset.id}: authorize failed (HTTP ${status}) ${JSON.stringify(payload)}`);
  const deviceCode = text(payload, "device_code");
  const userCode = text(payload, "user_code");
  if (!deviceCode || !userCode) throw new Error(`${preset.id}: authorize answer had no code: ${JSON.stringify(payload)}`);
  return {
    deviceCode,
    userCode,
    verificationUri: text(payload, "verification_uri") || preset.origin,
    verificationUriComplete: text(payload, "verification_uri_complete") || text(payload, "verification_uri") || preset.origin,
    expiresInSec: count(payload, "expires_in") ?? 600,
    intervalSec: Math.max(1, count(payload, "interval") ?? 5),
  };
}

export type DeviceCheck = { state: "pending" } | { state: "approved"; tokens: LoginTokens } | { state: "expired" };

/**
 * One look at the token endpoint. The CLI drives its own polling loop with this; the console
 * calls it once per render, so a page that refreshes itself *is* the poll.
 */
export async function checkDeviceLogin(
  preset: ProviderPreset,
  options: { transport: UpstreamFetch; deviceCode: string; signal?: AbortSignal },
): Promise<DeviceCheck> {
  const { status, payload } = await postJson(
    options.transport,
    `${preset.origin}${preset.paths.token}`,
    preset.managerHeaders,
    { device_code: options.deviceCode },
    options.signal,
  );
  if (status === 200) {
    const accessToken = text(payload, "access_token");
    if (!accessToken) throw new Error(`${preset.id}: approval carried no access token: ${JSON.stringify(payload)}`);
    return {
      state: "approved",
      tokens: {
        accessToken,
        refreshToken: text(payload, "refresh_token") || null,
        expiresInSec: count(payload, "expires_in"),
        gatewayUrl: text(payload, "gateway_url") || null,
      },
    };
  }
  if (status === 428) return { state: "pending" };
  if (status === 400 && text(payload, "detail").includes("expired")) return { state: "expired" };
  throw new Error(`${preset.id}: waiting for approval failed (HTTP ${status}) ${JSON.stringify(payload)}`);
}

/** Step two: wait for the approval. 428 means "keep waiting". */
export async function pollDeviceLogin(
  preset: ProviderPreset,
  options: {
    transport: UpstreamFetch;
    deviceCode: string;
    intervalSec: number;
    expiresAt: number;
    sleep?: (ms: number) => Promise<void>;
    onWait?: (round: number) => void;
    signal?: AbortSignal;
  },
): Promise<LoginTokens> {
  const sleep =
    options.sleep ??
    ((ms: number) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    });
  for (let round = 1; ; round += 1) {
    if (Date.now() > options.expiresAt) throw new Error(`${preset.id}: the code expired before it was approved`);
    const check = await checkDeviceLogin(preset, options);
    if (check.state === "approved") return check.tokens;
    if (check.state === "expired") throw new Error(`${preset.id}: the code expired before it was approved`);
    options.onWait?.(round);
    await sleep(options.intervalSec * 1_000);
  }
}

/** Rotating both tokens is the provider's rule; the caller must serialise this per account. */
export async function refreshDeviceTokens(
  preset: ProviderPreset,
  options: { transport: UpstreamFetch; refreshToken: string; origin?: string },
): Promise<LoginTokens> {
  const origin = (options.origin ?? preset.origin).replace(/\/+$/, "");
  const { status, payload } = await postJson(
    options.transport,
    `${origin}${preset.paths.refresh}`,
    preset.managerHeaders,
    { refresh_token: options.refreshToken },
  );
  if (status !== 200 || !payload) {
    const detail = text(payload, "detail") || JSON.stringify(payload);
    throw new Error(`${preset.id}: refresh refused (HTTP ${status}) ${detail}`);
  }
  const accessToken = text(payload, "access_token");
  if (!accessToken) throw new Error(`${preset.id}: refresh carried no access token`);
  return {
    accessToken,
    refreshToken: text(payload, "refresh_token") || options.refreshToken,
    expiresInSec: count(payload, "expires_in"),
    gatewayUrl: text(payload, "gateway_url") || null,
  };
}

/**
 * Opens the approval page in the caller's browser. Best effort on purpose: the URL is
 * printed either way, which is what makes this usable over SSH or on a headless box.
 */
export function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CI && env.CI !== "0" && env.CI !== "false") return false;
  if (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.WSL_DISTRO_NAME) return false;
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => {
      /* no opener on this box: the printed URL is the fallback */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
