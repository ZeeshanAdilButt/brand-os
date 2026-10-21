# 06: Easy-connect UX, MCP design and tech stack

Research date: 2026-10-19. Scope: how the owner connects accounts with the least effort, how Claude drives the tool over MCP without ever publishing on its own, and what to build it with and where to run it. Facts I could not confirm from a primary source are marked **UNVERIFIED**.

---

## 0. Summary table

| Platform / tool | Connect method | Auth / token life | Cost | Limits | Connect-UX risk | Recommendation |
|---|---|---|---|---|---|---|
| **dev.to** | Paste API key into dashboard | Static API key, no expiry | Free | Forem API rate limits (not re-checked) | Low | v1. Paste once; `canonical_url` points to the site |
| **Hashnode** | Paste Personal Access Token | Static PAT | Free | GraphQL rate limits (not re-checked) | Low | v1. `originalArticleURL` = canonical |
| **Bluesky** | App password (easiest) or atproto OAuth loopback client | Session refresh handled by SDK | Free | 300-grapheme posts | Low | v1 with app password. OAuth loopback later. Whether app passwords are still offered in late 2026 is UNVERIFIED |
| **Mastodon** | Preferences > Development > new app > copy token, or OAuth loopback | Token does not expire | Free | Per-instance | Low | v1 with pasted token |
| **LinkedIn** (member posts) | `connect linkedin` loopback OAuth with your own dev app ("Share on LinkedIn" product) | **60-day access token, no programmatic refresh** unless you are an approved partner | Free | API rate limits; per-day member limits (not re-checked) | **High**: re-consent every ~55 days | v1, plus a health check that warns at T-7 days. Re-auth is one click while you are still logged in |
| **X** | `connect x` loopback OAuth 2.0 PKCE + `offline.access` | 2 h access token plus refresh token | **Pay-per-use: $0.015/post, $0.20/post containing a URL** | Credits-based | Medium (cost per link) | v1 as an **intent-link (manual) mode** by default. API mode is opt-in |
| **YouTube** (Shorts + long) | `connect youtube` loopback OAuth, Google "Desktop app" client | Refresh token. **7-day expiry if the consent screen is in "Testing"** | Free | `videos.insert` = 1 unit from a "Video Uploads" bucket, **100 uploads/day** | Medium (Google Cloud console setup) | v1. Set the consent screen to "In production" |
| **Threads** | OAuth with a Meta app, then exchange for a long-lived token | 60-day long-lived token, refreshable once it is 24 h old | Free | About 250 posts per 24 h (third-party source, UNVERIFIED) | Medium-High (Meta app review, HTTPS redirect) | v2 |
| **Medium** | None (no new integration tokens) | n/a | Free | n/a | n/a | **Manual**: Medium "Import a story" from the canonical URL. Tool prepares it, you click |
| **Substack** | None (no public write API, UNVERIFIED as of 2026) | n/a | Free | n/a | n/a | **Manual**: copy-ready HTML plus a checklist |
| **Reddit** | Approval required since Nov 2025 | n/a | Free if approved | Approval is gated | High | **Manual** link-submit helper only |
| **Unified API: Zernio** | Hosted "connect" pages for many networks | Managed by vendor | First 2 accounts free, then $6/account/mo (accounts 3 to 10) | X passed through at cost | Low connect friction, vendor lock-in | Optional fallback for LinkedIn/Threads if their dev-app friction is too high |
| **Unified API: Postiz** | Hosted or self-host (AGPL) | Managed | $29/mo (5 channels), 7-day trial; self-host free | Unlimited posts | Low (hosted) | Not needed for v1; worth knowing about |
| **Secret store** | `@napi-rs/keyring` (Windows Credential Manager) + AES-GCM envelope in SQLite | n/a | Free | Credential blob ~2.5 KB (see §1.4) | Low | v1 |
| **MCP server** | Local **stdio** server (Claude Desktop / Claude Code) talking to a local daemon | n/a | Free | Only works while the PC is on | Low | v1. Remote HTTP is v2 |
| **Scheduler/host** | Home PC daemon (Task Scheduler at logon) | n/a | $0 | Posts are late if the PC is off | Medium | v1. Fly.io (~$2.34/mo) or Railway Hobby ($5/mo) if reliability matters |
| **DB** | SQLite (better-sqlite3, WAL mode) | n/a | Free | Single writer | Low | v1 |

