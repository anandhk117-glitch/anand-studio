# CINEMATOGRAPHY GUIDE — Putani Lokha (use for EVERY song)

Anand's standard (27 Sep 2026): every video should look like a feature-film cinematographer shot it. Strong camera work, exact counting, locked characters, locations and sizes, correct anatomy, good transitions.
Stage 5 (shot plan) must use this file. Stage 6 must build the reference sheets in §2 before any scene image.

---

## 1. Prompt blocks (same order in every image prompt)
1. **STYLE** (same sentence every scene; §6).
2. **SHOT**: shot size + camera angle + lens + camera position ("camera inside…").
3. **SUBJECT & ACTION**: who, doing what, facial expression, eyes looking where. Name each character and repeat their fixed outfit line (§3).
4. **LOCATION LOCK**: the location's fixed description (§4) + time of day.
5. **LIGHT**: key light direction, quality, colour (golden hour / soft morning / dappled green / warm lamp).
6. **COMPOSITION**: rule of thirds, foreground element (depth), lead lines, headroom, where the empty space is.
7. **FILM & RENDER**: lens character (anamorphic flare, bokeh), depth of field, film grain off, subsurface skin, soft global illumination.
8. **EXACT OBJECTS**: counts written as numbers AND words ("exactly 8 (eight) bananas"), each object's place.
9. **AVOID**: extra limbs/fingers/toes, extra or missing legs or tails, duplicate characters, text/letters/logos, photoreal humans, scary faces.
10. **16:9**.

Motion prompt (Grok) order: camera move + speed → character action (one clear verb) → secondary motion (leaves, dust, hair, ears) → speed feel (slow motion / real time) → "Keep faces, outfits, body proportions and number of legs exactly the same. No new characters. No text."

## 2. Reference sheets (make BEFORE any scene image)
| Sheet | Contents |
|---|---|
| **Character 360 turnaround** (one per character) | front, 3/4, side, back, plus 3 expressions (happy, surprised, sad) on a plain warm-cream background, full body, same scale, soft studio light. |
| **Height lineup** | every character in the song standing side by side on one ground line, with a light height-grid background → locks relative sizes. |
| **Location sheet** (one per location) | wide establishing view + 2 angles, no characters, the exact props that recur (window, plate, tree…). |
| **Prop sheet** (when counting) | the counted object in exact numbers (e.g. a brass plate with exactly 10 bananas, top view + side view). |
Upload the matching sheets as ingredients for every scene. Never let Flow invent a new design.

## 2b. Director's check before accepting ANY image (Anand, 27 Sep 2026)
1. Every character appears exactly ONCE: count them and name each one (no two Rajus, nobody missing, no extra kids).
2. Where is the camera, and does it match the lyric and the story beat? ("waking up" = inside the room, not the courtyard.)
3. Story props read clearly: a trunk must look like Aane's trunk (wrinkles, nostrils, ear or tusk peeking in), not a tail. Clues connect to the later reveal.
4. Counts are exact (bananas, animals), sizes are locked, anatomy is correct.
5. Continuity with the scenes before and after (time of day, where objects are, screen direction).
If any check fails, redo it. Never pass it on to video.

## 3. Anatomy & size locks (write into prompts)
- Kids: 2 arms, 2 legs, **5 fingers** per hand, 5 toes, proportional child bodies (head ≈ 1/4 of height).
- Aane (elephant mascot, baby): **4 legs, walks on all four legs**, 1 trunk, 2 small tusks, 2 big pink-lined ears, 1 thin tail with tuft, gold anklets. Shoulder height ≈ 1.3 × a kid. The kids' heads reach Aane's eye.
- Cow (Hasu Amma): 4 legs, 2 curved horns, 1 tail, brass bell. Shoulder ≈ 1.1 × kid.
- Calf (Karu): 4 legs, tiny horn nubs, 1 tail. Shoulder ≈ kid's waist.
- Puppy: 4 legs, 1 tail, knee-high to a kid.
- Monkey: 2 arms, 2 legs, 1 long tail; sitting height ≈ kid's knee; standing ≈ kid's waist.
- Parrot: 2 wings, 2 feet (zygodactyl), red hooked beak; fits on a kid's hand.
- Check every generated image for these BEFORE downloading. Wrong count = reject.

## 4. Location lock
Write one fixed paragraph per location (roof, walls, doors, trees, props, where the sun is) and paste it word-for-word. Keep the screen direction: once the house is on the left of the grove, it stays on the left (180° rule).

