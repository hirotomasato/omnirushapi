# Contributing

## Setup

```bash
git clone https://github.com/hirotomasato/omnirushapi.git
cd omnirushapi
npm install
npm run check        # typecheck + unit tests + end-to-end suite
```

Node 22 or newer. There is no build step: TypeScript runs through `tsx`, and the console is
server-rendered HTML with inline styles and icons.

## Ground rules

- **No new runtime dependencies** without a strong reason. The gateway ships with `fastify` and
  `better-sqlite3` on purpose; the console has no client framework and no CDN.
- **Strict TypeScript**, `noUncheckedIndexedAccess` included. Read `tsconfig.json` before
  reaching for an escape hatch.
- **Migrations are additive.** Never rewrite an existing entry in `MIGRATIONS` (`src/db.ts`):
  someone's live database has already run it.
- **The tests are the specification.** Add a case to the relevant suite for behaviour you
  change; the end-to-end harness (`test/e2e`) is where routing, failover, dialects, login and
  the console are pinned down.
- **Comments say why.** The code says what. Keep the existing tone: short, factual, no
  narration.
- **No dead code.** A cutover removes what it replaced — no aliases, shims or commented-out
  blocks.

## Talks with an upstream

Two rules keep provider quirks out of the core: a new provider goes in `src/providers.ts` as a
preset (origin, API base, dialect, headers, quirks, usage path), and anything a preset cannot
express becomes an explicit per-account flag rather than a branch inside the translator.

## Commits and pull requests

Small, focused commits with a one-line summary in the imperative mood. In a pull request, say
what changed, why, and how you verified it (`npm run check`, plus whatever manual call you
made). Screenshots help for console changes.
