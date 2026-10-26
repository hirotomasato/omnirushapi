// Which dialect serves which path — the one place that mapping lives.

import type { Dialect } from "./types.js";

export const DIALECTS: readonly Dialect[] = ["openai-chat", "openai-responses", "anthropic-messages"];

/** The request path each dialect serves, below the version segment. */
export const PATH_BY_DIALECT: Record<Dialect, string> = {
  "openai-chat": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/messages",
};

export const DIALECT_LABEL: Record<Dialect, string> = {
  "openai-chat": "OpenAI chat completions",
  "openai-responses": "OpenAI responses",
  "anthropic-messages": "Anthropic messages",
};

export function parseDialect(value: unknown): Dialect {
  const found = DIALECTS.find((dialect) => dialect === value);
  if (!found) throw new Error(`dialect must be one of ${DIALECTS.join(", ")} (got ${JSON.stringify(value)})`);
  return found;
}

/** For values that came from storage or a config file: unknown means the old default. */
export function dialectOrDefault(value: unknown): Dialect {
  return DIALECTS.find((dialect) => dialect === value) ?? "openai-chat";
}

/** The dialect a client is speaking, from the path it called; null for routes that are not model calls. */
export function dialectOfPath(path: string): Dialect | null {
  const bare = path.replace(/^\/v1(?=\/|$)/, "");
  for (const dialect of DIALECTS) {
    if (PATH_BY_DIALECT[dialect] === bare) return dialect;
  }
  return null;
}

export type { Dialect };

export * from "./types.js";
export { applyEvent, completionFrom, createAccumulator, eventsFromCompletion } from "./accumulate.js";
export type { Accumulator } from "./accumulate.js";
export { parseRequest, renderRequest } from "./requests.js";
export { parseResponse, renderResponse } from "./responses.js";
export { createSseReader, createStreamParser, createStreamRenderer } from "./stream.js";
export type { StreamParser, StreamRenderer } from "./stream.js";
