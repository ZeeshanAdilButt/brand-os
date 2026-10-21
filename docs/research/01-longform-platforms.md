# 01 — Long-form platforms: dev.to, Hashnode, Medium, Substack

Research date: 2026-10-19. Scope: how content-powerhouse can get a canonical post from `https://www.example-blog.dev/blog/<slug>` onto dev.to, Hashnode, Medium and Substack as **drafts**, with a canonical link back to the site, with the least setup effort. Every publish stays behind the user's explicit per-action approval.

Labels used below: **VERIFIED** = read on an official page during this research. **3rd-party** = only seen in non-official sources. **UNVERIFIED** = could not confirm.

---

## Summary table

| Platform | Best method | Auth | Cost | Key limits | ToS risk | Recommendation |
|---|---|---|---|---|---|---|
| **dev.to** (Forem) | REST API `POST /api/articles` with `published:false` | `api-key` header (personal key from Settings → Extensions) | Free | 4 tags; images must be absolute URLs (no upload endpoint); rate limit not officially documented (~10 creates/30 s reported, 3rd-party) | Low (official API). AI-assist must be disclosed | **API**: fully automate draft creation. User clicks Publish on dev.to, or the tool flips `published:true` after approval |
| **Hashnode** | Official MCP server / CLI / GraphQL (`createDraft` → `publishDraft`) | MCP and CLI: browser login. GraphQL: Personal Access Token | **API, MCP and CLI need Hashnode Pro: $5/mo or $50/yr** per publication. Free plan: editor only | 5 tags (3rd-party); 500 mutations/min (3rd-party) | Low (official API) | **Pro available → MCP/API. Otherwise → manual copy-assist** (paste markdown, set "Original URL") |
| **Medium** | Official **Import a story** tool (by URL) | Normal Medium login (no API) | Free to publish. Membership $5/mo or $50/yr only needed for Partner Program | **No new API tokens** (no new integrations). Import drops tables and custom components. Rules ban programmatic posting | **High** for automation (Rules ban automated or programmatic posting and browser add-ons). Low for import | **Import + copy-assist.** The tool prepares a fix-up kit. The user runs Import, patches, and publishes |
| **Substack** | **Manual copy-assist** (paste rich HTML into the editor) | Normal login. No posting API exists | Free (10% fee only if you charge subscribers) | No post/draft API. Official MCP is read-only and Bestseller-only. **No canonical field.** Importer publishes directly, it does not create drafts | **High** for unofficial APIs and browser automation (AUP bans scraping, automation while logged out, and reverse engineering) | **Manual copy-assist.** Optional later: unofficial draft-only library, at the user's own risk |

**Cross-cutting finding (affects 3 of 4 platforms):** the site's RSS feed (`app/feed.xml/route.ts`) only emits `<description>` (the summary). It has no `content:encoded` full body. So **dev.to's RSS importer, Substack's RSS importer and Hashnode's RSS importer would import summaries only.** Do not build on RSS import unless the site later adds a full-content feed. That would be a change to the read-only site repo, so it is a proposal only.

---

## Source content: what has to be converted

Checked read-only in `example-blog-site`:

- `lib/mdx.tsx` uses `remark-gfm` and `rehype-highlight`. Custom components: `Callout` (106 uses, `<Callout type="note">…</Callout>`), `PacketJourney`, `StateMachine`, `OutOfBandDiagram`. The last three are interactive React diagrams.
- GFM **tables** are used heavily: 8+ posts, up to 119 table lines in one post.
- Images are **site-relative SVGs**, e.g. `![alt](/images/diagrams/deadlock-cycle.svg)`.
- Post URLs are `/blog/<slug>`.

A per-platform renderer must therefore:

