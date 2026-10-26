// Shared harness for the end-to-end suites: one stub upstream/manager, one real gateway.
//
// These suites exist because the interesting failures live between the pieces: a proxy that
// the runtime ignores, a body parser that escapes its scope, a token rotation racing itself.

import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const STUB_PORT = 8811;
export const GATEWAY_PORT = 8812;
export const ADMIN_TOKEN = "e2e-admin-token";
/** The console session the suites sign in with; set explicitly, never inherited from defaults. */
export const DASHBOARD_USER = "console";
export const DASHBOARD_PASSWORD = "e2e-console-password";

/** The stub's memory: who it handed tokens to, and how many times it was asked to rotate. */
export interface StubState {
  issued: number;
  refreshCalls: number;
  tokenCalls: number;
  valid: string[];
  seen: { path: string; key: string; body: Record<string, unknown> }[];
}

const state = {
  issued: 0,
  refreshCalls: 0,
  tokenCalls: 0,
  valid: new Set<string>(),
  seen: [] as { path: string; key: string; body: Record<string, unknown> }[],
};

function resetStubState(): void {
  state.issued = 0;
  state.refreshCalls = 0;
  state.tokenCalls = 0;
  state.valid = new Set<string>();
  state.seen = [];
  forcedPending = 0;
  forcedFlaky = 0;
}

/** Token calls held in "pending" on purpose, so a test can see the waiting state. */
let forcedPending = 0;

/** Upstream calls dropped on purpose, to cover a transport failure. */
let forcedFlaky = 0;

/**
 * One upstream that speaks all three dialects and a manager that speaks the device flow.
 * Keys in the path decide behaviour: `k-429` always rate-limits, `k-quota` reports an
 * exhausted quota in the body (a 400, as some providers do).
 */
