// The plain path: two healthy accounts, one that rate-limits, one over quota — the routing,
// failover, accounting and logging the gateway has always had. Nothing here translates.

import type { Helpers } from "./harness.js";

export interface Context {
  base: string;
  helpers: Helpers;
  cli: (...args: string[]) => Promise<{ status: number | null; stdout: string; stderr: string }>;
  check: (name: string, ok: boolean, detail?: string) => void;
  stubBase: string;
}

export async function run(context: Context): Promise<void> {
  const { helpers, cli, check, stubBase } = context;
  const { admin, client, anthropicClient, key } = helpers;

  const account = async (label: string, extra: Record<string, unknown> = {}) => {
    const created = await admin("POST", "/admin/accounts", { label, base_url: `${stubBase}/v1`, api_key: `k-${label}`, ...extra });
    return (created.body?.data as { id: number } | undefined)?.id ?? -1;
  };
  const ids: Record<string, number> = {};
  const only = async (...labels: string[]) => {
    for (const [label, id] of Object.entries(ids)) await admin("POST", `/admin/accounts/${id}/enable`, { enabled: labels.includes(label) });
  };

  const added = await cli("account", "add", "--label", "plain-a", "--base-url", `${stubBase}/v1`, "--api-key", "k-plain-a");
  check("CLI account add", added.status === 0, added.stderr.trim().slice(0, 120));
  ids["plain-a"] = ((await admin("GET", "/admin/accounts")).body?.data as { id: number; label: string }[]).find((entry) => entry.label === "plain-a")?.id ?? -1;

  const madeKey = await cli("key", "add", "plain-client");
  const secret = /secret \(shown once[^)]*\): (\S+)/.exec(madeKey.stdout)?.[1] ?? "";
  check("CLI key add prints the secret once", madeKey.status === 0 && secret.startsWith("sk-gw-"), secret.slice(0, 12));
  check("the key listing never carries the secret", JSON.stringify((await admin("GET", "/admin/keys")).body).includes(secret) === false);

  ids["plain-c"] = await account("plain-c");
  ids["limited"] = await account("limited", { api_key: "k-429", priority: 50 });
  ids["over-quota"] = await account("over-quota", { api_key: "k-quota", priority: 50 });

  check("a call without a gateway key is refused", (await fetch(`${context.base}/v1/models`)).status === 401);
  const catalog = await fetch(`${context.base}/v1/models`, { headers: { authorization: `Bearer ${secret}` } });
  const catalogBody = (await catalog.json()) as { data?: unknown[] };
  check("GET /v1/models unions the accounts' catalogs", catalog.status === 200 && catalogBody.data?.length === 2, `${catalog.status}`);

  // A Claude client carries its key in x-api-key: that has to work on /v1/messages, or the
  // gateway is only "Anthropic compatible" for callers that send OpenAI's header.
  await only("plain-a");
  const anthropicHeader = await anthropicClient(secret, "/v1/messages", { model: "stub-mini", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
  check(
    "an Anthropic client's x-api-key is accepted and answered in its shape",
    anthropicHeader.status === 200 && anthropicHeader.text.includes('"type":"message"') && anthropicHeader.text.includes('"content":[{"type":"text"'),
    `${anthropicHeader.status} ${anthropicHeader.text.slice(0, 90)}`,
  );
  const wrongAnthropicKey = await anthropicClient("sk-gw-not-a-key", "/v1/messages", { model: "stub-mini", max_tokens: 16, messages: [] });
  check("and a wrong one is refused the same way", wrongAnthropicKey.status === 401, `${wrongAnthropicKey.status}`);

  await only("plain-a", "plain-c");
  const fingerprints: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const response = await client(secret, "/v1/chat/completions", { model: "stub-mini", messages: [{ role: "user", content: "hi" }] });
    fingerprints.push((JSON.parse(response.text) as { system_fingerprint: string }).system_fingerprint);
  }
  check(
    "two equal accounts alternate",
    JSON.stringify(fingerprints) === JSON.stringify(["acct:k-plain-a", "acct:k-plain-c", "acct:k-plain-a", "acct:k-plain-c"]),
    fingerprints.join(","),
  );

  const startedAt = Date.now();
  const streamed = await client(secret, "/v1/chat/completions", { model: "stub-mini", stream: true, messages: [] });
  const elapsed = Date.now() - startedAt;
  check("streaming arrives whole and terminated", streamed.status === 200 && streamed.text.includes('"content":"from-chat"') && streamed.text.trimEnd().endsWith("data: [DONE]"), `${elapsed}ms`);

  const tokens = ((await admin("GET", "/admin/usage?group=account")).body?.data as { tokens: number }[]).reduce((sum, row) => sum + row.tokens, 0);
  check("tokens are accounted from the usage frames", tokens >= 15 * 5, `tokens=${tokens}`);

  // Rate-limited first, then a body-level quota refusal: both must move the call on.
  await only("limited", "plain-a");
  check("a 429 account fails the call over", (await client(secret, "/v1/chat/completions", { model: "stub-mini", messages: [] })).status === 200);
  const parked = ((await admin("GET", "/admin/accounts")).body?.data as { label: string; status: string; lastError: string | null }[]).find((entry) => entry.label === "limited");
  check("the refusing account is parked with its error", parked?.status === "cooling" && String(parked?.lastError).includes("429"), JSON.stringify({ status: parked?.status }));

  await only("over-quota", "plain-a");
  check("a quota refusal in the body fails the call over too", (await client(secret, "/v1/chat/completions", { model: "stub-mini", messages: [] })).status === 200);
  const quotaParked = ((await admin("GET", "/admin/accounts")).body?.data as { label: string; status: string; lastError: string | null }[]).find((entry) => entry.label === "over-quota");
  check("with the upstream's own wording kept", quotaParked?.status === "cooling" && String(quotaParked?.lastError).includes("exceeded your current quota"), JSON.stringify({ status: quotaParked?.status }));

  await only("plain-a");
  check("an upstream 404 comes back as-is", (await client(secret, "/v1/does-not-exist", {})).status === 404);

  await only("plain-a");
  await fetch(`${stubBase}/_flaky`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ times: 1 }) });
  const retried = await client(secret, "/v1/chat/completions", { model: "stub-mini", messages: [] });
  const stillReady = ((await admin("GET", "/admin/accounts")).body?.data as { label: string; status: string }[]).find((entry) => entry.label === "plain-a");
  check("a dropped connection is retried on the same account", retried.status === 200 && stillReady?.status === "ready", JSON.stringify({ status: retried.status, account: stillReady?.status }));

  await admin("PATCH", `/admin/accounts/${ids["plain-c"]}`, { quota_limit: 1, enabled: true });
  await only("plain-a", "plain-c");
  const afterQuota: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const response = await client(secret, "/v1/chat/completions", { model: "stub-mini", messages: [] });
    afterQuota.push((JSON.parse(response.text) as { system_fingerprint: string }).system_fingerprint);
  }
  check("an account over its configured quota drops out", afterQuota.every((tag) => tag !== "acct:k-plain-c"), afterQuota.join(","));
  check(
    "the quota counter reflects the consumed tokens",
    ((await admin("GET", "/admin/accounts")).body?.data as { label: string; quotaUsed: number }[]).find((entry) => entry.label === "plain-c")?.quotaUsed >= 1,
  );

  for (const entry of (await admin("GET", "/admin/accounts")).body?.data as { id: number }[]) await admin("POST", `/admin/accounts/${entry.id}/enable`, { enabled: false });
  const starved = await client(secret, "/v1/chat/completions", { model: "stub-mini", messages: [] });
  check("no available account is a 503 with a code", starved.status === 503 && (JSON.parse(starved.text) as { error?: { code?: string } }).error?.code === "no_account_available", `${starved.status}`);
  const logged = (await admin("GET", "/admin/requests?limit=5")).body?.data as { status: number }[];
  check("every request is logged", logged.length === 5 && logged[0]?.status === 503, JSON.stringify(logged.map((row) => row.status)));

  void key;
}
