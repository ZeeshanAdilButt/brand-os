# Engineering Brand OS (content-powerhouse)

Working name for the product that content-powerhouse grows into. Days are implementation days, not calendar promises. Never tick a task without validating it.

## Current Position
Phase: 1
Day: 5
Status: Built and tested against fake servers (Day 4 complete). Waiting on the owner's live DEV.to check, the one acceptance step only the owner can do

## Phase 1: Technical Article Publishing

### Day 1: Foundation
- [x] Write ARCHITECTURE.md, DECISIONS.md, INTEGRATIONS.md, CLAUDE.md, .env.example
- [x] Verify current DEV.to, Hashnode, Medium and AI-auth facts (INTEGRATIONS.md)
- [x] Scaffold apps/web (Next.js, TypeScript, Tailwind, shadcn/ui) in the existing pnpm workspace
- [x] Database layer: Drizzle + embedded Postgres (local) / Postgres (hosted), migrations, health check
- [x] Design system tokens (site palette, dark and light) and the application shell with navigation
- [x] Local startup command, tests, document results

Acceptance: app starts locally with a real database and a polished shell; /api/health reports DB status; tests pass. **Met 2026-10-21.**

Day 1 results: `pnpm test` 1065 passed, 3 skipped (includes 71 web tests); `pnpm typecheck`, `pnpm build`, `pnpm web:build` and `pnpm web:lint` clean; `GET /api/health` returned `{"status":"ok","mode":"local","db":{"ok":true,"driver":"pglite",...}}` and every nav page returned 200 from `pnpm web:dev` (port 3100); shell checked at 1280px and 400px, light and dark. Not done on purpose: Playwright smoke (not cheap), real-Postgres run of the hosted driver (no Postgres or Docker engine available), see DECISIONS.md.

