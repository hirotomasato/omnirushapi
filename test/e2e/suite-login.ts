// Device-flow login, then the account keeping itself alive: proactive renewal, renewal
// after a refusal, and concurrent refusals sharing one rotation (providers count a second
// presentation of a superseded refresh token as a shared credential).

import type { Context } from "./suite-plain.js";

export async function run(context: Context): Promise<void> {
  const { helpers, cli, check, stubBase } = context;
  const { admin, client } = helpers;

  // The earlier suites leave accounts behind; this one must only ever reach the account the
  // login just filed, or "did it renew" would measure another account's token.
  for (const entry of ((await admin("GET", "/admin/accounts")).body?.data as { id: number }[]) ?? []) {
    await admin("POST", `/admin/accounts/${entry.id}/enable`, { enabled: false });
  }

  const login = await cli("login", "omnirush", "--origin", `${stubBase}/manager`, "--label", "e2e-login", "--no-open");
  check("CLI login exits cleanly", login.status === 0, login.stderr.trim().slice(0, 200));
  check("it waited for the approval instead of giving up", /approved\./.test(login.stdout), login.stdout.split("\n").slice(-3).join(" | "));

  const accounts = (await admin("GET", "/admin/accounts")).body?.data as
    | { id: number; label: string; provider: string; dialect: string; forceStream: boolean; baseUrl: string; apiKey: string; refreshToken: string | null; extraHeaders: Record<string, string> }[]
    | undefined;
  const account = accounts?.find((entry) => entry.label === "e2e-login");
  check("the login filed an account", Boolean(account), JSON.stringify(accounts?.map((entry) => entry.label)));
  check(
    "with the provider's dialect, stream rule and client headers",
    account?.provider === "omnirush" && account?.dialect === "openai-responses" && account?.forceStream === true && account?.extraHeaders?.["user-agent"] === "omnirush",
    JSON.stringify({ provider: account?.provider, dialect: account?.dialect, stream: account?.forceStream, headers: account?.extraHeaders }),
  );
  check("pointing at the gateway we asked for", account?.baseUrl === `${stubBase}/manager/v1`, String(account?.baseUrl));
  check("the refresh token was kept", typeof account?.refreshToken === "string" && account.refreshToken.startsWith("rt-"));
  check("the access token is never echoed by the CLI", !login.stdout.includes(String(account?.apiKey)));

  const secret = await helpers.key("login-client");
  const call = () => client(secret, "/v1/responses", { model: "stub-mini", input: "hi", stream: true, store: false });

  const first = await call();
  check("a client call works on the freshly minted token", first.status === 200 && first.text.includes("from-responses"), `${first.status} ${first.text.slice(0, 80)}`);
  check("a token nowhere near expiry is not rotated for fun", (await helpers.state()).refreshCalls === 0);

  await admin("PATCH", `/admin/accounts/${account?.id}`, { token_expires_at: new Date(Date.now() - 60_000).toISOString() });
  const renewed = await call();
  check("a spent token is renewed before the call", renewed.status === 200 && (await helpers.state()).refreshCalls === 1, `${renewed.status}`);

  await fetch(`${stubBase.replace(/\/manager$/, "")}/_invalidate`);
  const afterRefusal = await call();
  check("a refused token is renewed and the same call retried", afterRefusal.status === 200 && (await helpers.state()).refreshCalls === 2, `${afterRefusal.status}`);

  await fetch(`${stubBase.replace(/\/manager$/, "")}/_invalidate`);
  const parallel = await Promise.all([call(), call(), call()]);
  const counts = await helpers.state();
  check(
    "three concurrent refusals share one rotation",
    parallel.every((result) => result.status === 200) && counts.refreshCalls === 3,
    JSON.stringify({ statuses: parallel.map((result) => result.status), refreshCalls: counts.refreshCalls }),
  );

  const after = ((await admin("GET", "/admin/accounts")).body?.data as { label: string; status: string; refreshToken: string | null }[]).find((entry) => entry.label === "e2e-login");
  check("the account stayed ready and its token rotated", after?.status === "ready" && after?.refreshToken !== account?.refreshToken, JSON.stringify({ status: after?.status }));
  const logged = (await admin("GET", "/admin/requests?limit=6")).body?.data as { status: number; totalTokens: number | null }[];
  check("the calls are logged with the upstream's tokens", logged.length >= 5 && logged.some((row) => row.totalTokens === 27), JSON.stringify(logged.map((row) => [row.status, row.totalTokens])));

  // The same login, driven from the console: the page's own refresh is the poll.
  await fetch(`${stubBase.replace(/\/manager$/, "")}/_pending`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ times: 1 }) });
  // `redirect: manual` matters: fetch follows the 303s below and would hide both the
  // set-cookie and the location header, which are the things worth asserting.
  const form = (fields: Record<string, string>) => ({
    method: "POST",
    redirect: "manual" as const,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  const signIn = await fetch(`${context.base}/login`, form({ user: "console", password: "e2e-console-password" }));
  const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  check("the console session cookie is set", cookie.startsWith("gw_session="), cookie.slice(0, 16));

  /** Every console button is a form post: it must answer 303, and the page must follow. */
  const post = (path: string, fields: Record<string, string> = {}) => fetch(`${context.base}${path}`, { ...form(fields), headers: { ...form({}).headers, cookie } });
  const page = async (path: string): Promise<{ status: number; html: string }> => {
    const response = await fetch(`${context.base}${path}`, { headers: { cookie } });
    return { status: response.status, html: await response.text() };
  };

  const started = await post("/dashboard/accounts/providers/omnirush/start", { origin: `${stubBase}/manager`, label: "console-login" });
  const startedAt = started.headers.get("location") ?? "";
  check(
    "the sign-in button redirects instead of rendering, so a reload cannot re-post it",
    started.status === 303 && startedAt.startsWith("/dashboard/accounts?flash="),
    `${started.status} ${startedAt.slice(0, 60)}`,
  );
  const waiting = await page("/dashboard/accounts");
  check("the page it lands on shows the approval card", waiting.status === 200 && waiting.html.includes("Waiting for approval") && waiting.html.includes("E2E-CODE"), `${waiting.status}`);
  check(
    "while waiting it checks back every three seconds",
    waiting.html.includes("setInterval(tick,3000)") && waiting.html.includes('addEventListener("visibilitychange"') && waiting.html.includes("approval page"),
    waiting.html.match(/setInterval\(tick,[0-9]+\)/)?.[0] ?? "no timer",
  );

  const finished = await page("/dashboard/accounts");
  check("the next render finishes the login", finished.status === 200 && finished.html.includes("Signed in: account &quot;console-login&quot;"), `${finished.status}`);
  const consoleAccount = ((await admin("GET", "/admin/accounts")).body?.data as { id: number; label: string; dialect: string; forceStream: boolean; refreshToken: string | null }[]).find((entry) => entry.label === "console-login");
  check(
    "the console account carries the provider's shape and renews itself",
    consoleAccount?.dialect === "openai-responses" && consoleAccount?.forceStream === true && typeof consoleAccount?.refreshToken === "string",
    JSON.stringify(consoleAccount),
  );
  check("and the table marks it as renewing", finished.html.includes("auto-renews"));

  // The provider's own quota: shown next to the gateway's own count, and refresheable.
  const withQuota = await post(`/dashboard/accounts/${consoleAccount?.id}/quota`);
  const quotaWhere = withQuota.headers.get("location") ?? "";
  const quotaFlash = decodeURIComponent(quotaWhere);
  check(
    "the quota button reports what the provider said",
    withQuota.status === 303 && /Quota for console-login: [\d,]+ of [\d,]+ used today/.test(quotaFlash),
    quotaFlash.match(/Quota for[^&]*/)?.[0] ?? `${withQuota.status}`,
  );
  const quotaHtml = (await page(quotaWhere)).html;
  check("the account row shows the provider's numbers, labelled", quotaHtml.includes("provider:") && quotaHtml.includes("through this gateway"), "provider block");
  check("including what is left and the weekly cap", quotaHtml.includes("3,765,433 left") && quotaHtml.includes("week 4,321,000 / 15,000,000"), quotaHtml.match(/provider:[^<]*/)?.[0] ?? "");

  // The manager can refuse a token the gateway still believes in: another client on the same
  // device rotates the pair. The quota check must renew and ask again, not report 401.
  await fetch(`${stubBase.replace(/\/manager$/, "")}/_invalidate`);
  const beforeRenew = (await helpers.state()).refreshCalls;
  const refused = await post(`/dashboard/accounts/${consoleAccount?.id}/quota`);
  const refusedFlash = decodeURIComponent(refused.headers.get("location") ?? "");
  check(
    "a refused quota check renews the token and asks again",
    refused.status === 303 && /Quota for console-login: 1,234,567/.test(refusedFlash) && (await helpers.state()).refreshCalls === beforeRenew + 1,
    refusedFlash.match(/Quota for[^&]*|could not[^&]*/)?.[0] ?? `${refused.status}`,
  );

  const stored = ((await admin("GET", "/admin/accounts")).body?.data as { label: string; providerUsage: { used: number; limit: number; pot: number; error: string | null } | null }[]).find((entry) => entry.label === "console-login");
  check(
    "the snapshot is stored on the account",
    stored?.providerUsage?.used === 1_234_567 && stored?.providerUsage?.limit === 5_000_000 && stored?.providerUsage?.pot === 500_000 && stored?.providerUsage?.error === null,
    JSON.stringify(stored?.providerUsage),
  );

  // Every page of the console, and the buttons that act on it.
  const pages = [
    { path: "/dashboard", expect: "Provider quota" },
    { path: "/dashboard/accounts", expect: "Sign in to a provider" },
    { path: "/dashboard/models", expect: "Ask upstream again" },
    { path: "/dashboard/keys", expect: "Create key" },
    { path: "/dashboard/usage", expect: "Tokens per request" },
    { path: "/dashboard/requests", expect: "Errors only" },
  ];
  let sidebarComplete = true;
  for (const entry of pages) {
    const rendered = await page(entry.path);
    check(`${entry.path} renders its own page`, rendered.status === 200 && rendered.html.includes(entry.expect), `${rendered.status}`);
    if (!pages.every((other) => rendered.html.includes(`href="${other.path}"`))) sidebarComplete = false;
  }
  check("every page carries the whole sidebar", sidebarComplete, "nav links");

  const models = await page("/dashboard/models");
  check("the Models page lists what the accounts advertise", models.html.includes("stub-mini") && models.html.includes("stub-pro") && (models.html.match(/<tr id="model-/g) ?? []).length === 2, "catalog rows");
  const refreshed = await post("/dashboard/models/refresh");
  check("the refresh button re-asks the upstreams", refreshed.status === 303 && decodeURIComponent(refreshed.headers.get("location") ?? "").includes("2 models"), refreshed.headers.get("location") ?? "");
  const empty = await page("/dashboard/requests?limit=10&errors=1");
  check("the requests filter narrows to failures", empty.status === 200 && empty.html.includes("Errors only"), `${empty.status}`);

  // Accounts: disable, enable, reset — the same three buttons the browser shows.
  const off = await post(`/dashboard/accounts/${consoleAccount?.id}/enable`, { enabled: "0" });
  const disabled = ((await admin("GET", "/admin/accounts")).body?.data as { label: string; enabled: boolean }[]).find((entry) => entry.label === "console-login");
  check("the disable button takes effect", off.status === 303 && disabled?.enabled === false, `${off.status} ${JSON.stringify(disabled)}`);
  const on = await post(`/dashboard/accounts/${consoleAccount?.id}/enable`, { enabled: "1" });
  const reEnabled = ((await admin("GET", "/admin/accounts")).body?.data as { label: string; enabled: boolean }[]).find((entry) => entry.label === "console-login");
  check("and the enable button puts it back", on.status === 303 && reEnabled?.enabled === true, `${on.status}`);
  const reset = await post(`/dashboard/accounts/${consoleAccount?.id}/reset`);
  check("the reset button answers with a redirect", reset.status === 303, `${reset.status}`);

  // Keys: create (the secret is shown once), disable, delete.
  const createdKey = await post("/dashboard/keys", { name: "console-key" });
  check("creating a key redirects to the list", createdKey.status === 303 && (createdKey.headers.get("location") ?? "").startsWith("/dashboard/keys?flash="), `${createdKey.status}`);
  const keysHtml = (await page("/dashboard/keys")).html;
  const shownSecret = keysHtml.match(/sk-gw-[A-Za-z0-9_-]{16,}/)?.[0] ?? "";
  check("the new secret is shown once on that page", shownSecret !== "" && keysHtml.includes("New client key created"), shownSecret.slice(0, 12));
  check("and it is not in the URL", !(createdKey.headers.get("location") ?? "").includes("sk-gw-"), createdKey.headers.get("location") ?? "");
  const keyRows = (await admin("GET", "/admin/keys")).body?.data as { id: number; name: string; enabled: boolean }[];
  const consoleKey = keyRows.find((entry) => entry.name === "console-key");
  const keyOff = await post(`/dashboard/keys/${consoleKey?.id}/enable`, { enabled: "0" });
  check("the key's disable button takes effect", keyOff.status === 303 && ((await admin("GET", "/admin/keys")).body?.data as { id: number; enabled: boolean }[]).find((entry) => entry.id === consoleKey?.id)?.enabled === false, `${keyOff.status}`);
  const keyGone = await post(`/dashboard/keys/${consoleKey?.id}/delete`);
  check("the key's delete button takes effect", keyGone.status === 303 && !((await admin("GET", "/admin/keys")).body?.data as { id: number }[]).some((entry) => entry.id === consoleKey?.id), `${keyGone.status}`);

  // Signed out: the pages are closed, and the login form is what answers.
  const anonymous = await fetch(`${context.base}/dashboard/accounts`);
  const anonymousHtml = await anonymous.text();
  check("a page without a session is refused with the login form", anonymous.status === 401 && anonymousHtml.includes("Sign in to the admin console"), `${anonymous.status}`);
  const out = await fetch(`${context.base}/logout`, form({}));
  check("signing out clears the cookie", out.status === 303 && /gw_session=;/.test(out.headers.get("set-cookie") ?? ""), out.headers.get("set-cookie") ?? "");
}
