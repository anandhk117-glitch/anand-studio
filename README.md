# Anand's YouTube Studio

One website for all four channels — Putani Loka Kids (Kannada), Bumbu Ki Duniya (Hindi), Sparkle Kids Planet (English) and Legends Decoded (documentary). It runs on your PC, opens in your browser at **http://localhost:4600**, and takes each video from research to a finished, upload-ready package.

## How the work flows

Kids songs (Putani, Bumbu, Sparkle):

| # | Layer | Agent | How it works |
|---|---|---|---|
| 1 | Research | Research agent | Scans YouTube (your API key) + writes **4 ideas** with why they can go viral. You pick one. |
| 2 | Song | Songwriter | Lyrics with section tags, Suno style (≤200 chars), title. You edit and approve. |
| 3 | Music | Music producer | Suno in your browser (Claude Code can drive it) or free ACE-Step. Drop both versions in. |
| 4 | Pick | Music analyst | ffmpeg measures both versions and scores them. You listen and pick. |
| 5 | Timeline | Timeline mapper | Times every line and cuts the song into 5–10 s scenes. Paste real Suno timestamps for exact timing. |
| 6 | Images | Visual director | One prompt per scene with locked characters → Google Flow (Claude Code), Hugging Face (free) or upload. |
| 7 | Videos | Motion director | Motion prompts → **Wan 3.0 API (automatic)**, or Grok → Kling → Hailuo → Seedance on Dola (Claude Code in your browser), or upload. Missing clips can use a slow zoom on the image. |
| 8 | Edit | Editor | ffmpeg: intro + scenes + music + logo + lyrics + optional subscribe pop-ups + outro → `final.mp4` + `captions.srt`. |
| 9 | Publish | Publisher | Titles, bilingual description with chapters, tags, thumbnail idea, 3 Shorts, YouTube checklist. |

Legends Decoded uses the documentary line: research → script → narration → timeline → images → videos → edit → publish.

**Writing agents** (research, song, script, prompts, publish) run two ways — pick per job:
- **Free AI** — FreeLLMAPI on your PC pools free tiers from many providers (free tokens).
- **Send to Claude Code** — better quality, and the only way for browser jobs (Suno, Flow, Grok). Requests wait in the Studio until Claude Code does them.

## Setup (once)

1. **Install Node.js** (needed): `winget install OpenJS.NodeJS.LTS`. You already have ffmpeg.
2. **Put this folder somewhere fast**, e.g. `C:\putaniloka-tools\studio` (not inside OneDrive).
3. **Double-click `Start Everything.bat`** (starts FreeLLMAPI + the Studio and opens the browser). If Windows blocks a .bat that came from the internet: right-click → Properties → Unblock, or run `node server\server.js` in PowerShell from this folder. Keep the black window open.
4. **GitHub (memory backup)** — create an empty *private* repo called `youtube-studio` on github.com, then in this folder:
   ```
   git init
   git add -A
   git commit -m "Studio first version"
   git branch -M main
   git remote add origin https://github.com/<your-username>/youtube-studio.git
   git push -u origin main
   ```
   After that, the **Save to GitHub** button does it for you. Media, keys and settings never go to GitHub (see `.gitignore`).
5. **Free AI** — install FreeLLMAPI (Studio → *Free apps & repos* has the steps), add your free provider keys, paste its unified key in **Settings**.
6. **Wan 3.0 (automatic scene clips)** — Alibaba Cloud → Model Studio (Singapore/international) → turn ON **Free Quota Only** for the Wan model → create an API key → Studio Settings → Wan 3.0. The Videos stage then makes every clip by itself.
7. **YouTube API key** — Settings → paste your key. Then on each channel: *Niche research → Scan YouTube now* and *Refresh channel stats*. Check the channel handles in `config/channels/*.json` first.
8. **Brand kit** — on each channel page, add intro.mp4, outro.mp4, logo.png, subscribe.png and character sheets.
9. **Claude Code** — open Claude Code in this folder and say *"do the open requests"*. It reads `CLAUDE.md` and works through the list.

## Memory layers

