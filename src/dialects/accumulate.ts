// Folding a stream of canonical events back into one answer: what a caller that did not
// ask for a stream gets, and what the gateway counts tokens from.

import { mergeUsage, type CanonCompletion, type CanonEvent, type CanonToolCall, type CanonUsage, type StopReason } from "./types.js";

export interface Accumulator {
  text: string;
  /** Keyed by the upstream's tool index, in the order the calls appeared. */
  calls: Map<number, CanonToolCall>;
  usage: CanonUsage | null;
  stopReason: StopReason;
}

export function createAccumulator(): Accumulator {
  return { text: "", calls: new Map(), usage: null, stopReason: "stop" };
}

export function applyEvent(state: Accumulator, event: CanonEvent): void {
  if (event.type === "text") {
    state.text += event.text;
    return;
  }
  if (event.type === "tool_start") {
    state.calls.set(event.index, { id: event.id, name: event.name, arguments: "" });
    state.stopReason = "tool_use";
    return;
  }
  if (event.type === "tool_arguments") {
    const call = state.calls.get(event.index);
    if (call) call.arguments += event.arguments;
    return;
  }
  if (event.type === "usage") {
    state.usage = mergeUsage(state.usage, event.usage);
    return;
  }
  state.stopReason = event.reason;
}

export function completionFrom(state: Accumulator, meta: { id: string; model: string; created: number }): CanonCompletion {
  return {
    id: meta.id,
    model: meta.model,
    created: meta.created,
    text: state.text,
    toolCalls: [...state.calls.values()],
    stopReason: state.stopReason,
    usage: state.usage,
  };
}

/** The events a whole answer amounts to, for a caller that asked to be streamed. */
export function eventsFromCompletion(completion: CanonCompletion): CanonEvent[] {
  const events: CanonEvent[] = [];
  if (completion.text) events.push({ type: "text", text: completion.text });
  completion.toolCalls.forEach((call, index) => {
    events.push({ type: "tool_start", index, id: call.id, name: call.name });
    if (call.arguments) events.push({ type: "tool_arguments", index, arguments: call.arguments });
  });
  if (completion.usage) events.push({ type: "usage", usage: completion.usage });
  events.push({ type: "stop", reason: completion.stopReason });
  return events;
}
