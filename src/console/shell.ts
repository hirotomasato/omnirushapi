// The console's shell: icons, styles, and the frame every page is rendered into.
//
// No build step and no client framework on purpose: this is a local service, and the page has
// to work with nothing but a browser. Each page is its own route; the sidebar is the nav.

import type { FastifyReply } from "fastify";
import type { Account } from "../accounts.js";

export type PageId = "overview" | "accounts" | "models" | "keys" | "usage" | "requests";

const SVG_ATTRS =
  'class="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

export const ICONS = {
  overview: `<svg ${SVG_ATTRS}><rect x="3" y="4" width="18" height="6" rx="1.6"/><rect x="3" y="14" width="18" height="6" rx="1.6"/><path d="M7 7h.01M7 17h.01"/></svg>`,
  accounts: `<svg ${SVG_ATTRS}><ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6"/><path d="M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3"/></svg>`,
  models: `<svg ${SVG_ATTRS}><path d="M12 3 3 7.5l9 4.5 9-4.5z"/><path d="m3 12.5 9 4.5 9-4.5"/><path d="m3 17 9 4.5 9-4.5"/></svg>`,
  keys: `<svg ${SVG_ATTRS}><circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H21"/><path d="M17 12v3"/><path d="M20 12v3"/></svg>`,
  usage: `<svg ${SVG_ATTRS}><path d="M4 20v-6M9.33 20V8.5M14.67 20v-8M20 20V4.5"/><path d="M2.5 20h19"/></svg>`,
  requests: `<svg ${SVG_ATTRS}><path d="M9 6h12M9 12h12M9 18h12"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/></svg>`,
  power: `<svg ${SVG_ATTRS}><path d="M12 3v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/></svg>`,
  refresh: `<svg ${SVG_ATTRS}><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>`,
  trash: `<svg ${SVG_ATTRS}><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/></svg>`,
  copy: `<svg ${SVG_ATTRS}><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a1 1 0 0 0-1 1v9"/></svg>`,
  signout: `<svg ${SVG_ATTRS}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h9"/></svg>`,
  panel: `<svg ${SVG_ATTRS}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9.5 4v16"/><path d="m15.5 10-2.5 2 2.5 2"/></svg>`,
  login: `<svg ${SVG_ATTRS}><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 8l4 4-4 4"/><path d="M14 12H3"/></svg>`,
} as const;

/** The sections, in the order they appear in the sidebar. */
export const PAGES: { id: PageId; label: string; path: string; icon: string }[] = [
  { id: "overview", label: "Overview", path: "/dashboard", icon: ICONS.overview },
  { id: "accounts", label: "Accounts", path: "/dashboard/accounts", icon: ICONS.accounts },
  { id: "models", label: "Models", path: "/dashboard/models", icon: ICONS.models },
  { id: "keys", label: "Client keys", path: "/dashboard/keys", icon: ICONS.keys },
  { id: "usage", label: "Usage", path: "/dashboard/usage", icon: ICONS.usage },
  { id: "requests", label: "Requests", path: "/dashboard/requests", icon: ICONS.requests },
];

