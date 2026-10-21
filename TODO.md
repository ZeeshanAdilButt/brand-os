# Engineering Brand OS (content-powerhouse)

Working name for the product that content-powerhouse grows into. Days are implementation days, not calendar promises. Never tick a task without validating it.

## Current Position
Phase: 1
Day: 4
Status: Not started (Day 3 complete)

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
- [ ] MCP server (profile, articles, drafts, search, AI tasks) on the shared action layer; extend the Phase 0 MCP
- [ ] AI provider interface: local model (Ollama/OpenAI-compatible), optional BYOK API; AI task inbox for Claude Code
- [ ] Editor assistance returning structured operations with diff approvals

Acceptance: Claude Code drives articles over MCP; UI AI works with a configured provider; app works with AI off.

### Day 5: Technical publishing connectors
- [ ] Adapter interface (auth, formats, drafts, scheduling, media, status, restrictions)
- [ ] DEV.to adapter (reuse Phase 0 route and approval gate); Hashnode if supported; connection state; canonical URLs and tags; provider IDs and URLs; errors and retries

Acceptance: at least one real publication created or published after explicit approval.

### Day 6: Publishing preview and workflow
- [ ] Composer: original (left), destination cards (middle), AI suggestions (right); per-destination preview, edit, diff, metadata
- [ ] Individual and approved batch publishing; retries; result links; personal-site adapter (Markdown or reviewable GitHub change, never silent)

Acceptance: several destinations from one source, each independently controlled.

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
- Public actions (publish, email, submit) need explicit per-action approval; the Phase 0 approval gate stays the only path.
- Private seed data never enters git, fixtures, docs or other tenants. No invented metrics or experience; achievements are owner claims needing review before publication.
- No fake UX: unfinished features are hidden or clearly disabled.
- No em dashes in code comments, UI copy, docs or commits. No Claude attribution in git.
- Daily loop: read TODO.md and CLAUDE.md, finish the current day, test, review security and UX, tick validated tasks, commit, report.

## Implementation notes
- Phase 0 (done, branch feat/phase-0): approval gate, dev.to and Buffer routes, dashboard, MCP, CLI. 994 tests. Day 5 reuses it.
