# Decisions

Each entry: the decision, why, and what it costs. Dated 2026-10-21 (Phase 1, Day 1). Versions were read from the npm registry on that date. Decisions 11 to 17 were made on Day 2 (2026-10-21).

## 1. One Postgres schema; embedded engine locally, a server when hosted

**Decision.** Local mode runs embedded Postgres (`@electric-sql/pglite` 0.5.10, PostgreSQL 18.6 compiled to WASM) through `drizzle-orm/pglite`. Hosted mode runs a real PostgreSQL server through `drizzle-orm/node-postgres` at `DATABASE_URL`. The choice is made by `MODE` alone. One schema, one generated migration set, one query layer; app code depends on the `AppDb` type, never on a driver. Driver modules are imported lazily.

**Why.** Docker is installed here but its engine is not running, and there is no local Postgres. Local mode must work with no account, no AI key and nothing to install or pay for. PGlite needs nothing but Node. Postgres on both sides keeps the data model, SQL and migrations identical, so self-hosters and the SaaS do not diverge.

**Trade-offs.**
- PGlite allows one process per data directory. A pid lock (`cph.lock`) makes a second writer fail loudly (for example `pnpm db:migrate` while the dev server runs: stop the server first).
- It is single-connection and in-process, so it is for one person, not for concurrency. That is the local-mode use case.
- Extensions are limited to what PGlite bundles. Anything beyond core SQL must be checked before use.
- Tests run on in-memory PGlite and cover the hosted driver only for configuration and unreachable-server behavior. A real-Postgres run needs a server (Docker engine, not available today); the hosted path is therefore less exercised than the local one until CI gets a Postgres service.

## 2. What PGlite supports (checked, not assumed)

Both are asserted in `apps/web/test/db.test.ts`, so a PGlite upgrade that changes them fails a test.

- **tsvector full-text search: supported.** A generated `tsvector` column, a GIN index, `websearch_to_tsquery` and `ts_rank` all work. Day 2 knowledge search can use native Postgres FTS in both modes.
- **Row level security: supported, with a caveat.** Policies and `FORCE ROW LEVEL SECURITY` work and are enforced for a non-superuser role (`set role`), including `WITH CHECK` on inserts. But the embedded engine connects as the `postgres` superuser, and superusers bypass RLS, so in local mode RLS would protect nothing unless every query switched roles.

**Decision.** Tenant isolation is enforced in one data-access layer (`src/server/data`), where every query is scoped by `owner_id` and covered by tests. RLS is not relied on. Hosted mode may add RLS under a non-superuser application role later as defense in depth (Day 27 security review).

**Trade-off.** Isolation depends on discipline: a query written outside `data/` could leak. Mitigations: only `data/` imports table definitions (a Day 2 lint or test will enforce it), `scopedX` factories make the unscoped query the harder one to write, and each new table ships an isolation test.

## 3. Stack and exact versions

Next.js 16.4.2 (App Router, Turbopack), React 19.3.1, TypeScript 5.9.3 (strict, `noUncheckedIndexedAccess`), Tailwind CSS 4.3.3, shadcn/ui components (new-york style, copied into `src/components/ui`, built on `radix-ui` 1.8.1, `lucide-react` 1.61.0, `cmdk` 1.1.1), Drizzle ORM 0.45.4 with drizzle-kit 0.31.11, `pg` 8.23.1, Zod 4.6.7, ESLint 9.39.5 with `eslint-config-next` 16.4.2, Vitest 5.0.5. All pinned exactly, no ranges.

**Deliberate exceptions to "latest".**
- TypeScript stays at 5.9.3, the workspace pin shared with the Phase 0 packages. TypeScript 7 exists; moving the whole workspace is a separate change with its own risk.
- ESLint stays on 9.x because the React and Next lint plugins lag a major version. `eslint-config-next` accepts `>=9`.

**Why this stack.** Owner-decided. It gives one language end to end, server components for the shell, route handlers for `/api/*`, and a deployment story (Node server or Vercel) that does not need new infrastructure.

## 4. Modular monolith, no extra infrastructure

One Next.js app with internal modules (`db`, `data`, `actions`, UI). No Redis, Kafka, Kubernetes, vector database or separate API service. Background work runs in-process with Postgres rows as the queue. **Trade-off:** a very large hosted deployment would eventually want a worker process; the action layer is the seam to split on, so it is a move, not a rewrite.

## 5. A shared action layer for UI, MCP and AI

Every capability is an action: Zod-validated input, owner context, typed output, audit event. UI, the MCP server and AI features call actions and nothing else. **Why:** guarantees that an AI or an MCP client has exactly the powers of a click, with the same validation, scoping and audit trail, and that "works with AI off" is true by construction. **Trade-off:** a thin extra layer for simple reads.

## 6. Tenant model

`users.id` is the owner id; every other table has `owner_id`. Local mode has one fixed `local_owner` row created idempotently on first use (fixed UUID, so a later import or switch to a sign-in does not orphan rows). Hosted accounts are `member` rows (Day 2). The private owner seed binds to the owner's user id, never to a display name.

