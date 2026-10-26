// Table rows and small HTML fragments, the pieces the pages put together.
//
// Kept apart from the pages themselves: a row is about one record, a page is about the
// console's structure, and these fragments are reused on more than one page.

import type { Account } from "../accounts.js";
import { DIALECTS, DIALECT_LABEL, type Dialect } from "../dialects/index.js";
import type { GatewayKey } from "../keys.js";
import type { ModelEntry } from "../models.js";
import type { RequestRow, UsageRow } from "../usage.js";
import { escapeHtml, formatNumber, ICONS, mask, sinceText } from "./shell.js";

/** Form fields are strings: a blank or a typo must mean "keep", never NaN in the database. */
export function optionalNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Blank keeps the stored headers; `{}` clears them. Invalid JSON throws so the route can
 * show the reason in the flash instead of silently dropping the edit.
 */
export function parseExtraHeaders(raw: string | undefined): Record<string, string> | null | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("extra_headers must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("extra_headers must be a JSON object");
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string") throw new Error(`extra_headers.${name} must be a string`);
    headers[name] = value;
  }
  return Object.keys(headers).length === 0 ? null : headers;
}

export function emptyRow(colspan: number, text: string): string {
  return `<tr><td colspan="${colspan}"><div class="muted">${escapeHtml(text)}</div></td></tr>`;
}

export function dialectOptions(selected: Dialect | null): string {
  return DIALECTS.map(
    (dialect) => `<option value="${dialect}"${dialect === selected ? " selected" : ""}>${escapeHtml(DIALECT_LABEL[dialect])}</option>`,
  ).join("");
}

/** "on" pill with its dot, the same everywhere an account's state is shown. */
export function statusPill(status: string): string {
  return `<span class="pill ${status}"><span class="dot ${status}" style="display:inline-block;vertical-align:middle;margin-right:5px"></span>${escapeHtml(status)}</span>`;
}

/** The provider's numbers, worked out once; each page formats them its own way. */
export interface QuotaView {
  used: number | null;
  limit: number | null;
  /** Whatever is left today, when the provider states both sides. */
  left: number | null;
  /** How much of today's allowance is spent, 0-100. */
  percent: number | null;
  today: string;
  pot: string;
  week: string;
  reset: string;
  checkedAt: string;
  checkedText: string;
  error: string;
}

export function quotaView(account: Account): QuotaView | null {
  const usage = account.providerUsage;
  if (!usage) return null;
  const { used, limit } = usage;
  const left = limit === null || used === null ? null : Math.max(0, limit - used);
  return {
    used,
    limit,
    left,
    percent: limit !== null && limit > 0 && used !== null ? Math.max(0, Math.min(100, Math.round((used / limit) * 100))) : null,
    today: limit === null ? `${formatNumber(used ?? 0)} used` : `${formatNumber(used ?? 0)} / ${formatNumber(limit)} today`,
    pot: usage.pot === null ? "" : formatNumber(usage.pot),
    week: usage.weekUsed === null || usage.weekLimit === null ? "" : `${formatNumber(usage.weekUsed)} / ${formatNumber(usage.weekLimit)}`,
    reset: usage.resetsAt === null ? "" : `${usage.resetsAt.slice(0, 16).replace("T", " ")}Z`,
    checkedAt: usage.checkedAt,
    checkedText: sinceText(usage.checkedAt),
    error: usage.error ?? "",
  };
}

/**
 * The provider's own quota: how much of the account's allowance is left, as the provider
 * counts it — which includes anything spent outside this gateway.
 */
export function providerQuota(account: Account): string {
  const quota = quotaView(account);
  if (!quota) return "";
  const extras = `${quota.pot === "" ? "" : ` · pot ${quota.pot}`}${quota.week === "" ? "" : ` · week ${quota.week}`}${quota.reset === "" ? "" : ` · resets ${escapeHtml(quota.reset.slice(11, 16))}Z`}`;
  return `<div class="provider">
      <div class="muted">provider: ${escapeHtml(quota.today)}${quota.left === null ? "" : ` · ${formatNumber(quota.left)} left`}${extras}</div>
      ${quota.percent === null ? "" : `<div class="bar"><span style="width:${quota.percent}%"></span></div>`}
      <div class="muted" style="font-size:11px">checked ${escapeHtml(quota.checkedText)}${quota.error ? ` · ${escapeHtml(quota.error.slice(0, 60))}` : ""}</div>
    </div>`;
}

