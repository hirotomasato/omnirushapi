// Streams: the upstream's frames become canonical events, the canonical events become the
// client's frames. Nothing is buffered beyond the frame being read.

import { anthropicStopReason, openAiFinishReason, stopReasonOfAnthropic, stopReasonOfOpenAiChat } from "./stops.js";
import { asArray, asRecord, asString, mergeUsage, usageObject, type CanonEvent, type CanonUsage, type Dialect, type StopReason } from "./types.js";

/** Reads SSE payloads out of a byte stream, keeping "[DONE]" as the marker it is. */
export function createSseReader(): { push(chunk: Uint8Array): string[] } {
  const decoder = new TextDecoder();
  let pending = "";
  return {
    push(chunk: Uint8Array): string[] {
      pending += decoder.decode(chunk, { stream: true });
      const payloads: string[] = [];
      for (;;) {
        const end = pending.indexOf("\n");
        if (end === -1) break;
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (line.startsWith("data:")) payloads.push(line.slice(5).trim());
      }
      if (pending.length > 4_000_000) pending = "";
      return payloads;
    },
  };
}

export interface StreamParser {
  push(chunk: Uint8Array): CanonEvent[];
  /** Whatever the upstream never said out loud: a closing stop reason. */
  end(): CanonEvent[];
}

export function createStreamParser(dialect: Dialect): StreamParser {
  const reader = createSseReader();
  let stopped = false;
  let usage: CanonUsage | null = null;
  let sawToolCall = false;
  const itemIndexById = new Map<string, number>();
  const toolNameById = new Map<string, string>();

  const pushUsage = (found: CanonUsage | null): CanonEvent[] => {
    if (!found) return [];
    usage = mergeUsage(usage, found);
    return usage ? [{ type: "usage", usage }] : [];
  };

  const stop = (reason: StopReason): CanonEvent[] => {
    if (stopped) return [];
    stopped = true;
    return [{ type: "stop", reason }];
  };

  const fromOpenAiChat = (payload: string): CanonEvent[] => {
    if (payload === "[DONE]") return [];
    const record = asRecord(JSON.parse(payload));
    if (!record) return [];
    const events: CanonEvent[] = [];
    const choice = asRecord(asArray(record.choices)[0]);
    const delta = asRecord(choice?.delta);
    const text = asString(delta?.content);
    if (text) events.push({ type: "text", text });
    for (const entry of asArray(delta?.tool_calls)) {
      const call = asRecord(entry);
      if (!call) continue;
      const index = typeof call.index === "number" ? call.index : 0;
      const fn = asRecord(call.function);
      const name = asString(fn?.name);
      if (name) events.push({ type: "tool_start", index, id: asString(call.id) || `call_${index}`, name });
      const args = asString(fn?.arguments);
      if (args) events.push({ type: "tool_arguments", index, arguments: args });
      sawToolCall = true;
    }
    events.push(...pushUsage(usageObject(record.usage)));
    const finish = asString(choice?.finish_reason);
    if (finish) events.push(...stop(stopReasonOfOpenAiChat(finish)));
    return events;
  };

  const fromOpenAiResponses = (payload: string): CanonEvent[] => {
    const record = asRecord(JSON.parse(payload));
    if (!record) return [];
    const type = asString(record.type);
    const events: CanonEvent[] = [];
    if (type === "response.output_item.added") {
      const item = asRecord(record.item);
      if (asString(item?.type) === "function_call") {
        const index = typeof record.output_index === "number" ? record.output_index : 0;
        const id = asString(item?.call_id) || asString(item?.id) || `call_${index}`;
        itemIndexById.set(asString(item?.id) || id, index);
        toolNameById.set(id, asString(item?.name));
        sawToolCall = true;
        events.push({ type: "tool_start", index, id, name: asString(item?.name) });
      }
      return events;
    }
    if (type === "response.output_text.delta") {
      const text = asString(record.delta);
      if (text) events.push({ type: "text", text });
      return events;
    }
    if (type === "response.function_call_arguments.delta") {
      const index = itemIndexById.get(asString(record.item_id)) ?? 0;
      const args = asString(record.delta);
      if (args) events.push({ type: "tool_arguments", index, arguments: args });
      return events;
    }
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      const response = asRecord(record.response);
      events.push(...pushUsage(usageObject(response?.usage)));
      const incomplete = asRecord(response?.incomplete_details);
      const reason: StopReason =
        type === "response.incomplete" && asString(incomplete?.reason) === "max_output_tokens" ? "length" : sawToolCall ? "tool_use" : "stop";
      events.push(...stop(reason));
      return events;
    }
    return events;
  };

  const fromAnthropic = (payload: string): CanonEvent[] => {
    const record = asRecord(JSON.parse(payload));
    if (!record) return [];
    const type = asString(record.type);
    const events: CanonEvent[] = [];
    if (type === "message_start") {
      events.push(...pushUsage(usageObject(asRecord(record.message)?.usage)));
      return events;
    }
    if (type === "content_block_start") {
      const block = asRecord(record.content_block);
      if (asString(block?.type) === "tool_use") {
        const index = typeof record.index === "number" ? record.index : 0;
        sawToolCall = true;
        events.push({ type: "tool_start", index, id: asString(block?.id) || `call_${index}`, name: asString(block?.name) });
      }
      return events;
    }
    if (type === "content_block_delta") {
      const index = typeof record.index === "number" ? record.index : 0;
      const delta = asRecord(record.delta);
      const deltaType = asString(delta?.type);
      if (deltaType === "text_delta") {
        const text = asString(delta?.text);
        if (text) events.push({ type: "text", text });
      } else if (deltaType === "input_json_delta") {
        const args = asString(delta?.partial_json);
        if (args) events.push({ type: "tool_arguments", index, arguments: args });
      }
      return events;
    }
    if (type === "message_delta") {
      events.push(...pushUsage(usageObject(record.usage)));
      const reason = asString(asRecord(record.delta)?.stop_reason);
      if (reason) lastReason = stopReasonOfAnthropic(reason);
      return events;
    }
    if (type === "message_stop") return stop(lastReason ?? (sawToolCall ? "tool_use" : "stop"));
    return events;
  };

  let lastReason: StopReason | null = null;

  return {
    push(chunk: Uint8Array): CanonEvent[] {
      const out: CanonEvent[] = [];
      for (const payload of reader.push(chunk)) {
        try {
          for (const event of dialect === "openai-chat" ? fromOpenAiChat(payload) : dialect === "openai-responses" ? fromOpenAiResponses(payload) : fromAnthropic(payload)) {
            if (event.type === "stop") lastReason = event.reason;
            out.push(event);
          }
        } catch {
          /* a frame we cannot read is skipped, never fatal mid-stream */
        }
      }
      return out;
    },
    end(): CanonEvent[] {
      // The upstream may just stop talking: say the one thing a client needs to finish.
      return stop(lastReason ?? (sawToolCall ? "tool_use" : "stop"));
    },
  };
}