1. **Absolutize image URLs** to `https://www.example-blog.dev/images/...`.
2. **Rasterize SVG to PNG at 2x.** SVG support on Medium and Substack is UNVERIFIED and generally poor, and dev.to proxies images through its CDN. PNG is the safe common format.
3. **Lower `<Callout>`** to a blockquote, with a bold label like `> **Note:** …`, on all four platforms.
4. **Replace interactive components** with a static PNG/GIF snapshot plus the link "Interactive version on example-blog.dev". The snapshot could be produced by a headless browser screenshot of the canonical page. That is a design detail for the build phase.
5. **Tables:** keep as GFM on dev.to and Hashnode, which both render markdown tables. On **Medium**, tables are not supported (UNVERIFIED, but long-standing behavior), so render them to PNG or a monospaced code block. On **Substack**, native table support is UNVERIFIED, so plan on PNG.
6. **Code blocks:** keep fenced blocks with a language tag. dev.to and Hashnode highlight them. Medium and Substack have code blocks with limited or no highlighting (UNVERIFIED for details).
7. **Add an attribution line** at the top or bottom: "Originally published at example-blog.dev/blog/<slug>". This is the only SEO signal available on Substack.

---

## 1. dev.to (Forem API v1)

**Status: VERIFIED, official, free, the best automation target.**

