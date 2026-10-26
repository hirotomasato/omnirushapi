# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-26

First release: one OpenAI- and Anthropic-compatible endpoint in front of many upstream
accounts, with a console, a CLI and an admin API.

### Added

- **Data plane**: `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages`,
  `GET /v1/models`, plus `GET /healthz`. Streaming and whole responses, tool calls, and
  translation between OpenAI chat, OpenAI responses and Anthropic messages in both directions.
- **Routing**: round-robin (or priority-ordered) across enabled accounts, with failover, an
  attempt budget, cooldowns after a failure, and per-account priorities and weights.
- **Credentials**: device-flow sign-in per provider, refresh tokens, proactive renewal on
  expiry, renewal-and-retry when an upstream refuses a token, and one refresh per account when
  callers race.
- **Providers**: presets carry the wire dialect, client headers and the quirks an upstream
  needs (`force_stream`, `strip_sampling`), so a provider's oddities stay in one place.
- **Console** (`/dashboard`): overview, accounts, models, client keys, usage and requests as
  separate pages; device login; account and key management; provider-reported quota next to the
  gateway's own count; guarded self-refresh.
- **CLI** (`npm run gateway -- …`): `login`, `providers`, `account add|patch|list|get|rm|enable|
  disable|reset|quota`, `key add|list|rm|enable|disable`, `usage`, `requests`, `status`.
- **Admin API** (`/admin/*`): the same operations for scripts, behind an admin token.
- **Storage**: SQLite via better-sqlite3, additive migrations, request log with token counts.
- **Transport**: `curl` carries upstream traffic (proxy-aware, uncompressed, streaming) with
  retries around transport blips; loopback upstreams stay direct.
- **Tests**: unit suites for routing, the SSE scanner, the dialect layer, the token refresher,
  quota parsing and the favicon; an end-to-end harness with a stub upstream and manager that
  drives the data plane, the CLI and every console page and button.

[Unreleased]: https://github.com/hirotomasato/omnirushapi/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hirotomasato/omnirushapi/releases/tag/v0.1.0