export interface StreamRenderer {
  /** Frames that open the client's stream. */
  head(): string;
  event(event: CanonEvent): string;
  /** Frames that close it, after the last event. */
  tail(): string;
}

function sse(name: string | null, payload: unknown): string {
  return `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(payload)}\n\n`;
}

export function createStreamRenderer(
  client: Dialect,
  meta: { id: string; model: string; created: number; includeUsage: boolean },
): StreamRenderer {
  if (client === "openai-chat") {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage: unknown = null): string =>
      sse(null, {
        id: meta.id,
        object: "chat.completion.chunk",
        created: meta.created,
        model: meta.model,
        choices: finish === null || delta.content !== undefined || Object.keys(delta).length > 0 ? [{ index: 0, delta, finish_reason: finish }] : [],
        ...(usage ? { usage } : {}),
      });
    return {
      head: () => "",
      event: (event) => {
        if (event.type === "text") return chunk({ content: event.text });
        if (event.type === "tool_start") {
          return chunk({ tool_calls: [{ index: event.index, id: event.id, type: "function", function: { name: event.name, arguments: "" } }] });
        }
        if (event.type === "tool_arguments") return chunk({ tool_calls: [{ index: event.index, function: { arguments: event.arguments } }] });
        if (event.type === "usage") {
          if (!meta.includeUsage) return "";
          return sse(null, {
            id: meta.id,
            object: "chat.completion.chunk",
            created: meta.created,
            model: meta.model,
            choices: [],
            usage: {
              prompt_tokens: event.usage.input ?? 0,
              completion_tokens: event.usage.output ?? 0,
              total_tokens: event.usage.total ?? (event.usage.input ?? 0) + (event.usage.output ?? 0),
            },
          });
        }
        return chunk({}, openAiFinishReason(event.reason));
      },
      tail: () => "data: [DONE]\n\n",
    };
  }

  if (client === "anthropic-messages") {
    let blocks = 0;
    let textBlock: number | null = null;
    const toolBlocks = new Map<number, number>();
    let usage: CanonUsage | null = null;
    let finished = false;
    const closeBlocks = (): string => {
      let out = "";
      if (textBlock !== null) out += sse("content_block_stop", { type: "content_block_stop", index: textBlock });
      for (const index of toolBlocks.values()) out += sse("content_block_stop", { type: "content_block_stop", index });
      textBlock = null;
      toolBlocks.clear();
      return out;
    };
    return {
      head: () =>
        sse("message_start", {
          type: "message_start",
          message: {
            id: meta.id,
            type: "message",
            role: "assistant",
            model: meta.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      event: (event) => {
        if (event.type === "text") {
          let out = "";
          if (textBlock === null) {
            textBlock = blocks++;
            out += sse("content_block_start", { type: "content_block_start", index: textBlock, content_block: { type: "text", text: "" } });
          }
          return out + sse("content_block_delta", { type: "content_block_delta", index: textBlock, delta: { type: "text_delta", text: event.text } });
        }
        if (event.type === "tool_start") {
          const out = closeBlocks();
          const index = blocks++;
          toolBlocks.set(event.index, index);
          return (
            out +
            sse("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "tool_use", id: event.id, name: event.name, input: {} },
            })
          );
        }
        if (event.type === "tool_arguments") {
          const index = toolBlocks.get(event.index);
          if (index === undefined) return "";
          return sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: event.arguments } });
        }
        if (event.type === "usage") {
          usage = event.usage;
          return "";
        }
        finished = true;
        return (
          closeBlocks() +
          sse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: anthropicStopReason(event.reason), stop_sequence: null },
            usage: { input_tokens: usage?.input ?? 0, output_tokens: usage?.output ?? 0 },
          }) +
          sse("message_stop", { type: "message_stop" })
        );
      },
      tail: () => (finished ? "" : ""),
    };
  }

  // openai-responses
  const textItemId = `msg_${meta.id}`;
  const output: Record<string, unknown>[] = [];
  const toolItemByIndex = new Map<number, string>();
  let textOpen = false;
  let text = "";
  let usage: CanonUsage | null = null;
  let finished = false;
  const base = (status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: meta.id,
    object: "response",
    created_at: meta.created,
    status,
    model: meta.model,
    output: [],
    ...extra,
  });
  return {
    head: () => sse("response.created", { type: "response.created", response: base("in_progress") }),
    event: (event) => {
      if (event.type === "text") {
        let out = "";
        if (!textOpen) {
          textOpen = true;
          out += sse("response.output_item.added", {
            type: "response.output_item.added",
            output_index: 0,
            item: { id: textItemId, type: "message", status: "in_progress", role: "assistant", content: [] },
          });
          out += sse("response.content_part.added", {
            type: "response.content_part.added",
            item_id: textItemId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
        }
        text += event.text;
        return out + sse("response.output_text.delta", { type: "response.output_text.delta", item_id: textItemId, output_index: 0, content_index: 0, delta: event.text });
      }
      if (event.type === "tool_start") {
        const itemId = `fc_${event.id}`;
        toolItemByIndex.set(event.index, itemId);
        output.push({ type: "function_call", id: itemId, call_id: event.id, name: event.name, arguments: "" });
        return sse("response.output_item.added", {
          type: "response.output_item.added",
          output_index: event.index,
          item: { id: itemId, type: "function_call", status: "in_progress", call_id: event.id, name: event.name, arguments: "" },
        });
      }
      if (event.type === "tool_arguments") {
        const itemId = toolItemByIndex.get(event.index);
        if (!itemId) return "";
        const entry = output.find((item) => item.id === itemId);
        if (entry) entry.arguments = `${asString(entry.arguments)}${event.arguments}`;
        return sse("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          item_id: itemId,
          output_index: event.index,
          delta: event.arguments,
        });
      }
      if (event.type === "usage") {
        usage = event.usage;
        return "";
      }
      finished = true;
      let out = "";
      if (textOpen) {
        out += sse("response.output_text.done", { type: "response.output_text.done", item_id: textItemId, output_index: 0, content_index: 0, text });
        out += sse("response.content_part.done", {
          type: "response.content_part.done",
          item_id: textItemId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text, annotations: [] },
        });
        out += sse("response.output_item.done", {
          type: "response.output_item.done",
          output_index: 0,
          item: { id: textItemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] },
        });
        output.unshift({ id: textItemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
      }
      const incomplete = event.reason === "length";
      return (
        out +
        sse("response.completed", {
          type: "response.completed",
          response: base(incomplete ? "incomplete" : "completed", {
            ...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
            output,
            usage: {
              input_tokens: usage?.input ?? 0,
              output_tokens: usage?.output ?? 0,
              total_tokens: usage?.total ?? (usage?.input ?? 0) + (usage?.output ?? 0),
            },
          }),
        })
      );
    },
    tail: () => (finished ? "" : ""),
  };
}