**Bottom line**
1. The hard part of connecting accounts is the one-time **developer-app registration** (LinkedIn, X, Google, Meta), not OAuth itself. The dashboard should turn that into a guided checklist: deep link, the exact redirect URI to paste, then fields for client ID and secret. After that, each connection is one click or one command.
2. The approval gate has to sit in the server, not in a client prompt. A publish only happens against an **approval bound to a hash of the exact payload**, and that approval comes from a human channel the model cannot forge: an MCP elicitation form, a click in the local dashboard, or a code that is shown only outside the chat.
3. Stack: TypeScript on Node 24 LTS, one daemon process on 127.0.0.1 (dashboard, OAuth callbacks, scheduler, SQLite), and a thin stdio MCP server that Claude launches. Running cost is **$0/month** except X API usage.

---

## 1. Easy-connect UX

### 1.1 What the source looks like (read from `example-blog-site`, read-only)

The connector layer and the adapters both need these facts:

- **Posts**: `content/posts/<slug>.mdx`, parsed with `gray-matter` (`lib/content.ts`). Frontmatter fields: `title`, `date` (`"YYYY-MM-DD"` string), `category` (`engineering | case-study | productivity | community`, from `lib/types.ts`), `tags[]`, `description`, `published` (`false` = draft, which a production build never serves), `coverImage` (an **SVG** path under `/images/blogs-covers/`).
- **Cover images**: `scripts/covers-to-png.js` (`npm run covers`) writes a PNG twin next to each SVG, because "social platforms ... do not render SVG". The tool should **always upload the `.png` twin** (`/images/blogs-covers/<name>.png`) and never the SVG.
- **MDX components** (`lib/mdx.tsx`): `Callout` (`type="note" | "aside" | "alert"`, optional `title`; 100+ uses), plus three interactive diagrams: `PacketJourney name="..."`, `StateMachine name="..."` and `OutOfBandDiagram`. Posts begin with lines like `import Callout from '@/components/Callout';`. Rendering uses `remark-gfm` (tables), `rehype-slug` and `rehype-highlight`.
  - Adapter rules: strip `import` lines. Convert `Callout` to a blockquote with a bold label (`> **Note:** ...`; for alert, `> **Big Word Alert: X** ...`). Replace the interactive diagrams with a static PNG and an "interactive version at <canonical>#anchor" link. Keep GFM tables for dev.to and Hashnode, and flatten them for LinkedIn and X.
- **Canonical URL**: `https://www.example-blog.dev/blog/<slug>` (`lib/site.ts`, `app/feed.xml/route.ts`).
- **RSS** (`/feed.xml`) has only title, link, description, date and category, with **no full body**. The tool should read MDX from a local clone (or GitHub raw), and use the feed or a canonical-URL check only to decide whether a post is live.
- **Publishing notes**: `content/publishing-notes/<slug>.md` uses bold-label lines: `**Primary title:**`, `**Alternate titles**`, `**Meta description:**`, `**Excerpt (index/home):**`, `**OG / social card text:**`, `**Social visual concept:**`, `**Key entities / terms:**`, plus "Fact labels used" and "Verify before publishing" sections. Parse these into a typed `PublishingPackage` that feeds the adaptation prompts. Surface "Verify before publishing" items as a **pre-publish checklist** in the approval UI.
- **Canonical-first gate**: before any syndication, the tool does `GET https://www.example-blog.dev/blog/<slug>`. Anything other than 200 blocks syndication, which also covers `published: false` drafts.

### 1.2 The connect flow (target experience)

```
> cph connect linkedin
  Opening browser... waiting on http://127.0.0.1:53682/callback/linkedin
  OK  LinkedIn connected as "The owner" (token valid until 2026-12-18, 60 days)
> cph status
  linkedin   OK  connected      expires in 60d
  x          OK  connected      refresh ok (2h access)
  youtube    !!  needs setup    -> cph setup youtube
  devto      OK  connected      api key
  medium     --  manual-only    (no API, import from canonical URL)
```

