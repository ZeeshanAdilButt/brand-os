# content-powerhouse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to carry out this plan one task at a time. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, Claude-driven tool that reads posts from example-blog.dev (read-only) and turns each one into native drafts for every platform. Nothing goes public without a server-enforced, Windows Hello-verified approval for each action. Phase 0 ships one slice: an MDX post becomes a dev.to **draft** plus a LinkedIn post draft, and both are reachable over MCP (Claude Code at user scope and Claude Desktop) and the CLI.

**Revision 2 (2026-10-19):** review findings applied. The main changes: Windows Hello moved into Phase 0 and made mandatory; "kill switch" renamed to `publishing_enabled`; Buffer health metered with an API budget; LinkedIn link card sent through `linkAttachment` (or dropped); X defaults to a single post; R2 deferred to Phase 2; remote scheduled posts cancelled on invalidation; Approve & publish in the dashboard; user-scope Claude registration in Phase 0. See "Self-review notes" at the end.

**Architecture:** One always-on daemon on `127.0.0.1:4646` (Node, Hono, SQLite) owns state, secrets, the approval gate, routes and an htmx dashboard. A thin stdio MCP server (`cph-mcp`) and a CLI (`cph`) call the daemon over loopback HTTP with scoped tokens. All parsing and transforms live in a pure `core` package with no I/O.

