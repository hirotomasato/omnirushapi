// The dialect layer: requests, whole answers and streams, in both directions.
// Frames here are copies of what the real upstreams send, not invented shapes.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEvent,
  createAccumulator,
  createStreamParser,
  createStreamRenderer,
  dialectOfPath,
  completionFrom,
  eventsFromCompletion,
  parseRequest,
  parseResponse,
  renderRequest,
  renderResponse,
} from "../src/dialects/index.js";

const encode = (text: string) => new TextEncoder().encode(text);

function runStream(dialect: "openai-chat" | "openai-responses" | "anthropic-messages", frames: string[], chunkSize = 4096) {
  const parser = createStreamParser(dialect);
  const state = createAccumulator();
  const whole = frames.join("");
  for (let at = 0; at < whole.length; at += chunkSize) for (const event of parser.push(encode(whole.slice(at, at + chunkSize)))) applyEvent(state, event);
  for (const event of parser.end()) applyEvent(state, event);
  return state;
}

function rendered(client: "openai-chat" | "openai-responses" | "anthropic-messages", upstream: "openai-chat" | "openai-responses" | "anthropic-messages", frames: string[], chunkSize = 4096) {
  const parser = createStreamParser(upstream);
  const renderer = createStreamRenderer(client, { id: "test-1", model: "m", created: 1, includeUsage: true });
  let out = renderer.head();
  const whole = frames.join("");
  for (let at = 0; at < whole.length; at += chunkSize) for (const event of parser.push(encode(whole.slice(at, at + chunkSize)))) out += renderer.event(event);
  for (const event of parser.end()) out += renderer.event(event);
  return { out: out + renderer.tail() };
}

test("paths map to dialects", () => {
  assert.equal(dialectOfPath("/v1/chat/completions"), "openai-chat");
  assert.equal(dialectOfPath("/v1/responses"), "openai-responses");
  assert.equal(dialectOfPath("/v1/messages"), "anthropic-messages");
  assert.equal(dialectOfPath("/v1/embeddings"), null);
  assert.equal(dialectOfPath("/v1/models"), null);
});

test("an openai chat request renders into anthropic", () => {
  const canonical = parseRequest("openai-chat", {
    model: "claude-3",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "file body" },
    ],
    tools: [{ type: "function", function: { name: "read", description: "read a file", parameters: { type: "object" } } }],
    max_tokens: 64,
  });
  const body = renderRequest("anthropic-messages", canonical);
  assert.equal(body.system, "be brief");
  assert.equal(body.max_tokens, 64);
  const messages = body.messages as Record<string, unknown>[];
  assert.equal(messages.length, 3);
  const userContent = messages[0]?.content as Record<string, unknown>[];
  assert.deepEqual(userContent[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
  const assistant = messages[1]?.content as Record<string, unknown>[];
  assert.deepEqual(assistant[0], { type: "tool_use", id: "call_1", name: "read", input: { path: "a" } });
  assert.deepEqual(messages[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file body" }] });
  assert.deepEqual(body.tools, [{ name: "read", description: "read a file", input_schema: { type: "object" } }]);
});

test("an anthropic request renders into openai responses, storing nothing", () => {
  const canonical = parseRequest("anthropic-messages", {
    model: "gpt-6-astra",
    system: "be brief",
    max_tokens: 128,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "done" }] }] },
    ],
  });
  const body = renderRequest("openai-responses", canonical);
  assert.equal(body.instructions, "be brief");
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 128);
  const input = body.input as Record<string, unknown>[];
  assert.deepEqual(input[0], { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] });
  assert.deepEqual(input[1], { type: "function_call", call_id: "toolu_1", name: "read", arguments: '{"path":"a"}' });
  assert.deepEqual(input[2], { type: "function_call_output", call_id: "toolu_1", output: "done" });
});

test("a responses request renders back into openai chat", () => {
  const canonical = parseRequest("openai-responses", {
    model: "m",
    instructions: "sys",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
      { type: "function_call", call_id: "call_9", name: "run", arguments: "{}" },
      { type: "function_call_output", call_id: "call_9", output: "output text" },
    ],
  });
  const body = renderRequest("openai-chat", canonical);
  assert.deepEqual(body.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_9", type: "function", function: { name: "run", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_9", content: "output text" },
  ]);
});

