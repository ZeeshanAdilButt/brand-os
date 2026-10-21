# 04 — Schedulers, aggregators and existing MCP servers (buy vs build)

Research date: 2026-10-19. Prices are USD unless noted and change often. Anything marked **UNVERIFIED** comes from third-party or conflicting sources, or could not be confirmed on an official page. Re-check before paying for anything.

Workload used for the cost estimates: about 3 articles and 10 shorts per week, so about 13 articles and 43 shorts a month. Each article fans out to LinkedIn, X, Threads, Bluesky, Mastodon, dev.to, Hashnode, Medium and Substack. Each short goes to YouTube Shorts and LinkedIn video, and optionally X and Threads. That works out to roughly 150–200 publish actions a month.

---

## TL;DR

1. **Buy the social and video layer, build the blog layer.** Use **Buffer** as the scheduler for LinkedIn, X, YouTube Shorts, Threads, Bluesky and Mastodon. It has an official remote MCP server (`https://mcp.buffer.com/mcp`), the MCP is included on every plan including Free, and it costs $5 per channel per month. Buffer also owns the hard parts: an audited YouTube app, LinkedIn token refresh, and X API billing (**UNVERIFIED**: whether Buffer passes X API costs on to users).
2. **Use direct APIs where they are free and simple:** dev.to (API key, supports `canonical_url`) and Hashnode (GraphQL PAT; a Pro-plan requirement is **UNVERIFIED**). Bluesky and Mastodon can also go direct for free if you want to save two Buffer channels.
3. **Medium and Substack cannot be fully automated through any legitimate API.** Medium issues no new integration tokens. Substack has no publish API, and its official MCP is read-only. Plan a "copy-ready export + 1-click open" step: Claude prepares the content and the owner pastes or imports it.
4. **Runner-up: Postiz Cloud** at $29–39/mo. It has an official MCP and covers dev.to, Hashnode and Medium in the same tool. Choose it if one tool for everything matters more than cost. **Do not self-host Postiz** for this project: you would have to register your own LinkedIn, X and Google apps and pass YouTube's API audit, which defeats "very very easy to connect".
5. **Do not build a direct YouTube uploader first.** Videos uploaded through `videos.insert` from an unaudited Google project created after 2020-07-28 are locked to **private** until the project passes a YouTube API compliance audit. An aggregator sidesteps this.
6. **Expected monthly cost:** **$15–30/mo** for distribution (Buffer at 3–6 channels, plus $0 for dev.to, Hashnode and direct Bluesky/Mastodon). The alternative is **$31–39/mo** for Postiz Cloud. **Avoid** Ayrshare ($149/mo minimum) and Hootsuite ($99+/user/mo).
7. **Approval gate:** every write-capable MCP here can publish immediately (Buffer `create_post`, Postiz `schedulePostTool` with publish-now, Typefully `publish_at: "now"`). content-powerhouse must enforce draft-first itself. Set Claude Code permission rules to `ask` on write tools and `deny` on raw passthrough tools such as Buffer `execute_mutation`.

---

## Summary table

