# 05 - Faceless short-video pipeline: voice, motion graphics, captions

Research date: 2026-10-19. Prices change often (ElevenLabs re-priced on 2026-09-28 with the v4 launch). Anything not confirmed on an official page is marked **UNVERIFIED**.

Goal: turn a canonical post on example-blog.dev (first one: the upcoming first launch article - latency vs utilization, queueing knee, tail latency, coordinated omission, fan-out) into a 45-60 s vertical (1080x1920) faceless short with code-driven motion graphics, narrated in the owner's cloned voice, for YouTube Shorts and LinkedIn video. Nothing is published without explicit per-action approval.

---

## Summary table

| Platform / tool | Method | Auth | Cost (Oct 2026) | Limits | Risk | Recommendation |
|---|---|---|---|---|---|---|
| **ElevenLabs** (voice) | REST API `POST /v1/text-to-speech/{voice_id}/with-timestamps`; hosted MCP server | API key (`xi-api-key`); hosted MCP uses OAuth | Creator $22/mo ($11 first month), includes ~$22 of API usage = ~275k chars at $0.08/1K (v4, v3, Multilingual v2); Flash $0.04/1K. Starter $6/mo | v4/Multilingual v2: 10k chars per request; v3: 5k. PVC needs Creator+. Free plan: no commercial use, attribution required | Prices moved in Sept 2026; a leaked key lets someone speak in your voice | **Use it.** Creator plan, Professional Voice Clone of own voice, v4 or Multilingual v2 |
| ElevenLabs IVC (Instant clone) | Upload under 2 min of audio, ready immediately | same | Starter $6/mo and up | Less consistent quality | Low | Use for a same-day prototype only |
| Cartesia Sonic | REST/WebSocket API | API key | Pro $5/mo (100K credits, IVC); Startup $49/mo (1.25M credits, 2 PVC slots) | 3-5 concurrent TTS requests | Smaller ecosystem, no first-party MCP found | Best-value fallback |
| OpenAI TTS | REST API | API key | tts-1 $15/1M chars; tts-1-hd $30/1M; gpt-4o-mini-tts $0.60/1M text in + $12/1M audio tokens out | No self-serve voice cloning (**UNVERIFIED**) | Not your voice | Use only for scratch narration |
| Gemini TTS | REST API | API key | e.g. 3.8 Flash TTS $0.50/1M in + $9/1M audio out until 2026-12-31, then doubles | No cloning | Not your voice | Skip |
| PlayHT / PlayAI | none | - | - | Shut down (Meta acquisition July 2025, service ended 2025-12-31 per secondary sources) | Dead | **Do not use** |
| Fish Audio | REST API | API key | $15 per 1M UTF-8 bytes (about 12 h of speech) | Concurrency tied to lifetime spend | Commercial terms on free tier inconsistent | Cheapest cloud cloning option, second choice |
| Chatterbox (Resemble, local) | Python, local GPU | none | $0 (MIT) | Zero-shot clone from one clip; GPU strongly advised (**UNVERIFIED** on Windows) | Quality/maintenance on you | Offline fallback |
| Kokoro (local) | Python / C# (KokoroSharp) | none | $0 (Apache-2.0) | 54 preset voices, **no cloning** | - | Free scratch narration while iterating |
| **Remotion** (motion graphics) | React/TS -> MP4 via headless Chrome + bundled FFmpeg; `npx remotion render`; agent skills for Claude Code | none locally | **$0 for an individual** (free license covers individuals and orgs up to 3 people). Company: $25/seat/mo, or $0.01/render with $100/mo minimum | Windows x64 supported (no Windows ARM); Remotion 5 license counts contractors | License changes if you form a 4+ person company | **Primary renderer** |
| Remotion Lambda | AWS Lambda | AWS IAM | About $0.017-0.021 per 1-min video (AWS compute only) | Needs AWS account | AWS setup friction | Optional later; local render is enough |
| HyperFrames (HeyGen) | HTML/CSS/GSAP -> MP4 via headless Chrome + FFmpeg; 21 agent skills | none | $0 (Apache-2.0) | Node 22+, FFmpeg; no official Windows docs | New (open-sourced 2026-04-17) | Strong runner-up; prototype one scene to compare |
| Manim Community | Python -> MP4 | none | $0 (MIT) | v0.22.0; LaTeX optional (MiKTeX) | Weak for captions and vertical layout | Use only for math-heavy segments, composited into Remotion |
| Motion Canvas | TS generators | none | $0 (MIT) | Original project reported unmaintained, site offline | Abandoned | Skip |
| Revideo | Motion Canvas fork, headless `renderVideo()` | none | $0 (MIT) | ~4.1k stars, release cadence unclear | Low activity | Skip |
| Captions | Burn in from ElevenLabs character timestamps (group into words) via `@remotion/captions` | - | $0 | - | - | **Use.** Also export `.srt` for YouTube/LinkedIn |
| ElevenLabs Forced Alignment / Scribe v2 | Align text to audio | API key | $0.22 per audio hour | 10 h audio / 675k chars | - | Fallback when audio is edited after TTS |
| Whisper.cpp via `@remotion/install-whisper-cpp` | Local transcription | none | $0 | Docs warn of crashes in some versions | - | Fallback |
| Music: YouTube Audio Library | Download tracks | YouTube account | $0 | Standard-license tracks are for YouTube; CC BY tracks need credit | LinkedIn reuse unclear | YouTube-only cuts |
| Music: ElevenLabs Music | API | API key | $0.15/min; commercial use on Starter+ | YouTube wants disclosure only if AI music is the main focus | Content ID behavior **UNVERIFIED** | **Use** for 60 s beds (~$0.15/short) |
| Music: Epidemic Sound / Artlist | Subscription library | account | Epidemic Creator about $17.99/mo or $119.88/yr; Artlist Social about $9.99-14.99/mo (**UNVERIFIED**, third-party prices) | Channel whitelisting | Cancellation terms | Only if you want a human-composed library |
| AI images (Gemini Nano Banana) | API | API key | $0.034-0.067 per 1K image (batch half price) | - | Inaccurate technical diagrams | Thumbnails/backgrounds only |
| AI video (Veo 3.1) | API | API key | Lite $0.05/s (720p); Fast $0.10/s; Standard $0.40/s | Charged only on success | Expensive, off-brand for technical content | Mostly skip |
| Sora 2 | - | - | - | App closed 2026-04-26; API scheduled to end 2026-09-24 | Discontinued | **Do not use** |

