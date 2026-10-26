// Whole answers, in and out. Streaming lives in stream.ts.

import { anthropicStopReason, openAiFinishReason, stopReasonOfAnthropic, stopReasonOfOpenAiChat } from "./stops.js";
import {
  asArray,
  asRecord,
  asString,
  intOrNull,
  usageObject,
  type CanonCompletion,
  type CanonToolCall,
  type CanonUsage,
  type Dialect,
  type StopReason,
} from "./types.js";

function toolCallsFromOpenAi(value: unknown): CanonToolCall[] {
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

function parseOpenAiChat(body: Record<string, unknown>): CanonCompletion {
  const choice = asRecord(asArray(body.choices)[0]);
  const message = asRecord(choice?.message) ?? asRecord(choice?.delta);
  const toolCalls = toolCallsFromOpenAi(message?.tool_calls);
  const finish = asString(choice?.finish_reason);
  return {
    id: asString(body.id) || "chatcmpl-gateway",
    model: asString(body.model),
    created: intOrNull(body.created) ?? Math.floor(Date.now() / 1000),
    text: asString(message?.content),
    toolCalls,
    stopReason: stopReasonOfOpenAiChat(finish) === "stop" && toolCalls.length > 0 ? "tool_use" : stopReasonOfOpenAiChat(finish),
    usage: usageObject(body.usage),
  };
}

function parseOpenAiResponses(body: Record<string, unknown>): CanonCompletion {
  let text = "";
  const toolCalls: CanonToolCall[] = [];
  for (const entry of asArray(body.output)) {
    const record = asRecord(entry);
    if (!record) continue;
    const type = asString(record.type);
    if (type === "function_call") {
      const calls = toolCallsFromOpenAi([record]);
      toolCalls.push(...calls);
      continue;
    }
    if (type !== "message") continue;
    for (const part of asArray(record.content)) {
      const piece = asRecord(part);
      if (piece && (asString(piece.type) === "output_text" || asString(piece.type) === "text")) text += asString(piece.text);
    }
  }
  const incomplete = asRecord(body.incomplete_details);
  const status = asString(body.status);
  let stopReason: StopReason = "stop";
  if (status === "incomplete" && asString(incomplete?.reason) === "max_output_tokens") stopReason = "length";
  else if (toolCalls.length > 0) stopReason = "tool_use";
  return {
    id: asString(body.id) || "resp-gateway",
    model: asString(body.model),
    created: intOrNull(body.created_at) ?? Math.floor(Date.now() / 1000),
    text,
    toolCalls,
    stopReason,
    usage: usageObject(body.usage),
  };
}

function parseAnthropic(body: Record<string, unknown>): CanonCompletion {
  let text = "";
  const toolCalls: CanonToolCall[] = [];
  for (const block of asArray(body.content)) {
    const record = asRecord(block);
    if (!record) continue;
    const type = asString(record.type);
    if (type === "text") text += asString(record.text);
    else if (type === "tool_use") {
      toolCalls.push({
        id: asString(record.id) || `call_${toolCalls.length}`,
        name: asString(record.name),
        arguments: JSON.stringify(record.input ?? {}),
      });
    }
  }
  const stopReason = stopReasonOfAnthropic(asString(body.stop_reason));
  return {
    id: asString(body.id) || "msg-gateway",
    model: asString(body.model),
    created: Math.floor(Date.now() / 1000),
    text,
    toolCalls,
    stopReason: stopReason === "stop" && toolCalls.length > 0 ? "tool_use" : stopReason,
    usage: usageObject(body.usage),
  };
}

export function parseResponse(dialect: Dialect, body: unknown): CanonCompletion {
  const record = asRecord(body);
  if (!record) throw new Error("upstream answer was not a JSON object");
  if (dialect === "openai-chat") return parseOpenAiChat(record);
  if (dialect === "openai-responses") return parseOpenAiResponses(record);
  return parseAnthropic(record);
}

function usageForOpenAi(usage: CanonUsage | null): Record<string, unknown> | null {
  if (!usage) return null;
  return {
    prompt_tokens: usage.input ?? 0,
    completion_tokens: usage.output ?? 0,
    total_tokens: usage.total ?? (usage.input ?? 0) + (usage.output ?? 0),
  };
}

export function renderResponse(client: Dialect, completion: CanonCompletion): Record<string, unknown> {
  if (client === "openai-chat") {
    const message: Record<string, unknown> = { role: "assistant", content: completion.text || null };
    if (completion.toolCalls.length > 0) {
      message.tool_calls = completion.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
    }
    return {
      id: completion.id,
      object: "chat.completion",
      created: completion.created,
      model: completion.model,
      choices: [{ index: 0, message, finish_reason: openAiFinishReason(completion.stopReason) }],
      usage: usageForOpenAi(completion.usage),
    };
  }

  if (client === "openai-responses") {
    const output: unknown[] = [];
    if (completion.text) {
      output.push({
        id: `msg_${completion.id}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: completion.text, annotations: [] }],
      });
    }
    for (const call of completion.toolCalls) {
      output.push({ type: "function_call", id: call.id, call_id: call.id, name: call.name, arguments: call.arguments, status: "completed" });
    }
    return {
      id: completion.id,
      object: "response",
      created_at: completion.created,
      status: completion.stopReason === "length" ? "incomplete" : "completed",
      ...(completion.stopReason === "length" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
      model: completion.model,
      output,
      usage: completion.usage
        ? {
            input_tokens: completion.usage.input ?? 0,
            output_tokens: completion.usage.output ?? 0,
            total_tokens: completion.usage.total ?? (completion.usage.input ?? 0) + (completion.usage.output ?? 0),
          }
        : null,
    };
  }

  const content: unknown[] = [];
  if (completion.text) content.push({ type: "text", text: completion.text });
  for (const call of completion.toolCalls) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: call.id, name: call.name, input });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    id: completion.id,
    type: "message",
    role: "assistant",
    model: completion.model,
    content,
    stop_reason: anthropicStopReason(completion.stopReason),
    stop_sequence: null,
    usage: {
      input_tokens: completion.usage?.input ?? 0,
      output_tokens: completion.usage?.output ?? 0,
    },
  };
}