The same actions appear as **Connect** buttons in the local dashboard (`http://127.0.0.1:4646`) and as an MCP tool (`connect_platform`) that returns the dashboard URL. Claude never handles a secret: the MCP spec says servers **MUST NOT** request passwords, API keys or tokens through form elicitation and **MUST** use URL mode for those ([MCP elicitation spec](https://modelcontextprotocol.io/specification/latest/client/elicitation)).

**Mechanics (per OAuth platform)**
1. `cph setup <platform>` (one time): the dashboard page shows numbered steps, deep links to the developer portal, and the **exact redirect URI** to copy (for example `http://127.0.0.1:53682/callback/linkedin`). You paste the client ID and secret, which go straight into the secret store.
2. `cph connect <platform>`:
   - generate `state` (CSRF) and a PKCE `code_verifier`/`code_challenge` (S256)
   - start a one-shot HTTP listener on **127.0.0.1** on a fixed port per platform (LinkedIn and X need an exact registered URI; Google accepts the loopback IP)
   - open the system browser with `start "" <authorize-url>` (Windows)
   - receive `code`, verify `state`, exchange it for tokens, store them, run a health check, close the listener
3. RFC 8252 (OAuth for native apps) is the governing pattern. Google calls the loopback IP redirect "the recommended mechanism" for desktop apps, recommends `127.0.0.1` over `localhost` (firewall issues), treats desktop clients as **public clients** whose secret is not confidential, and requires PKCE ([Google native-app OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)).

**Per-platform specifics**

| Platform | One-time setup | Redirect URI | Token handling | Sources |
|---|---|---|---|---|
| LinkedIn | Create a dev app, add "Share on LinkedIn" (`w_member_social`) and "Sign In with LinkedIn using OpenID Connect". App creation may require associating a LinkedIn Page (UNVERIFIED) | Docs say to add an absolute HTTPS URL, and query params are ignored. `http://localhost` is widely used in practice (UNVERIFIED officially) | "All access tokens are issued with a 60-day lifespan". Programmatic refresh tokens are "available for a limited set of partners". Re-running the auth flow skips the consent screen while you are logged in and the token is still valid | [LinkedIn 3-legged OAuth](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow) |
| X | Developer console app, OAuth 2.0 enabled, type "Native App" (public client) | Exact match against callback URLs in app settings | Access token valid 2 h; refresh token only with `offline.access`. The auth code must be exchanged within 30 s | [X OAuth 2.0 auth code](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code) |
| YouTube | Google Cloud project, enable YouTube Data API v3, OAuth consent screen (External), client type "Desktop app" | `http://127.0.0.1:<port>` | Refresh tokens issued while the consent screen is in **Testing expire after 7 days**; in production they generally persist until revoked or unused for about 6 months ([Google setup docs](https://developers.google.com/health/setup)). The `youtube.upload` scope is sensitive, so an unverified app shows a warning screen. That is acceptable for your own account, but whether unverified production apps get non-expiring tokens is UNVERIFIED | [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert) |
| Threads | Meta app with the Threads use case | Meta generally requires HTTPS redirects (UNVERIFIED for Threads). May need a tunnel or a static HTTPS bounce page | Short-lived 1 h, then long-lived 60 days, refreshable when at least 24 h old (`grant_type=th_refresh_token`) | [Threads long-lived tokens](https://developers.facebook.com/docs/threads/get-started/long-lived-tokens/) |
| Bluesky | none (app password) or a loopback OAuth client | `client_id` = `http://localhost?...`, redirect must be `http://127.0.0.1:...` | Loopback clients are public and need no registration (community docs, UNVERIFIED against the official spec) | [Mojo::ATProto::OAuth readme](https://metacpan.org/release/MADCAT/Mojo-ATProto-OAuth-1.02/view/README.md) |
| Medium | n/a | n/a | New integration tokens have not been issued since about 2025; existing tokens reportedly still work | [StackOne Medium guide](https://docs.stackone.com/connectors/medium/guides/link-account/integration-token), [timetopost](https://timetopost.co/blog/medium-api-auto-post-2026/) |
| Reddit | Approval request | n/a | "self-service access to Reddit's public data API will be closed" (Nov 2025) | [r/redditdev announcement mirror](https://r.datuan.dev/r/redditdev/s/gquSJqMgrM) |

**"Manual-assist" mode is a first-class connection type, not a failure state.** For Medium, Substack, Reddit and (by default) X, the tool prepares the final text, copies it to the clipboard, and opens the compose or import page (for X, `https://x.com/intent/post?text=...`). The publish click is yours, so the approval gate is satisfied by construction. For X specifically this avoids the **$0.20 per post that contains a URL** ([X pricing](https://docs.x.com/x-api/getting-started/pricing)).

### 1.3 Local web dashboard

- **Pages**: Connections (status cards and Connect/Reconnect buttons), Content (posts from the repo, their syndication status per platform), Drafts (per-platform adaptation, editable, preview), **Approvals queue** (Approve / Reject per item, showing the exact payload and the "Verify before publishing" checklist), Schedule, Logs.
- **Security** (it holds publish power):
  - Bind to `127.0.0.1` only. Validate `Host` and `Origin` headers to block DNS rebinding. The MCP Streamable HTTP spec requires Origin validation and recommends binding to 127.0.0.1 for local servers ([MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)).
  - Per-install random admin token. `cph dashboard` opens the browser with a one-time login link that sets an HttpOnly, SameSite=Strict cookie.
  - CSRF tokens on every POST, especially Approve.
- **Stack**: Hono (or Fastify) serving a small Vite + React SPA, or server-rendered HTML with htmx. A full Next.js app is overkill for a local tool. The site's Next.js knowledge carries over to React either way.

### 1.4 Secret storage on Windows

- **keytar is abandoned**: latest 7.9.0 was published 2022-02-17 (npm registry, checked 2026-10-19). Do not use it.
- **`@napi-rs/keyring` 2.1.2** (published 2026-10-19, about 3.07M downloads/week per the npm downloads API) is a Rust `keyring`-backed N-API module that uses Windows Credential Manager on Windows. It ships prebuilt binaries, so no node-gyp.
- **Blob size**: Windows generic credentials cap the secret at `CRED_MAX_CREDENTIAL_BLOB_SIZE` = 5 x 512 = **2560 bytes** in the current `wincred.h` (UNVERIFIED from Microsoft docs; older headers show 512). LinkedIn advises planning for access and refresh tokens of at least 1000 characters each ([LinkedIn](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow)), so a JSON bundle of tokens can overflow.
- **Recommended design: envelope encryption**
  1. One 256-bit **master key** stored in Credential Manager (`service=content-powerhouse`, `account=master-key`).
  2. Token bundles (`{access_token, refresh_token, expires_at, scope, account_id}`) encrypted with AES-256-GCM (`node:crypto`) and stored in SQLite table `credentials(platform, account, ciphertext, iv, tag, updated_at)`.
  3. Benefits: no size limit, atomic updates on refresh-token rotation, easy backup (DB plus a re-enrollable key), and a remote host can swap the master key source for an environment secret.
- Alternative: Windows DPAPI (`CryptProtectData`, user scope) through a small native module. It is equivalent, but there is no well-maintained npm package to point to, so prefer keyring.

### 1.5 Token refresh and health checks

- **Refresh job** (every 15 min in the daemon, plus on demand before each API call):
  - X: refresh when less than 10 min of access-token life remains. Persist the new refresh token in the same DB transaction (X refresh tokens may rotate, UNVERIFIED).
  - YouTube: the Google library refreshes automatically. Persist any new tokens.
  - Threads: refresh the long-lived token weekly. It must be at least 24 h old and not yet expired, and every refresh resets it to 60 days.
  - LinkedIn: no programmatic refresh. Show amber at T-7 days, then red. Send a Windows toast with a "Reconnect" deep link.
- **Health check** ("whoami", cheap):

| Platform | Probe | Cost note |
|---|---|---|
| LinkedIn | `GET /v2/userinfo` | free |
| X | Default to **token-expiry math only**. Optionally `GET /2/users/me` once a day | Reads are billed on pay-per-use, so avoid frequent probes |
| YouTube | `channels.list?mine=true` | 1 unit of the regular quota (UNVERIFIED that it is unchanged) |
| dev.to | `GET /api/users/me` | free |
| Hashnode | GraphQL `me { username }` | free |
| Bluesky | `com.atproto.server.getSession` | free |
| Mastodon | `GET /api/v1/accounts/verify_credentials` | free |
| Threads | `GET /me?fields=id,username` | free |

- **States**: `connected` (green), `expiring` (amber, less than 7 days), `needs_reconnect` (red), `not_configured` (grey), `manual_only` (blue). Expose them through the dashboard, `cph status`, and the MCP resource `connections://status`. Each one names the next action ("run `cph connect linkedin`").

### 1.6 Build vs buy for "connect"

- **Zernio** (formerly Late): first 2 connected accounts free, then $6/account/mo for accounts 3 to 10, $3 for 11 to 100. X is passed through at X's rates. Covers X, YouTube, Bluesky, Reddit, Threads and LinkedIn (listed for comments and ads; LinkedIn posting is likely but not confirmed on the pricing page). No Medium or dev.to ([Zernio pricing](https://zernio.com/pricing)).
- **Postiz**: $29 / $39 / $49 / $99 per month for 5 / 10 / 30 / 100 channels, unlimited posts, 7-day trial. Every plan includes a hosted MCP server, CLI and public API. Self-hosting is AGPL ([Postiz pricing](https://postiz.com/pricing)).
- **Ayrshare**: Premium is about $129 to $149/mo; sources disagree ([Ayrshare pricing](https://www.ayrshare.com/pricing.md), [PricingSaaS](https://pricingsaas.com/companies/ayrshare)). Too expensive for one person.
- **Recommendation**: build direct adapters (the API-key platforms are trivial, and LinkedIn, X and YouTube are well documented). Keep a `provider: "zernio"` adapter slot so LinkedIn or Threads can be routed through Zernio's free 2 accounts if the dev-app or 60-day re-auth pain turns out to be real. The adapter interface (`connect`, `health`, `publish`, `delete`) makes this swappable.

---

## 2. MCP server design

### 2.1 Spec status (late 2026)

- The current revision is **2026-07-28**. It removes protocol sessions and the `initialize` handshake, so every request carries its version and capabilities in `_meta`. It adds `server/discover` and replaces server-initiated requests (elicitation, sampling) with **Multi Round-Trip Requests**: the tool returns `InputRequiredResult` and the client retries with `inputResponses`. Roots, Sampling and Logging are deprecated. Tasks moved to an extension ([MCP changelog 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog)).
- **TypeScript SDK**: v1 `@modelcontextprotocol/sdk` 1.32.1 (2026-10-05). The v2 split packages `@modelcontextprotocol/server` and `@modelcontextprotocol/client` are at 2.3.1 (`latest` tag, 2026-10-05; npm registry). v2 targets 2026-07-28 ([TS SDK v2 docs](https://ts.sdk.modelcontextprotocol.io/v2/)). **Before committing, check that Claude Desktop and Claude Code negotiate with a v2 server** (backward compatibility goes through `server/discover` or a fallback probe). If they don't, start on v1 (2025-11-25 semantics) and use the codemod (`npx @modelcontextprotocol/codemod v1-to-v2`) later.
- **Client support for elicitation**: Claude Code added MCP elicitation (form and URL) in v2.1.76, March 2026 ([havoptic release tracker](https://www.havoptic.com/r/claude-code-2.1.76), [claudcod.com](https://claudcod.com/blog/claude-code-mcp-elicitation/)). Claude Desktop and claude.ai elicitation support is **UNVERIFIED**. Design the gate so it does **not depend** on elicitation (§2.4).
- **MCP Apps** (`io.modelcontextprotocol/ui` extension, `ui://` resources rendered in a sandboxed iframe) were announced on 2026-01-26 and reportedly render in Claude web and Desktop ([WorkOS](https://workos.com/blog/2026-01-27-mcp-apps), [morphllm](https://www.morphllm.com/mcp-apps)). This is a good v2 option for an inline preview card with an Approve button.

### 2.2 Local stdio vs remote HTTP

| | Local stdio (+ local daemon) | Remote Streamable HTTP |
|---|---|---|
| Works in | Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json` or a `.mcpb` bundle), Claude Code (`claude mcp add`) | claude.ai web/mobile, Desktop, Code, as a custom connector |
| Reachability | Only on this PC | Must be reachable on the **public internet from Anthropic's cloud**. Free plan allows 1 custom connector ([Claude help](https://support.claude.com/en/articles/11175166)) |
| Auth | None needed (process spawned by your client) | Must implement MCP authorization (OAuth 2.1, Client ID Metadata Documents; DCR now deprecated) |
| Where tokens live | Your PC (Credential Manager) | Cloud host secrets |
| Cost | $0 | $0 to $5/mo (see §3) |
| Effort | Low | Medium-high |

**Recommendation**: v1 is **local stdio**. The stdio process is a thin MCP facade that calls the always-on local daemon (`http://127.0.0.1:4646/api`, authenticated with the per-install token read from keyring). The daemon is the single writer to SQLite and owns OAuth callbacks, the scheduler and the dashboard. v2 (to drive it from your phone through claude.ai) can expose the daemon's MCP endpoint through **Cloudflare Tunnel** with OAuth in front, or move the daemon to a small cloud host. Distribute v1 as a **`.mcpb` Desktop Extension** for one-click install in Claude Desktop (`@anthropic-ai/mcpb` 2.1.2), with a documented `claude mcp add content-powerhouse -- node <path>/mcp.js` line for Claude Code.

### 2.3 Tool surface

These names follow the MCP guidance on deterministic ordering and explicit state handles, since there are no sessions in 2026-07-28 ([MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)).

| Tool | Side effects | Notes |
|---|---|---|
| `list_content` | read | Posts from the repo with status per platform (`not_started / drafted / approved / scheduled / published / failed`) |
| `get_content` | read | Frontmatter + publishing package + canonical-live check |
| `list_connections` | read | Same data as `connections://status` |
| `connect_platform` | none (returns a URL) | Returns the dashboard connect URL. Uses URL-mode elicitation where the client supports it |
| `preview_adaptation` | read | Deterministic transforms (MDX to markdown, Callout to blockquote) plus a char-count, link and hashtag lint per platform. Claude writes the creative copy; the tool validates |
| `create_draft` / `update_draft` | local write | Stores the per-platform payload. Returns `draft_id` and a `payload_sha256` |
| `list_drafts` | read | |
| `request_approval` | local write | Creates a pending approval for `{draft_id, payload_sha256, platform, account, when}`. **Does not return any secret or token** |
| `get_approval_status` | read | `pending / approved / rejected / expired` |
| `publish` | **external write** | Requires `approval_id`. The server re-verifies the approval (see §2.4). Annotated `destructiveHint: true, openWorldHint: true` (hints are untrusted per spec) |
| `schedule` | local write, external later | Same approval requirement. The approval covers the scheduled time |
| `cancel_scheduled` | local write | Always allowed |
| `get_publish_log` | read | Platform post URLs and errors |
| `render_short` (later) | local compute | Video pipeline hook |

**Resources**: `content://posts/{slug}` (MDX source), `content://notes/{slug}` (publishing package), `drafts://{id}`, `connections://status`, `approvals://pending`. **Prompts**: `adapt-linkedin`, `adapt-x-thread`, `adapt-devto`, `short-script-60s`, each seeded with the publishing-notes fields.

### 2.4 The approval gate (HARD RULE: nothing publishes without your explicit per-action yes)

Threat model: the model (or a prompt-injected page) calls `publish` on its own, or reuses an old approval for changed text. Client-side "allow tool?" prompts are not enough. A user can click "always allow", and the MCP spec only says clients **SHOULD** prompt for confirmation and that tool annotations are untrusted ([MCP tools security](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)).

**Server-enforced rules**
1. `publish` and `schedule` refuse without an `approval_id` whose record is `approved`, unexpired (30 min for publish-now; until fire time + 15 min for scheduled), single-use, and whose `payload_sha256` matches the **current** draft byte-for-byte, including media hashes, platform, account and scheduled time. Any edit invalidates it.
2. **An approval can only be created by a human channel the model cannot write to**:
   - **(a) Elicitation (preferred where supported)**: `publish` returns `InputRequiredResult` with a form-mode elicitation that shows the platform, account, a first-200-characters preview, the hash prefix, and an enum field `decision: ["Publish now", "Cancel"]`. Only `action: "accept"` with `decision = "Publish now"` marks the approval as approved. The client renders this to you directly, so the model cannot fill it in. Caveat: Claude Code Elicitation hooks could auto-answer; that is a user-configured choice, so document "don't auto-accept content-powerhouse".
   - **(b) Dashboard click (always available)**: `request_approval` puts the item in the dashboard queue and returns `"Pending. Approve at http://127.0.0.1:4646/approvals/<id>"`. You click Approve (CSRF-protected, localhost-only). The model then calls `publish(approval_id)`.
   - **(c) Out-of-band code (fallback for chat-only use)**: `request_approval` shows a 6-digit code **only** in a Windows toast or the dashboard, never in the tool result. You type the code into chat, and the model passes `confirm_code`. Because the model never sees the code until you type it, it cannot self-confirm.
   - **Never** return a confirm token inside the tool result. The model would simply echo it back, which makes the gate theatre.
3. **Global kill switch** (`publishing_enabled=false` by default until you flip it in the dashboard), a dry-run mode, and an append-only audit log `{who/channel, approval_id, hash, platform, response URL}`.
4. **Pre-publish checks**: canonical URL returns 200, platform length limits, link present, the publishing-notes "Verify before publishing" items ticked in the dashboard, and a duplicate check (same hash already published to this platform).

---

## 3. Tech stack, scheduling, DB

### 3.1 Language: TypeScript on Node

- It matches the site (Next.js 14, `gray-matter`, `next-mdx-remote`, `remark-gfm`). The adapter can **reuse the same remark/rehype pipeline** to turn MDX into markdown or HTML for dev.to, Hashnode and Substack. The official MCP TS SDK is the reference SDK (about 39M weekly downloads for v1, npm API). The user's machine has Node v22.22.2.
- Target **Node 24 LTS**. Python would only be a better fit for the video pipeline (moviepy/whisper), and that can live as a separate worker process later.
- **Key libraries** (npm registry, 2026-10-19):
  - `@modelcontextprotocol/server` 2.3.1 (or `@modelcontextprotocol/sdk` 1.32.1)
  - `@napi-rs/keyring` 2.1.2
  - `better-sqlite3` 13.0.3 (2026-08-05)
  - `croner` 10.0.1 for in-process cron
  - `hono`
  - `gray-matter` and `unified`/`remark` (shared with the site)
  - `zod` for schemas
- **`node:sqlite`**: avoid for now. It is experimental on Node 22, stability on 24 is unclear, and 2026 CVEs include CVE-2026-58041 ([SentinelOne](https://www.sentinelone.com/vulnerability-database/cve-2026-58041/), [ts-sql-query docs](https://ts-sql-query.readthedocs.io/en/latest/configuration/query-runners/recommended/node_sqlite/)). `better-sqlite3` is mature and ships Windows prebuilds.

### 3.2 Local DB schema (SQLite, WAL)

`content(slug, sha256_of_mdx, title, date, canonical_live_at)`, `drafts(id, slug, platform, account, payload_json, payload_sha256, status, created_at)`, `approvals(id, draft_id, payload_sha256, channel, status, code_hash, expires_at, decided_at)`, `jobs(id, draft_id, approval_id, run_at, status, attempts, last_error)`, `publications(id, draft_id, platform, remote_id, remote_url, published_at)`, `credentials(platform, account, ciphertext, iv, tag, expires_at, updated_at)`, `audit_log(...)`. Put the DB file in `%LOCALAPPDATA%\content-powerhouse\cph.db`, not in the repo.

### 3.3 Where the scheduler runs

| Option | Monthly cost | Precision | Fit | Source |
|---|---|---|---|---|
| **Home Windows PC**: daemon started by Task Scheduler at logon, with `croner` inside it | **$0** | Exact while awake | Good for v1. Most posts are "publish now after approval". Set `StartWhenAvailable` (run after a missed start) and optionally `WakeToRun` | [TaskSettings](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings) |
| **Fly.io** shared-cpu-1x 256 MB 24/7 + 1 GB volume | **~$2.19 + $0.15 = $2.34** (512 MB: $3.69 + $0.15). No free tier; card required; trial is 2 h or 7 days | Exact | Best cheap always-on host for the daemon and SQLite volume | [Fly pricing](https://docs.fly.io/about/pricing) |
| **Railway** Hobby | **$5/mo** including $5 usage. Free plan is $1/mo usage, 0.5 GB RAM, 500 MB volume. Memory about $10/GB-mo | Exact | Easy deploy. Free plan may just fit a tiny daemon | [Railway pricing](https://railway.com/pricing) |
| **Cloudflare Workers** Free / Paid | **$0** (100k req/day, 10 ms CPU, **5 cron triggers**) / **$5** (250 cron triggers, D1 included) | Minute-level | Good for text-only publishing with D1 instead of SQLite. Poor for YouTube uploads (large bodies) | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [limits](https://developers.cloudflare.com/workers/platform/limits/) |
| **Vercel Cron** Hobby / Pro | $0 / $20 per month | Hobby: **once per day, ±59 min**. Pro: per-minute | Not suitable on Hobby | [Vercel cron pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing) |
| **GitHub Actions** schedule | Free on public repos; private has 2,000 min/mo on Free (third-party figure) | Scheduled runs can be delayed (UNVERIFIED) | Awkward: rotating refresh tokens must be written back to secrets | [cicdcost](https://cicdcost.com/github-actions-pricing) |

**Recommendation**: start on the **home PC**. Handle late posts with a policy rather than silently: if a scheduled job is more than 2 h late (PC was off), mark it `held` and notify you instead of publishing late. This keeps "per-action confirmation" meaningful. Move to **Fly.io (~$2.34/mo)** only if you start scheduling many posts while away from the PC. The daemon code is identical: the master key comes from a Fly secret instead of Credential Manager.

---

## 4. Pricing summary (all monthly unless stated)

| Item | Cost | Notes |
|---|---|---|
| MCP server, dashboard, SQLite, keyring | $0 | Open-source libraries |
| dev.to, Hashnode, Bluesky, Mastodon, LinkedIn, YouTube, Threads APIs | $0 | Limits and token-lifetime caveats in §1 |
| X API (if API mode) | $0.015/post, **$0.20/post with URL**, $0.005 per post read | Pay-per-use; free tier closed to new signups (third-party reports). Possible one-time credits of $20 plus an auto-recharge match up to $50 ([X pricing](https://docs.x.com/x-api/getting-started/pricing)). Example: 20 link posts/month = **$4.00**; 20 no-link posts = $0.30 |
| Hosting | $0 (home PC) / ~$2.34 (Fly) / $5 (Railway Hobby or Workers Paid) / $20 (Vercel Pro) | |
| Cloudflare Tunnel (v2 remote MCP) | $0 (UNVERIFIED for current terms) | |
| Optional unified API | Zernio $0 for 2 accounts, then $6/account; Postiz $29+; Ayrshare ~$129 to $149 | |
| Claude custom connector (remote, v2) | Included; Free plan limited to 1 | |
| **Expected v1 total** | **$0 to $4/mo** | Dominated by X link posts if API mode is used |

---

## 5. Open risks

1. **LinkedIn 60-day re-consent** (no programmatic refresh for non-partners). Mitigation: T-7 alerts, one-click reconnect, or route LinkedIn through Zernio.
2. **LinkedIn redirect URI**: docs say HTTPS. If `http://127.0.0.1` is rejected for your app, use `https://oauth.pstmn.io`-style bounce pages, or a tiny static HTTPS page on the personal site's domain that forwards `code`/`state` to `127.0.0.1` (that would require adding a route to the site, which is out of bounds since the site repo is read-only). Fallback: Cloudflare Tunnel hostname. UNVERIFIED which is needed.
3. **Google consent screen**: if it is left in "Testing", YouTube breaks every 7 days. Whether an unverified "In production" app with the sensitive `youtube.upload` scope keeps long-lived refresh tokens is UNVERIFIED. Verify at setup.
4. **YouTube upload quota** changed in 2026 to a separate "Video Uploads" bucket (100/day, 1 unit each), and current docs say unverified projects are **no longer** forced to private. Third-party guides still cite the old 1,600-unit and forced-private rules. Re-check at build time.
5. **X costs** for link posts ($0.20 each), and X's pricing has changed several times in 2026. Default X to manual intent links.
6. **MCP SDK v2 / protocol 2026-07-28 vs client support**: Claude Desktop/Code compatibility with a v2-only server, and Claude Desktop's elicitation support, are UNVERIFIED. The dashboard approval path keeps the gate working regardless.
7. **Threads and Meta app review / HTTPS redirect** may require a tunnel or app review. Deferred to v2.
8. **Medium, Substack, Reddit** have no usable write API. They stay manual-assist; do not scrape or automate browser posting (ToS risk).
9. **Home-PC scheduling** misses posts while the PC sleeps. The "held, not late-published" policy handles this but needs your attention.
10. **Secrets**: the Credential Manager blob limit (2560 bytes, UNVERIFIED) is why envelope encryption is the design. Back up the master key or plan for re-connecting every platform after a reinstall.
11. **Prompt injection via content**: adapted drafts are built from your own repo, but any fetched web content (for example research links) must never reach tool calls as instructions. The approval hash binding means injected edits cannot ride an old approval.
12. **Bluesky app passwords and atproto OAuth details** come from community docs (UNVERIFIED against the official spec for 2026).