| Platform / tool | Method | Auth | Cost (single creator) | Key limits | Risk | Recommendation |
|---|---|---|---|---|---|---|
| **Buffer** | SaaS scheduler + official remote MCP + GraphQL API | API key (Bearer). OAuth via in-app "Integrations → Claude" | Free: 3 channels. Essentials $5/channel/mo. Team $10/channel/mo | Free: 10 scheduled posts per channel, 3,000 API req/30d. Essentials: 7,500 req/30d | Medium: Buffer holds all social OAuth tokens. The API key gives full account access | **PRIMARY for social + video** |
| **Postiz Cloud** | SaaS scheduler (AGPL open source) + official MCP + API + CLI | API key (Bearer or in-URL) or OAuth2 `pos_` tokens | Standard $29 ($23 annual), 5 channels. Team $39 ($31), 10 channels | No free plan, 7-day trial. MCP cannot read comments | Medium: same as Buffer. Key-in-URL variant leaks into logs | **Runner-up / all-in-one** |
| **Postiz self-hosted** | Docker (Next.js, NestJS, Postgres, Redis, Temporal) | Your own developer apps for every OAuth platform | $0 licence + VPS (est. $5–15/mo, **UNVERIFIED**) | YouTube audit, LinkedIn 60-day tokens, X pay-per-use all fall on you | Low third-party risk, high ops burden | Not for v1 |
| **Ayrshare** | Social API + official MCP + Claude Code plugin | API key. X needs your own X OAuth 1.0a keys (since 2026-03-31) | Premium $149/mo, Launch $299/mo | No free plan | Medium | Overkill. Skip |
| **Zernio** (ex-Late) | Social API, MCP (vendor-built) | API key | First 2 accounts free, then $6/account/mo. X billed at X's own rates | 10k messages/mo free | Medium | Viable cheap alternative to Buffer |
| **Upload-Post** | Social API + open-source MCP (~50 tools) | API key | Free tier. Basic about $24/mo for 5 profiles (**UNVERIFIED**) | Includes dev.to, Hashnode, Bluesky, Mastodon | Medium | Watch-list alternative |
| **Typefully** | Text scheduler + API v2 (MCP reported) | API key | Free (10–15 posts/mo). Creator about $8–15/mo (**UNVERIFIED**) | No YouTube or video platforms | Medium | Only if you want best-in-class X/LinkedIn writing UX |
| **Hootsuite** | Enterprise SMM + official remote MCPs (Perch/Nest/Lumen) | OAuth (workspace sign-in) | Standard $99/user/mo (annual) | 10 accounts | Low–Med | Too expensive. Skip |
| **Publer** | SMM scheduler, API on Business | API key | Pro about $5/account. Business about $10/account (**UNVERIFIED**) | Free plan excludes X. MCP beta Enterprise/Ambassador only (**UNVERIFIED**) | Medium | Skip |
| **Zapier MCP** | Hosted MCP over 8k apps | OAuth per app | Free 100 tasks. Pro from $19.99/mo (annual, 750 tasks). About 2 tasks per MCP call | Shared task pool | Medium: another token holder | Glue only, not core |
| **Make** | Automation + MCP server | OAuth per app | Free 1,000 credits. Core about $9–12/mo for 10k credits (**UNVERIFIED**) | Medium app deprecated | Medium | Skip |
| **n8n** | Workflow engine, MCP Server Trigger | Your creds | Self-host Community: free. Cloud Starter €20/mo (2,500 executions) | | Low if self-hosted | Optional later |
| **X direct** | X API v2 pay-per-use, official `xmcp` | OAuth 1.0a / 2.0 user context, own dev app | $0.015 per post, **$0.20 per post containing a URL**. No free tier for new devs since 2026-02-06. $20 first-card credit | | Low (you hold the keys) | Only if Buffer's X support is limited |
| **LinkedIn direct** | Posts API (`/rest/posts`), "Share on LinkedIn" self-serve | OAuth 2.0, `w_member_social` | Free | **60-day tokens, no refresh token** for non-partners. Video via Videos API (**UNVERIFIED** for member scope) | Low | Via Buffer instead |
| **YouTube direct** | Data API v3 `videos.insert` | Google OAuth (sensitive scope) | Free | 100 uploads/day bucket. **Unaudited projects: uploads forced private.** Testing-mode refresh tokens expire after 7 days | Low | Via Buffer instead |
| **dev.to direct** | Forem API v1 `POST /api/articles` | `api-key` header | Free | 4 tags, supports `canonical_url` and `published:false` drafts | Low | **Build direct** |
| **Hashnode direct** | GraphQL `publishPost` | PAT in `Authorization` | Free, or Pro if API is now Pro-only (**UNVERIFIED**) | 500 mutations/min | Low | **Build direct** |
| **Medium** | No new API tokens. Legacy tokens still work | n/a | Free | Cannot automate for a new user | — | **Manual import** (Medium's "Import a story" keeps canonical) |
| **Substack** | No publish API. Official MCP is read-only | n/a | Free | Unofficial cookie-based MCPs only | High (session cookie) | **Manual paste.** Notes possibly via Buffer/Typefully |
| **Bluesky / Mastodon direct** | AT Protocol / Mastodon REST | App password / access token | Free | | Low | Direct or Buffer, either is fine |
| **Threads** | Threads API (Meta app) | Meta OAuth | Free | Needs a Meta developer app | Low | Via Buffer |
| **ElevenLabs** | Hosted MCP `https://api.elevenlabs.io/v1/mcp` (OAuth, in Claude directory). Old local MCP archived | OAuth / API key | Uses your ElevenLabs credits (see voice-research doc) | Hosted MCP looks Agents-platform-centric. TTS via hosted MCP is **UNVERIFIED** | Low | Call the REST API from content-powerhouse. Use the MCP only for ad-hoc work |

---

## 1. Buffer

**What it is now.** Buffer ships a public GraphQL API, a CLI and an **official remote MCP server**. Third-party reports date the launch to May 2026 (**UNVERIFIED**). Buffer's own pages confirm the MCP and say it is included on **every plan including Free**.

- MCP endpoint: `https://mcp.buffer.com/mcp` over HTTP. Auth: `Authorization: Bearer <API key>`. ([developers.buffer.com MCP guide](https://developers.buffer.com/guides/integrations/mcp.html))
- The marketing page also offers OAuth sign-in and a one-click "Settings → Integrations → Claude". Access is revocable under Settings → API. ([buffer.com/mcp](https://buffer.com/mcp))
- Tools: `get_account`, `list_channels`, `get_channel`, `list_posts`, `get_post`, `create_post`, `edit_post`, `delete_post`, `get_aggregated_post_metrics`, `list_ideas`, `list_idea_groups`, `create_idea`, post-template CRUD. Advanced tools: `introspect_schema`, `execute_query`, `execute_mutation`. There is also a `review_weekly_posts` prompt.
- Networks postable via the API/MCP: Instagram, Facebook, X, LinkedIn, Pinterest, **YouTube** (video required, plus `metadata.youtube` title and category), Google Business, Mastodon, TikTok, Threads, Bluesky, Start Page. Buffer's channel list also mentions Substack (probably Notes, **UNVERIFIED**), but the API docs do not list it.
- The API supports drafts. Buffer says AI-created posts "land in your Buffer queue as drafts or scheduled posts", which fits the approval gate.

**Pricing** ([buffer.com/pricing](https://buffer.com/pricing)):

| Plan | Price | Channels | Posts | API |
|---|---|---|---|---|
| Free | $0 | up to 3 | 10 scheduled per channel | 1 key; 100/15 min, 250/24 h, 3,000/30 d |
| Essentials | $5/channel/mo ($60/channel/yr) | any | unlimited | 3 keys; 7,500/30 d |
| Team | $10/channel/mo | any | unlimited | 5 keys; 500/24 h, 15,000/30 d |

The FAQ says annual billing saves 20%, but the listed prices imply about 17%. Volume discounts apply above 10 channels. The Free plan also has a lifetime cap of 8 unique channels per network ([Buffer X help](https://support.buffer.com/article/561-using-twitter-with-buffer)).

**X caveat.** Buffer's help docs do not say whether X's 2026 pay-per-use API costs are absorbed or passed on (**UNVERIFIED**). X Delegate accounts are not supported.

**Setup (Claude Code):**
1. In Buffer, connect LinkedIn, YouTube and X (and optionally Threads, Bluesky, Mastodon) in the web UI. This is one-click OAuth per network.
2. Settings → API → create an API key. Store it in Windows Credential Manager or a user env var, never in the repo.
3. `claude mcp add --transport http buffer https://mcp.buffer.com/mcp --header "Authorization: Bearer %BUFFER_API_KEY%"`
4. In `.claude/settings.json`, set permissions to ask on `mcp__buffer__create_post`, `edit_post` and `delete_post`, and deny `mcp__buffer__execute_mutation`.

**Verdict:** best price-to-ease ratio for the social and video layer.

---

## 2. Postiz (open source + cloud)

- Repo `gitroomhq/postiz-app`: about 37.4k stars, **AGPL-3.0**, actively developed (3.4k commits). Stack: Next.js, NestJS, Prisma/Postgres, Redis, Temporal. ([GitHub](https://github.com/gitroomhq/postiz-app))
- **Official MCP** at `https://mcp.postiz.com/mcp` with a Bearer key, or `/mcp/<key>` with the key in the URL. Self-hosted instances expose `/mcp`, `/mcp/:apiKey` and `/mcp-oauth` on their own backend. 13 tools: `integrationList`, `groupList`, `integrationSchema`, `triggerTool`, `schedulePostTool` (schedule, draft or publish now), `postsListTool`, `postSettingsTool`, `generateImageTool`, `generateVideoOptions`, `videoFunctionTool`, `generateVideoTool`, `clippingTool`, `clippingStatusTool`. It cannot read or reply to comments. ([docs.postiz.com/mcp](https://docs.postiz.com/mcp/introduction))
- **Platforms:** X, LinkedIn (personal and page), YouTube, Threads, Bluesky, Mastodon, Reddit, Instagram, Facebook, TikTok, Pinterest, Discord, Slack, Dribbble, Lemmy, Nostr, WordPress, **dev.to, Hashnode, Medium**. Bluesky, dev.to, Hashnode, Medium and WordPress connect with credentials and need no dev app. **Medium still needs an integration token, which Medium no longer issues**, so it is effectively unavailable for a new user. ([providers docs](https://docs.postiz.com/providers))
- **Cloud pricing** ([postiz.com/pricing](https://postiz.com/pricing)): Standard $29/mo ($23 annual) with 5 channels; Team $39 ($31) with 10 channels; Pro $49 ($39) with 30; Ultimate $99 ($79) with 100. All plans have unlimited posts, and API, MCP and CLI are included. There is no free plan, only a 7-day trial ([cloud overview](https://docs.postiz.com/cloud/overview)). How Postiz handles X API costs on cloud is **UNVERIFIED**.
- **Self-host:** you must register your own developer app for X, LinkedIn, Google/YouTube and Meta. Meta, YouTube and TikTok approvals "can take weeks". This brings back every hard problem in sections 9–10.

**Setup (cloud):** sign up, connect channels in the UI, then Settings → Developers → Public API → key. Run `claude mcp add --transport http postiz https://mcp.postiz.com/mcp --header "Authorization: Bearer <key>"`. Use the header form, never the key-in-URL form.

**Verdict:** the best "one tool for everything except Substack" option. It costs more than Buffer for this channel count (8 channels means the Team plan at $31–39). Its AI video and clipping tools overlap with what content-powerhouse would build.

---

## 3. Ayrshare

- Pricing: **Premium $149/mo** (1 profile, up to 14 networks, unlimited posts), Launch $299/mo, Business from $599/mo. No free plan; Launch has a 28-day trial. ([ayrshare.com/pricing](https://www.ayrshare.com/pricing/))
- Official **MCP** at `https://api.ayrshare.com/mcp` (Streamable HTTP, stateless, Bearer API key, 27 tools). It also ships a **Claude Code plugin with a confirmation hook**, a useful pattern to copy. ([MCP connect docs](https://www.ayrshare.com/docs/additional/mcp-action-connect))
- **X requires your own X API keys** (OAuth 1.0a headers) since 2026-03-31, so you also pay X pay-per-use. ([X BYO keys](https://www.ayrshare.com/docs/dashboard/connect-social-accounts/x-twitter-byo-keys))
- **Verdict:** built for platforms serving many users. Ten times the cost of Buffer for one creator. Skip.

## 4. Typefully

- API v2 at `https://api.typefully.com`, Bearer API key. Drafts CRUD, media upload, queue. `publish_at` accepts `now`, `next-free-slot` or an ISO time. `plan_at` creates dated drafts that **do not auto-publish until confirmed**, which is a good approval-gate primitive. Platforms: **X (incl. X Articles), LinkedIn, Threads, Bluesky, Mastodon, Substack Notes**. No YouTube or video platforms. ([typefully.com/docs/api](https://typefully.com/docs/api))
- MCP: Typefully's site links an "MCP" help article. Eden's Aug-2026 roundup calls it official and included on all plans including Free, and another roundup says it is "Verified" in the Claude directory. Community servers also exist (`pepuscz/typefully-mcp-server`). I could not open Typefully's own MCP doc (**UNVERIFIED** endpoint). ([eden.so roundup](https://eden.so/blog/best-social-media-mcp-servers/))
- Pricing (**UNVERIFIED**: no public price list could be fetched, and aggregators conflict): Free has 1 social set and about 10–15 posts/mo with API/MCP. Creator is about $8–15/mo. Business/Team is about $18–59/mo. ([aiproductivity.ai](https://aiproductivity.ai/pricing/typefully/), [toolradar](https://toolradar.com/tools/typefully/pricing))
- **Verdict:** excellent text/thread UX, and the only route found to Substack Notes besides Buffer. It does not cover video, so it cannot be the only tool.

## 5. Hootsuite

- Standard from **$99/user/mo** (annual, 10 accounts), Professional $199, Advanced up to $399. 14-day trial. ([hootsuite.com/plans](https://www.hootsuite.com/plans))
- Official remote MCPs per product: `mcp.hootsuite.com/perch` (drafting, scheduling, publishing), `/nest`, `/lumen`, `/parliament`. Auth is OAuth workspace sign-in. ([hootsuite.com/integrations/mcp](https://www.hootsuite.com/integrations/mcp))
- **Verdict:** enterprise pricing. Skip.

## 6. Publer

- Pricing per account (**UNVERIFIED**, sources inconsistent): Professional about $5/mo for the first account ($4 annual); Business about $10 ($8 annual). The free plan has 3 accounts and **excludes X**. API is on Business. An MCP beta is reportedly limited to Enterprise and Top Ambassadors. ([costbench](https://costbench.com/software/social-media-management/publer/), [blotato](https://www.blotato.com/blog/publer-pricing))
- **Verdict:** no MCP for normal users. Skip.

## 7. Cheaper API aggregators (alternatives to watch)

- **Zernio** (formerly Late): the first 2 accounts are free, then $6/account for accounts 3–10. X is billed at X's own rates with no markup. A vendor MCP is reported (280+ tools per third parties, **UNVERIFIED**). For 6 accounts the cost is $24/mo plus X usage. ([zernio.com/pricing](https://zernio.com/pricing))
- **Upload-Post:** 22 platforms including YouTube, LinkedIn, X, Threads, Bluesky, Mastodon, dev.to, Hashnode. MIT-licensed MCP with about 50 tools, plus FFmpeg jobs. Free tier; Basic is about $24/mo for 5 profiles (**UNVERIFIED**). ([upload-post.com/pricing](https://www.upload-post.com/pricing), [YouTube MCP](https://www.upload-post.com/mcp/youtube/))
- Both are younger vendors than Buffer. Use them as fallbacks if Buffer's X or YouTube handling disappoints.

## 8. Zapier / Make / n8n

- **Zapier:** Free has 100 tasks/mo. Pro is $19.99/mo annual for 750 tasks ($29.99 monthly). MCP access is on all plans, and each successful MCP tool call costs **about 2 tasks** (one source says 1, so **UNVERIFIED**), drawn from the shared task pool. ([zapier.com/pricing](https://zapier.com/pricing))
- **Make:** Free has 1,000 credits and 2 active scenarios. Core is about $9–12/mo for 10k credits (**UNVERIFIED**; the pricing page did not render prices). It has an MCP server. Its **Medium app is deprecated** for new connections. ([make.com/pricing](https://www.make.com/en/pricing), [jetadmin](https://www.jetadmin.io/blog/make-pricing/))
- **n8n:** cloud Starter €20/mo (2,500 executions), Pro €50/mo. The self-hosted Community Edition is on GitHub (free under the Sustainable Use License). It has an MCP Server Trigger, an MCP Client and instance-level MCP. ([n8n.io/pricing](https://n8n.io/pricing/))
- **Verdict:** none of these is needed. content-powerhouse plus Buffer already does the orchestration. Each adds another party holding your tokens. n8n self-hosted is the only one worth considering later, for cron-style jobs.

---

## 9. Direct platform APIs (the "build" side)

### X (Twitter)
- Pay-per-use is the default since 2026-02-06; the free tier is closed to new developers. **$0.015 per post** and **$0.20 per post containing a URL** (since 2026-04-20). Post reads cost $0.005. A one-time $20 credit applies on the first saved card (since 2026-10-02). Prices change; the X Developer Console is authoritative. ([postproxy](https://postproxy.dev/blog/x-api-pricing-2026), [opentweet](https://opentweet.io/how-to/x-api-pay-per-use-explained), [medianama](https://www.medianama.com/2026/02/223-x-developer-api-pricing-pay-per-use-model/))
- Official MCP: **`xdevplatform/xmcp`** runs locally at `127.0.0.1:8000/mcp`, auto-generates tools from the OpenAPI spec, and supports `X_API_TOOL_ALLOWLIST` to restrict tools. ([docs.x.com/tools/mcp](https://docs.x.com/tools/mcp))
- Cost at our volume if done direct: 13 link posts × $0.20 = $2.60, plus about 45 non-link posts × $0.015 = $0.68. That is **about $3–5/mo**.

### LinkedIn
- No official LinkedIn MCP. Community servers are either OAuth-based or **browser-automation based** (the most popular, `stickerdaniel/linkedin-mcp-server`, warns that it may violate the ToS). ([contentin.io](https://contentin.io/blog/best-linkedin-mcp-server/), [morphllm](https://www.morphllm.com/linkedin-mcp-server))
- The official path is the self-serve "Share on LinkedIn" product, which grants `w_member_social` for posting via `/rest/posts`. Video is uploaded via `/rest/videos` and referenced by URN (member-scope video is **UNVERIFIED** on official docs).
- **Access tokens last 60 days. Refresh tokens exist only for approved Marketing Developer Platform partners**, so a self-built integration means re-authorising every 60 days. ([Microsoft Learn: refresh tokens](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens))
- Buffer and Postiz Cloud are partners and handle this for you.

### YouTube
- `videos.insert` now costs **1 unit from a separate 100-uploads/day bucket**. `thumbnails.set` costs 50 units from the 10k/day pool. The page was updated 2026-10-15. ([Google quota costs](https://developers.google.com/youtube/v3/determine_quota_cost))
- **Blocker:** videos uploaded by unaudited API projects created after 2020-07-28 are **locked private** until the project passes a YouTube API Services compliance audit. ([summary](https://timetopost.co/blog/how-to-upload-videos-youtube-api), [audit form](https://support.google.com/youtube/contact/yt_api_form))
- A Google OAuth consent screen left in "Testing" issues refresh tokens that expire after **7 days**. ([unipile](https://www.unipile.com/google-oauth-refresh-token/))
- Community MCPs: `anwerj/youtube-uploader-mcp` (Go, MIT, small) and `eat-pray-ai/yutu` (CLI + MCP, broader). Both need your own Google project, so the audit problem applies. ([pkg.go.dev](https://pkg.go.dev/github.com/anwerj/youtube-uploader-mcp))

### dev.to (Forem)
- `POST https://dev.to/api/articles` with an `api-key` header. Fields include `body_markdown`, `published` (false means a draft, which is a natural approval gate), `tags` (up to 4), **`canonical_url`**, `series`, `main_image`. Free. ([Forem API v1](https://developers.forem.com/api/v1))
- Community MCPs exist (`rawveg/devtomcp`, hosted MCPBundles), but a 50-line direct client is safer and simpler.

### Hashnode
- GraphQL endpoint with a PAT from hashnode.com/settings/developer; 500 mutations/min. Canonical is set via `originalArticleURL`. A third-party listing claims the **API has been Pro-only since May 2026** (**UNVERIFIED**). ([search summary](https://dev.to/morinaga/three-hashnode-api-behaviors-that-differ-from-devto-in-a-cross-post-pipeline-14ml))

### Medium
- Medium "will not be issuing any new integration tokens" and allows no new integrations; existing tokens still work. ([Medium help](https://help.medium.com/hc/en-us/articles/213480228)) Make's Medium app is deprecated.
- Plan: content-powerhouse publishes canonically on example-blog.dev, then the owner uses Medium's "Import a story" (which sets the canonical link) with the URL that Claude prepares. Avoid browser-automation workarounds, which fall outside the ToS.

### Substack
- No public publish API. Substack's **official MCP (`https://mcp.substack.com/api/v1/mcp`, since 2026-07-06) is read-only** (metrics/settings) and reportedly limited to Bestseller publications (**UNVERIFIED**). Community "publish" MCPs rely on the `substack.sid` session cookie, which is high risk. ([smtpedia summary](https://smtpedia.com/platforms/substack/api/), [enterprisedna listing](https://enterprisedna.co/directories/mcp/conorbronsdon-substack-mcp))
- Plan: generate Substack-ready HTML/markdown plus subject and preview text, then paste manually. Substack Notes may be reachable via Typefully (confirmed in its API) or Buffer (**UNVERIFIED**).

### Bluesky / Mastodon / Threads
- Bluesky (app password, AT Protocol) and Mastodon (personal access token) are free and trivial to call directly. Threads needs a Meta developer app with `threads_content_publish`. Buffer covers all three, so going direct only saves $5/channel. (Direct-API details are from general knowledge, not re-verified this session.)

---

## 10. Existing MCP servers: maturity and risk

| Server | Official? | Transport / auth | Maturity | Risk notes |
|---|---|---|---|---|
| Buffer `mcp.buffer.com/mcp` | Yes | Remote HTTP; API key or OAuth | New (2026), vendor-maintained | `execute_mutation` is a raw GraphQL escape hatch, so deny it. The key gives full account access |
| Postiz `mcp.postiz.com/mcp` | Yes | Remote HTTP; Bearer / key-in-URL / OAuth | Active OSS project | Key-in-URL form leaks in logs and history |
| Ayrshare `api.ayrshare.com/mcp` | Yes | Streamable HTTP; Bearer | Mature API, new MCP | X needs BYO keys |
| Hootsuite `mcp.hootsuite.com/*` | Yes | Remote; OAuth | New | Expensive |
| Typefully | Reported official (**UNVERIFIED**) + community | API key | — | Community servers are small |
| X `xdevplatform/xmcp` | Yes (X Dev Platform) | Local; your X keys | New | Exposes every endpoint unless you allowlist |
| LinkedIn | **None official** | Community: OAuth or browser-session | Mixed | Browser-session servers risk account restriction |
| YouTube | **None official** | Community: your Google OAuth | Small projects | Audit/private-lock problem |
| dev.to | None official | Community / hosted bundles | Small | Easy to replace with a direct call |
| Medium | None usable | — | — | No tokens available |
| Substack | Official, **read-only** | Remote; Substack sign-in | New | Cookie-based write MCPs are risky |
| ElevenLabs | Yes. Hosted `api.elevenlabs.io/v1/mcp` (OAuth, in Claude directory). Local `elevenlabs-mcp` (1.5k stars) **archived** | Remote OAuth | Hosted is current | Tool calls spend credits. Hosted focus appears to be Agents ([hosted MCP docs](https://elevenlabs.io/docs/agents-platform/operate/hosted-mcp.md), [GitHub](https://github.com/elevenlabs/elevenlabs-mcp)) |
| Zapier / Composio | Aggregators | OAuth per app | Mature | One more party holding tokens |

## 11. Claude connectors (claude.ai / Claude Desktop / Claude Code)

- Directory at `claude.ai/directory`. Remote connectors require a paid plan per Anthropic's FAQ; some third-party guides say Free gets 1 custom connector (**UNVERIFIED**). ([Claude blog](https://claude.com/blog/connectors-directory), [connector FAQ](https://claude.com/docs/connectors/faq))
- Relevant directory connectors: **ElevenLabs** (hosted, OAuth) and **Canva**. **Typefully** is reportedly "Verified" (**UNVERIFIED**). Buffer offers a one-click "Integrations → Claude" flow from its side. Hootsuite documents adding its MCP as a custom connector ([Hootsuite blog](https://blog.hootsuite.com/post-on-social-media-from-claude/)).
- Claude Code: add any remote server with `claude mcp add --transport http <name> <url> --header "Authorization: Bearer ..."`. Remote connectors added in claude.ai are called from Anthropic's cloud, so a local content-powerhouse MCP server works in Claude Code and Desktop (stdio) but not in claude.ai web unless it is exposed publicly.

---

## Pricing summary (single creator, ~13 articles + ~43 shorts a month)

| Option | Channels covered automatically | Monthly cost | Notes |
|---|---|---|---|
| **A. Buffer Free + direct APIs (minimum)** | LinkedIn, X, YouTube via Buffer. dev.to, Hashnode, Bluesky, Mastodon direct | **$0** (+ Hashnode Pro if required, **UNVERIFIED**) | 10-scheduled-post cap per channel is tight for 10 shorts/week. Threads not covered |
| **B. Buffer Essentials + direct (recommended)** | LinkedIn, X, YouTube, Threads (4 × $5) via Buffer. dev.to, Hashnode, Bluesky, Mastodon direct | **$20/mo** ($30 if Bluesky and Mastodon also go through Buffer) | Unlimited scheduling. 7,500 API req/30d is far above our ~500 |
| C. Postiz Cloud Team | LinkedIn, X, YouTube, Threads, Bluesky, Mastodon, dev.to, Hashnode (8 of 10 slots) | **$31/mo annual, $39 monthly** | One MCP for everything. X cost handling **UNVERIFIED** |
| D. Zernio | 6 accounts | about $24/mo + X usage (~$3–5) | Younger vendor |
| E. Fully direct (build) | All except Medium/Substack | about $3–5/mo (X only) + VPS if hosted | YouTube audit, LinkedIn 60-day re-auth, Meta app. Weeks of friction |
| F. Ayrshare Premium | 14 networks | $149/mo + X usage | Not justified |
| G. Hootsuite Standard | 10 accounts | $99/mo | Not justified |
| Always manual | Medium (import), Substack (paste) | $0 | Claude prepares copy-ready output |

Not included above: voice/TTS (ElevenLabs) and rendering costs, which belong to the video research doc.

---

## Open risks

1. **Approval gate bypass.** Every write tool can publish now. Mitigations: content-powerhouse exposes only `draft_*` tools to Claude, with publishing behind an explicit `confirm_publish(id)`. Claude Code `permissions.ask` on all write tools and `deny` on `execute_mutation`. Prefer Buffer drafts, Typefully `plan_at` and dev.to `published:false`.
2. **Token custody.** Buffer or Postiz holds the OAuth tokens for LinkedIn, X and YouTube. A compromised Buffer API key can post anywhere. Store keys in Windows Credential Manager, use the minimum number of keys, and rotate if leaked. Never use Postiz's key-in-URL form.
3. **X costs and policy drift.** X has changed prices three times in 2026. Link posts cost 13× plain posts. It is unclear whether Buffer or Postiz absorb or pass through X costs (**UNVERIFIED**). Watch the first invoice.
4. **Buffer MCP is young** (2026). Features like YouTube Shorts metadata, LinkedIn video or the Substack channel may lag the UI. Validate with a dry run (draft only) per network before committing.
5. **Hashnode API possibly Pro-only** (**UNVERIFIED**). Confirm before building.
6. **Medium/Substack stay manual.** Unofficial automation (cookies, browser bots) risks account restriction. Keep them as assisted-manual steps.
7. **Vendor lock-in.** Keep content-powerhouse's publishing adapter interface provider-agnostic (`Publisher` per destination) so Buffer can be swapped for Postiz, Zernio or direct without touching content logic.
8. **Claude plan dependency.** claude.ai remote connectors need a paid plan. A local stdio MCP in Claude Code or Desktop avoids that dependency.
9. **Unverified prices:** Typefully, Publer, Make, Upload-Post and Zernio's MCP were all from aggregators. Re-check on the vendor sites before any purchase.
