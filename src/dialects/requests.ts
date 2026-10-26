// Requests in and out: the client's body becomes canonical, the canonical request is
// rendered into whatever the upstream speaks.

import {
  asArray,
  asRecord,
  asString,
  boolOrNull,
  emptyMessage,
  intOrNull,
  isEmptyMessage,
  numberOrNull,
  parseDataUrl,
  toDataUrl,
  type CanonImage,
  type CanonMessage,
  type CanonRequest,
  type CanonTool,
  type CanonToolCall,
  type CanonToolChoice,
  type Dialect,
} from "./types.js";

/** Anthropic requires max_tokens; when the client named none, this is what we send. */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192;

function textFromParts(parts: unknown[]): string {
  const pieces: string[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      pieces.push(part);
      continue;
    }
    const record = asRecord(part);
    if (!record) continue;
    const text = asString(record.text) || asString(record.input_text) || asString(record.output_text);
    if (text) pieces.push(text);
  }
  return pieces.join("");
}

function imageFromUrl(url: string): CanonImage | null {
  if (!url) return null;
  const inline = parseDataUrl(url);
  return inline ? { kind: "base64", mime: inline.mime, data: inline.data } : { kind: "url", url };
}

function imagesFromOpenAiParts(parts: unknown[]): CanonImage[] {
  const images: CanonImage[] = [];
  for (const part of parts) {
    const record = asRecord(part);
    if (!record) continue;
    const type = asString(record.type);
    if (type !== "image_url" && type !== "input_image") continue;
    const raw = record.image_url;
    const url = typeof raw === "string" ? raw : asString(asRecord(raw)?.url);
    const image = imageFromUrl(url);
    if (image) images.push(image);
  }
  return images;
}

function readToolCalls(value: unknown): CanonToolCall[] {
  const calls: CanonToolCall[] = [];
  for (const entry of asArray(value)) {
    const record = asRecord(entry);
    if (!record) continue;
    const fn = asRecord(record.function);
    const name = asString(fn?.name) || asString(record.name);
    if (!name) continue;
    calls.push({
      id: asString(record.id) || asString(record.call_id) || `call_${calls.length}`,
      name,
      arguments: asString(fn?.arguments) || asString(record.arguments) || "{}",
    });
  }
  return calls;
}

