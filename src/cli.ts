#!/usr/bin/env -S node --env-file-if-exists=.env --import tsx
// Thin admin client: everything it does is one admin API call, except `login`, which runs
// the provider's device flow and then files the token as an account.

import { loadConfig } from "./config.js";
import { createOutboundFetch, nativeFetch } from "./curl.js";
import { PROVIDERS, beginDeviceLogin, openBrowser, pollDeviceLogin, providerPreset, withOrigin } from "./providers.js";

const USAGE = `omnirushapi <command>

  status                                  gateway health and counts
  providers                               upstreams that can be logged into
  login <provider>                        device-flow sign-in: opens the browser once, then
                                          files the token as an account (renews itself)
                [--label L] [--origin URL] [--account-id N] [--no-open]
  account add --label L --base-url U --api-key K
                [--provider P] [--dialect openai-chat|openai-responses|anthropic-messages]
                [--priority N] [--weight N] [--quota-limit N] [--quota-reset ISO]
                [--force-stream|--no-force-stream] [--headers '{"x-name":"value"}']
  account patch <id> [same optional flags as add]
  account list | get <id> | rm <id> | enable <id> | disable <id> | reset <id>
  account quota <id>                      ask the provider how much is left
  key add <name> | list | rm <id> | enable <id> | disable <id>
  usage [--since ISO] [--group account|key|model]
  requests [--limit N]

Flags: --url <base> (default $AI_GATEWAY_URL or http://127.0.0.1:8787)
       --token <admin token> (default $ADMIN_TOKEN)
       --json   print the raw reply`;

interface Flags {
  positional: string[];
  options: Map<string, string>;
  json: boolean;
}

/** Flags that stand alone: their presence is the value. */
const BOOLEAN_FLAGS: Record<string, [key: string, value: string]> = {
  "--force-stream": ["force-stream", "true"],
  "--no-force-stream": ["force-stream", "false"],
  "--no-open": ["no-open", "true"],
  "--strip-sampling": ["strip-sampling", "true"],
  "--keep-sampling": ["strip-sampling", "false"],
};