/** The gateway's own count for one account, with the bar. */
export function gatewayQuota(account: Account): string {
  const text = account.quotaLimit === null ? `${formatNumber(account.quotaUsed)} / ∞` : `${formatNumber(account.quotaUsed)} / ${formatNumber(account.quotaLimit)}`;
  const percent =
    account.quotaLimit !== null && account.quotaLimit > 0 ? Math.max(0, Math.min(100, Math.round((account.quotaUsed / account.quotaLimit) * 100))) : null;
  return `<div class="muted" style="font-size:11px">through this gateway</div>${escapeHtml(text)}${percent === null ? "" : ` <span class="pct">${percent}%</span>`}${percent === null ? "" : `<div class="bar"><span style="width:${percent}%"></span></div>`}${providerQuota(account)}<div class="muted">${formatNumber(account.served)} served</div>`;
}

/** One account is two rows: the summary, and an expandable edit form below it. */
export function accountRows(account: Account, canAskProvider: boolean, page: string): string {
  const status = account.enabled ? account.status : "disabled";
  const cooling = account.cooldownUntil ? `<div class="muted">until ${escapeHtml(account.cooldownUntil.replace("T", " ").slice(0, 19))}</div>` : "";
  const toggle = account.enabled ? "disable" : "enable";
  const extraHeaders = account.extraHeaders ? JSON.stringify(account.extraHeaders, null, 2) : "";
  const notes = [
    account.forceStream ? "force stream" : "",
    account.refreshToken ? "auto-renews" : "",
    account.stripSampling ? "no sampling params" : "",
  ].filter(Boolean);

  return `<tr>
    <td class="num">${account.id}</td>
    <td><strong>${escapeHtml(account.label)}</strong><div class="muted">${escapeHtml(account.provider)}</div></td>
    <td><span class="badge">${escapeHtml(DIALECT_LABEL[account.dialect])}</span>${notes.map((note) => `<div class="muted" style="font-size:11.5px">${escapeHtml(note)}</div>`).join("")}</td>
    <td><span class="mono">${escapeHtml(account.baseUrl)}</span><div class="mono muted">${escapeHtml(mask(account.apiKey))}</div></td>
    <td class="num">${account.priority} / ${account.weight}</td>
    <td>${statusPill(status)}${cooling}</td>
    <td>${gatewayQuota(account)}</td>
    <td>${account.lastError ? `<span class="muted">${escapeHtml(account.lastError.slice(0, 120))}</span>` : '<span class="muted">—</span>'}</td>
    <td class="actions">
      <form class="inline" method="post" action="${page}/accounts/${account.id}/enable" title="${toggle} account"><input type="hidden" name="enabled" value="${account.enabled ? "0" : "1"}"><button class="btn icon-btn" type="submit" aria-label="${toggle} account ${account.id}">${ICONS.power}${toggle}</button></form>
      <form class="inline" method="post" action="${page}/accounts/${account.id}/reset" title="clear the cooldown"><button class="btn icon-btn" type="submit" aria-label="reset account ${account.id}">${ICONS.refresh}reset</button></form>${
        canAskProvider
          ? `<form class="inline" method="post" action="${page}/accounts/${account.id}/quota" title="ask the provider how much is left"><button class="btn icon-btn" type="submit" aria-label="refresh quota of account ${account.id}">${ICONS.usage}quota</button></form>`
          : ""
      }
      <form class="inline" method="post" action="${page}/accounts/${account.id}/delete" title="remove this account"><button class="btn icon-btn danger" type="submit" aria-label="delete account ${account.id}">${ICONS.trash}delete</button></form>
    </td>
  </tr>
  <tr class="edit-row"><td colspan="9">
    <details>
      <summary>Edit account #${account.id}</summary>
      <form class="edit-form" method="post" action="${page}/accounts/${account.id}">
        <label class="field">base_url<input name="base_url" size="34" value="${escapeHtml(account.baseUrl)}"></label>
        <label class="field">api_key<input name="api_key" type="password" size="26" value="" placeholder="leave blank to keep"></label>
        <label class="field">provider<input name="provider" size="12" value="${escapeHtml(account.provider)}"></label>
        <label class="field">dialect<select name="dialect">${dialectOptions(account.dialect)}</select></label>
        <label class="field">priority<input name="priority" size="5" value="${account.priority}"></label>
        <label class="field">weight<input name="weight" size="5" value="${account.weight}"></label>
        <label class="field">quota_limit<input name="quota_limit" size="8" value="${account.quotaLimit ?? ""}" placeholder="blank = keep"></label>
        <label class="field">quota_reset_at<input name="quota_reset_at" size="22" value="${escapeHtml(account.quotaResetAt ?? "")}"></label>
        <label class="field wide">extra_headers<textarea name="extra_headers" rows="3" placeholder="blank = keep, {} = clear">${escapeHtml(extraHeaders)}</textarea></label>
        <label class="check"><input type="checkbox" name="force_stream" value="1"${account.forceStream ? " checked" : ""}> force stream</label>
        <label class="check"><input type="checkbox" name="strip_sampling" value="1"${account.stripSampling ? " checked" : ""}> drop temperature / top_p</label>
        <label class="check"><input type="checkbox" name="enabled" value="1"${account.enabled ? " checked" : ""}> enabled</label>
        <button class="btn primary" type="submit">Save changes</button>
      </form>
    </details>
  </td></tr>`;
}

