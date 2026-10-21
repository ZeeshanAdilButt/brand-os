# 02 - Social platforms: LinkedIn, X, Bluesky, Threads, Reddit, Mastodon

Research date: 2026-10-19. Scope: direct first-party APIs for posting to the owner's **personal** accounts (text, images, documents, and short 9:16 videos), from a single-user, draft-first tool that Claude drives via MCP. Every publish needs explicit per-action user approval (no auto-posting).

Legend: **VERIFIED** = read on an official doc/pricing page during this research. **3P** = third-party source only. **UNVERIFIED** = could not confirm; check before relying on it.

---

## Summary table

| Platform | Method | Auth | Cost | Key limits | Risk | Recommendation |
|---|---|---|---|---|---|---|
| **LinkedIn** (personal profile) | Official Posts API `POST /rest/posts` + Images, Videos, Documents APIs | OAuth 2.0 3-legged, self-serve products "Share on LinkedIn" (`w_member_social`) + "Sign In with LinkedIn using OpenID Connect". App must be linked to a LinkedIn Page | **Free** | 150 requests per member per day; video 3 s to 30 min, MP4, 75 KB to 500 MB; documents up to 100 MB / 300 pages; access token 60 days, **no refresh token** for self-serve apps | Medium: a re-auth click every 60 days; monthly API versions (202511 sunsets 2026-11-16); no long-form article or newsletter API | **Build direct.** Native video and PDF-carousel posts work for the personal profile. Track token expiry and prompt for a re-auth click before day 60 |
| **X / Twitter** | Official X API v2 `POST /2/tweets` + v2 chunked media upload | OAuth 2.0 Auth Code + PKCE (`tweet.read tweet.write users.read media.write offline.access`), or OAuth 1.0a user tokens for your own account | **Pay-per-use credits.** $0.015 per post, **$0.20 per post that contains a URL**. No free tier for new developers since Feb 2026 (3P). One-time $20 credit after adding a card (3P) | 100 creates per 15 min per user; 10,000 per 24 h per app; video `tweet_video` up to 20 min / 8 GB by default per the docs; posts over 280 chars need X Premium (3P) | Medium: costs money (small at this volume); pricing has changed 3 times in 2 years | **Build direct with a prepaid balance and a hard spending cap** (~$5/month cap is plenty). Put the blog link in only one post per thread, since URL posts cost 13x more |
| **Bluesky** | AT Protocol XRPC: `com.atproto.repo.createRecord` (`app.bsky.feed.post`), `uploadBlob`, video service | App password (simplest) or AT Protocol OAuth | **Free** | 5,000 points per hour and 35,000 per day (create = 3 points); `createSession` 30 per 5 min, 300 per day; 300-grapheme posts; video now up to 10 min / 300 MB (3P, Aug 2026) | Low | **Build direct with an app password.** It is the easiest platform to connect |
| **Threads** | Meta Threads API: create a container, then `threads_publish` | Meta app with Threads use case; OAuth scopes `threads_basic` and `threads_content_publish`; your own account added as a Threads tester, so no App Review is needed for self-use (3P) | **Free** | 250 API posts per 24 h; 1,000 replies per 24 h; 500-char text; video MP4/MOV, H.264/HEVC, up to 5 min and 1 GB, 9:16 recommended; **video must be at a public URL**; long-lived token 60 days, refreshable | Medium: you must host media publicly; Meta app setup is fiddly | **Build direct** (tester mode). Host video and images on a public bucket with short-lived URLs |
| **Reddit** | Data API (`/api/submit`) | OAuth "script" app, **but new OAuth tokens need manual approval since Nov 2025** (Responsible Builder Policy) | Free tier (100 QPM, non-commercial), but access is gated | Approval reported as slow and often rejected for personal scripts (3P); subreddit self-promotion rules | High: access and account-ban risk | **Do not automate.** Generate a subreddit-specific draft plus a pre-filled submit link; the owner posts by hand |
| **Mastodon** | REST `POST /api/v1/statuses` + `POST /api/v2/media` | Personal access token from the instance's Preferences > Development > New application (scopes `write:statuses write:media`) | **Free** | 300 requests per 5 min per account; 30 media uploads per 30 min; char and video limits depend on the instance (500 chars default); read them from `GET /api/v2/instance` | Low | **Build direct with a personal token.** Choose a tech-focused instance |