**Bottom line:** ElevenLabs Creator ($22/mo) for a PVC of your own voice, Remotion (free) rendered locally on Windows, captions from TTS timestamps ($0), and an ElevenLabs Music bed (about $0.15). That comes to about **$22/mo fixed + $0.25-0.60 per short**. Two approval gates: one on the script, one on the final MP4. Publishing itself is a third, per-platform confirmation.

---

## 1. ElevenLabs (recommended voice)

### Plans (from the consumer and API pricing pages)
| Plan | $/mo | App credits/mo | API usage included (Multilingual v2/v3/v4 at $0.08/1K) | IVC | PVC | Commercial |
|---|---|---|---|---|---|---|
| Free | 0 | 10,000 | 10k chars | No | No | **No.** Title must credit "elevenlabs.io" or "11.ai" |
| Starter | 6 (about $5 on annual billing) | 30,000 | 75k chars | Yes | No | Yes |
| **Creator** | **22** ($11 first month; about $18.33 on annual) | 121,000 | 275k chars | Yes | **Yes (1)** | Yes |
| Pro | 99 | 600,000 | 1.238M chars | Yes | Yes (1) | Yes |
| Scale | 299 | 1.8M | 3.738M chars | Yes | Yes (3) | Yes |
| Business | 990 | 6M | 12.375M chars | Yes | Yes (10) | Yes |

- Annual billing charges 10 months for the year. App credits are about 1 credit per character on Multilingual v2. The API page says "API usage is billed in US dollars, not credits."
- API per-1K-character rates: **Eleven v4 $0.08**, v4 Turbo $0.04 (third-party), v3 $0.08, Multilingual v2 $0.08, Flash/Turbo $0.04. Scribe v2 STT is $0.22/h, Music $0.15/min, and SFX $0.12/min.
- v4 launched 2026-09-28. Its launch discount ended 2026-10-12, and the older models were reportedly cut 20% at the same time (third-party, **UNVERIFIED**).
- Sources: https://elevenlabs.io/pricing, https://elevenlabs.io/pricing/api, https://www.usagepricing.com/blueprint/activity/elevenlabs-2026-10-05-v4-launch-tts-price-cut, https://www.eesel.ai/blog/eleven-v4-pricing
- Plan-to-number mapping comes from a flattened table on the pricing page. The PVC counts per plan are inferred, so confirm them on the live page before you buy.

