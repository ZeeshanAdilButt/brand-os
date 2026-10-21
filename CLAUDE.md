# Brand OS: instructions for coding agents

Read in this order: `README.md` (what the product is), `TODO.md` (roadmap and the current day), `ARCHITECTURE.md`, `DECISIONS.md`, `INTEGRATIONS.md` (verified platform capabilities). Older design notes are in `docs/superpowers/` and `docs/research/`.

## Daily loop

1. Read `TODO.md` and this file; find the current unfinished day.
2. Finish that day's tasks only. Do not start later phases.
3. Run the relevant tests; review the change for security, quality and UX.
4. Tick only tasks you validated; add implementation notes.
5. Commit a coherent, working change in small logical commits.
6. Report what works, what remains and any blockers.

## Hard rules

- **Public actions need explicit approval.** Never publish, post, schedule or send anything to a real platform without the user's approval of that exact action. Drafts and dry runs are fine. One approval covers one action; there is no "approve all". The approval gate in `packages/daemon` is the only path to a publish.
- **Tenant isolation.** Every tenant row carries an owner id taken only from the authenticated session, never from request input or an agent argument. All tenant queries go through `forOwner(ownerId)` in `apps/web/src/server/data`.
- **No secrets or personal data in git.** The repo is public. Keys, tokens, `.env` files, local databases and private seed data stay out of it. Private knowledge lives in the database; the one-time import file `apps/web/seed/owner.private.json` is gitignored. Tests use synthetic data only. Before every push, scan the diff for key-shaped strings; never put provider-shaped token literals in tests.
- **Generic voice.** No personal names, personal domains or employer details in tracked files; use the placeholder domain `example-blog.dev` and "the owner" or "you".
- **No fake UX.** Unfinished features are hidden or shown as clearly disabled. No simulated success, analytics or integrations.
- **External sites are read-only.** The tool reads a configured content site and never writes to it.
- **Style.** No em dashes in code comments, UI copy, docs or commit messages. Plain, specific writing; no invented metrics.
- Changes to the user's own machine configuration (editor or agent settings, scheduled tasks) need explicit go-ahead after showing the exact change.

## Where things are

- `apps/web`: the Next.js app (UI, API routes, data layer, auth). Local mode uses embedded Postgres in `DATA_DIR`; hosted mode uses `DATABASE_URL`.
- `packages/core`: pure parsing, lint and platform transforms (no I/O).
- `packages/daemon`: the publishing engine (approval gate, routes, local dashboard, API).
- `packages/mcp`, `packages/client`, `packages/cli`: MCP server, daemon client, the `cph` command and installer.
- `packages/brand-mcp`: the `brand-os` MCP server (articles, knowledge, AI tasks) over the web app's agent API (`/api/agent/*`, bearer key). It has no publishing, platform draft or approval tools. See `docs/brand-os-mcp.md`.
- `spikes/`: throwaway experiments with written findings.

## Commands

```bash
pnpm install
pnpm test            # whole workspace
pnpm typecheck
pnpm build
pnpm web:lint
pnpm web:dev         # web app on http://localhost:3100
pnpm setup:local     # install, migrate, print how to start
pnpm seed:owner      # one-time import of the private owner file (owner account only)
```
