// The canonical form every dialect is translated through: a client's request in, an
// upstream's answer out, with nothing dialect-specific left in between.
//
// Only what the three dialects genuinely share lives here. Anything a dialect has and
// the others do not (thinking blocks, citations, audio) is dropped rather than faked.

export type Dialect = "openai-chat" | "openai-responses" | "anthropic-messages";

export type StopReason = "stop" | "length" | "tool_use" | "content_filter";

export type CanonImage = { kind: "base64"; mime: string; data: string } | { kind: "url"; url: string };

export interface CanonToolCall {
  id: string;
  name: string;
  /** JSON text, as both OpenAI and Anthropic send it on the wire. */
  arguments: string;
}

export interface CanonMessage {
  role: "system" | "user" | "assistant" | "tool";
  text: string;
  images: CanonImage[];
  toolCalls: CanonToolCall[];
  /** Set on role "tool": which call this answers. */
  toolCallId: string | null;
}

export interface CanonTool {
  name: string;
  description: string;
  parameters: unknown;
}

export interface CanonToolChoice {
  mode: "auto" | "required" | "none" | "tool";
  name: string | null;
}

export interface CanonRequest {
  model: string;
  messages: CanonMessage[];
  tools: CanonTool[];
  toolChoice: CanonToolChoice | null;
  maxTokens: number | null;
  temperature: number | null;
  topP: number | null;
  stream: boolean;
  /** Responses API only; null means "the gateway decides" (it renders false). */
  store: boolean | null;
  /** The client asked for a usage frame in a stream (OpenAI's stream_options). */
  includeUsage: boolean;
  /**
   * True when this upstream rejects temperature/top_p (some Responses backends answer
   * "Unsupported parameter"). The values are dropped rather than sent and refused.
   */
  stripSampling: boolean;
}

export interface CanonUsage {
  input: number | null;
  output: number | null;
  total: number | null;
}

export interface CanonCompletion {
  id: string;
  model: string;
  created: number;
  text: string;
  toolCalls: CanonToolCall[];
  stopReason: StopReason;
  usage: CanonUsage | null;
}

export type CanonEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "tool_arguments"; index: number; arguments: string }
  | { type: "usage"; usage: CanonUsage }
  | { type: "stop"; reason: StopReason };

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function intOrNull(value: unknown): number | null {
  const found = numberOrNull(value);
  return found === null ? null : Math.trunc(found);
}

export function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** A data: URL as its parts, or null when it is an ordinary URL. */
export function parseDataUrl(url: string): { mime: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match?.[1] && match[2] !== undefined ? { mime: match[1], data: match[2] } : null;
}

export function toDataUrl(image: CanonImage): string {
  return image.kind === "base64" ? `data:${image.mime};base64,${image.data}` : image.url;
}

/** One parsed usage object, whichever dialect's field names it uses. */
export function usageObject(value: unknown): CanonUsage | null {
  const record = asRecord(value);
  if (!record) return null;
  const input = numberOrNull(record.prompt_tokens) ?? numberOrNull(record.input_tokens);
  const output = numberOrNull(record.completion_tokens) ?? numberOrNull(record.output_tokens);
  const reported = numberOrNull(record.total_tokens);
  const total = reported ?? (input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null);
  if (input === null && output === null && total === null) return null;
  return { input, output, total };
}

export function emptyMessage(role: CanonMessage["role"]): CanonMessage {
  return { role, text: "", images: [], toolCalls: [], toolCallId: null };
}

/**
 * Folds one usage frame into what is already known. Upstreams report usage in pieces
 * (Anthropic sends input tokens first, output later), and a partial frame carries its own
 * misleading total — so the total is recomputed whenever both halves are known.
 */
export function mergeUsage(previous: CanonUsage | null, found: CanonUsage | null): CanonUsage | null {
  if (!found) return previous;
  const input = found.input ?? previous?.input ?? null;
  const output = found.output ?? previous?.output ?? null;
  const total = input !== null && output !== null ? input + output : (found.total ?? previous?.total ?? null);
  return { input, output, total };
}

/** A message with no text, images or calls carries nothing worth translating. */
export function isEmptyMessage(message: CanonMessage): boolean {
  return message.text.trim() === "" && message.images.length === 0 && message.toolCalls.length === 0;
}