export function keyRows(key: GatewayKey, page: string): string {
  const toggle = key.enabled ? "disable" : "enable";
  return `<tr>
    <td class="num">${key.id}</td>
    <td>${escapeHtml(key.name)}</td>
    <td class="mono">${escapeHtml(key.prefix)}…</td>
    <td><span class="pill ${key.enabled ? "ready" : "disabled"}">${key.enabled ? "enabled" : "disabled"}</span></td>
    <td class="muted">${key.lastUsedAt ? escapeHtml(key.lastUsedAt.replace("T", " ").slice(0, 19)) : "never"}</td>
    <td class="actions">
      <form class="inline" method="post" action="${page}/keys/${key.id}/enable" title="${toggle} key"><input type="hidden" name="enabled" value="${key.enabled ? "0" : "1"}"><button class="btn icon-btn" type="submit" aria-label="${toggle} key ${key.id}">${ICONS.power}${toggle}</button></form>
      <form class="inline" method="post" action="${page}/keys/${key.id}/delete" title="remove this key"><button class="btn icon-btn danger" type="submit" aria-label="delete key ${key.id}">${ICONS.trash}delete</button></form>
    </td>
  </tr>`;
}

export function usageTable(heading: string, rows: UsageRow[], empty: string): string {
  const body =
    rows
      .map(
        (row) =>
          `<tr><td class="mono">${escapeHtml(row.group)}</td><td class="num">${formatNumber(row.requests)}</td>` +
          `<td class="num">${formatNumber(row.tokens)}</td>` +
          `<td class="num">${row.errors > 0 ? `<span class="pill dead">${formatNumber(row.errors)}</span>` : "0"}</td></tr>`,
      )
      .join("") || emptyRow(4, empty);
  return `<div class="card scroll"><table><thead><tr><th>${escapeHtml(heading)}</th><th class="num">requests</th><th class="num">tokens</th><th class="num">errors</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

export function requestRows(rows: RequestRow[], colspan = 7): string {
  const body = rows
    .map(
      (row) =>
        `<tr class="${row.status >= 400 ? "row-error" : ""}">` +
        `<td class="muted">${escapeHtml(row.at.replace("T", " ").slice(0, 19))}</td>` +
        `<td class="num">${row.status}</td>` +
        `<td>${escapeHtml(row.accountId ?? "-")}</td>` +
        `<td class="mono">${escapeHtml(row.model ?? "-")}</td>` +
        `<td>${escapeHtml(row.path)}</td>` +
        `<td class="num">${row.totalTokens === null ? "-" : formatNumber(row.totalTokens)}</td>` +
        `<td class="num">${row.latencyMs}</td></tr>`,
    )
    .join("");
  return (
    body ||
    emptyRow(colspan, "No requests yet.")
  );
}

/** Capabilities as badges: the interesting part is what a model can do, not the raw JSON. */
export function capabilityChips(entry: ModelEntry): string {
  const chips = [...entry.capabilities, ...entry.reasoningLevels.map((level) => `reasoning:${level}`)];
  if (chips.length === 0) return '<span class="muted">—</span>';
  return chips.map((chip) => `<span class="badge">${escapeHtml(chip)}</span>`).join(" ");
}

export function modelRows(entries: ModelEntry[]): string {
  return (
    entries
      .map(
        (entry) =>
          `<tr id="model-${encodeURIComponent(entry.id)}">` +
          `<td class="mono">${escapeHtml(entry.id)}${entry.displayName && entry.displayName !== entry.id ? `<div class="muted">${escapeHtml(entry.displayName)}</div>` : ""}</td>` +
          `<td>${escapeHtml(entry.ownedBy ?? "—")}</td>` +
          `<td class="num">${entry.context === null ? "—" : formatNumber(entry.context)}</td>` +
          `<td class="num">${entry.output === null ? "—" : formatNumber(entry.output)}</td>` +
          `<td>${capabilityChips(entry)}</td>` +
          `<td>${entry.accounts.map((label) => `<span class="badge">${escapeHtml(label)}</span>`).join(" ")}</td></tr>`,
      )
      .join("") ||
    emptyRow(6, "No model answered.")
  );
}