## 5. Camera menu (vary every 5–10 s; never 2 identical framings in a row)
| Shot | Use it for | Prompt words |
|---|---|---|
| Drone establishing / crane | opening, section changes, finale | "high aerial drone shot, slow descent / crane up and back" |
| Tracking (Steadicam) | kids running, following a trail | "low tracking shot following behind at child height, smooth Steadicam" |
| Low angle | heroes, big reveals, tall animals | "low-angle hero shot from ground level, looking up" |
| Top-down (overhead) | counting objects, patterns, circles of kids | "straight top-down overhead shot" |
| Extreme close-up | eyes, a banana peel, a bite, a tear | "extreme close-up macro, shallow depth of field" |
| Close-up slow motion | splash, hair flip, jump, reunion | "close-up, high-speed slow motion 120fps" |
| Dolly zoom (vertigo) | shock / realisation | "dolly zoom: camera pulls back while lens zooms in, background stretches" |
| Camera inside something | fun POV | "camera placed inside the brass water pot / inside the banana bunch / inside the tree hollow looking out" |
| Over-the-shoulder | conversations (kid ↔ animal) | "over-the-shoulder from behind Lakshmi, soft-focus shoulder in foreground" |
| Orbit / 360 | chorus, group energy | "camera orbits 180° around the kids at waist height" |
| Whip pan | quick cuts between suspects | "fast whip pan to the right, motion blur" |
| Push-in | emotion, sad moments | "very slow push-in on the face" |

## 6. Look
- STYLE sentence: `3D Pixar-style animated feature film still, Cocomelon-bright colors, 4K, cinematic lighting, soft global illumination, subsurface skin, shallow depth of field, anamorphic lens look, NOT photorealistic, no text or letters anywhere.`
- Light tells time: morning gold → bright midday → dappled green shade (mystery) → warm golden afternoon → sunset finale.
- Colour: warm, saturated; yellow bananas pop against green leaves and red roof tiles.
- Emotion lighting: sad = cooler, softer, backlit; reveal = shaft of sunlight + dust sparkles.

## 7. Timing & edit
- Cut on the beat; a drum hit = a cut or a punch-in.
- Speed: action moments at 0.5× slow motion (splash, jump, reunion); comedy beats at real speed; speed-ramp into big moments.
- Transitions (ffmpeg xfade): hard cuts inside a section; whip-smear (`smoothleft/right`) between suspects; `circleopen` iris for reveals; `zoomin` into choruses; white flash on a big drum hit; `fadeblack` only before the finale.
- Counting: big pop-up numerals (digit + Kannada word) placed ON the object being counted, timed to the sung word (word timestamps from Suno).
- Camera shake on thumps ("ಧಮ್ ಧಮ್").
- One short, silent animated **subscribe button** (≈3 s, corner, no voice ask) mid-video in an instrumental. (Made for Kids: keep it small and silent, never "tell your kids to subscribe".)
- Lip sync: current tools (Grok 480p) animate mouths "singing" but can't sync exactly to the song. Keep sung lines on shots where mouths are small/side-on, and use real lip-sync tools only for 1–3 hero close-ups if Anand wants.

## 8. Video generators (checked Sep 2026)
Nothing good is truly free AND unlimited. Best mix for this channel:
- **Grok Imagine**: current workhorse (480p/720p, 6/10/15 s).
- **Google Flow – Veo 3.1**: ❌ do NOT use (Anand, 27 Sep 2026). It spends the monthly Flow credits; keep Flow for images only.
- **Kling AI** (kling.ai/app) — **BACKUP #1** (Anand, 28 Sep 2026): free daily credits (~66/day, a few 5 s image-to-video clips), strong motion. Use it when Grok fails a scene twice (morphing, extra legs, count drift) or for 1–2 hero shots.
- **Hailuo (MiniMax)** (hailuoai.video) — **BACKUP #2**: free daily generations, good character consistency. Use it when Grok and Kling both fail a scene.
- Both need Anand signed in once in his Chrome (the agent never logs in). Same rules as Grok: upload the scene image, motion prompt + "keep faces/outfits/legs the same", no audio, check the 4-frame strip, and save as `05_videos/Sxx.mp4` (note the tool in `video_log.md`).
- **Wan 2.2 (open source)**: truly unlimited, but needs a PC with a 24 GB GPU (ComfyUI).
