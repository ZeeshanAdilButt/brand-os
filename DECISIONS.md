# Decisions

Each entry: the decision, why, and what it costs. Dated 2026-10-21 (Phase 1, Day 1). Versions were read from the npm registry on that date. Decisions 11 to 17 were made on Day 2, 18 to 23 on Day 3, 24 to 31 on Day 4 and 32 to 38 on Day 5 (all 2026-10-21).

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

**Superseded in part on Day 5 (decision 32).** The web app does not call the daemon. It ports the gate's invariants onto Postgres instead, and the daemon stays as the legacy single-user path until Day 7 decides whether to reconcile or retire it.

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

## 18. Editor: CodeMirror 6

A plain textarea cannot do fenced-code highlighting, list continuation or reliable undo, and Monaco is far heavier than a Markdown page needs. CodeMirror 6 gives Markdown with nested language highlighting (loaded per language on demand), history, accessible key bindings and a small core. The editor is a client component loaded with `next/dynamic` (`ssr: false`), so the studio shell appears first and the editor and its language support download after. Colors come from the site design variables, so light and dark need no second theme. Tab is left to move focus (no keyboard trap); indent with Ctrl+] and Ctrl+[. Not built: in-editor find and replace (the search package is not installed), vim keys, collaborative editing.

## 19. One Markdown pipeline, and nothing is dropped silently

`src/lib/markdown/render.ts` is the only renderer: unified with remark (GFM: tables, task lists, footnotes, strikethrough, autolinks) and rehype. The editing preview runs it in the browser and the reading view runs it on the server, so what you preview is what you read. Raw HTML is allowed into the tree and then sanitized against GitHub's allow-list (hast-util-sanitize). The pipeline marks every element before sanitizing and compares before and after, so each removal (a script, an iframe, an `onerror` attribute, a `javascript:` or `data:` link, an unsupported MDX component) comes back as a notice and the UI shows "N items were not rendered" with the list. The Markdown source is never changed. Plain HTML comments are the one exception: they are invisible by nature and stay in the source. Heading and footnote ids get a `user-content-` prefix so an author's `id="location"` cannot shadow a browser global; in-page links are rewritten to match. Syntax highlighting covers go, rust, python, sql, bash, yaml, json, typescript, javascript, css, xml, diff, dockerfile, markdown, ini, c, cpp and java; other fences render as plain code. Math is not rendered (not cheap enough to do safely today; dollar-sign text stays as written). There is no embed allow-list yet, so every iframe is removed and reported.

Mermaid fences render client-side and lazily: the `mermaid` package loads only when a diagram exists, runs in `securityLevel: 'strict'`, redraws on a theme change and caches by source. If a diagram fails to parse, the code block stays and a visible warning says why. Uploaded images are written as `asset:<id>` in the Markdown and resolved to the authenticated asset route when rendered, so the stored text does not depend on where the app runs.

## 20. Assets: storage adapter, image checks, SVG policy

- **Adapter.** `StorageAdapter` (put, get, delete) with a filesystem implementation under `DATA_DIR/assets/<owner id>/<file id>.<ext>`. Keys are generated by the server and must match one exact shape (owner uuid, file uuid, known extension); a key is checked before every disk call and the resolved path must still sit inside the root. User input never reaches a path. **An S3 adapter is a documented seam only: it is not built.** Hosted mode today keeps files on the server's disk, which suits a single machine or a persistent volume but not serverless hosting; that needs the S3 adapter first.
- **What is accepted.** PNG, JPEG, GIF, WebP and clean SVG, up to 10 MB. The type is decided from the bytes; the file name and the type the browser claimed are ignored. The stored name is only for display and is cleaned.
- **SVG.** Accepted, but treated as untrusted twice over. At upload an SVG containing a script, `foreignObject`, event handlers, `javascript:` or HTML data URLs, entity declarations, stylesheet imports or any reference outside the file is refused with a clear message (it is rejected, not edited, so nothing changes behind your back). At serve time every asset carries `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox` and `Cross-Origin-Resource-Policy: same-origin`, and SVG is sent as an attachment so opening it directly downloads instead of rendering as a page of this origin. It still displays in an `<img>`.
- **Dedupe and access.** A file with the same sha256 that the owner already holds is reused; two owners with the same bytes each get their own row and key. Files are served only by `/api/assets/<id>`, which looks the id up through the data layer for the signed-in owner (another owner's id is a 404).

## 21. Saving, concurrency and version history

- **Optimistic concurrency.** `articles.revision` increases on every accepted change. A save must name the revision it saw; a stale one gets HTTP 409 with the current copy and writes nothing. The editor then shows a dialog with a summary and a diff and two explicit choices: keep my version (overwrite on purpose) or use the saved one. Nothing is overwritten until a choice is made, and the other version stays in history.
- **Autosave** is a small state machine (`src/lib/autosave.ts`, tested without a browser): about 1.5 s debounce, one request at a time, only changed fields, retry with growing delays when offline or the server fails, and a field the server rejects (a taken slug) is held back so it cannot block the rest. The indicator shows saved, unsaved, saving, offline, error or conflict. Pending edits are sent when the editor closes or the page is hidden (a keepalive request for bodies under 60 KB), and the browser's leave-page prompt appears if something is unsent.
- **History.** `article_versions` rows are never edited. A deliberate save (Ctrl+S), an import and a restore each leave their own entry. Autosaves from one editing burst (10 minutes from the burst's first save) collapse into one: the older autosave row is deleted and a new one holding the latest state is inserted. A manual save of text identical to the latest autosave promotes it. Restore adds a new version (reason restore) and keeps slug and status as they are, so restoring cannot collide with another article or change an address. The compare view is a line diff (Myers) between any two versions or the current text.
- **Trade-off.** History granularity is one autosave entry per 10 minutes, so a bad edit inside a burst cannot be undone from history (the editor's own undo covers it).

## 22. Imports

- **File.** `.md`, `.mdx`, `.markdown`, `.txt`, up to 1 MB, UTF-8 only (binary and other encodings are refused with a message). Front matter (YAML, core schema) supplies title, description, tags, canonical address and date; common aliases are understood; a cover reference and every unknown key are kept in `extra_metadata`. A front matter block that cannot be parsed stays in the body with a warning. With no title, the first heading is moved into the title (reported) or the file name is used. MDX imports, exports and components stay as literal text with one warning that counts them. CRLF and a byte order mark are normalized.
- **URL.** Fetched by the server, so it is the SSRF-sensitive path. Rules, all tested with an injected resolver and fetcher: only http and https, no user name or password in the address, ports 80, 443, 8080 and 8443; local-looking names are refused before any lookup; the name is resolved here and every answer must be public (one private answer refuses the name); the connection goes to the address that was checked, so a second lookup cannot rebind it; redirects are followed by hand, at most 5, and every hop repeats all checks; nothing from the user's browser or login is forwarded (no cookies, no auth headers); 5 MB and 10 s caps; the answer must be HTML, XHTML, Markdown or plain text. Blocked ranges cover IPv4 private, loopback, link-local (including the cloud metadata address), carrier-grade NAT, multicast, reserved and documentation, and IPv6 loopback, link-local, unique local, multicast, mapped, compatible, NAT64, 6to4 and Teredo forms, with embedded IPv4 addresses checked. The main article is found with Mozilla Readability on a linkedom document and converted with rehype-remark and remark-gfm, keeping code languages, tables, links and image addresses (made absolute). Images are linked, not copied, and the import says so. No third-party scraping service is used. Residual risk: a malicious public server can still use up the 10 s budget per hop.
- **Folder.** Local mode only (in hosted mode the folder would be the server's disk, so the feature is disabled with a reason). The owner sets a content folder; files are listed (md, mdx, markdown; hidden folders and node_modules skipped; 500 files at most) and imported one at a time by explicit choice, read-only. A requested path must be relative, free of `..`, drive letters and NUL bytes, and its real path (after every link) must stay inside the folder's real path. Directory links are never followed while listing, a file link is listed only if it stays inside, and the page reports how many links were skipped. Already imported files are marked; importing again creates a new article with the next free slug. Tests create a directory junction on Windows (file links need a privilege there, so two file-link cases skip on such machines and run elsewhere).
- **Result.** Every import creates a draft (never published) with a first version of reason import, and the response lists warnings and notes.

## 23. Article search

Same approach as decision 14: a generated `tsvector` (title A; description and tags B; body C), GIN index, `websearch_to_tsquery`, `ts_rank` and `ts_headline`, with the tenant filter inside the same WHERE. The list excludes archived articles unless asked. Slugs are unique per owner (`articles_owner_slug_idx`), so two owners can both have `hello-world`; the slug check endpoint only looks at the caller's articles.

## 24. Agent keys: random, hashed, scoped, revocable, and the only way an agent picks an owner

**Decision.** A person creates named keys in Settings > Agent access with a scope list (`read`, `write_articles`, `ai_tasks`). The secret is `bos_` plus 32 random bytes (base64url), shown once; the database keeps its SHA-256, a short prefix for display, last use and a revoke time. `/api/agent/*` accepts only `Authorization: Bearer`. The owner id comes from the key row. No path, query, body, header or MCP argument can name an owner, and unknown keys in a body are stripped by the same Zod schemas the UI uses.

**Why a plain hash.** The secret is 256 random bits, so it cannot be guessed or brute-forced offline from a hash, and a slow password hash would only slow every request. The lookup is by unique index on the hash, and a request that is not shaped like a secret never reaches the database.

**Limits.** Requests are limited per key (120 a minute) and failed attempts per client (20 a minute), in memory, so per process (a multi-instance deployment needs a shared store: Day 27). A revoked key gets the same "not valid" answer as an unknown one and the attempt is written to the owner's audit log. Agent saves are recorded with the version reason `agent` and audit actor `agent`; the reason is chosen by the action from who is acting, never by the request. A key cannot create or revoke keys or change providers.

**Trade-off.** A key is a bearer secret: anyone who has it has its scopes until it is revoked. Scopes are coarse on purpose (three), and "read" includes private knowledge because the point is to let the owner's own Claude Code understand them; the instructions to the agent say private items are context, not text to publish.

## 25. Provider keys at rest: AES-256-GCM bound to the row

**Decision.** A provider's API key is stored as `v1.<iv>.<tag>.<ciphertext>`, AES-256-GCM with a fresh 12-byte IV, and the owner id and provider id are authenticated data, so a value copied to another row or tenant fails to decrypt. The master key is HKDF-SHA256 of `APP_SECRET` (at least 32 characters; the only option in hosted mode, where saving a key without it is refused with a message that says what to set); in local mode with no `APP_SECRET` it is 32 random bytes in `secret.key` in `DATA_DIR`, created with owner-only permissions (mode 0600; on Windows the inherited permissions are replaced with the current user's, best effort). The browser only ever receives "has a key" and the last four characters; the runner is the only code that reads the ciphertext. Errors from a provider pass through a redactor that removes the key itself and anything shaped like a key or an auth header, and the code that handles keys and task text logs nothing but error names (a source-rule test).

**Costs.** Changing `APP_SECRET` or losing `secret.key` makes saved keys unreadable; the person enters them again (the message says so). Back up `DATA_DIR` including `secret.key` together. Key rotation and a KMS are Day 27 work.

## 26. Provider kinds, trust and hosted rules

**Decision.** Four kinds: `local` (OpenAI-compatible chat completions: Ollama at `/v1`, LM Studio, vLLM), `api_key` (Anthropic Messages API, or an OpenAI-compatible service with the user's key), `claude_code_handoff` (no execution: tasks wait for the owner's Claude Code over the agent API) and `local_cli_agent` (a reserved registry slot, listed in the UI as "not built yet" and refused by the create action). Each kind has capability notes in the UI: where the text goes, what is unknown (context size), quality limits and what is estimated. There is no default provider and no environment variable key: the app calls only providers the person set up (a source-rule test forbids reading provider keys from the environment).

**Trust is derived.** `local` only when the kind is `local` and the address is loopback or a private network (`localhost`, `127.0.0.0/8`, RFC 1918, `.local`, a one-word host name); everything else, including a "local" provider pointed at a public address, the hand-off (the text reaches Anthropic through the person's own Claude Code) and every `api_key` provider, is `external`.

**Hosted servers.** A hosted server cannot reach a model on the visitor's machine and must not become a way to reach private networks, so `local` providers are refused there, an OpenAI-compatible address must be https on a public name and port 443 or 8443, and every call resolves the name, requires every answer to be public and connects to the checked address (the same rules as the URL importer, decision 22).

**API shapes.** Verified from vendor documentation on 2026-10-21 (sources and gaps in `INTEGRATIONS.md`). One thing remains unverified: OpenAI's own reference page refused automated access, so the OpenAI-compatible request shape rests on the Ollama compatibility page and common behaviour; the adapter sends `max_tokens` and retries once with `max_completion_tokens` if the server says that is the right name.

## 27. The privacy gate for model context

**Decision.** A request carries the selected excerpt and the article's title, description and tags. Knowledge items are searched with the owner's scoped search on the excerpt and instruction, and an item is included only if it is relevant AND (the provider is `local`, OR the item is marked for public use, OR the person approved that item for this task). Style preferences go only to local providers. A private item is never added to an external request by default: the task card says how many were left out and offers "Review what would be sent with them", which shows the full text, system and user parts, and creates a new task only when the person confirms. The approval carries the SHA-256 of the exact text; the server rebuilds the text and refuses a different hash. An approval can name only items that are relevant candidates for that task in the owner's own knowledge.

**Prompt injection.** Article and note text is fenced between markers whose nonce is derived from the content (so identical requests give identical text, which the cache needs, but text inside cannot guess its own fence), marker-like text inside is defanged, and the instructions say that anything between markers is material, not instructions. That is not relied on alone: the model can only return structured operations, restricted per task kind, and nothing is applied without a click (decision 28). A fixture test feeds an article that tells the model to delete everything and publish, with an obedient fake model, and shows the task fails and nothing changes.

**Trade-off.** Relevance is keyword search, so a relevant private item may not be found and an irrelevant public one may be. The cap is three notes of 800 characters.

## 28. Structured results, validation and stale detection

**Decision.** A result is one to five operations from `replace_range` (original, proposed, rationale), `suggest_titles`, `review_notes` (severity, quote, note), `insert_after` and `outline`, validated by one Zod discriminated union (`src/lib/ai-ops.ts`) for a model's answer and for a result from Claude Code. Each task kind allows only some operations (an `improve_section` task cannot return `insert_after`). Size limits apply, HTML in proposed text, titles, notes and headings is refused (code spans and fences are ignored so generics like `Map<String, Integer>` survive), and a `replace_range` original must lie inside the task's own excerpt, so a task about one paragraph cannot change another.

**Applying.** Accepting needs the revision the editor has saved, re-locates the original in the live article (at its old position, or at its only occurrence; an ambiguous or missing match is stale), refuses overlapping edits, and saves through the normal save path as a version with the reason `ai_accept`. A stale result is shown as out of date with the reason and cannot be accepted. Titles are applied only as the one the person picks; review notes apply nothing.

**Trade-off.** If a model quotes the original with small differences, the result fails instead of being fuzzily matched; the person can run it again. The word-level diff is a display of what accepting will do, computed in the browser.

## 29. Running tasks: background, cancellable, cached, capped, live

**Decision.** A provider that runs tasks executes them after the response using Next's `after` (outside a request it simply starts). One call is bounded by a timeout (two minutes by default). Cancelling aborts the call in flight through an in-process controller. One retry, only for overloaded, 5xx, a short rate limit or a dropped connection, never for a refusal, a timeout or a bad answer (a bad answer shows the reason and a "Run again" button). An identical request (same provider, model, kind and exact text) is answered from an earlier result at no cost. The monthly soft cap is in estimated tokens per provider and blocks new tasks with the numbers; tokens are the provider's own when reported and otherwise characters divided by four, marked as estimated, and no cost is ever shown. Tasks the server lost (a restart) become failed after five minutes instead of spinning.

**Live updates.** Status changes are published to an in-process bus after the commit and delivered over server-sent events at `/api/ai/events`, scoped by the session; the studio falls back to polling while a task is working if the stream cannot open. **Trade-off:** the bus is per process, and `after` needs a host that keeps the function alive; a multi-instance or serverless deployment needs a shared channel and a real worker (Day 27).

## 30. The Brand OS MCP server is a new package, not an extension of the Phase 0 one

**Decision.** `packages/brand-mcp` (server name `brand-os`, stdio, SDK 1.32.1) is separate from `packages/mcp`. The Phase 0 server is a facade over the local daemon, with the approval gate, the OS credential store and dashboard-only actions; the new one is a facade over the web app's agent API with a per-user key, and has none of those concerns. Mixing them would put publishing-adjacent tools next to ones an owner expects to be harmless. They can be registered side by side. Day 5 and 6 will add publishing tools to the Phase 0 server (behind the approval gate), not here.

**Details.** Nine tools, none that publish, stage platform drafts or approve (a test checks the tool list). Inputs are Zod-typed; a tool result removes owner ids and key-like fields and the key itself from every string. The server keeps its own copy of the result rules so a bad result fails before it is sent; a drift test runs a list of valid and invalid results through both copies and fails if they disagree. An end-to-end test runs the tools over the SDK's in-memory transport against the real route handlers with two accounts.

## 31. User-driven Claude Code versus automatic API inference

Two different things share the word "AI" here, with different rules (see also `INTEGRATIONS.md` section 7).

- **User-driven Claude Code.** The owner runs Claude Code on their own machine, under their own plan, and it calls the `brand-os` tools. The app makes no model call and holds no Claude credential; it supplies tools and data and checks what comes back. A hand-off task is a request the owner left in an inbox, completed only when the owner's own session picks it up.
- **Automatic API inference.** The app itself calls a model, only because the person added a provider (a local model or their own API key) and only for a task they started. The text goes where the provider's trust level says, the privacy gate applies, usage is counted, and the key is theirs.

The app never calls Anthropic without a key the person saved, never accepts a Claude login, and never runs the `claude` binary on a hosted server. The optional local companion for browser users is documented in `ARCHITECTURE.md` and is not built.

## 32. Publishing in the web app ports the Phase 0 invariants to Postgres; the daemon stays untouched

**Decision.** The web app is the multi-tenant publishing path. It does not call the single-user SQLite daemon. The Phase 0 engine's invariants were read (`packages/daemon/src/gate`, `routes/devto.ts`, `services/publish.ts`) and rebuilt in `apps/web` on Postgres, tenant-scoped through `forOwner`. `packages/daemon` is legacy: untouched, its tests green. Reconciling or retiring it is a Day 7 decision.

**What was ported.**
- A hash-bound, single-use approval consumed atomically with the move to `publishing`, in one transaction (`authorizePublish` in `src/server/data/publishing.ts`).
- The approval is void if the draft or its source changes: editing the article flags the draft `source_changed` and invalidates the pending approval, and the authorization re-checks the source hash itself.
- A private stage hard-sets `published: false`, reads the remote article first and refuses to touch a live one. `publish()` is the only place `published: true` is sent, with exactly the approved payload.
- One publish request, never retried. A refusal after sending is `failed`; a timeout, network error, 5xx, redirect or unreadable success is `unknown`, resolved only by a read-only platform check or the owner's explicit word, never silently re-approvable.
- Every platform request has a 30 second timeout and `redirect: 'error'`; keys are scrubbed from every error text; a late stage answer can never move a draft that is approved, publishing or published (a positive status list in the update itself).
- A lint that blocks approval, and a duplicate guard (here a partial unique index on owner, platform and payload hash while `publishing`, `unknown` or `published`).

**What was not ported, on purpose.** Windows Hello presence (the web app has a signed-in browser session instead, decision 33), the OS keyring (keys are encrypted in Postgres, decision 35), Buffer and the assist routes, scheduling, per-platform dry-run switches, and reading content from disk (the article studio is the source).

**Cost.** Two engines exist until Day 7. They do not share data. The web app has no per-action Windows Hello prompt; the approval is a session click with a checklist, which is weaker against malware on the owner's machine (decision 33).

## 33. The approval model: one session-only act, bound to one payload hash

**Decision.** A draft goes `draft`, `staged` (a private copy exists on the platform), `pending_approval`, then `publishing` and `published` (or `failed` or `unknown`). Nothing can be requested for approval until it is staged, so the owner can look at the private copy first. A request is a row with the payload hash, a short tag (the first 8 hex characters, upper-cased, shown on the card and on the button), a 30 minute expiry and a requester. A newer request voids the older one.

**Who may do what.** Agent credentials and the `brand-os` MCP server can prepare drafts, stage private copies and REQUEST approval. They cannot approve, decline, publish, check, mark or connect: there is no route, no scope and no tool for those, and tests prove it three ways (route files, exported handlers, the tool list). Approving takes a signed-in browser session. The route also refuses a request that carries an Authorization header and one with no Origin header; the request guard has already checked that the Origin is this app. The approval card shows the platform, account, canonical URL, tags and the exact request body that will be sent, and four checklist boxes that must all be ticked before the button enables. "Approve and publish" is one transaction, not two: there is no state in which an approved but unspent approval exists (the status `approved` is kept in the vocabulary and is never persisted). There is no bulk approve.

**What it does not protect against.** In local mode the app trusts loopback: a process on the owner's machine that forges an Origin header can call the same route the browser calls. Hosted mode requires a real session cookie. A per-action presence check (Windows Hello) is not available on this machine and is not part of the web app; the checklist and the exact payload are the friction instead.

**Trade-off.** The payload hash binds platform, account and payload together. Disconnecting and reconnecting a different account changes the account, so an old approval cannot be spent on it.

## 34. Failures: clean or ambiguous, and what is repeated

**Decision.** Every platform failure is classified (`auth`, `forbidden_plan`, `validation`, `rate_limit`, `not_found`, `server`, `timeout`, `network`, `redirect`, `protocol`, `config`) with a redacted, readable message and a next step. A clear refusal (401, plan, 422, 429, 404, nothing sent) is `failed`. Anything that may have taken effect (5xx, timeout, dropped connection, a refused redirect, a success answer that cannot be read) is `unknown`. A publish that was authorized but never recorded an answer (the process stopped) is shown as `unknown` after three minutes, never `failed`.

**Staging may retry; publishing never does.** Staging is private and repeatable, so up to three tries with a short, capped pause (1 s, 3 s, at most 10 s) are made for a 5xx, a dropped connection, a timeout or a rate limit that names a short wait. An ambiguous failure of a first create is not repeated, because it could make a second private draft; it is reported with a next step instead. A 429 asks for the wait it says (seconds or an HTTP date), and a wait over 10 seconds is not retried at all.

**Recovery.** "Check on platform" is read-only. Live settles an unknown draft as published with its link; still private returns it to staged (so a new, explicit approval can follow); not found settles nothing, because it is not proof that nothing went out. "Mark by hand" needs an explicit confirmation that the owner looked.

## 35. Platform keys and the test-only address override

**Decision.** A key is checked with a read-only call before it is saved (a refused key is not stored), then stored as AES-256-GCM ciphertext bound to the owner and the connection row, with the same master key as AI provider keys (decision 25). One connection per platform per owner. The browser receives only the last four characters. The key is typed into a password field on Settings > Connections and nowhere else; no environment variable provides one (a source rule forbids it). Decrypted keys live only for one call. They never reach the agent API, MCP results, the audit log or an error message (a test plants the key in a platform's error body and checks every output).

**The address override.** Platform addresses are constants. Two environment variables (`CPH_TEST_DEVTO_URL`, `CPH_TEST_HASHNODE_URL`) can point an adapter at a fake server, but only when `CPH_ALLOW_TEST_PLATFORM_URLS=1` is also set and only for a loopback address, so they cannot send a real key elsewhere. A test asserts that without the flag the override is ignored.

## 36. Hashnode: built from the official schema, live-unverified

**Decision.** Hashnode's GraphQL API (`gql-beta.hashnode.com`) is implemented from the official agent skill and its schema (see `INTEGRATIONS.md`). `publishDraft` takes only a draft id, so `publish()` first writes the approved payload into the draft with `updateDraft` and then publishes it: a failure in the first step is clean (nothing is public), a failure in the second follows the usual rules. The description goes to `metaTags.description`, tags are slugs, the canonical URL is `originalArticleURL`, a series is ignored with a warning (it needs an existing series id), and a missing Pro plan is reported as such. The UI and `INTEGRATIONS.md` call it live-unverified until the owner tries it with a real token.

## 37. Source tracking, adaptation and lint

**Decision.** A platform draft stores the article revision and a hash of the fields it was built from (title, slug, description, tags, canonical URL, cover, body). An edit through any route (editor, restore, agent save, accepted AI change) flags drafts built from the old text; reading drafts and authorizing a publish check again, so a missed sync cannot publish stale text. Adaptation is visible, not silent: tags are cleaned to the platform's form with a line for every change, a list still over the limit is left long so the lint refuses it, and DEV.to gets a short "Originally published at" footer only when a canonical URL is set. Lint errors (empty title or body, more tags than allowed, an image or link that only exists on the owner's machine, a cover that is not public https, an over-long body) block staging and approval; warnings (missing canonical, Mermaid on DEV.to, template-like text, removed HTML) are shown and allowed. Reachability is judged from the address form only; nothing is fetched.

**Trade-off.** An article that was already published is not rebuilt (editing a live post is not built), and a second article with identical text cannot be published to the same account.

## 38. Where publishing is shown (superseded by 40 and 47)

**Decision.** Connections moved to Settings > Connections (the old address redirects). The article studio has a Publish panel with one card per destination. The Publishing page lists every draft and what needs the owner (unknown results, waiting approvals). The composer, per-destination editing and approved batches are Day 6.

## 39. Design system v2: Warm Editorial (replaced by decision 48)

**Decision.** The interface uses warm gray for the workspace (`#f4f2ee`), a nearly white working surface (`#fffefc`), white for overlays, and a deep forest green (`#285347`) for actions, links, focus and selection. Serif type (Iowan Old Style, Palatino, Georgia) is used only for article titles and reading text; the interface itself is sans (Segoe UI and system stacks). Category colours (blogs, social, communities, video, conferences, editorial, launches, aggregators) appear only on small icons and labels. Status colours are semantic pairs (text on its own subtle background) and every status chip carries an icon and text, never colour alone. Dark mode is a warm dark gray with a light sage action colour.

**Why.** A first v2 used a cool gray canvas and indigo actions. The owner found it generic and cold, and said it looked worse than the original. A design review compared both and kept the first version's task order while recovering the original's warmth: paper, ink, and one deep colour for the things you press. The same review asked for fewer competing containers and control styles: one tab system (underline tabs for pages and status filters), selects instead of a wall of category pills, divided rows instead of a card per article, one progress strip inside the Home card, and solid borders for empty states (dashed is for real drop zones only).

**Checks.** `test/design-tokens.test.ts` computes WCAG contrast from the token values in both themes: 4.5:1 for text pairs (including every category colour on background, surface and raised), 3:1 for the boundary of a form control and for the focus ring. Fonts are local stacks only. Legacy names (`cream`, `rust`, `ink`, `*-subtle`) remain only as aliases.

**Deviations from the review.** None of its rules conflicts with the approval model. Where the review suggested "Layout preview" as the label of an approximate preview, the app keeps "Approximate preview", because that wording is part of the approval design: a preview never claims to be the platform.

## 40. One publishing screen: article, platforms, previews

**Decision.** `/publishing` is the one place to publish from. Three numbered areas work together on one page: (1) pick the article (searchable, newest first, with status and size), (2) tick platforms from the whole directory (category tabs, search, "Recommended for this article" chips), (3) see a live, approximate preview of that article on each ticked platform, with the device toggle, a quick edit of title, description and tags, and a side by side comparison. Ticking a platform adds the destination and prepares its draft, which sends nothing; unticking removes it (a post that went out cannot be removed). The choice is saved with the article on the server, and the last choice is remembered in the browser as a starting suggestion for the next article. A sticky bar says "N platforms selected" and has one button, "Review and approve", which continues to the approval queue.

**What cannot be ticked.** Only entries with a composer destination (13 today) can be ticked. Directory entries without one stay visible with the reason and are never selectable, so they cannot reach a preview, a queue or an approval. Of the ticked ones only DEV.to, Hashnode and the personal site publish through the app; the others get a preview and a manual handoff.

**Why.** The earlier guided path spread "choose" and "preview" over two screens and the composer over a third. Putting them on one page makes previews two clicks from Home. The old separate steps are folded in: `/articles/<id>/publish` now serves the approval queue, the results and the expert composer, and redirects a request for the old choose or preview steps to the Publishing screen.

## 41. Approving several posts: a review queue, never a bulk approval

**Decision.** There is no bulk approve. "Batch" means a review queue: the owner reviews one destination, approves it with its own button ("Approve and next"), and the queue moves on. The approve route accepts exactly one approval id and a body of only the ticked boxes (`.strict()`); the queue is a pure client reducer with no function that approves more than one post; it stops on a failure or an unknown result and never retries a publish by itself. No keyboard shortcut, command palette entry or MCP tool approves or publishes.

**Trade-off.** Approving five posts is five deliberate acts. That is the product: every public action needs the owner's own per-action approval.

## 42. Destinations, drafts and independence

**Decision.** Each destination of an article has its own platform draft: its own payload, hash, status, lint, approval and attempts. `article_destinations` records which destinations the owner added and in what order. Editing one never changes another, a failure on one leaves the others untouched, and an approval is bound to one payload hash, so an edit after the request voids it and the draft goes back to staging. A draft keeps what the adapter generated (`generated_payload`) next to what the owner edited, so "reset to generated" and the divergence view are exact. `platform_drafts` also gain `extras` (hashed with the payload: the site file path, a subreddit, a Mastodon instance), `remote_info`, `published_via` (app or manual), `edited_at` and `edit_count`.

**Preparing needs no account.** Preparing builds the post from the article and sends nothing, so it works without a connection (the owner can still preview and post by hand). The connected account is attached when staging, which changes the hash before any approval exists. Staging, approving and publishing still need the connection.

## 43. Platform catalog: 13 composer destinations, 45 directory entries

**Decision.** The catalog (`lib/catalog.ts`) holds 13 destinations with capability data (formats, limits, what the API allows, restrictions, cost, manual hosts): DEV.to, Hashnode, the personal site, Medium, Substack, LinkedIn, X, Bluesky, Threads, Mastodon, Reddit, Hacker News and YouTube. Three have adapters (DEV.to, Hashnode, GitHub for the site). The others use a content adapter that adapts and lints but whose every network method refuses with a clean "not sent" error. `isPublishable` and `requirePublishable` gate stage, approve, publish, check and connect. The directory (`lib/directory.ts`) adds the rest of the roadmap (blogs, social, communities, video, conferences, editorial, launches, aggregators) as directory-only entries: visible with their method, plan and cost, never selectable.

**Connection method per platform** is recorded in the directory: `api_key` (DEV.to, Hashnode, and a GitHub access key for the site), `oauth` (LinkedIn, X, Threads, Mastodon, Reddit, YouTube), `browser_assisted` (platforms with no usable API, where the owner's own Claude can set up access in their browser) and `manual_only` (Medium, Substack, Hacker News). OAuth connections are the next task: the Connect button stays off with the reason until then.

## 44. The personal site through GitHub, with safeguards

**Decision.** The personal site destination is Markdown export (generic, Hugo, Jekyll or MDX presets, with a path template and a front matter mapping) and, optionally, a pull request through the GitHub REST API. The adapter does only this, in order: read the base branch sha, read the target file on the base branch, create a new branch `brand-os/<slug>-<first 8 hex of the payload hash>` at that sha, commit one file to it, open a pull request. It never writes to the base branch, never merges, and refuses to replace an existing file unless the draft says "update existing" and the file's blob sha is the one the owner saw. A leftover branch is reused only if its tip is the base sha. Everything before the pull request call is a clean "not sent" failure (the worst case is a stray branch); the pull request call can be ambiguous (a timeout is `unknown`) and "Check on platform" looks for a pull request from that branch. Staging the site is read-only. The access key needs Contents and Pull requests (read and write) for that one repository.

## 45. Canonical page check

**Decision.** Before a syndication copy is approved, the app looks at the article's canonical page: a read-only fetch with the same SSRF-safe fetcher as URL import (public https only, private and loopback addresses and DNS that points inward are refused, one hop of redirect re-checked, size and time capped), plus a check that the page is on the host the owner set for their site. The result is kept per article and address. When the page is not live (404, unreachable, blocked), the approval needs one more box, "I know the canonical page is not live yet". Publishing is never blocked by the check, only made deliberate.

**Deviation from the design review.** The review asked for one combined acknowledgement. The approval keeps the four separate boxes the server computes (read the payload, it goes public, canonical, not undone by the app) plus the canonical box when needed. Fewer boxes would weaken the per-action approval, so the rule wins.

## 46. Saved values for platforms that are not built yet

**Decision.** The owner can save what a not-yet-built platform will need (an API key, or an OAuth client id and client secret). They are encrypted with the same AES-256-GCM scheme as connection keys, bound to the owner and the row, shown as "Saved. Not used yet." with only the last four characters, never returned, logged or echoed, never exposed through the agent API or MCP, wiped by Remove, and tenant isolated. For platforms with no usable API, a copyable prompt lets the owner's own Claude set up access in their browser; the secret never passes through chat.

## 47. Where things live in the app

**Decision.** Home (one next step, computed from real state), Articles, Publishing, Platforms (Directory and Integrations tabs, with the old Connections addresses redirecting), Knowledge, and Settings at the bottom. A global command palette (Ctrl K) lists pages, articles and platforms and never lists an action that approves, declines or publishes. Status language is shared: one set of chips with an icon and text, in one tone vocabulary (neutral, info, success, warning, danger, planned).

## 48. Design system v3: Field Notes

**Decision.** The owner chose "Field Notes" for the look and took the working patterns of "Paper and Ink" for the Publishing screen. The base is a deep forest (`#12372a`) with a lime accent (`#d6f36b`) on bone paper (`#f6f4ec`), white working surfaces, ink text (`#14211b`) and a faint 32px field grid on the page behind them (never behind dense text). The sidebar is forest, the primary action is forest with lime text, and selection on forest is lime. A warm vermilion (`--accent-warm`, with a soft tint and a deep brown for text on it) is used only for attention and action states: things to set up or connect, the active tab underline and links. Danger is a separate brown-red on a pale tint. Type is Bricolage Grotesque for headings, Instrument Sans for text, IBM Plex Mono for labels, states and tile marks, and a warm serif (Newsreader) only for article titles and the article preview on the personal site. The fonts are self-hosted by `next/font` at build time, so the browser contacts no font service. Spacing is one 4px scale, controls are 40px high (44px for primary actions), and cards pad 16 to 20px. The dark theme is a deep green, not blue and not plain grey.

**Publishing.** The page names the article (serif) with a "Change article" button. Left is "Where should it go?": one row of suggestions, category tabs with counts, and a plain list (tile, name, one fact, state, checkbox). Right is "How it will look": a tab per chosen platform, the checks as small pills ("1 to fix", "1 heads up", "See checks") so the preview comes first, and the preview. The sidebar shows the four steps (Post chosen, Pick platforms, Approve each, Share the links) as a rail that only shows the way. A floating preview window (forest title bar, drag or arrow keys, minimise, open large, close) is optional, and the footer has one chip per ready preview that opens it large. None of this changes approval: one destination at a time, bound to the exact text, never in bulk.

**Checks.** `test/design-tokens.test.ts` still computes contrast for every text pair and control boundary in both themes, now including the forest sidebar, the solid surfaces and the warm accent. Empty states keep solid borders (dashed is for real drop zones) and now carry a small branching line drawing from the logo.
