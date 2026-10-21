# content-powerhouse: design

- **Date:** 2026-10-19
- **Status:** Design for review, revision 2 (review findings applied 2026-10-19). Nothing is built yet.
- **Owner:** the project owner
- **Repo:** `<repo>` (standalone, separate from the personal site)
- **Inputs:** the six research reports in `docs/research/` (01 long-form, 02 social, 03 video publishing, 04 schedulers and MCP, 05 video pipeline, 06 connect UX and architecture). Each claim below cites the report it comes from and, where one exists, the primary URL. **UNVERIFIED** means no official source confirmed it. Treat it as a build-time check, not a fact.
- **Labels:** decisions the user did not make are marked **[Architect's call]**. Questions only the user can answer are collected in section 9.3, "Open questions for the owner", most important first. Each has a stated default marked **default until decided**.
- **Companion plan:** `docs/superpowers/plans/2026-10-19-content-powerhouse-plan.md`.

---

## 0. TL;DR

1. **What it is.** content-powerhouse is a local tool driven by Claude. It turns each article on example-blog.dev into a native, deep version for every platform and moves each one through a draft → approve → publish pipeline. Claude drives it over MCP. People use it through a small CLI (`cph`) and a localhost dashboard.
2. **The site is the only source of truth, and the tool only reads it.** It reads MDX and publishing notes from the site repo and never writes there. Nothing is syndicated until the canonical URL returns 200.
3. **Each platform gets its own transport, chosen to be the easiest legitimate path:**
   - **direct API** for key-based platforms (dev.to, Bluesky, Mastodon);
   - **Buffer** for platforms that need OAuth developer apps (LinkedIn, YouTube, X), using Buffer's Free plan. On Free, X gets a **single post** (takeaway + link), because Free allows only "1" threaded post;
   - **assist** (the tool prepares the post, the user makes the final click) for Medium, Substack, Hashnode-free, Reddit and LinkedIn Articles.
4. **The approval gate is enforced by the server, not by the client.** Every external publish needs a single-use approval tied to a SHA-256 hash of the exact payload. On this user's machine Claude can drive a browser (claude-in-chrome) and the desktop (computer-use), so a dashboard click alone is **not** model-proof. While publishing is enabled, every Approve also needs a **Windows Hello** check (PIN, face or fingerprint), from Phase 0. If Hello turns out to be unavailable, the fallback is an MCP elicitation answered by the user in the Claude Code TUI. Publishing is disabled by default (`publishing_enabled=false`).
5. **Cost:**
   - $0/month for every text platform on the default path.
   - About $23–24/month once the video phase starts. Nearly all of that is ElevenLabs Creator at $22/month for a professional clone of the user's own voice.
   - Optional: +$10–15/month for Buffer Essentials if you want X threads, and Cloudflare R2 needs a payment method on file (no charge within the free tier) from Phase 2.
   - The "everything automated and comfortable" option is about $82–87/month.
6. **Phase 0** (first slice):
   - install registers the MCP server for **Claude Code (user scope) and Claude Desktop**, plus a Windows Hello spike;
   - connect accounts;
   - ingest a site post;
   - verify it is live on the site;
   - create a dev.to draft with `canonical_url` and `published:false`;
   - draft a LinkedIn post. It is published through Buffer only after one Hello-verified **Approve & publish** click, and in Phase 0 only if the owner explicitly OKs a live test (Q4).

---

## 1. Intent, goals, non-goals, anti-goals

### 1.1 Why this exists

The owner is building a personal brand around deep technical writing on distributed systems and systems performance. The thesis is that **content is king, and depth is the brand**. Each article is a large investment: original diagrams, first-principles explanations, and labelled facts with a "verify before publishing" list. Today that investment lands in one place.

content-powerhouse makes **one investment show up everywhere in a form native to each place, at full depth**. That means:
- a complete idea taught in a LinkedIn post;
- an X post that stands on its own (a thread once Buffer's Free limit is resolved; see Q7);
- the full article on dev.to, Hashnode and Medium, each with a canonical link home;
- a newsletter edition on Substack;
- later, a 60-second vertical explainer in the user's own voice on YouTube Shorts and LinkedIn video.

Every copy points back to `https://www.example-blog.dev/blog/<slug>`, so the authority builds up on the site.

The user's top requirement, in their words: **"it SHOULD BE VERY VERY EASY FOR ME TO BE ABLE TO CONNECT MY STUFF"**, and Claude must be able to drive it "via MCP or whatever".

### 1.2 Goals

| # | Goal | Measured by |
|---|---|---|
| G1 | **Easy to connect.** Each platform connects in one step: a paste, one OAuth click, or "nothing, it's manual" | Under 2 minutes per platform after any one-time vendor sign-up (Cloudflare R2, if Phase 2 needs it, is the known exception: section 4.2). Claude Code and Claude Desktop are registered by `cph install`. `cph status` shows all green |
| G2 | **Write once, publish everywhere.** One site post fans out to all configured destinations | One launch plan per post, listing every destination with its state |
| G3 | **Depth everywhere.** Each destination gets a native adaptation with real substance, not just a link | Lint: every social adaptation carries at least one complete takeaway, not only "new post, link" |
| G4 | **Claude drives it.** MCP is the main interface, and the full flow runs from Claude Code or Claude Desktop | Every step short of the human approval is reachable through MCP tools |
| G5 | **Canonical SEO.** The site wins search for its own content | Every syndicated copy carries a canonical URL or an attribution line, and the order and delay rules from section 5 are enforced |
| G6 | **Pricing is visible.** Every paid action shows its cost before approval | The approval card shows the cost (for example "X post with link: $0.20") |
| G7 | **Video (phase 2+).** Article → 45–60 s vertical short narrated in the user's cloned voice → YouTube Shorts and LinkedIn | One short produced end to end in under 30 minutes of the user's time |

### 1.3 Non-goals (v1)

- Editing or deploying the personal site. The site repo is read-only, and the user publishes the canonical post through their existing git push to Vercel.
- Writing the articles. Claude adapts the user's own writing and does not generate articles from scratch.
- Multiple users, teams or SaaS. This is one person on one Windows PC.
- Engagement automation: no auto-replies, auto-likes, follows or DMs.
- TikTok and Instagram Reels before phase 3. Long-form 16:9 video before phase 4.
- Paid ads and boosting.

### 1.4 Anti-goals (the tool must never do these)

| Anti-goal | How the design prevents it |
|---|---|
| **Anything that posts without the user's explicit per-action confirmation** | The approval gate in the server (section 2.6), a Windows Hello check on every Approve, `publishing_enabled` defaulting to false, no tool that publishes in one shot, Buffer write access withheld from Claude (no Buffer MCP, and Buffer's own Claude integration left disabled in claude.ai), and uploads set to private **where the route supports it** (YouTube direct, phase 3). The v1 Buffer route has no privacy field (UNVERIFIED) and posts publicly on `shareNow`, so it relies on Gate C alone. The residual risks are listed in R1 (section 9.1) |
| **Anything that puts the user's accounts at risk through ToS violations** | No browser automation, cookie reuse or private endpoints on Medium, Substack, LinkedIn or Reddit. Only official APIs, official import tools, or a human click (section 3) |
| **Anything hard to connect** | Setup that needs a developer app (LinkedIn, Google, X, Meta) is deferred or routed through Buffer. What's left is a pasted key or "manual" |
| Secrets in the repo, in `.env`, in chat or in tool results | Envelope encryption with the master key in Windows Credential Manager. Secrets are entered only in the dashboard |
| Duplicate-content self-harm | Canonical-first gate, syndication delays, and a newsletter edition for Substack instead of the full text (section 5) |
| Mass-produced, templated output | Human gates on the script and the final cut, varied visual templates, and a moderate cadence. This is the YouTube "inauthentic content" risk (03 §1.9) |

---

## 2. Architecture

### 2.1 Overview

```
                       ┌──────────────────────────────────────────────────────────────┐
  Claude Code /        │  cph-mcp  (stdio MCP server, thin facade, no secrets)         │
  Claude Desktop ─────►│  tools: list_content, get_content, preview_adaptation,        │
  (MCP client)  stdio  │  create_draft, request_approval, publish, schedule, ...       │
                       └───────────────┬──────────────────────────────────────────────┘
                                       │ HTTP 127.0.0.1:4646/api  (per-install token)
  You (browser) ──────────────────────►│
  http://127.0.0.1:4646                ▼
  ┌──────────────────────────────────────────────────────────────────────────────────┐
  │  cph-daemon (Node 24, always on at logon; the only writer to state)              │
  │                                                                                  │
  │  ┌────────────┐   ┌─────────────────┐   ┌──────────────┐   ┌──────────────────┐  │
  │  │ Ingest     │──►│ Canonical model │──►│ Transforms   │──►│ Drafts (per      │  │
  │  │ (read-only │   │ ContentItem +   │   │ per platform │   │ platform, hashed)│  │
  │  │ site reader│   │ PublishingPkg + │   │ md/html/text │   └────────┬─────────┘  │
  │  │ + live chk)│   │ PortableDoc AST │   │ + asset kit  │            │            │
  │  └─────▲──────┘   └─────────────────┘   └──────────────┘            ▼            │
  │        │                                                 ┌──────────────────┐    │
  │        │          ┌──────────────┐   human channels ───► │ APPROVAL GATE    │    │
  │        │          │ Dashboard    │   (click + Windows    │ hash-bound,      │    │
  │        │          │ Connections, │    Hello / elicit.)   │ single-use, TTL  │    │
  │        │          │ Content,     │                       └────────┬─────────┘    │
  │        │          │ Approvals,   │                                ▼              │
  │        │          │ Schedule,Log │   ┌───────────┐       ┌──────────────────┐    │
  │        │          └──────────────┘   │ Scheduler │──────►│ Routes           │    │
  │        │                             │ (croner,  │       │  direct  ─► dev.to, Bluesky, Mastodon,
  │        │          ┌──────────────┐   │ held-if-  │       │             (later LinkedIn, YouTube,
  │        │          │ Secret store │   │ late)     │       │              Hashnode Pro, X API)
  │        │          │ keyring +    │   └───────────┘       │  buffer  ─► LinkedIn, YouTube, X
  │        │          │ AES-GCM in   │                       │  assist  ─► Medium import, Substack,
  │        │          │ SQLite       │   ┌───────────┐       │             Hashnode free, Reddit,
  │        │          └──────────────┘   │ SQLite    │       │             LinkedIn Article, X intent
  │        │                             │ (WAL)     │       └────────┬─────────┘    │
  │        │          ┌──────────────┐   └───────────┘                │              │
  │        │          │ Video module │ (phase 2: script → voice → Remotion → QC)    │
  │        │          └──────────────┘                                │              │
  └────────┼──────────────────────────────────────────────────────────┼──────────────┘
           │ fs read only                                             │ HTTPS
  ┌────────┴──────────────────────┐                     ┌─────────────▼────────────────┐
  │ example-blog-site (local clone)│                     │ Platforms / Buffer / R2      │
  │ content/posts/*.mdx            │  GET canonical URL  │ (asset host for media URLs)  │
  │ content/publishing-notes/*.md  │◄── www.example-blog.dev/blog/<slug> (200?)     │
  └────────────────────────────────┘                     └──────────────────────────────┘

  cph (CLI) ── same daemon API ── `cph status | connect | sync | plan | dashboard | check | ...`
```

**[Architect's call] Process model.** There is one long-lived **daemon** that owns SQLite, the scheduler, OAuth callbacks, the dashboard and every outbound platform call. Claude launches **cph-mcp** over stdio. It is a thin facade with no secrets and no state, and it calls the daemon over loopback HTTP with a per-install token read from the keyring. The CLI uses the same API. Reasons:
- one writer to the database;
- the scheduler keeps running when Claude is closed;
- OAuth callbacks need a listener that stays up;
- the MCP process never holds publishing credentials.

Source: 06 §2.2.

### 2.2 Tech stack

| Concern | Choice | Why / source |
|---|---|---|
| Language/runtime | TypeScript on **Node 24 LTS**, with Node ≥22 also supported. The user's machine has 22.22.2 | It matches the site's remark/gray-matter tooling. The MCP TypeScript SDK is the reference SDK (06 §3.1) |
| MCP SDK | **[Architect's call]** Start on `@modelcontextprotocol/sdk` **1.32.1** (v1). Run a one-day spike in phase 0 on v2 `@modelcontextprotocol/server` 2.3.1 (spec 2026-07-28) and switch only if Claude Desktop and Claude Code both talk to it | Whether Claude's apps work with a v2-only server is UNVERIFIED (06 §2.1). A codemod `npx @modelcontextprotocol/codemod v1-to-v2` exists for the move later |
| HTTP | Hono, bound to 127.0.0.1 | Small. Validates Host and Origin to block DNS rebinding (06 §1.3) |
| Dashboard | **[Architect's call]** Server-rendered HTML + htmx, no SPA build step | Five pages of forms and tables. Least to maintain |
| DB | SQLite through `better-sqlite3` 13.x (WAL) at `%LOCALAPPDATA%\content-powerhouse\cph.db` | Mature with Windows prebuilds. Avoid `node:sqlite`, which is experimental and has CVEs in 2026 (06 §3.1) |
| Secrets | `@napi-rs/keyring` 2.1.2 (Windows Credential Manager) holds **one master key**. Tokens are stored AES-256-GCM encrypted in SQLite | keytar has been abandoned since 2022. The Credential Manager blob limit is about 2.5 KB (UNVERIFIED) (06 §1.4) |
| Scheduler | `croner` 10.x inside the daemon. A Windows Task Scheduler task starts the daemon at logon with `StartWhenAvailable` | $0 (06 §3.3) |
| Schemas | `zod` for every tool input, payload and config | |
| Markdown | `gray-matter`, `unified`/`remark-parse`/`remark-mdx`/`remark-gfm`, `remark-stringify`, `rehype-stringify` | The same pipeline family as the site (06 §3.1) |
| Rasterizing | **[Architect's call]** Playwright (Chromium) for table→PNG and interactive-diagram snapshots, and `@resvg/resvg-js` for SVG→PNG | Fidelity to the site's CSS. Playwright only screenshots the user's own public site; it is never used on a third-party platform |
| Presence check | **Windows Hello** via WinRT `Windows.Security.Credentials.UI.UserConsentVerifier`, called from Windows PowerShell 5.1 with an `execFile` args array. Required on every Approve and on enabling publishing (section 2.6). A 1-hour spike runs first in Phase 0 | The only human channel listed here that a model driving the browser or desktop cannot satisfy. Whether the call works from the daemon's own process (started by Task Scheduler, no visible window) is UNVERIFIED, and that is what the spike tests |
| Asset host | **[Architect's call] Deferred to Phase 2.** Phase 0–1 need no public media URLs: LinkedIn uses a link attachment, Bluesky and Mastodon upload media natively, assist kits hand the user local PNGs, and dev.to interactive diagrams become a text link to the canonical (section 2.4). In Phase 2, **Cloudflare R2** sits behind an `AssetHost` interface, unless the S2 spike finds a native Buffer upload mutation, in which case R2 is dropped for Buffer | Buffer's API references media by URL (section 3). Free tier: 10 GB-month, 1M Class A and 10M Class B operations, free egress ([Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/), verified on the official page). Third-party guides say Cloudflare asks for a **payment method before the first bucket** (no charge within the free tier) ([tech-insider guide](https://tech-insider.org/au/how-to-set-up-cloudflare-r2-2026/), [eastondev](https://eastondev.com/blog/en/posts/dev/20251130-r2-picgo-setup/)). UNVERIFIED on an official Cloudflare page |
| Video (phase 2) | Remotion (local render), ElevenLabs REST | Covered in 05 and in section 6 |
| Package layout | pnpm workspace: `packages/core` (model, transforms, adapters), `packages/daemon` (API, dashboard, scheduler, db), `packages/mcp`, `packages/cli`, and later `packages/video` (Remotion project) | Clear boundaries. `core` has no I/O, which keeps it unit-testable |

The Windows path contains spaces (`<projects>\...`). Every spawned CLI (git, ffmpeg, remotion, playwright) gets quoted paths and an `execFile` argument array, never a shell string. A smoke test in CI covers this (05 risk 6).

### 2.3 Content source of truth and read-only ingestion

**Source:** a local clone of the site, `C:\path\to\your-site`, configured as `site.repoPath`. The tool never writes there. **[Architect's call]** For a future cloud host, a `GitHubRawSource` fallback reads `ZeeshanAdilButt/personal-site` over HTTPS.

What the tool reads (06 §1.1, checked against the repo on 2026-10-19):
- `content/posts/<slug>.mdx`. Frontmatter fields:
  - `title`;
  - `date` (`"YYYY-MM-DD"`);
  - `category` (one of `engineering`, `case-study`, `productivity`, `community`);
  - `tags[]`;
  - `description`;
  - `published` (bool);
  - `coverImage` (an SVG path under `/images/blogs-covers/`; a PNG twin sits next to it, produced by `scripts/covers-to-png.js`).

  The body is MDX, with `import` lines, `<Callout type="note|aside|alert" title?>`, the interactive diagrams `<PacketJourney name>`, `<StateMachine name>` and `<OutOfBandDiagram>`, GFM tables, and site-relative SVG images.
- `content/publishing-notes/<slug>.md`. Bold-label lines:
  - `**Primary title:**`, a bulleted `**Alternate titles**`, `**URL slug:**`;
  - `**Meta title:**`, `**Meta description:**`, `**Excerpt (index/home):**`;
  - `**OG / social card text:**`, `**Social visual concept:**`, `**Search intent:**`;
  - `**Key entities / terms:**`, `**Suggested internal links:**`, `**Further-reading path:**`.

  Then come the `## Fact labels used` and `## Verify before publishing` sections. Not every post has a notes file. Of 15 posts, 4 have notes today.
- `git --no-optional-locks rev-parse HEAD` and `git --no-optional-locks status --porcelain -- <file>`, run with env `GIT_OPTIONAL_LOCKS=0` as well. They record which commit the content came from and warn when the local file has uncommitted changes, which means it is probably not what is deployed. Plain `git status` is **not** strictly read-only: it can refresh stat data and rewrite `.git/index` when it can take `index.lock`, and that can collide with the owner's own git commands. `--no-optional-locks` prevents this.

**Read-only enforcement:**
1. A `SiteReader` module is the only code with the site path. It exposes only `readFile`, `list` and `gitHead`.
2. A guarded fs wrapper throws if any write API gets a path under `site.repoPath`.
3. A unit test greps `packages/**` for write calls next to `repoPath`.
4. git is only ever invoked with read subcommands, from an allowlist, and only in the `--no-optional-locks` form. An integration test compares the mtime and sha256 of the site's `.git/index` before and after a full sync.

**Canonical-live gate** (06 §1.1). Before any syndication draft can be *approved*:
1. `GET https://www.example-blog.dev/blog/<slug>` must return 200, with the final URL on `www.example-blog.dev`.
2. The response must contain the post `title`. The check decodes HTML entities in the response and compares against the raw frontmatter title, because Next.js may escape apostrophes and quotes differently from any escaper we would use.
3. The frontmatter must say `published: true`.

The result is stored as `content.canonical_live_at`. The RSS feed is not used for content because it is summary-only (01 cross-cutting finding).

**Launch reference time T0** (used by every SEO delay in section 5.2). `canonical_live_at` is the first time *this tool* saw the post live. For any post that was already live before install, that is install day, not the day the post went live. So:
- `T0 = min(frontmatter.date at 00:00 site time zone, canonical_live_at)`. **[Architect's call]** The site time zone is a config value (`site.timeZone`) that defaults to the PC's Windows time zone. A few hours either way does not matter, given the 1-day slack below.
- The exception is a late deploy: if `canonical_live_at` is more than 1 day after the frontmatter date, T0 = `canonical_live_at`.
- Example: a 3-month-old post has T0 three months ago, so its dev.to `notBefore` (T0 + 48 h) is already in the past and nothing is blocked for no reason.

**Sync:** `cph sync` (also exposed as an MCP tool and run every 15 minutes by the daemon) parses every post, hashes the MDX and the notes, and upserts `content`. Sync reads only local files and the site itself, so it costs no platform API calls. If a post changes after drafts exist, those drafts are flagged `source_changed`, and any pending approvals on them are invalidated. If one of those drafts is already handed to a platform scheduler (Buffer `customScheduled`, YouTube `publishAt`), the remote scheduled post is cancelled too (section 2.6 rule 5).

**Note:** the first planned article (Systems Performance ch.1) **does not exist in the site repo yet**. No post mentions coordinated omission as of 2026-10-19. Phase 0 is therefore built and tested against an existing published post, `prometheus-cardinality-explained`, which has a notes file, using drafts only. The first real launch happens when the new post is live.

### 2.4 Canonical content model

```ts
type Slug = string;

interface ContentItem {
  slug: Slug;
  canonicalUrl: string;            // https://www.example-blog.dev/blog/<slug>
  frontmatter: { title; date; category; tags: string[]; description; published: boolean; coverImage: string };
  coverPngUrl: string;             // absolute URL of the .png twin; never upload the SVG
  doc: PortableDoc;                // MDX lowered to a neutral AST (below)
  notes?: PublishingPackage;
  source: { repoCommit: string; mdxSha256: string; notesSha256?: string; dirty: boolean };
  canonicalLiveAt?: string;        // ISO time the live check first passed (install day for old posts)
  t0?: string;                     // launch reference time, per the T0 rule in 2.3
}

interface PublishingPackage {
  primaryTitle; alternateTitles: string[]; metaTitle?; metaDescription; excerpt; ogText;
  socialVisualConcept?; searchIntent?; keyEntities: string[]; internalLinks?: string; furtherReading?: string;
  factLabels: string[]; verifyBeforePublishing: string[];  // shown as a checklist that blocks approval
}

// PortableDoc = mdast with MDX lowered into neutral node types:
//   heading | paragraph | list | code{lang} | table{rows} | image{src(abs), alt, svg?:true}
//   | callout{kind: note|aside|alert, title?, children} | interactive{component, name, anchor}
//   | blockquote | thematicBreak | html(raw, flagged)
// Unknown JSX → `unsupported` node → hard lint error (forces a transform rule, never silent loss).

interface Draft {                   // one per (content, platform, account, variant)
  id; slug; platform: PlatformId; account: string; route: 'direct'|'buffer'|'assist';
  kind: 'article'|'post'|'thread'|'video'|'newsletter'|'assist-kit';
  payload: PlatformPayload;         // zod-typed per platform
  media: { path: string; sha256: string; publicUrl?: string }[];
  authorship: 'verbatim'|'reformatted'|'ai-assisted';   // drives disclosure lines (5.4)
  notBefore?: string;               // SEO delay (section 5), computed from content.t0
  payloadSha256: string;            // sha256 of RFC 8785 canonical JSON of {platform, account, route, payload, media hashes, scheduledAt}
  remoteRef?: string;               // private remote draft id (dev.to article id, Buffer draft id)
  remoteScheduledId?: string;       // set when a platform scheduler holds the post (Buffer customScheduled, YouTube publishAt)
  status: 'draft'|'staged'|'pending_approval'|'approved'|'scheduled'|'publishing'|'unknown'|'published'
        |'handed_off'|'failed'|'held'|'source_changed';
  // publishing = remote call in flight. unknown = crash or timeout after the approval was consumed; a startup sweep
  // and a manual "check on platform" action resolve it to published or failed. It is never retried automatically.
}
```

**[Architect's call] Who produces what.** Mechanical transforms run as **deterministic code** in `core`: lowering MDX, making URLs absolute, converting Callouts to blockquotes, building tables, rasterizing, counting characters, applying tag rules. **Creative adaptation** is Claude's job through MCP prompts: the LinkedIn hook, the thread breakdown, the newsletter intro. The tool **validates** Claude's output with per-platform lint rules (length, link count, tag count, presence of the canonical URL or attribution, a takeaway present). Claude never bypasses lint. Lint errors block `request_approval`.

**Transform rules** (from 01 §"Source content" and 06 §1.1):

| Node | dev.to / Hashnode | Medium (import) | Substack (paste) | Social |
|---|---|---|---|---|
| `import` lines | strip | n/a (import reads the live page) | strip | n/a |
| Callout | `> **Note:** …` (alert becomes `> **Big Word Alert: X** …`) | fix-up kit item | blockquote in HTML | can be the source of a takeaway |
| Interactive diagram | Phase 0–1: a text block, `> **Interactive diagram: <name>.** Open it on the original post: <canonical>#anchor`. A PNG snapshot replaces it once an asset host exists (Phase 2). Never a placeholder image: lint rule `placeholder-image` is an error that blocks approval | PNG + link in fix-up kit (local file) | PNG + link (local file) | optional image |
| GFM table | keep GFM | PNG in kit | PNG | flatten to bullets |
| SVG image | absolute site URL (spike S3: does dev.to render SVG? If not, link the site's PNG twin where one exists, otherwise a text link until Phase 2) | PNG in kit | PNG | PNG |
| Code | fenced with language | kit note: check language | `<pre><code>` | avoid; use an image if essential |
| Attribution | `canonical_url` / `originalArticleURL` + footer line | canonical is set by Import + footer line | **header line "Originally published at …"** (the only SEO signal available) | link to canonical with UTM |

### 2.5 Platform adapters: transform × route

Each destination is a pair:
- a **Transform** (platform-specific rendering and lint, pure);
- a **Route** (how the bytes leave the machine).

The two are configured separately, so LinkedIn can move from `buffer` to `direct` without touching the transform. This is the vendor-swap protection called for in 04 risk 7.

```ts
interface Transform<P> { platform: PlatformId; limits: Limits;
  skeleton(item: ContentItem): Partial<P>;          // deterministic defaults (title, tags, canonical, media)
  lint(p: P, item: ContentItem): LintResult[]; }

interface Route<P> { kind: 'direct'|'buffer'|'assist';
  connect(): ConnectFlow;  health(): Promise<Health>;
  stage?(d: Draft<P>): Promise<RemoteRef>;          // PRIVATE remote draft only (see 2.6 rule 6)
  publish(d: Draft<P>, a: VerifiedApproval): Promise<Publication>;   // only callable by the gate
  cancelScheduled?(d: Draft<P>): Promise<void>;     // delete/unschedule a post held by the platform's scheduler
  checkOnPlatform?(d: Draft<P>): Promise<'published'|'not_found'|'unknown'>;  // resolves the `unknown` state
  handOff?(d: Draft<P>): Promise<AssistKit>;        // assist: clipboard + open URL + checklist
  costEstimate(d: Draft<P>): Money; }
```

**Route contract: what you approve is what is sent.** A route may not drop any hashed payload field. If a field is in `payload` (and therefore in the hash and on the approval card), the route must send it to the platform. If the platform cannot take a field, the field is removed from that platform's payload type, and the card says what the platform will do instead. Each route has a contract test that builds a payload with every field set, runs `publish` against a recording fake, and asserts every field reaches the wire.

### 2.6 The approval gate (hard rule)

Threat model (06 §2.4, extended for this user's setup):
- The model, or a prompt-injected page, calls `publish` on its own.
- An old approval gets reused for changed text.
- A client-side "always allow" quietly removes the prompt.
- **The model drives the approval UI itself.** The owner runs Claude with the claude-in-chrome and computer-use MCPs. Claude can open `http://127.0.0.1:4646/approvals`, tick the boxes and click Approve. It can also read anything shown on screen, including a code in a Windows toast or on a dashboard card.
- **A same-user process goes around the daemon.** Claude's Bash or PowerShell tool runs as the same Windows user. It can read `api-token:cli` and the master key from Credential Manager (for example `node -e "require('@napi-rs/keyring')..."` from the repo), mint a dashboard login nonce, or decrypt the Buffer key and call Buffer directly.
- **Project-scoped Claude settings don't follow Claude around.** Rules in `content-powerhouse\.claude\settings.json` load only when Claude Code runs in that directory. The owner works from several directories, for example `D:\Projects - Community`.

**Server-enforced rules:**
1. **There is no publish without an approval.** Publishing (the dashboard's **Approve & publish**, or MCP `publish(draft_id, approval_id)` / `schedule(...)`) succeeds only if the approval is:
   - in state `approved`;
   - single-use;
   - unexpired (30 minutes for publish-now, or until fire time + 15 minutes for a scheduled post);
   - for a `payload_sha256` equal to the draft's **current** hash.

   The hash covers the platform, account, route, payload, media hashes and scheduled time. Any edit invalidates the approval. Both paths go through the same `authorize()` function.
2. **Only a human-presence channel can create approvals.** The dashboard click and the out-of-band code are **not** model-proof on this machine, so neither counts on its own:
   - **(a) Dashboard click + Windows Hello** (Phase 0, required while `publishing_enabled` is true). `request_approval` returns `Pending: approve at http://127.0.0.1:4646/approvals/<id>`. The approval card shows:
     - the exact rendered payload, exactly as it will be sent (see the route contract in 2.5);
     - the platform and account;
     - the route;
     - the cost, and for metered providers the quota left (Buffer API budget, ElevenLabs characters);
     - the "Verify before publishing" checklist from the publishing notes. Every box must be ticked before the buttons enable;
     - the SEO `notBefore`.

     The buttons are protected by CSRF and a SameSite=Strict cookie. When the POST arrives, the **daemon** (not the browser) calls Windows Hello `UserConsentVerifier` with the text "Approve: <platform> post for <slug>". The approval is recorded only if Hello returns `Verified`. A model can click the button but cannot supply the owner's face, fingerprint or PIN.
   - **(b) MCP elicitation in Claude Code**, only as the **fallback if the Hello spike fails**. The client renders a form with `decision: ["Publish now", "Cancel"]` and the owner answers in the Claude Code TUI, where the model is not in the loop. Claude Code ≥2.1.76 supports elicitation; Claude Desktop is UNVERIFIED. Document "do not auto-answer content-powerhouse elicitations". Residual risk: computer-use gets only "click" tier on terminals, so it cannot type an answer, but it might click one. Hello is strongly preferred.
   - **Dropped:** the out-of-band 6-digit code channel from revision 1. A model with screenshots can read the toast, so it adds nothing over (a).
   - **Never** return a confirm token in a tool result, because the model would simply echo it back.
3. **[Architect's call] No "approve all".** Per-action means one approval per (draft, platform, account, time). The dashboard makes this fast: a keyboard-driven queue, one card per action, one Hello prompt per Approve. Whether a single "launch plan" approval that lists every action can count is open question Q1.
4. **`publishing_enabled`** (default `false`, shown in the dashboard as **Publishing: DISABLED / ENABLED**). The term "kill switch" is not used anywhere in the UI or code, because it reads backwards. Turning publishing on also needs Windows Hello. There is also a per-platform `dry_run` mode that renders and logs without sending.
5. **Pre-publish checks.**
   - Checked at authorize time, and again at fire time for jobs the **daemon** schedules (direct routes):
     - the canonical is live;
     - `notBefore` has passed;
     - lint is clean;
     - the hash has not already been published to this platform (duplicate check);
     - the cost is within the configured monthly cap (for example X);
     - the connection is healthy.
   - **Platform-side scheduled posts** (Buffer `customScheduled`, YouTube `publishAt`) are checked once, at **hand-over** time. The platform fires them later without asking us. To keep the approval meaningful, the daemon records the remote scheduled id. If the draft is edited, cancelled or becomes `source_changed` while scheduled, the daemon calls the route's `cancelScheduled` (Buffer's delete-post mutation, or YouTube `videos.update` back to private with no `publishAt`). The dashboard then shows a red card: "Remote scheduled post cancelled, re-approve". If the cancel call fails, the card is red with a "cancel it by hand in Buffer" deep link and a toast.
6. **Staging is allowed. Publishing is gated.** Creating a **private** remote draft is a "stage" action. It does not need an approval, but it is logged and shown. Examples:
   - dev.to `published:false`. A re-stage runs only for drafts in status `draft` or `staged`, and first reads the article back from dev.to. If the article is already published (through cph or by hand on dev.to), the stage is refused. Any edit to a live article is a publish and needs its own approval;
   - a Hashnode draft;
   - a Buffer draft (`saveToDraft: true`). Buffer's `addToQueue` mode would otherwise put the post in the next queue slot, so a dropped or renamed flag would turn a stage into an unapproved publish. The route asserts the response says `post.status === 'draft'`. If it does not, it deletes the post at once, marks the draft `failed` and alerts the owner. `addToQueue` may appear in code only next to `saveToDraft: true` (a source rule);
   - a YouTube private upload (direct route, phase 3).

   The route code must hard-set the private field. For example, YouTube's API now defaults to `public` when `privacyStatus` is omitted (03 §1.2). Each such field gets a unit test. Endpoints that can go live directly are **forbidden in code**:
   - Hashnode `publishPost` and the MCP direct-post tool;
   - Substack's importer;
   - Buffer `mode: shareNow` outside `publish()`.
7. **Assist routes satisfy the rule by construction.** The tool prepares the payload, copies it to the clipboard and opens the compose or import page. The **user's own click** publishes. The draft moves to `handed_off`. The user pastes back the live URL, or the daemon detects it where a public read exists (dev.to `/api/articles/me`, Medium RSS `medium.com/feed/@<user>`), and the publication is recorded.
8. **Audit log.** Append-only: `{ts, actor_channel, draft_id, approval_id, hash, platform, route, request summary, response id/url, cost}`. `actor_channel` records `dashboard+hello` or `elicitation`.
9. **Defense in depth on the client** (none of this is the gate; it narrows the paths around it):
   - **User scope, not project scope.** With the owner's approval, `cph install` writes to `~/.claude/settings.json` (user scope, so it applies in every directory):
     - `permissions.ask` on `mcp__content-powerhouse__publish` and `mcp__content-powerhouse__schedule`. The primary path is the dashboard's **Approve & publish** button, so this prompt fires only when Claude starts a publish. It is a config option (`claude.askOnPublish`, default on);
     - a `PreToolUse` hook (`cph-guard`) that blocks claude-in-chrome tool calls whose input references `127.0.0.1:4646` or `localhost:4646`, and Bash or PowerShell commands that reference the content-powerhouse keyring entries (`content-powerhouse` together with `keyring`, `Credential`, `cmdkey`, `api-token` or `master-key`) or the state dir. A hook is used because permission rules match MCP tools by name only and cannot inspect a URL argument (check against current Claude Code docs at build time; UNVERIFIED).
   - These rules are bypassable (an obfuscated command, a computer-use click on an already-open tab), which is why Hello is the gate and not these rules.
   - **[Architect's call]** The Buffer MCP is **not** added to Claude, and **Buffer's own Claude integration** ("Manage your Buffer queue and draft posts from Claude", included on all plans per [buffer.com/pricing](https://buffer.com/pricing)) stays **disabled** in claude.ai. If it is enabled, Claude can post to Buffer outside this gate. If the user later wants Buffer in Claude for analytics, deny `create_post`, `edit_post`, `delete_post` and `execute_mutation` (04 §1, §10). Claude reaches Buffer only through cph routes, behind the gate.

**What the owner confirms, in steady state** (Phase 1 onward, defaults until Q1 is decided):

| When | Confirmation | How often |
|---|---|---|
| Once, at setup | Approve the install side effects (Task Scheduler entry, Claude registrations, `~/.claude/settings.json` hook) | Once |
| Once per session of publishing | Turn **Publishing: ENABLED** on (Windows Hello) | Rarely. It stays on until turned off |
| Each public action | Tick the checklist, click **Approve & publish** (or **Approve & schedule**), pass Windows Hello | **One per action. This is the "explicit confirmation per action"** |
| Only if Claude calls `publish` itself | Claude Code's `permissions.ask` prompt | Configurable; does not fire on the dashboard path |

A chat "yes" is **not** required per action (default until Q1 is decided). Phase 0's one-off live test is the exception: it also needs the owner's explicit OK in chat for that post (Q4).

**Approve-then-publish hand-off.** Two paths, one `authorize()`:
- **Dashboard-first (default).** The card's primary button is **Approve & publish**. The Hello-verified click is the approval, and the daemon publishes at once through `authorize()`. For a scheduled draft the button is **Approve & schedule**.
- **Claude-first.** The secondary button is **Approve only**. `request_approval` tells Claude: "Ask the owner to approve at <url>. Then call `get_approval_status` every 15 s for up to 10 minutes. Stop when the status is `published`, `approved`, `denied` or `expired`." On `approved`, Claude calls `publish(draft_id, approval_id)` within the 30-minute TTL. On `published` (The owner used Approve & publish), Claude reports the URL. After 10 minutes Claude stops polling and says the approval is still waiting.

### 2.7 State store (SQLite schema sketch)

```
content(slug PK, canonical_url, title, date, mdx_sha256, notes_sha256, repo_commit, dirty, published, canonical_live_at, t0, synced_at)
assets(id, slug, kind[cover|diagram|table|snapshot|video|caption|thumb], local_path, sha256, public_url, url_expires_at)
drafts(id, slug, platform, account, route, kind, payload_json, payload_sha256, authorship, not_before, scheduled_at, status, remote_ref, remote_scheduled_id, created_at, updated_at)
approvals(id, draft_id, payload_sha256, channel[dashboard_hello|elicitation], mode[publish_now|approve_only|schedule], status, presence_verified_at, expires_at, decided_at, used_at)
api_budget(provider, window[15m|24h|30d], limit, remaining, resets_at, observed_at)  -- from response quota headers (Buffer)
settings(key PK, value)                                           -- publishing_enabled=false, dry_run:<platform>, caps
jobs(id, draft_id, approval_id, run_at, status[pending|running|done|failed|held], attempts, last_error)
publications(id, draft_id, platform, account, remote_id, remote_url, published_at, cost_usd)
connections(platform, account, route, status, expires_at, last_health_at, last_health_detail)
credentials(platform, account, ciphertext, iv, tag, updated_at)   -- AES-256-GCM, master key in Credential Manager
spend(month, platform, usd)                                       -- for caps (X, ElevenLabs)
audit_log(id, ts, actor_channel, action, draft_id, approval_id, hash, platform, detail_json)
video_jobs(id, slug, stage, script_json, words_json, scenes_json, mp4_asset_id, srt_asset_id, gate_a_at, gate_b_at)  -- phase 2
metrics(publication_id, ts, impressions, reactions, comments, clicks)                                               -- phase 4
```

Backup: `cph backup` writes the DB plus an encrypted export of the master key protected by a user passphrase. Without the export, a reinstall means reconnecting every platform (06 risk 10).

### 2.8 Scheduler

- **v1 host is the home PC** ($0). The daemon starts at logon through Task Scheduler (`StartWhenAvailable`, optional `WakeToRun`), and croner ticks every minute (06 §3.3).
- **Held-if-late policy [Architect's call]:** if a direct-route job is more than **2 hours** late (the PC was off), it becomes `held` and the user gets a notification. It is never published late without a fresh confirmation. This preserves the meaning of the time that was approved.
- **Platform-side scheduling is preferred where it exists.** On the Buffer route an approved scheduled post goes to Buffer with `mode: customScheduled, dueAt`, so it fires even when the PC is off ([Buffer MCP guide](https://developers.buffer.com/guides/integrations/mcp.html)). On the YouTube direct route (phase 3), `videos.update publishAt` hands the schedule to YouTube (03 §1.5). The trade-off: these posts are checked at hand-over, not at fire time, so the daemon stores `remote_scheduled_id` and cancels the remote post whenever the draft is edited, cancelled or becomes `source_changed` (section 2.6 rule 5). If the PC is off when the MDX changes, the cancel happens at the next sync after logon. A post due before then still goes out with the approved text.
- **Crash recovery.** A draft left in `publishing` after a crash or timeout becomes `unknown`. A startup sweep calls `checkOnPlatform` where the route supports a read (dev.to `/api/articles/me`, Buffer post status), and otherwise leaves a dashboard card with a manual **Check on platform** action. An `unknown` draft is never retried automatically.
- **SEO delays** (section 5) are `notBefore` constraints. An approval can be granted early with `scheduledAt ≥ notBefore`.
- Cloud move (optional, phase 4): Fly.io shared-cpu-1x 256 MB + 1 GB volume, about **$2.34/month**. The master key then comes from a Fly secret (06 §3.3). Vercel Hobby cron (once a day, ±59 min) does not fit.

### 2.9 Interfaces

**MCP tools** (the stdio facade; names from 06 §2.3, plus video tools in phase 2):

| Tool | Effect | Notes |
|---|---|---|
| `sync_content` | read site, update the DB | |
| `list_content` / `get_content` | read | Status per platform; frontmatter, publishing package and live check |
| `list_connections` | read | Never returns secrets |
| `open_dashboard{page}` | opens the browser | The daemon itself opens the default browser to a fresh one-time login URL for `page` (for example `connections/devto`, `approvals`). The nonce is never returned to Claude. This makes "connect dev.to" one click in chat |
| `connect_platform` | opens the browser | Calls `open_dashboard` for that platform's connect card. Secrets are never accepted through MCP |
| `preview_adaptation` | read | Deterministic skeleton + lint for a platform |
| `create_draft` / `update_draft` / `list_drafts` | local write | Returns `draft_id`, `payload_sha256` and lint |
| `stage_remote_draft` | external **private** write | Only on routes with a private stage (dev.to, Hashnode Pro, Buffer draft, YouTube private) |
| `plan_launch` | local write | Creates every draft for a post following section 5, with `notBefore` set |
| `request_approval` | local write | Returns the pending id, where to approve, and the polling instruction from 2.6 (every 15 s, up to 10 min). No token |
| `get_approval_status` | read | `pending`, `approved`, `published` (with URL), `denied`, `expired` |
| `publish` / `schedule` | **external write** | Needs an `approval_id` created through the Approve-only button. Annotated `destructiveHint`/`openWorldHint`. Secondary path; the default is the dashboard's Approve & publish |
| `cancel_scheduled` | local / external write | Always allowed. Deletes the remote scheduled post on platform-scheduled routes |
| `check_on_platform{draft_id}` | read (platform) | Resolves an `unknown` draft |
| `hand_off` | local + clipboard + opens browser | Assist routes. Returns the checklist |
| `record_publication` | local write | For assist hand-offs: the user supplies the URL |
| `get_publish_log` | read | |
| `video_plan` / `video_voice` / `video_render` / `video_preview` (phase 2) | local compute + spend | There is **no** publish tool in the video module (05 §8). Voice generation shows the estimated cost and respects the ElevenLabs monthly cap |

**Resources:** `content://posts/{slug}`, `content://notes/{slug}`, `drafts://{id}`, `connections://status`, `approvals://pending`.

**Prompts:** `adapt-linkedin`, `adapt-x-post` (`adapt-x-thread` only once threads are enabled, Q7), `adapt-bluesky`, `adapt-mastodon`, `adapt-devto-intro`, `adapt-substack-edition`, `adapt-reddit`, `short-script-60s`. Each is seeded with the publishing-package fields and the voice and style rules from section 5.5.

**CLI (`cph`):** `status`, `setup <platform>`, `connect <platform>`, `disconnect`, `sync`, `plan <slug>`, `drafts`, `dashboard` / `approve` (opens the dashboard, signed in), `check <draft>` (check on platform), `log`, `backup`, `revoke-all`, `doctor` (checks Node, paths, git, ffmpeg, playwright, ports).

**Dashboard pages:** Connections, Content (posts × platforms matrix), Drafts (edit and preview), **Approvals queue**, Schedule, Log, Spend.

**Install (Phase 0):** `pnpm i && pnpm build && node packages\cli\dist\index.js install`. `cph install` shows each side effect and asks before it does it:
1. creates the master key and the scoped API tokens in Credential Manager;
2. registers the Task Scheduler entry that starts the daemon at logon;
3. links `cph` globally (`pnpm link --global`, run in `packages/cli`), so `cph` is on PATH. This is part of install, not optional, because the sign-in fallback says "run `cph dashboard`";
4. runs `claude mcp add --scope user content-powerhouse -- node "<repo>\packages\mcp\dist\index.js"`. **User scope**, so the tools appear in every directory, including `D:\Projects - Community`. The default `local` scope would show them only inside the repo;
5. merges a `content-powerhouse` entry into Claude Desktop's `%APPDATA%\Claude\claude_desktop_config.json` (`mcpServers.content-powerhouse = {command: "node", args: ["<repo>\\packages\\mcp\\dist\\index.js"]}`), backing up the file first. Claude Desktop needs a restart. No `.mcpb` bundle is needed for this;
6. writes the user-scope `~/.claude/settings.json` rules and the `cph-guard` hook (section 2.6 rule 9), merging with what is there and backing it up.

User-scope registration means the project's own `.claude/settings.json` rules do not apply when Claude runs elsewhere, which is why step 6 exists. A `.mcpb` bundle (06 §2.2) is an optional Phase 3 nicety. A remote MCP for claude.ai on web or phone is phase 4: Cloudflare Tunnel plus OAuth (06 §2.2).

---

## 3. Connector strategy per platform

Routes:
- **direct:** our code calls the official API.
- **buffer:** our code calls Buffer's official API, and Buffer holds that platform's OAuth.
- **assist:** the tool prepares the post and the user clicks.
- **import:** the platform's official import tool, run by the user.
- **browser automation:** **never used** (Medium Rules ban it; Substack's ToS bars reverse engineering; LinkedIn browser-session MCPs risk restriction: 01 §3, §4; 04 §9).

| Platform | v1 route | Mechanism | Why this route | Fallback | Phase |
|---|---|---|---|---|---|
| **Site** (canonical) | read-only ingest | fs read + `GET` canonical | Source of truth. Site repo is read-only | GitHub raw | 0 |
| **dev.to** | **direct** | Forem API v1 `POST /api/articles` with `published:false`, `canonical_url`, `series`, `main_image`, ≤4 tags; publish = `PUT published:true` after approval | Free, official, private drafts, canonical supported, key-paste connect (01 §1) | assist (paste markdown) | 0 |
| **LinkedIn** (member posts) | **buffer** | Buffer API `create_post` to the LinkedIn channel: text plus a link card through `metadata.linkedin.linkAttachment` (title, description, thumbnail), or image/video/**document** assets. The guide says a link attachment "cannot be sent alongside a non-empty `assets` array" ([Buffer MCP guide](https://developers.buffer.com/guides/integrations/mcp.html)). The exact input fields are confirmed by S2 introspection; if they can't be, the link card is dropped from the payload and LinkedIn builds the preview from the page's OG tags | One OAuth click inside Buffer. No LinkedIn dev app, no Page requirement, no 60-day re-auth on our side, no HTTPS-redirect uncertainty (02 §1; 06 risk 2). $0 on Buffer Free | assist (copy + open the LinkedIn composer) → phase 3 **direct** (`/rest/posts`, `w_member_social`) if Buffer lacks SRT captions or document posts | 0 |
| **LinkedIn Articles / Newsletter** | **assist** | Paste-ready rich HTML + checklist | No API exists (02 §1) | — | 1 (optional) |
| **X** | **buffer** | **Default: a single post** (one complete takeaway + link, ≤280 chars). Buffer Free lists "Threaded posts: 1" ([buffer.com/pricing](https://buffer.com/pricing)); whether that means one at a time or one in total is unclear. Threads use `metadata.twitter.thread`, where the top-level `text` repeats the first item and the thread array holds every post (same Buffer guide). They are enabled only after S2(f) confirms "one at a time" and that publish-now threads don't count, or on Buffer Essentials | Covers X without an X dev app or card. Avoids pay-per-use if Buffer absorbs X costs (UNVERIFIED, 04 §1) | **assist** (X web intent per post, $0; also the fallback for threads) → **direct** pay-per-use API with prepaid credits, a $5/cycle cap and auto-recharge OFF (02 §2) | 1 |
| **YouTube Shorts** | **buffer** | Buffer API: video asset + `metadata.youtube` title and category. Buffer exposes no privacy field (UNVERIFIED), so `shareNow` posts publicly and Gate C is the only control | Avoids the Google Cloud project, the consent-screen trap and the ambiguous unverified-project private lock (03 §1.2; 04 §9). $0 on Buffer Free | assist (YouTube Studio upload bundle) → phase 3 **direct** Data API v3 (private upload → `publishAt`, caption track, `containsSyntheticMedia`) after a smoke test | 2 |
| **LinkedIn video** | **buffer** | Same LinkedIn channel, video asset | Same reasons as LinkedIn | assist / phase 3 direct Videos API (03 §2) | 2 |
| **Bluesky** | **direct** | AT Protocol `createRecord` with an app password; facets for links; `getUploadLimits` at runtime for video | Easiest connect of all, free (02 §3) | buffer | 1 |
| **Mastodon** | **direct** | `POST /api/v1/statuses` + `/api/v2/media` with a personal token; `Idempotency-Key` | Free, a paste of one token, instance limits read at runtime (02 §6) | buffer | 1 |
| **Hashnode** | **assist** (free) / **direct** if Pro | Free: markdown + checklist, user sets "Are you republishing?" → Original URL. Pro: GraphQL `createDraft` with `originalArticleURL`, then `publishDraft` after approval | API, MCP and CLI need Pro at **$5/mo or $50/yr** (01 §2, [hashnode.com/pro](https://hashnode.com/pro)). Lowest-reach destination, so Pro is optional | — | 1 |
| **Medium** | **import** + assist kit | User runs Stories → Import a story → canonical URL. The tool produces a fix-up kit (PNG tables and diagrams, an ordered checklist, title/subtitle, ≤5 topics) | No new API tokens. Rules ban programmatic posting and browser add-ons. Import sets the canonical automatically (01 §3) | Paste rich HTML from the clipboard + set canonical by hand. If the user has a **pre-2025 integration token** (Q6), direct becomes possible | 1 |
| **Substack** | **assist** | Rich HTML (CF_HTML clipboard) + PNGs + title, subtitle, email preview. Newsletter edition by default (5.3) | No posting API. The official MCP is read-only and Bestseller-only. The importer publishes immediately. Cookie libraries put the account at risk (01 §4) | — | 1 |
| **Threads** | **deferred** → buffer | Buffer Essentials channel (+$5/mo) | Direct needs a Meta app, tester role, an HTTPS redirect and a public video URL (02 §4) | direct tester mode | 3 |
| **Reddit** | **assist** | Per-subreddit title and body + pre-filled `…/submit?type=link&title=&url=` | New OAuth tokens need manual approval and personal scripts are rejected. High ban risk (02 §5) | — | 1 |
| **TikTok / Instagram Reels** | **deferred** → buffer | Buffer channels | Unaudited TikTok is SELF_ONLY. IG needs a Meta app + public URL (03 §3–4) | — | 3+ |
| **ElevenLabs** (voice) | **direct** | REST `/v1/text-to-speech/{voice_id}/with-timestamps` | Timestamps, caching and versioning stay under our control (05 §1). The hosted MCP (OAuth) is optional for ad-hoc work in Claude | Cartesia Pro $5/mo; Kokoro (local, not the user's voice) | 2 |

**[Architect's call] Buffer over direct for OAuth-heavy platforms.** Report 04 recommends Buffer and report 06 recommends direct. Buffer wins on the user's top requirement:

- **Setup:**
  - Buffer: sign up, click Connect three times, paste one key.
  - Direct: register three developer apps (LinkedIn with a Page, Google Cloud with a consent screen, the X console with a card).
- **Upkeep:** direct LinkedIn needs a re-auth every 60 days. Buffer, as a partner, handles that (04 §9).
- **Cost:** Buffer Free covers exactly the three channels that need it (LinkedIn, YouTube, X) at **$0** ([buffer.com/pricing](https://buffer.com/pricing), 04 §1).
- **Limits that shape the design** (Free, verified on [buffer.com/pricing](https://buffer.com/pricing) 2026-10-19):
  - API: **100 requests per 15 min, 250 per 24 h, 3,000 per 30 days**, 1 API key. Health probes are therefore metered (section 4.4);
  - 10 scheduled posts per channel;
  - "Threaded posts: 1", hence the single-post X default.
- **Gating:** Buffer supports `saveToDraft`, `shareNow` and `customScheduled` with `dueAt`, which map onto our stage and publish steps. Stages are verified to have landed as drafts (section 2.6 rule 6).
- **What we give up:**
  - Buffer holds those tokens, and a Buffer API key gives full account access. It is stored in our secret store and never given to Claude.
  - Buffer's own Claude integration is included on every plan. It must stay disabled in claude.ai, or Claude could post outside the gate.
  - Fine-grained control is lost: YouTube caption tracks, `containsSyntheticMedia`, LinkedIn SRT, YouTube privacy. Burned-in captions cover accessibility.
- **Exit path:** the Route interface makes moving to direct a config change plus one adapter.

Buffer specifics to verify in the phase 0 spike S2 (read-only introspection and drafts only), all UNVERIFIED. The letters match plan task T0.22:
- (a) whether there is a **native upload mutation**. If there is, R2 is dropped for Buffer. If not, media is passed **by public URL** (the guide's edit semantics imply `url`). Also the asset input shape for video and document, and whether LinkedIn video and YouTube Shorts take a 9:16 MP4;
- (b) whether X API costs are passed through on Free;
- (c) the field on `Post` that gives the live LinkedIn URL after sending;
- (d) how a disconnected channel shows up in `get_channel`;
- (e) the `metadata.linkedin.linkAttachment` input fields (url, title, description, thumbnail);
- (f) what "1 threaded post" means (one at a time or one in total), and whether publish-now threads count;
- (g) the Free-plan limit of 10 scheduled posts per channel. It is fine for publish-now, but tight if many shorts are queued ahead;
- (h) the delete-post mutation and `allowedActions` (needed to cancel scheduled posts and to undo a stage that did not land as a draft);
- (i) the `post.status` value for a draft, and the names of the remaining-quota response headers;
- (j) **when Buffer downloads an asset URL**: at create time or at send time. Tested in Phase 2 once an asset host exists, with a draft whose asset URL expires in 10 minutes, read back after expiry. This decides the presign TTL in section 4.2.

---

## 4. "Connect in one step" UX

### 4.1 Principles

1. **Secrets never pass through Claude.** `connect_platform` makes the daemon open the signed-in dashboard card in the default browser (the login nonce never reaches Claude). Keys are pasted only into the dashboard or `cph connect` (06 §1.2; the MCP spec says servers MUST NOT collect secrets through form elicitation). Note that this does not hide secrets from a same-user process; see R1.
2. **Developer-app chores become a guided checklist.** Each step is a deep link, an exact value to copy, and a paste field.
3. **"Manual" is a first-class state** (blue). It is not an error.
4. **Every connection runs a health check immediately** and shows *who* it is connected as.

### 4.2 Exact flows

| Platform | User steps (target under 2 minutes) | Secret stored | Health check |
|---|---|---|---|
| **Claude Code + Claude Desktop** | Nothing beyond approving `cph install`, which registers the MCP server at user scope for Claude Code and merges the Claude Desktop config (section 2.9). Restart Claude Desktop once | per-install MCP token (Credential Manager) | `/mcp` lists `content-powerhouse`; `list_connections` answers |
| **dev.to** | In chat: "connect dev.to" (Claude calls `connect_platform`, the card opens signed in), or Dashboard → *Connect dev.to* → link opens `dev.to/settings/extensions` → "DEV Community API Keys" → description `content-powerhouse` → Generate → paste | API key | `GET /api/users/me` shows the username (01 §1) |
| **Buffer** (unlocks LinkedIn, X, YouTube) | 1) Sign up at buffer.com (Free). 2) In Buffer, *Connect channel* → LinkedIn profile, X, YouTube (one OAuth click each). 3) Buffer Settings → API → create key → paste into the dashboard. 4) The dashboard lists Buffer channels and the user maps each one (for example "LinkedIn: The owner"). 5) Leave Buffer's Claude integration **off** in claude.ai (disconnect it if it is on). Done | Buffer API key | Metered (section 4.4): one `channels()` call with the cached org id, once a day and right before each publish. Each mapped channel shows connected or disconnected. A disconnected channel shows "Reconnect in Buffer" with a deep link |
| **Bluesky** | Bluesky → Settings → Privacy and security → **App passwords** → Add `content-powerhouse` → paste handle + app password. (For video: confirm the account email is verified) | handle + app password; session JWTs refreshed with `refreshSession`, never one session per post (300/day cap) | `getSession` (02 §3) |
| **Mastodon** | Enter the instance (for example `hachyderm.io`) → link opens `https://<instance>/settings/applications/new` → name it, scopes `write:statuses write:media read:accounts` → Submit → copy the access token → paste | instance URL + token | `verify_credentials`; also caches `/api/v2/instance` limits (02 §6) |
| **Hashnode** | Free: nothing to connect ("manual"). Pro: hashnode.com → Settings → Developer → Generate token → paste → choose the publication | PAT | GraphQL `me { username publications }`; check the `errors[]` array (01 §2) |
| **Medium** | Nothing to connect. A one-time card: "Are you logged into Medium in your default browser? Do you have a pre-2025 integration token? (Settings → Security and apps)" | none | n/a (manual) |
| **Substack** | Nothing to connect. A one-time card asks for the publication URL, used to open `…/publish/post` | none | n/a (manual) |
| **Reddit** | A one-time card: list the target subreddits plus a per-sub rules note | none | n/a (manual) |
| **R2 asset host** (Phase 2, and only if S2 finds no native Buffer upload) | **This is not a 2-minute connect, and it needs a card.** Cloudflare dashboard → R2 → enable R2 (third-party guides say Cloudflare asks for a **payment method before the first bucket**; no charge within the free tier; UNVERIFIED officially) → Create bucket `cph-media` → *Manage API tokens* → Object Read & Write on that bucket → paste account ID, access key ID and secret. The dashboard shows each click with a screenshot. **[Architect's call]** Presigned GET URLs get TTL = `max(24 h, dueAt − now + 24 h)`, capped at the 7-day S3 presign maximum. Because of that 7-day cap, media posts are scheduled at most 7 days ahead, so one 14-day lifecycle rule keeps every object until at least `dueAt + 7 d`. If S2(j) shows Buffer downloads at create time, the TTL can stay 24 h. Alternative if presigned URLs with query strings are rejected: a public bucket with unguessable `sha256` object keys | S3-style keys | `PutObject` + `HeadObject` of a 1-byte probe |
| **ElevenLabs** (phase 2) | elevenlabs.io → Profile → API keys → create (with a quota limit if offered) → paste. The dashboard then lists `GET /v1/voices` so the user can pick their PVC voice | API key + `voice_id` | `GET /v1/user/subscription` gives `character_count` / `character_limit`. The spend cap is sized from it at runtime and the remaining quota is shown on every Gate A card |
| **X direct** (optional fallback) | `cph setup x`: console.x.com → create a project/app → OAuth 2.0, type Native App, callback `http://127.0.0.1:53682/callback/x` (copy button) → paste the client ID → add a card and **buy prepaid credits** (minimum purchase amount UNVERIFIED; the $20 bonus credit applies only after saving a card *and* completing a first credit purchase) → **set a $5 spend cap, auto-recharge OFF** (the user does the billing) → `cph connect x` (PKCE loopback) ([X pricing](https://docs.x.com/x-api/getting-started/pricing)) | refresh token (rotating) | token-expiry math only. Reads are billed, so do not probe (06 §1.5) |
| **LinkedIn direct** (phase 3, optional) | `cph setup linkedin`: confirm you admin a LinkedIn Page → developers app → add *Share on LinkedIn* + *Sign In with LinkedIn using OpenID Connect* → redirect `http://127.0.0.1:53682/callback/linkedin` → paste ID and secret → `cph connect linkedin` | 60-day access token | `GET /v2/userinfo`. Amber at T-7 days, then a toast with one-click reconnect (02 §1) |
| **YouTube direct** (phase 3, optional) | `cph setup youtube`: create a GCP project → enable YouTube Data API v3 → consent screen External → **set to "In production"** (not Testing, otherwise tokens die after 7 days) → Desktop OAuth client → paste → `cph connect youtube` (click through "unverified app" once) → **automatic smoke test** (5 s private clip; the user confirms in Studio that it can be made unlisted, then deletes it) | refresh token | `channels.list?mine=true` (03 §1.3) |

### 4.3 Where secrets live

- One 256-bit master key in **Windows Credential Manager** (`service=content-powerhouse, account=master-key`) via `@napi-rs/keyring`.
- All tokens are encrypted with AES-256-GCM and stored in the `credentials` table. The design avoids the roughly 2.5 KB credential blob limit (UNVERIFIED) and makes rotating refresh tokens atomic (06 §1.4).
- The daemon's per-install API tokens (scoped `mcp` and `cli`) are also in Credential Manager.
- **Limit of this design:** Credential Manager entries are readable by any process running as the same Windows user. Envelope encryption protects against leaks into the repo, logs, backups and other users, not against Claude's own shell. That gap is covered by the user-scope `cph-guard` hook and Claude Code's Bash/PowerShell permission prompts, and is listed as residual risk in R1. Never run Claude in a permission-bypass mode while platforms are connected.
- Never in the repo, `.env`, logs, tool results or the audit log. Logs redact anything shaped like a token.
- `cph revoke-all` wipes the credentials and prints the per-platform revoke links (dev.to Extensions, Buffer API settings, Bluesky app passwords, Mastodon applications, ElevenLabs keys).

### 4.4 Health states

`connected` (green), `expiring` (amber, under 7 days), `needs_reconnect` (red), `not_configured` (grey), `manual_only` (blue).

Each state names the next action ("Reconnect LinkedIn in Buffer", "run `cph connect x`"). They are shown in the dashboard header, in `cph status`, and in the `connections://status` resource.

**Probe classes:**
- **Free probes** (dev.to `users/me`, Bluesky `getSession`, Mastodon `verify_credentials`): every 15 minutes, and right before a publish.
- **Metered probes**: once a day, and right before each publish. **Buffer is metered.** Free allows 250 requests per 24 h and 3,000 per 30 days. Probing `organizations()` + `channels()` every 15 minutes would be 192 calls/day, about 5,760 per 30 days, and publishing would start failing with 429s within about two weeks. So the org id is cached at connect time and each probe is a single `channels()` call. X direct is never probed (reads are billed). ElevenLabs is probed when the video page opens.
- **Budget guard.** Every Buffer response's remaining-quota headers (names confirmed in S2(i)) update the `api_budget` table. When less than 20% of the 24 h or 30 d budget remains, the daemon refuses every non-publish Buffer call (probes, stages, metrics) and shows an amber "Buffer API budget low" banner, so the remaining budget is kept for publishing. A test simulates 30 days of daemon uptime with nothing published and asserts at most about 300 Buffer calls.

---

## 5. SEO and distribution rules

### 5.1 Canonical rules

- The canonical is always `https://www.example-blog.dev/blog/<slug>`, with no UTM.
- dev.to: `canonical_url`. Hashnode: `originalArticleURL`. Medium: set automatically by Import (or *More settings → Advanced → originally published elsewhere*). Substack: no canonical field exists, so add an attribution line at the top.
- Social links to the post carry UTM: `?utm_source=<platform>&utm_medium=social&utm_campaign=<slug>`. **[Architect's call]** UTM goes only on links in social posts. Canonical fields and the in-body links of syndicated articles never carry it.
- Canonical is a hint and not a guarantee. dev.to and Medium have high domain authority (01 risk 2). That is why the order and delays below exist.

### 5.2 Order and delays (defaults; configurable per post)

| When | Destination | What | Why |
|---|---|---|---|
| T0 (rule in 2.3) | Site | User publishes. The tool confirms it is live (200 + title). The user requests indexing in Search Console (manual checkbox on the launch plan) | Canonical first |
| T0 → T0+1 day | LinkedIn post, X post, Bluesky, Mastodon | Native excerpts that link to the canonical | Drives traffic to the canonical, no duplicate-content issue |
| **T0 + 48 h** | dev.to (full, canonical) → Hashnode (full, canonical) → Medium (import, full) | Full article | Gives Google time to index the original first (01 §4 suggestion) |
| T0 + 3–7 days | Substack newsletter edition | Edition (below) | No canonical exists, so it goes last |
| T0 + 1–7 days (optional) | Reddit (discussion-first), LinkedIn Article | Manual | Community norms. A LinkedIn Article has no canonical, so treat it like Substack |
| Phase 2: T0 + 0–7 days | YouTube Short + LinkedIn video | Short with the canonical in the description, and in the LinkedIn post text | Distribution, not duplication |

### 5.3 Excerpt vs full text per platform

| Platform | Full or excerpt | Rule |
|---|---|---|
| dev.to, Hashnode | **Full** | Canonical set. Callouts become blockquotes, interactive components become a PNG + link, tables stay GFM, tags are sanitized (dev.to ≤4, normalized lowercase alphanumeric) |
| Medium | **Full** (required) | Medium treats link-teasers and clipped content as spam (01 §3). Default is **not paywalled** (reach over revenue; Q12) |
| Substack | **[Architect's call] Newsletter edition by default**: an "Originally published at" line, a 300–600 word summary with the 2–3 key graphs, and "read the full deep-dive". Full text is opt-in and only at T0 + 7 days or later | No canonical, so full text competes with the site (01 §4). Substack allows teasers (Q10) |
| LinkedIn post | Excerpt, but a **complete takeaway**: hook, the single most useful idea taught fully, 3–5 sharp points, CTA + link. Within the platform limit (3,000 chars widely reported, UNVERIFIED; 02 §6) | Depth everywhere. Link card is built from the publishing-notes OG fields and sent through Buffer's `linkAttachment` (02 §1), or left to LinkedIn's OG scrape if S2 cannot confirm that field |
| X | **Default (Buffer Free): one post, ≤280 chars**, carrying one complete takeaway and the link. Buffer Free allows only "1" threaded post ([buffer.com/pricing](https://buffer.com/pricing)). **Thread** (4–8 posts of ≤280 chars, link once in the last post) only when S2(f) confirms the limit is "one at a time" and publish-now threads don't count, or on Buffer Essentials, or through assist intent links (Q7) | Each post with a URL costs $0.20 on the direct API (02 §2). Posts over 280 chars need Premium (UNVERIFIED; Q6 asks whether you have it) |
| Bluesky | 2–4 posts of ≤300 graphemes, link facet + card on the last | 02 §3 |
| Mastodon | 1–3 posts of ≤ the instance limit (500 by default), plus hashtags | 02 §6 |
| Reddit | Discussion-first self-post or link per subreddit rules. The link goes last | 02 §5 |
| YouTube / LinkedIn video | 45–60 s Short. The description has the canonical URL in the first line | 03, 05 |

### 5.4 AI disclosure

- **Policy decision:** each draft has an `authorship` field.
  - `verbatim`/`reformatted` covers the user's own words, mechanically transformed. These need no disclosure.
  - `ai-assisted` means Claude wrote new prose, such as intros, hooks or the Substack edition.
- Rules applied when a draft is `ai-assisted`:
  - **dev.to:** add a disclosure line, or the `#abotwrotethis` tag where appropriate. The DEV guidelines require it (01 §1).
  - **Medium:** add one disclosure sentence in the first two paragraphs, otherwise distribution drops to "Network Only" (01 §3).
  - **Other platforms:** no requirement was found. **[Architect's call]** Don't add one.
- Video: see section 6.4.
- The tool must never let Claude rewrite the article body for Medium or dev.to. Full-text copies are `reformatted` only, so no disclosure line is needed on full-text syndication.

### 5.5 Voice and style for adaptations

The prompts follow the user's writing:
- plain, confident and technical;
- no hype, no emoji walls, and no "🧵👇" style;
- numbers taken only from the article and its "Fact labels" (documented, measured or illustrative), keeping those labels' honesty.

Lint rejects any figure in an adaptation that does not appear in the source MDX or notes. A number is matched by its normalized value.

---

## 6. Video pipeline (phase 2+)

Based on report 05 §8 and report 03.

```
content/posts/<slug>.mdx + notes  (read-only)
 ├─1 EXTRACT   Claude → brief.json  (thesis, 3–5 ideas, numbers with fact labels, which diagrams)
 ├─2 SCRIPT    Claude → script.json (hook ≤2 s; 4–6 beats; CTA "full deep-dive at example-blog.dev";
 │             ≤1,000 chars; per beat: display text, spoken text, scene component + props)
 │     ⛔ GATE A  user approves the script (dashboard)
 ├─3 VOICE     ElevenLabs PVC (Eleven v4 or Multilingual v2), /with-timestamps per beat
 │             → beat-N.mp3 + char alignment → words.json (grouped to words; mapped back to display text)
 │             cached by sha256(text+voice+model+settings), so a re-render costs $0
 ├─4 SCENES    Claude → scenes.json (durations snapped to the beat audio)
 ├─5 MUSIC     optional ElevenLabs Music bed (~$0.15), ducked to about -24 LUFS under the voice; or none
 ├─6 RENDER    Remotion, local: 1080x1920, 30 fps, H.264 CRF ~18, AAC 48 kHz, +faststart; burned-in
 │             word-highlight captions (@remotion/captions) + .srt; thumb 9:16 PNG
 ├─7 QC        automatic: ≤60 s, about -14 LUFS, captions inside the safe area (middle third), no clipped text,
 │             <100 MB, all numbers ∈ brief
 │     ⛔ GATE B  user watches the MP4 in the dashboard; approve or edit (loop back to 2/3/4)
 └─8 PUBLISH   per platform drafts (YouTube Short, LinkedIn video; later X, Bluesky, Threads)
       ⛔ GATE C  standard per-action approval (section 2.6) → Buffer route (v1) / direct (phase 3)
```

### 6.1 Components

- **Voice:** ElevenLabs **Creator** ($22/mo, $11 the first month) with a **Professional Voice Clone**:
  - needs about 30–60 minutes of clean recorded narration and a live "voice captcha";
  - it can only be your own voice;
  - Starter ($6) offers only the instant clone.
  - **Included quota, and it is ambiguous.** The main pricing page lists Creator at **121k credits/month**, says "All products draw from one shared monthly credit pool", and prices TTS at 1 credit per character for Multilingual v2 (0.5–1 for Flash/Turbo over the API) ([elevenlabs.io/pricing](https://elevenlabs.io/pricing)). The API pricing page lists Creator with **275k v4 characters** included and says "API usage is billed in US dollars, not credits" ([elevenlabs.io/pricing/api](https://elevenlabs.io/pricing/api)). Whether API characters are a separate 275k pool or come out of the 121k credits is **UNVERIFIED**, and it is resolved in U2-A **before** subscribing. The design therefore hard-codes no quota: the spend cap is sized at runtime from `GET /v1/user/subscription` (`character_count` / `character_limit`).
  - The $0.08 per 1K characters (v4, v3, Multilingual v2) and $0.04 (Flash) figures are the **pay-as-you-go API rates**. Inside a subscription, a take costs quota, not dollars, until the quota runs out. Cost estimates on cards show both "characters from your quota" and "dollars if over quota".
  - Behind a `VoiceProvider` interface (`speak(text) → {audio, words[]}`) so Cartesia ($5 Pro) or Kokoro (local, $0) can be swapped in.
  - Prices changed with v4 on 2026-09-28, so re-check before subscribing ([elevenlabs.io/pricing](https://elevenlabs.io/pricing), [API pricing](https://elevenlabs.io/pricing/api); 05 §1).
- **Spoken vs display text:** "rho" or "p ninety-nine point nine" is spoken, while "ρ" or "p99.9" is displayed in the captions. The alignment is mapped back to display tokens (05 risk 10).
- **Renderer:** **Remotion**. It is free for individuals and organisations of up to 3 people (confirmed), supports Windows x64, and has official Claude Code skills. Above 3 people a company license is needed, and Remotion 5 counts contractors ([remotion.dev/terms](https://www.remotion.dev/terms); 05 §3). The company price ($25/seat/mo in research 05) is not shown on remotion.pro or in LICENSE.md and is **UNVERIFIED**. It does not apply to a one-person setup. **[Architect's call]** Run a 1-hour bake-off against HyperFrames (Apache-2.0) on the `QueueKnee` scene before the first build, and keep Remotion unless HyperFrames is clearly easier for Claude to author.
- **Scene library** (for the first short), with charts computed in code so the numbers are right:
  - `TitleCard`;
  - `QueueKnee` (utilization sweep);
  - `LatencyUtilizationCurve` (S/(1−ρ));
  - `PercentileHistogram` (p50/p99/p99.9);
  - `CoordinatedOmissionTimeline`;
  - `FanOutTail` (1 − 0.99^N);
  - `CTA`.

  The site's React diagram components are **not imported** because the site is read-only. They are re-implemented from the data and intent in the MDX (05 §4).
- **Captions:** built from TTS timestamps at $0. Fallback is ElevenLabs Forced Alignment at $0.22 per audio hour (05 §5).
- **Visual variety:** at least 3 layout and colour templates, rotated, so each short looks different. This guards against the inauthentic-content risk (03 §1.9).
- **Music:** none, or an ElevenLabs Music bed. Do not use the YouTube Audio Library, because the same file goes to LinkedIn and its clearance there is unclear (05 §6).
- **Files:** `%LOCALAPPDATA%\content-powerhouse\video\<slug>\` (outside both repos). The video module reads the site and the DB only.

### 6.2 Publish targets and specs

- **One master file:** 1080x1920 H.264/AAC MP4, `+faststart`, ≤60 s, <100 MB, plus SRT. It satisfies YouTube Shorts (≤3 min; keep ≤60 s so a copyright claim cannot block it globally), LinkedIn (3 s–30 min, ≤500 MB, aspect 1:2.4 to 2.4:1), X, Bluesky (≤10 min / 300 MB since Aug 2026, third-party), Threads and Mastodon (02 cross-cutting §5; 03 §1.4, §2.3).
- **YouTube via Buffer (v1):** title ≤100 chars with `#Shorts`, category Science & Technology, description with the canonical in the first line. Whether Buffer exposes privacy, captions and `containsSyntheticMedia` is UNVERIFIED (phase 0 spike). Assume it does not: a Buffer `shareNow` to YouTube goes **public** immediately, so Gate C is the only control on this route. Media reaches Buffer by native upload if S2(a) finds one, otherwise by an R2 URL (section 4.2). The custom Shorts thumbnail is Studio-only, so pick a strong first frame (03 §1.6).
- **YouTube direct (phase 3 option):**
  - upload with `privacyStatus=private` (enforced in code, with a test), `selfDeclaredMadeForKids=false` and `containsSyntheticMedia=false`;
  - `captions.insert` the SRT;
  - the user previews in Studio;
  - on approval, `videos.update publishAt`. If the draft is invalidated before `publishAt`, `videos.update` sets it back to private with no `publishAt` (section 2.6 rule 5);
  - quota: 100 uploads/day in their own bucket, plus about 500 of the 10,000 shared units per fully dressed Short (03 §1.1).
- **LinkedIn video via Buffer (v1)**, or direct Videos API (`initializeUpload` → 4 MB parts → `finalizeUpload` → poll `AVAILABLE` → Posts API) with an English SRT (03 §2.2).

### 6.3 Approvals in the video flow

- Gate A (script) and Gate B (final cut) are **production** approvals. They spend money (TTS) and time, but nothing goes public.
- Gate C is the standard publish gate, per platform, per action.
- Voice generation shows an estimate ("3 beats, 980 chars from your quota; 41,200 of 121,000 left this month; $0.08 if billed at the pay-as-you-go rate"). It is refused if the run would exceed the remaining quota from `GET /v1/user/subscription`, unless the owner raises the cap.
- Gates A and B are production approvals, so they do not need Windows Hello. Gate C does.

### 6.4 AI disclosure for video

- **YouTube:** the Help Center lists "Cloning one's own voice to create voice overs or dubs" and non-realistic animation as **not** needing disclosure ([Help 14328491](https://support.google.com/youtube/answer/14328491); 03 §1.8). Default `containsSyntheticMedia=false`, with a per-video toggle that must be set to `true` if a video uses realistic AI footage or anyone else's voice.
- **[Architect's call]** Add a short honest description line by default ("Narrated by me, using an AI clone of my own voice"). It is good for trust in a personal brand, does not trigger YouTube's label, and the user can switch it off (Q15).
- **LinkedIn:** no specific rule was found (UNVERIFIED). Use the same description line.
- **Inauthentic-content policy:**
  - every short derives from an original article;
  - every script and cut is human-approved;
  - the visuals are varied;
  - the cadence is moderate (≤3 shorts per week to start).

  Partner Program thresholds for reference: 1,000 subscribers plus 4,000 watch hours in 12 months or 10M Shorts views in 90 days (03 §1.9). Monetization is not a goal.

---

## 7. Platform API constraints (reference)

| Platform | Key constraints | Source |
|---|---|---|
| **dev.to** | Auth is the `api-key` header (not Bearer) + `accept: application/vnd.forem.api-v1+json`. `published` defaults to false. ≤4 tags, silently normalized. `canonical_url`, `series`, `main_image` (absolute URL). There is no image-upload endpoint in the docs read. Rate limits are undocumented (about 10 creates per 30 s, third-party); a 429's `Retry-After` can be seconds **or** an HTTP-date. AI-assisted text must be disclosed | [Forem API v1](https://developers.forem.com/api/v1); [DEV AI guidelines](https://dev.to/guidelines-for-ai-assisted-articles-on-dev); 01 §1 |
| **Hashnode** | GraphQL, MCP (`https://mcp.hashnode.com/mcp`) and CLI all need **Pro at $5/mo or $50/yr per publication** (since about May–June 2026). Canonical input is `originalArticleURL`. Tags ≤5 (third-party). 500 mutations/min (third-party). GraphQL returns 200 with an `errors[]` array. The MCP direct-post tool goes live immediately, so use only the draft tools. Whether the MCP can set `originalArticleURL` is UNVERIFIED | [hashnode.com/pro](https://hashnode.com/pro); [MCP post](https://hashnode.com/blog/hashnode-mcp-server); [CLI post](https://hashnode.com/blog/hashnode-cli); 01 §2 |
| **Medium** | No new integration tokens or integrations. Import a story sets the canonical and backdates. The Rules ban automated or programmatic posting, scripts and browser add-ons, and treat teaser posts as spam. Undisclosed AI text gets "Network Only" distribution. The Partner Program needs a $5/mo membership | [Help: API/Importing](https://help.medium.com/hc/en-us/articles/213480228-API-Importing); [Importing](https://help.medium.com/hc/en-us/articles/214550207); [Medium Rules](https://policy.medium.com/medium-rules-30e5502c4eb4); [AI policy](https://help.medium.com/hc/en-us/articles/22576852947223); 01 §3 |
| **Substack** | No posting API. The Developer API covers public profile data only. The official MCP is read-only and Bestseller-only (third-party). There is no canonical field. The importer publishes immediately. The Terms (2026-10-06) bar scraping, automation while logged out and reverse engineering | [substack.com/api-tos](https://substack.com/api-tos); [substack.com/tos](https://substack.com/tos); [importer help](https://support.substack.com/hc/en-us/articles/360037830351); 01 §4 |
| **LinkedIn** (direct) | `POST /rest/posts` with `LinkedIn-Version` (202511 sunsets 2026-11-16; pin 202610) and `X-Restli-Protocol-Version: 2.0.0`. `w_member_social` is self-serve. The app must be linked to a Page. Tokens last 60 days with **no refresh** for non-partners. 150 requests per member per day. Article link shares need you to supply the title, description and thumbnail (no scraping). Video: 3 s–30 min, ≤500 MB, MP4, one English SRT. Documents: ≤100 MB / 300 pages. **No API for native Articles or Newsletters** | [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api); [Videos API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api); [Share on LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin); [refresh tokens](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens); 02 §1, 03 §2 |
| **X** (direct) | Pay-per-use: **$0.015 per post, $0.20 per post containing a URL**. Media upload is not listed as a charge (UNVERIFIED). Reads cost $0.005. The free tier closed to new developers in Feb 2026 (third-party). **Credits are prepaid** ("Purchase credits upfront in the Developer Console"). The $20 bonus is earned only "when you save your first eligible payment card and complete your first credit purchase", so the real first outlay is a top-up, not the monthly usage; the minimum purchase amount is not stated (UNVERIFIED). 100 creates per 15 min per user. v2 chunked media upload (init/append/finalize/status). OAuth2 PKCE tokens last 2 h, with refresh via `offline.access`. Spending cap is available | [X pricing](https://docs.x.com/x-api/getting-started/pricing); [rate limits](https://docs.x.com/x-api/fundamentals/rate-limits); [media upload](https://docs.x.com/x-api/media/quickstart/media-upload-chunked); 02 §2 |
| **YouTube** (direct) | `videos.insert` costs 1 unit from its own 100/day bucket. Everything else shares 10,000 units/day (thumbnail 50, caption 400, update 50). **The default privacy is now `public`, so always send `private`.** Unverified-project private lock: the docs (2026-10-15) say it no longer applies, but this is UNVERIFIED in practice, so run a smoke test. `publishAt` works only on a private, never-published video. Testing-mode refresh tokens expire after 7 days. Custom Shorts thumbnails are Studio-only | [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert); [quota](https://developers.google.com/youtube/v3/determine_quota_cost); [revision history](https://developers.google.com/youtube/v3/revision_history); [Help 72431](https://support.google.com/youtube/answer/72431); 03 §1 |
| **Buffer** | Free: 3 channels, 10 scheduled posts per channel, **"Threaded posts: 1"**, 1 API key, API 100 per 15 min / 250 per 24 h / 3,000 per 30 days. Essentials: $5 **per connected channel**/mo, 3 keys, 7,500 per 30 days. MCP, API and a Claude integration on every plan. `create_post` supports `saveToDraft` and `mode` (`addToQueue` is the default and uses the next queue slot, `shareNext`, `shareNow`, `customScheduled`+`dueAt`). YouTube needs a video plus `metadata.youtube` title and category. LinkedIn assets can be an image, video or document; `metadata.linkedin.linkAttachment` gives a link card and cannot be combined with non-empty `assets`. Threads go in `metadata.<service>.thread`, with the top-level `text` repeating the first item. `delete_post` takes a `postId` and requires `deletePost` in the post's `allowedActions`. Whether X costs are passed through is UNVERIFIED | [buffer.com/pricing](https://buffer.com/pricing); [Buffer MCP guide](https://developers.buffer.com/guides/integrations/mcp.html); 04 §1 |
| **Bluesky** | App password. 5,000 points/h and 35,000/day (a create costs 3). `createSession` 30 per 5 min and 300/day. 300 graphemes per post. Links need facets. Video ≤10 min / 300 MB (third-party, Aug 2026); a verified email is required. Read `getUploadLimits` at runtime | [rate limits](https://docs.bsky.app/docs/advanced-guides/rate-limits); 02 §3 |
| **Mastodon** | Personal token. 300 requests per 5 min. 30 media uploads per 30 min. Limits vary by instance (`/api/v2/instance`). `Idempotency-Key`. Async video processing | [statuses](https://docs.joinmastodon.org/methods/statuses/); [media](https://docs.joinmastodon.org/methods/media/); [rate limits](https://docs.joinmastodon.org/api/rate-limits/); 02 §6 |
| **Threads** | Container then `threads_publish`. 250 posts per 24 h. 500 chars. Video ≤5 min / 1 GB **at a public URL**. 60-day tokens, refreshable. Tester mode avoids App Review (third-party). HTTPS redirect (UNVERIFIED) | [Threads posts](https://developers.facebook.com/docs/threads/posts); [tokens](https://developers.facebook.com/docs/threads/get-started/long-lived-tokens); 02 §4 |
| **Reddit** | New OAuth tokens need approval since 2025-11-11. Personal scripts are reportedly rejected. Subreddit self-promotion rules apply | 02 §5 (third-party mirrors) |
| **TikTok / IG** | TikTok unaudited: SELF_ONLY, 5 users per 24 h. IG: professional account, Meta app, public URL, 100 (or 50) posts per 24 h | [TikTok guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines); [IG publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing); 03 §3–4 |
| **ElevenLabs** | `/with-timestamps` returns timing per **character**. v4 allows 10k chars per request. PVC needs Creator or above and a voice captcha. Free plan: no commercial use. Output from Beta features is not commercial. Creator: 121k credits/mo on the main pricing page vs 275k v4 API characters on the API pricing page; whether these are one pool is UNVERIFIED (section 6.1). Remaining quota: `GET /v1/user/subscription` | [TTS with timestamps](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps); [voice cloning](https://elevenlabs.io/docs/eleven-api/concepts/voice-cloning.mdx); [pricing](https://elevenlabs.io/pricing); [API pricing](https://elevenlabs.io/pricing/api); 05 §1 |
| **Claude / MCP** | Spec 2026-07-28 (stateless, multi-round-trip elicitation). Claude Code elicitation since v2.1.76. Claude Desktop is UNVERIFIED. A remote connector must be reachable from Anthropic's cloud (Free plan: 1 custom connector) | [MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog); [elicitation](https://modelcontextprotocol.io/specification/latest/client/elicitation); 06 §2 |

---

## 8. Pricing: monthly cost model

**Workload assumed:**
- Base case: **4–8 articles/month**, plus **8 shorts/month** from phase 2.
- Sensitivity case: 13 articles and 43 shorts/month (the 04 workload).

All prices were checked by the research on 2026-10-19, and Buffer, ElevenLabs and X were re-checked on their pricing pages during revision 2 on the same day. Re-check before paying for anything: X, ElevenLabs and Hashnode all changed prices in 2026. Claude itself is excluded, because the user already has a subscription.

### 8.1 Three options

| Item | **Minimal** | **Recommended** (default path) | **Max (all-automated comfort)** | Source |
|---|---|---|---|---|
| dev.to, Bluesky, Mastodon (direct) | $0 | $0 | $0 | 01, 02 |
| Buffer (LinkedIn, YouTube, X) | Free, $0 (3 channels) | Free, $0. X gets a single post, not a thread | Essentials, 5 channels (LinkedIn, YouTube, X, Threads, TikTok): **$25** | [buffer.com/pricing](https://buffer.com/pricing) |
| X direct API (fallback only) | $0 (not used) | $0 (not used; X goes through Buffer Free as a single post) | **Prepaid credit purchase first** (minimum amount UNVERIFIED; the $20 bonus needs a saved card *and* a first purchase), then ~$2–4/mo usage under a $5 cap | [X pricing](https://docs.x.com/x-api/getting-started/pricing) |
| Hashnode | Free (assist) | Free (assist) | Pro **$4.17** ($50/yr) | [hashnode.com/pro](https://hashnode.com/pro) |
| Medium | $0 (import) | $0 | Membership **$5** (Partner Program) | 01 §3 (third-party price) |
| Substack | $0 | $0 | $0 (10% + Stripe only if charging) | 01 §4 |
| Asset host (Cloudflare R2) | $0, not used in Phases 0–1 | $0 within the free tier from Phase 2, **with a payment method on file** (third-party reports; UNVERIFIED officially). Not needed at all if Buffer has a native upload (S2) | $0, payment method on file | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Hosting/scheduler | $0 (home PC) | $0 (home PC) | Fly.io **$2.34** | [Fly pricing](https://docs.fly.io/about/pricing) |
| **Text subtotal** | **$0** | **$0** | **~$41.51** | |
| Voice (phase 2) | ElevenLabs Starter **$6** (instant clone) | ElevenLabs Creator **$22** ($11 first month; about $18.33/mo billed annually per research 05, UNVERIFIED), PVC. Included quota: 121k credits, or 275k API characters if that is a separate pool (UNVERIFIED, section 6.1) | Creator **$22** | [elevenlabs.io/pricing](https://elevenlabs.io/pricing), [API pricing](https://elevenlabs.io/pricing/api) |
| Music | none | ElevenLabs Music about $0.15 × 8 = **$1.20** | Epidemic Sound Creator **~$17.99** (UNVERIFIED) | 05 §6 |
| Thumbnails/AI images | none | optional ~$0.40 (8 × $0.05) | ~$0.40 | 05 §4 |
| Remotion render | $0 (individual license, local) | $0 | $0 (the company price, ~$25/seat in research 05, is UNVERIFIED and does not apply to one person) | [remotion.dev/terms](https://www.remotion.dev/terms) |
| **Video subtotal** | **$6** | **~$23.60** | **~$40.39** | |
| **Total before video** | **$0** | **$0** | **~$42** | |
| **Total with video** | **$6** | **~$24** | **~$82** (≈$87 with Instagram added to Buffer, 6 channels at $30) | |

**Upgrade triggers** (things that move you off the $0 / ~$24 path):

| Trigger | What it costs | Notes |
|---|---|---|
| You want **X threads** and S2(f) shows Buffer Free's "1 threaded post" blocks them (Q7) | Buffer Essentials, billed **per connected channel**: **$10/mo** for LinkedIn + X, **$15/mo** once YouTube is connected | Essentials applies to the account's channels, so it is not "$5 for X alone" (Architect's reading of "$5/channel/mo"; confirm on the billing page before buying). Free alternative: assist intent links, one click per post |
| More than 10 scheduled posts queued per channel | Same Essentials price | Publish-now does not count against this |
| A 4th channel (Threads, TikTok, Instagram) | $20–30/mo for 4–6 channels on Essentials | Phase 3 |
| Hashnode automated drafts (Q11) | $50/yr | Optional |
| X direct (only if Buffer stops covering X) | Prepaid top-up, then ~$2–4/mo, $5 cap | Optional |
| ElevenLabs quota exceeded (section 8.2) | Overage at an UNVERIFIED rate, or Pro **$99** | Sized at runtime from `/v1/user/subscription` |

**One-time costs:** none required. Optional: a decent USB mic for the voice-clone recording, if the user doesn't own one. Hashnode Pro is billed annually at $50. Cloudflare R2 and X direct need a card on file even when nothing is charged (X also needs a first credit purchase).

### 8.2 Sensitivity (13 articles + 43 shorts/month)

- **X:** on the default Buffer route, $0. On X direct: 13 single posts × $0.20 + 43 shorts × $0.015 ≈ $2.60 + $0.65 = **~$3.25/month** (about $4 with threads), after a prepaid top-up.
- **ElevenLabs:** 43 shorts × ~3k chars (with retakes) ≈ 129k chars.
  - If API characters are a **separate 275k pool**, Creator covers it and **$22 holds**.
  - If they come out of the **121k shared credits** at 1 credit per character, the month runs about 8k characters over. That is about **$0.65 extra** if overage is billed at the $0.08/1K pay-as-you-go rate (UNVERIFIED), or it forces **Pro at $99** if Creator blocks instead of billing overage. Using Flash (0.5–1 credit per character) for draft takes cuts this.
  - The base case (8 shorts ≈ 24k chars) fits either way.
  - Music ≈ $6.45.
- **Buffer:** the 10-scheduled-posts-per-channel limit becomes binding if shorts are queued days ahead. Essentials for LinkedIn, X and YouTube would cost **+$15/month**. The API budget is not binding: about 112 publishes + 30 daily probes + 112 pre-publish probes ≈ 260 calls per 30 days, against 3,000.
- **Recommended total at this volume: about $28–45/month** ($22 Creator + ~$6.45 music, plus up to $15 Buffer Essentials and a few dollars of overage).

### 8.3 Price-change guardrails built in

- A spend cap per metered provider is held in the `spend` table: X at $5/cycle; ElevenLabs sized at runtime from `GET /v1/user/subscription`; a warning at 80%.
- The Buffer API budget is tracked in `api_budget` from response headers, and non-publish calls stop below 20% remaining (section 4.4).
- Each approval card shows the per-action cost and the quota left.
- `cph doctor --prices` prints the pricing pages to re-check, with the date each was last verified.

---

## 9. Risks, decisions and open questions

### 9.1 Risks and mitigations

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | Something publishes without approval: a bug, the model, a prompt injection, or the YouTube public default | Low / **severe** | Server-side hash-bound gate. **Windows Hello on every Approve and on enabling publishing** (the only channel a model cannot satisfy). `publishing_enabled` defaults to false. Private-field unit tests. No Buffer MCP and Buffer's Claude integration left off. Audit log. User-scope `permissions.ask` and `cph-guard` hook. **Residual risks, not closable by this design:** (1) any same-user process, including Claude's own Bash or PowerShell, can read the master key and the Buffer or dev.to key from Credential Manager and post directly, bypassing the daemon. Only Claude Code's per-command permission prompts and the bypassable `cph-guard` hook stand in the way, so never run Claude in a permission-bypass mode while platforms are connected. (2) If the owner ever types his Windows Hello PIN where a model can see it, Hello is no longer model-proof; prefer face or fingerprint. (3) If the Hello spike fails and the elicitation fallback is used, a computer-use click on the Claude Code window could answer it. (4) Buffer's YouTube route has no private mode, so a wrongly approved short goes public at once |
| R2 | Buffer API gaps: media by URL, LinkedIn link card, LinkedIn video, YouTube Shorts metadata, X cost pass-through, thread limit, Free-plan caps | Medium / medium | Phase 0 spike S2 before committing. The Route interface lets each platform fall back to assist or direct independently. The route contract test forbids silently dropping a field |
| R3 | Buffer holds the OAuth for 3 accounts, and its API key gives full account access | Low / high | Key only in the secret store, never given to Claude, rotate on suspicion, `revoke-all` |
| R4 | X pricing churn (3 changes in 2026), or Buffer stops covering X | Medium / low | Assist (intent) mode is the floor, with a $5 cap and auto-recharge off on direct |
| R5 | Syndicated copies outrank the site | Medium / medium | Canonical fields, a 48 h delay from the correct T0, Search Console indexing step, Substack as an edition only |
| R6 | ToS action on Medium, Substack or Reddit | Low (by design) / high | No automation on those platforms, by design. Assist and import only |
| R7 | Import fidelity: tables, SVG and interactive content lost on Medium, Substack and dev.to | High / low | PNG fix-up kits, text links to interactive diagrams, and the `placeholder-image` lint. A dry-run import of an existing post as a Medium draft, **only with the user's go-ahead** |
| R8 | Summary-only RSS blocks every RSS importer | Certain / low | Not used. Read the MDX directly. Proposal P1 |
| R9 | MCP SDK v2 or elicitation incompatibility with Claude Desktop | Medium / low | Start on v1 SDK. The gate does not depend on elicitation unless the Hello spike fails |
| R10 | The home PC is off at a scheduled time | Medium / low | Prefer platform-side scheduling (Buffer `dueAt`, YouTube `publishAt`). Held-if-late policy. Fly.io later |
| R11 | Voice-clone key leak (anyone can make "you" say anything) | Low / high | Key encrypted at rest, quota-limited key if available, rotation, never in logs |
| R12 | YouTube "inauthentic content" flag | Low / medium | Human gates A and B, varied templates, original analysis, moderate cadence |
| R13 | Vendor churn (PlayHT died, Sora ended, Hashnode paywalled its API) | Medium / medium | Provider interfaces for voice, route and asset host. No single-vendor lock-in for content logic |
| R14 | Windows path with spaces breaks CLIs | Medium / low | `execFile` with argument arrays, `cph doctor`, a CI smoke test on a spaced path |
| R15 | Remotion licence if a 4+ person team forms (Remotion 5 counts contractors) | Low / low | HyperFrames (Apache-2.0) as an escape hatch |
| R16 | Accidental write to the site repo, including `.git/index` rewrites by `git status` | Low / high | Guarded `SiteReader`, git read-only allowlist with `--no-optional-locks`, `.git/index` mtime/sha256 test |
| R17 | Numbers mangled in adaptations (credibility with engineers) | Medium / high | Numeric-provenance lint against the MDX and fact labels. The "Verify before publishing" checklist blocks approval |
| R18 | **Buffer Free API budget exhausted** (250/24 h, 3,000/30 d), so publishing fails with 429s | Medium / medium | Buffer is a metered probe (daily + before publish, one call each), `api_budget` from response headers, non-publish calls refused below 20%, and a 30-day simulation test |
| R19 | **A platform-scheduled post fires after its source changed** (Buffer `customScheduled`, YouTube `publishAt`) | Medium / medium | Remote scheduled id stored; edit, cancel or `source_changed` triggers `cancelScheduled` and a red re-approve card. Gap: a post due while the PC is off still fires |
| R20 | **A private stage goes live** (Buffer `addToQueue` without a working `saveToDraft`; a dev.to re-stage on a live article) | Low / high | Assert `post.status === 'draft'` and delete otherwise; source rule tying `addToQueue` to `saveToDraft`; dev.to stage reads the article back and refuses if it is live |
| R21 | **The approval card differs from what is sent** (for example LinkedIn's link card) | Medium / medium | Route contract: every hashed field reaches the wire, tested per route. Otherwise the field is removed and the card says what the platform will generate |

### 9.2 Architect's calls (decided here; the user can override)

1. Daemon + stdio MCP facade + CLI + htmx dashboard. TypeScript on Node 24. SQLite via better-sqlite3. Envelope-encrypted secrets via `@napi-rs/keyring`.
2. MCP SDK v1 1.32.1 first; v2 only after a compatibility spike.
3. **Routes:**
   - Buffer Free for LinkedIn, YouTube and X;
   - direct for dev.to, Bluesky and Mastodon;
   - assist for Medium (import), Substack, Hashnode-free, Reddit and LinkedIn Articles;
   - Threads, TikTok and IG deferred.
4. **X defaults to a single post** on Buffer Free. Threads only after S2(f) or an upgrade (Q7).
5. Buffer's MCP is **not** connected to Claude, and Buffer's own Claude integration stays off. Claude reaches Buffer only through cph routes behind the gate.
6. **Windows Hello is mandatory on every Approve and on enabling publishing, from Phase 0.** MCP elicitation in Claude Code is the fallback only if the Hello spike fails. The out-of-band code channel is dropped.
7. No "approve all". One approval per action. Approvals are bound to a hash, single-use and short-lived.
8. **Approve & publish** in the dashboard is the default path: the Hello-verified click is the approval and the daemon publishes at once. MCP `publish` stays for Claude-started flows, with a defined polling contract.
9. `publishing_enabled` (shown as Publishing: DISABLED/ENABLED) replaces the term "kill switch".
10. Private remote staging (dev.to draft, Buffer draft, YouTube private) is allowed without approval, with read-back checks that the stage is still private. Going public always needs approval.
11. Platform-side scheduled posts are checked at hand-over and cancelled on invalidation.
12. Buffer health is a metered probe (daily + before publish), with an API budget table.
13. Syndication delay of 48 h for full-text copies from **T0 = min(frontmatter date, canonical_live_at)**, with a late-deploy exception. Substack defaults to a newsletter edition at T0 + 3 days or later. UTM on social links only.
14. Full-text copies are `reformatted` only; Claude never rewrites the article body. Disclosure lines are added automatically for `ai-assisted` drafts on dev.to and Medium.
15. Held-if-late after 2 h for direct-route jobs. A crash after consume leaves the draft `unknown`, resolved by a startup sweep or a manual check, never retried automatically.
16. Playwright for table and diagram snapshots of the user's own site. resvg for SVG→PNG. **No asset host until Phase 2**; then R2 (or Buffer's native upload if S2 finds one), with presign TTL `max(24 h, dueAt − now + 24 h)` capped at 7 days.
17. **Install registers Claude Code at user scope and Claude Desktop through its JSON config in Phase 0**, links `cph` globally, and writes user-scope Claude settings (each step asked first). `open_dashboard` makes connecting one click in chat.
18. Video: ElevenLabs Creator PVC, Remotion local, captions from TTS, no stock music by default. A default honest "AI clone of my own voice" description line. `containsSyntheticMedia=false`. No hard-coded TTS quota.
19. Phase 0 is built against the existing `prometheus-cardinality-explained` post (drafts only). The first real launch is the first launch article once it is live.
20. Site git commands run with `--no-optional-locks`; the live check decodes HTML entities before matching the title.

### 9.3 Open questions for the owner

Most important first. Each default applies until you decide (**default until decided**).

| # | Question | Default until decided |
|---|---|---|
| Q1 | **What counts as your "explicit confirmation per action"?** Is a dashboard click (with Windows Hello) enough, or must the confirmation come from you in chat? Can one launch-plan approval that lists every action explicitly cover all of them, or does each platform action need its own click? | A Hello-verified **Approve & publish** click per action, no chat "yes" needed, and no launch-plan bulk approval |
| Q2 | **Do you agree to a Windows Hello check (PIN, face or fingerprint) on every Approve from Phase 0?** Claude in your setup can drive the browser (claude-in-chrome) and the desktop (computer-use) and could otherwise click Approve itself. The alternative is disabling those tools whenever content-powerhouse is in use | Hello required on every Approve and on enabling publishing |
| Q3 | Are you OK with **Buffer** (Free) holding your LinkedIn, YouTube and X connections? The alternative is registering your own developer apps (more setup, a LinkedIn re-auth every 60 days) | Buffer |
| Q4 | **Phase 0 live test:** should one real LinkedIn post of the existing `prometheus-cardinality-explained` article go out publicly, or should Phase 0 stay dry-run only until the first launch article is live? When do you expect that post to be live? | Dry-run only. The first real publish is the first launch article |
| Q5 | Do you mainly want to drive this from **Claude Desktop, Claude Code, or both** from day one? | Both, registered by `cph install` in Phase 0 |
| Q6 | **Which accounts exist today?** Bluesky; Mastodon (which instance, for example hachyderm.io); X (and do you have **Premium**, so posts can exceed 280 chars); a **phone-verified** YouTube channel; Substack publication; Hashnode; Medium (and any **pre-2025 Medium integration token**); Threads | Phase 1 connects whichever exist. Assume no X Premium and no Medium token |
| Q7 | **X format.** Buffer Free allows only one threaded post. Single post with the link, or pay for Buffer Essentials to get threads ($10/mo for LinkedIn + X, $15 with YouTube, since Essentials is billed per connected channel), threads through manual intent links ($0, one click per post), or X direct pay-per-use (prepaid credits, ~$3/mo, $5 cap)? | Single post with the link via Buffer Free |
| Q8 | Are you willing to add a **payment method to Cloudflare** for R2 (no charge within the free tier)? It is needed in Phase 2 to give Buffer public video URLs, unless Buffer turns out to accept direct uploads | Ask again at Phase 2 start, after S2 says whether Buffer has a native upload |
| Q9 | **Video:** is ElevenLabs Creator at $22/mo OK given its included quota (121k credits per month, which may cap you at about 40 shorts including retakes if API usage shares that pool)? Is setting aside an afternoon to record 30–60 minutes of narration for the professional clone acceptable? | Yes, at Phase 2 start, after the pooling question is answered |
| Q10 | Substack: newsletter **edition** (summary + key graphs + link) or **full text**? | Edition |
| Q11 | Buy **Hashnode Pro** ($50/yr) for automated drafts, or use copy-assist? | Copy-assist |
| Q12 | Medium: join the Partner Program ($5/mo) and paywall some posts, or keep everything free for reach? | Free, no paywall |
| Q13 | Is the home PC usually on during posting hours, and is a background daemon at logon acceptable? | Yes. Held-if-late covers gaps |
| Q14 | Disclosure stance for Claude-written adaptations (hooks, editions) on platforms with no rule (LinkedIn, X, Bluesky)? | No disclosure where none is required |
| Q15 | Keep the "AI clone of my own voice" line in video descriptions? | Keep |
| Q16 | Target subreddits and cadence for Reddit, or skip Reddit? | Skip until listed |
| Q17 | Posting cadence goals (articles per month, shorts per week)? | 4–8 articles, 8 shorts |
| Q18 | Accept **site-repo proposals** (you would make these changes yourself): **P1** a full-content RSS feed (`content:encoded`); **P2** PNG twins for body diagrams (extend `covers-to-png.js`), which would also let dev.to show diagram images before Phase 2; **P3** a future "write once in cph → open a PR to the site repo" entry point | None; the tool works without them |

---

## 10. Phased roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **0: Connect + first slice** (about 1–2 weeks) | **Windows Hello spike first (1 h)**, then the presence check on Approve and on enabling publishing (or the elicitation fallback). Scaffold the monorepo; daemon, SQLite, keyring envelope; `cph` (`status`, `connect`, `sync`, `doctor`, `dashboard`, `install`); `cph install` with user-scope Claude Code registration, Claude Desktop config, global `cph`, user-scope settings + `cph-guard` hook; dashboard (Connections, Content, Drafts, **Approvals** with Approve & publish, Settings with Publishing: DISABLED/ENABLED); stdio MCP with the core tools incl. `open_dashboard`; read-only `SiteReader` (`--no-optional-locks`) + publishing-notes parser + canonical-live gate + T0 rule; `PortableDoc` lowering + dev.to markdown transform (text links for interactive diagrams, `placeholder-image` lint); **dev.to direct route** (stage `published:false` with canonical, refuses to touch a live article; publish via approval); **LinkedIn post via Buffer route** (metered health, API budget, `linkAttachment` or no link card, draft-status assertion on stage; publish `shareNow` after a Hello-verified approval); assist fallback for LinkedIn; audit log; `unknown` state + startup sweep. **Spikes:** Hello; MCP SDK v2 compatibility; Buffer schema (S2 a–i); dev.to SVG rendering | `cph status` all green for dev.to and Buffer. Claude Code (from any directory) and Claude Desktop both list the tools. For an existing post: a dev.to **draft** exists with the correct canonical (not published). A LinkedIn post is drafted and its approval card matches what would be sent. With **Publishing: DISABLED**, or with an edited payload, or without a Hello verification, publish is refused, and tests prove it. A live LinkedIn post happens only if the owner explicitly OKs it for that post (Q4). The audit log shows every step |
| **1: Text everywhere** | X **single post** via Buffer (threads only per Q7), Bluesky and Mastodon direct, `plan_launch` with SEO `notBefore` from T0 + basic scheduler, held-if-late, remote-schedule cancellation on invalidation, asset pipeline without a public host (resvg, Playwright table and diagram PNGs as local files for kits; native media upload on Bluesky and Mastodon), **assist kits**: Medium fix-up kit, Substack clipboard HTML edition, Hashnode markdown + checklist, Reddit submit link, LinkedIn Article, X intent links; hand-off and record-publication; Hashnode Pro direct route (if Q11 = yes); numeric-provenance lint; spend caps | The first launch article (once live) goes out across all text destinations from one launch plan, with each public action individually approved. Editing a draft that Buffer holds as scheduled cancels the Buffer post |
| **2: Video** | Resolve the ElevenLabs pooling question (U2-A); `packages/video` (Remotion), ElevenLabs `VoiceProvider` (cached, quota-sized cap from `/v1/user/subscription`), spoken/display text, scene library for the first short, captions + SRT, QC, gates A and B in the dashboard, video MCP tools; **asset host** (Buffer native upload if S2 found one, else R2 with the TTL rule; S2(j) asset-fetch-time test); publish to **YouTube Shorts + LinkedIn video via Buffer**. Spike: YouTube direct smoke test (private upload, then confirm whether the lock applies) | One 45–60 s short of the first launch article approved at gates A, B and C and live on YouTube Shorts and LinkedIn. Under 30 minutes of user time |
| **3: Expand + graduate** | Optional direct routes where Buffer falls short: YouTube direct (private, `publishAt` with cancel-to-private on invalidation, caption track, `containsSyntheticMedia`), LinkedIn direct (PDF document posts, SRT); Threads (Buffer Essentials or direct); TikTok and IG via Buffer; elicitation approval channel as a second option (if not already the Phase 0 fallback); optional `.mcpb` Desktop bundle; video to X, Bluesky and Threads | Each new route passes the same gate and route-contract tests. The connect flow stays under 2 minutes once any developer app exists |
| **4: Scheduling + analytics** | Calendar view and recurring cadences; metrics ingestion (Buffer `get_aggregated_post_metrics` within the API budget, dev.to `/api/articles/me`, YouTube Analytics if direct, Bluesky and Mastodon public counts) into `metrics`; weekly "what worked" report via MCP prompt; optional Search Console URL-inspection check for the canonical-indexed gate; remote MCP (Cloudflare Tunnel + OAuth) for phone use; optional Fly.io host; long-form 16:9 video | A weekly report shows reach per platform per post. Claude can be driven from the phone (if wanted), with approvals still Hello-verified on the PC |

**Test strategy (all phases):**
- Unit tests on transforms (snapshot per fixture post).
- Gate tests:
  - no approval → refuse;
  - edited payload → refuse;
  - reused approval → refuse;
  - publishing disabled → refuse;
  - no Hello verification → refuse;
  - YouTube/dev.to private-field assertions.
- Route contract tests: every hashed payload field reaches the wire, against recorded HTTP fixtures.
- Buffer budget test: 30 simulated days of uptime with nothing published make at most about 300 Buffer calls.
- A `dry_run` end-to-end on every PR.
- No live posting in CI, ever.

---

## Appendix A: first-slice walkthrough (phase 0, what "done" looks like)

1. `cph doctor` → `cph install`. Install asks before each step: master key, Task Scheduler entry, global `cph`, `claude mcp add --scope user content-powerhouse …`, the Claude Desktop config entry, and the user-scope `~/.claude/settings.json` hook. Restart Claude Desktop.
2. In Claude (any directory): "connect dev.to". Claude calls `connect_platform`, and the signed-in dev.to card opens in the browser. Paste the key. Repeat for Buffer (paste the key, map the LinkedIn channel). `cph status`: dev.to OK, LinkedIn (Buffer) OK, Medium/Substack manual.
3. In Claude Code: "Prepare prometheus-cardinality-explained for dev.to and LinkedIn."
   - Claude calls `get_content`. It is live (200), and the notes are parsed, with 2 "verify" items. T0 is the post's frontmatter date, months ago, so dev.to's `notBefore` has already passed.
   - Claude calls `create_draft(devto)`. The skeleton has the title, 4 sanitized tags (the first 4 frontmatter tags unless a preference list is set), `canonical_url`, the cover PNG, and the series if any. Interactive diagrams become text links. Lint is clean.
   - Claude calls `stage_remote_draft`, which creates a private dev.to draft, and returns the dev.to preview URL.
   - Claude uses `adapt-linkedin` to write the post, then `create_draft(linkedin)`. Lint checks the length, one canonical link with UTM, numbers present in the source, and one complete takeaway.
4. Claude calls `request_approval` for the LinkedIn draft. The tool replies "Pending: approve at http://127.0.0.1:4646/approvals/<id>, then poll `get_approval_status` every 15 s for up to 10 minutes."
5. The owner opens the dashboard, ticks the 2 "Verify before publishing" items, and reads the card (payload, the link card exactly as Buffer will send it, cost $0, Buffer API budget left, notBefore).
6. **Phase 0 default (Q4): stop here.** The draft stays approved-but-unsent, or the owner clicks Deny.
   **Only with an explicit OK in chat for this post:** The owner sets Publishing to ENABLED (Windows Hello), then clicks **Approve & publish** on the LinkedIn card (Windows Hello again). The daemon runs `authorize()` (hash, publishing enabled, health, live check), calls Buffer `shareNow` with the text and link attachment, and records the post in `publications` and the audit log. Claude's next `get_approval_status` poll returns `published` with the URL, and Claude reports it. The owner sets Publishing back to DISABLED.
7. The dev.to draft stays unpublished until a separate approval on or after its `notBefore`. On a real launch the user may simply delete the test draft on dev.to.

## Appendix B: sources

- Research reports:
  - `docs/research/01-longform-platforms.md`
  - `docs/research/02-social-platforms.md`
  - `docs/research/03-youtube-video-publishing.md`
  - `docs/research/04-schedulers-and-mcp.md`
  - `docs/research/05-video-pipeline.md`
  - `docs/research/06-connect-ux-and-architecture.md`
- Checked during the first design pass (2026-10-19):
  - [Buffer MCP/API guide](https://developers.buffer.com/guides/integrations/mcp.html): `saveToDraft`; `mode` (`shareNow`, `customScheduled`+`dueAt`); YouTube `metadata.youtube`; LinkedIn image, video and document assets; `metadata.twitter.thread`; asset `url` semantics.
  - [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/): 10 GB-month free, 1M Class A, 10M Class B, free egress (the operation allowances were confirmed on the official page by the plan's verification pass).
  - Site repo (read-only): 15 posts, 4 publishing-notes files, and the notes field labels listed in §2.3. No first launch article yet.
- Re-checked during revision 2 (2026-10-19):
  - [buffer.com/pricing](https://buffer.com/pricing): Free API limits 100/15 min, 250/24 h, 3,000/30 d; 1 API key; "Threaded posts: 1"; Essentials $5/channel/mo ($60/yr per channel), 7,500 requests/30 d; a Claude integration ("Manage your Buffer queue and draft posts from Claude") on all plans.
  - [Buffer MCP/API guide](https://developers.buffer.com/guides/integrations/mcp.html): `linkAttachment` under `metadata.<service>` cannot be sent with non-empty `assets`; `delete_post` takes a `postId` and needs `deletePost` in `allowedActions`; `addToQueue` is the default mode; threads repeat the first item in top-level `text`.
  - [elevenlabs.io/pricing](https://elevenlabs.io/pricing): Starter $6 / 30k credits, Creator 121k credits ($11 first month), Pro $99 / 600k; "one shared monthly credit pool"; TTS 1 credit per character (Multilingual v2).
  - [elevenlabs.io/pricing/api](https://elevenlabs.io/pricing/api): Creator 275k v4 characters; $0.08/1K (v4, v2), $0.04/1K (Flash); "API usage is billed in US dollars, not credits". Pooling with the 121k credits is UNVERIFIED.
  - [X API pricing](https://docs.x.com/x-api/getting-started/pricing): $0.015 per post, $0.20 with a URL; prepaid credits; $20 bonus after saving a card and completing a first purchase; per-cycle spend cap; auto-recharge.
  - Cloudflare R2 payment method before the first bucket: [tech-insider guide](https://tech-insider.org/au/how-to-set-up-cloudflare-r2-2026/), [eastondev](https://eastondev.com/blog/en/posts/dev/20251130-r2-picgo-setup/) (third-party; UNVERIFIED officially).
