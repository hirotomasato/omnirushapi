// The console's pages: one route each, one concern each.
//
// Everything here is server-rendered HTML — no client framework, no build step, no fetch
// dance. A page is a pure function of the database, so a reload always tells the truth.

import { listAccounts } from "../accounts.js";
import type { Config } from "../config.js";
import type { UpstreamFetch } from "../curl.js";
import type { Db } from "../db.js";
import { DIALECT_LABEL } from "../dialects/index.js";
import { listKeys } from "../keys.js";
import type { Catalog, CatalogSource } from "../models.js";
import { PROVIDERS } from "../providers.js";
import type { QuotaRefresher } from "../quota.js";
import { recentRequests, usageSummary, type UsageGroup } from "../usage.js";
import { accountRows, dialectOptions, emptyRow, keyRows, modelRows, providerQuota, quotaView, requestRows, usageTable } from "./tables.js";
import {
  accountStatus,
  escapeHtml,
  formatNumber,
  ICONS,
  pageHead,
  renderShell,
  statCard,
  uptimeText,
  type Flash,
  type PageId,
  type ShellOptions,
  type WaitingLogin,
} from "./shell.js";

export type { Flash, WaitingLogin } from "./shell.js";

export interface ConsoleDeps {
  db: Db;
  config: Config;
  adminToken: string;
  startedAt: number;
  version: string;
  /** How the console reaches a provider's device endpoints (same route out as the data plane). */
  transport: UpstreamFetch;
  /** Asks providers what is left on each account. */
  quotas: QuotaRefresher;
  /** The model list, shared with the data plane. */
  catalogSource: CatalogSource;
}

/** What the shell needs from the route: the frame around a page's own content. */
export interface PageMeta {
  flash: Flash | null;
  secret: string | null;
  waiting: WaitingLogin | null;
  /** Seconds between self-refreshes, or null while the page must stay put. */
  refreshSeconds: number | null;
  hint: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The policy in one line: what the numbers in the Runtime cards belong to. */
function runtimeLine(config: Config, startedAt: number): string {
  return `${config.strategy} · up ${uptimeText(startedAt, Date.now())} · ${config.maxAttempts} attempts · ${Math.round(config.cooldownMs / 1_000)}s cooldown`;
}

function totalsOf(rows: { requests: number; tokens: number; errors: number }[]): { requests: number; tokens: number; errors: number } {
  const totals = { requests: 0, tokens: 0, errors: 0 };
  for (const row of rows) {
    totals.requests += row.requests;
    totals.tokens += row.tokens;
    totals.errors += row.errors;
  }
  return totals;
}

/** The gateway's public address, as the client should write it. */
function baseUrlOf(config: Config): string {
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  return `http://${host}:${config.port}`;
}

function clientSnippet(config: Config): string {
  return `export OPENAI_BASE_URL=${baseUrlOf(config)}/v1
export OPENAI_API_KEY=sk-gw-…      # a client key from the Keys page

curl -sS ${baseUrlOf(config)}/v1/chat/completions \\
  -H "authorization: Bearer $OPENAI_API_KEY" -H "content-type: application/json" \\
  -d '{"model":"<model id from the Models page>","messages":[{"role":"user","content":"hi"}]}'`;
}

function shell(deps: ConsoleDeps, active: PageId, meta: PageMeta, content: string): string {
  const options: ShellOptions = {
    version: deps.version,
    active,
    refreshSeconds: meta.refreshSeconds,
    flash: meta.flash,
    secret: meta.secret,
    waiting: meta.waiting,
    hint: meta.hint,
  };
  return renderShell(options, content);
}

// --- overview ------------------------------------------------------------------------

export function overviewPage(deps: ConsoleDeps, meta: PageMeta): string {
  const accounts = listAccounts(deps.db);
  const keys = listKeys(deps.db);
  const since = new Date(Date.now() - DAY).toISOString();
  const byAccount = usageSummary(deps.db, since, "account");
  const totals = totalsOf(byAccount);
  const errorRate = totals.requests === 0 ? "0%" : `${Math.round((totals.errors / totals.requests) * 100)}%`;
  const counts = { ready: 0, cooling: 0, dead: 0, disabled: 0 };
  for (const account of accounts) counts[accountStatus(account)] += 1;

  const quotaCards = accounts.flatMap((account) => {
    const quota = quotaView(account);
    return quota === null ? [] : [{ account, quota }];
  });
  const attention = accounts.filter((account) => accountStatus(account) === "dead" || (account.enabled && account.lastError !== null));

  const content = `
  ${pageHead(ICONS.overview, "Overview", `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}`)}
  <div class="stack">
    <div class="stats">
      ${statCard(ICONS.accounts, String(accounts.length), "Accounts", `${counts.ready} ready · ${counts.cooling} cooling · ${counts.dead} dead${counts.disabled > 0 ? ` · ${counts.disabled} disabled` : ""}`)}
      ${statCard(ICONS.requests, formatNumber(totals.requests), "Requests, 24h", `${formatNumber(totals.errors)} errors · ${errorRate}`)}
      ${statCard(ICONS.usage, formatNumber(totals.tokens), "Tokens, 24h", "prompt + completion")}
      ${statCard(ICONS.keys, String(keys.length), "Client keys", `${keys.filter((key) => key.enabled).length} enabled`)}
    </div>
    ${
      attention.length === 0
        ? ""
        : `<section class="card"><h2>${ICONS.power}Needs attention</h2><div class="stack" style="margin-top:10px">${attention
            .map(
              (account) =>
                `<div class="flash bad" style="margin:0"><strong>${escapeHtml(account.label)}</strong> — ${escapeHtml(accountStatus(account))}${account.lastError ? `: ${escapeHtml(account.lastError.slice(0, 200))}` : ""}</div>`,
            )
            .join("")}</div></section>`
    }
    <section class="card">
      <h2>${ICONS.usage}Provider quota</h2>
      ${
        quotaCards.length === 0
          ? `<div class="muted" style="margin-top:8px">No snapshot yet.</div>`
          : `<div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">${quotaCards
              .map(({ account, quota }) => `<div class="card stat"><div class="stat-head"><span class="icon-chip">${ICONS.accounts}</span><span class="label">${escapeHtml(account.label)}</span></div>${quotaCard(quota)}</div>`)
              .join("")}</div>`
      }
    </section>
    <section class="card">
      <h2>${ICONS.keys}Calling the gateway</h2>
      <pre class="mono" style="margin-top:10px; style="margin:0;padding:12px;border:1px solid var(--line);border-radius:10px;overflow-x:auto">${escapeHtml(clientSnippet(deps.config))}</pre>
    </section>
    <section class="card">
      <h2>${ICONS.overview}Runtime</h2>
      <div class="muted mono" style="margin:10px 0">${escapeHtml(runtimeLine(deps.config, deps.startedAt))}</div>
      <div class="stats">
        ${statCard(ICONS.requests, String(deps.config.maxAttempts), "Attempts per request", escapeHtml(deps.config.strategy))}
        ${statCard(ICONS.refresh, `${Math.round(deps.config.cooldownMs / 1_000)}s`, "Cooldown on failure", `${Math.round(deps.config.deadCooldownMs / 60_000)}m when dead`)}
        ${statCard(ICONS.models, `${Math.round(deps.config.catalogCacheMs / 1_000)}s`, "Catalog cache")}
        ${statCard(ICONS.usage, `${Math.round(deps.config.upstreamTimeoutMs / 1_000)}s`, "Upstream timeout", escapeHtml(deps.config.outboundProxy ?? "direct"))}
      </div>
      <div class="muted mono" style="margin-top:10px">${escapeHtml(`${baseUrlOf(deps.config)}/v1 · db ${deps.config.dbPath}`)}</div>
    </section>
  </div>`;
  return shell(deps, "overview", meta, content);
}

