// Stop reasons, in the four vocabularies the dialects use.

import type { StopReason } from "./types.js";

export function stopReasonOfOpenAiChat(finish: string): StopReason {
  if (finish === "length") return "length";
  if (finish === "tool_calls" || finish === "function_call") return "tool_use";
  if (finish === "content_filter") return "content_filter";
  return "stop";
}

export function stopReasonOfAnthropic(stop: string): StopReason {
  if (stop === "max_tokens") return "length";
  if (stop === "tool_use") return "tool_use";
  if (stop === "refusal") return "content_filter";
  return "stop";
}

/** What an OpenAI chat client is told. */
export function openAiFinishReason(reason: StopReason): string {
  if (reason === "length") return "length";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "content_filter") return "content_filter";
  return "stop";
}

/** What an Anthropic client is told. */
export function anthropicStopReason(reason: StopReason): string {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_use") return "tool_use";
  if (reason === "content_filter") return "refusal";
  return "end_turn";
}
