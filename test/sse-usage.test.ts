// The SSE scanner is the one piece of the data plane with real parsing to get wrong:
// frames arrive split across chunks, and the two OpenAI dialects put the same numbers
// in different places. These frames are copies of what the upstreams actually send.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createSseUsageScanner } from "../src/openai.js";

const encode = (text: string) => new TextEncoder().encode(text);

function scan(frames: string[], chunkSize = 4096) {
  const scanner = createSseUsageScanner();
  const whole = frames.join("");
  for (let at = 0; at < whole.length; at += chunkSize) scanner.push(encode(whole.slice(at, at + chunkSize)));
  return scanner.usage();
}

test("chat completions usage, in one frame", () => {
  const usage = scan([
    'data: {"id":"c1","choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":10,"total_tokens":25}}\n\n',
    "data: [DONE]\n\n",
  ]);
  assert.deepEqual(usage, { prompt: 15, completion: 10, total: 25 });
});

test("responses API usage, nested under response", () => {
  const usage = scan([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"r1","usage":null}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":11,"input_tokens_details":{"cached_tokens":0},"output_tokens":6,"total_tokens":17}}}\n\n',
  ]);
  assert.deepEqual(usage, { prompt: 11, completion: 6, total: 17 });
});

test("usage survives being split one byte at a time", () => {
  const usage = scan(
    [
      'data: {"id":"c1","choices":[]}\n\n',
      'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
    ],
    1,
  );
  assert.deepEqual(usage, { prompt: 7, completion: 3, total: 10 });
});

test("a null usage frame never overwrites a real one", () => {
  const usage = scan([
    'data: {"type":"response.in_progress","response":{"usage":null}}\n\n',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":1,"total_tokens":5}}}\n\n',
  ]);
  assert.deepEqual(usage, { prompt: 4, completion: 1, total: 5 });
});

test("a stream without usage reports nothing", () => {
  assert.equal(scan(['data: {"id":"c1","choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"]), null);
});

test("non-SSE noise does not invent usage", () => {
  assert.equal(scan(['{"error":{"message":"nope"}}', "event: ping\n"]), null);
});