/** One account's provider numbers as a stat card, for the Overview. */
function quotaCard(quota: NonNullable<ReturnType<typeof quotaView>>): string {
  return `<div class="value">${quota.left === null ? formatNumber(quota.used ?? 0) : formatNumber(quota.left)}<span class="muted" style="font-size:14px"> left</span></div>
    <div class="note">${escapeHtml(quota.today)}${quota.pot === "" ? "" : ` · pot ${quota.pot}`}${quota.week === "" ? "" : ` · week ${quota.week}`}</div>
    ${quota.percent === null ? "" : `<div class="bar"><span style="width:${quota.percent}%"></span></div>`}
    <div class="note">${quota.reset === "" ? "" : `resets ${escapeHtml(quota.reset)} · `}checked ${escapeHtml(quota.checkedAt.slice(11, 16))}Z${quota.error === "" ? "" : ` · ${escapeHtml(quota.error.slice(0, 60))}`}</div>`;
}

// --- accounts ------------------------------------------------------------------------

export function accountsPage(deps: ConsoleDeps, meta: PageMeta): string {
  const accounts = listAccounts(deps.db);
  const signIn = Object.values(PROVIDERS)
    .map(
      (preset) => `<form class="grid-form" method="post" action="/dashboard/accounts/providers/${preset.id}/start">
      <label class="field">provider<input value="${escapeHtml(preset.id)}" size="10" disabled></label>
      <label class="field wide">manager origin<input name="origin" value="${escapeHtml(preset.origin)}" size="34"></label>
      <label class="field">label<input name="label" placeholder="${escapeHtml(preset.id)}" size="12"></label>
      <button class="btn primary icon-btn" type="submit">${ICONS.login}Sign in</button>
    </form>`,
    )
    .join("");
  const notReady = accounts.filter((account) => account.enabled && account.status !== "ready").length;

  const content = `
  ${pageHead(ICONS.accounts, "Accounts", `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}${notReady > 0 ? ` · ${notReady} not ready` : ""}`)}
  <div class="stack">
    <section class="card">
      <h2>${ICONS.login}Sign in to a provider</h2>
      <div style="margin-top:10px">${signIn}</div>
    </section>
    <details class="card">
      <summary>Add a provider by hand</summary>
      <form class="grid-form" method="post" action="/dashboard/accounts">
        <label class="field">label<input name="label" size="14" required></label>
        <label class="field">base_url<input name="base_url" size="32" placeholder="https://api.openai.com/v1" required></label>
        <label class="field">api_key<input name="api_key" type="password" size="26" required></label>
        <label class="field">provider<input name="provider" size="10" placeholder="openai"></label>
        <label class="field">dialect<select name="dialect">${dialectOptions("openai-chat")}</select></label>
        <label class="field">priority<input name="priority" size="5" placeholder="100"></label>
        <label class="field">weight<input name="weight" size="5" placeholder="1"></label>
        <label class="field">quota_limit<input name="quota_limit" size="8" placeholder="∞"></label>
        <label class="field wide">extra_headers<textarea name="extra_headers" rows="2" placeholder='{"x-tenant":"acme"}'></textarea></label>
        <label class="check"><input type="checkbox" name="force_stream" value="1"> force stream</label>
        <label class="check"><input type="checkbox" name="strip_sampling" value="1"> drop temperature / top_p</label>
        <button class="btn primary" type="submit">Add account</button>
      </form>
    </details>
    <div class="card scroll"><table>
      <thead><tr><th class="num">id</th><th>label</th><th>dialect</th><th>base url</th><th class="num">prio / wt</th><th>status</th><th>quota</th><th>last error</th><th>actions</th></tr></thead>
      <tbody>${accounts.map((account) => accountRows(account, deps.quotas.canRefresh(account), "/dashboard")).join("") || emptyRow(9, "No accounts yet.")}</tbody>
    </table></div>
  </div>`;
  return shell(deps, "accounts", meta, content);
}