## 7. Two stores until Day 5, and how they reconcile

Today there are two stores: the Phase 0 daemon's SQLite (`cph.db`, approval gate state, keyring-held credentials, publish log) and the new Postgres. They are intentionally not synchronized on Day 1; neither depends on the other, and Phase 0's tests still pass untouched.

**Reconciliation on Day 5 (publishing connectors):**
- Postgres becomes the system of record for articles, drafts, versions and publications.
- The daemon stays the only path to a public action. The web app and MCP stage a draft and request approval; the owner approves in the gate; the daemon performs the call and returns the provider id and URL, which the action layer stores on the `publications` row. The approval gate and credential handling are not reimplemented in Postgres.
- Phase 0's DEV.to route is reused behind the new publishing adapter interface. Hosted mode, which has no per-user daemon, gets a server-side adapter with per-user encrypted credentials and an explicit per-action approval step in the UI.
- No bulk migration of SQLite rows is planned. If Phase 0 content rows are worth keeping, a one-time import action reads them through `packages/client` and writes through the action layer.

**Cost.** Until then, publishing from the web app does not exist (the Publishing and Connections pages say so), and the dashboard from Phase 0 remains the way to approve a post.

## 8. Local ports and files

`pnpm web:dev` listens on port 3100, not 3000, because 3000 is commonly taken by other local projects (it was on this machine). `next start` honors `PORT`. Local data lives in `apps/web/.data` unless `DATA_DIR` says otherwise; `.data/` is gitignored. Back up by copying the folder while the app is stopped.

## 9. AI is optional by construction

Three ways to use AI, none required: the user's own Claude Code over MCP (user-driven, no inference by the app), a local Ollama or OpenAI-compatible server, or the user's own Anthropic API key. The app never calls Anthropic without a key the user saved, never accepts a Claude login, and never runs the `claude` binary on a hosted server. Reasoning and sources: `INTEGRATIONS.md` section 7.

## 10. Design system

Palette from the personal site (cream, ink, rust, teal, sand) as CSS variables with a warm dark theme, local font stacks only (no network fonts), visible focus rings, `prefers-reduced-motion` respected. The brand rust and teal fail WCAG AA as small text on cream, so text uses darker role tokens (`--link`, `--teal-text`); contrast pairs are asserted in `test/design-tokens.test.ts`. Unbuilt features render an intentional empty state that names the day they arrive; there is no placeholder data and no inert button.

## 11. Authentication: Better Auth on our own tables

**Decision.** Hosted mode uses Better Auth 1.7.12 (email and password only) with the Drizzle adapter on the same Postgres. No third-party auth service. Its model names are mapped onto our tables: `user` is `users` (name is `display_name`), plus `sessions`, `accounts`, `verifications`; ids are UUIDs. Local mode has no sign-in at all: a request is the single `local_owner` row, which carries a real user id on every row it writes.

**Why this one.** It works with Drizzle and with both drivers (it only needs the query builder), runs inside a Next route handler, is actively maintained, ships secure defaults and a rate limiter, and avoids writing session and password code ourselves. Alternatives considered: Auth.js (database sessions with credentials are second-class there and it is in maintenance mode), Lucia (deprecated as a library), and a hand-rolled scrypt plus sessions table (about 150 lines, but every line is ours to get wrong and keep current).

**Specifics.**
- Passwords are salted scrypt hashes (Better Auth default, memory hard). Argon2id is the current first choice in OWASP guidance and scrypt is the accepted alternative; moving to Argon2id means a native dependency, so it is deferred.
- The session is an opaque random value in an httpOnly, SameSite=Lax cookie, Secure when APP_URL is https. The server stores the session row, so sign-out revokes it at once. Lifetime 14 days, refreshed daily.
- Better Auth turns its Origin and CSRF checks off when NODE_ENV is "test"; we set both explicitly on so tests exercise the real behavior. A cross-origin sign-out carrying the cookie is rejected in a test.
- Sign-in and sign-up are rate limited (8 and 5 per minute per address, 100 for everything else). The limiter is in memory, so it is per process; a multi-instance deployment needs a shared store (Day 27).
- Email verification and password reset are off: there is no mail provider yet, so neither could complete. Cost: a typo'd email address is accepted, and there is no self-service reset until mail exists.
- Forms post to the Better Auth endpoints with fetch (not through server actions) so the origin check and rate limit apply. Server components resolve the session from the cookie on every request; there is no cookie cache.
- Hosted mode needs AUTH_SECRET (at least 32 characters). It is checked when sign-in starts, not when config loads, so the health endpoint still answers without it.

**Trade-offs.** One more dependency tree (about 26 packages) and its release cadence. Its endpoints are exposed under /api/auth, including ones we do not use; they are inert without the matching feature flags.

## 12. How tenant isolation is enforced

