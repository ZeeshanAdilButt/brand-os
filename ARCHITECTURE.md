# Architecture

Engineering Brand OS (the product content-powerhouse is growing into) is a local-first, self-hostable, multi-tenant studio for technical articles and their distribution. The same code runs on one person's machine with no account and no AI key, and as a hosted service for many isolated users. Day 1 shipped the foundation described here and Day 2 added accounts, the tenant-scoped data layer and personal knowledge; later days fill in the modules. See `DECISIONS.md` for why, and `TODO.md` for when.

## Modes

| | `MODE=local` (default) | `MODE=hosted` |
|---|---|---|
| Who | One person, one machine | Many users, one deployment |
| Account | None. A single implicit `local_owner` row, marked owner | Email and password sign-in, one `member` row per user |
| Database | Embedded Postgres (PGlite) in `DATA_DIR` | PostgreSQL server at `DATABASE_URL` |
| Migrations | Applied automatically on first use | Explicit deploy step: `pnpm db:migrate` |
| AI | Optional, off by default | Optional, per-user key only |
| Cost | Nothing to pay | Operator's hosting only |

The mode is read once from the environment by `apps/web/src/server/config.ts`. Everything below the config line is identical in both modes: one schema, one migration set, one query layer.

## Layout

```
apps/web/                 Next.js (App Router, TypeScript strict, Tailwind, shadcn/ui)
  src/app/(app)/          The studio behind the session check; (auth)/ holds sign-in and sign-up; api/ holds route handlers
  src/components/         Shell, empty states, shadcn/ui primitives
  src/server/
    config.ts             Env to validated config (mode, driver, data dir, app URL, auth secret, owner id)
    context.ts            AppContext (config, db, auth) for a request
    auth/                 Better Auth setup (hosted), session resolution, requireSessionUser
    http/                 Request guard and the JSON route handlers' logic
    db/                   schema.ts (Drizzle), client.ts (pglite or node-postgres), migrate.ts
    data/                 The data-access layer: forOwner(ownerId) and its repositories. Only code that queries tenant tables.
    actions/              The shared action layer (see below): knowledge, profile, export, system
  drizzle/                Generated SQL migrations (one set, both drivers)
  seed/                   owner.private.json (gitignored, never committed): the private owner seed
  test/                   Vitest: db, health, tokens, hygiene, auth, isolation, search, seed, source rules
packages/                 Phase 0, kept and reused on Day 5
  core/ daemon/ client/ mcp/ cli/    Approval gate, dev.to and Buffer routes, dashboard, MCP, CLI
scripts/setup-local.mjs   One-step local setup
```

It is a modular monolith: one deployable, internal modules with clear seams. No Redis, Kafka, Kubernetes or vector database. Long work (publishing retries, imports) runs in-process with rows in Postgres as the queue until measurement says otherwise.

## The shared action layer

Every capability is a function in `src/server/actions/`: input validated with Zod, an authenticated `owner` context in, a typed result out, an audit event written for anything that changes state. Three callers use the same functions and nothing else:

```
 Browser UI (server components, route handlers)  \
 MCP server (user's own Claude Code)              >-->  actions/  -->  data/ (scopedX)  -->  db/
 AI provider (optional, structured operations)   /
```

The rules that follow from this:

- UI, MCP and AI never import `db/` or `drizzle-orm` tables directly. They call actions.
- An AI call cannot do more than a user's click can: it goes through the same action, with `actor: 'ai'` in the audit trail.
- Every action after the first takes an `OwnerContext` (built only from a session by `sessionToOwner`) and accepts no owner id in its input. Day 1 had `getHealth()`; Day 2 added knowledge, profile and export. Later days add articles, drafts and publishing in the same shape.

## Tenant model

`users.id` is the owner id. Every other table carries `owner_id uuid not null references users(id)`, indexed with its most common sort key. Rules:

1. Only `src/server/data/` touches tenant tables. `forOwner(ownerId)` returns the repositories; every query inside is filtered by that owner id, and inserts set it last. The id is validated as a UUID so a malformed value cannot widen a query. A source-rule test fails the build on any other access.
2. Tests prove isolation (owner A cannot read, list, modify, search or publish owner B's rows). `test/isolation.test.ts` covers profiles, preferences, sources, items, search and export through the data layer and the route handlers; each new table adds the same tests.
3. Row level security is available in both engines (verified, see `DECISIONS.md`) but is not the primary boundary: the embedded engine connects as a superuser, which bypasses it. Hosted mode may add RLS under a non-superuser role as defense in depth.
4. The owner id comes only from the authenticated session (hosted) or the single local owner (local), never from request input or an MCP or AI argument.
5. Private owner data (the personal knowledge seed) is bound to the owner's user id, is read only from a gitignored file, lives in the database, and never enters git, fixtures or docs.

## Accounts and sessions

Local mode resolves every request to the `local_owner` row (a real user id, `is_owner` set). Hosted mode uses Better Auth (decision 11): `/api/auth/*` endpoints, an httpOnly SameSite=Lax session cookie, sessions stored in Postgres. `src/app/(app)/layout.tsx` redirects signed-out hosted visitors to `/sign-in`; route handlers answer 401. JSON route handlers also run a request guard (loopback host names in local mode, same-origin for mutations).

## Knowledge

`profiles` and `brand_preferences` (one row per owner), `knowledge_sources` and `knowledge_items` (one claim per row, with verification, confidence, confidentiality, a public-use flag and a review date). Search is a generated `tsvector` with a GIN index, ranked and highlighted in SQL, always inside the owner filter. `GET /api/export` returns the signed-in user's own rows as JSON.

## Adapter seams

Three seams keep providers replaceable. Day 1 defines the shape; implementations arrive later.

| Seam | Interface (sketch) | Implementations |
|---|---|---|
| Storage | put, get, delete, signed or local URL for article assets | Local folder under `DATA_DIR` (default); S3-compatible (hosted, later) |
| AI | `complete(task) -> structured result`, capability probe, never required | None (default); local Ollama or any OpenAI-compatible server; user's own Anthropic API key |
| Publishing | auth, formats, create or update draft, schedule, media, status, restrictions | DEV.to (Day 5), Hashnode, personal-site change, Medium as "prepare and open" |

Verified facts and limits for each provider are in `INTEGRATIONS.md`.

## Approval boundaries

- Nothing is published, posted, scheduled or sent without the owner's explicit approval of that exact action. One approval covers one action, never a batch relayed by another session.
- Publish actions in the web app will route through the Phase 0 approval gate in `packages/daemon` (Day 5). The web app and MCP can stage drafts and request approval; they cannot approve.
- AI output is a proposal: structured operations shown as a diff, applied only when the owner accepts.
- Credentials are never read from `~/.claude` or any Claude login. The only Anthropic credential accepted is an API key the user saved on purpose.
- Provider keys are stored per user, encrypted with an app-level key, shown as last four characters only, never logged.

## Phase 0 and the new stack (two stores, until Day 5)

Phase 0 is a separate local program: a daemon with SQLite (`cph.db`), the approval gate, OS keyring secrets, dev.to and Buffer routes, an MCP server and a dashboard. The new web app has its own Postgres. They do not share data on Day 1. Day 5 reconciles them as described in `DECISIONS.md` (decision 7).

## Observability

`GET /api/health` returns `{ status, mode, db: { ok, driver, latencyMs, schema } }`, HTTP 503 when the database is unreachable. The top-bar chip polls it; Settings shows the detail. Audit events (`audit_events`) record who did what, per owner.
