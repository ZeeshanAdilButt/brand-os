# 03 - YouTube + LinkedIn video publishing (and TikTok / Reels later)

Research date: 2026-10-19. Scope: how content-powerhouse uploads short vertical (9:16) faceless videos narrated in the user's own cloned voice to YouTube Shorts and LinkedIn. TikTok and Instagram Reels are covered as optional later targets. Every price, quota and limit below was checked against a live page on the research date unless it is marked **UNVERIFIED**.

Hard rule this design must follow: nothing goes public without the user's explicit per-action confirmation. Every upload path below is built to be draft-first.

---

## Summary table

| Platform / tool | Method | Auth | Cost | Limits | Risk | Recommendation |
|---|---|---|---|---|---|---|
| **YouTube (Shorts + long-form)** | YouTube Data API v3 `videos.insert` (resumable), then `thumbnails.set` / `captions.insert` | Google OAuth 2.0, Desktop client, own Google Cloud project, consent screen "External" + **In production** (unverified, single user) | **$0** (no billing account needed) | Uploads have their own bucket: **100 `videos.insert` calls/day**, 1 unit each. Other calls share **10,000 units/day** (thumbnail 50, caption 400, update 50). Max file 256 GB | Medium. The 2020 "unverified project, locked private" rule conflicts with the current docs (see section 1.2). Refresh tokens expire after 7 days if the app is left in Testing mode | **Primary path.** Always upload with `privacyStatus=private`. Publish only after approval, either now or through `publishAt`. Make your first upload a smoke test to confirm the lock is gone |
| YouTube fallback | YouTube Studio manual upload. The tool hands over the MP4, title, description, tags, SRT and thumbnail | Browser login | $0 | None in practice | Low | Use if the API lock turns out to still apply. Studio is also the only place to set a custom **Shorts** thumbnail |
| **LinkedIn (personal profile)** | Videos API (`/rest/videos` initializeUpload, then 4 MB parts, then finalizeUpload) plus the Posts API. Legacy option: `assets?action=registerUpload` + `ugcPosts` | LinkedIn OAuth 2.0, "Share on LinkedIn" product (self-serve), scope `w_member_social` | **$0** | Video 3 s to 30 min (API doc). File 75 KB to 500 MB per the high-level spec, 5 GB per the schema. Aspect ratio 1:2.4 to 2.4:1, so 9:16 is fine. One English SRT. **150 requests/member/day**. Access token lasts 60 days, with **no refresh token** for non-partner apps | Low to medium. You must re-authorize every ~60 days. There is no native scheduling, so the tool has to hold posts | **Primary path.** Reuse the same 9:16 MP4 and SRT. Schedule inside content-powerhouse |
| TikTok (later) | Content Posting API. Direct Post (`video.publish`) or Upload-to-inbox (`video.upload`) | TikTok Login Kit OAuth, app review for scopes | $0 | Without the audit: **SELF_ONLY** posts only, the account must be private, and at most **5 users per 24 h** | High for Direct Post, because an audit is needed for public posts | Use **Upload-to-inbox** (a draft the user finishes in the TikTok app; behaviour UNVERIFIED), or go through an audited aggregator |
| Instagram Reels (later) | Instagram Graph API content publishing, `media_type=REELS`, video at a public URL | Instagram Login (`instagram_business_basic`, `instagram_business_content_publish`) | $0 | **100 API posts per rolling 24 h** (one place in the same doc says 50). Needs a professional (Creator/Business) account | Medium. Meta app setup is fiddly, and the video must be hosted at a public URL | Later phase. Needs a Creator account and a Meta app that only you use |
| Aggregator fallback: Buffer | Buffer app, API or MCP | Buffer OAuth to each network | Free: 3 channels, 10 scheduled posts per channel. Essentials **$5/channel/mo**. Team $10/channel/mo | API: 3,000 requests/mo on Free, 100 per 15 min | Low. Its YouTube app is already approved | Escape hatch if the direct YouTube or TikTok API path is blocked |
| Aggregator fallback: Upload-Post | REST API plus an MCP server (`npx @upload-post/mcp`) | API key | Free trial. Paid prices are **not shown** on the pricing page (UNVERIFIED) | 22 platforms | Medium. Paid third party, pricing unknown | Only as a TikTok/IG shortcut if building direct integrations is too costly |

---

## 1. YouTube Data API v3

### 1.1 Quota (changed in 2025-2026)