function parseArgs(argv: string[]): Flags {
  const positional: string[] = [];
  const options = new Map<string, string>();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    const boolean = BOOLEAN_FLAGS[argument];
    if (boolean) {
      options.set(boolean[0], boolean[1]);
      continue;
    }
    if (argument.startsWith("--")) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${argument} needs a value`);
      options.set(argument.slice(2), value);
      index += 1;
      continue;
    }
    positional.push(argument);
  }
  return { positional, options, json };
}

const flags = parseArgs(process.argv.slice(2));
const baseUrl = (flags.options.get("url") ?? process.env.AI_GATEWAY_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const adminToken = flags.options.get("token") ?? process.env.ADMIN_TOKEN ?? "";

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "x-admin-token": adminToken,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const described =
      typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "object" && payload.error !== null && "message" in payload.error
        ? String(payload.error.message)
        : text;
    throw new Error(`${method} ${path} -> HTTP ${response.status}: ${described}`);
  }
  return payload;
}

/** The `data` field of an admin reply, or the reply itself. */
function payloadData(payload: unknown): unknown {
  if (typeof payload === "object" && payload !== null && "data" in payload) return payload.data;
  return payload;
}

function print(rows: unknown): void {
  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (Array.isArray(rows)) {
    for (const row of rows) console.log(formatRow(row));
    if (rows.length === 0) console.log("(empty)");
    return;
  }
  console.log(formatRow(rows));
}

/** Credentials are masked here; `--json` still prints the raw reply for scripting. */
const SECRET_FIELDS = /^(api_?key|refresh_?token|secret|token|password)$/i;

function maskedSecret(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : "…";
}

function formatRow(row: unknown): string {
  if (typeof row !== "object" || row === null) return String(row);
  return Object.entries(row)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => {
      const shown =
        SECRET_FIELDS.test(key) && typeof value === "string"
          ? maskedSecret(value)
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value);
      return `${key}=${shown}`;
    })
    .join("  ");
}

function numberOf(name: string): number {
  const raw = flags.options.get(name);
  if (raw === undefined) throw new Error(`--${name} is required`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`--${name} must be an integer (got ${raw})`);
  return value;
}

function idArgument(): number {
  const raw = flags.positional[2];
  if (raw === undefined) throw new Error("an id is required");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`id must be an integer (got ${raw})`);
  return value;
}

function jsonArgument(name: string): unknown {
  const raw = flags.options.get(name);
  if (raw === undefined) throw new Error(`--${name} is required`);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`--${name} must be JSON (got ${raw})`);
  }
}

/** The account fields present on the command line, in the admin API's spelling. */
function accountFields(): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const text = (flag: string, key: string): void => {
    const value = flags.options.get(flag);
    if (value !== undefined) fields[key] = value;
  };
  const integer = (flag: string, key: string): void => {
    if (flags.options.has(flag)) fields[key] = numberOf(flag);
  };
  text("provider", "provider");
  text("dialect", "dialect");
  text("base-url", "base_url");
  text("api-key", "api_key");
  text("quota-reset", "quota_reset_at");
  if (flags.options.has("headers")) fields.extra_headers = jsonArgument("headers");
  if (flags.options.has("force-stream")) fields.force_stream = flags.options.get("force-stream") === "true";
  if (flags.options.has("strip-sampling")) fields.strip_sampling = flags.options.get("strip-sampling") === "true";
  integer("priority", "priority");
  integer("weight", "weight");
  integer("quota-limit", "quota_limit");
  return fields;
}

/** The id of the account with this label, from what the admin API listed. */
function accountIdFor(accounts: unknown, label: string): number | null {
  if (!Array.isArray(accounts)) return null;
  for (const entry of accounts) {
    if (typeof entry !== "object" || entry === null) continue;
    if (!("label" in entry) || !("id" in entry)) continue;
    if (entry.label === label && typeof entry.id === "number") return entry.id;
  }
  return null;
}

async function run(): Promise<void> {
  const [command, sub = "", extra] = flags.positional;
  if (!command || command === "help") {
    console.log(USAGE);
    return;
  }

  if (command === "status") {
    print(await call("GET", "/admin/health"));
    return;
  }

  if (command === "account") {
    if (sub === "add") {
      const created = await call("POST", "/admin/accounts", {
        label: flags.options.get("label"),
        base_url: flags.options.get("base-url"),
        api_key: flags.options.get("api-key"),
        ...accountFields(),
      });
      print(payloadData(created));
      return;
    }
    if (sub === "patch") {
      const updated = await call("PATCH", `/admin/accounts/${idArgument()}`, accountFields());
      print(payloadData(updated));
      return;
    }
    if (sub === "list" || sub === "") {
      print(payloadData(await call("GET", "/admin/accounts")));
      return;
    }
    if (sub === "get") {
      print(payloadData(await call("GET", `/admin/accounts/${idArgument()}`)));
      return;
    }
    if (sub === "rm") {
      print(payloadData(await call("DELETE", `/admin/accounts/${idArgument()}`)));
      return;
    }
    if (sub === "enable" || sub === "disable") {
      print(payloadData(await call("POST", `/admin/accounts/${idArgument()}/enable`, { enabled: sub === "enable" })));
      return;
    }
    if (sub === "reset") {
      print(payloadData(await call("POST", `/admin/accounts/${idArgument()}/reset`)));
      return;
    }
    if (sub === "quota") {
      print(payloadData(await call("POST", `/admin/accounts/${idArgument()}/quota`)));
      return;
    }
    throw new Error(`unknown account subcommand: ${sub}`);
  }

  if (command === "key") {
    if (sub === "add") {
      if (extra === undefined) throw new Error("a key name is required");
      const created = await call("POST", "/admin/keys", { name: extra });
      print(payloadData(created));
      if (typeof created === "object" && created !== null && "secret" in created) {
        console.log(`\nsecret (shown once, store it now): ${String(created.secret)}`);
      }
      return;
    }
    if (sub === "list" || sub === "") {
      print(payloadData(await call("GET", "/admin/keys")));
      return;
    }
    if (sub === "rm") {
      print(payloadData(await call("DELETE", `/admin/keys/${idArgument()}`)));
      return;
    }
    if (sub === "enable" || sub === "disable") {
      print(payloadData(await call("POST", `/admin/keys/${idArgument()}/enable`, { enabled: sub === "enable" })));
      return;
    }
    throw new Error(`unknown key subcommand: ${sub}`);
  }

  if (command === "usage") {
    const query = new URLSearchParams();
    const since = flags.options.get("since");
    const group = flags.options.get("group");
    if (since) query.set("since", since);
    if (group) query.set("group", group);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    print(payloadData(await call("GET", `/admin/usage${suffix}`)));
    return;
  }

  if (command === "requests") {
    const limit = flags.options.get("limit");
    print(payloadData(await call("GET", `/admin/requests${limit ? `?limit=${encodeURIComponent(limit)}` : ""}`)));
    return;
  }

  if (command === "providers") {
    for (const preset of Object.values(PROVIDERS)) console.log(`${preset.id.padEnd(12)} ${preset.label}`);
    return;
  }

  if (command === "login") {
    const requested = sub || "omnirush";
    const origin = flags.options.get("origin");
    const preset = origin ? withOrigin(providerPreset(requested), origin) : providerPreset(requested);
    const routing = loadConfig();
    const transport = routing.outboundProxy
      ? createOutboundFetch({ bin: routing.curlBin, proxy: routing.outboundProxy })
      : nativeFetch;
    const label = flags.options.get("label") ?? preset.id;

    console.log(`Signing in to ${preset.label}`);
    const login = await beginDeviceLogin(preset, { transport });
    console.log(`  code: ${login.userCode}`);
    console.log(`  open: ${login.verificationUriComplete}`);
    const opened = flags.options.has("no-open") ? false : openBrowser(login.verificationUriComplete);
    console.log(opened ? "  (opened in your browser — approve it there)" : "  (open the link above, approve it, then come back)");

    const tokens = await pollDeviceLogin(preset, {
      transport,
      deviceCode: login.deviceCode,
      intervalSec: login.intervalSec,
      expiresAt: Date.now() + login.expiresInSec * 1_000,
      onWait: (round) => {
        if (round % 6 === 0) process.stdout.write(".");
      },
    });
    console.log(`\napproved.`);

    const account = {
      label,
      provider: preset.id,
      dialect: preset.dialect,
      force_stream: preset.forceStream,
      strip_sampling: preset.stripSampling,
      base_url: `${preset.origin}${preset.apiBase}`,
      api_key: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_expires_at: tokens.expiresInSec === null ? null : new Date(Date.now() + tokens.expiresInSec * 1_000).toISOString(),
      oauth_origin: preset.origin,
      extra_headers: preset.accountHeaders,
    };
    const existing = accountIdFor(payloadData(await call("GET", "/admin/accounts")), label);
    const forced = flags.options.get("account-id");
    const target = forced !== undefined ? Number(forced) : existing;

    if (target === null) print(payloadData(await call("POST", "/admin/accounts", account)));
    else print(payloadData(await call("PATCH", `/admin/accounts/${target}`, account)));
    console.log(`\nSaved as account "${label}"${tokens.refreshToken ? " — the gateway renews it with the refresh token" : ""}.`);
    console.log("Tokens stay in the database; the console and this CLI only ever show them masked.");
    return;
  }

  throw new Error(`unknown command: ${command}\n\n${USAGE}`);
}

try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