Approval-gate note for all rows: the tool should produce a **draft** (text plus media plus target account) and call the platform only after an explicit "approve X for platform Y" from the user. LinkedIn's API has no draft state for member posts (`lifecycleState` must be `PUBLISHED` on create; see the LinkedIn section), so drafts live in content-powerhouse, not on the platform.

---

## 1. LinkedIn (personal profile)

### What exists (VERIFIED)
- **Posts API** `POST https://api.linkedin.com/rest/posts` replaces `ugcPosts`. It needs headers `LinkedIn-Version: YYYYMM` and `X-Restli-Protocol-Version: 2.0.0`. Organic content types for posts: text, images, **videos**, **documents** (PDF "carousel" posts), article (link card), multi-image, poll. Organic carousels are **not** supported; sponsored only. Source: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api (updated 2026-05-13, default version `li-lms-2026-10`).
- **Permission:** `w_member_social` covers "Post, comment, and like posts on behalf of an authenticated member". Reading your own posts back needs `r_member_social`, which is restricted to approved users, so the tool should store the returned `x-restli-id` (post URN) itself. Same source.
- **Article posts (link shares):** the Posts API does **not** scrape the URL. You must supply `source`, `title`, `description` and an uploaded thumbnail `urn:li:image:...`. This suits us well, because the site's publishing-notes already contain the OG title, description and image. Same source.
- **Long-form LinkedIn Articles and Newsletters:** no endpoint exists in the Posts API content-type list. Third-party schedulers also report there is no API for native articles (https://publer.com/help/en/article/qoqs02/). **Conclusion: no API. Native LinkedIn articles and newsletters stay manual** (the tool can produce paste-ready copy).
- **Images API** `POST /rest/images?action=initializeUpload`: JPG/GIF/PNG, under 36,152,320 pixels; `w_member_social` can upload but cannot GET on versioned endpoints. https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
- **Videos API** `POST /rest/videos?action=initializeUpload`, PUT the 4 MB parts to the returned URLs, collect ETags, then `finalizeUpload`. Optional SRT captions (English only) and a custom thumbnail. Specs: **3 s to 30 min, 75 KB to 500 MB, MP4** (the initialize field allows up to 5 GB). `w_member_social` is allowed when the owner is the member's `urn:li:person`. https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
- **Documents API** `POST /rest/documents?action=initializeUpload`: PDF/PPT(X)/DOC(X), up to 100 MB and 300 pages. Useful for a "slides" version of the latency/queueing article. https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api
- **Rate limit (Share on LinkedIn):** 150 requests per member per day, 100,000 per app per day (UTC). https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin
- **Version sunset:** "Marketing Version 202511 ... will be sunset on November 16, 2026." Pin a recent version (for example `202610`) and plan to bump it about yearly. Posts API page above.

### Tokens (VERIFIED)
- Access tokens last **60 days**. **Programmatic refresh tokens (365 days) are only for approved Marketing Developer Platform partners.** A self-serve Share on LinkedIn app gets no refresh token, so the member must click through OAuth again about every 60 days. https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens
- Design implication: store `expires_at` and warn at day 50 ("LinkedIn needs a reconnect: one click"). Re-consent is usually a single click when already logged in (UNVERIFIED UX detail).

### Setup steps
1. Create or choose a LinkedIn **Page** (for example "Internals with Zee"); the developer app must be associated with a Page and verified by its admin, which is instant if you admin it (3P: https://www.linkedin.com/help/learning/answer/a1665329, https://dev.to/broke2builtai/how-to-post-to-linkedin-from-a-script-the-15-minute-oauth-walkthrough-2026-58fp).
2. https://www.linkedin.com/developers/apps > Create app.
3. Products tab: add **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect** (both self-serve, no review; 3P).
4. Auth tab: add redirect URL `http://127.0.0.1:<port>/callback/linkedin` (or `http://localhost:...`).
5. OAuth authorize with scopes `openid profile w_member_social`, exchange the code, then call `/v2/userinfo` to get `sub` and build `urn:li:person:{sub}`.
6. Post as `author: urn:li:person:...`. A 403 is usually a missing version header or a token minted before the product was added (3P: https://opentweet.io/answers/linkedin-api-403-on-rest-posts).

### Short-form video post requirements
MP4 (H.264/AAC is safest), 9:16 1080x1920 is fine, 3 s to 30 min, under 500 MB. Upload via the Videos API; optional SRT captions (worth doing for faceless narrated video); optional thumbnail. Then `POST /rest/posts` with `content.media.id = urn:li:video:...` and a `title`. Poll `GET /rest/videos/{urn}` until `AVAILABLE` before posting (doc shows status values PROCESSING / AVAILABLE).

### Cost: **$0.** Recommendation: **direct API**.

---

## 2. X (Twitter)

### Pricing (VERIFIED on docs.x.com pricing page, 2026-10-19)
Source: https://docs.x.com/x-api/getting-started/pricing
- **Post: Create: $0.015 per request.**
- **Post: Create with URL: $0.200 per request.** This applies to any post whose text contains a link (effective 2026-04-20 per 3P https://opentweet.io/x-api-pricing).
- Post: Create (summoned): $0.010. User interaction create: $0.015. Delete: $0.010.
- Reads: $0.005 per post; $0.001 for "owned reads" (your own posts and followers).
- Media upload: **not listed as a charge**; only "Media Metadata" delete at $0.005. Treat upload as free (UNVERIFIED; confirm in the Developer Console).
- Prepaid credits; you can set a **spending limit per billing cycle**, and requests are blocked when it is hit. Auto-recharge is optional. A negative balance blocks requests. 24 h dedup on reads.
- **Free tier:** closed to new developers since about 2026-02-06; legacy Basic ($200/mo) and Pro ($5,000/mo) remain for existing subscribers only, and Basic users were reportedly auto-migrated on 2026-06-01. (3P: https://roboin.io/article/en/2026/02/08/x-transitions-api-to-pay-per-use-model-ending-free-plan/, https://www.postproxy.dev/blog/x-api-pricing-2026/; the migration date is UNVERIFIED.)
- **Signup credits (3P):** $20 after saving a first payment card, plus a match of the first auto-recharge, up to $50. Spend rebate in xAI credits only above $200 per cycle (irrelevant here). https://opentweet.io/x-api-pricing (checked 2026-10-10).
- Minimum credit purchase amount: **UNVERIFIED**.

**Estimated monthly cost for the owner:** 8 articles/month x (5-post thread with the link only in the last post = 4 x $0.015 + $0.20 = $0.26) + 8 short videos x $0.015 = **about $2.20/month**, likely covered for months by the $20 signup credit. Set a $5 cycle cap.

### Limits (VERIFIED) https://docs.x.com/x-api/fundamentals/rate-limits
- `POST /2/tweets`: 100 per 15 min per user; 10,000 per 24 h per app.
- `POST /2/media/upload/initialize|append|finalize`: 1,875 per 15 min per user.

### Media and video (VERIFIED) https://docs.x.com/x-api/media/quickstart/media-upload-chunked
- v2 chunked upload: `POST /2/media/upload/initialize` (`media_type`, `total_bytes`, `media_category=tweet_video`), then `/{id}/append` (chunks of 5 MB or less), then `/{id}/finalize`, then poll `GET /2/media/upload?command=STATUS` until `succeeded`.
- `tweet_video` limits are listed as 20 min / 8 GB default and 125 min / 16 GB with Premium. Older 3P guides still say 512 MB / 2:20, so the limits are re-checked at post time ("a successful upload can still be rejected", 403). A 30-90 s Short is far inside either limit.
- Attach with `{"text": "...", "media": {"media_ids": ["..."]}}`. One video per post, or up to 4 images.

### Threads
Post 1 normally, then each following post with `"reply": {"in_reply_to_tweet_id": "<previous id>"}`. Each post is billed separately. Posts over 280 chars require the author to have X Premium (3P: https://www.ayrshare.com/docs/apis/post/social-networks/x-twitter; UNVERIFIED on docs.x.com), so a thread of posts of 280 chars or less is the safe default.

### Auth (VERIFIED) https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
- OAuth 2.0 Authorization Code + PKCE. Access tokens last **2 hours**; `offline.access` adds a refresh token. Scopes: `tweet.read tweet.write users.read media.write offline.access`. Choose the "Web App, Automated App or Bot" (confidential client) type for a local server. Treat refresh tokens as rotating and persist the new one on every refresh (common practice; UNVERIFIED wording).
- Alternative: OAuth 1.0a user-context Access Token + Secret generated in the console for **your own** account. These do not expire, which is the simplest "connect once" option for a single-user tool. Confirm that v2 media upload accepts OAuth 1.0a (UNVERIFIED).

### Setup steps
1. Sign in at the X Developer Console (console.x.com / developer.x.com) with the personal account; accept the developer terms (user action).
2. Create a Project and App. Under User authentication settings, enable OAuth 2.0, choose type Web App, set callback `http://127.0.0.1:<port>/callback/x`, and set permissions to Read and Write.
3. Billing: add a card (user action), buy a small credit, **set a spending limit**, and leave auto-recharge OFF.
4. Run the PKCE flow once; store the refresh token in the OS credential store (Windows Credential Manager).

### Recommendation: **direct API, paid, capped.** Avoid links in every post: put the canonical URL once, in the last post or in a reply.

---

## 3. Bluesky

### Facts
- **Rate limits (official, 3P-confirmed text from docs.bsky.app):** writes per account 5,000 points per hour and 35,000 per day; CREATE = 3 points, so about 1,666 creates per hour. `createSession` 30 per 5 min and 300 per day. 3,000 requests per 5 min per IP. https://docs.bsky.app/docs/advanced-guides/rate-limits (note: docs.bsky.app now 308-redirects to bsky.network/docs; the content did not render in our fetch, so the figures come via search snippet).
- **Post length:** 300 graphemes (well-known lexicon limit; UNVERIFIED in this session). Links need **facets** (byte offsets); a link card needs an `app.bsky.embed.external` with an uploaded thumbnail blob.
- **Video:** limits raised in late Aug 2026 to **10 min and 300 MB** (3P: https://engadget.com/2244638/bluesky-now-supports-10-minute-videos-larger-file-sizes/, https://opentweet.io/answers/bluesky-limits). Older docs say 3 min / 100 MB. A daily cap of 25 videos or 10 GB is reported (3P, UNVERIFIED). Call `app.bsky.video.getUploadLimits` at runtime instead of hard-coding limits. Upload goes through the video service (`app.bsky.video.uploadVideo`, then poll `getJobStatus`) using a service-auth token (`com.atproto.server.getServiceAuth`); a **verified email** on the account is required (from the official video tutorial outline https://bsky.network/docs/tutorials/video; detailed body not retrievable, UNVERIFIED).
- **Cost:** free, no developer registration.

### Auth and setup
1. Bluesky app: Settings > Privacy and security > **App passwords** > Add (user action). Name it "content-powerhouse".
2. The tool stores handle and app password in Windows Credential Manager; `com.atproto.server.createSession` returns access and refresh JWTs; refresh with `refreshSession` (do not create a new session per post, because of the 300 per day `createSession` cap).
3. Post: `com.atproto.repo.createRecord` with collection `app.bsky.feed.post`. Threads: set `reply.root` and `reply.parent` refs.
- OAuth (AT Protocol OAuth with DPoP) also exists but is heavier; app passwords are fine for a personal tool.

### Short video requirements
MP4, 9:16 OK, 10 min / 300 MB or less (verify via `getUploadLimits`), verified email, then embed `app.bsky.embed.video` with the returned blob and `aspectRatio {width:9,height:16}`, plus optional captions (VTT) and alt text.

### Recommendation: **direct, app password.** Lowest friction of all platforms.

---

## 4. Threads (Meta)

### Facts (VERIFIED) https://developers.facebook.com/docs/threads/overview, https://developers.facebook.com/docs/threads/posts
- Flow: `POST /{threads-user-id}/threads` (create container: `media_type=TEXT|IMAGE|VIDEO|CAROUSEL`, `text`, `video_url` or `image_url`), wait about 30 s and check container status, then `POST /{threads-user-id}/threads_publish?creation_id=...`. Host: `graph.threads.net`.
- Limits per 24 h moving window: **250 API-published posts** per profile (a carousel counts as 1), 1,000 replies, 100 deletes. Check with `GET /{id}/threads_publishing_limit`.
- Text: 500 chars. Carousel: 2-20 items.
- **Video:** MOV/MP4, moov atom first, H.264 or HEVC, AAC 48 kHz, 23-60 fps, max width 1920, aspect 0.01:1 to 10:1 (**9:16 recommended**), up to 100 Mbps, **up to 300 s (5 min), up to 1 GB**.
- **`video_url` must be on a public server.** Threads pulls the file from it, so content-powerhouse needs public object storage (for example Cloudflare R2, S3 or Vercel Blob, with a presigned or expiring URL).
- Threads (multi-post): post 1, then later posts with `reply_to_id` (counts toward the 1,000 replies per day).
- Tokens (VERIFIED, https://developers.facebook.com/docs/threads/get-started/long-lived-tokens): short-lived 1 h; exchange for a **long-lived 60-day** token; refresh with `GET /refresh_access_token?grant_type=th_refresh_token` once the token is 24 h or more old and not expired, giving a new 60 days. A scheduled weekly refresh keeps it alive indefinitely.
- **App Review:** accounts added as **Threads testers** under App Roles can grant permissions without App Review; review and a published app are only needed for other users (3P: https://postproxy.dev/blog/how-to-post-to-threads-via-api/, https://www.blotato.com/blog/threads-api-pricing). The tester invite must be accepted from the Threads account. Tech Provider verification is mentioned by some guides for production (3P, UNVERIFIED; not needed for tester-only use).
- Cost: free.

### Setup steps
1. https://developers.facebook.com > Create app > use case **"Access the Threads API"**.
2. Add permissions `threads_basic` and `threads_content_publish` (plus optionally `threads_manage_replies`).
3. App Roles: add the Threads account as a **Threads Tester**; accept the invite in Threads (Settings > Account > Website permissions > Invites).
4. Set the redirect URI (must be **https**; Meta generally rejects plain-http localhost; UNVERIFIED). Use a tunnel or the Graph API Explorer / User Token Generator to mint the first token, then exchange it for a long-lived one.
5. Store the long-lived token; schedule a refresh about every 50 days.

### Recommendation: **direct, tester mode, plus a public media bucket.**

---

## 5. Reddit

### Facts
- **Responsible Builder Policy (2025-11-11):** "requiring approval for any new Oauth tokens"; self-service Data API access closed; existing tokens unaffected; developers steered to **Devvit**. (3P mirrors of the r/redditdev admin announcement: https://r.datuan.dev/r/redditdev/comments/1oug31u/introducing_the_responsible_builder_policy_new/noc31sg; official policy page not retrieved, UNVERIFIED wording.)
- Reports say personal scripts are frequently rejected and approval takes 2-4 weeks (3P: https://medium.com/@alex_79882/reddits-api-is-officially-dead-in-2026-here-s-what-i-use-instead-f88ee5b809c8, https://www.socialcrawl.dev/blog/reddit-data-api-2026).
- Pricing: free tier 100 QPM per OAuth client (non-commercial). Commercial pricing ($0.24 per 1,000 calls; about $12k minimum) comes from 2023 announcements and is **UNVERIFIED** for 2026 (https://www.techloy.com/reddit-api-pricing-in-2026-complete-guide-for-developers-and-businesses/).
- Video upload via API uses undocumented media-lease endpoints (UNVERIFIED; historically unofficial).
- Cultural risk: subreddits (r/programming, r/ExperiencedDevs, r/sre, r/linux, r/devops) enforce self-promotion rules; automated link drops are the fastest way to get shadow-banned.

### Recommendation: **manual, assisted.** The tool generates a per-subreddit title and body (discussion-first, link last), checks a stored per-sub rules note, and opens `https://www.reddit.com/r/<sub>/submit?type=link&title=...&url=...` in the browser for the owner to review and submit. Optionally apply for API access later, but do not depend on it.

---

## 6. Mastodon

### Facts (VERIFIED)
- `POST /api/v1/statuses` (scope `write:statuses`): `status`, `media_ids[]`, `in_reply_to_id` (for threads), `visibility`, `language`, `scheduled_at`; send an **`Idempotency-Key`** header (kept 1 h), which is good for safe retries. https://docs.joinmastodon.org/methods/statuses/
- `POST /api/v2/media` (scope `write:media`): video is processed **async** (202), so poll `GET /api/v1/media/:id` until 200. https://docs.joinmastodon.org/methods/media/
- Rate limits: 300 requests per 5 min per account; **media uploads 30 per 30 min**. https://docs.joinmastodon.org/api/rate-limits/
- Char limit and media size limits are **per instance**; read `configuration.statuses.max_characters` and `configuration.media_attachments.*` from `GET /api/v2/instance`. The default is 500 chars; video around 99-100 MB on stock 4.x (UNVERIFIED).
- Cost: free.

### Setup steps
1. Pick an instance whose audience fits distributed-systems content (for example hachyderm.io or fosstodon.org); sign-up is a user action.
2. Preferences > Development > New application, scopes `write:statuses write:media read:accounts`. Copy the **access token** (it does not expire unless revoked).
3. Store the instance URL and token. Done.

### Recommendation: **direct, personal access token.** Easy and free.

---

## Cross-cutting design implications for content-powerhouse

1. **One adapter per platform** behind a common `publish(draft, target)` interface, plus an MCP server exposing `list_drafts`, `preview(draft, platform)`, `request_publish(draft, platform)` -> returns a confirmation token, and `confirm_publish(token)`. Never expose a one-shot "post now" tool, so the approval gate is structural.
2. **Secrets:** Windows Credential Manager (via keytar or similar) for tokens; never in repo or `.env` committed.
3. **"Connect my stuff" UX:** one local `connect <platform>` command that opens the browser for OAuth (LinkedIn, X, Threads) or prompts for a pasted app password or token (Bluesky, Mastodon), then shows a status page with token expiry dates.
4. **Public media hosting** is needed for Threads (and Instagram/YouTube flows elsewhere). LinkedIn, X, Bluesky and Mastodon accept direct binary upload.
5. **Video master:** produce one 1080x1920 H.264/AAC MP4 under 90 s and under 100 MB, plus an SRT/VTT caption file. This satisfies every platform above: LinkedIn (MP4, 500 MB or less), X, Bluesky (300 MB / 10 min), Threads (5 min, 1 GB, moov-first: use `ffmpeg -movflags +faststart`), and Mastodon (check instance).
6. **Per-platform text variants:** X (280 chars or less per post, thread), Bluesky (300 graphemes, facets), Threads (500 chars), Mastodon (500 by default), LinkedIn (long commentary, 3,000 chars widely reported but UNVERIFIED in the docs fetched; link card built from publishing-notes OG data).
7. **Idempotency:** record the platform post ID after each publish; use Mastodon's `Idempotency-Key`; on X, check before retrying, because a retry is a second $0.015 / $0.20 charge.

### Aggregator alternative (brief, mostly UNVERIFIED; another report may cover this)
Postiz is AGPL open source and free to self-host; its cloud costs about $29/month for 5 channels to $99 for 100, and it supports most of these platforms (3P: https://www.blotato.com/blog/postiz-pricing). An aggregator removes app setup, but adds a monthly fee and a third party holding the tokens. For this volume, direct APIs cost about $2-5/month in total (X only).

---

## Pricing summary

| Platform | API cost | Free allowance | Expected monthly cost (8 articles + 8 shorts) |
|---|---|---|---|
| LinkedIn | Free | 150 req/member/day | $0 |
| X | $0.015/post; $0.20/post containing a URL; reads $0.005 (VERIFIED) | No free tier for new devs (3P); $20 signup credit (3P) | **About $2-3** (cap at $5) |
| Bluesky | Free | 5,000 pts/h, 35,000 pts/day | $0 |
| Threads | Free | 250 posts/day | $0 (plus public storage, pennies; for example Cloudflare R2 has a free tier, covered by the storage report) |
| Reddit | Free tier gated by approval; commercial pricing UNVERIFIED | 100 QPM if approved | $0 (manual posting) |
| Mastodon | Free | 300 req/5 min | $0 |
| Optional: X Premium (for posts over 280 chars or longer videos) | about $8/mo Premium (UNVERIFIED, varies by region) | n/a | Not needed |
| Optional: Postiz cloud | $29-$99/mo (3P) | Self-host free | Not recommended initially |

**Total recommended spend for social posting: about $2-5/month (X credits only).**

---

## Open risks

1. **X pricing volatility.** The model changed in Feb 2026 and the URL surcharge was added in Apr 2026. Mitigation: spending cap, auto-recharge off, and per-publish cost shown in the approval prompt ("This will cost $0.20 because it contains a link"). Media upload cost and minimum top-up are UNVERIFIED.
2. **LinkedIn 60-day re-auth** with no refresh token for self-serve apps. Mitigation: expiry tracker and a reminder. LinkedIn may revoke tokens at any time (stated in the docs).
3. **LinkedIn version churn:** monthly `LinkedIn-Version`; 202511 sunsets 2026-11-16. Pin the version in config, and alert on a 426 or deprecation header.
4. **LinkedIn native articles and newsletters have no API.** They stay manual (paste-ready export).
5. **Threads needs public media URLs and Meta app hygiene.** The HTTPS redirect requirement for localhost is UNVERIFIED. Tester-mode use is 3P-sourced; if Meta tightens it, App Review would be needed.
6. **Reddit access is effectively closed** to new personal scripts (3P), and there is ban risk from automation. Keep it manual.
7. **Bluesky video limits are in flux** (changed Aug 2026), and the daily video cap is UNVERIFIED. Query `getUploadLimits` at runtime.
8. **Platform ToS on automation:** all platforms forbid spammy automation; the approval gate plus low volume keeps this well within norms. X's automation rules and LinkedIn's API ToS should be read once by the user (user action).
9. **Unverified items to re-check at build time:** X OAuth 1.0a support on v2 media upload; X long-post Premium requirement via API; LinkedIn 3,000-char commentary limit; Bluesky 300-grapheme limit and video daily cap; Mastodon default video size; Reddit commercial pricing.
10. **Account security:** tokens grant posting rights. Store them in the OS credential vault, use least scopes (no DM or delete scopes unless needed), and include a "revoke all" command.