- `videos.insert`: "Quota impact: 100 calls per day. A call to this method has a quota cost of 1 unit in the Video Uploads quota bucket." ([videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert), last updated 2026-10-15)
- Revision history:
  - 2025-12-04: upload cost cut "from approximately 1600 units to approximately 100 units".
  - 2026-06-01: "API calls to the videos.insert and search.list methods will be charged to their own respective quota buckets."
  - Source: [revision history](https://developers.google.com/youtube/v3/revision_history)
- [Quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost) (updated 2026-10-15). The default is 10,000 units/day for everything except `search.list` and `videos.insert`, which get 100 calls/day each. Quotas reset at midnight Pacific.

| Call | Cost | Bucket |
|---|---|---|
| `videos.insert` | 1 | Uploads bucket (100/day) |
| `thumbnails.set` | 50 | Shared 10k |
| `captions.insert` | 400 | Shared 10k |
| `videos.update` (e.g. set `publishAt`, flip to public) | 50 | Shared 10k |
| `videos.list` (status polling) | 1 | Shared 10k |
| `playlistItems.insert` | 50 | Shared 10k |

- One full Short costs 1 upload call plus about 500 units: thumbnail 50 + caption 400 + update 50. That allows roughly 20 fully dressed uploads per day, far above what a personal channel needs.
- Ignore older blog posts and MCP READMEs that still quote 1,600 units per upload and "6 uploads/day". One example is the miller-joe/youtube-mcp README, found via [glama listing](https://glama.ai/mcp/servers/miller-joe/youtube-mcp).
- **Cost:** the API is free. Raising quota beyond the default needs the free [Audit and Quota Extension Form](https://support.google.com/youtube/contact/yt_api_form). A single-user tool will never need it.

### 1.2 The "unverified projects are locked private" rule: current status

- **History.**
  - On 2020-07-28 Google ruled that videos uploaded "from unverified API projects created after 28 July 2020 will be restricted to private viewing mode" until the project passes an audit.
  - Locked videos could not be appealed. They had to be re-uploaded.
  - Sources: [revision history](https://developers.google.com/youtube/v3/revision_history), [clipember guide, Aug 2026](https://clipember.com/guides/youtube-upload-comes-out-private)
- **The current official reference says the opposite.** Both [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert) and the [Videos resource](https://developers.google.com/youtube/v3/docs/videos) (`status.privacyStatus`) now say:
  - "Videos uploaded from unverified API projects are not restricted to private viewing mode."
  - "if you don't specify a value for this property, the uploaded video's privacy status defaults to `public`."
  - "Certain uploads might default to `private` based on creator account settings" (linked to [Help 157177](https://support.google.com/youtube/answer/157177), which only covers the private default for under-18 creators).
- **Conflict.**
  - I found no revision-history entry announcing that the restriction was lifted. I read the first 100k characters, which cover all 2025-2026 entries.
  - Third-party guides from 2026 still describe the lock: [clipember](https://clipember.com/guides/youtube-upload-comes-out-private), and [Blotato](https://www.blotato.com/blog/youtube-api-pricing), which notes the docs disagree as of 2026-10-08.
  - **Status: UNVERIFIED in practice.** The reference docs say there is no lock. Settle it empirically with one throwaway smoke-test upload (section 1.3, step 7).
- **Design consequence (true either way).**
  1. Always send `status.privacyStatus: "private"` explicitly. The API default is now **public**, which would break the approval-gate rule.
  2. If the lock still applies, a locked video **cannot** be made public later. The fallback is a manual Studio upload of the same bundle, or an audit.
  3. The audit is the [Audit and Quota Extension Form](https://support.google.com/youtube/contact/yt_api_form). It has an "individual" option and requires compliance with the YouTube API Developer Policies.
     - Third parties report review times from weeks to months (UNVERIFIED): [getphyllo](https://www.getphyllo.com/post/is-the-youtube-api-free-in-2026-quota-limits-costs-when-to-pay), [outlierkit](https://outlierkit.com/resources/youtube-api-quota/).
     - For one user this is overkill. Use Studio, or Buffer, whose YouTube app is already approved, if the lock is real.

### 1.3 Setup for a single-user personal tool (the easiest connect path)

1. In Google Cloud Console, create a project (e.g. `content-powerhouse`). No billing account is needed.
2. Enable **YouTube Data API v3**.
3. Configure the OAuth consent screen:
   - User type **External**.
   - App name, support email, and your own email as developer contact.
   - Add the scopes `youtube.upload` and `youtube.force-ssl`. `captions.insert` requires `youtube.force-ssl` or `youtubepartner` per [captions.insert](https://developers.google.com/youtube/v3/docs/captions/insert).
4. **Publishing status: move from "Testing" to "In production" without submitting for verification.**
   - Why: in Testing mode with External user type, refresh tokens expire in **7 days** for any scopes beyond basic profile ([Google OAuth docs](https://developers.google.com/identity/protocols/oauth2#expiration)). You would have to reconnect every week.
   - An unverified production app shows the "Google hasn't verified this app" screen. You click through once (Advanced, then Go to app). Unverified apps are capped at **100 new users**, which is irrelevant here ([Unverified apps](https://support.google.com/cloud/answer/7454865)).
   - Google lists "apps in development" ("experimental or a test build") as not needing verification.
   - That YouTube scopes are classed as *sensitive* rather than *restricted* is **UNVERIFIED**. The scope pages fetched did not state it.
5. Create OAuth Client ID, type **Desktop app**. Store `client_secret.json` and the refresh token in the Windows Credential Manager / DPAPI, not in the repo.
6. Refresh tokens otherwise live until revoked or unused for 6 months. There is a limit of 100 refresh tokens per account per client ([same doc](https://developers.google.com/identity/protocols/oauth2#expiration)).
7. Run a **smoke test**:
   - Upload a 5-second 9:16 test clip with `privacyStatus=private`.
   - Check in Studio that you can manually switch it to Unlisted. If Studio refuses or shows "locked", the 2020 rule still applies.
   - Then delete the clip yourself in Studio.
8. Channel prerequisite: the account must be **verified** (phone) to use custom thumbnails ([Help 72431](https://support.google.com/youtube/answer/72431)). `thumbnails.set` returns 403 otherwise.

"Connect" UX for the user: one button or command, `connect youtube`. It opens the browser to Google consent, you click through the unverified warning once, and you are done.

Existing open-source MCP servers prove the pattern but are small projects (UNVERIFIED maintenance): [anwerj/youtube-uploader-mcp](https://pkg.go.dev/github.com/anwerj/youtube-uploader-mcp), [mrchevyceleb/youtube-mcp](https://github.com/mrchevyceleb/youtube-mcp), [yutu](https://glama.ai/mcp/servers/jii2qatzah). Recommendation: wrap the API in content-powerhouse's own MCP tool rather than depend on these. The surface is small: insert, thumbnail, caption, update, list.

### 1.4 Shorts eligibility

- Uploads on or after 2024-10-15 with a "square or vertical aspect ratio up to three minutes in length" are classified as Shorts automatically ([Help 15424877](https://support.google.com/youtube/answer/15424877)).
- The API has no `isShort` flag. Render at **1080x1920, 9:16, 3 minutes or less**, and target 30-60 s for these explainers.
- Content ID: a Short **over 1 minute** with any active copyright claim is blocked globally. Use only original audio (your cloned-voice narration plus your own or YouTube Audio Library music; Audio Library tracks "won't receive a Content ID claim"). Keeping Shorts at 60 s or less avoids the issue entirely.
- Adding `#Shorts` to the title or description is common practice. That it is unnecessary for classification is UNVERIFIED.
- For long-form later, use 16:9 to avoid Shorts classification.

### 1.5 Scheduling with `publishAt`

- `status.publishAt` "can be set only if the privacy status of the video is private and the video has never been published". A past time publishes immediately. On update you must also send `privacyStatus: private` ([Videos resource](https://developers.google.com/youtube/v3/docs/videos)).
- **Approval-gate pattern:**
  1. Upload private with no `publishAt` (a draft).
  2. Show the user the Studio preview link.
  3. On "approve publish at <time>", call `videos.update` with `publishAt` (50 units).
  4. YouTube then flips the video to public itself, so the tool does not need to be running at publish time.
  - Alternative: the user schedules in Studio.

### 1.6 Thumbnails

- `thumbnails.set`: 50 units, JPEG/PNG. The max file size went up from 2 MB to **50 MB** on 2026-09-14 ([thumbnails.set](https://developers.google.com/youtube/v3/docs/thumbnails/set), [revision history](https://developers.google.com/youtube/v3/revision_history)). Recommended size: 3840x2160 for videos, 2160x3840 (9:16) for Shorts ([Help 72431](https://support.google.com/youtube/answer/72431)).
- **Shorts caveat:** "Custom thumbnails for Shorts are currently only available to add in YouTube Studio on a computer" ([Help 72431](https://support.google.com/youtube/answer/72431)).
  - Whether `thumbnails.set` takes effect on a Short is **UNVERIFIED**. Test it during the smoke test.
  - Plan B: choose a strong frame-0 or title card, or set the thumbnail manually in Studio during approval.

### 1.7 Captions

- `captions.insert`: 400 units. Scope `youtube.force-ssl` or `youtubepartner`. Max 100 MB. Body `text/xml` or `application/octet-stream` (SRT/VTT accepted) ([captions.insert](https://developers.google.com/youtube/v3/docs/captions/insert)).
- The narration script already exists, so generate the SRT from the TTS word timestamps (ElevenLabs returns alignment data; that is another agent's scope) and upload it as a real track. This is also good for accessibility and SEO.
- Also set `snippet.defaultAudioLanguage=en`.

### 1.8 "Altered or synthetic content" disclosure (AI voice)

- From YouTube's Help page on altered or synthetic content ([Help 14328491](https://support.google.com/youtube/answer/14328491)):
  - The list of changes that **do not** need disclosure includes "Cloning one's own voice to create voice overs or dubs".
  - It also includes AI help with scripts, titles and thumbnails, and fully animated, non-realistic content.
  - Disclosure is required for realistic content, e.g. making "a real person appear to say or do something they didn't do".
- **Conclusion for this project:** a Short narrated in **your own** cloned voice over motion graphics (non-realistic diagrams) does **not** require disclosure.
- API field: `status.containsSyntheticMedia` (boolean, on insert/update) ([Videos resource](https://developers.google.com/youtube/v3/docs/videos)).
  - Recommendation: set it explicitly to `false` by default and record the reason in the video's metadata file.
  - Expose a per-video toggle. Set it to `true` if a video ever uses realistic AI footage or another person's voice.
- If you choose to disclose anyway, "disclosure alone won't limit a video's audience or affect monetization eligibility". Repeated failure to disclose when required can lead to labels, removal or a YPP suspension.
- Since May 2026 the label for Shorts shows as an overlay on the video ([techwyse report](https://www.techwyse.com/news/platform-updates/youtube-automatic-ai-labels-disclosure-may-2026), secondary source). That is one more reason not to over-disclose when it is not required.
- Also always set `status.selfDeclaredMadeForKids=false`.

### 1.9 Monetization implications

- **YPP eligibility** ([Help 72851](https://support.google.com/youtube/answer/72851)): 1,000 subscribers plus either 4,000 qualified long-form watch hours in 12 months **or** 10M qualified Shorts views in 90 days.
  - Shorts-feed watch time does not count toward the 4,000 hours.
  - The lower "fan funding" tier (500 subscribers, 3 uploads in 90 days, 3,000 hours or 3M Shorts views) is **UNVERIFIED** here. It was not on the fetched page.
- **Inauthentic content policy** (renamed from "repetitious content" on 2025-07-15; covers "content that is repetitive or mass-produced") ([YPP policies, Help 1311392](https://support.google.com/youtube/answer/1311392)).
  - This is the real risk for faceless AI-voice channels.
  - Secondary sources say enforcement is channel-level and targets templated, generic-voice, mass-produced uploads ([air.io timeline](https://air.io/en/monetization/youtube-monetization-policy-changes-2026-a-complete-dated-timeline), [gulfnews](https://gulfnews.com/technology/youtube-updates-monetisation-policies-ai-and-repetitive-content-ban-begins-july-15-1.500192660); figures in these are UNVERIFIED).
  - **Mitigation:**
    - Each Short derives from an original long-form article with original diagrams and analysis.
    - The voice is your own.
    - Vary the visual templates.
    - Avoid a high-volume cadence.
    - Link back to the canonical post.
- Monetization is not a near-term goal; Shorts are distribution for example-blog.dev. The policy still matters because a channel-level "inauthentic" flag would follow you to long-form later.

---

## 2. LinkedIn native video

### 2.1 Access

- Add the **Share on LinkedIn** product in the LinkedIn Developer Portal. It is self-serve and free, and grants `w_member_social` for posting as yourself ([Share on LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin)).
- Rate limit: **150 requests per member per day**, 100,000 per app.
- Tokens:
  - Access tokens are valid for **60 days**.
  - Programmatic refresh tokens (1 year) are only for "approved Marketing Developer Platform (MDP) partners" ([Refresh tokens](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens)).
  - So plan a one-click re-connect roughly every 60 days, with a reminder at day 50.
- Posting as a Company Page needs `w_organization_social` through the Community Management API, which requires a separate application. Out of scope for a personal brand.

### 2.2 Upload flow

Use the newer [Videos API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api) (default version `li-lms-2026-10`). It lists `w_member_social` and supports member-URN owners.

1. `POST /rest/videos?action=initializeUpload` with `owner: urn:li:person:<id>`, `fileSizeBytes`, `uploadCaptions: true`, `uploadThumbnail: true`. Required headers: `Linkedin-Version: 202610` and `X-Restli-Protocol-Version: 2.0.0`.
2. PUT each 4 MB part (4,194,304 bytes) to its `uploadUrl` and keep each ETag.
3. Upload the SRT (one file, **English only**) and the thumbnail to the returned URLs.
4. `POST /rest/videos?action=finalizeUpload` with the ETags.
5. Poll `GET /rest/videos/{urn}` until `AVAILABLE`.
6. Create the post through the Posts API, referencing the video URN. Posts API details are in the LinkedIn text research doc.

Notes:

- Whether a self-serve "Share on LinkedIn" app can call the versioned `/rest/videos` endpoint is **UNVERIFIED**. Developers widely report that it works, and the documented permission matches.
- The legacy path (`/v2/assets?action=registerUpload` with recipe `feedshare-video` + `/v2/ugcPosts` with `shareMediaCategory: VIDEO`) is still documented on the Share on LinkedIn page as a fallback.
- Version policy: Marketing version 202511 sunsets 2026-11-16. Pin a recent version and bump it periodically.

### 2.3 Specs

- From the Videos API page: length "Three seconds to 30 minutes", file "Between 75kb and 500MB", MP4. The schema says "Maximum allowed Videos size is 5GB".
- LinkedIn Help for organic video ([Pages video specs](https://www.linkedin.com/help/linkedin/answer/a1311816), [Share photos/videos](https://www.linkedin.com/help/lms/answer/a527229)):
  - 75 KB to 5 GB.
  - Aspect ratio **1:2.4 to 2.4:1**, so **9:16 vertical is supported**.
  - 256x144 to 4096x2304.
  - 10-60 fps.
  - Length 15 min from desktop / 10 min from mobile (the sources conflict).
- A 30-60 s, 1080x1920 H.264/AAC MP4 under 100 MB satisfies all of these. **The same file serves YouTube Shorts and LinkedIn.**
- **No scheduling via API.** content-powerhouse must hold approved posts and fire them at the chosen time. That means a local scheduler or a small cloud job, which is outside this doc's scope.

---

## 3. TikTok (optional, later)

- Content Posting API ([Get started](https://developers.tiktok.com/doc/content-posting-api-get-started), [Content sharing guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines)):
  - "All content posted by unaudited clients will be restricted to private viewing mode."
  - Unaudited clients can only post `SELF_ONLY`, for at most 5 users per 24 h, and the posting accounts must be private.
  - Audited clients still have creator caps and per-account daily caps.
- Third parties report audit times of 2-6 weeks and frequent rejections ([bundle.social](https://bundle.social/blog/tiktok-api-approval), UNVERIFIED).
- The API is free. A sandbox is available.
- **Recommendation:**
  - Use the **Upload (inbox/draft) mode** (`video.upload`). The video lands in your TikTok inbox, and you finish posting in the app. This lines up naturally with the approval gate.
  - Whether Upload mode is exempt from the audit/private restriction is **UNVERIFIED**. Confirm in the TikTok developer portal.
  - Otherwise, use an audited aggregator such as Buffer, which supports TikTok on its Free plan ([Buffer pricing](https://buffer.com/pricing)).

## 4. Instagram Reels (optional, later)

- Instagram Platform content publishing ([docs](https://developers.facebook.com/docs/instagram-platform/content-publishing)):
  - Create a container with `media_type=REELS` and a `video_url` that must be "hosted on a publicly accessible server", then publish.
  - Requires an Instagram **professional** account (Creator is free).
  - Instagram Login scopes: `instagram_business_basic` and `instagram_business_content_publish`.
  - Limit: **100 API-published posts per rolling 24 h**. The carousel section of the same doc says 50, so treat it as 50+.
- Cost: $0.
- Friction:
  - You need a Meta developer app, a public URL for each video (e.g. a short-lived signed URL from Vercel Blob or R2), and a webhooks server per the doc.
  - That an app used only by its own admin/tester works without full App Review is **UNVERIFIED**; it was not stated on the fetched page.

---

## 5. Recommended pipeline (video leg)

```
article.mdx -> script.md (approved) -> ElevenLabs narration + word timestamps -> motion-graphics render
  -> short.mp4 (1080x1920, <=60s, H.264/AAC) + captions.srt + thumb_9x16.png + thumb_16x9.png + meta.json
  -> [APPROVAL GATE 1: user reviews mp4 + metadata]
  -> YouTube: videos.insert(private, containsSyntheticMedia=false, madeForKids=false) + captions.insert (+ thumbnails.set)
  -> LinkedIn: initializeUpload/parts/finalize -> held as "ready"
  -> [APPROVAL GATE 2: per platform "publish now / at T"]
  -> YouTube videos.update(publishAt=T) ; LinkedIn Posts API create at T
```

Every gate is an explicit per-action confirmation. No step changes visibility without one.

---

## Pricing summary

| Item | Price | Free tier / limits | Source |
|---|---|---|---|
| YouTube Data API v3 | **$0** | 100 uploads/day (own bucket) + 10,000 units/day for everything else. Higher quota needs an audit (free) | [quota calc](https://developers.google.com/youtube/v3/determine_quota_cost) |
| Google Cloud project / OAuth client | **$0** | No billing account required for the YouTube Data API | same |
| YouTube Studio manual upload | **$0** | n/a | n/a |
| LinkedIn Share on LinkedIn + Videos API | **$0** | 150 requests/member/day. Token lasts 60 days and must be re-connected | [Share on LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin) |
| TikTok Content Posting API | **$0** | Unaudited: SELF_ONLY, 5 users/24 h | [TikTok guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines) |
| Instagram Graph API | **$0** | 100 (or 50) API posts per 24 h | [Meta docs](https://developers.facebook.com/docs/instagram-platform/content-publishing) |
| Buffer (fallback) | Free: 3 channels, 10 scheduled posts per channel. Essentials **$5/channel/mo** ($60/yr). Team **$10/channel/mo** | API on Free: 3,000 requests/mo. Has an MCP page | [buffer.com/pricing](https://buffer.com/pricing) |
| Upload-Post (fallback) | Free trial. Paid prices not listed (**UNVERIFIED**). Its page claims Ayrshare costs $49+/mo | 22 platforms, MCP server | [upload-post.com/pricing](https://www.upload-post.com/pricing) |
| YPP thresholds (not a cost) | 1,000 subscribers + 4,000 h / 12 mo **or** 10M Shorts views / 90 d | n/a | [Help 72851](https://support.google.com/youtube/answer/72851) |

Expected cost of the video **publishing** leg is $0/month. Narration (ElevenLabs) and rendering costs are covered in the voice and video-generation research docs.

---

## Open risks

1. **The YouTube unverified-project lock is ambiguous.**
   - The current docs (2026-10-15) say uploads are "not restricted to private". The 2020 rule, which has no recorded revocation, and 2026 third-party guides say they are.
   - Mitigation: smoke-test upload first. If the lock applies, fall back to Studio upload or Buffer. The audit is possible but slow and not guaranteed.
2. **The API default privacy is `public`.** A bug that omits `privacyStatus` would publish without approval. Mitigations:
   - Hard-code `private` in the client wrapper.
   - Add a test.
   - Refuse any upload call that lacks an approval token.
3. **OAuth Testing-mode trap.** Leaving the consent screen in "Testing" means the YouTube connection dies every 7 days. Move it to "In production" (unverified) on day one.
4. **LinkedIn 60-day re-auth.** There is no refresh token for self-serve apps. Add an expiry warning and a one-click reconnect. Also bump the LinkedIn-Version header (202511 sunsets 2026-11-16).
5. **Shorts custom thumbnails** are documented as Studio-desktop only. Whether `thumbnails.set` works for Shorts is UNVERIFIED.
6. **Inauthentic-content (YPP) risk** for faceless AI-voiced Shorts. Keep each Short tied to original analysis, vary the templates, and keep the cadence moderate.
7. **AI disclosure judgment.** Own-voice cloning is exempt per the Help Center. If you ever use a stock or other-person voice, or photorealistic AI footage, set `containsSyntheticMedia=true`.
8. **Content ID on Shorts over 60 s.** Any claim blocks the Short globally. Use only original or Audio Library audio, and prefer 60 s or less.
9. **TikTok / IG are gated** (audit, public video URL, Meta app). Defer them, or route through an audited aggregator.
10. **Third-party MCP servers for YouTube are small hobby projects.** Prefer an in-repo tool. Do not grant third-party servers `youtube.force-ssl`, which includes deleting videos.
