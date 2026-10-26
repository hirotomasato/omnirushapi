// Upstream transport for anything the gateway cannot reach directly.
//
// Node's fetch ignores HTTP(S)_PROXY, and undici's own ProxyAgent does not survive every
// corporate proxy (the one on this host rejects it mid-handshake while curl is fine). So
// when a proxy is configured, curl carries the upstream request: nothing is buffered
// beyond the response headers, and the body streams straight to the caller.

import { spawn } from "node:child_process";

export interface UpstreamRequest {
  method: string;
  headers: Headers;
  /** Already buffered by the caller, which retries a failed attempt on another account. */
  body?: Buffer;
  signal: AbortSignal;
}

export type UpstreamFetch = (url: string, init: UpstreamRequest) => Promise<Response>;

// The gateway owns framing. Encoding is forwarded untouched: asking for none is both
// simpler and safer than negotiating compression and decoding it — one upstream drops a
// long compressed stream mid-flight ("Empty reply from server") while the same request
// uncompressed arrives whole.
const HOP_BY_HOP: Record<string, true> = {
  "content-length": true,
  "transfer-encoding": true,
  connection: true,
  "keep-alive": true,
};

// A proxy CONNECT reply, or any interim response: never the answer itself.
const INTERIM = /^HTTP\/[\d.]+ (?:1\d\d|200 Connection established)/i;

export const nativeFetch: UpstreamFetch = (url, init) =>
  fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body && init.body.length > 0 ? { body: init.body } : {}),
    signal: init.signal,
  });

// Anything on this machine — a local upstream, the stub in a test — must never be handed
// to a proxy: curl's explicit -x ignores NO_PROXY.
const LOOPBACK = /^https?:\/\/(?:127(?:\.\d{1,3}){3}|localhost|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:[/?#]|$)/i;

function parseHeaderBlock(block: string): { status: number; statusText: string; headers: Headers } | null {
  const [statusLine, ...rest] = block.split("\r\n");
  const match = /^HTTP\/[\d.]+ (\d{3})(?: (.*))?$/.exec(statusLine ?? "");
  if (!match) return null;
  const headers = new Headers();
  for (const line of rest) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (HOP_BY_HOP[name.toLowerCase()]) continue;
    try {
      headers.append(name, value);
    } catch {
      /* a header curl tolerated but Headers will not: drop it */
    }
  }
  return { status: Number(match[1]), statusText: (match[2] ?? "").trim(), headers };
}

export function createCurlFetch({ bin = "curl", proxy = null }: { bin?: string; proxy?: string | null } = {}): UpstreamFetch {
  return async (url, init) => {
    // Uncompressed on purpose (see HOP_BY_HOP): the bytes curl hands over are the bytes the
    // upstream sent, so nothing has to be decoded and nothing can be decoded twice.
    const args = ["-sS", "--no-buffer", "--connect-timeout", "30", "--http1.1", "-i"];
    if (proxy) args.push("-x", proxy);
    if (init.method === "HEAD") args.push("-I");
    else args.push("-X", init.method);
    for (const [name, value] of init.headers) {
      if (/^(host|content-length|connection)$/i.test(name)) continue;
      // Whatever the caller prefers, ask for no compression.
      if (/^accept-encoding$/i.test(name)) continue;
      args.push("-H", `${name}: ${value}`);
    }
    args.push("-H", "Accept-Encoding: identity");
    if (init.body && !init.headers.has("content-type")) args.push("-H", "Content-Type:");
    if (init.body && init.body.length > 0) args.push("--data-binary", "@-");
    args.push(url);

    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {
      /* curl can exit before reading a body it will not use */
    });
    child.stdin.end(init.body && init.body.length > 0 ? init.body : undefined);

    const abort = () => child.kill("SIGTERM");
    if (init.signal.aborted) {
      abort();
      throw init.signal.reason instanceof Error ? init.signal.reason : new Error("aborted");
    }
    init.signal.addEventListener("abort", abort, { once: true });
    child.on("close", () => init.signal.removeEventListener("abort", abort));

    const stream = child.stdout;
    const iterator = stream[Symbol.asyncIterator]();
    let pending: Buffer = Buffer.alloc(0);
    let head: { status: number; statusText: string; headers: Headers } | null = null;
    while (!head) {
      const end = pending.indexOf("\r\n\r\n");
      if (end !== -1) {
        const block = pending.subarray(0, end).toString("latin1");
        pending = pending.subarray(end + 4);
        if (!INTERIM.test(block)) head = parseHeaderBlock(block);
        continue;
      }
      const { value, done } = await iterator.next();
      if (done) throw new Error(stderr.trim() || "curl produced no response");
      pending = Buffer.concat([pending, value]);
    }

    const bodyless = head.status === 101 || head.status === 204 || head.status === 304;
    if (bodyless) {
      stream.destroy();
      return new Response(null, { status: head.status, statusText: head.statusText, headers: head.headers });
    }
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          if (pending.length > 0) controller.enqueue(new Uint8Array(pending));
          for (;;) {
            const { value, done } = await iterator.next();
            if (done) break;
            controller.enqueue(new Uint8Array(value));
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
      cancel() {
        child.kill("SIGTERM");
      },
    });
    return new Response(body, { status: head.status, statusText: head.statusText, headers: head.headers });
  };
}

/** Upstream transport when a proxy is configured: local hosts stay direct, the rest go through it. */
export function createOutboundFetch(options: { bin?: string; proxy?: string | null; useCurl?: boolean } = {}): UpstreamFetch {
  const proxied = createCurlFetch(options);
  const direct = options.useCurl ? createCurlFetch({ bin: options.bin, proxy: null }) : nativeFetch;
  return (url, init) => (LOOPBACK.test(url) ? direct(url, init) : proxied(url, init));
}