test("a whole answers maps between dialects with its stop reason and usage", () => {
  const chat = parseResponse("openai-chat", {
    id: "chatcmpl-1",
    created: 5,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "hello", tool_calls: [{ id: "call_1", function: { name: "read", arguments: '{"a":1}' } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  });
  const asAnthropic = renderResponse("anthropic-messages", chat);
  assert.equal(asAnthropic.stop_reason, "tool_use");
  assert.deepEqual(asAnthropic.usage, { input_tokens: 7, output_tokens: 3 });
  assert.deepEqual(asAnthropic.content, [
    { type: "text", text: "hello" },
    { type: "tool_use", id: "call_1", name: "read", input: { a: 1 } },
  ]);

  const anthropic = parseResponse("anthropic-messages", {
    id: "msg_1",
    model: "m",
    content: [{ type: "text", text: "hi there" }],
    stop_reason: "max_tokens",
    usage: { input_tokens: 4, output_tokens: 9 },
  });
  const asChat = renderResponse("openai-chat", anthropic);
  assert.equal((asChat.choices as Record<string, unknown>[])[0]?.finish_reason, "length");
  assert.deepEqual(asChat.usage, { prompt_tokens: 4, completion_tokens: 9, total_tokens: 13 });

  const responses = parseResponse("openai-responses", {
    id: "resp_1",
    created_at: 9,
    model: "m",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  });
  const asChatAgain = renderResponse("openai-chat", responses);
  assert.equal((asChatAgain.choices as Record<string, unknown>[])[0]?.finish_reason, "stop");
  assert.equal(((asChatAgain.choices as Record<string, unknown>[])[0]?.message as Record<string, unknown>).content, "ok");
});

test("an openai chat stream folds into one answer", () => {
  const state = runStream(
    "openai-chat",
    [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hel"}}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
      "data: [DONE]\n\n",
    ],
    3,
  );
  const completion = completionFrom(state, { id: "x", model: "m", created: 1 });
  assert.equal(completion.text, "hello");
  assert.equal(completion.stopReason, "stop");
  assert.deepEqual(completion.usage, { input: 5, output: 2, total: 7 });
});

test("the responses frames omnirush sends render as an anthropic stream", () => {
  const { out } = rendered("anthropic-messages", "openai-responses", [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","usage":null}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"gateway ok"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-6-astra","usage":{"input_tokens":11,"input_tokens_details":{"cached_tokens":0},"output_tokens":6,"total_tokens":17}}}\n\n',
  ]);
  assert.match(out, /event: message_start/);
  assert.match(out, /"content_block_start"/);
  assert.match(out, /"text_delta","text":"gateway ok"/);
  assert.match(out, /"content_block_stop"/);
  assert.match(out, /"stop_reason":"end_turn"/);
  assert.match(out, /"input_tokens":11,"output_tokens":6/);
  assert.match(out, /event: message_stop/);
});

test("a tool call in a responses stream survives the trip to anthropic", () => {
  const { out } = rendered("anthropic-messages", "openai-responses", [
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_7","name":"read","arguments":""}}\n\n',
    'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"{\\"path\\":"}\n\n',
    'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"\\"a\\"}"}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7}}}\n\n',
  ]);
  assert.match(out, /"type":"tool_use","id":"call_7","name":"read"/);
  assert.match(out, /"partial_json":"\{\\"path\\":"/);
  assert.match(out, /"stop_reason":"tool_use"/);
});

test("an openai chat stream renders as a responses stream", () => {
  const { out } = rendered("openai-responses", "openai-chat", [
    'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
  ]);
  assert.match(out, /"output_text","text":"hi"/);
  assert.match(out, /response\.output_text\.delta/);
  assert.match(out, /"status":"completed"/);
  assert.match(out, /"total_tokens":3/);
});

test("an anthropic stream folds into one answer, usage and all", () => {
  const state = runStream(
    "anthropic-messages",
    [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":9,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ],
    7,
  );
  const completion = completionFrom(state, { id: "x", model: "m", created: 1 });
  assert.equal(completion.text, "ok");
  assert.equal(completion.stopReason, "stop");
  assert.deepEqual(completion.usage, { input: 9, output: 2, total: 11 });
});

test("a whole answer replays as events for a caller that asked to stream", () => {
  const events = eventsFromCompletion({
    id: "x",
    model: "m",
    created: 1,
    text: "hello",
    toolCalls: [{ id: "call_1", name: "read", arguments: "{}" }],
    stopReason: "tool_use",
    usage: { input: 1, output: 2, total: 3 },
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ["text", "tool_start", "tool_arguments", "usage", "stop"],
  );
});