**Tech stack** (exact versions confirmed with `npm view` on 2026-10-19):
- Node ≥22, tested on 22.22.2, the user's version; Node 24 LTS is preferred.
- pnpm 10.24
- TypeScript **5.9.3** (`npm view typescript@5 version`, 2026-10-19). One compiler both checks and emits: `pnpm build` runs `tsc -b` (project references, output to each package's `dist/`), and `pnpm typecheck` runs the same build. TypeScript 7.x is not used
- vitest 5.0.5, tsx 4.23.15
- hono 4.13.13 + @hono/node-server 2.1.5
- better-sqlite3 13.0.3
- @napi-rs/keyring 2.1.2
- zod 4.6.7 (MCP SDK peer `^3.25 || ^4.0`)
- @modelcontextprotocol/sdk 1.32.1 (v2 `@modelcontextprotocol/server` 2.3.1 is only a spike)
- gray-matter 4.0.3; unified 11.0.5 + remark-parse 11.0.0 + remark-mdx 3.1.1 + remark-gfm + remark-stringify
- canonicalize 5.1.0 (RFC 8785)
- commander 15.0.0
- clipboardy 5.3.2, open 11.0.4
- htmx.org 2.0.11, vendored as a static file with no CDN
- node-notifier 11.0.0 (Phase 0: toasts for held, unknown and cancelled-remote states)
- Phase 1 and later: croner 10.0.1, @resvg/resvg-js 2.6.2, playwright 1.64.1, @atproto/api 0.28.0
- Phase 2: remotion and @remotion/captions 4.0.536; @aws-sdk/client-s3 + s3-request-presigner 3.1152.0 (only if R2 is needed)
- Windows Hello: no npm dependency. Windows PowerShell 5.1 (`powershell.exe`) calls WinRT `UserConsentVerifier` (T0.0 spike)

**Spec:** `docs/superpowers/specs/2026-10-19-content-powerhouse-design.md`. Executors read both documents. The section numbers in this plan (§2.6 and so on) point into the spec.

---

## Global Constraints

- **The hard rule: nothing reaches a public surface without a single-use, unexpired approval whose `payload_sha256` equals the draft's current hash.** Only a human-presence channel can create that approval: a dashboard click **verified by Windows Hello** (or, if the T0.0 spike fails, an MCP elicitation answered in the Claude Code TUI). A dashboard click alone is not enough, because Claude on this machine can drive the browser and the desktop. No "approve all". `publishing_enabled` defaults to `false`, and turning it on also needs Hello. The words "kill switch" appear nowhere in code or UI.
- **What you approve is what is sent.** A route may not drop any hashed payload field. Each route has a contract test that sets every payload field and asserts each one reaches the wire.
- The site repo `C:\path\to\your-site` is **read-only**. Only `SiteReader` holds its path. git may run only `rev-parse`, `status --porcelain`, `log -1`, always as `git --no-optional-locks -C <repo> …` with env `GIT_OPTIONAL_LOCKS=0`.
- The canonical URL is `https://www.example-blog.dev/blog/<slug>`, never with UTM. UTM goes only on links in social posts: `?utm_source=<platform>&utm_medium=social&utm_campaign=<slug>`.
- Secrets never pass through MCP, tool results, logs, `.env` or the repo. They are entered only in the dashboard (or by a `cph connect` prompt). The master key sits in Windows Credential Manager (`service=content-powerhouse`, `account=master-key`). Tokens are stored AES-256-GCM encrypted in SQLite.
- Approval TTL: 30 min for publish-now; for scheduled posts, until fire time + 15 min.
- Private stages hard-set the private field, and each one gets a unit test:
  - dev.to `published:false`;
  - Buffer `saveToDraft:true`;
  - YouTube `privacyStatus:'private'`.
- Forbidden in code: Hashnode `publishPost`, Substack importer calls, any browser automation of third-party platforms. Buffer `mode: shareNow` and dev.to `published: true` may appear **only** inside the `publish()` function of their route. Buffer `addToQueue` may appear only next to `saveToDraft: true`, and every Buffer stage asserts the response `post.status === 'draft'`.
- Stages never touch live content: dev.to re-stage reads the article first and refuses if it is published.
- Platform-side scheduled posts (Buffer `customScheduled`, later YouTube `publishAt`) store `remote_scheduled_id` and are cancelled when the draft is edited, cancelled or becomes `source_changed`.
- Buffer Free API budget (100/15 min, 250/24 h, 3,000/30 d): Buffer health is a **metered** probe (once a day + right before each publish, one `channels()` call with the cached org id). Non-publish Buffer calls are refused when less than 20% of the 24 h or 30 d budget remains.
- **Tests never touch the network.** Every outbound client takes an injected `fetch`. A vitest setup file replaces `globalThis.fetch` with one that throws `NetworkBlockedError`. CI never holds real keys.
- Windows paths contain spaces. Every child process uses `execFile`/`spawn` with an argument array, never a shell string.
- State dir: `%LOCALAPPDATA%\content-powerhouse\`, holding `cph.db`, `config.json`, `logs\`, `video\`. Port: 4646. OAuth loopback port (phase 1 and later): 53682.
- `core` has no I/O: no `fs`, `fetch`, `child_process` or `Date.now()`. The current time is passed in as `now: Date`.
- Full-text copies (dev.to, Hashnode, Medium) use `authorship: 'reformatted'` and Claude never rewrites them. Lint rejects any number in an adaptation that does not appear in the source.
- Commits are authored by the owner only, with no Claude attribution anywhere (no `Co-Authored-By` trailer, no "Generated with" line, in commits, PRs or anything GitHub-visible). Commit in small logical steps. Work happens on a branch (`feat/phase-0`, and so on), never on `main`. The repo is public at github.com/ZeeshanAdilButt/brand-os; `main` holds the docs.

## Review Focus

The five failure modes most likely to hurt the user that no single happy-path test covers. Each line names the task that owns the pinning test.

1. **The post or draft changes after approval.** The user edits the MDX or the draft text after clicking Approve. `publish` must refuse with `HASH_MISMATCH` or `SOURCE_CHANGED`, never post the old or the new text. Pinned in T0.13 and T0.12.
2. **Two publishes race on one approval.** A double-click, or Claude retrying after a timeout, calls `publish` twice. Exactly one remote call may happen. Consumption is an atomic `UPDATE … WHERE used_at IS NULL` in the same transaction that records "in flight". Pinned in T0.13 and T0.17.
3. **The canonical page "looks live" but isn't.** Possible causes:
   - Vercel has not deployed yet;
   - a soft-404 page returns 200;
   - an apex↔www redirect happens;
   - frontmatter says `published: false`.

   The live check must require a final URL on `www.example-blog.dev`, status 200, the exact frontmatter title in the HTML, and `published: true`. Pinned in T0.12.
4. **A platform error that doesn't look like one.** Buffer returns HTTP 200 with a `MutationError`. dev.to returns 422 or 429 with `Retry-After` as either seconds or an HTTP-date. These must give a `failed` status with the message, and a publish must never be retried automatically (only stages may retry). Pinned in T0.14 and T0.15.
5. **Windows realities:**
   - CRLF line endings in MDX and notes;
   - BOM at file start;
   - repo path with spaces;
   - posts with **no** notes file (11 of 15 today);
   - emoji or `ρ` in text, where length is counted in graphemes, not UTF-16 units.

   The parsers and lint must handle all of these. Pinned in T0.2, T0.3, T0.6 and T0.11.
6. **The model approves its own post.** Claude has claude-in-chrome and computer-use on this machine, so it can open the dashboard and click Approve. The Approve handler must not record an approval unless Windows Hello returned `Verified` in the daemon's own process. Pinned in T0.13b and T0.19.
7. **What was approved is not what was sent.** A route sends fewer fields than the hash covers (for example the LinkedIn link card), or a platform scheduler fires an old version after the source changed. Pinned in T0.15 (contract test) and T1.7 (remote cancel).
8. **A private stage goes public.** Buffer `addToQueue` without a working `saveToDraft`, or a dev.to re-stage on an article that is already live. Pinned in T0.14 and T0.15.
9. **The Buffer API budget runs out.** Frequent health probes use up 250/24 h and 3,000/30 d, and then publishing fails with 429s. Pinned in T0.15 (30-day simulation).

**Residual risk to flag to the user (not closable by this design):**
- Claude's Bash or PowerShell runs as the same Windows user. It can read `api-token:cli` and the master key from Credential Manager, decrypt the Buffer or dev.to key, and call the platform directly, bypassing the daemon and the gate entirely. Hello protects the approval, not the keys.
- Mitigations: the user-scope `cph-guard` PreToolUse hook (blocks claude-in-chrome on `127.0.0.1:4646`/`localhost:4646` and shell commands that reference the content-powerhouse keyring entries; T0.21), Claude Code's per-command permission prompts, MCP tokens scoped so they can never approve or change settings (T0.18), and the login nonce never printed or returned (T0.20, T0.21).
- These rules live in **user-scope** `~/.claude/settings.json`, because project rules in `content-powerhouse\.claude\settings.json` load only when Claude runs in that directory, and the owner often works elsewhere (for example `D:\Projects - Community`).
- Never run Claude in a permission-bypass mode while platforms are connected. This goes into the spec's R1 row and the install output.

---

## Verified facts this plan depends on (checked 2026-10-19)

| Fact | Status | Source |
|---|---|---|
| Buffer API is GraphQL at `https://api.buffer.com`; key created at `https://publish.buffer.com/settings/api` | Verified | [Buffer auth guide](https://developers.buffer.com/guides/authentication.md) |
| Buffer `createPost(input:{channelId, text, schedulingType: automatic\|notification, mode, dueAt?, saveToDraft?, assets?, metadata?})`. The response union is `PostActionSuccess{post{id status}}` or `MutationError{message}`. Errors arrive as unions, not HTTP codes | Verified | [first post](https://developers.buffer.com/guides/your-first-post.md), [draft example](https://developers.buffer.com/examples/create-draft-post.md), [posts guide](https://developers.buffer.com/guides/posts-and-scheduling.md) |
| `mode` values `addToQueue` (the default; next queue slot), `shareNow`, `shareNext`, `customScheduled` (+`dueAt` ISO UTC) | Verified in Buffer's MCP guide. `shareNow` is **not** in the GraphQL guides, so Spike S2 confirms it with `introspect` | [Buffer MCP guide](https://developers.buffer.com/guides/integrations/mcp.html) |
| LinkedIn link card: `metadata.<service>.linkAttachment`; it "cannot be sent alongside a non-empty `assets` array". Exact input fields (title, description, thumbnail) UNVERIFIED until S2(e) introspects them | Verified (field exists) | [Buffer MCP guide](https://developers.buffer.com/guides/integrations/mcp.html) |
| Threads: `metadata.<service>.thread`; the top-level `text` repeats the first item and the thread array holds every post | Verified | [Buffer MCP guide](https://developers.buffer.com/guides/integrations/mcp.html) |
| `delete_post` takes a `postId`; check that `deletePost` is in the post's `allowedActions` first. The GraphQL mutation name is confirmed in S2(h) | Verified (MCP tool) | [Buffer MCP guide](https://developers.buffer.com/guides/integrations/mcp.html) |
| Buffer media: `assets:[{image:{url}}]`, one of `image`/`video`/`document` per entry; the URL **must be publicly reachable**. Whether a native upload mutation exists is UNVERIFIED (S2(a)) | Verified (image). Video/document shape UNVERIFIED | [image post example](https://developers.buffer.com/examples/create-image-post.md) |
| Channels: `account{organizations{id name}}`, then `channels(input:{organizationId}){id name service}` | Verified | [first post](https://developers.buffer.com/guides/your-first-post.md) |
| Buffer Free: 3 channels, 10 scheduled posts per channel, **1 API key; API 100 per 15 min, 250 per 24 h, 3,000 per 30 days**; "Threaded posts: 1". Essentials $5/channel/mo (3 keys, 7,500 per 30 d). Team $10/channel/mo. A Claude integration ("Manage your Buffer queue and draft posts from Claude") is included on all plans | Verified on the pricing page (re-checked 2026-10-19). The annual figure ($60/yr/channel, "save 2 months") should be confirmed before buying | [buffer.com/pricing](https://buffer.com/pricing) |
| Buffer Free thread limit: one **scheduled** thread at a time per queue; unscheduled drafts are unlimited (Bluesky help page). The same limit for X, and whether publish-now threads count, is UNVERIFIED (S2(f)) | Partially verified | [Buffer help: Bluesky](https://support.buffer.com/article/855-using-bluesky-with-buffer) |
| dev.to: `api-key` header; `POST /api/articles {article:{title, body_markdown, published(default false), series, main_image, canonical_url, description, tags(≤4)}}`; `PUT /api/articles/{id}`; `GET /api/users/me`; `GET /api/articles/me/unpublished`. Rate limits not documented | Verified | [Forem API v1](https://developers.forem.com/api/v1) |
| Cloudflare R2 free tier: 10 GB-month, 1M Class A, 10M Class B, free egress. Beyond that $0.015/GB-mo, $4.50/M Class A, $0.36/M Class B | **Verified on the official page** | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Cloudflare asks for a payment method (card or PayPal) before the first R2 bucket; no charge within the free tier | Third-party only, UNVERIFIED officially | [tech-insider guide](https://tech-insider.org/au/how-to-set-up-cloudflare-r2-2026/), [eastondev](https://eastondev.com/blog/en/posts/dev/20251130-r2-picgo-setup/) |
| Hashnode Pro $5/mo or $50/yr; GraphQL API access is a Pro feature | Verified | [hashnode.com/pro](https://hashnode.com/pro) |
| ElevenLabs Starter $6 (30k credits), Creator $22 (50% off the first month, so $11; 121k credits/mo), Pro $99 (600k). "All products draw from one shared monthly credit pool"; TTS is 1 credit per character for Multilingual v2. Creator includes a Professional Voice Clone and a commercial licence. The Free plan has no commercial licence | Verified on the pricing page (re-checked 2026-10-19) | [elevenlabs.io/pricing](https://elevenlabs.io/pricing) |
| ElevenLabs API page: Creator includes 275k v4 characters; $0.08/1K (v4, v2), $0.04/1K (Flash) pay-as-you-go; "API usage is billed in US dollars, not credits". **Whether the 275k API characters are separate from the 121k credits is UNVERIFIED** and is resolved in U2-A before subscribing | Conflicting sources | [elevenlabs.io/pricing/api](https://elevenlabs.io/pricing/api) |
| X API: $0.015 per post, $0.20 per post with a URL. Credits are **prepaid**. The $20 bonus needs a saved card **and** a first credit purchase. No stated minimum purchase (UNVERIFIED). Per-cycle spend cap; auto-recharge optional | Verified (re-checked 2026-10-19) | [X pricing](https://docs.x.com/x-api/getting-started/pricing) |
| The canonical `https://www.example-blog.dev/blog/prometheus-cardinality-explained` loads and contains the title | Verified | live fetch |
| Site HEAD `48ea40cf…` (2026-10-10). Fixture post: 6 tags, 3 Callouts, 2 GFM tables, `import Callout`. Its notes file has 2 "Verify before publishing" items | Verified (read-only) | local clone |

---

## File structure (locked here; tasks refer to these paths)

```
content-powerhouse/
  package.json  pnpm-workspace.yaml  tsconfig.base.json  vitest.config.ts  .gitignore  .nvmrc
  .claude/settings.json                       # project-scope permissions.ask (T0.1); applies only inside this repo
  .github/workflows/ci.yml                    # windows-latest, checkout into a path with spaces
  test/setup/no-network.ts                    # global fetch guard
  test/source-rules.test.ts                   # forbidden-call scanner (T0.1, extended in T0.14/T0.15)
  packages/core/src/
    ids.ts            # PlatformId, RouteKind, DraftKind, DraftStatus, Authorship
    model.ts          # Frontmatter, ContentItem, PublishingPackage, Draft<P>, LintResult
    urls.ts           # canonicalUrlFor, coverPngUrl, absolutize, withUtm
    frontmatter.ts    # parsePost
    notes.ts          # parsePublishingNotes
    portable-doc.ts   # PortableDoc node types
    lower-mdx.ts      # lowerMdx
    hash.ts           # payloadHash
    lint/text.ts      # graphemeLength, countLinks
    lint/numbers.ts   # extractNumbers, findUnsourcedNumbers
    transforms/types.ts  transforms/devto.ts  transforms/linkedin.ts  transforms/registry.ts
    content-item.ts   # buildContentItem
    index.ts
  packages/core/test/fixtures/  sample-post.mdx  sample-notes.md  crlf-bom-post.mdx  unknown-jsx.mdx
  packages/daemon/src/
    paths.ts  config.ts
    site/site-reader.ts  site/guarded-fs.ts  site/git.ts
    live-check.ts  sync.ts
    db/open.ts  db/migrations/001_init.sql  db/repos.ts
    secrets/keystore.ts  secrets/secret-store.ts  secrets/redact.ts
    gate/errors.ts  gate/verified.ts  gate/approval-gate.ts  gate/prechecks.ts  gate/presence.ts  gate/elicitation.ts (fallback only)
    routes/types.ts  routes/devto.ts  routes/buffer-client.ts  routes/buffer.ts  routes/assist-linkedin.ts  routes/registry.ts
    services/drafts.ts  services/publish.ts  services/connections.ts  services/api-budget.ts  services/recovery.ts  audit.ts  notify.ts
    t0.ts             # launch reference time rule (spec 2.3)
    http/app.ts  http/auth.ts  http/api.ts  http/dashboard.ts  http/views/*.ts  http/static/htmx.min.js
    main.ts
  packages/client/src/daemon-client.ts        # typed HTTP client shared by mcp + cli
  packages/mcp/src/index.ts  tools.ts  prompts.ts  resources.ts
  packages/cli/src/index.ts  commands/{status,connect,sync,doctor,install,dashboard,drafts,log,daemon,check}.ts
  packages/cli/src/install/{claude-code.ts,claude-desktop.ts,user-settings.ts,task-scheduler.ts}
  packages/cli/hooks/cph-guard.mjs            # user-scope PreToolUse hook (T0.21)
  spikes/  S0-hello/  S1-mcp-v2/  S2-buffer/  S3-devto-svg/   # throwaway; each has a README with findings
```

---

# Phase 0: Connect + first working slice

**Goal:** For the existing published post `prometheus-cardinality-explained`:
- `sync` reads it read-only and checks it is live;
- a **dev.to draft** (`published:false`, correct `canonical_url`) is created through MCP or the CLI;
- Claude writes a **LinkedIn post draft**, which appears in the dashboard for review.

Both destinations connect from the dashboard in under 2 minutes each, and "connect dev.to" works as one click from chat. The approval gate is enforced by the server, needs Windows Hello, and is proven by tests.

**Exit criteria (things the user can see):**
1. `cph status` shows `dev.to ● connected as @<username>` and `linkedin (buffer) ● connected: The owner`. Medium and Substack show as blue `manual`.
2. Claude Code started in **any** directory (for example `D:\Projects - Community`) and Claude Desktop both list the `content-powerhouse` tools.
3. In Claude Code: "Prepare prometheus-cardinality-explained for dev.to and LinkedIn" leaves:
   - an unpublished article in dev.to's dashboard (Dashboard → Drafts) with the canonical set, the cover image and 4 tags;
   - a LinkedIn draft card in `http://127.0.0.1:4646/drafts`.
4. `request_approval` returns a dashboard link, the polling instruction and **no token**. The Approve buttons stay disabled until both "Verify before publishing" boxes are ticked. The approval card shows the LinkedIn post exactly as Buffer will receive it (text plus link card, or text plus "Preview will be generated by LinkedIn from the page's OG tags").
5. Publish is refused with a clear reason, and the audit log shows the refusal, when any of these holds:
   - **Publishing: DISABLED** (`publishing_enabled=false`), even with a valid approval;
   - the draft was edited after approval;
   - Windows Hello was cancelled or failed on Approve.
6. Optional, and **only with the owner's explicit OK in chat for that specific post** (Q4; the default is dry-run only): one LinkedIn post goes out via Buffer `shareNow` after one Hello-verified **Approve & publish** click, and the post id and URL appear in `cph log`.
7. `pnpm test` is green on Windows and in CI (on a checkout path with spaces). No test makes a network call.

**Phase 0 cost: $0/month.**
- dev.to API is free.
- Buffer Free is $0: 3 channels (only LinkedIn used now), 1 API key, API 100 per 15 min / 250 per 24 h / 3,000 per 30 days, 10 scheduled posts per channel ([buffer.com/pricing](https://buffer.com/pricing)). The metered health probe keeps idle usage around 30–60 calls a month.
- Windows Hello: built into Windows, $0.
- All npm dependencies are free/OSS.
- Nothing is paid.

### USER ACTIONS for Phase 0 (collected; each is referenced by the task that needs it)

| ID | What | Exact steps | Cost | Needed by |
|---|---|---|---|---|
| **U0-A** | dev.to API key | 1) Sign in at dev.to. 2) Open `https://dev.to/settings/extensions`. 3) Scroll to "DEV Community API Keys". 4) Description `content-powerhouse` → **Generate API Key**. 5) Paste it **only** into the dashboard's Connect dev.to card (`http://127.0.0.1:4646/connections/devto`), never into chat | $0 | T0.14 manual check, T0.23 |
| **U0-B** | Buffer account + LinkedIn channel + API key | 1) Sign up at `https://buffer.com` on the **Free** plan (no card). 2) Buffer → *Connect channel* → **LinkedIn → personal profile** → approve LinkedIn's OAuth screen. (X and YouTube can wait until Phases 1 and 2; Free allows 3 channels.) 3) Open `https://publish.buffer.com/settings/api` → create an API key named `content-powerhouse` (Free allows **1** key). 4) Paste it into `http://127.0.0.1:4646/connections/buffer`, then pick the LinkedIn channel in the mapping dropdown. 5) **Never** add Buffer's own MCP to Claude, and **do not enable Buffer's Claude integration/connector in claude.ai**. It is included on all plans and would let Claude post to Buffer outside the gate. If it is already enabled, disconnect it (spec §2.6 rule 9) | $0 | T0.15 manual check, T0.23 |
| **U0-C** | Approve the local install side effects | `cph install` lists each side effect and asks before doing it:<br>(a) a Windows Task Scheduler entry "content-powerhouse daemon" (at logon) and Credential Manager entries `content-powerhouse/master-key`, `api-token:mcp`, `api-token:cli`;<br>(b) the global `cph` link (`pnpm link --global`, run in `packages/cli`), now **required**, because the sign-in fallback tells you to run `cph dashboard`;<br>(c) `claude mcp add --scope user content-powerhouse -- node "<repo>\packages\mcp\dist\index.js"` (user scope, so the tools work from every directory);<br>(d) a merge into Claude Desktop's `%APPDATA%\Claude\claude_desktop_config.json` (backed up first), then restart Claude Desktop;<br>(e) a merge into **user-scope** `~/.claude/settings.json` (backed up first): `permissions.ask` on `mcp__content-powerhouse__publish` and `__schedule`, and the `cph-guard` PreToolUse hook | $0 | T0.21 |
| **U0-D** | Answer open questions Q1, Q2, Q3 and Q4 (spec §9.3) | Q1: what counts as explicit confirmation (default: one Hello-verified Approve & publish click per action). Q2: Windows Hello on every Approve (default yes). Q3: is Buffer OK to hold the LinkedIn, X and YouTube OAuth? (default yes). Q4: a live LinkedIn test in Phase 0, or dry-run only? (default dry-run only) | — | before T0.13b and T0.15 are merged |
| **U0-E** | Set up Windows Hello, if it is not already on | Settings → Accounts → Sign-in options → set up a PIN, and face or fingerprint if the hardware supports it. Prefer face or fingerprint for approvals, and never type the PIN where Claude can read it | $0 | T0.0 |
| **U0-F** | Explicit OK for one live LinkedIn post (optional exit criterion 6; only if Q4 = live test) | The owner says in chat, for that exact draft: "yes, post it". Then Dashboard → Settings → set **Publishing: ENABLED** (Hello), tick the checklist, click **Approve & publish** (Hello). Afterwards set Publishing back to DISABLED | $0 | T0.23 step 3 |

---

### Task T0.0: Windows Hello spike (1 hour, before anything else)

**Files:** `spikes/S0-hello/README.md`, `spikes/S0-hello/verify.ps1`. Nothing in `packages/` depends on `spikes/`.

**Why first:** the whole approval design depends on it (spec §2.6 rule 2). If it fails, Phase 0 switches to the elicitation fallback in T0.13b before any gate code is written.

- [ ] **Step 1 (after U0-E):** Write `verify.ps1` for **Windows PowerShell 5.1** (`powershell.exe`, not `pwsh`). It loads `[Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType=WindowsRuntime]`, calls `CheckAvailabilityAsync()`, then `RequestVerificationAsync('content-powerhouse test')`, awaits the WinRT `IAsyncOperation` (through `System.WindowsRuntimeSystemExtensions.AsTask`), and prints the result enum (`Verified`, `Canceled`, `DeviceNotPresent`, …) as one line of JSON.
- [ ] **Step 2:** Run it three ways and record each result:
  - (a) from an interactive console;
  - (b) via Node `execFile('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File', scriptPath])` from a test script, with the repo path containing spaces;
  - (c) from a process started the way the daemon will be (Task Scheduler at logon, hidden or headless console). Does the Hello dialog appear in front, and can the owner complete it? A Win32 process without a window may need `IUserConsentVerifierInterop::RequestVerificationForWindowAsync` with a window handle; if (c) fails, try the interop call with the foreground window handle, or start a tiny visible helper window.
- [ ] **Step 3:** Also check: the time from click to dialog (target < 2 s), what happens when the owner cancels, and whether computer-use can see or interact with the dialog (it should not be able to supply a face, fingerprint or PIN).
- [ ] **Step 4:** Decision, written into the README:
  - **Works in (c):** T0.13b implements `presence.verify()` with this script, and Hello is mandatory.
  - **Fails:** T0.13b implements the **MCP elicitation** channel (Claude Code ≥2.1.76) as the Phase 0 approval channel, and the dashboard Approve buttons are replaced by "Approve in Claude Code". Tell the owner about the weaker residual risk (spec R1).

### Task T0.1: Workspace scaffold, network guard, CI on a spaced path

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`, `.nvmrc` (`22`), `packages/{core,daemon,client,mcp,cli}/package.json` + `tsconfig.json` + `src/index.ts`
- Create: `test/setup/no-network.ts`, `test/source-rules.test.ts`, `.github/workflows/ci.yml`, `.claude/settings.json`

**Interfaces:**
- Produces: package names `@cph/core`, `@cph/daemon`, `@cph/client`, `@cph/mcp`, `@cph/cli`. Root scripts: `build` (`tsc -b` with TypeScript 5.9.3, project references, each package to `dist/`), `test` (`vitest run`), `typecheck` (`tsc -b`). `engines.node: ">=22"`.
- Produces: `class NetworkBlockedError extends Error`, exported from `test/setup/no-network.ts`. The setup file runs for every vitest project.
- Produces: `scanSources(globs: string[], pattern: RegExp): {file: string; line: number}[]` in `test/source-rules.test.ts`. Later tasks add rules here.

- [ ] **Step 1:** `git checkout -b feat/phase-0`. Write `test/setup/no-network.ts`. It replaces `globalThis.fetch` with a function that throws `NetworkBlockedError("network disabled in tests: <url>")`, and installs an undici `MockAgent` with `disableNetConnect()` as the global dispatcher.
- [ ] **Step 2:** Write a failing test, `test/no-network.test.ts`:
  ```ts
  it('blocks real network', async () => {
    await expect(fetch('https://dev.to/api/users/me')).rejects.toThrow(NetworkBlockedError);
  });
  ```
- [ ] **Step 3:** Wire `vitest.config.ts` with `test.projects` (one per package) and `setupFiles: ['test/setup/no-network.ts']`. Run `pnpm test`. Expected: PASS.
- [ ] **Step 4:** Write `test/source-rules.test.ts` with rule `no-browser-automation`: no import of `playwright` or `puppeteer` outside `packages/daemon/src/assets/` (phase 1, own-site screenshots only). Expected: PASS on the empty tree.
- [ ] **Step 5:** Write the project-scope `.claude/settings.json` with `permissions.ask` for `mcp__content-powerhouse__publish`, `mcp__content-powerhouse__schedule` and `mcp__content-powerhouse__stage_remote_draft`. **This file only applies when Claude Code runs inside this repo.** The rules that matter everywhere (the `cph-guard` hook and the user-scope `ask` rules) are written to `~/.claude/settings.json` by `cph install` in T0.21, with the owner's approval. Check the exact rule and hook syntax against current Claude Code settings docs before committing. **Tell the user both files exist and what they do.**
- [ ] **Step 6:** CI: `.github/workflows/ci.yml` on `windows-latest`. `actions/checkout` with `path: 'cp space/repo'` (relative to the workspace; `path` cannot be an absolute `D:\…` path), and every later step sets `working-directory: 'cp space/repo'`. Then `pnpm i --frozen-lockfile`, `pnpm typecheck`, `pnpm test`. No secrets in the workflow. (The repo has no remote yet; CI runs once the user pushes. Pushing is the user's call.)
- [ ] **Step 7:** Commit: `chore: scaffold pnpm workspace, network-blocking test setup, CI`.

### Task T0.2: Core model, URLs, frontmatter parser

**Files:** Create `packages/core/src/{ids.ts,model.ts,urls.ts,frontmatter.ts}`, `packages/core/test/fixtures/{sample-post.mdx,crlf-bom-post.mdx}`. Test: `packages/core/test/frontmatter.test.ts`, `urls.test.ts`.

**Interfaces (Produces):**
```ts
// ids.ts
type PlatformId = 'devto'|'linkedin'|'x'|'bluesky'|'mastodon'|'hashnode'|'medium'|'substack'|'reddit'|'youtube';
type RouteKind = 'direct'|'buffer'|'assist';
type DraftKind = 'article'|'post'|'thread'|'video'|'newsletter'|'assist-kit';
type DraftStatus = 'draft'|'staged'|'pending_approval'|'approved'|'scheduled'|'publishing'|'unknown'|'published'|'handed_off'|'failed'|'held'|'source_changed';
type Authorship = 'verbatim'|'reformatted'|'ai-assisted';
// model.ts: Frontmatter, ContentItem, PublishingPackage exactly as spec §2.4, plus:
interface LintResult { rule: string; severity: 'error'|'warning'; message: string; }
// urls.ts
canonicalUrlFor(slug: string, baseUrl = 'https://www.example-blog.dev'): string   // `${base}/blog/${slug}`
coverPngUrl(coverImage: string, baseUrl): string    // '/images/blogs-covers/x.svg' -> absolute '.png'
absolutize(src: string, baseUrl): string            // site-relative -> absolute; absolute unchanged
withUtm(url: string, platform: PlatformId, slug: string): string
// frontmatter.ts
parsePost(raw: string): { frontmatter: Frontmatter; body: string }   // throws PostParseError(field, reason)
```
`DraftStatus` matches spec §2.4: `publishing` is in flight (Review Focus #2), and `unknown` means a crash or timeout happened after the approval was consumed (T0.17).

- [ ] **Step 1:** Fixture `sample-post.mdx` is a synthetic post that mirrors the real format (see "Verified facts"): 6 tags, `import Callout from '@/components/Callout';`, 1 `alert` Callout with title, 1 `note` Callout, 1 GFM table, 1 site-relative SVG image, 1 fenced `promql` code block, and one `<PacketJourney name="x" />`. `crlf-bom-post.mdx` is the same content with `\uFEFF` and `\r\n`.
- [ ] **Step 2:** Failing tests:
  - `parsePost(sample)` gives `frontmatter.tags.length===6`, `published===true`, `date==='2026-07-19'`;
  - `parsePost(crlfBom)` deep-equals `parsePost(sample)`;
  - missing `title` throws `PostParseError` with `field==='title'`;
  - `category:'blog'` throws (enum `engineering|case-study|productivity|community`);
  - `coverPngUrl('/images/blogs-covers/prometheus-cardinality.svg', base)` gives `'https://www.example-blog.dev/images/blogs-covers/prometheus-cardinality.png'`;
  - `withUtm(canon,'linkedin','s')` ends with `?utm_source=linkedin&utm_medium=social&utm_campaign=s`;
  - `canonicalUrlFor('s')` contains no `utm_`.
- [ ] **Step 3:** Run, expect FAIL. Implement with gray-matter and a zod `Frontmatter` schema. Strip the BOM and normalize `\r\n` to `\n` before parsing.
- [ ] **Step 4:** Run, expect PASS. Commit `feat(core): model, url helpers, frontmatter parser`.

### Task T0.3: Publishing-notes parser

**Files:** Create `packages/core/src/notes.ts`, fixture `sample-notes.md` (the real label set from spec §2.3, synthetic values, 2 verify items, 3 fact labels). Test: `notes.test.ts`.

**Interfaces:** Produces `parsePublishingNotes(raw: string): PublishingPackage`. Unknown bold labels are ignored. A missing optional label gives `undefined`. A missing `**Meta description:**` or `**Excerpt (index/home):**` gives a `NotesParseError`.

- [ ] **Step 1:** Failing tests:
  - `alternateTitles.length===3` (from the bulleted list under `**Alternate titles**`, which has no colon);
  - `verifyBeforePublishing` deep-equals the 2 bullet strings under `## Verify before publishing`;
  - `factLabels.length===3`;
  - `ogText` equals the value after `**OG / social card text:**`;
  - `keyEntities` is split on `, ` with a trailing `.` trimmed;
  - a CRLF+BOM copy parses identically;
  - a file with only `**Meta description:**` and `**Excerpt (index/home):**` parses with empty arrays.
- [ ] **Step 2:** Implement as a line scanner: a bold label regex `^\*\*(.+?):?\*\*:?\s*(.*)$`, `## ` sections, `- ` bullets. No markdown AST is needed.
- [ ] **Step 3:** PASS. Commit `feat(core): publishing-notes parser`.

### Task T0.4: MDX → PortableDoc lowering

**Files:** Create `packages/core/src/{portable-doc.ts,lower-mdx.ts}`, fixture `unknown-jsx.mdx`. Test: `lower-mdx.test.ts`.

**Interfaces:** Produces:
```ts
type PNode =
  | {type:'heading'; depth: 1|2|3|4|5|6; children: Inline[]}
  | {type:'paragraph'; children: Inline[]}
  | {type:'list'; ordered: boolean; items: PNode[][]}
  | {type:'code'; lang?: string; value: string}
  | {type:'table'; header: string[]; rows: string[][]}
  | {type:'image'; src: string; alt: string; svg: boolean}
  | {type:'callout'; kind:'note'|'aside'|'alert'; title?: string; children: PNode[]}
  | {type:'interactive'; component: string; name?: string; anchor: string}
  | {type:'blockquote'; children: PNode[]} | {type:'thematicBreak'}
  | {type:'html'; value: string} | {type:'unsupported'; component: string; line: number};
type Inline = mdast PhrasingContent with link/image URLs already absolutized;
interface PortableDoc { nodes: PNode[]; plainText: string /* for numeric provenance */ }
lowerMdx(body: string, opts: { baseUrl: string; canonicalUrl: string }): PortableDoc
```
Known interactive components: `PacketJourney`, `StateMachine`, `OutOfBandDiagram`. The anchor is `#` + slugified `name` (or the component name). `import`/`export` ESM nodes are dropped.

- [ ] **Step 1:** Failing tests on `sample-post.mdx`:
  - there are no ESM nodes;
  - exactly one `callout` with `kind:'alert'` and `title` starting `Big Word Alert`;
  - one `table` whose `header` matches the fixture;
  - `image.src` starts with `https://www.example-blog.dev/` and `svg===true`;
  - `code.lang==='promql'`;
  - `interactive.component==='PacketJourney'`;
  - `unknown-jsx.mdx` (`<FancyThing/>`) gives one `unsupported` node with `component==='FancyThing'` and a line number;
  - `plainText` contains the table's cell text and the Callout text.
- [ ] **Step 2:** Implement with `unified().use(remarkParse).use(remarkMdx).use(remarkGfm)`, then a single recursive `lower(node)` switch. The `type` attribute of a `Callout` JSX element maps to `kind`; any other value gives `unsupported`.
- [ ] **Step 3:** PASS. Commit `feat(core): lower MDX to PortableDoc`.

### Task T0.5: Payload hashing

**Files:** Create `packages/core/src/hash.ts`. Test: `hash.test.ts`.

**Interfaces:** Produces `payloadHash(input: { platform: PlatformId; account: string; route: RouteKind; payload: unknown; mediaSha256: string[]; scheduledAt: string|null }): string`. This is lowercase hex SHA-256 of `canonicalize(input)` (RFC 8785), computed with `node:crypto` `createHash` (synchronous and pure, so it is allowed in `core`).

- [ ] **Step 1:** Failing tests:
  - key order does not change the hash;
  - changing one character of `payload.text` changes it;
  - changing `scheduledAt` from `null` to an ISO string changes it;
  - `mediaSha256` order matters (media order is user-visible);
  - a snapshot pins one known hash so canonicalization can't silently drift.
- [ ] **Step 2:** Implement. PASS. Commit `feat(core): RFC 8785 payload hash`.

### Task T0.6: Lint primitives (length, links, numeric provenance)

**Files:** Create `packages/core/src/lint/{text.ts,numbers.ts}`. Test: `lint-text.test.ts`, `lint-numbers.test.ts`.

**Interfaces:** Produces:
- `graphemeLength(s: string): number`, using `Intl.Segmenter('en',{granularity:'grapheme'})`;
- `countLinks(s: string): string[]`, returning the URLs found;
- `extractNumbers(s: string): string[]`, normalized as described below;
- `findUnsourcedNumbers(text: string, sources: string[]): string[]`.

Normalization:
- `1,000`→`1000`; `16,800`→`16800`; `p99.9`→`99.9`; `12%`→`12`; `x12`→`12`;
- ordinals and years inside URLs are ignored;
- `1 to 2 bytes` yields `1` and `2`;
- **single digits 0–9 are allowed** without a source, for counts like "3 points" (architect's call to avoid noise).

- [ ] **Step 1:** Failing tests:
  - `graphemeLength('ρ👩‍💻')===2`;
  - `findUnsourcedNumbers('drops 31 series to 7', ['31 series to 7 after aggregation'])` gives `[]`;
  - `findUnsourcedNumbers('saves 45% of memory', [source])` gives `['45']`;
  - `findUnsourcedNumbers('16,800 series', ['16800'])` gives `[]`;
  - numbers inside `https://…?utm_campaign=2026` are ignored.
- [ ] **Step 2:** Implement. PASS. Commit `feat(core): lint primitives incl. numeric provenance`.

### Task T0.7: dev.to transform

**Files:** Create `packages/core/src/transforms/{types.ts,devto.ts,registry.ts}`, `content-item.ts`. Test: `devto.test.ts` with a snapshot `__snapshots__/devto.test.ts.snap`.

**Interfaces:**
- Consumes: `ContentItem`, `PortableDoc`, `LintResult`, `canonicalUrlFor`, `coverPngUrl`.
- Produces:
```ts
interface Transform<P> { platform: PlatformId; kind: DraftKind;
  skeleton(item: ContentItem): P; lint(p: P, item: ContentItem): LintResult[]; }
interface DevtoPayload { title: string; body_markdown: string; published: false; canonical_url: string;
  main_image: string; description: string; tags: string[]; series?: string; }
const devtoTransform: Transform<DevtoPayload>;
renderDevtoMarkdown(doc: PortableDoc, item: ContentItem): string;
sanitizeDevtoTags(tags: string[], preferred?: string[]): string[];   // lowercase, [a-z0-9] only, dedupe, max 4
buildContentItem(i: { slug: string; mdxRaw: string; notesRaw?: string; repoCommit: string; dirty: boolean; baseUrl: string }): ContentItem;
const transforms: Record<'devto'|'linkedin', Transform<any>>;   // registry.ts
```
- The tag rule is **[Architect's call]**: if `preferred` is given (from config `platforms.devto.tagPreference`), keep the frontmatter tags in preference order; otherwise take the first 4 in frontmatter order. For the fixture post that gives `prometheus, observability, tsdb, cardinality`. Spec Appendix A shows a different hand-picked set, so the user can set the preference list.
- `published` is the literal type `false`. The skeleton cannot express true.

- [ ] **Step 1:** Failing tests:
  - `skeleton(item).canonical_url === 'https://www.example-blog.dev/blog/<slug>'`, with no `utm_`;
  - `main_image` ends `.png`;
  - `tags.length===4`, each matching `/^[a-z0-9]+$/`;
  - `published===false`;
  - the `body_markdown` contains no `import ` line and no `<Callout`;
  - the alert Callout renders as `> **Big Word Alert: …**`;
  - the note Callout renders as `> **Note:** …`;
  - the interactive node renders as a text block `> **Interactive diagram: <name>.** Open it on the original post: <canonical>#<anchor>`, with **no image**;
  - `lint` on a payload whose markdown contains an image whose URL equals `main_image` (or any URL in a `placeholderUrls` list) gives the error `placeholder-image`, so such a draft can never be approved;
  - the table stays GFM;
  - the footer is `*Originally published at [example-blog.dev](<canonical>).*`;
  - `lint` on an item with an `unsupported` node gives an `error` with rule `unsupported-node`;
  - `lint` with 5 tags gives the error `devto-tags`;
  - snapshot of the full markdown.
- [ ] **Step 2:** Implement `renderDevtoMarkdown` with `remark-stringify` over PNodes converted back to mdast. Interactive nodes render as the text block above until an asset host exists (Phase 2), when a real PNG snapshot is added above the link. There are no placeholder images. SVG images keep the absolute site URL until Spike S3 decides; if dev.to does not render SVG, they become a text link (or the site's PNG twin where one exists).
- [ ] **Step 3:** PASS. Commit `feat(core): dev.to transform + lint`.

### Task T0.8: LinkedIn transform

**Files:** Create `packages/core/src/transforms/linkedin.ts`. Test: `linkedin.test.ts`.

**Interfaces:** Produces:
```ts
interface LinkedinPayload { text: string; link?: { url: string; title: string; description: string; thumbnailUrl: string } }
const linkedinTransform: Transform<LinkedinPayload>;
```
- `link` is sent to Buffer as `metadata.linkedin.linkAttachment` (T0.15). It is **optional in the type and gated by config** `platforms.linkedin.linkCard: boolean`. It is set to `true` only after Spike S2(e) confirms the `linkAttachment` input fields. **If S2 cannot confirm them before T0.23, `link` is removed from the skeleton (and so from the hash)**, and the approval card says "Preview will be generated by LinkedIn from the page's OG tags". The card must never show a preview the route does not send.
- **Skeleton:**
  - `text` is the excerpt from the notes, or `frontmatter.description` when there is no notes file, followed by `\n\n` and the UTM link;
  - `link.url` is `withUtm(canonical,'linkedin',slug)`;
  - `link.title` is `notes.primaryTitle ?? frontmatter.title`;
  - `link.description` is `notes.metaDescription ?? description`;
  - `link.thumbnailUrl` is `coverPngUrl`.
- **Lint rules:**
  - `li-length`: `graphemeLength(text) ≤ 3000` (UNVERIFIED limit, from spec §5.3). Over the limit is an error.
  - `li-one-link`: exactly 1 link in `text`, and it equals `withUtm(canonical,'linkedin',slug)` (and `link.url` when `link` is present).
  - `li-utm`: the link carries UTM.
  - `li-takeaway`: the text has ≥ 3 lines that aren't the link, and ≥ 400 graphemes. This is the proxy for "a complete takeaway" (G3; architect's call). Failing it is an error.
  - `li-numbers`: `findUnsourcedNumbers(text, [doc.plainText, notes fields])` is non-empty. Error.
  - `li-hashtag-wall`: more than 5 `#tags`. Warning.
  - `li-emoji-wall`: more than 3 emoji. Warning.

- [ ] **Step 1:** Failing tests, one per rule, plus:
  - the skeleton passes every rule except `li-takeaway`. The skeleton is deliberately too thin, so Claude must write the adaptation.
  - A post without notes still produces a skeleton.
  - With `linkCard:false`, the skeleton has no `link` key at all (so the hash cannot cover a field that is never sent).
- [ ] **Step 2:** Implement. PASS. Commit `feat(core): LinkedIn transform + lint`.

### Task T0.9: Daemon paths, config, SQLite schema and repos

**Files:** Create `packages/daemon/src/{paths.ts,config.ts,db/open.ts,db/migrations/001_init.sql,db/repos.ts}`. Test: `packages/daemon/test/db.test.ts`.

**Interfaces:** Produces:
- `stateDir(): string`, which is `%LOCALAPPDATA%\content-powerhouse`, overridable by env `CPH_STATE_DIR` (tests use a temp dir).
- `loadConfig(): Config`, a zod schema:
  ```ts
  { site: { repoPath: string; baseUrl: string; timeZone?: string /* default: Windows time zone */ };
    daemon: { port: 4646 };
    claude: { askOnPublish: boolean /* default true */ };
    platforms: { devto?: { tagPreference?: string[] };
                 linkedin?: { route: 'buffer'|'assist'; bufferChannelId?: string; linkCard?: boolean /* default false until S2(e) */ };
                 buffer?: { organizationId?: string /* cached at connect */ } } }
  ```
  `config.json` defaults to `repoPath = 'C:\\path\\to\\your-site'`.
- `openDb(file: string): Db`. Applies WAL and runs migrations.
- `Repos`:
  - `content.upsert / get / list`;
  - `drafts.insert / get / list / update(id, patch, expectedSha?)`;
  - `approvals.insert / get / setStatus / consume(id): boolean`;
  - `publications.insert / findByHash(platform, sha)`;
  - `connections.upsert / get / list`;
  - `credentials.put / get / delete`;
  - `settings.get / set`;
  - `audit.append / list`;
  - `apiBudget.record(provider, window, limit, remaining, resetsAt) / get(provider)`.

The schema follows spec §2.7, including `drafts.remote_scheduled_id`, `drafts.scheduled_at`, `content.t0`, `approvals.presence_verified_at`, `approvals.mode`, the `api_budget` table and the `settings(key PK, value)` table:
- `publishing_enabled = 'false'` is seeded;
- `dry_run:<platform>` keys.

`approvals.consume` runs `UPDATE approvals SET used_at=? WHERE id=? AND used_at IS NULL AND status='approved'` and returns `changes===1`. `audit_log` has no UPDATE or DELETE path in `Repos`.

- [ ] **Step 1:** Failing tests:
  - migrations are idempotent (open twice);
  - `settings.get('publishing_enabled')==='false'` on a fresh DB;
  - `consume` returns `true` once and then `false`;
  - two `consume` calls inside `Promise.all` give exactly one `true` (Review Focus #2);
  - `Repos.audit` exposes no update or delete function (`expect(Object.keys(repos.audit)).toEqual(['append','list'])`).
- [ ] **Step 2:** Implement. PASS. Commit `feat(daemon): sqlite schema, repos, config`.

### Task T0.10: Secret store (keyring envelope) and redaction

**Files:** Create `packages/daemon/src/secrets/{keystore.ts,secret-store.ts,redact.ts}`. Test: `secrets.test.ts`.

**Interfaces:** Produces:
- `interface KeyStore { get(name): string|null; set(name, v): void; delete(name): void }`, with implementations `WindowsKeyStore` (`@napi-rs/keyring` `Entry('content-powerhouse', name)`) and `MemoryKeyStore` (tests).
- `class SecretStore { constructor(ks: KeyStore, repos: Repos); ensureMasterKey(): void; put(platform, account, secret: Record<string,string>): void; get(platform, account): Record<string,string>|null; delete(platform, account): void; wipeAll(): void }`. It uses AES-256-GCM with a random 12-byte IV per write.
- `redact(s: string): string`. It masks strings shaped like tokens: base64/hex runs of 20+ characters, `Bearer x`, and `api-key: x`.
- `issueApiToken(ks, scope: 'mcp'|'cli'): string`. It stores `api-token:<scope>` in the keystore.

- [ ] **Step 1:** Failing tests:
  - a round trip `put`/`get` succeeds;
  - the ciphertext column does not contain the plaintext;
  - tampering with one byte of the tag throws;
  - a missing master key throws `MasterKeyMissing`, not a silent re-create; re-creating is only allowed in `cph install` via `ensureMasterKey()`;
  - `redact('api-key: abcdefghijklmnopqrstuvwxyz')` hides the key.
- [ ] **Step 2:** Implement. One manual test (skipped unless `CPH_KEYRING_IT=1`) exercises the real Windows Credential Manager with a throwaway service name and deletes it afterwards.
- [ ] **Step 3:** PASS. Commit `feat(daemon): envelope-encrypted secret store`.

### Task T0.11: Read-only SiteReader + git allowlist

**Files:** Create `packages/daemon/src/site/{site-reader.ts,guarded-fs.ts,git.ts}`. Test: `site-reader.test.ts`. Extend `test/source-rules.test.ts`.

**Interfaces:** Produces:
- `class SiteReader { constructor(repoPath: string, run?: GitRunner); listPosts(): Promise<string[] /* slugs */>; readPost(slug): Promise<string>; readNotes(slug): Promise<string|null>; gitHead(): Promise<string>; isDirty(relPath): Promise<boolean> }`
- `assertNotUnderSite(target: string, repoPath: string): void`. It throws `SiteWriteBlocked`, using a case-insensitive Windows comparison of resolved paths.
- `guardedFs`: wrapped `writeFile`, `mkdir`, `rm`, `rename`, `copyFile` that call the assert first. All daemon code imports fs writes from here.
- `git(args: string[])`: allows only `['rev-parse','HEAD']`, `['status','--porcelain','--',path]` and `['log','-1','--format=%H']`. Anything else throws `GitCommandBlocked`. It runs `execFile('git', ['--no-optional-locks', '-C', repoPath, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })`. Without `--no-optional-locks`, `git status` can refresh stat data and rewrite `.git/index` (taking `index.lock`), which is a write to the site repo and can collide with the owner's own git commands.

- [ ] **Step 1:** Failing tests against a **temp copy** of the fixtures, in a temp directory with a space in its name:
  - `listPosts()` returns the slugs;
  - `readNotes('missing')` returns `null`;
  - `guardedFs.writeFile(join(repo,'x'))` throws `SiteWriteBlocked`;
  - the same holds with a different case (`C:\PATH\…`) and with `..` traversal;
  - `git(['commit'])` throws `GitCommandBlocked`;
  - a fake `execFile` records every git call, and each one starts with `--no-optional-locks` and carries `GIT_OPTIONAL_LOCKS=0`.
- [ ] **Step 2:** Source rule `site-read-only`: any file under `packages/**/src` that imports `node:fs` write APIs (`writeFile|appendFile|mkdir|rm|rename|copyFile|createWriteStream`) directly fails the test; only `guarded-fs.ts` is allowlisted. Rule `git-allowlist`: `execFile('git'` appears only in `site/git.ts`, and only with `--no-optional-locks` as the first argument.
- [ ] **Step 3:** Optional integration test, skipped unless `CPH_SITE_REPO` is set. It reads the **real** clone read-only, asserts `listPosts()` includes `prometheus-cardinality-explained`, and asserts that, before and after a full sync: `git --no-optional-locks status --porcelain` output is identical, **and the mtime and sha256 of `.git/index` are identical**. This is the "never modified it" proof.
- [ ] **Step 4:** PASS. Commit `feat(daemon): read-only SiteReader with write guard and git allowlist`.

### Task T0.12: Content sync + canonical-live gate

**Files:** Create `packages/daemon/src/{live-check.ts,sync.ts,t0.ts}`. Test: `live-check.test.ts`, `sync.test.ts`, `t0.test.ts`.

**Interfaces:**
- Consumes: `SiteReader`, `buildContentItem`, `Repos`.
- Produces:
  - `checkCanonicalLive(item: ContentItem, fetchFn: typeof fetch): Promise<{ ok: boolean; status: number; finalUrl: string; reason?: 'not-published'|'status'|'host'|'title-missing'|'network' }>`;
  - `computeT0(frontmatterDate: string, canonicalLiveAt: string|null, timeZone: string): string|null` (spec §2.3);
  - `syncContent(deps: { reader: SiteReader; repos: Repos; fetchFn; now: () => Date; onInvalidated?: (draftIds: string[]) => Promise<void> }): Promise<{ upserted: number; changed: string[]; invalidatedApprovals: number }>`.

Behaviour:
- `checkCanonicalLive` uses `redirect:'follow'` and requires all of:
  - `new URL(finalUrl).host === 'www.example-blog.dev'`;
  - status 200;
  - after **decoding HTML entities in the response** (named, decimal and hex, for example `&#x27;`, `&#39;`, `&apos;`, `&rsquo;`, `&amp;`), the text contains the raw frontmatter title. Do not escape the title and compare; Next.js may escape apostrophes and quotes differently;
  - `frontmatter.published === true`.
- On the first pass it sets `content.canonical_live_at`, and then `content.t0 = computeT0(...)`:
  - `T0 = min(frontmatter.date at 00:00 in site.timeZone, canonical_live_at)`;
  - except when `canonical_live_at` is more than 1 day after that date (a late deploy), then `T0 = canonical_live_at`.
- When the MDX or notes hash changes, sync marks every draft of that slug in `draft|staged|pending_approval|approved|scheduled` as `source_changed`. It sets the pending or approved approvals to `invalidated`, appends an audit entry `source_changed`, and calls `onInvalidated` for drafts that have a `remote_scheduled_id` (wired to remote cancellation in T1.7; a no-op in Phase 0, where nothing is platform-scheduled).

- [ ] **Step 1:** Failing tests with fake fetch:
  - a 200 response containing the title gives `ok`;
  - 200 with a soft-404 body gives `title-missing`;
  - a redirect to `example-blog.dev` (apex) as the final URL gives `host`;
  - `published:false` gives `not-published` without any fetch call;
  - a fetch that throws gives `network`;
  - sync twice with no change gives `changed:[]`;
  - after editing the fixture MDX: an approved approval becomes `invalidated` and the draft becomes `source_changed` (Review Focus #1);
  - a title with an apostrophe (`Why Prometheus Can't Keep Up`) matches HTML that encodes it as `&#x27;`, `&#39;` or `&apos;`. `&rsquo;` decodes to a different character (’) and does not match a straight apostrophe, and the test pins that too;
  - `computeT0`: a 3-month-old post (date 2026-07-19, first seen live today) gives T0 = 2026-07-19 00:00, so dev.to `notBefore` (T0 + 48 h) is already in the past; a post dated today but first seen live 3 days later gives T0 = `canonical_live_at`; a post seen live the same day gives T0 = the frontmatter date.
- [ ] **Step 2:** Implement. PASS. Commit `feat(daemon): content sync and canonical-live check`.

### Task T0.13: The approval gate

**Files:** Create `packages/daemon/src/gate/{errors.ts,verified.ts,approval-gate.ts,prechecks.ts}`. Test: `gate.test.ts`. This is the most important test file in the project.

**Interfaces:** Produces:
```ts
type GateCode = 'NO_APPROVAL'|'NOT_APPROVED'|'EXPIRED'|'USED'|'HASH_MISMATCH'|'SOURCE_CHANGED'|'PUBLISHING_DISABLED'
  |'CANONICAL_NOT_LIVE'|'LINT_ERRORS'|'NOT_BEFORE'|'DUPLICATE'|'UNHEALTHY'|'CHECKLIST_INCOMPLETE'|'WRONG_CHANNEL'
  |'PRESENCE_FAILED'|'BUDGET_LOW';
class GateError extends Error { code: GateCode }
// verified.ts: a branded type only this module can mint
declare const verifiedBrand: unique symbol;
type VerifiedApproval = { approvalId: string; draftId: string; payloadSha256: string; [verifiedBrand]: true };
class ApprovalGate {
  constructor(deps: { repos: Repos; now: () => Date; health: (platform, account) => Promise<boolean>;
                      presence: PresenceVerifier; ttlMs?: number /* 30*60_000 */ });
  request(draftId: string): { approvalId: string; status: 'pending'; approveUrl: string; instructions: string };  // refuses LINT_ERRORS, CANONICAL_NOT_LIVE, SOURCE_CHANGED
  approve(approvalId: string, ctx: { channel: 'dashboard_hello'|'elicitation'; checked: string[]; mode: 'publish_now'|'approve_only'|'schedule' }): Promise<void>;
     // CHECKLIST_INCOMPLETE unless checked ⊇ checklist(draft); then awaits presence.verify(prompt) and records
     // presence_verified_at only on 'verified'; otherwise PRESENCE_FAILED and nothing is recorded
  deny(approvalId: string, ctx: { channel: 'dashboard_hello'|'elicitation' }): void;   // no presence needed to say no
  checklist(draftId: string): string[];   // ['I have read this exact payload', ...notes.verifyBeforePublishing]
  authorize(draftId: string, approvalId: string): Promise<VerifiedApproval>;   // runs every precheck, consumes atomically
}
interface PresenceVerifier { verify(prompt: string): Promise<'verified'|'canceled'|'unavailable'|'error'> }   // T0.13b
```
- `authorize` order: `publishing_enabled` → approval exists → `approved` → `presence_verified_at` set → not expired → `payload_sha256 === draft.payload_sha256` (the hash is recomputed from the stored payload, not trusted from the column) → draft not `source_changed` → canonical live → lint clean → `not_before ≤ now` → no publication with the same hash → health → `consume()` (atomic). Each failure writes an audit entry with the `GateCode`.
- `request().instructions` is the polling contract from spec §2.6: "Ask the owner to approve at <url>. Then call get_approval_status every 15 s for up to 10 minutes; stop on published, approved, denied or expired."
- **Assumption:** `approve()` has no code path reachable from the API-token-authenticated router. T0.18 enforces this.

- [ ] **Step 1:** Write the failing tests, one `it` per row:

  | Test | Expect |
  |---|---|
  | authorize without approval | `NO_APPROVAL` |
  | pending, not approved | `NOT_APPROVED` |
  | approved, `now` + 31 min | `EXPIRED` |
  | approved, then `drafts.update` changes text | `HASH_MISMATCH` |
  | approved, column hash forged to match but payload changed | `HASH_MISMATCH` (recomputed) |
  | authorize twice | second `USED` |
  | `Promise.all` of two authorizes | exactly one resolves |
  | `publishing_enabled=false` | `PUBLISHING_DISABLED`, even with a valid approval |
  | `approve` with one verify box missing | `CHECKLIST_INCOMPLETE` |
  | `approve` with a fake presence returning `canceled` / `unavailable` / `error` | `PRESENCE_FAILED`; approval stays `pending`; no `presence_verified_at` |
  | approval row forced to `approved` without `presence_verified_at` (simulated DB tamper) | `PRESENCE_FAILED` at authorize |
  | `approve` called with all boxes ticked and presence `verified` | `approved`, `channel='dashboard_hello'`, `presence_verified_at` set |
  | `request` when lint has errors | `LINT_ERRORS` |
  | `request` when canonical not live | `CANONICAL_NOT_LIVE` |
  | source changed after approval | `SOURCE_CHANGED` |
  | dev.to draft with `not_before` = live + 48 h, now = live + 1 h | `NOT_BEFORE` |
  | publication already exists for hash+platform | `DUPLICATE` |
  | health false | `UNHEALTHY` |
  | `request()` result serialized | contains no field that, if passed back, authorizes anything (`Object.keys` equals `['approvalId','status','approveUrl','instructions']`) |
- [ ] **Step 2:** Run, expect all FAIL. Implement. Expect PASS.
- [ ] **Step 3:** Commit `feat(daemon): hash-bound single-use approval gate`.

### Task T0.13b: Presence check (Windows Hello), moved here from Phase 1

**Files:** Create `packages/daemon/src/gate/presence.ts`, `packages/daemon/src/gate/hello.ps1` (from the T0.0 spike), and, only if T0.0 failed, `packages/daemon/src/gate/elicitation.ts`. Test: `presence.test.ts`.

**Interfaces:**
- `class WindowsHelloPresence implements PresenceVerifier`. It runs `execFile('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File', helloPs1, '-Prompt', prompt])` (args array, path with spaces), with a 120 s timeout. It parses the one-line JSON result into `'verified'|'canceled'|'unavailable'|'error'`. A timeout or non-zero exit is `'error'`. **It fails closed: anything except an explicit `Verified` from WinRT is not verified.**
- `class FakePresence` for tests.
- The prompt text names the action: "Approve: LinkedIn post for prometheus-cardinality-explained" or "Enable publishing".
- **Where it is called:**
  - inside `ApprovalGate.approve()` (every approval, every mode);
  - on the dashboard `POST /settings/publishing` when turning publishing **on** (turning it off needs no Hello).
- **Fallback, only if T0.0 failed:** `ElicitationPresence` sends an MCP `elicitInput` through the connected Claude Code client with `decision: ["Approve", "Cancel"]` and the rendered payload, and returns `verified` only on "Approve". The dashboard Approve buttons are then replaced by "Approve in Claude Code". If no client supports elicitation, approval is impossible, which fails safe.

**Tests:**
- a script result of `Verified` gives `verified`; `Canceled` gives `canceled`; garbage, timeout and exit code 1 give `error`;
- `execFile` is called with an args array whose script path contains spaces;
- the dashboard publishing toggle refuses to turn on when presence is not `verified`, and turning it off works without presence;
- a source rule: `approvals.setStatus(…, 'approved')` is called only from `approval-gate.ts`, after `presence.verify`.

**Manual (after U0-E):** click Approve on a dry-run draft. The Hello prompt appears with the right text. Cancel it: the card stays pending. Complete it: the card shows "approved (Windows Hello)".

Commit `feat(daemon): Windows Hello presence check on approve and on enabling publishing`.

### Task T0.14: Route interface + dev.to direct route

**Files:** Create `packages/daemon/src/routes/{types.ts,devto.ts,registry.ts}`, fixtures `packages/daemon/test/fixtures/http/devto-*.json` (shapes from the Forem docs; replace with redacted real responses after U0-A). Test: `devto-route.test.ts`.

**Interfaces:**
- Consumes: `VerifiedApproval`, `DevtoPayload`, `SecretStore`.
- Produces:
```ts
interface Health { state: 'connected'|'expiring'|'needs_reconnect'|'not_configured'|'manual_only'; who?: string; detail?: string; nextAction?: string }
interface RemoteRef { remoteId: string; previewUrl?: string }
interface Publication { remoteId: string; remoteUrl?: string; costUsd: number }
interface Route<P> { kind: RouteKind; platform: PlatformId;
  health(account: string): Promise<Health>;
  connect?(account: string, input: Record<string,string>): Promise<Health>;   // validates, then stores the secret
  stage?(d: Draft<P>): Promise<RemoteRef>;
  publish(d: Draft<P>, a: VerifiedApproval): Promise<Publication>;
  cancelScheduled?(d: Draft<P>): Promise<void>;        // platform-held scheduled posts (T1.7)
  checkOnPlatform?(d: Draft<P>): Promise<'published'|'not_found'|'unknown'>;   // resolves `unknown` (T0.17)
  handOff?(d: Draft<P>): Promise<AssistKit>;
  costEstimate(d: Draft<P>): number; }
class DevtoRoute implements Route<DevtoPayload> { constructor(deps: { secrets: SecretStore; fetchFn: typeof fetch; now: () => Date }) }
class PlatformError extends Error { status: number; retryAfterMs?: number; body?: string }
parseRetryAfter(h: string|null, now: Date): number|undefined   // seconds OR HTTP-date
```
Calls (headers `api-key`, `accept: application/vnd.forem.api-v1+json`, `content-type: application/json`):
- `connect` → `GET https://dev.to/api/users/me`; stores `{apiKey}` only on 200; `who='@'+username`.
- `stage` → runs **only for drafts in status `draft` or `staged`** (anything else throws `StageRefused`).
  - If `remote_ref` is null: `POST /api/articles` with `{article:{...payload, tags: payload.tags.join(','), published:false}}`. Spreading `published:false` **after** the payload overrides any value.
  - Otherwise, **before any PUT**, read the article back with `GET /api/articles/me/unpublished` (paginate until found) or `GET /api/articles/{id}`. If it is published, or cannot be found among the unpublished articles, throw `StageRefused('article is live on dev.to; editing it is a publish and needs its own approval')` and mark the draft `failed` with that reason. Only then `PUT /api/articles/{id}` with the same body.
- `publish` → `PUT /api/articles/{id}` with the **approved** full payload and `published:true`, then reads `url` from the response. Any edit to a live article is treated as a publish: it goes through `publish()` with its own approval.
- `checkOnPlatform` → `GET /api/articles/me/published` / `unpublished` to resolve an `unknown` draft (T0.17).

- [ ] **Step 1:** Failing tests (fake fetch records requests):
  - stage sends `published:false` even when the payload object was cast to carry `published:true`;
  - stage never calls `PUT` with `published:true`;
  - `canonical_url` is sent unchanged;
  - `connect` with a 401 stores nothing and returns `needs_reconnect`;
  - 429 with `Retry-After: 7` gives `retryAfterMs 7000`, and with an HTTP-date gives the correct delta (Review Focus #4);
  - 422 gives a `PlatformError` with the body text;
  - `publish` sends the full approved payload;
  - `publish` makes exactly one fetch call and no retry on 5xx;
  - re-stage when the fake dev.to reports the article as **published**: no PUT is sent, `StageRefused`, draft `failed`;
  - re-stage when the article is unpublished: GET first, then exactly one PUT with `published:false`;
  - stage on a draft in status `approved`, `published` or `handed_off` throws `StageRefused` without any fetch;
  - route contract: a payload with every `DevtoPayload` field set reaches the wire with every field.
- [ ] **Step 2:** Source rule `devto-publish-only`: the regex `published:\s*true` appears only inside `DevtoRoute.publish` in `routes/devto.ts`. The scanner checks the enclosing method name with a simple brace-depth scan.
- [ ] **Step 3:** Implement. PASS. Commit `feat(daemon): dev.to direct route (private stage, gated publish)`.
- [ ] **Step 4 (manual, after U0-A):** In the dashboard, connect dev.to; the card shows `@username`. Run `cph drafts stage <id>` for the fixture post's dev.to draft. Check `https://dev.to/dashboard` and confirm it is listed as **Draft**, with the canonical URL under "Edit → … → Canonical URL". **Do not publish.**

### Task T0.15: Buffer route (connect, channel mapping, metered health, gated `shareNow`)

**Files:** Create `packages/daemon/src/routes/{buffer-client.ts,buffer.ts}`, `packages/daemon/src/services/api-budget.ts`, fixtures `buffer-account.json`, `buffer-channels.json`, `buffer-createPost-success.json`, `buffer-createPost-draft.json`, `buffer-createPost-notDraft.json`, `buffer-createPost-mutationError.json`, `buffer-deletePost.json`. Test: `buffer-route.test.ts`, `buffer-budget.test.ts`.

**Interfaces:** Produces:
```ts
class BufferClient { constructor(apiKey: string, fetchFn: typeof fetch, budget: ApiBudget);
  gql<T>(query: string, variables?: object, opts?: { purpose: 'publish'|'probe'|'stage'|'other' }): Promise<T>;
     // POST https://api.buffer.com, Authorization: Bearer <key>. Reads the remaining-quota response headers
     // (names from S2(i)) into ApiBudget after every call. Throws GateError('BUDGET_LOW') for purpose !== 'publish'
     // when < 20% of the 24 h or 30 d budget remains.
  organizations(): Promise<{id: string; name: string}[]>;            // only at connect time; the id is cached in config
  channels(organizationId: string): Promise<{id: string; name: string; service: string; isDisconnected?: boolean}[]>;
  createPost(input: BufferCreatePostInput): Promise<{ id: string; status: string }>;   // throws BufferMutationError on MutationError
  deletePost(postId: string): Promise<void>; }                        // mutation name and allowedActions check from S2(h)
type BufferCreatePostInput = { channelId: string; text: string; schedulingType: 'automatic';
  mode: 'shareNow'|'customScheduled'|'addToQueue'; dueAt?: string; saveToDraft?: boolean;
  assets?: ({image:{url:string}}|{video:{url:string}}|{document:{url:string}})[];
  metadata?: { linkedin?: { linkAttachment?: { url: string; title: string; description: string; thumbnailUrl: string } } /* field names from S2(e) */ } };
class ApiBudget { constructor(repos: Repos, now: () => Date);
  record(provider: 'buffer', headers: Headers): void; allows(provider, purpose): boolean; snapshot(provider): { d1: {limit; remaining}; d30: {limit; remaining} } }
class BufferRoute implements Route<LinkedinPayload> { platform: 'linkedin' /* x, youtube in later phases */ }
```
- `connect(account, {apiKey})` calls `organizations()` once and `channels()` once. The org id is cached in `config.platforms.buffer.organizationId`; the user maps the channel in the dashboard (T0.19), and the choice is saved to `config.platforms.linkedin.bufferChannelId`.
- `health` is a **metered probe** (spec §4.4): **one** `channels(cachedOrgId)` call, run once a day by the daemon and right before each publish, never on the 15-minute timer. The result is cached and served to `cph status` and the dashboard. If the mapped channel is missing or disconnected: `needs_reconnect` with `nextAction: 'Reconnect LinkedIn in Buffer: https://publish.buffer.com/channels'`. The exact disconnect field is UNVERIFIED and comes from Spike S2(d).
- `stage(d)` uses `saveToDraft:true, mode:'addToQueue', schedulingType:'automatic'`. It **asserts the response `post.status === 'draft'`** (exact value from S2(i)). If not, it calls `deletePost(post.id)` at once, marks the draft `failed` with "Buffer did not save this as a draft; it was deleted", writes an audit entry, and raises a toast. If the delete also fails, the toast and a red dashboard card say "Delete it by hand in Buffer now" with a deep link. `stage` is **not called in Phase 0**: the LinkedIn draft lives locally and is reviewed in the dashboard.
- `publish(d, a)` calls `createPost({channelId, text: payload.text, schedulingType:'automatic', mode:'shareNow', metadata: payload.link ? { linkedin: { linkAttachment: payload.link } } : undefined })`, with no `assets` (a link attachment cannot be combined with non-empty assets). It returns `{remoteId: post.id, costUsd: 0}`. Before calling, it runs the pre-publish `health()` probe.
- `cancelScheduled(d)` calls `deletePost(d.remoteScheduledId)` (used from T1.7).
- `checkOnPlatform(d)` reads the post by id where the schema allows (S2), for the `unknown` sweep.
- `remoteUrl` stays unknown until S2(c) finds the field for the live LinkedIn URL. Meanwhile the dashboard links to Buffer's "Sent" view.

- [ ] **Step 1:** Failing tests:
  - every request has `Authorization: Bearer <key>` and goes to `https://api.buffer.com`;
  - HTTP 200 with a `MutationError` union gives a `BufferMutationError` with the message, and the route marks the draft `failed` (Review Focus #4);
  - `publish` sends `mode:'shareNow'` exactly once, and never retries;
  - `stage` sends `saveToDraft:true` and never `shareNow`;
  - **`stage` when the fake returns `status:'scheduled'` (or anything but draft): `deletePost` is called once, the draft is `failed`, and an alert is raised** (Review Focus #8);
  - **route contract:** a `LinkedinPayload` with `text` and every `link` field set reaches the wire: `text`, `linkAttachment.url`, `.title`, `.description` and `.thumbnailUrl` all appear in the recorded request. With `link` absent, no `metadata.linkedin` is sent (Review Focus #7);
  - the API key never appears in any thrown error message (`redact`);
  - a disconnected channel gives `needs_reconnect` with the deep link;
  - `health()` makes exactly one request (`channels`), never `organizations`;
  - **budget:** with remaining-quota headers showing 40 of 250 left in 24 h, a probe or stage throws `BUDGET_LOW` without a request, while a publish still goes out;
  - **30-day simulation:** a fake clock runs the daemon's timers for 30 days of uptime with nothing published, and the fake Buffer records **≤ 300 calls** (expected ≈ 30 daily probes; Review Focus #9).
- [ ] **Step 2:** Source rules:
  - `buffer-sharenow-only`: `shareNow` appears only in `BufferRoute.publish` (types are excluded);
  - `buffer-queue-needs-draft`: every object literal containing `addToQueue` also contains `saveToDraft: true`;
  - `no-buffer-mcp`: the string `mcp.buffer.com` appears nowhere in `packages/`.
- [ ] **Step 3:** Implement. PASS. Commit `feat(daemon): Buffer route for LinkedIn with metered health, budget guard and gated shareNow`.
- [ ] **Step 4 (manual, after U0-B, U0-D, S2):** Paste the Buffer key in the dashboard. The mapping dropdown lists "LinkedIn: The owner". Map it. `cph status` shows it green. Set `platforms.linkedin.linkCard` per S2(e). **No post is sent.**

### Task T0.16: LinkedIn assist fallback

**Files:** Create `packages/daemon/src/routes/assist-linkedin.ts`. Test: `assist-linkedin.test.ts`.

**Interfaces:** Produces `interface AssistKit { copiedText: string; openUrl: string; checklist: string[] }` and `class AssistLinkedinRoute implements Route<LinkedinPayload>`, with `kind:'assist'` and injected `clipboard: {write(s)}` and `opener: (url) => Promise<void>`.
- `handOff` copies `payload.text`, opens `https://www.linkedin.com/feed/`, and returns the checklist: `['Click "Start a post"', 'Paste (Ctrl+V)', 'Check the link preview', 'Click Post', 'Paste the post URL back with record_publication']`.
- `publish()` throws `GateError('WRONG_CHANNEL')`: assist routes never publish themselves. Text prefill via a URL parameter is UNVERIFIED, so it is not used.
- Hand-off still requires a **dashboard approval**. It does not publish, but it is the step before the user's own click, and gating it keeps the audit log complete. **[Architect's call]**. The draft becomes `handed_off`. `record_publication(draftId, url)` validates that the URL host is `www.linkedin.com` and writes `publications` + audit.

- [ ] **Step 1:** Failing tests:
  - `handOff` writes the exact text to the fake clipboard and opens the URL;
  - `publish` throws;
  - `record_publication` with `https://evil.example` is rejected.
- [ ] **Step 2:** Implement with `clipboardy` and `open` in production wiring only. PASS. Commit `feat(daemon): LinkedIn assist fallback route`.

### Task T0.17: Drafts service + publish service

**Files:** Create `packages/daemon/src/services/{drafts.ts,publish.ts,connections.ts,recovery.ts}`, `audit.ts`, `notify.ts`. Test: `publish-service.test.ts`, `drafts-service.test.ts`, `recovery.test.ts`.

**Interfaces:**
- Consumes: transforms registry, `payloadHash`, `ApprovalGate`, route registry, `Repos`.
- Produces:
```ts
class DraftsService {
  create(i: { slug: string; platform: 'devto'|'linkedin'; account?: string; payload?: unknown; authorship?: Authorship }): DraftView;
     // payload omitted -> transform skeleton; payload given -> zod-validated, merged over skeleton
     // devto: authorship forced 'reformatted', payload.body_markdown must equal skeleton's (Claude cannot rewrite full text)
     // linkedin: authorship defaults 'ai-assisted' when payload.text differs from skeleton
     // devto: not_before = content.t0 + 48h (T0 rule from T0.12; NOT canonical_live_at, which is install day for old posts)
  update(id: string, patch: unknown): DraftView;    // recomputes hash; invalidates pending/approved approvals (audit 'draft_edited');
                                                    // if remote_scheduled_id is set, calls route.cancelScheduled (T1.7)
  get(id): DraftView; list(filter?): DraftView[];
  preview(slug, platform): { payload; lint: LintResult[] };
  stage(id): Promise<RemoteRef>;                    // only routes with stage(); audit 'staged'
}
type DraftView = { id; slug; platform; account; route; status; payload; payloadSha256; lint: LintResult[]; notBefore?: string; remoteRef?: string };
class PublishService {
  publish(draftId: string, approvalId: string): Promise<{ status: 'published'|'failed'|'dry_run'; remoteUrl?: string; error?: string }>;
     // gate.authorize -> draft.status='publishing' (same tx) -> if dry_run:<platform> log+return -> route.publish -> publications+audit
     // on a clean route error (the platform said no): status 'failed', audit with redacted error, NO retry
     // on timeout / network error / crash after consume(): status 'unknown' (we cannot know whether it posted), toast, NO retry
  approveAndPublish(approvalId: string, ctx: { checked: string[] }): Promise<…same result…>;
     // dashboard "Approve & publish": gate.approve(mode 'publish_now', Hello) then publish() in the same request,
     // through the same authorize(). "Approve & schedule" does the same with schedule() (T1.7).
  handOff(draftId, approvalId): Promise<AssistKit>;   // authorize, then route.handOff
  recordPublication(draftId, url): void;
}
class RecoveryService {
  sweepOnStartup(): Promise<void>;     // every draft in 'publishing' becomes 'unknown'; then checkOnPlatform where supported
  checkOnPlatform(draftId): Promise<'published'|'failed'|'unknown'>;   // dashboard "Check on platform" button, MCP check_on_platform, cph check
}
```
- `unknown` is resolved to `published` (record the publication) or `failed` (offer a fresh approval) only by `checkOnPlatform` or by the owner marking it by hand on the dashboard card. It is never retried automatically, because a retry could double-post.
- [ ] **Step 1:** Failing tests:
  - `create(devto)` with a modified `body_markdown` gives a validation error `full-text-immutable`;
  - `update` after approval: the approval is `invalidated`, then `publish` gives `HASH_MISMATCH`;
  - `publish` with the dev.to route faked: the fake records exactly one call, the publication row is written, and the audit sequence is `[approval_requested, approved, authorize_ok, publish_started, published]`;
  - a route throw gives draft `failed` and no second call;
  - `dry_run:linkedin=true` means no route call and `status:'dry_run'`;
  - a concurrent double `publish` makes one route call (Review Focus #2);
  - `create(devto)` for a 3-month-old fixture post gives a `notBefore` in the past (T0 from the frontmatter date, not install day);
  - a route that throws a timeout gives draft `unknown` (not `failed`) and no second call;
  - `sweepOnStartup` with one draft left in `publishing` moves it to `unknown` and calls `checkOnPlatform`; a fake dev.to that lists the article gives `published` and a publication row;
  - `approveAndPublish` with Hello `verified` makes exactly one route call; with Hello `canceled` it makes none and the approval stays `pending`.
- [ ] **Step 2:** Implement. PASS. Commit `feat(daemon): drafts, publish and recovery services`.

### Task T0.18: Daemon HTTP API with scoped auth

**Files:** Create `packages/daemon/src/http/{app.ts,auth.ts,api.ts}`, `main.ts`. Test: `api.test.ts` (Hono `app.request()`, no real socket).

**Interfaces:** Produces `createApp(deps): Hono` and these routes (JSON, `Authorization: Bearer <token>`, scope `mcp` or `cli`):

| Method + path | Calls | Scopes |
|---|---|---|
| `POST /api/sync` | `syncContent` | mcp, cli |
| `GET /api/content`, `GET /api/content/:slug` | repos | mcp, cli |
| `GET /api/connections` | health of each (never secrets) | mcp, cli |
| `POST /api/open-dashboard {page}` | the **daemon** mints a one-time 60 s nonce and opens the default browser at `http://127.0.0.1:4646/login?nonce=…&next=/<page>` via `open`. Returns only `{opened: true, page}`; the nonce never leaves the daemon. `page` is validated against an allowlist (`connections`, `connections/<platform>`, `drafts/<id>`, `approvals`, `approvals/<id>`, `content`, `log`) | mcp, cli |
| `GET /api/preview/:slug/:platform` | `DraftsService.preview` | mcp, cli |
| `POST /api/drafts`, `PATCH /api/drafts/:id`, `GET /api/drafts[/:id]` | DraftsService | mcp, cli |
| `POST /api/drafts/:id/stage` | `DraftsService.stage` | mcp, cli |
| `POST /api/approvals {draftId}`, `GET /api/approvals/:id` | `gate.request`, status (`pending`, `approved`, `published` + URL, `denied`, `expired`) | mcp, cli |
| `POST /api/drafts/:id/check` | `RecoveryService.checkOnPlatform` | mcp, cli |
| `POST /api/publish {draftId, approvalId}` | `PublishService.publish` | mcp, cli |
| `POST /api/drafts/:id/handoff {approvalId}`, `POST /api/publications {draftId,url}` | PublishService | mcp, cli |
| `GET /api/log` | audit list (redacted) | mcp, cli |
| `POST /api/dashboard-login-nonce` | one-time nonce, 60 s | **cli only** |

- **Middleware:** reject unless `Host` is `127.0.0.1:4646` or `localhost:4646`. Reject a cross-origin `Origin`. Bearer tokens are compared in constant time.
- **There is no API route that approves, denies, or changes settings.** Those exist only on the cookie-authenticated dashboard router (T0.19), and approving or enabling publishing there also needs Windows Hello (T0.13b). `open-dashboard` gives Claude a signed-in browser tab, which is acceptable only because of Hello; it is a convenience, not a security boundary.
- The server binds only `127.0.0.1`.

- [ ] **Step 1:** Failing tests:
  - no token gives 401;
  - `Host: evil.com` gives 403;
  - the mcp token on `/api/dashboard-login-nonce` gives 403;
  - **the mcp or cli bearer token on `POST /approvals/:id/approve` gives 403** (the dashboard route refuses bearer auth);
  - the response bodies of `/api/connections` and `/api/log` contain no secret (seed a known fake key and assert it is absent);
  - the `publish` response with a gate refusal gives 409 `{code:'PUBLISHING_DISABLED', message}`;
  - `POST /api/open-dashboard` returns a body with no nonce or token-shaped string, calls the injected opener exactly once, and rejects a `page` outside the allowlist with 400.
- [ ] **Step 2:** Implement `main.ts`: load the config, open the DB, build the keystore, secrets, repos, routes, gate, presence verifier and services, run `RecoveryService.sweepOnStartup()`, serve on `127.0.0.1:4646`, and write logs through `redact` to `logs\daemon.log`. Timers in Phase 0 (`setInterval`; croner arrives in Phase 1): content sync and free health probes every 15 minutes; **metered probes (Buffer) once a day**.
- [ ] **Step 3:** PASS. Commit `feat(daemon): loopback HTTP API with scoped tokens`.

### Task T0.19: Dashboard (Connections, Content, Drafts, Approvals, Settings, Log)

**Files:** Create `packages/daemon/src/http/dashboard.ts`, `http/views/{layout,connections,connect-devto,connect-buffer,content,drafts,draft,approvals,settings,log}.ts` (tagged-template HTML, escaped by default), and `http/static/htmx.min.js` (vendored 2.0.11). Test: `dashboard.test.ts`.

**Interfaces:**
- Consumes: services, gate, `SecretStore`, routes.
- Produces cookie session `cph_session` (HttpOnly, SameSite=Strict, Path=/), minted only by `GET /login?nonce=<one-time>`. Every POST carries a CSRF token, either as a hidden field or as the `HX-CSRF` header.

Pages:
- **`/connections`:** one card per platform with the health colour, `who`, and `nextAction`.
  - The **dev.to** card has a deep link to `https://dev.to/settings/extensions`, a paste field and a Test & Save button.
  - The **Buffer** card has 4 numbered steps matching U0-B, a paste field, and then a channel-mapping `<select>` for LinkedIn.
  - Medium and Substack show as blue "manual".
  - Secrets go only into `<input type=password autocomplete=off>`. They are never echoed back, even masked.
- **`/content`:** the posts × platforms matrix with live-check state. **`/drafts/:id`:** the rendered payload, the lint list, and the edit textarea, which calls `PATCH` and shows the hash change.
- **`/approvals`:** one card per pending approval. Each card shows:
  - the exact payload **as the route will send it**: the raw text, plus a LinkedIn-like link card only when `payload.link` is present (it then goes out as `linkAttachment`). Without it, the card says "Preview will be generated by LinkedIn from the page's OG tags";
  - platform, account and route;
  - the cost (`$0.00`) and, for Buffer, the API budget left (24 h and 30 d);
  - `notBefore`;
  - the checklist from `gate.checklist()`.

  Buttons: **Approve & publish** (primary; for a scheduled draft, **Approve & schedule**), **Approve only** (for a publish Claude will start), and **Deny**. The approve buttons stay `disabled` until every box is ticked, which is enforced client side and again on the server. Clicking an approve button makes the daemon show the **Windows Hello** prompt; the card shows "Waiting for Windows Hello…" and updates over htmx when it returns. Keyboard: `j`/`k` move between cards, `a` = Approve & publish.
- **Red cards** at the top of `/approvals`: drafts in `unknown` (with **Check on platform** and "mark as posted / not posted" buttons), stages that did not land as drafts, and (Phase 1) remote scheduled posts cancelled after an edit ("Remote scheduled post cancelled, re-approve").
- **`/settings`:** **Publishing: DISABLED / ENABLED** (the `publishing_enabled` setting, default DISABLED; a red banner on every page while ENABLED; turning it on needs Windows Hello, turning it off does not) and the per-platform `dry_run` toggles. The words "kill switch" appear nowhere.
- **`/log`:** the audit log.

- [ ] **Step 1:** Failing tests:
  - `GET /approvals` without a cookie redirects to a "Run `cph dashboard`, or ask Claude to open the dashboard, to sign in" page;
  - `GET /login?nonce=…&next=/connections/devto` signs in and lands on that page;
  - a reused nonce gives 403;
  - `POST /approvals/:id/approve` without CSRF gives 403;
  - posting with only one of two boxes ticked gives 422 `CHECKLIST_INCOMPLETE`;
  - a valid approve with fake presence `verified` moves the approval to `approved` with `channel='dashboard_hello'`; with `canceled` it stays `pending` and the response says so;
  - **Approve & publish** with presence `verified` results in exactly one fake route call and the card shows the published URL;
  - `POST /settings/publishing {enabled:true}` with presence `canceled` leaves `publishing_enabled='false'`; `{enabled:false}` needs no presence;
  - the approvals page HTML for a LinkedIn draft without `link` contains "Preview will be generated by LinkedIn" and no link-card markup;
  - the rendered HTML of every page never contains the string "kill switch";
  - the connect-devto POST with a fake fetch returning 200 stores the secret, and the page shows `@username`;
  - the HTML never contains the pasted key;
  - a draft text with `<script>` renders escaped.
- [ ] **Step 2:** Implement. PASS. Commit `feat(daemon): htmx dashboard with approvals queue and connect cards`.
- [ ] **Step 3 (manual):** Run `cph dashboard`. The browser opens and is signed in. Click through every page at 1280px and 400px widths. Set Publishing to ENABLED (Windows Hello appears), then back to DISABLED.

### Task T0.20: Daemon client + MCP server (stdio facade)

**Files:** Create `packages/client/src/daemon-client.ts`, `packages/mcp/src/{index.ts,tools.ts,prompts.ts,resources.ts}`. Test: `packages/mcp/test/tools.test.ts`, using the SDK's in-memory transport (`InMemoryTransport.createLinkedPair()`) and a fake `DaemonClient`.

**Interfaces:**
- Produces `class DaemonClient { constructor(opts: { baseUrl: string; token: string; fetchFn?: typeof fetch }) }`, with one method per API route above, typed with the zod schemas exported from `@cph/daemon`'s `api.ts`.
- The MCP server (`@modelcontextprotocol/sdk` 1.32.1, `McpServer` + `StdioServerTransport`) reads `api-token:mcp` from the keyring at start. If the daemon is down, every tool returns `isError` with "Daemon not running: run `cph daemon start`".

Phase 0 tools (snake_case, zod input schemas):

| Tool | Annotations |
|---|---|
| `sync_content`, `list_content`, `get_content{slug}`, `list_connections`, `preview_adaptation{slug,platform}`, `list_drafts`, `get_approval_status{approval_id}`, `get_publish_log` | `readOnlyHint: true` |
| `open_dashboard{page}`, `connect_platform{platform}` (= `open_dashboard` on `connections/<platform>`) | opens a browser tab; returns only `{opened, page}` |
| `create_draft{slug,platform,payload?}`, `update_draft{draft_id,patch}`, `request_approval{draft_id}`, `record_publication{draft_id,url}`, `check_on_platform{draft_id}` | local write (check reads the platform) |
| `stage_remote_draft{draft_id}` | `openWorldHint: true`, description says "creates a PRIVATE draft only" |
| `publish{draft_id, approval_id}`, `hand_off{draft_id, approval_id}` | `destructiveHint: true, openWorldHint: true` |

- **Prompt** `adapt-linkedin{slug}`. It embeds the excerpt, the OG text, the key entities, the fact labels, and the style rules from spec §5.5 (plain, confident, technical; no hype; no emoji walls; no "🧵👇"; numbers only from the source; hook, then one idea taught fully, then 3–5 points, then CTA + link). It tells Claude to call `create_draft` and then fix every lint error before `request_approval`.
- **Resources:** `content://posts/{slug}`, `content://notes/{slug}`, `drafts://{id}`, `connections://status`, `approvals://pending`.
- `connect_platform` description: "Opens the signed-in connect page for this platform in the user's browser. Never ask the user for keys in chat."
- `request_approval` result text: the approval URL plus the polling contract, verbatim: "Ask the owner to approve at <url>. Then call get_approval_status every 15 seconds for up to 10 minutes. Stop when the status is published (report the URL), approved (call publish now), denied or expired. After 10 minutes, stop and say the approval is still waiting." The tool does not block while waiting.
- `publish` description: "Secondary path. Normally the owner clicks Approve & publish in the dashboard and nothing more is needed. Use this only when the approval status is `approved`."

- [ ] **Step 1:** Failing tests:
  - `listTools()` names match the table exactly;
  - `publish` has `destructiveHint===true`;
  - the `request_approval` result text includes the dashboard URL and does **not** include any 6-digit code or token-like string (`redact(text)===text`);
  - no tool's input schema has a field named `api_key`, `token`, `secret` or `password`;
  - a daemon 409 `PUBLISHING_DISABLED` becomes `isError` text "Publishing is DISABLED. The owner can enable it in Dashboard → Settings (Windows Hello required).";
  - the `request_approval` text contains "get_approval_status" and "15 seconds";
  - the `open_dashboard` result contains no nonce or token-shaped string;
  - `getPrompt('adapt-linkedin')` includes the fixture's OG text.
- [ ] **Step 2:** Implement. PASS. Commit `feat(mcp): stdio MCP facade over daemon API`.

### Task T0.21: CLI `cph` + install

**Files:** Create `packages/cli/src/index.ts`, `commands/{status,connect,sync,doctor,install,dashboard,drafts,log,daemon,check}.ts`, `install/{claude-code.ts,claude-desktop.ts,user-settings.ts,task-scheduler.ts}`, `hooks/cph-guard.mjs`. Test: `packages/cli/test/cli.test.ts`, `install.test.ts`, `cph-guard.test.ts` (fake `DaemonClient`, fake `execFile`, temp home and `%APPDATA%` dirs).

**Interfaces:** Produces these commands (commander):
- `cph status` prints the table platform | route | state | who | next action, with a non-zero exit if any configured connection is red.
- `cph connect <platform>` opens the dashboard connect card. In a TTY, `--paste` prompts with hidden input as an alternative.
- `cph sync`.
- `cph drafts [list|show <id>|stage <id>]`.
- `cph log [--limit n]`.
- `cph dashboard` gets a nonce with the cli token and opens `http://127.0.0.1:4646/login?nonce=…` in the default browser via `open`. **The nonce is never printed.**
- `cph daemon start|stop|status` runs in the foreground for development.
- `cph doctor` checks:
  - Node ≥22;
  - pnpm;
  - git;
  - the site repoPath exists and `listPosts()>0`;
  - port 4646 is free or the daemon is up;
  - the master key is present;
  - the state dir is writable;
  - a path with spaces round-trips through `execFile`.
- `cph check <draft>` runs `checkOnPlatform` for an `unknown` draft.
- `cph install` (USER ACTION U0-C). It prints the full list of side effects first, then asks `[y/N]` before **each** numbered step (and `--yes` is not offered):
  1. `ensureMasterKey()`;
  2. `issueApiToken('mcp')` and `issueApiToken('cli')`;
  3. writes `config.json` if it is missing;
  4. writes a Task Scheduler XML (logon trigger, `StartWhenAvailable=true`, `MultipleInstancesPolicy=IgnoreNew`; action `conhost.exe --headless "<node.exe>" "<repo>\packages\daemon\dist\main.js"`, where `--headless` is UNVERIFIED, so check that no window appears and otherwise use a minimized console. The T0.0 spike result decides whether the Hello prompt can appear from this process context; if not, the daemon starts a small visible helper for the prompt);
  5. runs `execFile('schtasks', ['/Create','/TN','content-powerhouse daemon','/XML',xmlPath,'/F'])`;
  6. links `cph` globally: `execFile('pnpm', ['link','--global'], { cwd: join(repoRoot,'packages','cli') })` (`pnpm --filter @cph/cli link --global` fails with `ERR Unknown option: 'recursive'`). This is a normal install step now, not optional;
  7. **registers Claude Code at user scope:** `execFile('claude', ['mcp','add','--scope','user','content-powerhouse','--','node', mcpEntry])`, where `mcpEntry` is the absolute path with spaces as one array element. If `claude` is not on PATH, it prints the command instead;
  8. **registers Claude Desktop:** reads `%APPDATA%\Claude\claude_desktop_config.json` (creates it if missing), writes a timestamped `.bak`, merges `mcpServers["content-powerhouse"] = { "command": "node", "args": ["<repo>\\packages\\mcp\\dist\\index.js"] }` without touching other keys, writes it back, and tells the owner to restart Claude Desktop. No `.mcpb` is needed;
  9. **user-scope Claude settings:** reads `~/.claude/settings.json`, writes a `.bak`, and merges (never replaces):
     - `permissions.ask`: `mcp__content-powerhouse__publish`, `mcp__content-powerhouse__schedule` (skipped if `claude.askOnPublish=false`);
     - a `hooks.PreToolUse` entry running `node "<repo>\packages\cli\hooks\cph-guard.mjs"` for claude-in-chrome, Bash and PowerShell tool calls. The hook reads the tool input JSON from stdin and blocks (exit code 2 with a reason) when a claude-in-chrome input mentions `127.0.0.1:4646` or `localhost:4646`, or a Bash/PowerShell command mentions `content-powerhouse` together with any of `keyring`, `Credential`, `cmdkey`, `api-token`, `master-key`, or the state dir `%LOCALAPPDATA%\content-powerhouse`. Check matcher and exit-code semantics against current Claude Code hook docs at build time (UNVERIFIED);
  10. prints the residual-risk note (spec R1): these rules are bypassable, Hello is the real gate, and Claude must never run in a permission-bypass mode while platforms are connected.

- [ ] **Step 1:** Failing tests:
  - `cph dashboard` stdout does not contain the nonce;
  - `install` calls `execFile` with an args array whose `/XML` path contains spaces unquoted (an array element, not a shell string);
  - `install` with every prompt answered "n" makes **no** `execFile` call and writes no file;
  - the `claude mcp add` call includes `--scope`, `user`, and the MCP entry path as a single argument;
  - the Desktop config merge keeps an existing unrelated `mcpServers.other` entry, writes a `.bak`, and is idempotent (running twice leaves one entry);
  - the user-settings merge keeps existing `permissions.allow` entries and existing hooks, and is idempotent;
  - `cph-guard` blocks `{"tool_name":"mcp__claude-in-chrome__navigate","tool_input":{"url":"http://127.0.0.1:4646/approvals"}}` and a Bash command `node -e "require('@napi-rs/keyring')…content-powerhouse…master-key"`, and allows `git status` and a chrome navigation to `https://dev.to`;
  - `doctor` reports `site repo: OK (N posts)` where N equals the number of fixture posts in the fixture dir (3: `sample-post`, `crlf-bom-post`, `unknown-jsx`), and the integration variant against the real clone (`CPH_SITE_REPO`) expects 15;
  - `status` exit code is 1 when the fake reports `needs_reconnect`.
- [ ] **Step 2:** Implement. PASS. Commit `feat(cli): cph install with user-scope Claude Code + Desktop registration and cph-guard hook`.
- [ ] **Step 3 (manual, U0-C):** Ask the user, then run `pnpm build && node packages/cli/dist/index.js install` and answer each prompt with the user. Sign out and back in to Windows, or run `schtasks /Run /TN "content-powerhouse daemon"`. Confirm `cph status` (now on PATH) reaches the daemon. Start Claude Code in `D:\Projects - Community`: `/mcp` lists `content-powerhouse` with the Phase 0 tools. Restart Claude Desktop: its tools list shows `content-powerhouse`. In Claude Code, ask "open the content-powerhouse dashboard": the signed-in dashboard opens. Ask Claude to navigate claude-in-chrome to `http://127.0.0.1:4646/approvals`: `cph-guard` blocks it.

### Task T0.22: Phase 0 spikes (time-boxed, with written findings)

**Files:** `spikes/S1-mcp-v2/README.md`, `spikes/S2-buffer/README.md`, `spikes/S3-devto-svg/README.md`, and throwaway scripts. Nothing in `packages/` depends on `spikes/`.

- [ ] **S1 MCP SDK v2 (≤1 day).** Port `tools.ts` to `@modelcontextprotocol/server` 2.3.1 in the spike folder (`npx @modelcontextprotocol/codemod v1-to-v2`). Register it under a different name in Claude Code **and** Claude Desktop. Record: do the tools list, do calls work, does elicitation render (Claude Code ≥2.1.76; Desktop UNVERIFIED)? Decision rule: switch only if both clients work.
- [ ] **S2 Buffer (≤1 day, after U0-B).** Use **read-only** GraphQL and **drafts only** (`saveToDraft:true`). Never `shareNow` in the spike. Introspect the schema. Then answer each item and update `buffer-client.ts` types:
  - (a) is `shareNow` in the `ShareMode` enum? **Is there a native media upload mutation?** (If yes, R2 is dropped for Buffer in Phase 2.) The asset input shape for `video` and `document`;
  - (b) X cost pass-through: ask Buffer support or read their docs. UNVERIFIED until answered;
  - (c) is there a field on `Post` that gives the live LinkedIn URL after sending?
  - (d) how a disconnected channel appears;
  - (e) the LinkedIn `metadata.linkedin.linkAttachment` input fields (url, title, description, thumbnail). **Decision for T0.8:** if confirmed, set `platforms.linkedin.linkCard=true`; if not, `link` is removed from the LinkedIn payload before T0.23 and the card shows the OG-tags note;
  - (f) the X thread input and the Free-plan "Threaded posts: 1" meaning: one scheduled thread **at a time** or one **in total**, and whether publish-now threads count. Read from the schema, docs and Buffer support, not by posting. Decides whether T1.1 threads can be enabled on Free;
  - (g) the Free-plan scheduled-posts limit behaviour (10 per channel);
  - (h) the delete-post mutation name, its input, and `allowedActions` / `deletePost` on a draft and on a scheduled post (needed by T0.15 stage undo and T1.7 cancellation);
  - (i) the `post.status` value returned for a `saveToDraft:true` post, and the **names of the remaining-quota response headers** for the 15 min, 24 h and 30 d windows (needed by `ApiBudget`);
  - (j) deferred to Phase 2 (needs an asset host): when Buffer downloads an asset URL. See T2.7.

  Count the spike's own API calls and stay under 100 total (the Free budget is 250 per 24 h). Delete the spike drafts in Buffer afterwards. **Ask the user before deleting** anything in their account. Drafts the spike created are fine to remove once the user OKs it.
- [ ] **S3 dev.to SVG (≤2 h, after U0-A).** Stage one **private** dev.to draft whose body references one site SVG and one PNG. Open the preview: does the SVG render? Record the result. If it doesn't, SVGs become a text link (or the site's PNG twin, if proposal P2 exists) until Phase 2 adds an asset host. Leave the draft unpublished, then ask the user whether to delete it.

### Task T0.23: Phase 0 acceptance (dry-run e2e + manual walkthrough)

**Files:** Test `packages/daemon/test/e2e-phase0.test.ts`, which runs the whole daemon in-process against the fixture site dir with fake fetch for the site, dev.to and Buffer.

- [ ] **Step 1:** E2E test script (fake presence, fake fetch):
  1. sync → content live → `t0` equals the fixture's frontmatter date;
  2. `create_draft(devto)` → `stage` (assert the fake dev.to received `published:false` + canonical, and no image placeholder) → stage again after the fake marks the article published: `StageRefused`, no PUT;
  3. `create_draft(linkedin, payload with a good adaptation)` → `request_approval` ×2 (the result includes the polling instructions);
  4. dashboard **Approve only** on LinkedIn with presence `canceled` → still `pending`; again with presence `verified` → `approved`;
  5. with **`publishing_enabled=false`**: `publish(linkedin)` gives `PUBLISHING_DISABLED`;
  6. enabling publishing with presence `canceled` fails; with presence `verified` → `publishing_enabled=true`;
  7. `publish(linkedin)` → the fake Buffer receives `shareNow` once, with every hashed field on the wire (text, plus `linkAttachment` if `linkCard=true`);
  8. a second draft approved with **Approve & publish** posts once, with no MCP `publish` call, and `get_approval_status` returns `published` with the URL;
  9. `publish(devto)` with no approval gives `NO_APPROVAL`;
  10. the audit log has every step, with `actor_channel='dashboard+hello'`;
  11. the fake Buffer recorded ≤ 10 calls in total for the run (no 15-minute probing).

  Expected: PASS.
- [ ] **Step 2 (manual, after U0-A..E):** Do spec Appendix A steps 1–5 for real with Claude Code, started from `D:\Projects - Community` to prove user-scope registration. Stop at the approval card. Confirm exit criteria 1–5 and 7.
- [ ] **Step 3 (manual, optional, only if Q4 = live test and after U0-F):** Set Publishing: ENABLED (Hello), click **Approve & publish** on the one LinkedIn card (Hello), then `cph log`. Afterwards set Publishing back to DISABLED.
- [ ] **Step 4:** Ask the user whether to keep or delete the test dev.to draft.
- [ ] **Step 5:** Commit and offer a PR or merge. **Ask before pushing.**

---

# Phase 1: Text everywhere

**Goal:** One launch plan per post sends native, approved versions to:
- LinkedIn and X (via Buffer; X as a **single post** by default);
- Bluesky and Mastodon (direct);
- dev.to (direct, full text after T0 + 48 h);
- Hashnode, Medium, Substack, Reddit and LinkedIn Articles (assist kits);
- Hashnode direct, optionally, if the user buys Pro.

SEO order and delays are enforced. Each public action is approved on its own, with Windows Hello.

**Exit criteria (visible):**
1. The Systems Performance ch.1 post, once it is live on the site, shows a launch plan in `/content/<slug>` with every destination, its `notBefore` (from T0), and its state.
2. Each social excerpt is approved one by one and goes out on T0 → T0+1 d. dev.to is approved and published at ≥ T0+48 h. The Medium, Substack and Hashnode kits are handed off and their URLs recorded.
3. A scheduled Buffer post fires with the PC off. A direct-route job that is more than 2 hours late shows as `held`, with a toast.
4. Editing a draft that Buffer holds as a scheduled post (or changing the MDX) deletes the Buffer post and shows a red "Remote scheduled post cancelled, re-approve" card.
5. Every approval went through a Hello-verified dashboard click (or the elicitation fallback, if T0.0 failed).

**Phase 1 cost: $0/month baseline.**
- No asset host is needed in Phase 1 (R2 moves to Phase 2): kits hand the owner local PNG files, Bluesky and Mastodon take native uploads, LinkedIn uses a link card, and dev.to links interactive diagrams.
- Buffer Free stays $0 with LinkedIn + X (2 of 3 channels). X is a single post, which the Free plan allows.
- Buffer API budget: a launch is about 2–4 Buffer publishes plus a pre-publish probe each, so roughly 10 calls per post, against 250 per 24 h and 3,000 per 30 d.

Optional extras:
- **Buffer Essentials for X threads** (Q7): billed per connected channel, **$10/mo** for LinkedIn + X ($15 once YouTube is connected in Phase 2) ([buffer.com/pricing](https://buffer.com/pricing)). Only if S2(f) shows Free blocks the threads you want. The free alternative is X intent links.
- **Hashnode Pro** $5/mo or $50/yr (≈$4.17/mo), if Q11 = yes ([hashnode.com/pro](https://hashnode.com/pro)).
- **X direct pay-per-use**, only if Buffer can't do X: a **prepaid credit purchase** first (minimum amount UNVERIFIED; the $20 bonus needs a saved card and a first purchase), then about $3/mo at the spec workload ($0.015/post, $0.20/post with a URL), under a hard $5 cap ([X pricing](https://docs.x.com/x-api/getting-started/pricing)).
- **Buffer Essentials** at $5/channel/mo also if the 10-scheduled-posts-per-channel cap binds.

Expected total: **$0/month**, about $4 with Hashnode Pro, and $10–15 more if you pay for X threads.

### USER ACTIONS for Phase 1

| ID | What | Exact steps | Cost |
|---|---|---|---|
| U1-A | Connect X in Buffer | buffer.com → Connect channel → X → authorize (2nd of 3 Free channels). Answer Q7 (single post vs threads) | $0 |
| U1-B | Bluesky app password | bsky.app → Settings → Privacy and security → **App passwords** → Add `content-powerhouse` → paste the handle + password into `/connections/bluesky`. For video later, confirm the account email is verified | $0 |
| U1-C | Mastodon token | In `/connections/mastodon`, enter the instance (e.g. `hachyderm.io`). The link opens `https://<instance>/settings/applications/new`. Name it `content-powerhouse`, scopes `write:statuses write:media read:accounts` → Submit → copy "Your access token" → paste | $0 |
| U1-D | (moved) Cloudflare R2 | Moved to Phase 2 as U2-G, and only if S2 finds no native Buffer upload | — |
| U1-E | One-time manual-platform cards | Medium: are you logged in? Any pre-2025 integration token (Q6)? Substack: the publication URL. Reddit: the target subreddits + rules (Q16) or skip. Answer Q6, Q7, Q10, Q11, Q14 | $0 |
| U1-F | (If Q11 = yes) Hashnode Pro | hashnode.com/pro → subscribe ($5/mo or $50/yr) → hashnode.com/settings/developer → Generate token → paste → choose the publication | $5/mo or $50/yr |
| U1-G | (If Q7 = X direct) X developer app | console.x.com → create a project/app → OAuth 2.0, Native App, callback `http://127.0.0.1:53682/callback/x` → paste the client ID in `/connections/x` → add a card, **buy the first prepaid credits**, **set the spend cap to $5, auto-recharge OFF** → `cph connect x` | prepaid top-up, then ~$3/mo, $5 cap |
| U1-H | Search Console | After each site publish, request indexing for the canonical URL in Google Search Console. This is a manual checkbox on the launch plan | $0 |

### Task T1.1: Shared social-transform helpers + X post transform via Buffer

**Files:** `packages/core/src/transforms/x.ts`, the extended `routes/buffer.ts` (platform `x`), `routes/assist-x.ts`. Tests: `x.test.ts`, `buffer-x.test.ts`.

**Interfaces:**
- `interface XPayload { posts: string[] }`. **Default (`platforms.x.threads=false`): exactly 1 post**, ≤280 graphemes, carrying one complete takeaway and the UTM link. Threads (2–8 posts) are allowed only when `platforms.x.threads=true`, which is set after S2(f) confirms "one at a time" and that publish-now threads don't count, or after the owner moves to Buffer Essentials (Q7).
- Lint:
  - single-post mode: exactly 1 post, ≥ 1 complete takeaway (the `li-takeaway`-style proxy, scaled: ≥ 140 graphemes before the link), exactly one URL;
  - thread mode: 4–8 posts, **exactly one URL, in the last post** (`x-link-last`);
  - each `graphemeLength ≤ 280` (unless Q6 says Premium; even then, keep 280 by default);
  - numeric provenance;
  - no "🧵👇".
- Buffer publish:
  - single post: `createPost({channelId, text: posts[0], mode:'shareNow'})`;
  - thread: `createPost({channelId, text: posts[0], metadata:{twitter:{thread: posts.map(text => ({text}))}}, mode:'shareNow'})`. Per Buffer's guide, the top-level `text` repeats the first item and the thread array holds **all** posts (not `posts.slice(1)`); the exact item shape comes from S2(f).
- Route contract test: every post in `posts` reaches the wire.
- Assist fallback: the X web intent `https://x.com/intent/post?text=<encoded>`, one per post, opened in sequence with a checklist ($0). The intent URL host is UNVERIFIED (`twitter.com/intent/tweet` is the legacy form), so check it at build time. This is also the free way to post a thread on Buffer Free.
- `costEstimate`:
  - Buffer route: 0, unless S2(b) shows a pass-through;
  - direct route: `0.015*(n-1) + 0.20`.

**Tests:**
- single-post mode rejects a 2-post payload with `x-single-post`;
- a link in post 2 of a thread fails `x-link-last`;
- a 281-grapheme post fails;
- the thread request has top-level `text === posts[0]` and a thread array of length `posts.length`;
- a `MutationError` on the Free thread cap surfaces as a readable `failed` reason: "Buffer Free allows only 1 threaded post; post a single post, use X intent links, or upgrade (Q7)".

**Manual:** after U1-A, make one dry-run per Buffer channel (`dry_run:x=true`) and inspect the rendered post in the dashboard.

### Task T1.2: Bluesky direct route

**Files:** `core/src/transforms/bluesky.ts`, `daemon/src/routes/bluesky.ts`. Test with a fake `fetch` injected into `AtpAgent` (`@atproto/api` 0.28.0 accepts a custom fetch; confirm the option name).

**Interfaces:**
- `BlueskyPayload { posts: string[] }` (2–4 posts, ≤300 graphemes, link facet + external embed card on the last post). Card thumbnails and images are uploaded natively with `uploadBlob`, so no asset host is needed.
- `connect` uses `createSession` once. Sessions are stored encrypted and `refreshSession` is reused; there is **never one session per post** (300/day cap). Publishing a thread uses `createRecord` with `reply.root/parent`.

**Tests:**
- the facet byte offsets are correct for text with `ρ` and emoji (UTF-8 byte indices);
- a second publish reuses the session (no `createSession` call);
- an expired access token triggers `refreshSession` once;
- route contract: every post, the facet and the embed card fields reach the wire.

### Task T1.3: Mastodon direct route

**Files:** `core/src/transforms/mastodon.ts`, `daemon/src/routes/mastodon.ts`.

**Interfaces:**
- `MastodonPayload { posts: string[]; visibility: 'public' }`.
- The limits come from a cached `/api/v2/instance` `configuration.statuses.max_characters` (default 500).
- `POST /api/v1/statuses` with `Idempotency-Key = payloadSha256`; replies go via `in_reply_to_id`. Images go through `/api/v2/media` (native upload).
- `connect` = `verify_credentials`.

**Tests:**
- the `Idempotency-Key` header equals the draft hash;
- the instance limit is respected;
- a 429 is handled per T0.14.

### Task T1.4: Asset pipeline (local files; no public host in Phase 1)

**Files:** `daemon/src/assets/{rasterize-svg.ts,snapshot.ts,asset-host.ts}`.

**Interfaces:**
- `svgToPng(svg: Buffer, width=1600): Buffer` (resvg).
- `snapshotElement(url: string, selector: string, outPath: string): Promise<void>`. It uses Playwright Chromium, and its **URL allowlist is exactly the host `www.example-blog.dev`**; a source rule enforces that this is the only Playwright use.
- `interface AssetHost { put(localPath, sha256, contentType, opts?: { dueAt?: string }): Promise<{ publicUrl: string; expiresAt: string }>; probe(): Promise<boolean> }`. **Phase 1 ships only `NoPublicHost`**, which throws `NoAssetHost` if any route asks for a public URL. `R2AssetHost` (or a Buffer native upload) arrives in Phase 2 (T2.7).

**Wiring:**
- `assets` rows are deduplicated by sha256, stored under `%LOCALAPPDATA%\content-powerhouse\assets\`.
- Kits (Medium, Substack, Hashnode-free, LinkedIn Article) list the local PNG paths for the owner to drag in.
- dev.to keeps the text-link rendering for interactive diagrams (T0.7) until Phase 2.
- Media hashes go into `payloadHash`.

**Tests:**
- a snapshot outside the allowlist host throws;
- an identical sha256 is stored once;
- a route that asks `NoPublicHost` for a URL fails lint before approval (never at publish time).

### Task T1.5: Numeric provenance with fact labels + verify checklist everywhere

**Files:** `core/src/lint/numbers.ts` (extended), `core/src/lint/facts.ts`.

**Interfaces:**
- `findUnsourcedNumbers` also accepts `notes.factLabels`.
- New warning `fact-label-illustrative`: an adaptation uses a number that the fact labels mark "Illustrative" without the word "illustrative" or "example" nearby.
- Every Claude-written transform (x, bluesky, mastodon, substack edition, reddit) runs it as an error.

**Tests:**
- use fixture fact labels;
- the Systems Performance numbers when that post exists. A canary test, skipped until the slug is present, asserts that `1 − 0.99^100` written as "63%" is accepted only if "63" is in the source.

### Task T1.6: (moved) Windows Hello is now T0.13b; the out-of-band code channel is dropped

Windows Hello moved into Phase 0 (T0.0 spike, T0.13b implementation) and is mandatory. The 6-digit out-of-band code channel from revision 1 is dropped: a model with screenshots can read the Windows toast and the dashboard card, so the code adds nothing over a Hello-verified click. There is no `confirm_code` parameter anywhere.

### Task T1.7: Launch plan + SEO `notBefore` + scheduler + held-if-late + remote-schedule cancellation

**Files:** `daemon/src/services/launch-plan.ts`, `daemon/src/scheduler.ts` (croner 10.0.1), `daemon/src/services/remote-schedule.ts`, MCP tools `plan_launch`, `schedule`, `cancel_scheduled`.

**Interfaces:**
- `planLaunch(slug, opts?: { destinations?: PlatformId[]; t0?: string }): DraftView[]` creates one draft per destination with `notBefore` per spec §5.2:
  - social: T0 to T0+1 d;
  - dev.to, Hashnode, Medium: T0+48 h;
  - Substack: T0+3 d;
  - Reddit, LinkedIn Article: T0+1 d.

  T0 defaults to `content.t0` (the T0 rule from T0.12: the frontmatter date, unless the deploy was more than a day late). For a back-catalogue post, every `notBefore` may already be in the past, which is correct.
- `schedule(draftId, approvalId, scheduledAt)` requires `scheduledAt ≥ notBefore`. The hash includes `scheduledAt`. The dashboard's **Approve & schedule** calls the same path.
  - **Buffer route:** calls `createPost(mode:'customScheduled', dueAt)` **at approval-consumption time**, so Buffer fires it even with the PC off, and stores the returned post id as `drafts.remote_scheduled_id`, status `scheduled`. The prechecks (canonical live, lint, health, cost cap) run **at hand-over**, not at fire time (spec §2.6 rule 5).
  - **Direct routes:** insert a `jobs` row; the prechecks run again at fire time.
- **Remote-schedule cancellation** (`RemoteScheduleService.onInvalidated(draftIds)`, wired into `syncContent.onInvalidated`, `DraftsService.update` and `cancel_scheduled`). For each draft with a `remote_scheduled_id`:
  1. call `route.cancelScheduled(d)` (Buffer: the delete-post mutation from S2(h), after checking `allowedActions`);
  2. on success: clear `remote_scheduled_id`, mark the draft `source_changed` (or `draft` after a plain edit), audit `remote_cancelled`, and show the red card "Remote scheduled post cancelled, re-approve";
  3. on failure: a red card "Could not cancel the scheduled post in Buffer. Delete it by hand now" with a deep link, plus a toast. Never silent.
- The scheduler ticks every minute. A direct-route job that is more than 2 h late becomes `held`, sends a toast, and is never sent late. Approval TTL for a scheduled post = fire time + 15 min.
- The Q1 answer (launch-plan approval) changes only `/approvals` UI grouping, never the one-approval-per-action data model.

**Tests:**
- `planLaunch` dates for a fixed T0, and for a 3-month-old post (all `notBefore` in the past);
- `scheduledAt < notBefore` is rejected;
- a fake clock 2 h 1 m late gives `held`;
- Buffer `customScheduled` is sent with an ISO UTC `dueAt`, and `remote_scheduled_id` is stored;
- **editing the MDX while a Buffer post is scheduled:** sync calls the fake Buffer delete exactly once, the draft is `source_changed`, the red card exists, and a later `publish` with the old approval is refused;
- **editing the draft text while scheduled:** same, via `DraftsService.update`;
- a failing delete leaves a red "delete it by hand" card and a toast;
- `cancel_scheduled` on Buffer calls the delete mutation, or marks it locally for direct routes.

### Task T1.8: Assist kits (Medium, Substack, Hashnode-free, Reddit, LinkedIn Article)

**Files:** `core/src/transforms/{medium-kit.ts,substack-edition.ts,hashnode.ts,reddit.ts,linkedin-article.ts}`, `daemon/src/routes/assist-generic.ts`, `daemon/src/clipboard-html.ts`.

**Interfaces:** each kit is `AssistKit` plus `files: {path, purpose}[]` (local PNGs from T1.4; no public host needed).
- **Medium:**
  - `openUrl` is the "Import a story" page (`https://medium.com/p/import`; check the URL);
  - the kit has the canonical URL to paste, the title and subtitle, ≤5 topics, and the PNGs for tables and interactive diagrams;
  - it has an ordered fix-up checklist, which adds the disclosure line only if `ai-assisted`;
  - it is detected afterwards via `medium.com/feed/@<user>`.
- **Substack edition:** `authorship:'ai-assisted'`. Contents:
  - an "Originally published at" header line;
  - a 300–600 word summary written by Claude through prompt `adapt-substack-edition`;
  - 2–3 key graph PNGs;
  - a "Read the full deep-dive" link.

  It is copied as HTML through `powershell.exe -NoProfile -Command "Set-Clipboard -AsHtml"`. `-AsHtml` exists in Windows PowerShell 5.1 and not in PowerShell 7, so call `powershell.exe` explicitly; UNVERIFIED, test manually. `openUrl` is `<publication>/publish/post`.
- **Hashnode-free:** markdown (the dev.to renderer with Hashnode tag rules, ≤5) + "Are you republishing? → Original URL" checklist.
- **Reddit:** for each subreddit, a title and body, plus `https://www.reddit.com/r/<sub>/submit?type=link&title=<t>&url=<canonical+utm>`, with the link last.
- **LinkedIn Article:** rich HTML + checklist, treated like Substack (no canonical).
- **X thread via intent links** (when Q7 = intent links): one `x.com/intent/post` URL per post, opened in order, with a checklist.
- All kits use `hand_off` (approval-gated with Hello, as in T0.16), then `record_publication`.

**Tests:**
- each kit snapshot;
- the Substack edition word count is within 300–600;
- the Medium kit never contains a paywall instruction unless Q12 = yes;
- the `open` URLs match an allowlist of platform hosts.

**Manual:** one dry-run hand-off of each kit for the fixture post, with the user. Nothing is submitted.

### Task T1.9: Hashnode Pro direct route (only if Q11 = yes)

**Files:** `daemon/src/routes/hashnode.ts`.

**Interfaces:**
- GraphQL at `https://gql.hashnode.com`. Check the endpoint.
- `stage` = `createDraft(input:{publicationId, title, contentMarkdown, originalArticleURL, tags})`. Re-stage follows the same rule as dev.to: only for drafts in `draft`/`staged`, and only after reading the draft back.
- `publish` = `publishDraft(input:{draftId})`.
- `me { username publications }` for health.
- HTTP 200 with `errors[]` is treated as a failure.
- Source rule: the string `publishPost` is forbidden.

**Tests:**
- `errors[]` at 200 gives `failed`;
- `originalArticleURL` equals the canonical;
- `publishDraft` appears only in `publish()`;
- route contract: every hashed field reaches the wire.

### Task T1.10: Spend caps, cost on cards, `cph doctor --prices`

**Files:** `daemon/src/spend.ts`, `cli/src/commands/doctor.ts`.

**Interfaces:**
- `spend.reserve(platform, usd): void` throws `CAP_EXCEEDED` (a new `GateCode`) and runs inside `authorize`.
- Caps live in settings: `cap:x=5`, with a warning at 80%. The ElevenLabs cap is **not** a fixed setting: it is sized at runtime from `GET /v1/user/subscription` (T2.1).
- The approval card shows the cost and, for metered providers, the quota left (Buffer API budget from `api_budget`; ElevenLabs characters).
- `doctor --prices` prints each pricing URL from this plan's tables with its "last verified" date.

**Tests:**
- the cap is reached exactly at the boundary;
- the card shows `$0.20` for an X direct post with a URL.

### Task T1.11: X direct fallback (only if Q7 = X direct)

**Files:** `daemon/src/routes/x-direct.ts`, `daemon/src/oauth/loopback.ts`.

**Interfaces:**
- PKCE (S256) loopback on `127.0.0.1:53682`, with a `state` check and scopes `tweet.write tweet.read users.read offline.access`.
- Rotating refresh tokens are saved atomically.
- Health uses token-expiry maths only. There are **no billed read probes**.
- `costEstimate` follows T1.1. `spend.reserve` caps at $5. Credits are **prepaid** in the X Developer Console; the connect card says so and links to the billing page (the user buys the credits, never the tool).

**Tests:**
- a `state` mismatch is rejected;
- a refresh-token rotation persists the new token before use;
- no read call is made in `health()`.

### Task T1.12: `cph backup`, `cph revoke-all`, `cph disconnect`

**Files:** `cli/src/commands/{backup,revoke-all,disconnect}.ts`, `daemon/src/backup.ts`.

**Interfaces:**
- `backup(outPath, passphrase)` writes a copy of the DB (made with the SQLite online backup API) plus the master key, encrypted with scrypt+AES-GCM using the passphrase, which is prompted with hidden input.
- `revoke-all` calls `SecretStore.wipeAll()` and prints the revoke links for each platform: dev.to Extensions, `publish.buffer.com/settings/api`, Bluesky app passwords, Mastodon applications, R2 tokens (if any) and ElevenLabs keys. It also reminds the owner to check that Buffer's Claude integration is off in claude.ai.

**Tests:**
- a restore round trip on a temp dir;
- a wrong passphrase fails;
- `revoke-all` leaves the `credentials` table empty.

### Task T1.13: Phase 1 acceptance

- E2E dry-run over all routes with fakes, including the remote-schedule cancellation path and a 30-day Buffer budget simulation with a full launch in it (≤ 400 calls).
- Manual: the real launch of the first launch article, with each public action individually approved by the owner (Hello), in the order of spec §5.2.

---

# Phase 2: Video (YouTube Shorts + LinkedIn video)

**Goal:** Article → 45–60 s vertical short in the user's cloned voice, with three human gates (script, final cut, then publish per platform), published to YouTube Shorts and LinkedIn through Buffer.

**Exit criteria (visible):**
1. One short of the first launch article is approved at Gate A (script), Gate B (watch the MP4 in the dashboard) and Gate C (one Hello-verified approval per platform).
2. It is live on YouTube Shorts and LinkedIn.
3. It took under 30 minutes of the user's time.
4. `cph log` shows the TTS characters used and the quota left.

**Phase 2 cost: about $22–24/month.**
- **ElevenLabs Creator:** $22/mo, 50% off the first month, so **$11** ([elevenlabs.io/pricing](https://elevenlabs.io/pricing)). Starter at $6 has no Professional Voice Clone.
  - **Included quota is ambiguous.** The main pricing page lists **121k credits/mo** in "one shared monthly credit pool" (1 credit per character for Multilingual v2). The API pricing page lists **275k v4 characters** for Creator and says "API usage is billed in US dollars, not credits" ([elevenlabs.io/pricing/api](https://elevenlabs.io/pricing/api)). Whether these are separate pools is UNVERIFIED, so U2-A answers it before subscribing.
  - At the base case (8 shorts × ~3k chars ≈ 24k) either pool is enough. At the sensitivity case (43 shorts ≈ 129k chars), Creator covers it only if the API has its own 275k pool; otherwise it runs ~8k over (≈ $0.65 at the $0.08/1K pay-as-you-go rate, if overage is billed that way, UNVERIFIED) or needs Pro at $99.
- **Music bed:** optional, about $0.15 per short (research 05; UNVERIFIED this pass).
- **Remotion:** $0 for individuals and teams of ≤3 ([remotion.dev/terms](https://www.remotion.dev/terms)). The company seat price is UNVERIFIED and does not apply.
- **Buffer Free:** $0, with YouTube as the 3rd of 3 channels. (If you took Essentials for X threads, connecting YouTube adds $5: $15/mo total.)
- **Asset host:** $0. Buffer's native upload if S2(a) found one; otherwise Cloudflare R2 within the free tier, **with a payment method on file** (U2-G).
- **Running total:** **≈ $22–24/month**, ≈ $11–13 in the first month.

### USER ACTIONS for Phase 2

| ID | What | Exact steps | Cost |
|---|---|---|---|
| U2-A | Answer Q9, resolve the quota question, then subscribe | 1) **Before paying**, settle whether Creator's API usage comes out of the 121k credits or a separate 275k-character pool: ask ElevenLabs support, or check the subscription page after a Starter trial. Record the answer in `spikes/S6-elevenlabs-quota/README.md`. 2) elevenlabs.io → Pricing → **Creator** → pay. Re-check the price on the day, since v4 pricing changed on 2026-09-28 | $11 first month, then $22/mo (≈$18.33/mo billed annually, per research 05, UNVERIFIED) |
| U2-B | Record the Professional Voice Clone | 1) A quiet room and a decent USB mic (optional one-time purchase). 2) Record **30–60 min** of clean narration in your normal explainer voice: read your own articles aloud, at a consistent distance, no music, no background noise. Export WAV or high-bitrate MP3. 3) ElevenLabs → Voices → Add voice → **Professional Voice Clone** → upload → complete the **voice captcha** live (read the shown text). 4) Wait for fine-tuning (minutes to hours). 5) Copy the voice ID | $0 beyond the plan |
| U2-C | ElevenLabs API key | elevenlabs.io → Profile → API keys → Create. Set a character quota limit if offered → paste into `/connections/elevenlabs`, then pick the PVC voice from the list | $0 |
| U2-D | Connect YouTube in Buffer | buffer.com → Connect channel → YouTube → authorize the channel. The channel must be phone-verified for longer uploads (Q6) | $0 |
| U2-E | Answer Q15 | Keep the line "Narrated by me, using an AI clone of my own voice"? | — |
| U2-G | (Only if S2(a) found no native Buffer upload; answer Q8 first) Cloudflare R2 | dash.cloudflare.com → R2 → enable R2. Third-party guides say Cloudflare asks for a **payment method** (card or PayPal) before the first bucket; no charge within the free tier (UNVERIFIED officially). → Create bucket `cph-media` → Settings → lifecycle rule "delete after 14 days" → R2 → *Manage API tokens* → Create token, **Object Read & Write**, scoped to `cph-media` → paste the account ID, access key ID and secret into `/connections/r2`. This is a 5+ step setup and will not meet the 2-minute connect goal; the dashboard card shows a screenshot per step | $0 within the free tier; card on file |

### Task T2.1: `VoiceProvider` + ElevenLabs client (cached, quota-sized cap)

**Files:** `packages/video/src/voice/{provider.ts,elevenlabs.ts,cache.ts}`.

**Interfaces:**
- `interface VoiceProvider { speak(text: string, opts: { voiceId: string; model: 'eleven_v4'|'eleven_multilingual_v2'|'eleven_flash' }): Promise<{ audioPath: string; chars: { char: string; start: number; end: number }[] }> }`.
- `POST /v1/text-to-speech/{voice_id}/with-timestamps` with header `xi-api-key`. Results are cached by `sha256(text+voice+model+settings)` under `%LOCALAPPDATA%\content-powerhouse\video\cache\`.
- `quota(): Promise<{ used: number; limit: number; resetsAt?: string }>` from `GET /v1/user/subscription` (`character_count`, `character_limit`). **No quota is hard-coded.**
- Before each call: `estimate(chars, model)` → `{ quotaChars, usdIfOverQuota }` (the $0.08/1K and $0.04/1K pay-as-you-go rates are used only for the "if over quota" figure), then refuse if `used + quotaChars > limit` unless the owner raised the cap in the dashboard.
- Gate A cards and `video_voice` results show "N chars from your quota; X of Y left this month".

**Tests:**
- a cache hit makes no fetch;
- a run that would exceed the remaining quota is refused before the call;
- the cap follows a fake `/v1/user/subscription` (changing `character_limit` changes the cap, with no setting edit);
- the key is absent from logs.

### Task T2.2: Spoken vs display text + word alignment

**Files:** `packages/video/src/text/{spoken.ts,align.ts}`.

**Interfaces:**
- `toSpoken(display: string): { spoken: string; map: Span[] }`. For example, `p99.9` → "p ninety-nine point nine" and `ρ` → "rho".
- `alignWords(chars, map): Word[]` maps the alignment back to display tokens.

**Tests:**
- `p99.9`, `ρ`, `S/(1−ρ)`, `1 − 0.99^N` and `16,800` are spoken correctly and display unchanged;
- the alignment covers every display word.

### Task T2.3: `packages/video` Remotion project + 1-hour bake-off

**Files:** `packages/video/remotion/` (Root, compositions), `spikes/S4-hyperframes/README.md`.

**Work:**
- Run the bake-off on the `QueueKnee` scene: Remotion vs HyperFrames. Keep Remotion unless HyperFrames is clearly easier for Claude to write.
- Rendering uses `execFile('npx', ['remotion','render', …])` with args arrays on a spaced path, as a CI smoke test.

### Task T2.4: Scene library with computed charts

**Files:** `packages/video/remotion/scenes/{TitleCard,QueueKnee,LatencyUtilizationCurve,PercentileHistogram,CoordinatedOmissionTimeline,FanOutTail,CTA}.tsx`, plus `packages/video/src/math.ts`.

**Interfaces:** `responseTime(S, rho) = S/(1-rho)` and `fanOutTail(p, N) = 1 - p**N`. These are pure and unit-tested, for example `fanOutTail(0.99,100) ≈ 0.634`. The scenes take props from `scenes.json` and render ≥3 rotating visual templates.

### Task T2.5: Captions + SRT + render + QC

**Files:** `packages/video/src/{captions.ts,render.ts,qc.ts}`.

**Interfaces:**
- Word-highlight captions via `@remotion/captions`, plus an `.srt` writer.
- `render(jobId)` outputs 1080x1920, 30 fps, H.264 CRF ~18, AAC 48 kHz, `+faststart`.
- `qc(mp4)` uses ffprobe/ffmpeg `ebur128` with `execFile` and checks:
  - duration ≤60 s;
  - about −14 LUFS;
  - <100 MB;
  - captions inside the safe area;
  - every on-screen number belongs to the brief (the T1.5 lint).

**Tests:** fixtures for SRT timing; QC thresholds on a tiny generated clip (ffmpeg `testsrc`, generated locally, no download).

**USER ACTION:** if ffmpeg/ffprobe is missing, `cph doctor` reports it. Install with `winget install Gyan.FFmpeg` ($0), and ask the user first.

### Task T2.6: Gates A/B in the dashboard + video MCP tools

**Files:** `daemon/src/video/{jobs.ts,gates.ts}`, `http/views/video.ts`, MCP tools `video_plan`, `video_voice`, `video_render`, `video_preview`, prompt `short-script-60s`.

**Rules:**
- Gate A (script) and Gate B (final cut) are production approvals, recorded on `video_jobs.gate_a_at` and `gate_b_at`, and stored as dashboard-only actions. They spend quota, not reach, so they do not need Windows Hello; Gate C does.
- `video_voice` refuses to run before Gate A. Its result shows the estimate ("3 beats, 980 chars from your quota; 41,200 of 121,000 left").
- **There is no publish tool in the video module.** A source rule enforces it.

**Tests:**
- voice before Gate A is refused;
- a Gate B approval is invalidated if the MP4 sha256 changes.

### Task T2.7: Asset host + Buffer video route for YouTube Shorts + LinkedIn video

**Files:** extended `routes/buffer.ts` (platform `youtube` + LinkedIn video), `core/src/transforms/{youtube-short.ts,linkedin-video.ts}`, `daemon/src/assets/{buffer-upload.ts,r2.ts}`, `spikes/S2-buffer/README.md` (item j).

**Step 0, decide the media path (from S2(a)):**
- **Buffer has a native upload mutation:** implement `BufferUploadAssetHost` and skip R2 entirely.
- **It does not:** implement `R2AssetHost` (after U2-G). Objects go to `cph-media/<sha256>.<ext>`. Presigned GET TTL = `max(24 h, dueAt − now + 24 h)`, capped at S3's **7-day** presign maximum; media posts therefore cannot be scheduled more than 7 days ahead (the scheduler refuses it with a clear reason). The bucket's 14-day lifecycle rule keeps every object until at least `dueAt + 7 d`. If Buffer rejects presigned URLs with query strings, switch to a public bucket with unguessable sha256 keys.
- **S2(j), asset fetch time (draft-only test):** create a Buffer **draft** whose video URL is a presigned R2 URL that expires in 10 minutes. After 15 minutes, read the draft back and check whether Buffer still has the media. If Buffer copied it at create time, a 24 h TTL is enough; if it fetches at send time, the formula above applies. Delete the test draft after asking the user.

**Interfaces:**
- YouTube: `assets:[{video:{url}}]` (or the uploaded asset id), `metadata.youtube {title ≤100 chars incl. #Shorts, category: Science & Technology}`. The description's first line is the canonical URL (with UTM), plus the AI-voice line (Q15). **Buffer has no privacy field (UNVERIFIED), so a `shareNow` goes public at once.** The approval card says "Goes public on YouTube immediately; Buffer has no private mode".
- LinkedIn video: the same MP4, with the canonical in the text.
- The media sha256 is in the hash. Gate C is per platform.
- Route contract test: title, category, description and the asset all reach the wire.

**Tests:**
- `#Shorts` is present;
- the title is ≤100 chars;
- the first description line is the canonical URL;
- media is not re-uploaded when the hash is unchanged;
- R2 presign TTL for `dueAt = now + 3 d` is 4 days; for `dueAt = now + 10 d`, scheduling is refused.

### Task T2.8: Spike S5, YouTube direct smoke test (optional; decides Phase 3)

**USER ACTION U2-F:**
1. console.cloud.google.com → New project `content-powerhouse` → enable **YouTube Data API v3**.
2. OAuth consent screen: External, then **Publish app ("In production")**. Under "Testing", tokens expire after 7 days.
3. Credentials → OAuth client ID → **Desktop app** → paste the ID and secret in `/connections/youtube` → `cph connect youtube` → click through "unverified app" once.

Cost: $0 (quota: 10,000 units/day plus 100 uploads/day).

**Spike:** upload a 5 s clip with `privacyStatus:'private'` (the unit test from T0 constraints applies). The user checks in Studio whether it can be made unlisted, which tells us whether the unverified-project lock applies, and then deletes it.

### Task T2.9: Phase 2 acceptance

The first real short goes through Gates A, B and C to YouTube Shorts and LinkedIn, with the user timing their own minutes.

---

# Phase 3: Expand + graduate off Buffer where it falls short

**Goal:**
- Direct routes where Buffer lacks a feature: YouTube caption tracks, `containsSyntheticMedia`, private-then-`publishAt`; LinkedIn PDF document posts or SRT.
- Threads, TikTok and Instagram.
- The elicitation approval channel as a second option (if it is not already the Phase 0 fallback).
- Optionally, a `.mcpb` bundle for Claude Desktop (Desktop is already registered through its JSON config in Phase 0).

**Exit criteria:**
1. Each new route passes the same gate and route-contract suites: T0.13's table runs parameterized over every route.
2. Connecting each new platform takes under 2 minutes once its developer app exists.

**Phase 3 cost:**
- Direct YouTube and LinkedIn: $0 (the developer apps are free).
- Moving beyond 3 channels means leaving Buffer Free: **Essentials at $5/channel/mo for every connected channel**. 4 channels (LinkedIn, X, YouTube, Threads) = $20/mo; +TikTok = $25; +Instagram = $30 ([buffer.com/pricing](https://buffer.com/pricing)).
- Total with video: **≈ $42–57/month**. This matches the spec's "Max" column ($82–87 also includes Hashnode Pro, Medium membership, Fly.io and stock music).

### USER ACTIONS for Phase 3
- **U3-A (LinkedIn direct):**
  1. Confirm you admin a LinkedIn Page.
  2. linkedin.com/developers → Create app linked to that Page → Products: *Share on LinkedIn* + *Sign In with LinkedIn using OpenID Connect*.
  3. Auth → redirect `http://127.0.0.1:53682/callback/linkedin`.
  4. Paste the client ID and secret → `cph connect linkedin`.
  5. Re-auth every 60 days: an amber warning appears at T-7 days. $0.
- **U3-B (Buffer Essentials):** Buffer → Billing → Essentials → add channels. $5/channel/mo.
- **U3-C (Threads / TikTok / IG):** connect in Buffer after U3-B.

### Tasks
- **T3.1 YouTube direct route**:
  - `videos.insert` with `privacyStatus:'private'` hard-set and unit-tested, `selfDeclaredMadeForKids:false`, `containsSyntheticMedia` from a per-video toggle (default false);
  - `captions.insert` SRT;
  - `publish` = `videos.update status.publishAt`, or privacy change → public, after approval. `publishAt` stores `remote_scheduled_id`;
  - `cancelScheduled` = `videos.update` back to `privacyStatus:'private'` with **no** `publishAt`, wired to the T1.7 invalidation path;
  - quota accounting: about 500 of the 10,000 units per Short.

  Tests: the private-field assertion; `publishAt` only on a never-published private video; an MDX edit before `publishAt` results in a `videos.update` to private with `publishAt` removed.
- **T3.2 LinkedIn direct route:** `POST /rest/posts`, with headers `LinkedIn-Version: 202610` (202511 sunsets 2026-11-16) and `X-Restli-Protocol-Version: 2.0.0`. Document posts (≤100 MB / 300 pages), and the Videos API with SRT. Tests: headers; link-share title, description and thumbnail always supplied (route contract).
- **T3.3 Threads/TikTok/IG via Buffer:** transforms + lint. Threads: 500 chars.
- **T3.4 Elicitation approval channel** (skip if T0.13b already built it as the fallback): `request_approval{channel:'elicitation'}` sends `elicitInput` with an enum `["Publish now","Cancel"]` and the rendered payload. **No secrets in the form.** Feature-detect client support, falling back to the dashboard. Document "do not auto-answer content-powerhouse elicitations".
- **T3.5** Optional `.mcpb` bundle for Claude Desktop.
- **T3.6** Video to X, Bluesky and Threads, using the same master MP4.
- **T3.7** Parameterize the gate and route-contract suites over all routes.

---

# Phase 4: Scheduling, analytics, remote access

**Goal:** a calendar with recurring cadences, metrics per publication, a weekly "what worked" report, optional phone use through a remote MCP, an optional cloud host, and long-form 16:9 video.

**Exit criteria:** a weekly report in Claude shows reach per platform per post. If the user wants it, Claude can drive the tool from the phone, with approvals still Hello-verified on the PC.

**Phase 4 cost:**
- Analytics APIs: $0.
- Cloudflare Tunnel: $0.
- Fly.io shared-cpu-1x 256 MB + 1 GB volume: ≈ **$2.34/mo** if cloud hosting is chosen (spec §2.8, [Fly pricing](https://docs.fly.io/about/pricing); re-check).
- A claude.ai remote custom connector: the Free plan allows 1 (spec §7).

Phase 4 adds **$0–2.34/month**.

### Tasks
- **T4.1 Metrics ingestion** into `metrics`, from:
  - Buffer `get_aggregated_post_metrics` (needs a personal API key, per Buffer docs);
  - dev.to `/api/articles/me`;
  - Bluesky and Mastodon public counts;
  - YouTube Analytics, if direct.

  Rate-limit budgets: Buffer Free has 3,000 requests per 30 days and 250 per 24 h in total, shared with probes and publishing. Metrics calls go through `ApiBudget` with purpose `other`, so they stop first when the budget runs low. Poll once a day, batched, staying under about 1,000 a month.
- **T4.2** Weekly report prompt + `get_metrics` tool.
- **T4.3** Calendar view + recurring cadences (still one approval per action).
- **T4.4 Remote MCP:** Streamable HTTP behind Cloudflare Tunnel + OAuth. **The remote surface exposes no `publish` tool that skips the human channels.** Approvals stay Hello-verified on the PC (or elicitation, if that is the fallback). Note that a Windows Hello prompt cannot be answered from a phone, so remote use can draft and request but not approve.
- **T4.5** Optional Fly.io deploy. The master key comes from a Fly secret. The SQLite volume is backed up with `cph backup`. Windows Hello is not available on Fly, so approvals would need a new human-presence channel (for example a WebAuthn passkey on the dashboard); design it before moving.
- **T4.6** Optional Search Console URL-inspection check for a "canonical indexed" gate.
- **T4.7** Long-form 16:9 video template.

---

## Cost summary by phase (monthly, as of 2026-10-19)

| Phase | Adds | Running total |
|---|---|---|
| 0 | $0 (dev.to, Buffer Free, Windows Hello) | **$0** |
| 1 | $0 baseline (X as a single post on Buffer Free); optional Hashnode Pro $5 ($4.17 annual); optional Buffer Essentials for X threads $10 (LinkedIn + X); X direct only as a fallback (prepaid top-up, then ~$3, $5 cap) | **$0** (≈$4 with Hashnode Pro; +$10 with X threads) |
| 2 | ElevenLabs Creator $22 ($11 first month), music ~$1.20 at 8 shorts; R2 $0 with a card on file, or nothing if Buffer uploads natively. If on Essentials, YouTube adds $5 | **≈ $22–24** (+$15 with Essentials) |
| 3 | Buffer Essentials $20–30 when going beyond 3 channels | **≈ $42–57** |
| 4 | Fly.io ~$2.34 (optional) | **≈ $44–60** |

Sensitivity case (13 articles + 43 shorts/month, spec §8.2): **about $28–45/month** on the recommended path. ElevenLabs Creator covers it only if API characters are a separate 275k pool; otherwise expect a small overage (≈ $0.65 if billed at the pay-as-you-go rate, UNVERIFIED) or Pro at $99. Buffer Essentials for LinkedIn, X and YouTube (+$15) is needed once the 10-scheduled-posts cap binds.

## Self-review notes (done)

- **Spec coverage:**
  - §2.1–2.9 → T0.0–T0.21;
  - §2.6 gate (Hello, Approve & publish, polling, remote-schedule rule) → T0.0, T0.13, T0.13b, T0.17, T0.19, T0.20, T1.7;
  - §3 routes → T0.14–16, T1.1–1.3, T1.8–1.11, T2.7, T3.1–3.3;
  - §4 connect UX → T0.19, T0.20 (`open_dashboard`), T0.21 (install), U-tables;
  - §4.4 metered Buffer probe + API budget → T0.15, T0.18;
  - §5 SEO and the T0 rule → T0.7, T0.12, T0.17, T1.7, T1.8;
  - §5.4 disclosure → T0.17 (authorship), T1.8;
  - §5.5 numbers → T0.6, T1.5;
  - §6 video → Phase 2;
  - §8 pricing → per-phase cost lines;
  - §9.3 questions → USER ACTIONS;
  - §10 tests → T0.13, T0.13b, route contract tests, source rules, no-network guard, Buffer budget simulation.
  - `cph backup`, `revoke-all` and `disconnect` (spec §2.9 CLI) → T1.12.
- **Revision 2 changes (from the review), all reflected in the spec:**
  1. Windows Hello moved from optional Phase 1 (old T1.6) to **mandatory Phase 0** (T0.0 spike, T0.13b), on every Approve and on enabling publishing. Elicitation is the fallback if the spike fails. The out-of-band code channel is dropped.
  2. User-scope Claude settings and the `cph-guard` hook (T0.21), because project-scope rules do not apply when Claude runs from another directory. Residual risk (same-user processes can read the keys) stated in Review Focus and spec R1.
  3. Buffer health is metered (daily + before publish, one call), with an `api_budget` table and a 30-day simulation test (T0.15).
  4. LinkedIn link card goes through `metadata.linkedin.linkAttachment`, or is removed from the payload; route contract tests for every route (T0.8, T0.15).
  5. X defaults to a single post on Buffer Free; threads behind S2(f), Essentials or intent links (T1.1).
  6. R2 deferred to Phase 2 and only if Buffer has no native upload; payment method, TTL formula and the asset-fetch-time test recorded (T1.4, T2.7, U2-G).
  7. ElevenLabs quota sized at runtime from `/v1/user/subscription`; the pooling question is resolved before subscribing (T2.1, U2-A).
  8. Platform-scheduled posts are cancelled on invalidation (T1.7, T3.1).
  9. Buffer stage asserts `status === 'draft'` and deletes otherwise; `addToQueue` only with `saveToDraft` (T0.15).
  10. dev.to re-stage refuses to touch a live article (T0.14).
  11. T0 = min(frontmatter date, canonical_live_at), with a late-deploy exception (T0.12, T0.17, T1.7).
  12. Dashboard **Approve & publish**, the polling contract, and the steady-state confirmation list (T0.17, T0.19, T0.20).
  13. Claude Code registered at user scope and Claude Desktop through its JSON config in Phase 0; global `cph`; `open_dashboard` (T0.20, T0.21).
  14. "Kill switch" renamed to `publishing_enabled` / "Publishing: DISABLED/ENABLED" everywhere.
  15. Low-severity fixes: `--no-optional-locks` and a `.git/index` check (T0.11); TypeScript 5.9.3 for emit (T0.1); CI checkout path relative to the workspace (T0.1); doctor fixture count (T0.21); `unknown` state, startup sweep and "Check on platform" (T0.17); entity-decoded title match (T0.12); `placeholder-image` lint and no placeholder images (T0.7).
- **Earlier deviations from the spec, still flagged for the user:**
  1. dev.to tags default to the first 4 in frontmatter order, plus an optional preference list.
  2. MCP and CLI tokens are scoped, and the dashboard login nonce is never printed or returned.
  3. LinkedIn assist hand-off is approval-gated.