**Decision.** One data-access layer, `src/server/data`. `forOwner(ownerId, db?)` returns repositories (profile, preferences, sources, items, audit, exportAll) whose every query carries `owner_id = $owner` in the same WHERE as everything else, and whose inserts set `owner_id` last, after any caller-supplied values. The owner id is validated as a UUID. A row that belongs to someone else is indistinguishable from a row that does not exist (not found, not forbidden), and a source id on an item is checked to be the same owner's.

**Where the owner id comes from.** Only from a resolved session: `resolveSessionUser` returns the signed-in user (hosted) or the local owner (local), and `sessionToOwner` is the single place an `OwnerContext` is built. Actions take that context first and accept no owner id in their input (Zod strips unknown keys). Route handlers never read an owner id from the body, query, path or headers. This is what an MCP tool or AI call will use on Day 4 too.

**Enforcement.** `test/source-rules.test.ts` fails the build if code outside `src/server/data` and `src/server/db` imports a tenant table, names one in raw SQL, imports the query builder, or calls `forOwner` anywhere but the session-to-owner function and the seed; if pages or components import the data or db layers; or if a handler reads an owner id from a request. Behavior tests (`isolation.test.ts`) run two real hosted users and prove that B cannot read, update, review, delete, attach to or search A's items, sources and profile, through the data layer and through every route handler and the export, even when B passes A's ids, and that an owner id smuggled in a body, query string or header is ignored.

## 13. Row level security: not added (answer: it is not simple here)

RLS would be a second boundary for hosted Postgres only. It needs (a) a non-superuser application role, since superusers and table owners bypass policies, (b) the owner id set per request with `set_config` inside a transaction that wraps every query, so a pooled connection never carries one request's id into the next, and (c) a second deployment mode to test, because the embedded engine connects as superuser. Our pool hands out connections per query, not per request, so (b) means restructuring the data layer around a request-scoped transaction. That is a real change with its own failure modes (a missed set_config either blocks everything or, worse, silently depends on a stale value). The owner_id filter in the data layer, the source rules and the isolation tests are the boundary. RLS stays on the Day 27 security review list as defense in depth, with the verified PGlite behavior in decision 2.

## 14. Knowledge model and search

- `knowledge_items` holds one claim per row. Defaults are the safe ones: confidentiality private, verification unverified, public use not permitted, never reviewed. `verification_status` is verified, owner_claim_needs_review or unverified; `confidence` is low, medium or high; kinds are fact, achievement, experience, project, reading, certification and note.
- "Mark reviewed" sets verified and the review date. It never touches public use; that is a separate explicit choice.
- Search is native Postgres full text: a generated `tsvector` column (title weight A, body B, tags C, English stemming) with a GIN index, `websearch_to_tsquery` (phrases, minus to exclude, no syntax errors on odd input), `ts_rank` ordering and `ts_headline` snippets. The tenant filter is in the same WHERE as the match. Snippets mark matches with two control characters, not HTML; the UI splits on them and renders React text nodes, so item text can never inject markup.
- The generated column needs an immutable expression and `array_to_string` is only stable, so migration 0002 defines a small immutable SQL function (`cph_join_tags`). It is hand-written in the migration; regenerating migrations must keep it.
- Limits: English stemming only; no fuzzy or typo matching; a query of only stop words returns nothing.

## 15. The private owner seed

- Bound to a user id, never a name, email or display name. Local mode: the auto-provisioned owner row, and only while its `is_owner` flag is set. Hosted mode: the id in OWNER_USER_ID. `applyOwnerSeed` refuses any other target, a missing owner, or an unflagged local row, and writes nothing in those cases.
- Idempotent by stable `seed_key` per item and source: insert if absent, never update, so a re-run changes nothing and the owner's later edits survive. The whole seed runs in one transaction. The audit event stores counts only.
- A seed can never make anything public: the schema rejects public confidentiality and any public-use flag. All seeded achievements are owner claims awaiting review, kept as separate items and never summed.
- The only data source is `apps/web/seed/owner.private.json`, gitignored (verified with `git check-ignore`) and untracked. `pnpm seed:owner` prints counts only. A test reads the file when present and fails if its claims, or the owner identity within the web app and its docs, appear in any tracked file.
- Trade-off: idempotent insert-only means fixing a typo in the seed file does not update an already seeded row; edit it in the app, or delete the row and re-run.

## 16. Request guard for the JSON API

Local mode has no login, so anything that can send a request to the port acts as the owner. The API therefore refuses (a) non-loopback Host names in local mode, which stops DNS rebinding from a hostile page, and (b) mutating requests whose Origin names another site, or whose Sec-Fetch-Site says cross-site. Non-browser clients send neither and are allowed; the session cookie is also SameSite=Lax. Server actions use Next's built-in origin check. Residual risk: other software on the same machine can still call the local API, which is inherent to a no-login local mode.

## 17. Onboarding days for features that are not built

The onboarding page shows disabled controls with the planned day: resume upload (Day 3, with the file importer), GitHub import (Day 27, onboarding and connection management) and source connections (Day 5, with the publishing connectors). These are the current plan, not promises; they are copied from TODO.md and should move if it does. Until then a new account is fully usable by hand: profile form, knowledge items, export.
