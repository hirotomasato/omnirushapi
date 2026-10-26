// OpenAI-compatible data plane.
//
// Every /v1/* call is authenticated with a gateway key, sent to one upstream account,
// and — when the upstream fails in a way another account could fix — retried on the
// next account of the plan. Streaming responses pass through unbuffered.

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  addAccountUsage,
  availableAccounts,
  getAccount,
  recordAccountFailure,
  recordAccountSuccess,
  type Account,
} from "./accounts.js";
import type { Config } from "./config.js";
import type { CatalogSource } from "./models.js";
import type { UpstreamFetch } from "./curl.js";
import type { Db } from "./db.js";
import {
  applyEvent,
  asRecord,
  completionFrom,
  createAccumulator,
  createStreamParser,
  createStreamRenderer,
  dialectOfPath,
  eventsFromCompletion,
  parseRequest,
  parseResponse,
  PATH_BY_DIALECT,
  renderRequest,
  renderResponse,
  type Accumulator,
  type CanonEvent,
  type Dialect,
} from "./dialects/index.js";
import { findKeyBySecret, touchKey, type GatewayKey } from "./keys.js";
import type { TokenRefresher } from "./refresh.js";
import { isCredentialStatus, isFailoverStatus, planAttempts, readsAsAccountLimit, type Candidate, type RouteState } from "./routing.js";
import { recordRequest } from "./usage.js";

export interface DataPlaneDeps {
  db: Db;
  config: Config;
  routeState: RouteState;
  /** How upstream requests leave this process (direct, or through the configured proxy). */
  transport: UpstreamFetch;
  /** Renews device-flow credentials before and after they expire. */
  refresher: TokenRefresher;
  /** The model list, shared with the console. */
  catalogSource: CatalogSource;
}

/** Tokens an upstream reported, however many of the three fields it sent. */
interface Tokens {
  prompt: number | null;
  completion: number | null;
  total: number | null;
}

// Response headers the gateway owns: it streams, so upstream framing is not carried over.
const HOP_BY_HOP: Record<string, true> = {
  "content-length": true,
  "transfer-encoding": true,
  connection: true,
  "keep-alive": true,
};

// Request headers that must not go upstream: routing/tunnel headers, and the caller's
// credentials, which are replaced by the account's.
const REQUEST_HEADERS_TO_DROP: Record<string, true> = {
  host: true,
  connection: true,
  "content-length": true,
  "transfer-encoding": true,
  "keep-alive": true,
  upgrade: true,
  expect: true,
  authorization: true,
  "x-admin-token": true,
};

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The first of `names` the usage object carries as a finite number. */
function usageNumber(usage: object, names: readonly string[]): number | null {
  for (const name of names) {
    if (!(name in usage)) continue;
    const found = numberOrNull(Reflect.get(usage, name));
    if (found !== null) return found;
  }
  return null;
}

/** The usage object of a payload: top level, or inside `response` (Responses API events). */
function usageObjectOf(value: unknown): object | null {
  if (typeof value !== "object" || value === null) return null;
  if ("usage" in value) {
    const direct: unknown = value.usage;
    if (typeof direct === "object" && direct !== null) return direct;
  }
  if ("response" in value) {
    const nested: unknown = value.response;
    if (typeof nested === "object" && nested !== null && "usage" in nested) {
      const usage: unknown = nested.usage;
      if (typeof usage === "object" && usage !== null) return usage;
    }
  }
  return null;
}

