# Lessons learned — Putani Loka
(The agents read this before every job. Add a line whenever something goes wrong or right.)

- Traditional canon songs get far more views than original compositions; titles must match what parents search.
- Kannada karaoke subtitles: keep letter spacing at 0 or the Kannada letters break apart.
- Google Flow images carry a small sparkle mark bottom-right — remove it before editing (tools/erase_mark.ps1).
- New Grok clips (736×400) carry a "Grok" mark bottom-right at x=660 y=362 w=70 h=30.
- Once Anand corrects a timeline, never re-estimate it — his times are final.
- 2026-10-13: Grok/Vibes clips are about 5 s long, so scenes are kept 3.5-6 s (config scene_len). Longer scenes get the clip slowed or played forward-and-back, never frozen.

- 2026-10-21 Gowri Cow: lyrics, captions and scenes drifted up to 9 s because the timeline was an even-spread ESTIMATE. Rule: lyric times are always HEARD from the song (Timeline mapper listens in 30-second pieces) before scenes are planned; never approve an estimated timeline.
- 2026-10-21 Clips that barely move (motion under 1.4) look like a still picture with a wobble. The clip checker now rejects them and asks for livelier motion; one scene = one clip (max 5.8 s), no zoomed fillers; video is 24 fps and 16 fps clips get real in-between frames.

- 2026-10-22 Editor upgrade (kids style): 3-second hook first (the story peak clip + big curiosity words + whoosh), brand intro shortened so the song still starts at the same time; white-flash + whoosh on every new song section; slow sideways camera drift on every shot; echo words pop up big in colour with a soft pop sound; brighter kids colour grade; karaoke line at the bottom. Turn any of these off in the edit options: hook, transitions, camera, popwords, sfx.

- 2026-10-24 Why kids repeated the same move: spare takes made for one line were reused for other lines of the same picture. Now spares are only reused for the SAME action. Every next shot must show a new action that moves the story on.
- 2026-10-24 Calm or instrumental parts use continuous shots: the next clip starts from the last frame of the previous clip (no cut), 2-3 clips = one smooth 10-15 s shot. Motion is slow, smooth and cinematic; fast moves only in the chorus dance.
- 2026-10-24 Ending: the song plays to its last note, then Anand's outro (brand/putani/outro.mp4) full screen. No HyperFrames end card.
- 2026-10-25: Kaggle free T4 (15 GB) could not run Wan 2.2 TI2V-5B in diffusers even with fp8 weights, fp16, cpu offload, VAE tiling and sizes down to 512x288x49 - out of GPU memory every time (4 runs, 25 Oct 2026). kaggle_wan switched off in layers; clips come from the browser tools.
- 2026-10-26: Anand (26 Oct): full motion only - no still pictures in any kids video, ever. Songs may be 3:00-3:30. The free clip tools go to one song at a time (the one closest to finished) so one full video is finished each day, rotating channels. Calm continuous shots use one 10 s clip for two scenes on Dola/Dreamina.
- 2026-10-27 · Anand compared the website video (Gowri, 13 pictures for 39 scenes, 24 fps, flat eye-level shots, some animals with extra legs) with the hand-made Hallu Ujju (40 pictures, one per scene, drone/close-up/top-down/POV angles, anatomy lock lines, 30 fps). Rule now: one picture per scene, camera menu, anatomy lock, 30 fps.