// The product mark; drawn in code, like the favicon (see ../favicon.ts).
export const MARK = `<svg viewBox="0 0 32 32" width="20" height="20" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#4f46e5"/><path d="M9 22V10l14 12V10" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// The sidebar's state is the browser's to keep: applied before the first paint so the page
// never flickers between layouts, and toggled without a round trip.
const COLLAPSE_KEY = "omnirushapi.sidebar";
const COLLAPSE_HEAD = `<script>try{if(localStorage.getItem("${COLLAPSE_KEY}")==="closed")document.documentElement.classList.add("side-closed")}catch(e){}</script>`;
const COLLAPSE_SCRIPT = `<script>(()=>{const button=document.getElementById("collapse");if(!button)return;const root=document.documentElement;const sync=()=>button.setAttribute("aria-expanded",String(!root.classList.contains("side-closed")));sync();button.addEventListener("click",()=>{root.classList.toggle("side-closed");sync();try{localStorage.setItem("${COLLAPSE_KEY}",root.classList.contains("side-closed")?"closed":"open")}catch(e){}})})();</script>`;

// A self-refreshing page must not fight the person using it, and must not burn CPU in a tab
// nobody is looking at: the timer only refreshes a visible page with no field focused and no
// panel open, and coming back to the tab refreshes at once instead of waiting for a tick.
function refreshScript(seconds: number | null): string {
  if (seconds === null) return "";
  return `<script>(()=>{const busy=()=>{if(document.hidden)return true;if(document.querySelector("details[open]"))return true;const active=document.activeElement;return Boolean(active&&active.closest&&active.closest("input,textarea,select"))};const tick=()=>{if(!busy())location.reload()};setInterval(tick,${Math.max(1, seconds) * 1_000});let away=document.hidden;document.addEventListener("visibilitychange",()=>{const wasAway=away;away=document.hidden;if(wasAway&&!away)tick()})})();</script>`;
}

// Feedback arrives in the query string so it survives the 303; showing it is a one-time
// event, so the address bar is tidied immediately and a refresh no longer repeats it.
const FLASH_STRIP = `<script>(()=>{const url=new URL(location.href);if(!url.searchParams.has("flash"))return;url.searchParams.delete("flash");url.searchParams.delete("kind");history.replaceState(null,"",url.pathname+url.search+url.hash)})();</script>`;

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f5f6f8; --fg: #14161c; --muted: #667085; --card: #ffffff;
  --line: rgba(16, 20, 28, .12); --accent: #4f46e5; --accent-fg: #ffffff;
  --ok: #0b7a45; --ok-bg: rgba(16, 163, 74, .13);
  --warn: #96610a; --warn-bg: rgba(245, 158, 11, .18);
  --bad: #b42318; --bad-bg: rgba(220, 38, 38, .12);
  --idle: #4b5563; --idle-bg: rgba(107, 114, 128, .14);
  --shadow: 0 1px 2px rgba(16, 20, 28, .06);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d0f14; --fg: #e7e9ef; --muted: #98a1b0; --card: #151821;
    --line: rgba(255, 255, 255, .12); --accent: #7f8cff; --accent-fg: #0d0f14;
    --ok: #57d99a; --ok-bg: rgba(87, 217, 154, .14);
    --warn: #f5c04e; --warn-bg: rgba(245, 192, 78, .16);
    --bad: #ff8a80; --bad-bg: rgba(255, 138, 128, .16);
    --idle: #a5adba; --idle-bg: rgba(165, 173, 186, .16);
    --shadow: none;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
svg.icon { flex: none; vertical-align: -3px; }
h1, h2 { margin: 0; }
h2 { display: flex; align-items: center; gap: 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); }
section.card { padding: 14px 16px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.stat { padding: 14px 16px; }
.stat-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.stat .value { font-size: 26px; font-weight: 650; letter-spacing: -.02em; }
.stat .label { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.stat .note { font-size: 12px; color: var(--muted); margin-top: 2px; }
.icon-chip { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px;
  border-radius: 9px; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
.icon-chip svg { width: 16px; height: 16px; }
.scroll { overflow-x: auto; border-radius: 14px; }
.scrolly { max-height: 440px; overflow: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
thead th { position: sticky; top: 0; z-index: 1; background: var(--card); white-space: nowrap;
  font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: color-mix(in srgb, var(--accent) 5%, transparent); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.row-error td { background: var(--bad-bg); }
.mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
.muted { color: var(--muted); }
.pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 650; }
.pill.ready { color: var(--ok); background: var(--ok-bg); }
.pill.cooling { color: var(--warn); background: var(--warn-bg); }
.pill.dead { color: var(--bad); background: var(--bad-bg); }
.pill.disabled { color: var(--idle); background: var(--idle-bg); }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--ok);
  vertical-align: middle; margin-right: 5px; }
.dot.cooling { background: var(--warn); }
.dot.dead { background: var(--bad); }
.dot.disabled { background: var(--idle); }
.bar { height: 6px; min-width: 70px; margin-top: 5px; border-radius: 999px; background: var(--idle-bg); overflow: hidden; }
.bar > span { display: block; height: 100%; background: var(--accent); }
.badge { display: inline-block; padding: 2px 8px; border: 1px solid var(--line); border-radius: 7px; font-size: 11.5px; color: var(--muted); white-space: nowrap; }
.btn { font: inherit; font-size: 12.5px; padding: 5px 11px; border: 1px solid var(--line); border-radius: 9px;
  background: var(--card); color: var(--fg); cursor: pointer; text-decoration: none; }
.btn:hover { border-color: var(--accent); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 600; }
.btn.danger { color: var(--bad); }
.btn.icon-btn { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; }
.btn.icon-btn svg { width: 14px; height: 14px; }
form.inline { display: inline; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; }
form.grid-form, form.edit-form { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: flex-end; }
form.edit-form { padding: 12px 2px 6px; }
label.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
label.field.wide { flex: 1 1 320px; }
label.check { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--fg); }
input, select, textarea { font: inherit; font-size: 13px; padding: 6px 9px; border: 1px solid var(--line);
  border-radius: 9px; background: var(--bg); color: var(--fg); }
textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; resize: vertical; }
input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible, a:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 1px; }
details summary { cursor: pointer; padding: 2px 0; font-size: 12.5px; color: var(--accent); }
details > summary::marker { color: var(--muted); }
.flash { margin: 0 0 14px; padding: 10px 13px; border: 1px solid var(--line); border-radius: 10px; font-size: 13px; }
.flash.ok { color: var(--ok); background: var(--ok-bg); border-color: color-mix(in srgb, var(--ok) 35%, transparent); }
.flash.bad { color: var(--bad); background: var(--bad-bg); border-color: color-mix(in srgb, var(--bad) 35%, transparent); }
.secret-box { margin: 0 0 14px; padding: 12px 14px; border: 1px solid var(--accent); border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 10%, transparent); }
.secret-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 6px; }
.secret-row code { flex: 1 1 320px; word-break: break-all; }
.pct { font-size: 11.5px; color: var(--muted); }
.provider { margin-top: 8px; padding-top: 7px; border-top: 1px dashed var(--line); font-size: 11.5px; }
.provider .muted { font-size: 11.5px; }
.login-wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
form.login { width: 100%; max-width: 360px; padding: 24px; display: flex; flex-direction: column; gap: 12px; }
form.login h1 { display: flex; align-items: center; gap: 8px; font-size: 19px; }
/* Sidebar and page shell ----------------------------------------------------------- */
.shell { display: grid; grid-template-columns: 248px minmax(0, 1fr); min-height: 100vh; }
.side { position: sticky; top: 0; align-self: start; display: flex; flex-direction: column; gap: 16px;
  height: 100vh; overflow-y: auto; padding: 18px 16px; background: var(--card); border-right: 1px solid var(--line); }
.main { min-width: 0; padding: 20px 24px 72px; }
nav.side-nav { display: flex; flex-direction: column; gap: 2px; }
nav.side-nav a { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 9px;
  color: var(--muted); font-size: 13px; font-weight: 600; text-decoration: none; }
nav.side-nav a:hover { color: var(--fg); background: color-mix(in srgb, var(--accent) 12%, transparent); }
nav.side-nav a.current { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.brand { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 650; letter-spacing: -.01em; }
.brand .version { font-size: 12px; font-weight: 600; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; }
.side-top { display: flex; align-items: center; gap: 8px; }
.side-foot { margin-top: auto; display: flex; flex-direction: column; gap: 8px; }
.toggle { margin-left: auto; display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; padding: 0; border: 1px solid var(--line); border-radius: 9px;
  background: transparent; color: var(--muted); cursor: pointer; }
.toggle:hover { color: var(--fg); border-color: var(--accent); }
.toggle svg { width: 16px; height: 16px; transition: transform .15s ease; }
html.side-closed .shell { grid-template-columns: 68px minmax(0, 1fr); }
html.side-closed .side { padding: 18px 10px; }
html.side-closed .side .label,
html.side-closed .side .hint { display: none; }
html.side-closed .side-top { flex-direction: column; }
html.side-closed .toggle { margin: 0; }
html.side-closed .toggle svg { transform: rotate(180deg); }
html.side-closed nav.side-nav { align-items: stretch; }
html.side-closed nav.side-nav a { justify-content: center; padding: 9px 0; }
html.side-closed .brand { justify-content: center; }
.page-head { display: flex; align-items: baseline; gap: 10px; margin: 0 0 14px; flex-wrap: wrap; }
.page-head h1 { font-size: 19px; letter-spacing: -.01em; display: flex; align-items: center; gap: 9px; }
.page-head .count { margin-left: auto; font-size: 12.5px; color: var(--muted); }
.stack > * + * { margin-top: 12px; }
@media (max-width: 900px) {
  .shell { grid-template-columns: 1fr; }
  .side { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center;
    gap: 10px; border-right: 0; border-bottom: 1px solid var(--line); }
  nav.side-nav { flex-direction: row; flex-wrap: wrap; }
  .side-foot { margin: 0 0 0 auto; flex-direction: row; align-items: center; }
  .toggle { display: none; }
  .scrolly { max-height: none; }
  .main { padding: 16px 16px 64px; }
}
.btn, nav.side-nav a, input, select, textarea, .toggle svg { transition: background-color .12s ease, border-color .12s ease, color .12s ease; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

export interface Flash {
  kind: "ok" | "bad";
  text: string;
}

export interface WaitingLogin {
  label: string;
  userCode: string;
  verificationUriComplete: string;
  expiresAt: number;
  expiresInSec: number;
}

export interface ShellOptions {
  version: string;
  active: PageId;
  /** Seconds between self-refreshes, or null for a page that must not reload itself. */
  refreshSeconds: number | null;
  flash: Flash | null;
  secret: string | null;
  waiting: WaitingLogin | null;
  /** The line in the sidebar footer: what the page is doing on its own. */
  hint: string;
}

// --- values -------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/** Never render a credential in full: enough to tell two apart, not enough to use. */
export function mask(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : "…";
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

/** "12s ago", "3m ago", "2h ago" — for anything that carries its own timestamp. */
export function sinceText(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "unknown";
  const seconds = Math.max(0, Math.round((now - at) / 1_000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function uptimeText(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours < 24) return `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** The word the console shows for an account: its state, or "disabled" when it is off. */