### API facts
- Docs: https://developers.forem.com/api/v1. The docs themselves warn they may be out of date. v0 is deprecated. Use v1.
- **Auth:** `api-key: <key>` header plus `accept: application/vnd.forem.api-v1+json`. It is **not** `Authorization: Bearer` ([Forem docs](https://developers.forem.com/api/v1), [3rd-party pitfalls write-up](https://dev.to/morinaga/three-devto-api-behaviors-i-had-to-handle-explicitly-in-a-publish-pipeline-56c0)).
- **Create:** `POST /api/articles` with body `{ "article": { title, body_markdown, published, series, main_image, canonical_url, description, tags, organization_id } }`.
  - `published` **defaults to `false`**, so the result is a draft. VERIFIED.
  - `canonical_url`: the URL of the original post. VERIFIED.
  - `series`: created if it doesn't exist. VERIFIED.
  - `main_image`: an absolute URL for the cover image. VERIFIED.
  - `tags`: a comma-separated string, **max 4**. VERIFIED. Tags are silently normalized to lowercase alphanumeric, so `machine-learning` becomes `machinelearning`. A 5th tag is silently dropped (3rd-party).
  - `body_markdown` may also carry YAML front matter. Pick one source of truth: send fields in JSON and no front matter.
- **Update:** `PUT /api/articles/{id}` takes the same fields. Setting `published:false` on a published article reverts it to draft. VERIFIED.
- **Responses:** 201, 401, 422 (create); 200, 401, 404, 422 (update).
- **Rate limits:** not documented in the official docs (UNVERIFIED). Reports say about 10 creates per 30 s, with `429` plus a `Retry-After` value that may be seconds **or** an HTTP-date ([3rd-party](https://dev.to/morinaga/three-devto-api-behaviors-i-had-to-handle-explicitly-in-a-publish-pipeline-56c0)). At one post per week this is irrelevant. Still, implement a backoff that handles both `Retry-After` formats.
- **Images:** there is no image-upload endpoint in the v1 docs I read (UNVERIFIED that none exists). Use absolute URLs hosted on the site.
- **Scheduling via API:** UNVERIFIED. Scheduling is available in the web editor (hexagon icon → "Schedule Publication") ([DEV help](https://dev.to/help/writing-editing-scheduling)).

### Getting credentials (clicks)
1. Sign in at dev.to → avatar → **Settings** → **Extensions**.
2. Under **DEV Community API Keys**, type a description ("content-powerhouse") → **Generate API Key**.
3. Store it in the tool's secret store, not in the repo. Revoke it on the same page.

### Canonical
- Via API: the `canonical_url` field. Via editor: gear/hexagon icon → "Canonical URL". Via RSS import: "Mark the RSS source as canonical URL" ([DEV help](https://dev.to/help/writing-editing-scheduling)).

### RSS import (not recommended now)
- Settings → Extensions → "Publishing to DEV Community from RSS". Imports arrive as **drafts** and can mark the source as canonical. However, the site's feed is summary-only, so imports would be summaries. Users also report that deleted imported drafts reappear ([3rd-party](https://dev.to/felixrunquist/automatically-cross-publishing-posts-to-devto-with-rss-12em)).

### Conversion notes
- Markdown plus Liquid tags (`{% embed %}`, `{% katex %}`, etc.). GFM tables and fenced code are supported. MDX components must be lowered as described above.

### Policy
- **AI disclosure:** the DEV guidelines allow AI-assisted posts but require disclosure, either with the `#abotwrotethis` tag or a note in the text, and the author must fact-check ([DEV AI guidelines](https://dev.to/guidelines-for-ai-assisted-articles-on-dev)). A newer tiered "AI Disclosure" selector was reported (3rd-party mirror, UNVERIFIED). If Claude only reformats the user's own text, disclosure is arguably not needed. If Claude writes adapted intros, disclose.

### Cost / risk
- Free. ToS risk is low because this is the official API.

**Recommendation: API.** Create the draft with `published:false`, `canonical_url`, `series`, ≤4 sanitized tags, `main_image` and `description`. Show the user the draft URL. Publish only on explicit approval, either via `PUT published:true` or by the user clicking Publish.

---

## 2. Hashnode (GraphQL / MCP / CLI)

**Status: VERIFIED on official pages. Big 2026 change: programmatic access is now paid.**

### Pricing change (important)
- Official Pro page: **$5/month or $50/year (2 months free)**. Pro includes **GraphQL API access**, headless mode, the agent skill for the API, webhooks, GitHub backup, bulk markdown import, scheduled publishing, custom domain, and hiding Hashnode branding. Pro is **per publication**. Upgrading one raises the account limit to 10 publications ([hashnode.com/pro](https://hashnode.com/pro)).
- The official MCP and CLI announcements both state that reading or writing a publication through the API requires Pro on that publication ([MCP post, 2026-09-29](https://hashnode.com/blog/hashnode-mcp-server), [CLI post, 2026-10-06](https://hashnode.com/blog/hashnode-cli)).
- Timeline (3rd-party): the GraphQL API became Pro-only around **2026-05-13**, and Pro launched **2026-06-11**. Custom domains connected earlier are grandfathered ([poster.ly guide](https://www.poster.ly/guides/hashnode-guide), [Feather comparison, competitor](https://feather.so/compare/feather-vs-hashnode)).
- The free plan gives one publication on `*.hashnode.dev` and the web editor.

### Three official ways in (all need Pro)
1. **Official MCP server: the easiest for "connect my stuff".** Endpoint `https://mcp.hashnode.com/mcp`. In Claude Code: `claude mcp add --transport http hashnode-mcp https://mcp.hashnode.com/mcp`. A browser login approves access, with **no token to handle**. It has 32 tools, including `create_draft`, `update_draft`, `publish_draft`, and image upload (`create_image_upload_url`, `confirm_image_upload`). The page warns that "Posts go live immediately" with the direct post tool, so always use the **draft tools** ([source](https://hashnode.com/blog/hashnode-mcp-server)). Whether the MCP can set a canonical URL (`originalArticleURL`) is **UNVERIFIED**. If it can't, use the GraphQL or CLI path for that field.
2. **Official CLI:** `npm i -g @hashnode/cli` (Node ≥20). `hashnode login` (browser), or `HASHNODE_PAT` for CI. Commands: `hashnode -p <pubId> draft create … --original-article-url <url>`, then `hashnode draft publish <draft-id>`, and `hashnode image upload cover.png` returns a CDN URL. **Front matter is not read**, so pass metadata as flags ([source](https://hashnode.com/blog/hashnode-cli)).
3. **GraphQL:** endpoint `https://gql.hashnode.com`. Header `Authorization: <PAT>` (UNVERIFIED whether the `Bearer` prefix is accepted. Send the raw token). Mutations `createDraft` / `publishDraft` / `publishPost(input: PublishPostInput!)` / `updatePost`. Inputs include `publicationId`, `title`, `contentMarkdown`, `originalArticleURL` (the **canonical input**; `canonicalUrl` is read-only on responses), `tags: [{slug, name}]` (max 5), `coverImageOptions`, `seriesId`. Rate limit: 20k queries/min and 500 mutations/min. The field names and limits come from 3rd-party sources that cite the official docs. The official docs site (apidocs.hashnode.com) redirects to an Apollo sandbox I couldn't render, so treat the exact schema as UNVERIFIED until checked via introspection ([dev.to cross-post write-up](https://dev.to/morinaga/three-hashnode-api-behaviors-that-differ-from-devto-in-a-cross-post-pipeline-14ml), [mcpbundles listing](https://app.mcpbundles.com/skills/hashnode)).
   - Gotchas: GraphQL returns HTTP 200 with an `errors[]` array, so always check it. Auth or edge failures can return HTML, so parse the body as text first. `publicationId` is not the blog slug: get it from `me { publications(first:5){ edges{ node{ id } } } }`.

### Getting credentials (clicks)
- MCP / CLI: no token. A browser login does it.
- PAT (GraphQL / CI): hashnode.com → avatar → **Account Settings** → **Developer** → **Generate new token** (path per the CLI post: "Settings, Developer").
- Pro: hashnode.com/pro → **Get Hashnode Pro** → choose the publication → pay. **Payment is something the user must do themselves.**

### Free path (no Pro)
- Editor → the down-arrow in the header → **Draft Settings** → "**Are you republishing?**" → **Add Original URL** sets the canonical ([Hashnode help](https://docs.hashnode.com/help-center/hashnode-editor/how-to-set-a-canonical-link)). The editor accepts raw Markdown, so copy-assist works well: the tool emits Hashnode-flavored markdown plus a checklist (title, subtitle, tags, cover, original URL).
- RSS importer with a "Scrape post" option for summary-only feeds exists per older community posts. Whether it is still free or creates drafts is UNVERIFIED ([townhall post](https://townhall.hashnode.com/increase-your-custom-blog-traffic-by-republishing-on-hashnode)).

### Conversion notes
- Markdown, GFM tables and fenced code with highlighting. LaTeX is supported (stated on the homepage). Mermaid support is UNVERIFIED. Lower MDX components. Images: use absolute URLs or upload to the Hashnode CDN.

### Cost / risk
- Free (manual) or $5/mo ($50/yr) for API/MCP/CLI. ToS risk is low on official paths.

**Recommendation:** If the user accepts **$50/yr → official MCP** (draft tools only) plus CLI/GraphQL for `originalArticleURL`. This is the smoothest "connect" experience of all four platforms. **If not → manual copy-assist** (about 2 minutes per post). Hashnode is also the lowest-priority platform of the four for reach, so deferring Pro is reasonable.

---

## 3. Medium

**Status: VERIFIED. The API is closed to new users. Import is the official path.**

### API
- Official help page: Medium "will not be issuing any new integration tokens for our API and will not allow any new integrations". Existing tokens keep working ([Medium help: API/Importing](https://help.medium.com/hc/en-us/articles/213480228-API-Importing)). The cutoff date was 2025-01-01 per a 3rd-party source ([StackOne](https://docs.stackone.com/connectors/medium/guides/link-account/integration-token)). n8n also documents that new Medium credentials can't be configured ([n8n](https://docs.n8n.io/integrations/builtin/credentials/medium/)).
- Unless the user already has a pre-2025 integration token (Settings → Security and apps → Integration tokens; ask the user to check), **there is no API path**.

### Import tool (official, preserves canonical)
1. medium.com → left rail **Stories** → **Import a story** (top right).
2. Paste `https://www.example-blog.dev/blog/<slug>` → **Import** → **See your story**.
3. The story lands as an editable draft, **backdated** to the original date, with the **canonical URL set automatically** ([Medium help: Importing a post](https://help.medium.com/hc/en-us/articles/214550207)).
4. Fix up the draft (see below) → **Publish**. That click belongs to the user.
- If the import fails, Medium says to move the content manually ([troubleshooting](https://help.medium.com/hc/en-us/articles/360033931713)). The site is SSR/SSG Next.js, so the HTML should be scrapable (UNVERIFIED until tried).
- Manual canonical (if pasting instead of importing): edit mode → **⋯** → **More settings** → **Advanced Settings** → "This story was originally published elsewhere" → enter URL → **Save canonical link** → Publish ([Medium help](https://help.medium.com/hc/en-us/articles/360033930293-Set-a-canonical-link)). Check it via View Source → search "canonical".

### What the import breaks (plan a fix-up kit)
- Tables: not supported, so they disappear or flatten (UNVERIFIED in detail). Substitute PNGs.
- Interactive components (`PacketJourney`, etc.) won't come through. Insert a PNG or GIF plus a link.
- SVG images may fail to import (UNVERIFIED). Provide PNGs.
- Callouts become plain paragraphs. Code block language and highlighting are limited.
- So content-powerhouse should produce a **"Medium fix-up kit"**: a folder of PNGs (tables, diagrams), an ordered checklist ("after paragraph X, insert table-2.png"), suggested title/subtitle, and up to 5 topics. Optionally it also puts the rendered rich HTML on the Windows clipboard for a full paste as a fallback to Import.

### Rules / ToS (important for automation)
- Medium Rules ([policy.medium.com/medium-rules](https://policy.medium.com/medium-rules-30e5502c4eb4)) prohibit "posting content … automatically, systematically, or programmatically". They also prohibit using "any software, script, robot … (including … browser plugins and add-ons …) to access the Services", and accessing the service except through the "published interfaces". **Driving Medium with browser automation, even in the user's own logged-in Chrome, is a clear ToS risk.** Keep Medium human-operated: the tool prepares, the user clicks.
- Cross-posting your own content is explicitly allowed. However, "content clipped with the purpose of linking to the rest of the article" on another site and "posting content primarily to drive traffic to … an external site" count as spam. **Post the full article, not a teaser.**
- **AI policy:** AI-assisted text must be disclosed (one sentence in the first two paragraphs). Undisclosed AI-assisted or AI-generated text is limited to "Network Only" distribution. Fully AI-generated writing can't be paywalled ([AI content policy](https://help.medium.com/hc/en-us/articles/22576852947223)). AI-generated images need a caption disclosure. This matters if the pipeline lets Claude rewrite text for Medium.

### Partner Program implications
- Eligibility: an **active Medium membership**, ≥1 published story, a complete profile, a bank in a supported country (Pakistan, the US, the UK and many others are listed), age 18+, and acceptance of the terms and the paywall-content policy ([eligibility](https://help.medium.com/hc/en-us/articles/39121627791639-Medium-Partner-Program-eligibility)). Earlier help pages quoted 5–6 stories and 2–3 months of activity. The current page says 1 story, so treat the page as the source of truth.
- Not eligible for the paywall: meta content about Medium, and mostly AI-generated writing ([paywall policy](https://help.medium.com/hc/en-us/articles/31090080813591)). Previously published stories *can* go behind the paywall per the enrollment guide (3rd-party summary of it).
- Strategy note: a paywalled copy reaches only members, and the canonical points to the site anyway. For brand-building, **don't paywall** by default. Make it a per-post choice.

### Cost
- Publishing and import are free. Membership is **$5/mo or $50/yr**, and "Friend of Medium" is $15/mo or $150/yr (3rd-party trackers; Medium has not changed $5 since 2017). Membership is only needed for the Partner Program.

**Recommendation: official Import tool plus a copy-assist fix-up kit. No API, no browser automation.**

---

## 4. Substack

**Status: VERIFIED that there's no posting API. Canonical is not supported (3rd-party consensus).**

### Official surfaces (none can post)
- **Developer API** (terms last updated 2026-01-08): covers public creator and publication profile data only (names, social URLs, subscriber counts, bestseller status). It mentions no publishing, and access is by application ([substack.com/api-tos](https://substack.com/api-tos)). Reported as launched in April 2026 for LinkedIn-handle lookups (3rd-party, low confidence).
- **Official MCP server** (reported 2026-07-06, `https://mcp.substack.com/api/v1/mcp`): **read-only** stats and settings, limited to **Bestseller** publication admins. It cannot publish or send Notes (3rd-party: [smtpedia](https://smtpedia.com/platforms/substack/api/). I couldn't find Substack's own announcement, so UNVERIFIED).
- **RSS** `/feed` is read-only.
- **Email-to-post:** no documented feature found (UNVERIFIED absence).

### Importer (not a draft tool)
- Settings → **Import/Export** → **Import posts** → paste a URL (Medium, Ghost, WordPress, Mailchimp, Beehiiv, Tumblr, Blogspot, SeekingAlpha) **or an RSS feed** → Import. Imported posts **appear in Home and Archive**, so they are published, not drafted. Afterwards you choose whether to email them ([Substack help](https://support.substack.com/hc/en-us/articles/360037830351)).
- Two problems with it: the site's RSS is summary-only, and the importer bypasses the draft-first gate. **Don't use it** for new posts.

### Canonical
- Substack has **no canonical URL field**. Posts self-canonicalize ([startuphub guide](https://www.startuphub.ai/news/canonical-cross-posting-guide), [Substack writer](https://anshulkumar.substack.com/p/can-you-post-the-same-blog-on-substack)). One blog claims an advanced-settings canonical exists. That is UNVERIFIED and contradicted by others, so check in the editor once.
- Mitigations: publish on the site first, make sure it is indexed (Search Console "Request indexing"), then post on Substack 2+ days later with an "Originally published at …" line. Alternatively, send a **newsletter edition**: a strong summary, 2–3 key graphs, and "read the full deep-dive" linking to the site. Unlike Medium, Substack has no rule against teasers. This is an editorial choice for the user.

### Unofficial options (ToS risk)
- `python-substack` (PyPI): cookie or email+password auth against **private endpoints**. Supports `create_draft_from_markdown` (draft by default) and a separate publish step ([PyPI](https://pypi.org/p/python-substack)). Community MCPs exist, e.g. `@conorbronsdon/substack-mcp`, which is draft-only for posts but publishes Notes immediately ([socket.dev](https://socket.dev/npm/package/@conorbronsdon/substack-mcp)).
- Risks: the session cookie is a **full-account credential**. Substack's Terms (last updated 2026-10-06) bar crawling and scraping, "any processes that run or are activated while you are not logged into Substack", and reverse engineering, and a breach "may result in immediate termination of your account" ([substack.com/tos](https://substack.com/tos)). Private endpoints break without notice.
- Browser automation (Claude in Chrome on the user's own logged-in session, filling a draft while the user watches) is technically feasible and not clearly banned by the clauses above, but it is grey. It is also fragile against editor changes. Not recommended as the default.

### Conversion notes
- Editor input is rich text. Paste **rendered HTML** (CF_HTML clipboard on Windows) rather than markdown. Code blocks and LaTeX blocks exist. Native tables are UNVERIFIED, so plan PNGs. Use PNG images, not SVG. Remove `<Callout>` and interactive components as above.

### Cost
- Free. 10% of paid-subscription revenue plus Stripe fees (2.9% + $0.30, plus 0.7% recurring billing) only if you charge. Custom domain is a one-time $50 (3rd-party: [Ruzuku, checked against Substack support 2026-03-26](https://www.ruzuku.com/learn/articles/substack-pricing)).

**Recommendation: manual copy-assist.** The tool produces a Substack-ready HTML render plus PNGs plus a title/subtitle/email-preview text, and copies it to the clipboard. The user pastes it into a new post, reviews it, and clicks Publish/Send. Revisit an unofficial draft-only library later only if the user explicitly accepts the account risk.

---

## Recommended method per platform

| Platform | Method | Automation level | User clicks per post |
|---|---|---|---|
| dev.to | **API** (Forem v1) | Draft fully automated. Publish after approval | 1 (approve) |
| Hashnode | **MCP/API** with Pro ($50/yr); else **manual copy-assist** | Full draft automation with Pro | 1 with Pro / ~6 without |
| Medium | **Import tool + copy-assist fix-up kit** | Prep only. Human does import and publish | ~5–10 (import, insert PNGs, publish) |
| Substack | **Manual copy-assist** (clipboard HTML) | Prep only | ~5 (new post, paste, check, publish/send) |

Suggested order after the site goes live: site → (indexed) → dev.to draft (API) → Hashnode → Medium import → Substack newsletter edition 2+ days later.

---

## Pricing summary

| Item | Price | Needed? |
|---|---|---|
| dev.to account + API | Free | Yes |
| Hashnode free plan | Free (1 publication on `*.hashnode.dev`, editor only) | Minimum |
| **Hashnode Pro** | **$5/mo or $50/yr per publication** ([official](https://hashnode.com/pro)) | Only for API/MCP/CLI automation, custom domain, scheduled publishing |
| Medium publishing + import | Free | Yes |
| Medium membership | $5/mo or $50/yr (Friend: $15/mo or $150/yr), 3rd-party trackers | Only for Partner Program earnings |
| Substack | Free; 10% of paid revenue + Stripe fees if monetized; custom domain $50 one-time | Free tier is enough |
| Unofficial Substack libs | Free (OSS) | Not recommended |
| **Total minimum** | **$0/yr** | Every platform can be reached for $0 |
| **Recommended "easy-connect" total** | **$50/yr** (Hashnode Pro) | Optional |

---

## Open risks

1. **Summary-only RSS feed.** It blocks every RSS-import path (dev.to, Hashnode, Substack). A fix would need a full-content feed (`content:encoded`) in the site repo, which is read-only for this project. Raise it as a proposal for the user.
2. **Canonical is a hint, not a guarantee.** dev.to and Medium have high domain authority and can outrank the site. Google's 2023 guidance reportedly prefers `noindex` on syndicated copies over canonical (3rd-party reports; official page not fetched, UNVERIFIED), and none of these platforms offers noindex. Mitigate by publishing the site first, getting it indexed, and delaying syndication by a few days.
3. **Substack has no canonical at all.** Each full-text Substack copy is unattributed duplicate content to search engines. Decide between full text and a newsletter edition.
4. **Medium automation is a ToS violation.** Its Rules explicitly ban programmatic posting and browser add-ons. Keep Medium human-driven.
5. **AI-disclosure policies** (Medium: Network-Only distribution if undisclosed; dev.to: disclosure required). If content-powerhouse rewrites text, as opposed to reformatting the user's own words, it must add a disclosure line per platform. Design a "who wrote this" flag per adaptation.
6. **Hashnode paywalled its API** in 2026, and these pricing changes are recent. Re-check before buying. Whether the MCP's draft tools can set `originalArticleURL` is UNVERIFIED.
7. **dev.to rate limits are undocumented** and the Forem docs admit they may be stale. Build backoff that handles `Retry-After` given as seconds or as a date.
8. **Hashnode GraphQL schema details** (field names, tag max, rate limits) are 3rd-party sourced. Verify via introspection on first use.
9. **Medium import fidelity** on this specific Next.js site is untested: tables, SVGs and code language. Run one dry-run import of an existing post as a draft and do not publish it. Only do this with the user's go-ahead.
10. **Substack official MCP/API facts** come from 3rd-party sources. Substack's own announcement wasn't found.
11. **Credential handling.** Store the dev.to API key and Hashnode PAT in the OS credential store (Windows Credential Manager), not `.env` in the repo. Never collect Substack or Medium passwords or cookies.
12. **Approval gate.** The Substack importer and Hashnode's direct `publishPost` / MCP post tools **go live immediately**. The tool must only ever call draft endpoints, with publishing as a separate, user-confirmed step.