### Models (https://elevenlabs.io/docs/overview/models)
- **Eleven v4**: highest quality, 10k chars per request, recommended for narration and voiceover.
- Multilingual v2: "most stable on long-form", 10k chars per request.
- v3: expressive with audio tags, 5k chars.
- Flash v2.5: about 75 ms latency and about half the price, but lower quality. Use it for drafts.
- Turbo v2/v2.5 are deprecated.
- A 60 s short is about 900-1,000 chars, so it fits in one request on any model.

### IVC vs PVC (https://elevenlabs.io/docs/eleven-api/concepts/voice-cloning.mdx)
- **IVC:** under 2 min of audio, no training, available immediately. Quality depends on the reference audio and is less consistent across speaking styles.
- **PVC:** about 30 min of clean audio recommended (more is better), fine-tunes in minutes to hours, noticeably more consistent and more emotional range. Requires **Creator or above**.
- **Consent/verification:** both IVC and PVC use a "voice captcha", where you read a prompt live to prove the voice is yours. A PVC can only be made of **your own voice**. If you fail verification, wait 24 h or ask support@elevenlabs.io to reset attempts. The browser needs microphone permission. Sources: https://elevenlabs.io/docs/help-center/product/voices/voice-cloning/what-can-i-do-if-i-failed-to-verify-my-professional-voice-clone-pvc.md, https://elevenlabs.io/docs/help-center/product/voices/voice-cloning/can-i-create-a-professional-voice-clone-of-someone-elses-voice.md

### Commercial rights
- All paid plans include a commercial license, **except output from Beta services**, which cannot be used commercially.
- The Free plan cannot be used commercially and requires attribution in the title.
- On paid plans, whether attribution is required "is subject to the agreement you have with ElevenLabs". Third parties say no attribution is needed on paid plans (**UNVERIFIED** wording).
- Source: https://elevenlabs.io/docs/help-center/legal/can-i-publish-the-content-i-generate-on-the-platform

### TTS with timestamps (word-level captions)
- Endpoint: `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps`
- Returns `audio_base64`, plus `alignment` and `normalized_alignment` objects. Each holds `characters[]`, `character_start_times_seconds[]` and `character_end_times_seconds[]`.
- **Timing is per character only.** To get words, group characters on whitespace and punctuation: a word's start is its first character's start and its end is its last character's end. This is a few lines of code and costs nothing extra.
- Defaults: `output_format` is `mp3_44100_128` and the model is `eleven_multilingual_v2`. Set `model_id` explicitly.
- Source: https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps
- If the audio is cut or retimed after generation, re-align with **Forced Alignment**, which returns word-level output and is billed at the STT rate of $0.22/h. Sources: https://elevenlabs.io/docs/capabilities/forced-alignment, https://fal.ai/models/fal-ai/elevenlabs/forced-alignment/llms.txt

### "Easy to connect" / MCP
- ElevenLabs runs a **hosted MCP server at `https://api.elevenlabs.io/v1/mcp` with OAuth**. The old local `uvx elevenlabs-mcp` server is deprecated and unmaintained. Source: https://github.com/elevenlabs/elevenlabs-mcp
- With the hosted server, Claude Desktop or Claude Code can make TTS calls without you handling a key. The exact tool list on the hosted server is **UNVERIFIED**.
- For the content-powerhouse pipeline itself, call the REST API directly with a key in `.env`. That keeps timestamps, versioning and caching under our control. Use MCP for ad-hoc work ("regenerate line 3 warmer").
- Guardrail: anything that calls TTS spends credits. Generation (spending) only needs a cost estimate. Publishing stays behind the per-action approval gate.

### Setup steps
1. Subscribe to **Creator**. The first month is $11. Starter does not include PVC.
2. Record 30-60 min of clean narration in a quiet room with a decent USB/XLR mic, at the same distance and energy you will use in shorts. Reading your own blog posts aloud works well.
3. Go to Voices -> Add voice -> Professional Voice Clone, upload the audio, and pass the voice captcha. Wait for fine-tuning to finish.
4. Copy the `voice_id`. Create an API key, ideally scoped or quota-limited (per-key limits are **UNVERIFIED**).
5. Test with v4 and Multilingual v2 on the same script and pick by ear. Lock `stability`, `similarity_boost` and `style` per voice in config.