### Day 2: Accounts, privacy, personal knowledge
- [x] Authentication plus local-owner mode; tenant-aware data access (owner id on every row)
- [x] User profile and brand-preference models; knowledge items with source, date, confidence, confidentiality, public-use permission, last reviewed
- [x] Private, gitignored, idempotent owner-only seed bound to the owner's user id (never by display name)
- [x] General onboarding for other users; private full-text knowledge search
- [x] Tenant-isolation tests (A cannot read, modify, search or publish B's data)

Acceptance: the owner account holds the private context; a second account starts empty and cannot see it. **Met 2026-10-21.**

Day 2 results: `pnpm test` 1132 passed, 4 skipped (about 67 new web tests: auth, isolation through the data layer and every route handler, search ranking and highlighting, seed binding and idempotency, source rules, hygiene, local-mode API); `pnpm typecheck`, `pnpm build`, `pnpm web:build` and `pnpm web:lint` clean. Local mode, `next start` on a spare port: health ok, every page 200 with no login, cross-site and rebinding requests refused with 403. Checked at 1280px and 400px. Hosted sign-in is tested on in-memory Postgres with real sessions; a run against a real Postgres server is still outstanding (no server available), as on Day 1. Choices and trade-offs: DECISIONS.md 11 to 17. Not done on purpose: row level security (decision 13), email verification and password reset (no mail provider), account deletion (Day 27; the UI says so), resume upload, GitHub import and source connections (shown disabled with their planned day).

### Day 3: Article studio
- [x] Markdown editor; import from files, URLs and a content site; keep code, links, tables, diagrams
- [x] Metadata and assets; autosave and version history; draft states; reading and editing previews

Acceptance: import, edit, save, reopen and preview a real technical article with no AI. **Met 2026-10-21.**

Day 3 results: CodeMirror 6 editor (lazy loaded) with toolbar, shortcuts, image paste and drop, word count and reading time; one unified/remark/rehype pipeline for the live preview and the reading view (GFM, footnotes, highlighting for go, rust, python, sql, bash, yaml, json, typescript, Mermaid with a visible fallback, sanitizing that reports every removal as "N items were not rendered"); metadata panel with per-owner slug check; debounced autosave with a visible state, optimistic concurrency and a keep-mine or use-saved conflict dialog; version history with coalesced autosaves, line diff between any two versions and restore as a new version; assets behind a storage adapter with sniffed types, an SVG policy, sha256 dedupe and an authenticated tenant-checked route; file, URL (SSRF-checked on every hop) and local folder import. `pnpm test` 1362 passed, 6 skipped (about 230 new web tests: tenant isolation for articles, versions, assets, search and imports through the data layer and the routes; autosave and conflicts; coalescing, diff and restore; rendering; frontmatter variants; SSRF cases; asset limits and traversal; folder traversal and links; source rules); `pnpm typecheck`, `pnpm build`, `pnpm web:build` and `pnpm web:lint` clean. Real flow on `next start` with a temporary data folder: new article, long technical paste with code, a table and a Mermaid diagram, pasted image, autosave, Ctrl+S, history, diff, restore, a forced conflict, a real page import, reading view; checked at 1280px and 400px, light and dark. Choices and trade-offs: DECISIONS.md 18 to 23. Not done on purpose: math rendering, embeds (every iframe is removed and reported), an S3 storage adapter (the seam is documented), in-editor find and replace, copying imported images (they stay linked), a real Postgres run of the hosted driver (no server available, as on Days 1 and 2). Two file-link tests skip on machines where creating file links needs a privilege (Windows without developer mode); the directory-link tests run everywhere.

### Day 4: AI and Claude MCP
- [x] MCP server (profile, articles, search, AI tasks) on the shared action layer. It is a new package, `packages/brand-mcp` (server `brand-os`), not an extension of the Phase 0 server (DECISIONS.md 30); it has no platform-draft or approval tools, which arrive on Days 5 and 6
- [x] AI provider interface: local model (Ollama/OpenAI-compatible), optional BYOK API (Anthropic, OpenAI-compatible), Claude Code hand-off, reserved CLI agent slot; AI task inbox for Claude Code
- [x] Editor assistance returning structured operations with diff approvals

Acceptance: Claude Code drives articles over MCP; UI AI works with a configured provider; app works with AI off. **Met 2026-10-21** (with the caveats below).

Day 4 results: `pnpm test` 1574 passed, 6 skipped (about 210 new tests: agent keys and the agent API with hashing, scopes, revocation, rate limits and two-account isolation; provider key encryption, redaction and hosted address rules; adapters against injected fake fetch for Ollama-style, OpenAI-compatible and Anthropic shapes with success, malformed output, timeout, 4xx, 5xx and rate limits; result validation and stale detection; the privacy gate and per-task approval by hash; a prompt-injection fixture; caching, soft cap, cancel and retry; event delivery; the MCP tools over the SDK's in-memory transport and against the real routes; UI components in no-AI mode, stale, hand-off and review states; source rules for tenant tables and key handling); `pnpm typecheck`, `pnpm build`, `pnpm web:build` and `pnpm web:lint` clean. Real flow on `next start` (port 3411, temporary data folder, a local fake OpenAI-compatible server on port 4511): added a local provider and tested the connection, selected text, ran Improve, saw the word diff, accepted it, and found "AI change you accepted" in the history; added the Claude Code hand-off provider, asked with it (task showed as waiting with the copyable instruction), created an agent key in Settings > Agent access, ran the built `brand-os` server over stdio against the app (list tools, list tasks, read the task, a result outside the excerpt refused, a valid result submitted), and the studio showed it as ready to review without a reload. Checked at 1280px and 400px, light and dark; no horizontal overflow on the new settings pages. Choices and trade-offs: DECISIONS.md 24 to 31.

Not validated, on purpose or for lack of access: no real model was called (the flow used a local fake server, and the Anthropic and OpenAI-compatible adapters are tested against fake responses only; OpenAI's reference page could not be read, see INTEGRATIONS.md open risks 15 to 17); the MCP client in the real-flow run was the SDK's stdio client, not the Claude Code binary (`claude mcp add` is documented but was not run); the hosted driver against a real Postgres is still outstanding as on Days 1 to 3; the event bus and rate limiter are per process (multi-instance needs a shared store, Day 27); the local companion is documented, not built.

### Day 5: Technical publishing connectors
- [x] Adapter interface (auth, formats, drafts, scheduling, media, status, restrictions); capability data shown in the UI
- [x] Design: the Phase 0 invariants ported to Postgres for the web app, the daemon left as legacy (DECISIONS.md 32); reconciling or retiring the daemon is a Day 7 decision
- [x] Connections (Settings > Connections): encrypted keys, read-only probe, status and account, test, disconnect
- [x] DEV.to adapter: private draft, publish only inside `publish()`, canonical URL, sanitized tags with a visible report, status check, Retry-After in seconds and as a date
- [x] Hashnode adapter (GraphQL), verified from the official schema; marked live-unverified
- [x] Platform drafts with lint (errors block approval), source tracking and a payload hash
- [x] Approval flow: single use, 30 minutes, hash bound, session only, atomic with the move to publishing, no duplicates, unknown resolved by a check or by hand
- [x] Errors and retries: clean (failed) versus ambiguous (unknown), staging retries with capped backoff, publishing never
- [x] Minimal UI: Settings > Connections, the studio Publish panel with the approval card, the Publishing page
- [x] Agent API and brand-os MCP: create, list, get, stage privately, request approval, status; no approve, publish or hand-off (tested by route files, handlers and the tool list)
- [ ] **Pending the owner's live check:** add a DEV.to key in Settings > Connections, prepare a draft, stage a private draft, look at it in the DEV.to dashboard, and approve a publish if wanted (README, "Publish to DEV.to")

Acceptance: at least one real publication created or published after explicit approval. **Not met yet: pending the owner's live check.** Everything else is built and validated against fake servers; no real platform was called.

Day 5 results: `pnpm test`, `pnpm typecheck`, `pnpm build` and `pnpm web:lint` are green (see the commit message of the docs commit for the counts). Tests cover tenant isolation of connections, drafts, approvals, attempts and audit through the data layer, the routes and the agent API and MCP; single-use and expiring approvals; a changed payload or a changed article voiding an approval; exactly one remote call for concurrent approvals; duplicate prevention; unknown never retried or silently re-approvable; a late stage failure unable to flip a publishing or published draft; stage never touching a live article; agents unable to approve or publish by any route; keys encrypted at rest and never returned, logged or echoed; both adapters against fake fetch for success, 401, 422, 429 (seconds and date), 5xx, timeout and a refused redirect; tag sanitizing, canonical handling and lint (including local-asset images); source rules for the new tenant tables. Real flow: the built app on a spare port with a temporary data folder and a local fake DEV.to server (the address override needs an explicit test flag and a loopback address): connected the fake, prepared a draft from an article, saw a local-image lint error block staging, staged a private draft, requested approval, ticked the boxes (the button stayed off until all four), approved and published, saw the link, then edited an article after requesting approval and saw the approval void and the draft flagged. Checked at 1280px and 400px, light and dark; one horizontal overflow in the approval card was found and fixed.

Not validated, on purpose or for lack of access: no real DEV.to or Hashnode request was made, and the owner's live check is pending; Hashnode is built from the official schema only (INTEGRATIONS.md open risks 19 and 20); no real Postgres server run of the hosted driver (as on earlier days); the approval has no per-action presence check in the web app (DECISIONS.md 33).

### Day 6: Publishing preview and workflow
- [x] Composer: original, destination cards for all 13 destinations, suggestions; per-destination drawer with edit, approximate preview, diff against generated and against the article, reset, divergence
- [x] One Publishing screen: article picker, platform selector (category tabs, search, recommended chips), live previews per platform, quick edit, side by side comparison, one "Review and approve" button
- [x] Approval as a one-at-a-time queue ("Approve and next"); no bulk approval anywhere (route, queue reducer, keyboard, command palette, MCP)
- [x] Retries, history and result links per destination; unknown results resolved by a read-only check or by hand
- [x] Personal-site destination: Markdown export presets, GitHub pull request adapter with safeguards (own branch, one file, never the base branch, never a merge, no overwrite without a matching blob sha)
- [x] Canonical page check (SSRF-safe, read-only) with a required extra box when the page is not live
- [x] Manual handoff for every platform, with link validation and a manual approval that cannot be spent as a publish
- [x] Platform directory (every roadmap platform), Integrations, saved values for platforms not built yet (encrypted, never read back)
- [x] AI: adapt for a platform, editor's review, title suggestions; validated, shown as a diff, never applied on their own
- [x] Agent API and MCP: list destinations, update a draft, read a preview; still no approve or publish
- [x] Design system v2 (Warm Editorial), Home with one next step, command palette
- [ ] **Pending the owner's live checks:** DEV.to, Hashnode and a GitHub pull request on a real repository (nothing in this day called a real platform)

Acceptance: several destinations from one source, each independently controlled. Met against local fake servers.

### Day 7: Phase 1 hardening
- [ ] End-to-end publishing tests; authorization and tenant isolation; failed and retried publishes; no duplicates; canonical attribution
- [ ] Local Claude MCP workflows; no-AI mode; imports and rendering; backup and export docs; loading, empty and error states

Exit: run locally, see the private profile, import or write an article, use Claude over MCP, optionally AI in the UI, preview per destination, publish through a real integration, see real URLs and statuses.

## Phase 2: Ten-channel distribution (Days 8-12)
Channels: LinkedIn, X, Bluesky, Threads, DEV.to, Hashnode, Medium, Reddit, Hacker News, YouTube. The personal site stays canonical.
- [ ] Day 8: capability matrix, Postiz vs direct APIs, optional Postiz adapter, per-channel formats and validation
- [ ] Day 9: LinkedIn, X, Bluesky, Threads variants, previews, strategy, manual or API flows
- [ ] Day 10: Reddit rules research, Hacker News preparation, audience matching, human-reviewed submissions, no blanket cross-posting
- [ ] Day 11: unified drafts, scheduling, approval queue, status tracking, retries, calendar, campaign history
- [ ] Day 12: validate every integration, idempotency and reconciliation, no accidental cross-posting

Exit: one article yields suitable, independently controlled drafts across ten destinations, published through supported routes.

## Phase 3: Top technical publications (Days 13-16)
- [ ] Day 13: opportunity directory (InfoQ, CNCF, DZone, freeCodeCamp, LF publications, newsletters); verify real contribution policies, requirements, exclusivity
- [ ] Day 14: AI matching with reasons, required improvements, personalized pitches, kept sources
- [ ] Day 15: pitch emails, authorized submission, browser-assisted where permitted, response and follow-up tracking
- [ ] Day 16: kanban board, pitch history, reminders, acceptance insights, polish

Exit: pick an article, find credible publications, manage a real submission.

## Phase 4: Speaking (Days 17-20)
- [ ] Day 17: CFP discovery with verified dates, location, format, eligibility, travel support, remote options
- [ ] Day 18: proposal studio (ideas, abstracts, objectives, outlines, bios, 20/30/45 minute versions)
- [ ] Day 19: submission tracking, Sessionize and other flows, tailored content, approval, results
- [ ] Day 20: talks dashboard linked to articles and projects, presentation outlines, validation

Exit: find a real CFP, prepare a serious proposal, submit it, track it.

## Phase 5: Video and motion graphics (Days 21-24)
- [ ] Day 21: recording upload, timestamped transcripts, chapters, timelines, clip candidates
- [ ] Day 22: reusable motion templates (Remotion, SVG, FFmpeg, optionally Manim) for scheduling, queues, replication, network, transactions, Linux memory, performance comparisons, built from real source material
- [ ] Day 23: scene lists and timelines, captions, chapters, vertical and horizontal, GIF and MP4, thumbnails, approval
- [ ] Day 24: link media to campaigns, YouTube metadata, short clips, platform previews, export and publish tests

Exit: a recording becomes an edited technical video with approved animations and distribution assets.

## Phase 6: Series, intelligence, SaaS production (Days 25-28)
- [ ] Day 25: Technical Series Studio (objectives, progression, sources, dependencies, articles, videos, talks, status)
- [ ] Day 26: knowledge graph (experience to topics to projects to articles to videos to talks to outcomes) with evidence-based recommendations, not trending keywords
- [ ] Day 27: multi-user security review, authorization tests, onboarding, connection management, export and deletion, hosting, backup, local vs cloud parity, cost review
- [ ] Day 28: end-to-end regression, profiling, accessibility, polish, observability, docs, self-hosting and SaaS deployment, architecture review, honest capability report

Exit: locally usable and SaaS-deployable, optional AI, isolated user data.

## Phase 7: Software and product distribution (after Phase 6)
Announce tools, libraries and releases, not only articles. Same approval gate, same per-destination previews.
- [ ] Verify each platform's real rules and APIs first (GitHub releases, Show HN, Product Hunt, package registry pages, developer newsletters); record in INTEGRATIONS.md
- [ ] Release-notes composer: changelog and README become a launch post, release notes, a short demo script and a thumbnail brief
- [ ] Launch checklist and calendar per release; link demo videos from Phase 5
- [ ] Outcome tracking (stars, installs, referrals) kept separate from estimates

## Phase 8: Local CLI agent for wording (after the Day 4 provider work)
Use the owner's own local coding agent CLI (for example Codex) to improve wording, as one more AI provider next to local models, bring-your-own-key and Claude Code over MCP.
- [ ] Provider kind "local CLI agent": runs a configured command on the owner's machine, non-interactively, on selected text only
- [ ] Output is a reviewable diff, never auto-applied and never auto-published; no secrets are passed to it
- [ ] Reserve the seam in the Day 4 provider interface; build the adapter once the interface is stable

## Standing rules
- Vertical slices. Finish one real workflow before starting ten.
- Public actions (publish, email, submit) need explicit per-action approval; every publish goes through an approval gate (the Phase 0 daemon, or the web app's approval model).
- Private seed data never enters git, fixtures, docs or other tenants. No invented metrics or experience; achievements are owner claims needing review before publication.
- No fake UX: unfinished features are hidden or clearly disabled.
- No em dashes in code comments, UI copy, docs or commits. No Claude attribution in git.
- Daily loop: read TODO.md and CLAUDE.md, finish the current day, test, review security and UX, tick validated tasks, commit, report.

## Implementation notes
- Phase 0 (done, branch feat/phase-0): approval gate, dev.to and Buffer routes, dashboard, MCP, CLI. 994 tests. Day 5 ported its invariants to the web app instead of calling it (DECISIONS.md 32); it stays as the legacy path until Day 7.