| Layer | File | Who writes it |
|---|---|---|
| Rules | `memory/<channel>/rules.md` | You (Memory tab) |
| Lessons | `memory/<channel>/lessons.md` | You and Claude Code (`node tools/agent.js lesson …`) |
| Decisions | `memory/<channel>/decisions.md` | The Studio, every time you approve or pick |
| Live state | `data/projects/<id>/project.json` | The Studio and agents |
| Performance | `data/stats/<channel>.json` | YouTube stats refresh |
| History | git | Save to GitHub |

Every writing agent reads Rules + Lessons + recent Decisions before it starts.

## Folders

```
server/    the backend (Node, no packages to install)
web/       the website
config/    one file per channel: language, cast, style, Suno style, research keywords, edit defaults
memory/    the memory layers
brand/     intro, outro, logo, subscribe pop-up, character sheets per channel
apps/      the whitelist of free apps and repos
tools/     agent.js — the command line Claude Code uses
data/      projects (audio, images, clips, final video), queue, stats, your settings
```

## Good to know
- Everything runs on this PC; nothing is uploaded anywhere except your GitHub pushes and the AI/YouTube calls you set up.
- Timeline times are estimates until you correct them or paste real timestamps. Your corrections are final.
- Subscribe pop-ups are off for Putani (channel rule: no subscribe asks on Made for Kids). Turn on per video in the Edit stage if you change that rule.
- To add a channel: copy a file in `config/channels/`, change it, and add `memory/<id>/rules.md`.
- Port: 4600. Change with `set STUDIO_PORT=…` before starting.

## Scene length
Each channel's `scene_len` (in `config/channels/*.json`) sets how long scenes are. Kids channels use 3.5–6 s because Grok/Vibes clips are about 5 s. If a clip is shorter than its scene, the editor slows it a little or plays it forward-then-back — it never freezes.

## Testing
`node tools/_real_run.js "<a finished song folder>"` runs an existing song (song_package.md, final_song.mp3, lyrics_timeline.json, 04_images, 05_videos) through every stage using copies of its files. Your originals are never changed.

## Autopilot (agents work on their own)
- Turn it on/off on the Home page or in Settings. With it on, every 30 s the agents start the next job that needs no decision from you: writing, prompts, Claude Code browser jobs, Wan clips, the edit, thumbnail and Shorts.
- It always stops for you at: picking the idea, approving the song/script, picking the music version, approving the timeline, approving the final video, and marking it ready to upload.
- Claude Code runs one request at a time, at most `claude_daily_cap` per day (Settings). If it gets blocked it writes why, and the request shows as blocked in Requests with a "Try again" button.
- Schedule: daily 6 AM YouTube scan (needs the YouTube key), Monday 7 AM fresh ideas for every channel, Sunday 8 AM Scout.

## Start with Windows
Settings → Start with Windows → Turn on. It adds one file, `Anand Studio.vbs`, to your Startup folder. That runs `tools/supervisor.js` quietly, which keeps FreeLLMAPI and the Studio running and restarts them if they stop. Logs: `data/logs/`. Turn off the same way, or delete that file.

## Scout
Every Sunday (or "Look now" on Free apps & repos → Scout finds) it searches GitHub for active free projects in each layer and checks FreeLLMAPI for new free models. The free AI rates each find for your PC (no GPU). Nothing installs by itself — mark "I'll try it", then "It works — keep" or "Not useful".

## Free AI providers
See Free apps & repos → Free AI providers for a ranked list (Google AI Studio and Groq first). Add keys in FreeLLMAPI → Keys.

## How the work is split now (Oct 2026)
- **You:** pick the topic (one tap). In "topic only" mode that is your only decision.
- **Claude Code (your plan):** only the Suno song — it makes 2 versions and drops them in. Settings → "Stages Claude Code may do" (default: music).
- **Brain (free):** Gemini on AI Studio's free tier, then FreeLLMAPI's free models. Writes everything and checks its own work (song/package scored out of 10; under 7 → one rewrite → still weak → it stops and pings you).
- **Images:** free Hugging Face FLUX Spaces (needs a free HF token) → HF inference → you.
- **Clips:** Wan 3.0 free quota → free Hugging Face Wan/LTX Spaces → slow zoom on the image.
- **Narration (Legends):** Gemini voice on your Google credit.
- **Not used by default (to save credit):** Gemini images, Veo. Turn them on in Free apps & repos → Layer order.
- Add new free Spaces in `config/hf_spaces.json`. See a Space's inputs with `node tools/probe_space.js owner/space-name`.
