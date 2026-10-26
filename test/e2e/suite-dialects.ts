// Cross-dialect: an OpenAI client and a Claude client against upstreams that speak either
// dialect, including one that only answers the Responses API and only streamed (omnirush's
// shape). Same dialect must stay a byte-for-byte passthrough.

import type { Context } from "./suite-plain.js";

export async function run(context: Context): Promise<void> {
  const { helpers, check, stubBase } = context;
  const { admin, client } = helpers;

  const ids: Record<string, number> = {};
  for (const [label, extra] of [
    ["dial-chat", { dialect: "openai-chat" }],
    ["dial-responses", { dialect: "openai-responses", force_stream: true }],
    ["dial-anthropic", { dialect: "anthropic-messages" }],
    ["dial-strip", { dialect: "openai-responses", force_stream: true, strip_sampling: true }],
  ] as const) {
    const created = await admin("POST", "/admin/accounts", { label, base_url: `${stubBase}/v1`, api_key: `k-${label}`, ...extra });
    ids[label] = (created.body?.data as { id: number } | undefined)?.id ?? -1;
  }
  const only = async (label: string) => {
    for (const [name, id] of Object.entries(ids)) await admin("POST", `/admin/accounts/${id}/enable`, { enabled: name === label });
  };
  const secret = await helpers.key("dialects");

  // An upstream that refuses sampling parameters outright must not be sent any.
  await only("dial-strip");
  const stripped = await client(secret, "/v1/chat/completions", { model: "stub-mini", temperature: 0.5, top_p: 0.9, messages: [{ role: "user", content: "hi" }] });
  const stripState = await helpers.state();
  const stripSent = [...stripState.seen].reverse().find((entry) => entry.path.endsWith("/responses") && entry.key === "k-dial-strip");
  check("an account that refuses sampling is not sent temperature or top_p", stripped.status === 200 && !("temperature" in (stripSent?.body ?? {})) && !("top_p" in (stripSent?.body ?? {})), JSON.stringify(stripSent?.body).slice(0, 140));

  await only("dial-chat");
  const native = await client(secret, "/v1/chat/completions", { model: "stub-mini", messages: [{ role: "user", content: "hi" }] });
  check("openai chat client -> openai chat upstream", native.status === 200 && snapshot(native.text, "chat") === "from-chat", `${native.status}`);

  await only("dial-responses");
  const folded = await client(secret, "/v1/chat/completions", { model: "stub-mini", messages: [{ role: "user", content: "hi" }] });
  check(
    "chat client -> responses-only upstream, folded into one JSON answer",
    folded.status === 200 && snapshot(folded.text, "chat") === "from-responses",
    `${folded.status} ${folded.text.slice(0, 90)}`,
  );
  check("the folded answer carries the upstream's usage", (JSON.parse(folded.text) as { usage?: { total_tokens?: number } }).usage?.total_tokens === 27);

  const streamed = await client(secret, "/v1/chat/completions", { model: "stub-mini", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "hi" }] });
  check("chat stream <- responses upstream", streamed.status === 200 && streamed.text.includes("from-responses") && streamed.text.trimEnd().endsWith("data: [DONE]"), `${streamed.status}`);
  check("the translated stream keeps the upstream's usage frame", /"total_tokens":27/.test(streamed.text), streamed.text.slice(-120).replace(/\n/g, " "));

  await only("dial-chat");
  const claudeStream = await client(secret, "/v1/messages", { model: "stub-mini", max_tokens: 64, stream: true, system: "be terse", messages: [{ role: "user", content: "hi" }] });
  check(
    "claude stream <- openai chat upstream",
    claudeStream.status === 200 && claudeStream.text.includes('"text_delta","text":"from-chat"') && claudeStream.text.includes("message_stop"),
    `${claudeStream.status}`,
  );
  check("the claude stream carries anthropic usage", /"input_tokens":10,"output_tokens":5/.test(claudeStream.text), claudeStream.text.slice(-140).replace(/\n/g, " "));

  const claudeWhole = await client(secret, "/v1/messages", { model: "stub-mini", max_tokens: 64, messages: [{ role: "user", content: "hi" }] });
  const whole = JSON.parse(claudeWhole.text) as { type?: string; content?: { text?: string }[]; stop_reason?: string };
  check("claude whole answer <- openai chat upstream", claudeWhole.status === 200 && whole.content?.[0]?.text === "from-chat" && whole.stop_reason === "end_turn", `${claudeWhole.status}`);

  await only("dial-anthropic");
  const claudeNative = await client(secret, "/v1/messages", { model: "stub-mini", max_tokens: 64, messages: [{ role: "user", content: "hi" }] });
  check("claude client -> anthropic upstream", claudeNative.status === 200 && (JSON.parse(claudeNative.text) as { content?: { text?: string }[] }).content?.[0]?.text === "from-anthropic", `${claudeNative.status}`);

  // Tools, in both directions across the dialect boundary.
  await only("dial-chat");
  const claudeToOpenAi = await client(secret, "/v1/messages", {
    model: "stub-mini",
    max_tokens: 64,
    messages: [{ role: "user", content: "read a.txt" }],
    tools: [{ name: "read", description: "read", input_schema: { type: "object" } }],
  });
  const toolUse = JSON.parse(claudeToOpenAi.text) as { content?: { type?: string; name?: string; input?: { path?: string } }[] };
  check(
    "a tool call from an openai upstream comes back as anthropic tool_use",
    toolUse.content?.[0]?.type === "tool_use" && toolUse.content[0].name === "read" && toolUse.content[0].input?.path === "a.txt",
    claudeToOpenAi.text.slice(0, 120),
  );

  // The translated request must carry what that upstream demands.
  await only("dial-responses");
  await client(secret, "/v1/chat/completions", { model: "stub-mini", messages: [{ role: "system", content: "instructions text" }, { role: "user", content: "hi" }] });
  const state = await helpers.state();
  const sent = [...state.seen].reverse().find((entry) => entry.path.endsWith("/responses") && entry.key === "k-dial-responses");
  check("the translated responses request says store:false and stream:true", sent?.body.store === false && sent?.body.stream === true, JSON.stringify(sent?.body).slice(0, 140));
  check("openai messages become responses items", Array.isArray(sent?.body.input) && (sent?.body.input as { content?: { type?: string }[] }[])[0]?.content?.[0]?.type === "input_text", JSON.stringify(sent?.body.input).slice(0, 140));
  check("a system message becomes instructions", sent?.body.instructions === "instructions text", JSON.stringify(sent?.body.instructions));

  await only("dial-chat");
  await client(secret, "/v1/messages", { model: "stub-mini", max_tokens: 64, system: "claude system", messages: [{ role: "user", content: "hi" }] });
  const afterClaude = await helpers.state();
  const asChat = [...afterClaude.seen].reverse().find((entry) => entry.path.endsWith("/chat/completions") && entry.key === "k-dial-chat");
  const messages = asChat?.body.messages as { role?: string; content?: string }[] | undefined;
  check("a claude system turn reaches an openai upstream as a system message", messages?.[0]?.role === "system" && messages[0].content === "claude system", JSON.stringify(asChat?.body).slice(0, 140));
  check("max_tokens travels into max_tokens", asChat?.body.max_tokens === 64, String(asChat?.body.max_tokens));
}

/** The assistant text of an OpenAI-shaped answer. */
function snapshot(body: string, _dialect: "chat"): string {
  const parsed = JSON.parse(body) as { choices?: { message?: { content?: string } }[] };
  return parsed.choices?.[0]?.message?.content ?? "";
}