export async function startStub(port = STUB_PORT): Promise<{ close: () => Promise<void>; state: () => StubState }> {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://stub");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw || "{}");
      if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
    } catch {
      body = {};
    }
    const key = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    const json = (status: number, payload: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    const sse = async (frames: string[]) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of frames) {
        response.write(frame);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      response.end();
    };

    if (url.pathname === "/_state") return json(200, { ...state, valid: [...state.valid] });
    if (url.pathname === "/_invalidate") {
      state.valid.clear();
      return json(200, { ok: true });
    }
    if (url.pathname === "/_flaky") {
      // Drop the connection for the next N upstream calls: the shape of an edge or proxy
      // hiccup, which must not cost the caller its request or the account its health.
      forcedFlaky = typeof body.times === "number" ? body.times : 1;
      return json(200, { ok: true, forcedFlaky });
    }
    if (url.pathname === "/_pending") {
      // Hold the next N token calls in "authorization_pending", so a test can observe the
      // waiting state instead of racing an instant approval.
      forcedPending = typeof body.times === "number" ? body.times : 1;
      return json(200, { ok: true, forcedPending });
    }

    // --- device flow ---
    if (url.pathname.endsWith("/device/authorize")) {
      return json(200, {
        device_code: "dc-e2e",
        user_code: "E2E-CODE",
        verification_uri: `http://127.0.0.1:${port}/approve`,
        verification_uri_complete: `http://127.0.0.1:${port}/approve?code=E2E-CODE`,
        expires_in: 600,
        interval: 1,
      });
    }
    if (url.pathname.endsWith("/device/me")) {
      // The manager checks the token, as the real one does: a device token it has replaced is
      // refused, so a caller that never renews sees 401 here.
      if (!(key.startsWith("at-") && state.valid.has(key))) return json(401, { detail: "device_token_invalid" });
      return json(200, {
        id: "device-e2e",
        email: "e2e@example.com",
        status: "active",
        usage: {
          grant_date: "2026-10-26",
          period: "day",
          resets_at: "2026-10-27T00:00:00Z",
          day: { allowance: 5_000_000, used: 1_234_567, resets_at: "2026-10-27T00:00:00Z" },
          week: { limit: 15_000_000, used: 4_321_000 },
          pot: { balance: 500_000 },
        },
      });
    }
    if (url.pathname.endsWith("/device/token")) {
      state.tokenCalls += 1;
      if (forcedPending > 0) {
        forcedPending -= 1;
        return json(428, { detail: "authorization_pending" });
      }
      if (state.tokenCalls < 3) return json(428, { detail: "authorization_pending" });
      state.issued += 1;
      state.valid.add(`at-${state.issued}`);
      return json(200, { access_token: `at-${state.issued}`, refresh_token: `rt-${state.issued}`, expires_in: 3600 });
    }
    if (url.pathname.endsWith("/device/refresh")) {
      const presented = typeof body.refresh_token === "string" ? body.refresh_token : "";
      if (!presented.startsWith("rt-")) return json(401, { detail: "refresh_token_invalid_or_expired" });
      state.refreshCalls += 1;
      state.issued += 1;
      state.valid.add(`at-${state.issued}`);
      return json(200, { access_token: `at-${state.issued}`, refresh_token: `rt-${state.issued}`, expires_in: 3600 });
    }

    // --- upstream ---
    if (url.pathname.endsWith("/models")) {
      return json(200, { object: "list", data: [{ id: "stub-mini", object: "model", owned_by: "stub" }, { id: "stub-pro", object: "model", owned_by: "stub" }] });
    }
    if (url.pathname.includes("/device/")) return json(404, { detail: "no such device route" });

    state.seen.push({ path: url.pathname, key, body });
    if (forcedFlaky > 0) {
      forcedFlaky -= 1;
      request.destroy();
      response.destroy();
      return undefined;
    }
    if (key === "k-429") return json(429, { error: { message: "rate limited" } });
    if (key === "k-quota") return json(400, { error: { message: "You exceeded your current quota, please check your plan", type: "insufficient_quota" } });
    if (key.startsWith("at-") && !state.valid.has(key)) return json(401, { detail: "device_token_invalid" });

    if (url.pathname.endsWith("/chat/completions")) {
      const wantsTools = Array.isArray(body.tools) && body.tools.length > 0;
      if (body.stream) {
        return sse([
          `data: ${JSON.stringify({ id: "cc-1", object: "chat.completion.chunk", model: body.model, system_fingerprint: `acct:${key}`, choices: [{ index: 0, delta: { role: "assistant", content: "from-chat" } }] })}\n\n`,
          `data: ${JSON.stringify({ id: "cc-1", system_fingerprint: `acct:${key}`, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
          "data: [DONE]\n\n",
        ]);
      }
      return json(200, {
        id: "cc-1",
        object: "chat.completion",
        model: body.model,
        system_fingerprint: `acct:${key}`,
        choices: [
          wantsTools
            ? { index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }] }, finish_reason: "tool_calls" }
            : { index: 0, message: { role: "assistant", content: "from-chat" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }

    if (url.pathname.endsWith("/responses")) {
      // The gates the real omnirush gateway enforces.
      if (body.store !== false) return json(400, { detail: "Store must be set to false" });
      if (body.stream !== true) return json(400, { detail: "Stream must be set to true" });
      return sse([
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp-1", usage: null } })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg-1", output_index: 0, content_index: 0, delta: "from-responses" })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp-1", status: "completed", model: body.model, usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27 } } })}\n\n`,
      ]);
    }

    if (url.pathname.endsWith("/messages")) {
      const wantsTools = Array.isArray(body.tools) && body.tools.length > 0;
      if (body.stream) {
        return sse([
          `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 30, output_tokens: 0 } } })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "from-anthropic" } })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
          `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ]);
      }
      return json(200, {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: body.model,
        content: wantsTools ? [{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.txt" } }] : [{ type: "text", text: "from-anthropic" }],
        stop_reason: wantsTools ? "tool_use" : "end_turn",
        usage: { input_tokens: 30, output_tokens: 4 },
      });
    }

    return json(404, { error: { message: `stub has no ${url.pathname}` } });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  resetStubState();
  return {
    state: () => ({ ...state, valid: [...state.valid], seen: [...state.seen] }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface Gateway {
  base: string;
  env: NodeJS.ProcessEnv;
  stop: () => Promise<void>;
}

/** Starts the real thing, in a scratch database, waiting for its own listening line. */
export async function startGateway(options: { port?: number; projectRoot: string }): Promise<Gateway> {
  const port = options.port ?? GATEWAY_PORT;
  const dir = mkdtempSync(path.join(tmpdir(), "omnirushapi-e2e-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // The suites talk to 127.0.0.1 only, so a host proxy would just add noise.
    UPSTREAM_PROXY: "",
    HTTPS_PROXY: "",
    HTTP_PROXY: "",
    ALL_PROXY: "",
    PORT: String(port),
    DB_PATH: path.join(dir, "gateway.db"),
    ADMIN_TOKEN,
    DASHBOARD_USER,
    DASHBOARD_PASSWORD,
    LOG_LEVEL: "warn",
  };
  // Spawned through node, not npm: npm does not pass SIGTERM on to its child, and a suite
  // that leaves a gateway holding the port breaks the next run.
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: options.projectRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gateway did not start: ${log}`)), 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      log += chunk.toString();
      if (log.includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      log += chunk.toString();
    });
    child.on("exit", (code) => reject(new Error(`gateway exited (${code}): ${log}`)));
  });
  return {
    base: `http://127.0.0.1:${port}`,
    env,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Helpers {
  admin: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> | null }>;
  client: (secret: string, path: string, body: unknown, stream?: boolean) => Promise<{ status: number; text: string }>;
  /** The same call with Anthropic's header instead of OpenAI's. */
  anthropicClient: (secret: string, path: string, body: unknown, stream?: boolean) => Promise<{ status: number; text: string }>;
  key: (name: string) => Promise<string>;
  state: () => Promise<StubState>;
}

export function makeHelpers(base: string): Helpers {
  const admin: Helpers["admin"] = (method, path, body) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "x-admin-token": ADMIN_TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));

  return {
    admin,
    state: () => fetch(`http://127.0.0.1:${STUB_PORT}/_state`).then((response) => response.json() as Promise<StubState>),
    key: async (name) => {
      const created = await admin("POST", "/admin/keys", { name });
      const secret = created.body?.secret;
      if (typeof secret !== "string") throw new Error(`key creation failed: ${JSON.stringify(created.body)}`);
      return secret;
    },
    client: async (secret, path, body, stream = false) => {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      let text = "";
      for await (const chunk of response.body) text += new TextDecoder().decode(chunk);
      return { status: response.status, text };
    },
    anthropicClient: async (secret, path, body, stream = false) => {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "x-api-key": secret, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      let text = "";
      for await (const chunk of response.body) text += new TextDecoder().decode(chunk);
      return { status: response.status, text };
    },
  };
}

/** The tiny assertion helper every suite uses. */
export function createChecker(): { check: (name: string, ok: boolean, detail?: string) => void; failures: () => number } {
  let failures = 0;
  return {
    check: (name, ok, detail = "") => {
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
      if (!ok) failures += 1;
    },
    failures: () => failures,
  };
}