export function accountStatus(account: Account): "ready" | "cooling" | "dead" | "disabled" {
  return account.enabled ? account.status : "disabled";
}

// --- pages --------------------------------------------------------------------------

export function sendPage(reply: FastifyReply, html: string): FastifyReply {
  return reply.type("text/html; charset=utf-8").send(html);
}

function page(title: string, body: string, options: { refreshSeconds?: number | null; collapseState?: boolean; scripts?: string } = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="apple-touch-icon" href="/favicon.ico">${options.collapseState ? COLLAPSE_HEAD : ""}<style>${STYLE}</style></head>
<body>${body}${options.scripts ?? ""}</body></html>`;
}

export function loginPage(version: string, wrong: boolean): string {
  return page(
    "omnirushapi — sign in",
    `<div class="login-wrap">
       <form class="card login" method="post" action="/login">
         <h1>${MARK}<span>omnirushapi</span> <span class="version">v${escapeHtml(version)}</span></h1>
         <p class="muted" style="margin:0">Sign in to the admin console.</p>
         ${wrong ? '<div class="flash bad" style="margin:0">Wrong username or password.</div>' : ""}
         <label class="field">Username<input name="user" autocomplete="username" autofocus required></label>
         <label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label>
         <button class="btn primary" type="submit">Sign in</button>
       </form>
     </div>`,
  );
}

/** The heading every page carries: its icon, its title, and a count on the right. */
export function pageHead(icon: string, title: string, count = ""): string {
  return `<div class="page-head"><h1>${icon}${escapeHtml(title)}</h1>${count ? `<span class="count">${escapeHtml(count)}</span>` : ""}</div>`;
}

export function sectionCard(body: string, className = ""): string {
  return `<section class="card${className ? ` ${className}` : ""}">${body}</section>`;
}

function flashHtml(flash: Flash | null): string {
  return flash ? `<div class="flash ${flash.kind === "ok" ? "ok" : "bad"}">${escapeHtml(flash.text)}</div>` : "";
}

function secretHtml(secret: string | null): string {
  if (!secret) return "";
  return `<div class="secret-box"><strong>New client key created</strong> — this secret is shown once, copy it now:<div class="secret-row"><code class="mono">${escapeHtml(secret)}</code><button class="btn icon-btn" type="button" id="copy-secret" data-secret="${escapeHtml(secret)}">${ICONS.copy}Copy</button></div><div class="muted" style="font-size:12px">Lost it? Create another key and delete this one.</div></div><script>document.getElementById("copy-secret")?.addEventListener("click",async(event)=>{const button=event.currentTarget,value=button.dataset.secret??"";try{await navigator.clipboard.writeText(value)}catch{const field=document.createElement("textarea");field.value=value;document.body.append(field);field.select();document.execCommand("copy");field.remove()}button.textContent="Copied"});</script>`;
}

function waitingHtml(waiting: WaitingLogin | null): string {
  if (!waiting) return "";
  const left = Math.max(0, Math.round((waiting.expiresAt - Date.now()) / 1_000));
  return `<div class="secret-box"><strong>Waiting for approval — ${escapeHtml(waiting.label)}</strong><div class="secret-row"><code class="mono">${escapeHtml(waiting.userCode)}</code><a class="btn icon-btn" href="${escapeHtml(waiting.verificationUriComplete)}" target="_blank" rel="noreferrer">${ICONS.signout}Open the approval page</a></div><div class="muted" style="font-size:12px">Approve it in the browser and this finishes by itself — the page checks again in ${String(Math.min(15, Math.max(3, waiting.expiresInSec || 3)))}s (code expires in ${String(left)}s).</div></div>`;
}

export function statCard(icon: string, value: string, label: string, note = ""): string {
  return `<div class="card stat"><div class="stat-head"><span class="icon-chip">${icon}</span><span class="label">${escapeHtml(label)}</span></div><div class="value">${escapeHtml(value)}</div>${note ? `<div class="note">${escapeHtml(note)}</div>` : ""}</div>`;
}

/** The frame: sidebar on the left, and the page's own content on the right. */
export function renderShell(options: ShellOptions, content: string): string {
  const nav = PAGES.map(
    (entry) =>
      `<a href="${entry.path}"${entry.id === options.active ? ' class="current" aria-current="page"' : ""}>${entry.icon}<span class="label">${escapeHtml(entry.label)}</span></a>`,
  ).join("");
  const body = `
  <div class="shell">
  <aside class="side">
    <div class="side-top">
      <div class="brand">${MARK}<span class="label">omnirushapi</span><span class="version">v${escapeHtml(options.version)}</span></div>
      <button class="toggle" id="collapse" type="button" aria-expanded="true" aria-controls="side-nav" title="Collapse or expand the sidebar">${ICONS.panel}</button>
    </div>
    <nav class="side-nav" id="side-nav">${nav}</nav>
    <div class="side-foot">
      <div class="muted hint" style="font-size:11.5px">${escapeHtml(options.hint)}</div>
      <form method="post" action="/logout"><button class="btn icon-btn" type="submit" title="Sign out">${ICONS.signout}<span class="label">Sign out</span></button></form>
    </div>
  </aside>
  <main class="main">
    ${flashHtml(options.flash)}${secretHtml(options.secret)}${waitingHtml(options.waiting)}
    ${content}
  </main>
  </div>${COLLAPSE_SCRIPT}`;
  return page(`omnirushapi — ${PAGES.find((entry) => entry.id === options.active)?.label ?? ""}`.trim(), body, {
    collapseState: true,
    scripts: `${options.flash === null ? "" : FLASH_STRIP}${refreshScript(options.refreshSeconds)}`,
  });
}