function parseToolChoice(value: unknown): CanonToolChoice | null {
  if (typeof value === "string") {
    if (value === "auto" || value === "none" || value === "required") return { mode: value, name: null };
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const type = asString(record.type) || asString(record.name);
  if (type === "any") return { mode: "required", name: null };
  if (type === "tool") return { mode: "tool", name: asString(record.name) || null };
  if (type === "function") return { mode: "tool", name: asString(asRecord(record.function)?.name) || null };
  if (type === "auto" || type === "none" || type === "required") return { mode: type, name: null };
  return null;
}

function parseTools(value: unknown, shape: "openai" | "anthropic"): CanonTool[] {
  const tools: CanonTool[] = [];
  for (const entry of asArray(value)) {
    const record = asRecord(entry);
    if (!record) continue;
    const fn = asRecord(record.function);
    const name = asString(fn?.name) || asString(record.name);
    if (!name) continue;
    tools.push({
      name,
      description: asString(fn?.description) || asString(record.description),
      parameters: fn?.parameters ?? record.input_schema ?? record.parameters ?? { type: "object", properties: {} },
    });
  }
  void shape;
  return tools;
}

function parseOpenAiChat(body: Record<string, unknown>): CanonRequest {
  const messages: CanonMessage[] = [];
  for (const entry of asArray(body.messages)) {
    const record = asRecord(entry);
    if (!record) continue;
    const role = asString(record.role);
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool" && role !== "developer") continue;
    const content = record.content;
    const parts = Array.isArray(content) ? content : [];
    const message: CanonMessage = {
      role: role === "developer" ? "system" : role,
      text: typeof content === "string" ? content : textFromParts(parts),
      images: imagesFromOpenAiParts(parts),
      toolCalls: readToolCalls(record.tool_calls),
      toolCallId: asString(record.tool_call_id) || null,
    };
    if (!isEmptyMessage(message)) messages.push(message);
  }
  const streamOptions = asRecord(body.stream_options);
  return {
    model: asString(body.model),
    messages,
    tools: parseTools(body.tools, "openai"),
    toolChoice: parseToolChoice(body.tool_choice),
    maxTokens: intOrNull(body.max_completion_tokens) ?? intOrNull(body.max_tokens),
    temperature: numberOrNull(body.temperature),
    topP: numberOrNull(body.top_p),
    stream: boolOrNull(body.stream) ?? false,
    store: boolOrNull(body.store),
    includeUsage: asString(streamOptions?.include_usage) === "true" || streamOptions?.include_usage === true,
    stripSampling: false,
  };
}

function parseOpenAiResponses(body: Record<string, unknown>): CanonRequest {
  const messages: CanonMessage[] = [];
  const instructions = body.instructions;
  if (typeof instructions === "string" && instructions) messages.push({ ...emptyMessage("system"), text: instructions });

  const input = body.input;
  if (typeof input === "string" && input) messages.push({ ...emptyMessage("user"), text: input });
  for (const entry of asArray(input)) {
    const record = asRecord(entry);
    if (!record) {
      if (typeof entry === "string" && entry) messages.push({ ...emptyMessage("user"), text: entry });
      continue;
    }
    const type = asString(record.type);
    if (type === "function_call") {
      const calls = readToolCalls([record]);
      if (calls.length > 0) messages.push({ ...emptyMessage("assistant"), toolCalls: calls });
      continue;
    }
    if (type === "function_call_output") {
      messages.push({ ...emptyMessage("tool"), text: asString(record.output), toolCallId: asString(record.call_id) || null });
      continue;
    }
    const role = asString(record.role);
    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    const content = record.content;
    const parts = Array.isArray(content) ? content : [];
    const message: CanonMessage = {
      role,
      text: typeof content === "string" ? content : textFromParts(parts),
      images: imagesFromOpenAiParts(parts),
      toolCalls: [],
      toolCallId: null,
    };
    if (!isEmptyMessage(message)) messages.push(message);
  }
  return {
    model: asString(body.model),
    messages,
    tools: parseTools(body.tools, "openai"),
    toolChoice: parseToolChoice(body.tool_choice),
    maxTokens: intOrNull(body.max_output_tokens),
    temperature: numberOrNull(body.temperature),
    topP: numberOrNull(body.top_p),
    stream: boolOrNull(body.stream) ?? false,
    store: boolOrNull(body.store),
    includeUsage: true,
    stripSampling: false,
  };
}

function parseAnthropic(body: Record<string, unknown>): CanonRequest {
  const messages: CanonMessage[] = [];
  const system = body.system;
  if (typeof system === "string" && system) messages.push({ ...emptyMessage("system"), text: system });
  else if (Array.isArray(system)) {
    const text = textFromParts(system);
    if (text) messages.push({ ...emptyMessage("system"), text });
  }

  for (const entry of asArray(body.messages)) {
    const record = asRecord(entry);
    if (!record) continue;
    const role = asString(record.role);
    if (role !== "user" && role !== "assistant") continue;
    const content = record.content;
    if (typeof content === "string") {
      if (content) messages.push({ ...emptyMessage(role), text: content });
      continue;
    }
    const blocks = asArray(content);
    const text = emptyMessage(role);
    for (const block of blocks) {
      const part = asRecord(block);
      if (!part) continue;
      const type = asString(part.type);
      if (type === "text") {
        text.text += asString(part.text);
        continue;
      }
      if (type === "image") {
        const source = asRecord(part.source);
        const data = asString(source?.data);
        const mime = asString(source?.media_type);
        const url = asString(source?.url);
        if (data) text.images.push({ kind: "base64", mime: mime || "image/png", data });
        else if (url) text.images.push({ kind: "url", url });
        continue;
      }
      if (type === "tool_use") {
        text.toolCalls.push({
          id: asString(part.id) || `call_${text.toolCalls.length}`,
          name: asString(part.name),
          arguments: JSON.stringify(part.input ?? {}),
        });
        continue;
      }
      if (type === "tool_result") {
        const inner = part.content;
        messages.push({
          ...emptyMessage("tool"),
          text: typeof inner === "string" ? inner : textFromParts(asArray(inner)),
          toolCallId: asString(part.tool_use_id) || null,
        });
        continue;
      }
    }
    if (!isEmptyMessage(text)) messages.push(text);
  }

  const rawChoice = asRecord(body.tool_choice);
  const choiceType = asString(rawChoice?.type);
  const toolChoice: CanonToolChoice | null =
    choiceType === "any"
      ? { mode: "required", name: null }
      : choiceType === "tool"
        ? { mode: "tool", name: asString(rawChoice?.name) || null }
        : choiceType === "auto" || choiceType === "none"
          ? { mode: choiceType, name: null }
          : null;

  return {
    model: asString(body.model),
    messages,
    tools: parseTools(body.tools, "anthropic"),
    toolChoice,
    maxTokens: intOrNull(body.max_tokens),
    temperature: numberOrNull(body.temperature),
    topP: numberOrNull(body.top_p),
    stream: boolOrNull(body.stream) ?? false,
    store: null,
    includeUsage: true,
    stripSampling: false,
  };
}

export function parseRequest(dialect: Dialect, body: unknown): CanonRequest {
  const record = asRecord(body);
  if (!record) throw new Error("request body must be a JSON object");
  if (dialect === "openai-chat") return parseOpenAiChat(record);
  if (dialect === "openai-responses") return parseOpenAiResponses(record);
  return parseAnthropic(record);
}

// --- rendering -----------------------------------------------------------------------

function openAiContent(message: CanonMessage): unknown {
  if (message.images.length === 0) return message.text;
  const parts: unknown[] = [];
  if (message.text) parts.push({ type: "text", text: message.text });
  for (const image of message.images) parts.push({ type: "image_url", image_url: { url: toDataUrl(image) } });
  return parts;
}

function renderOpenAiChat(request: CanonRequest): Record<string, unknown> {
  const messages: unknown[] = [];
  for (const message of request.messages) {
    if (message.role === "tool") {
      messages.push({ role: "tool", tool_call_id: message.toolCallId ?? "", content: message.text });
      continue;
    }
    const entry: Record<string, unknown> = { role: message.role, content: openAiContent(message) };
    if (message.toolCalls.length > 0) {
      entry.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
      if (!message.text) entry.content = null;
    }
    messages.push(entry);
  }
  const out: Record<string, unknown> = { model: request.model, messages, stream: request.stream };
  if (request.tools.length > 0) {
    out.tools = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    out.tool_choice = request.toolChoice?.mode === "tool" ? { type: "function", function: { name: request.toolChoice.name } } : (request.toolChoice?.mode ?? "auto");
  }
  if (request.maxTokens !== null) out.max_tokens = request.maxTokens;
  if (request.temperature !== null && !request.stripSampling) out.temperature = request.temperature;
  if (request.topP !== null && !request.stripSampling) out.top_p = request.topP;
  if (request.stream && request.includeUsage) out.stream_options = { include_usage: true };
  return out;
}

function renderOpenAiResponses(request: CanonRequest): Record<string, unknown> {
  const instructions = request.messages.filter((message) => message.role === "system").map((message) => message.text).join("\n\n");
  const input: unknown[] = [];
  for (const message of request.messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.toolCallId ?? "", output: message.text });
      continue;
    }
    if (message.toolCalls.length > 0) {
      if (message.text) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: message.text }] });
      for (const call of message.toolCalls) {
        input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
      }
      continue;
    }
    const content: unknown[] = [];
    if (message.text) content.push({ type: message.role === "assistant" ? "output_text" : "input_text", text: message.text });
    for (const image of message.images) content.push({ type: "input_image", image_url: toDataUrl(image) });
    if (content.length > 0) input.push({ type: "message", role: message.role, content });
  }

  const out: Record<string, unknown> = {
    model: request.model,
    input,
    // An upstream that only answers streamed (omnirush) rejects store:true, and a gateway
    // has no business keeping the caller's prompts: absent means false.
    store: request.store ?? false,
    stream: request.stream,
  };
  if (instructions) out.instructions = instructions;
  if (request.tools.length > 0) {
    out.tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    }));
    if (request.toolChoice) out.tool_choice = request.toolChoice.mode === "tool" ? { type: "function", name: request.toolChoice.name } : request.toolChoice.mode;
  }
  if (request.maxTokens !== null) out.max_output_tokens = request.maxTokens;
  if (request.temperature !== null && !request.stripSampling) out.temperature = request.temperature;
  if (request.topP !== null && !request.stripSampling) out.top_p = request.topP;
  return out;
}