---

## 2. Voice alternatives

| Option | Price | Cloning | Timestamps | Notes / source |
|---|---|---|---|---|
| **Cartesia** | Free $0 (20K credits, no IVC); **Pro $5** (100K, IVC); Startup $49 (1.25M, 2 PVC); Scale $299 (8M, 4 PVC). Overage $65 -> $38 per 1M credits | IVC from Pro, PVC from Startup | Word timestamps reportedly supported (**UNVERIFIED**) | https://cartesia.ai/pricing. Credits are about 1 per character, and PVC speech costs 1 credit per character |
| **PlayHT / PlayAI** | - | - | - | Acquired by Meta in July 2025. The API reportedly stopped in July 2025 and the service ended 2025-12-31 (secondary sources: https://anyspeech.io/playht-alternatives, https://elevenlabs.io/blog/playht-alternatives-2026). **Dead** |
| OpenAI TTS | tts-1 $15/1M chars; tts-1-hd $30/1M; gpt-4o-mini-tts $0.60/1M text in + $12/1M audio out | No self-serve cloning (**UNVERIFIED**) | No | https://developers.openai.com/api/docs/pricing |
| Gemini TTS | 3.8 Flash TTS $0.50 in / $9 out per 1M tokens (doubles 2027-01-01); Flash-Lite $0.50 / $6 | No | No | https://ai.google.dev/gemini-api/docs/pricing |
| Fish Audio | API $15 per 1M UTF-8 bytes (about 12 h of speech); Plus $20/mo, Pro $150/mo | Yes, including on the free tier (commercial rights only on paid) | **UNVERIFIED** | https://docs.fish.audio/docs/models-pricing/pricing-and-rate-limits |
| Chatterbox (local) | $0, MIT | Zero-shot clone from one clip | No (pair with Whisper/forced alignment) | https://huggingface.co/ResembleAI/chatterbox. Needs a GPU in practice; Windows setup **UNVERIFIED** |
| Kokoro (local) | $0, Apache-2.0 | None (54 presets) | No | Runs on CPU; on Windows it needs espeak-ng. https://www.nuget.org/packages/KokoroSharp |

**Verdict:** ElevenLabs has the best mix of own-voice quality, built-in timestamps, an official hosted MCP and clear commercial terms. Cartesia Pro at $5 is the cheapest paid fallback with a clone. Use Kokoro for free scratch audio while iterating on visuals.

---

## 3. Motion graphics renderer

Requirements: code-driven technical explainers (latency-vs-utilization curve, queueing knee, latency histograms/percentiles, coordinated-omission timeline, fan-out tail amplification), 1080x1920, headless rendering on Windows 11, drivable by Claude Code.

### Remotion (recommended)
- **License:** free for individuals, for-profit orgs of **up to 3 people**, non-profits, and evaluation. That covers the owner.
- **Company license** (needed at 4+ people):
  - "Creators": $25/seat/mo, no minimum.
  - "Automators": $0.01/render, billed in 1,000-render blocks, $100/mo minimum.
  - Enterprise: from $500/mo.
  - The **Remotion 5 terms** (taking effect with 5.0, not yet released) also count contractors toward team size.
  - Sources: https://www.remotion.dev/terms, https://github.com/remotion-dev/remotion/blob/main/LICENSE.md, https://remotion.dev/docs/5-0-migration
- **Windows:** supports Windows x64 (also macOS x64/arm64 and Linux). Windows ARM is not listed. Bundled FFmpeg includes NVENC on Windows x64 when an NVIDIA GPU is present. Sources: https://www.remotion.dev/docs/4-0-migration, https://www.remotion.dev/docs/hardware-acceleration
- **Why it fits:**
  - React/TS, so charts can be SVG built with d3-scale/d3-shape.
  - Frame-exact `interpolate()`/`spring()`, so it is deterministic.
  - `@remotion/captions` provides `createTikTokStyleCaptions()` for word-highlight captions.
  - Remotion Studio gives a live preview.
  - CLI: `npx remotion render <comp> out.mp4 --props=...`.
  - Official **agent skills** for Claude Code: `npx skills add remotion-dev/skills` or `npx remotion skills add`. Sources: https://www.remotion.dev/docs/ai/skills, https://www.remotion.dev/docs/cli/skills
  - Official TikTok-style template with Whisper.cpp captions: https://github.com/remotion-dev/template-tiktok
- **Render cost/time:**
  - Local cost is $0.
  - Local time for 60 s at 30 fps (1,800 frames) on a modern 8-core desktop is roughly 1-4 min (**UNVERIFIED** estimate; measure it).
  - **Remotion Lambda** example (2048 MB, us-east-1): a 1-min video costs about $0.017 warm / $0.021 cold in about 16-19 s; a 10-min HD video costs about $0.10. That covers AWS compute only, with S3/egress extra. https://www.remotion.dev/docs/lambda/cost-example
- **Setup:**
  1. Install Node LTS.
  2. Run `npx create-video@latest` (blank or TikTok template) inside `content-powerhouse/video/`.
  3. Run `npx remotion skills add`.
  4. Build components: `LatencyUtilizationCurve`, `QueueKnee`, `PercentileHistogram`, `CoordinatedOmissionTimeline`, `FanOutTail`, `TitleCard`, `CaptionTrack`.
  5. Drive them with a JSON scene plan.

### HyperFrames (HeyGen) - runner-up
- Apache-2.0, open-sourced 2026-04-17. Renders HTML/CSS plus GSAP/Lottie/Three.js/Anime.js/WAAPI to deterministic MP4 with headless Chrome and FFmpeg.
- Needs Node 22+ and FFmpeg. CLI: `npx hyperframes init|preview|render|lint|doctor`.
- Ships 21 agent skills (`npx skills add heygen-com/hyperframes`), including embedded captions and TTS media skills. Also offers AWS Lambda rendering.
- The repo shows about 67k stars. That is high for a 6-month-old repo, so treat popularity as **UNVERIFIED**.
- **No official Windows docs.** A third-party Windows guide says the usual failure is PATH problems with node/ffmpeg.
- Pros: no license ceiling ever, and plain HTML is very LLM-friendly.
- Cons: new, so its APIs may churn.
- Sources: https://github.com/heygen-com/hyperframes, https://autoae.online/blog/hyperframes-topic2video-windows-setup
- **Recommendation:** spend 1 hour building the same "queueing knee" scene in both and keep Remotion unless HyperFrames is clearly easier for Claude to author.

### Manim Community
- MIT, v0.22.0. On Windows: `uv add manim`; it may need MSVC Build Tools. LaTeX (MiKTeX) is optional and only needed for formulas.
- Excellent for mathematical curves and equations (for example ρ/(1-ρ) blowing up).
- Weak for kinetic captions, branding and vertical layout.
- Use it only to pre-render a math clip and import it into Remotion with `<OffthreadVideo>`.
- Sources: https://docs.manim.community/en/stable/installation/uv.html, https://github.com/ManimCommunity/manim

### Motion Canvas / Revideo
- Motion Canvas is reported unmaintained, with motioncanvas.io offline. A community fork, Canvas Commons, exists.
- Revideo (MIT, about 4.1k stars) has headless `renderVideo()`, but its release cadence is unclear.
- **Skip both.**
- Sources: https://docs.re.video/, https://github.com/redotvideo/revideo, https://www.pkgpulse.com/guides/remotion-vs-motion-canvas-vs-revideo-programmatic-video-2026

---

## 4. Generated visuals

- **Diagrams from MDX:** the site's custom diagram components live in the read-only site repo, so do **not** import them. Instead, have Claude extract the data and intent (the axes, the knee point, the percentiles) from the MDX into the scene-plan JSON, and re-implement each one as a Remotion component. They then animate natively, which a static SVG cannot do. For flowchart-type diagrams, rendering Mermaid to SVG with `@mermaid-js/mermaid-cli` and animating it with stroke-dash reveals is a cheap path (approach **UNVERIFIED** for quality).
- **Charts:** generate data in code, for example M/M/1 latency = S/(1-ρ), synthetic lognormal latency distributions, and the percentile of max across N fan-out calls. The charts are then numerically correct, which matters for credibility with an engineering audience.
- **AI images** (Gemini): Nano Banana 2.1 is $0.0336 per 1K image ($0.0168 batch); Gemini 3.1 Flash Image is $0.067 per 1K; Nano Banana Pro is $0.134. Use them for thumbnails or abstract backgrounds only, not technical diagrams. https://ai.google.dev/gemini-api/docs/pricing
- **AI video:**
  - Veo 3.1 Lite: $0.05/s at 720p, $0.08/s at 1080p.
  - Veo 3.1 Fast: $0.10-0.12/s.
  - Veo 3.1 Standard: $0.40/s.
  - Billed only on success. https://ai.google.dev/gemini-api/docs/pricing
  - fal.ai resellers: FLUX schnell about $0.003/MP, FLUX dev about $0.025/MP, Kling about $0.07-0.11/s (third-party, **UNVERIFIED**). https://fal.ai/pricing
  - A 5 s B-roll clip costs about $0.25-0.60. It is rarely worth it for this niche, and it raises the YouTube disclosure and "inauthentic content" risk.
- **Sora 2:** OpenAI announced discontinuation on 2026-03-24. The app closed on 2026-04-26 and the API was scheduled to end on 2026-09-24. https://the-decoder.com/openai-sets-two-stage-sora-shutdown-with-app-closing-april-2026-and-api-following-in-september/ **Do not build on it.**

---

## 5. Captions and burned-in subtitles

- **Primary:** ElevenLabs character timestamps, grouped into words and saved as `words.json` (`[{text,startMs,endMs}]`, which is Remotion's `Caption` type). From there:
  - `createTikTokStyleCaptions()` produces pages of 2-4 words with the active word highlighted.
  - The captions are burned into the MP4.
  - Also write `captions.srt`. Upload it as a separate caption track on YouTube (accessibility and SEO) and on LinkedIn, where most video is watched muted.
- Because the text is the script, the captions have no transcription errors. Technical terms such as "p99", "M/M/1" and "ρ" render correctly.
- **Fallbacks:** ElevenLabs Forced Alignment ($0.22/h), or local Whisper.cpp through `@remotion/install-whisper-cpp` with `toCaptions()`. Use `tokenLevelTimestamps: true` and combine tokens within about 200 ms; the docs warn some Whisper.cpp versions crash. Sources: https://www.remotion.dev/docs/captions/transcribing, https://www.remotion.dev/docs/install-whisper-cpp/convert-to-captions
- **Safe area:** keep captions in the vertical middle third. The bottom roughly 20% and the right edge are covered by Shorts and LinkedIn UI.

---

## 6. Background music licensing

| Source | Cost | Scope | Notes |
|---|---|---|---|
| YouTube Audio Library | $0 | Standard-license tracks: YouTube; reuse elsewhere unclear. CC BY 4.0 tracks: anywhere, with a credit in the description | Content ID "won't be claimed" does not carry over to LinkedIn. https://www.socialpilot.co/youtube-marketing/youtube-audio-library |
| **ElevenLabs Music** | $0.15/min API | Commercial use on Starter+ | About $0.15 per short. Generate one unique ambient bed per short. Model terms: https://elevenlabs.io/eleven-music-model-specific-terms. Content ID behavior **UNVERIFIED** |
| Epidemic Sound | Creator about $17.99/mo or $119.88/yr (third-party, **UNVERIFIED**) | Channel-cleared, unlimited use | Ads need Pro. https://www.epidemicsound.com/pricing/ |
| Artlist | Social about $9.99/mo annual or $14.99 monthly (third-party, **UNVERIFIED**) | Social platforms | https://photutorial.com/artlist-vs-epidemic-sound |

Recommendation: an ElevenLabs Music bed, or no music at all. Technical explainers often work better with voice plus subtle SFX. Duck the music to about -24 LUFS under the voice. Avoid any library that needs per-channel whitelisting, since the same file goes to both YouTube and LinkedIn.

---

## 7. Platform policy notes

- **YouTube disclosure:** cloning **your own voice** for voiceovers is listed as a minor edit that needs **no** disclosure. Animation, captions and AI-assisted scripting also need none. Disclosure is required for realistic synthetic people, events or places, and for AI music that is the main focus of a video. https://support.google.com/youtube/answer/14328491
- **YouTube "inauthentic content":** the "repetitious content" policy was renamed on 2025-07-15. It targets mass-produced, templated output with little human input, not faceless or AI-voiced videos as such. Mitigations: original analysis, a distinct visual per short, a human-reviewed script, and avoiding identical templates. Further 2026 changes (a July 2026 clarification, an Aug 2026 YPP threshold change) are **UNVERIFIED**. https://air.io/en/monetization/youtube-monetization-policy-changes-2026-a-complete-dated-timeline
- **Shorts specs:** 9:16 (square also allowed), up to **3 minutes** since Oct 2024 (third-party: https://1of10.com/blog/how-long-can-youtube-shorts-be/). Target 45-60 s.
- **LinkedIn video:** MP4 H.264/AAC, 9:16 1080x1920 accepted, 3 s to 15 min on desktop, up to 5 GB (keep under 200 MB) (third-party: https://ligosocial.com/blog/linkedin-video-post-best-practices). Render one master file for both platforms.

---

## 8. Proposed pipeline

```
content/posts/<slug>.mdx  (read-only source, canonical URL)
  │
  ├─1. EXTRACT  (Claude)       -> brief.json: thesis, 3-5 key ideas, numbers, which diagrams
  ├─2. SCRIPT   (Claude)       -> script.json: hook (≤2 s), 4-6 beats, CTA "full deep dive at example-blog.dev"
  │                               ~130-160 words / ≤1,000 chars; each beat names a scene component + props
  │        ⛔ GATE A: user approves script text (cheap to change here)
  ├─3. VOICE    (ElevenLabs PVC, /with-timestamps, one call per beat or one call total)
  │                             -> audio/beat-N.mp3 + alignment -> words.json (char->word grouping)
  │                               cache by hash(text+voice+model+settings) so re-runs cost $0
  ├─4. SCENE PLAN (Claude)     -> scenes.json: durations snapped to beat audio lengths, component props
  ├─5. MUSIC    (ElevenLabs Music 60 s bed, optional; or none)
  ├─6. RENDER   (Remotion local: npx remotion render Short out/<slug>.mp4 --props=scenes.json)
  │                               1080x1920, 30 fps, H.264 CRF ~18, AAC 48 kHz; also out/<slug>.srt
  ├─7. QC (automatic)          duration ≤60 s, loudness ~-14 LUFS, captions inside safe area, no clipped text
  │        ⛔ GATE B: user watches MP4, approves or requests edits (edit script/scene -> re-run 3-6)
  └─8. PUBLISH (handled by the distribution agents) -> draft/unlisted upload, then
           ⛔ GATE C: explicit per-platform confirmation before anything goes public
```

The content-powerhouse MCP tools Claude would call are `video.plan(slug)`, `video.voice(slug)`, `video.render(slug)` and `video.preview(slug)`. There is deliberately **no** `publish` tool in the video module; publishing lives behind the shared approval gate.

### First short: draft beat plan (first launch article)
1. **Hook:** "Your server is 80% busy. Why are users waiting 5x longer?" (`QueueKnee`, utilization slider 0 -> 95%)
2. **Latency vs utilization:** S/(1-ρ) curve with the knee highlighted (`LatencyUtilizationCurve`)
3. **Averages lie:** histogram with p50/p99/p99.9 markers (`PercentileHistogram`)
4. **Coordinated omission:** load generator pauses, so missing samples hide the stall (`CoordinatedOmissionTimeline`)
5. **Fan-out:** 1 request -> 100 backends, so P(hit a p99) is about 63% (`FanOutTail`)
6. **CTA:** title card plus URL

### Cost per short (assumes 1,000-char script, 3 full regenerations, 60 s)
| Item | Cost |
|---|---|
| Claude script/plan | $0 marginal on the existing Claude subscription (API pricing in the LLM report) |
| ElevenLabs TTS v4 / Multilingual v2 (3,000 chars at $0.08/1K) | $0.24 (inside the Creator plan's included usage) |
| Draft takes on Flash ($0.04/1K) or Kokoro | $0.00-0.04 |
| Word timing | $0 (from TTS alignment); fallback alignment under $0.01 |
| Music bed (ElevenLabs Music 1 min) | $0.15 (optional) |
| Render (Remotion local, individual license) | $0 (Lambda alternative about $0.02) |
| AI image for thumbnail (optional) | $0.03-0.07 |
| **Marginal total** | **about $0.25-0.60** |
| **Fixed** | ElevenLabs Creator $22/mo (the first month is $11). Creator's included usage covers roughly 90 shorts per month |

At 8 shorts per month the all-in cost is about $3 per short, nearly all of it the subscription. Long-form later: a 10-min video is about 9,000 chars, roughly $0.72 per take, so stay on Creator until you exceed about 275k chars per month.

---

## Pricing summary

| Item | Price | Source |
|---|---|---|
| ElevenLabs Starter / Creator / Pro | $6 / $22 (first month $11) / $99 per month | https://elevenlabs.io/pricing |
| ElevenLabs API TTS v4, v3, Multilingual v2 | $0.08 per 1K chars | https://elevenlabs.io/pricing/api |
| ElevenLabs API Flash | $0.04 per 1K chars | same |
| ElevenLabs Scribe v2 / Forced Alignment | $0.22 per audio hour | same; https://elevenlabs.io/docs/capabilities/forced-alignment |
| ElevenLabs Music / SFX | $0.15/min / $0.12/min | https://elevenlabs.io/pricing/api |
| Cartesia Pro / Startup | $5 / $49 per month | https://cartesia.ai/pricing |
| OpenAI tts-1 / tts-1-hd | $15 / $30 per 1M chars | https://developers.openai.com/api/docs/pricing |
| Fish Audio API | $15 per 1M UTF-8 bytes | https://docs.fish.audio/docs/models-pricing/pricing-and-rate-limits |
| Chatterbox / Kokoro / Manim / HyperFrames / Revideo | $0 (open source) | repos above |
| Remotion (individual) | $0 | https://www.remotion.dev/terms |
| Remotion company | $25/seat/mo, or $0.01/render with $100/mo minimum; Enterprise from $500/mo | same |
| Remotion Lambda (AWS) | about $0.02 per 1-min render | https://www.remotion.dev/docs/lambda/cost-example |
| Veo 3.1 Lite / Fast / Standard | $0.05-0.08 / $0.10-0.30 / $0.40-0.60 per second | https://ai.google.dev/gemini-api/docs/pricing |
| Gemini image (Nano Banana 2.1) | $0.0336 per 1K image | same |
| Epidemic Sound Creator | about $17.99/mo (**UNVERIFIED**) | https://recurdash.com/subscription-pricing/epidemic-sound |

**Recommended stack total:** $22/mo fixed plus about $0.25-0.60 per short. The cheapest viable setup is Cartesia Pro at $5/mo with IVC, or a fully local Kokoro/Chatterbox + Remotion stack at $0.

---

## Open risks

1. **Price volatility:** ElevenLabs re-priced on 2026-09-28 (v4) and the API/app plan tables are formatted differently. Re-check https://elevenlabs.io/pricing before subscribing. The PVC count per plan is inferred from the table layout.
2. **Voice-clone security:** anyone with the API key can make "you" say anything. Keep the key in `.env` or the OS credential store, never commit it, use per-key quotas if available (**UNVERIFIED**), and rotate it if leaked. Prefer the hosted OAuth MCP for interactive use.
3. **PVC effort:** 30+ min of clean audio plus live verification. Poor recordings give a poor clone. Budget an afternoon.
4. **Remotion licensing drift:** free only while you are an individual or an org of 3 or fewer. Remotion 5 counts contractors. HyperFrames (Apache-2.0) is the escape hatch.
5. **HyperFrames maturity:** about 6 months old, no official Windows docs, popularity numbers unverified.
6. **Windows rendering:** Remotion supports Windows x64 only, not ARM. NVENC needs an NVIDIA GPU. Long paths with spaces (`<projects>\...`) can break CLI tooling, so quote paths and test early.
7. **YouTube monetization policy:** the "inauthentic content" enforcement on templated faceless channels is vaguely defined. Keep each short substantively original and human-reviewed. Own-voice cloning needs no disclosure.
8. **Music rights across platforms:** YouTube Audio Library clearance does not carry over to LinkedIn. ElevenLabs Music Content ID behavior is **UNVERIFIED**.
9. **Discontinued vendors:** PlayHT (Dec 2025) and Sora (API Sept 2026) show that AI media vendors disappear. Keep the TTS provider behind an interface (`speak(text) -> {audio, words[]}`) so ElevenLabs, Cartesia and Kokoro can be swapped.
10. **Caption accuracy for symbols:** ρ, p99.9 and M/M/1 can be read aloud oddly by TTS. Keep a separate `spoken` text ("rho", "p ninety-nine point nine") and `display` text per beat, and map the alignment back to the display tokens.
11. **Unverified items:** OpenAI cloning availability, Cartesia timestamps, Fish Audio s2 pricing, Artlist/Epidemic prices, local render times, and the hosted ElevenLabs MCP tool list.
