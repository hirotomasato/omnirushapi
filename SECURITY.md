# Security

## Reporting a vulnerability

Open a private advisory on GitHub (**Security → Report a vulnerability**) rather than a public
issue. Please include the version (`GET /admin/health` reports it), what you did, and what
happened. Expect an answer within a week.

## What this software holds

The SQLite database is the sensitive part: it stores every upstream account's API key (and its
OAuth refresh token), every client key's hash, and the admin token it mints on first start.
Treat the file as a credential store:

- keep it out of version control (`.gitignore` already does) and off shared drives;
- the client secrets are stored hashed, but upstream credentials are not — they have to be
  presented to providers verbatim, so anyone with the file can use your upstream accounts;
- deleting `data/gateway.db` invalidates the admin token and every client key.

## Defaults you must change before exposing the gateway

- `DASHBOARD_PASSWORD` (and `DASHBOARD_USER`) — the shipped placeholder is refused on a
  non-loopback host, but pick a real one anyway;
- keep `HOST=127.0.0.1` unless a TLS-terminating reverse proxy is in front. The console is
  plain HTTP, and it can create, edit and delete credentials.

## Supported versions

Only the latest release on `main`.