function renderAnthropic(request: CanonRequest): Record<string, unknown> {
  const system = request.messages.filter((message) => message.role === "system").map((message) => message.text).join("\n\n");
  const messages: unknown[] = [];
  for (const message of request.messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const block = { type: "tool_result", tool_use_id: message.toolCallId ?? "", content: message.text };
      const last = asRecord(messages.at(-1));
      if (last?.role === "user" && Array.isArray(last.content)) (last.content as unknown[]).push(block);
      else messages.push({ role: "user", content: [block] });
      continue;
    }
    const content: unknown[] = [];
    if (message.text) content.push({ type: "text", text: message.text });
    for (const image of message.images) {
      content.push(
        image.kind === "base64"
          ? { type: "image", source: { type: "base64", media_type: image.mime, data: image.data } }
          : { type: "image", source: { type: "url", url: image.url } },
      );
    }
    for (const call of message.toolCalls) {
      let input: unknown = {};
      try {
        input = JSON.parse(call.arguments || "{}");
      } catch {
        input = {};
      }
      content.push({ type: "tool_use", id: call.id, name: call.name, input });
    }
    if (content.length === 0) continue;
    const last = asRecord(messages.at(-1));
    if (last?.role === message.role && content.length > 0 && last.content !== undefined) {
      // Anthropic tolerates one message per role in a row only as text; keep the turn apart.
      messages.push({ role: message.role, content });
      continue;
    }
    messages.push({ role: message.role, content });
  }

  const out: Record<string, unknown> = {
    model: request.model,
    messages,
    max_tokens: request.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
    stream: request.stream,
  };
  if (system) out.system = system;
  if (request.tools.length > 0) {
    out.tools = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
    if (request.toolChoice) {
      out.tool_choice =
        request.toolChoice.mode === "tool"
          ? { type: "tool", name: request.toolChoice.name }
          : { type: request.toolChoice.mode === "required" ? "any" : request.toolChoice.mode };
    }
  }
  if (request.temperature !== null && !request.stripSampling) out.temperature = request.temperature;
  if (request.topP !== null && !request.stripSampling) out.top_p = request.topP;
  return out;
}

export function renderRequest(dialect: Dialect, request: CanonRequest): Record<string, unknown> {
  if (dialect === "openai-chat") return renderOpenAiChat(request);
  if (dialect === "openai-responses") return renderOpenAiResponses(request);
  return renderAnthropic(request);
}