// --- models --------------------------------------------------------------------------

export function modelsPage(deps: ConsoleDeps, meta: PageMeta, catalog: Catalog): string {
  const accounts = listAccounts(deps.db);

  const content = `
  ${pageHead(ICONS.models, "Models", `${catalog.entries.length} ${catalog.entries.length === 1 ? "model" : "models"}`)}
  <div class="stack">
    ${
      catalog.failures.length === 0
        ? ""
        : `<section class="card"><h2>${ICONS.power}Some accounts did not answer</h2><div class="stack" style="margin-top:10px">${catalog.failures
            .map((failure) => `<div class="flash bad" style="margin:0"><strong>${escapeHtml(failure.account)}</strong> — ${escapeHtml(failure.error)}</div>`)
            .join("")}</div></section>`
    }
    <section class="card">
      <div class="actions" style="align-items:center">
        <form class="inline" method="post" action="/dashboard/models/refresh"><button class="btn icon-btn" type="submit">${ICONS.refresh}Ask upstream again</button></form>
        <span class="muted" style="font-size:12px">read ${escapeHtml(catalog.fetchedAt.replace("T", " ").slice(0, 19))}Z · cached ${Math.round(deps.config.catalogCacheMs / 1_000)}s</span>
      </div>
    </section>
    <div class="card scroll"><table>
      <thead><tr><th>model</th><th>owned by</th><th class="num">context</th><th class="num">max output</th><th>capabilities</th><th>served by</th></tr></thead>
      <tbody>${modelRows(catalog.entries)}</tbody>
    </table></div>
    <section class="card">
      <h2>${ICONS.models}Dialects</h2>
      <div class="scroll" style="margin-top:10px"><table>
        <thead><tr><th>account</th><th>dialect</th><th>client paths</th><th>upstream</th></tr></thead>
        <tbody>${
          accounts
            .map(
              (account) =>
                `<tr><td>${escapeHtml(account.label)}</td><td><span class="badge">${escapeHtml(DIALECT_LABEL[account.dialect])}</span></td><td class="mono">/v1/… any</td><td class="mono">${escapeHtml(account.baseUrl)}</td></tr>`,
            )
            .join("") || emptyRow(4, "No accounts yet.")
        }</tbody>
      </table></div>
    </section>
  </div>`;
  return shell(deps, "models", meta, content);
}

// --- keys ----------------------------------------------------------------------------