/** The usage object of an OpenAI-shaped payload, whichever of its fields are present. */
function tokensFromUsage(value: unknown): Tokens | null {
  const usage = usageObjectOf(value);
  if (!usage) return null;
  // Chat completions report prompt_/completion_tokens; the Responses API reports
  // input_/output_tokens. Both are the same two numbers.
  const prompt = usageNumber(usage, ["prompt_tokens", "input_tokens"]);
  const completion = usageNumber(usage, ["completion_tokens", "output_tokens"]);
  const reported = usageNumber(usage, ["total_tokens"]);
  const total = reported ?? (prompt !== null || completion !== null ? (prompt ?? 0) + (completion ?? 0) : null);
  if (total === null && prompt === null && completion === null) return null;
  return { prompt, completion, total };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function modelFrom(parsed: unknown): string | null {
  const model: unknown = asRecord(parsed)?.model;
  return typeof model === "string" ? model : null;
}

/**
 * Reads an SSE body as it goes by and remembers the last usage frame. Frames are
 * reassembled across chunk boundaries; nothing else is kept.
 */
export function createSseUsageScanner() {
  const decoder = new TextDecoder();
  let pending = "";
  let usage: Tokens | null = null;
  return {
    push(chunk: Uint8Array): void {
      pending += decoder.decode(chunk, { stream: true });
      for (;;) {
        const end = pending.indexOf("\n");
        if (end === -1) break;
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (!line.startsWith("data:")) continue;
        const frame = parseJson(line.slice(5).trim());
        const found = tokensFromUsage(frame);
        if (found) usage = found;
      }
      // A frame that never terminates must not grow without bound.
      if (pending.length > 1_000_000) pending = "";
    },
    usage(): Tokens | null {
      return usage;
    },
  };
}

function upstreamHeaders(account: Account, incoming: FastifyRequest["headers"]): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (REQUEST_HEADERS_TO_DROP[name] || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  if (account.extraHeaders) for (const [name, value] of Object.entries(account.extraHeaders)) headers.set(name, value);
  headers.set("authorization", `Bearer ${account.apiKey}`);
  return headers;
}

const ID_PREFIX: Record<Dialect, string> = { "openai-chat": "chatcmpl-", "openai-responses": "resp_", "anthropic-messages": "msg_" };

function clientRequestId(dialect: Dialect): string {
  return `${ID_PREFIX[dialect]}${randomUUID().replace(/-/g, "")}`;
}

/** The local token shape the request log speaks. */
function tokensOf(state: Accumulator): Tokens | null {
  if (!state.usage) return null;
  return { prompt: state.usage.input, completion: state.usage.output, total: state.usage.total };
}

/** Whether the client asked for its tokens in a separate frame (OpenAI's stream_options). */
function wantsUsageFrame(dialect: Dialect, body: Record<string, unknown> | null): boolean {
  if (dialect !== "openai-chat") return true;
  const options = asRecord(body?.stream_options);
  return options?.include_usage === true;
}

/** An upstream failure, in the shape the caller's dialect expects. */
function clientError(dialect: Dialect | null, status: number, text: string): Record<string, unknown> {
  const message = text.slice(0, 500);
  if (dialect === "anthropic-messages") {
    return { type: "error", error: { type: status === 400 ? "invalid_request_error" : "api_error", message } };
  }
  return { error: { message, type: status === 400 ? "invalid_request_error" : "server_error" } };
}

export function registerDataPlane(app: FastifyInstance, deps: DataPlaneDeps): void {
  const { db, config, routeState, transport, refresher, catalogSource } = deps;

  // The gateway forwards the caller's bytes unchanged, so bodies are never parsed here.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  const keyByRequest = new WeakMap<FastifyRequest, GatewayKey>();

  app.get("/healthz", async () => ({ ok: true }));

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/v1")) return;
    const header = request.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    // Anthropic clients put the key in x-api-key; accept either, so pointing one at
    // /v1/messages works without a shim.
    const apiKey = request.headers["x-api-key"];
    const secret = bearer || (typeof apiKey === "string" ? apiKey.trim() : "");
    const key = secret ? findKeyBySecret(db, secret) : null;
    if (!key || !key.enabled) {
      await reply.status(401).send({
        error: { message: "Incorrect API key provided to the gateway.", type: "invalid_request_error", code: "invalid_api_key" },
      });
      return reply;
    }
    keyByRequest.set(request, key);
    touchKey(db, key.id);
    return undefined;
  });

  app.get("/v1/models", async (_request, reply) => {
    const accounts = availableAccounts(db);
    if (accounts.length === 0) return reply.send({ object: "list", data: [] });
    const catalog = await catalogSource.get();
    // Every account failing is worth saying out loud; one failing is not.
    if (catalog.entries.length === 0 && catalog.failures.length === accounts.length) {
      return reply.status(502).send({
        error: { message: `no account answered /models: ${catalog.failures.map((failure) => `${failure.account}: ${failure.error}`).join("; ")}`, type: "server_error" },
      });
    }
    return reply.send({ object: "list", data: catalog.entries.map((entry) => ({ object: "model", ...entry.raw, id: entry.id })) });
  });

  app.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    url: "/v1/*",
    handler: async (request, reply) => {
      const startedAt = Date.now();
      const key = keyByRequest.get(request);
      if (!key) return reply.status(401).send({ error: { message: "unauthenticated", type: "invalid_request_error" } });

      const questionMark = request.url.indexOf("?");
      const path = questionMark === -1 ? request.url : request.url.slice(0, questionMark);
      const query = questionMark === -1 ? "" : request.url.slice(questionMark + 1);
      const body = Buffer.isBuffer(request.body) ? request.body : undefined;
      const parsedBody = body ? parseJson(body.toString("utf8")) : null;
      const model = modelFrom(parsedBody);
      // What the caller speaks; null for routes that are not model calls (they never translate).
      const clientDialect = dialectOfPath(path);
      const clientBody = asRecord(parsedBody);
      const clientStream = clientBody?.stream === true;
      const clientIncludeUsage = clientDialect ? wantsUsageFrame(clientDialect, clientBody) : false;

      const accounts = availableAccounts(db);
      const log = (fields: { accountId: number | null; status: number; attempt: number; stream: boolean; tokens?: Tokens | null; error?: string | null }): void => {
        recordRequest(db, {
          keyId: key.id,
          accountId: fields.accountId,
          method: request.method,
          path,
          model,
          status: fields.status,
          stream: fields.stream,
          attempt: fields.attempt,
          promptTokens: fields.tokens?.prompt ?? null,
          completionTokens: fields.tokens?.completion ?? null,
          totalTokens: fields.tokens?.total ?? null,
          latencyMs: Date.now() - startedAt,
          error: fields.error ?? null,
        });
      };

      if (accounts.length === 0) {
        log({ accountId: null, status: 503, attempt: 0, stream: false, error: "no account available" });
        return reply.status(503).send({
          error: { message: "No upstream account is available (all disabled, cooling down or out of quota).", type: "server_error", code: "no_account_available" },
        });
      }

      const candidates: Candidate[] = accounts.map((account) => ({
        id: account.id,
        priority: account.priority,
        weight: account.weight,
        served: account.served,
      }));
      const plan = planAttempts(candidates, config.strategy, routeState, config.maxAttempts);

      const abort = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableEnded) abort.abort();
      });

      let lastStatus = 502;
      let lastError = "no attempt was made";
      let attempts = 0;

      for (const picked of plan) {
        const account = accounts.find((candidate) => candidate.id === picked.id);
        if (!account) continue;
        attempts += 1;

        const upstreamDialect = account.dialect;
        const translating = clientDialect !== null && clientDialect !== upstreamDialect;
        // Straight through when nothing has to change; otherwise the answer is rebuilt.
        const relaying = translating || (clientDialect !== null && account.forceStream && !clientStream);
        const upstreamStream = clientStream || (clientDialect !== null && account.forceStream);
        const upstreamPath = translating ? PATH_BY_DIALECT[upstreamDialect] : path;
        const suffix = upstreamPath.replace(/^\/v1/, "");
        const target = `${account.baseUrl}${suffix}${query ? `?${query}` : ""}`;

        let attemptBody = body;
        if (relaying) {
          try {
            const canonical = parseRequest(translating && clientDialect ? clientDialect : upstreamDialect, parsedBody);
            canonical.stream = upstreamStream;
            canonical.stripSampling = account.stripSampling;
            attemptBody = Buffer.from(JSON.stringify(renderRequest(upstreamDialect, canonical)));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log({ accountId: null, status: 400, attempt: attempts, stream: false, error: message });
            return reply.status(400).send(clientError(clientDialect, 400, `the request could not be translated: ${message}`));
          }
        }

        // A device-flow account renews itself: before the call when the stored expiry says
        // the token is spent, and once after a 401 if the upstream disagrees. Everything
        // reads the credential from the database first — a caller that still holds the
        // token another request has since rotated away must adopt the new one, never
        // present the superseded refresh token (providers count that as sharing).
        let credential = account;
        let refreshNote: string | null = null;
        const current = getAccount(db, account.id) ?? account;
        if (refresher.canRefresh(current) && refresher.isStale(current)) {
          const early = await refresher.refresh(current);
          refreshNote = early.error;
          if (early.ok) credential = getAccount(db, account.id) ?? account;
        }

        let upstream: Response | null = null;
        let transportFailure: string | null = null;
        for (let call = 1; call <= config.transportAttempts; call += 1) {
          try {
            upstream = await transport(target, {
              method: request.method,
              headers: upstreamHeaders(credential, request.headers),
              ...(attemptBody && attemptBody.length > 0 ? { body: attemptBody } : {}),
              signal: AbortSignal.any([abort.signal, AbortSignal.timeout(config.upstreamTimeoutMs)]),
            });
          } catch (error) {
            // A dropped connection is often the proxy or the edge, not the account: try the
            // same account once more before parking it. (A retried call may be billed twice
            // upstream; that is the usual price of at-least-once.)
            transportFailure = error instanceof Error ? error.message : String(error);
            if (call < config.transportAttempts) {
              // A small pause between attempts: an edge that just dropped a connection is
              // likelier to accept the next one a moment later than immediately.
              await new Promise((resolve) => setTimeout(resolve, 250));
              continue;
            }
            recordAccountFailure(db, account.id, transportFailure, config.transportCooldownMs, false);
            lastStatus = 502;
            lastError = `${account.label}: ${transportFailure}`;
            break;
          }
          if (upstream.status !== 401 || call > 1 || !refresher.canRefresh(account)) break;
          const stored = getAccount(db, account.id) ?? account;
          if (stored.apiKey !== credential.apiKey) {
            credential = stored;
            continue;
          }
          const renewed = await refresher.refresh(stored);
          refreshNote = renewed.error;
          if (!renewed.ok) break;
          credential = getAccount(db, account.id) ?? credential;
        }
        if (!upstream) continue;

        if (!upstream.ok) {
          const text = await upstream.text().catch(() => "");
          const code = upstream.status;
          // A refusal of the account (rather than of this request) moves the call on: some
          // upstreams report an exhausted quota as a 400 or a 404, so the body decides too.
          if (isFailoverStatus(code) || readsAsAccountLimit(code, text)) {
            const dead = isCredentialStatus(code);
            const detail = refreshNote ? `${code} ${text} (refresh: ${refreshNote})` : `${code} ${text}`;
            recordAccountFailure(db, account.id, detail.slice(0, 300), dead ? config.deadCooldownMs : config.cooldownMs, dead);
            lastStatus = code;
            lastError = `${account.label}: HTTP ${detail.slice(0, 200)}`;
            continue;
          }
          // The caller's own request was wrong: hand the upstream's answer straight back.
          log({ accountId: account.id, status: code, attempt: attempts, stream: false, error: text.slice(0, 200) });
          return reply
            .status(code)
            .header("content-type", "application/json")
            .send(relaying ? clientError(clientDialect, code, text) : text);
        }

        recordAccountSuccess(db, account.id);
        // Header names are case-insensitive; the lookups below are not, and curl passes
        // the server's own casing through while undici lowercases it.
        const headers: Record<string, string> = {};
        upstream.headers.forEach((value, name) => {
          const lower = name.toLowerCase();
          if (!HOP_BY_HOP[lower]) headers[lower] = value;
        });
        const isSse = (headers["content-type"] ?? "").includes("text/event-stream");
        // An origin that compressed anyway: the bytes are not ours to parse, and the caller
        // still gets a valid answer. Token accounting for that stream is skipped.
        const scanUsage = isSse && !(headers["content-encoding"] ?? "").length;

        if (!relaying) {
          const scanner = createSseUsageScanner();
          const buffered: Buffer[] = [];
          let bufferedBytes = 0;
          reply.hijack();
          reply.raw.writeHead(upstream.status, headers);
          if (upstream.body) {
            for await (const chunk of upstream.body) {
              reply.raw.write(chunk);
              if (scanUsage) scanner.push(chunk);
              else if (bufferedBytes < 4_000_000) {
                buffered.push(Buffer.from(chunk));
                bufferedBytes += chunk.length;
              }
            }
          }
          reply.raw.end();

          // Streaming answers carry usage in their last frame; plain ones in the body.
          const tokens = scanUsage ? scanner.usage() : tokensFromUsage(parseJson(Buffer.concat(buffered).toString("utf8")));
          log({ accountId: account.id, status: upstream.status, attempt: attempts, stream: isSse, tokens });
          if (tokens?.total) addAccountUsage(db, account.id, tokens.total);
          return reply;
        }

        // The answer is in another dialect: rebuild it, frame by frame or whole.
        const answerId = clientRequestId(clientDialect ?? upstreamDialect);
        const created = Math.floor(Date.now() / 1000);
        const state = createAccumulator();

        if (clientStream && clientDialect) {
          const renderer = createStreamRenderer(clientDialect, { id: answerId, model: model ?? "", created, includeUsage: clientIncludeUsage });
          const parser = createStreamParser(upstreamDialect);
          const emit = (events: CanonEvent[]): void => {
            for (const event of events) {
              applyEvent(state, event);
              reply.raw.write(renderer.event(event));
            }
          };
          reply.hijack();
          reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          reply.raw.write(renderer.head());
          const buffered: Buffer[] = [];
          let bufferedBytes = 0;
          if (upstream.body) {
            for await (const chunk of upstream.body) {
              if (isSse) emit(parser.push(chunk));
              else if (bufferedBytes < 4_000_000) {
                buffered.push(Buffer.from(chunk));
                bufferedBytes += chunk.length;
              }
            }
          }
          // An upstream that ignored stream:true still answers: one answer becomes one stream.
          if (isSse) emit(parser.end());
          else emit(eventsFromCompletion(parseResponse(upstreamDialect, parseJson(Buffer.concat(buffered).toString("utf8")))));
          reply.raw.write(renderer.tail());
          reply.raw.end();

          const tokens = tokensOf(state);
          log({ accountId: account.id, status: 200, attempt: attempts, stream: true, tokens });
          if (tokens?.total) addAccountUsage(db, account.id, tokens.total);
          return reply;
        }

        if (clientDialect) {
          if (isSse) {
            const parser = createStreamParser(upstreamDialect);
            if (upstream.body) {
              for await (const chunk of upstream.body) for (const event of parser.push(chunk)) applyEvent(state, event);
            }
            for (const event of parser.end()) applyEvent(state, event);
          } else {
            const text = await upstream.text().catch(() => "");
            for (const event of eventsFromCompletion(parseResponse(upstreamDialect, parseJson(text)))) applyEvent(state, event);
          }
          const completion = completionFrom(state, { id: answerId, model: model ?? "", created });
          const tokens = tokensOf(state);
          log({ accountId: account.id, status: 200, attempt: attempts, stream: false, tokens });
          if (tokens?.total) addAccountUsage(db, account.id, tokens.total);
          return reply.status(200).header("content-type", "application/json").send(renderResponse(clientDialect, completion));
        }

        // Not a model route and not relayed: nothing to translate it into.
        log({ accountId: account.id, status: upstream.status, attempt: attempts, stream: false, error: "untranslatable route" });
        return reply.status(502).send(clientError(null, 502, `no account speaks ${path}`));
      }

      log({ accountId: null, status: lastStatus, attempt: attempts, stream: false, error: lastError });
      const status = lastStatus === 429 ? 429 : 502;
      return reply.status(status).send({
        error: { message: `every upstream attempt failed: ${lastError}`, type: "server_error", code: "all_accounts_failed" },
      });
    },
  });
}