export function keysPage(deps: ConsoleDeps, meta: PageMeta): string {
  const keys = listKeys(deps.db);
  const content = `
  ${pageHead(ICONS.keys, "Client keys", `${keys.length} ${keys.length === 1 ? "key" : "keys"}`)}
  <div class="stack">
    <section class="card">
      <h2>${ICONS.keys}Create a key</h2>
      <form class="grid-form" method="post" action="/dashboard/keys" style="margin-top:10px">
        <label class="field">name<input name="name" size="22" placeholder="my-app" required></label>
        <button class="btn primary" type="submit">Create key</button>
      </form>
    </section>
    <div class="card scroll"><table>
      <thead><tr><th class="num">id</th><th>name</th><th>secret</th><th>state</th><th>last used</th><th>actions</th></tr></thead>
      <tbody>${keys.map((key) => keyRows(key, "/dashboard")).join("") || emptyRow(6, "No client keys yet.")}</tbody>
    </table></div>
    <section class="card">
      <h2>${ICONS.keys}Using a key</h2>
      <div class="mono" style="margin-top:10px">authorization: Bearer sk-gw-… · x-api-key: sk-gw-…</div>
      <pre class="mono" style="margin:10px 0 0;padding:12px;border:1px solid var(--line);border-radius:10px;overflow-x:auto">${escapeHtml(clientSnippet(deps.config))}</pre>
    </section>
  </div>`;
  return shell(deps, "keys", meta, content);
}

// --- usage ---------------------------------------------------------------------------

export function usagePage(deps: ConsoleDeps, meta: PageMeta, hours: number): string {
  const since = new Date(Date.now() - hours * HOUR).toISOString();
  const groups: { id: UsageGroup; heading: string }[] = [
    { id: "account", heading: "account" },
    { id: "key", heading: "client key" },
    { id: "model", heading: "model" },
  ];
  const tables = groups.map((group) => {
    const rows = usageSummary(deps.db, since, group.id);
    return `<div><div class="muted" style="margin-bottom:6px">By ${escapeHtml(group.heading)}</div>${usageTable(group.heading, rows, `no traffic in the last ${windowText(hours)}`)}</div>`;
  });
  const totals = totalsOf(usageSummary(deps.db, since, "account"));
  const window = (label: string, value: number): string =>
    `<a class="btn${value === hours ? " primary" : ""}" href="/dashboard/usage?hours=${value}">${escapeHtml(label)}</a>`;

  const content = `
  ${pageHead(ICONS.usage, "Usage", `${formatNumber(totals.tokens)} tokens`)}
  <div class="stack">
    <div class="stats">
      ${statCard(ICONS.requests, formatNumber(totals.requests), "Requests", `last ${windowText(hours)}`)}
      ${statCard(ICONS.usage, formatNumber(totals.tokens), "Tokens", "prompt + completion")}
      ${statCard(ICONS.power, formatNumber(totals.errors), "Errors", totals.requests === 0 ? "no traffic" : `${Math.round((totals.errors / totals.requests) * 100)}% of requests`)}
      ${statCard(ICONS.keys, formatNumber(Math.round(totals.tokens / Math.max(1, totals.requests))), "Tokens per request", "average")}
    </div>
    <section class="card"><div class="actions">${window("24 hours", 24)}${window("7 days", 168)}${window("30 days", 720)}</div></section>
    <div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr))">${tables.join("")}</div>
  </div>`;
  return shell(deps, "usage", meta, content);
}

function windowText(hours: number): string {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? "24 hours" : `${days} days`;
  }
  return `${hours} hours`;
}

// --- requests ------------------------------------------------------------------------

export function requestsPage(deps: ConsoleDeps, meta: PageMeta, limit: number, errorsOnly: boolean): string {
  const all = recentRequests(deps.db, limit);
  const rows = errorsOnly ? all.filter((row) => row.status >= 400) : all;
  const filter = (label: string, value: boolean, count: number): string =>
    `<a class="btn${value === errorsOnly ? " primary" : ""}" href="/dashboard/requests?limit=${limit}${value ? "&errors=1" : ""}">${escapeHtml(label)} <span class="muted">${count}</span></a>`;
  const errorCount = all.filter((row) => row.status >= 400).length;

  const content = `
  ${pageHead(ICONS.requests, "Requests", `${rows.length} of ${all.length}`)}
  <div class="stack">
    <section class="card"><div class="actions">
      ${filter("All", false, all.length)}
      ${filter("Errors only", true, errorCount)}
      <a class="btn" href="/dashboard/requests?limit=${limit === 100 ? 500 : 100}">show ${limit === 100 ? 500 : 100}</a>
    </div></section>
    <div class="card scroll scrolly"><table>
      <thead><tr><th>time</th><th class="num">status</th><th>account</th><th>model</th><th>path</th><th class="num">tokens</th><th class="num">ms</th></tr></thead>
      <tbody>${requestRows(rows)}</tbody>
    </table></div>
  </div>`;
  return shell(deps, "requests", meta, content);
}
