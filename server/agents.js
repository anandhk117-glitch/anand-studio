// The agent team. Each writing job is defined once and can run two ways:
//   1. right now with free tokens (FreeLLMAPI or any OpenAI-compatible endpoint)
//   2. as a request in the queue, picked up by Claude Code (tools/agent.js)
// Both paths save the result through the same apply() so the project looks the same either way.
const store = require('./store');
const llm = require('./llm');
const yt = require('./youtube');
const { estimateLines, estimateNarration, buildScenes } = require('./timeline');

const cut = (s, n) => (s && s.length > n ? s.slice(0, n) + '\n…' : s || '');

function context(channel) {
  const mem = store.getMemory(channel.id);
  let playbook = '';
  if (channel.pipeline === 'kids_song') { try { playbook = require('fs').readFileSync(require('path').join(store.P.memory, '_shared', 'creative_direction.md'), 'utf8'); } catch {} }
  return [
    playbook ? `CREATIVE DIRECTION PLAYBOOK (every agent follows it):\n${cut(playbook, 7000)}` : '',
    `CHANNEL: ${channel.name} (${channel.language}). ${channel.about}`,
    `AUDIENCE: ${channel.audience}`,
    channel.cast?.length ? `CAST (never redesign): ${channel.cast.map((c) => `${c.name} — ${c.look}`).join('; ')}` : '',
    `STYLE SENTENCE (goes first in every image prompt): ${channel.visual_style}`,
    `RULES:\n${cut(mem.rules, 6000)}`,
    mem.lessons.trim() ? `LESSONS LEARNED (follow these):\n${cut(mem.lessons, 2500)}` : '',
    mem.decisions.trim() ? `RECENT DECISIONS BY ANAND:\n${cut(mem.decisions.split('\n').slice(-25).join('\n'), 2000)}` : '',
  ].filter(Boolean).join('\n\n');
}

const JSON_ONLY = 'Reply with JSON only, no commentary, matching exactly this shape:';
const CHOREO = `
CHOREOGRAPHER RULES (how the kids act — Cocomelon-style clarity, never "AI slop"):
- ACT OUT THE LYRIC LITERALLY with what is in the picture. Read the line, find its verb and its object, and show exactly that: "ಅಜ್ಜಿ ಕೊಟ್ಟರು ಹಾಲು" → Ajji holds out a steel tumbler and a kid takes it with both hands; "ಎಣಿಸೋಣ" (counting) → one kid touches the items on the table ONE BY ONE in time with the counting while the other nods and counts on fingers; "ಗಟ ಗಟ ಕುಡಿದರು" → kids lift the tumblers and drink, then smile with a milk moustache.
- Hands and objects: one slow, clear handling per clip — pick ONE item up, show it to the camera, put it back. Hands always hold objects firmly; objects never melt, multiply or float.
- Everyone stays on their own spot. Nobody walks around, behind or through another person, animal or object; nobody turns their back. Animals do ONE small natural action (the calf does two small happy hops on the spot and wags its tail; the cow turns her head and blinks) and stay ONE animal in one piece.
- Chorus = a fixed, simple dance on the beat that repeats every chorus (sway left-right, clap above the head, hop on the spot) so kids can copy it — the same choreography every time the chorus returns.
- Instrumental fills = a fun "hook" moment: a reaction close-up (big surprised or laughing face), the mascot doing one cute move, or the kids clapping to the drum.
- Colours, clothes and faces never change during the clip.
`;
// Anatomy every picture and clip must keep (the clip tools love to add a 5th leg or a second tail).
const ANATOMY = `ANATOMY LOCK (write the matching lines into every picture prompt and check them):
- Every kid/person: 1 head, 2 arms, 2 legs, 5 fingers on each hand, 5 toes; normal child proportions.
- Cow / bull / calf / buffalo / goat / sheep / horse / donkey / dog / puppy / cat / deer / tiger / lion: EXACTLY 4 legs (2 front, 2 back, each ending in one hoof or paw), 1 tail, 1 head, 2 ears, 2 eyes. Cow and bull: 2 horns, the udder only between the BACK legs; a calf has tiny horn nubs.
- Elephant: EXACTLY 4 thick legs, 1 trunk, 2 big ears, 1 thin tail with a tuft, 0 or 2 small tusks (never more).
- Hen / rooster / duck / parrot / peacock / any bird: 2 legs, 2 wings, 1 beak, 1 tail fan.
- Monkey: 2 arms, 2 legs, 1 tail. Fish: no legs. Snake: no legs.
- Lying-down animals fold their legs under the body; count only legs you see, never extra ones.
- Avoid line for every prompt: "No extra or missing arms, legs, hooves, paws, fingers, toes, horns, trunks, tusks, wings or tails; no two heads; no animal or person fused into another."`;

const CAMERA = `CAMERA MENU — the camera angle lives in the PICTURE (the still), so every plate is framed like a feature film. Never two identical framings in a row; use at least 7 different shot types per song:
- Aerial drone / crane establishing shot: the opening, section changes and the finale.
- Wide shot: chorus group dances (everyone full body, feet visible).
- Medium shot (waist up): verses, singing lines.
- Close-up: one face for emotion, a question or a surprise; extreme close-up for a detail (a bell, a bite of grass, a laddu).
- Low-angle hero shot from ground level: big animals, heroes, reveals.
- Straight top-down overhead: counting objects, patterns, a circle of kids.
- Over-the-shoulder: a kid talking to an animal (soft-focus shoulder in front).
- Fun POV: camera inside the water pot / inside the haystack / from the cow's eye level looking at the kids.
- Tracking shot at child height: kids running or walking somewhere.
Write the shot into the prompt as "SHOT: <size>, <angle>, <lens>" (e.g. "SHOT: close-up, eye level, 85mm lens, shallow depth of field"). Composition: rule of thirds, a foreground element for depth, headroom, empty sky where the editor puts pop-up words. Keep screen direction (180° rule): once the house is on the left it stays on the left.
LIGHT tells time: misty sunrise gold → bright morning → warm afternoon → orange sunset → blue night with warm lamps. Write the light into every prompt.`;

const DIRECTOR = `
DIRECTOR RULES (plan the pictures like a big kids' show):
- Every lyric line gets a picture that SHOWS what the words say — the people, animals and objects named in the line must be in its plate (e.g. "ಅಜ್ಜಿ ... ಹಾಲು" needs Ajji AND glasses/tumblers of milk with the kids; a line about counting needs exactly those items on a table). Never reuse a plate whose content does not match the line.
- Follow the music: big wide group shots for choruses, medium shots for verses, a close-up reaction shot on a surprise or a question (e.g. "ಪುಟ್ಟು ಎಲ್ಲಿ?"), something special in every instrumental gap. Change shot size at least every 2–3 shots.
- The story must read with the sound off: problem → search → found → happy ending, each beat visible.
- Bright, warm, simple backgrounds; big clear faces; leave space between kids and big animals/props so the video tool never moves anyone through them.
- NEVER repeat the same action in neighbouring shots. Each next shot shows a NEW action that moves the story on (Ajji ties the garland → the calf turns to the kids → the kids clap). Only the chorus signature dance repeats, and always in its fixed order.
- CONTINUOUS SHOTS for calm, slow or instrumental passages: set "continue_previous": true on the following scene(s) of the same plate. That clip starts from the LAST frame of the previous clip, so 2–3 scenes become one smooth 10–15 s shot with no cut. Each part continues the action naturally (never restart the same move).
- Cinematic feel: smooth, gentle movement; no sudden, fast or jerky moves. Faster energy only in the chorus dance.
- FIXED SETS like a studio production: list every location once in bible.sets as {"L1":{"name":"","description":"one fixed paragraph: buildings, trees, props, colours, where things are"}} and give every plate "set":"L1". The Studio makes one empty picture of each set first and every shot there must match it.
- POSE for animal characters, chosen per shot: walking, running, sniffing, eating, sleeping = on all four legs like a real animal; talking, singing, dancing, waving, hugging, holding or giving something = standing upright on the hind legs, cartoon style, front legs used like arms (still exactly 4 legs). Write it into the prompt as "POSE: ...".
- ONE picture per scene. A plate is shared only by chorus repeats of the same dance (and then gets a different take and a different move). Repeating the same picture looks cheap.
${CAMERA}
${ANATOMY}
`;
const MOTION_RULES = `MOTION PROMPT RULES (motion_prompt of each scene) — the clip must look like real Pixar animation, not AI:
- ONE main action per clip (each clip is only about 5 seconds). Never a whole routine. Examples: "the four kids clap twice above their heads and sway left, then right, in time"; "Lakshmi holds out the grass, Gowri leans in and takes a bite"; "Kumar turns to the camera and waves". A chorus can use a different simple move in each of its clips.
- Natural timing: easy, unhurried movement at real speed with weight — anticipation before a move, ease-in and ease-out, feet planted on the ground (no sliding or floating), knees softly bending on the beat.
- Secondary motion that makes it feel alive: hair, braids and jasmine swing a little after a move, cloth sways, breathing, blinking, small head tilts. Characters not doing the main action keep small natural idle movement (blink, smile, sway) — never frozen, never all doing identical robotic moves.
- Faces: warm expressions that change gently. Mouths move only on singing lines, in a relaxed natural way; on instrumental or calm lines mouths stay closed and smiling.
- A motion prompt may ONLY move what is already in its plate picture. Never ask for a character, animal or object that is not in that plate (if the lyric needs the cow, use a plate that has the cow).
- Camera: LOCKED for most clips (camera moves make the tools morph faces and animals). Allowed on at most 1 in 5 clips — establishing shots, the finale, an emotional close-up — ONE slow simple move: "slow push-in", "slow pan right" or "slow crane down". Never a zoom, orbit or fast move on shots with kids near the frame edge.
- Start with a unique 3–5 word label (e.g. "Chorus clap sway wide").
- End every motion prompt with: "Smooth, natural Pixar-quality animation with real weight and timing; no jitter, no warping, no sliding feet, no rubbery limbs. Keep every face, hair style, outfit, body shape and size exactly the same from start to end. No new characters, no extra animals, no new objects, no text."
` + CHOREO;

const REEL_RULES = `AUDIENCE: US, UK, Australia, Europe adults — fast, confident, no filler, US spelling.
SOURCE: you get the story's Wikipedia article text below. No hype claims the article does not make ("changed Hollywood forever", "redefined cinema", "secretly"). EVERY fact, number, date, name and quote must come from that text. If it is not in the text, leave it out. Quotes only word-for-word from the text, with who said it.
HOOK: "hook_title" = 3-7 words shown big in the first 2.5 s (e.g. "The Movie That Killed a Studio"). Beat 1 starts mid-action with the most shocking fact (under 2.5 s spoken).
STRUCTURE: 9-13 beats, 170-240 spoken words (read at 1.15x → about 60-90 s): hook → setup → escalation → the fall → twist → close.
STORY TYPE: if the story's "type" is "actor", it is the biography of one legend: where they started, the turning point, the big break, the surprising fact most fans don't know, the legacy — still with a hook and a twist, never a dry timeline.
PUNCH LINES: most beats end on a short punchy line; put a 1-4 word version in "punch" (e.g. "$44 MILLION.", "ONE WEEK.", "GONE."). Not every beat — 5-7 of them.
LOOP: the last beat's sentence must lead straight back into beat 1 (e.g. last: "...and that is how one movie" → first: "destroyed a Hollywood studio."), so a re-watch feels seamless. The last beat's last shot is {"type":"end","text":"a short question to the viewer"} (the logo, a SUBSCRIBE button and "for more ..." are added automatically — never write them); the last beat has no "punch".
SHOTS: each beat has "shots": 1-3 visuals (a new picture every ~1.5-2 s; more shots for longer beats). Real proof first:
- {"type":"photo","person":"Exact Full Name","role":"film director|actor|producer|businessman","kicker":"NAME"} — a real person (the Studio takes their own Wikidata photo; never use "query" for a person).
- {"type":"photo","query":"Wikimedia Commons search words for a place, building, object or event","kicker":"LABEL","fallback_type":"headline","fallback_text":"..."} — never label a photo with a year or place it may not be from.
- {"type":"headline","kicker":"YEAR","text":"...","source":"Publication, Year"} / {"type":"quote","text":"exact quote","source":"Who, Publication, Year","kicker":"..."} — proof cards.
- {"type":"chart","kicker":"...","bars":[{"label":"Budget","value":44},{"label":"Box office","value":3.5}],"prefix":"$","unit":"M","source":"..."} — money and numbers.
- {"type":"stat","value":"3h 39m","label":"what the number means"} — one big number.
- {"type":"broll","query":"2-4 English words of stock footage","text":"SHORT LABEL"} — real moving cinema footage between proof shots: "red carpet photographers", "movie theater audience", "film set camera crew", "old film projector", "hollywood sign", "clapperboard", "cinema marquee lights", "film reel". Generic atmosphere ONLY — never claim it shows the real person or place. Use 3-5 in every video, about one every second or third beat, so the video always moves.
- {"type":"fx","style":"flashes|marquee|clapper|spotlight|filmstrip|reel","text":"SHORT LABEL"} — animated cinema graphics (camera flashes, theatre marquee, clapperboard snap, curtain + spotlight, rolling film strip, spinning reel). 1-2 per video.
- {"type":"panel","prompt":"comic panel of ... (no real face, no known characters, no logos)"} — ONLY where no real image can exist.
Prefer photos and broll; cards (headline/quote/stat/chart) sit on top of the beat's photo or footage automatically, so the whole phone screen is always filled.
Extras on any shot: "pop":"BOOM!" (2-3 per video), "emoji":"🎬" (one fitting emoji on 3-5 shots), "arrow":true with "focus_x"/"focus_y" (0-100) to point at something in a photo, "flashes":true on a photo of a star (paparazzi camera flashes; premieres, fame, scandal).
MUSIC: "music": "tension" | "mystery" | "upbeat" — the mood of the story.`;
const REEL_SCHEMA = { title: '', hook_title: '', music: 'tension', beats: [{ text: 'spoken line', punch: '', shots: [{ type: 'photo', person: '', role: '', kicker: '' }] }], sources: [{ name: '', url: '' }] };

const JOBS = {
  research: {
    schema: { ideas: [{ title_native: '', title_en: '', type: 'canon | festival | learning | original | episode', why_it_can_go_viral: '', evidence: '', hook: '', playlist: '', characters: '' }] },
    async messages(p, ch, extra = {}) {
      let evidence = 'No live YouTube data this time (no API key or scan failed). Use what you know about this niche, and say so in "evidence".';
      const niche = extra.niche || yt.cachedNiche(ch.id);
      if (niche?.videos?.length) {
        evidence = `LIVE YOUTUBE DATA (last ${niche.keywords?.length ? '45 days' : 'scan'}, sorted by views/day). Cite these as evidence:\n` +
          niche.videos.slice(0, 20).map((v) => `- "${v.title}" — ${v.channel} — ${v.views_per_day} views/day, ${v.views} views, ${v.outlier ?? '?'}× subs`).join('\n');
      }
      const opp = require('./research').cached(ch.id);
      if (opp?.opportunities?.length && Date.now() - new Date(opp.made).getTime() < 10 * 86400000) {
        evidence += `\n\nRESEARCH AGENTS' REPORT (${opp.made.slice(0, 10)}):\nTrends: ${(opp.trends || []).join('; ')}\nGaps: ${(opp.gaps || []).join('; ')}\nDated moments: ${(opp.dated || []).map((d) => d.what + ' ' + d.date).join('; ')}\nWorks for us: ${(opp.what_works_for_us || []).join('; ')}\nRanked opportunities:\n` + (opp.opportunities || []).map((o) => `- ${o.idea_en} (${o.idea_native}) — ${o.why} — proof: ${o.proof} — score ${o.score}`).join('\n') + `\nAvoid: ${(opp.avoid || []).join('; ')}`;
      }
      const recent = store.listProjects(ch.id).filter((x) => x.idea).slice(0, 15).map((x) => '- ' + (x.title || x.idea.title_en)).join('\n');
      return [
        { role: 'system', content: `You are the research agent for a YouTube channel. You find ideas with real demand.\n\n${context(ch)}` },
        { role: 'user', content: `${ch.research?.brief || ''}\n\n${evidence}\n\nAlready made (do not repeat):\n${recent || '- none yet'}\n\n` +
          `${extra.focus ? 'Anand wants this direction: ' + extra.focus + '\n\n' : ''}` +
          `Bring exactly 4 strong, different ideas for the next ${ch.pipeline === 'documentary' ? 'episode' : 'song'}. Each must say why it can go viral and cite evidence (a video, a views/day number, a search term, a festival date). Titles in ${ch.language} and English.\n\n${JSON_ONLY}\n${JSON.stringify(this.schema)}` },
      ];
    },
    apply(p, out) {
      const ideas = (out.ideas || []).slice(0, 4);
      if (!ideas.length) throw new Error('No ideas came back.');
      p.ideas = ideas;
    },
  },

  song: {
    schema: { title_native: '', title_en: '', lyrics: '[Intro]\n…\n[Verse 1]\n…\n[Chorus]\n…', style: '', retention_notes: '' },
    async messages(p, ch, extra = {}) {
      return [
        { role: 'system', content: `You are the songwriter for a kids YouTube channel.\n\n${context(ch)}` },
        { role: 'user', content: `Write the song for this idea:\n${JSON.stringify(p.idea, null, 1)}\n\n${ch.song_rules || ''}\n` +
          `Lyrics in ${ch.language}${ch.script_hint ? ' (' + ch.script_hint + ')' : ''}, with section tags [Intro] [Verse 1] [Chorus] [Verse 2] [Bridge] [Final Chorus] [Outro]. Short, repeatable lines a 3-year-old can sing. Target length ${ch.runtime || '2:15–3:00'}.\n` +
          `"style" is the Suno style box, under 200 characters. Default: ${ch.suno_style}\n` +
          `${extra.note ? 'Changes Anand asked for: ' + extra.note + '\n' : ''}${p.song?.lyrics && extra.note ? 'Previous version:\n' + p.song.lyrics + '\n' : ''}\n${JSON_ONLY}\n${JSON.stringify(this.schema)}` },
      ];
    },
    apply(p, out) {
      if (!out.lyrics) throw new Error('No lyrics came back.');
      p.song = { ...out, style: String(out.style || '').slice(0, 200), approved: false };
      p.title = out.title_native || out.title_en || p.title;
    },
  },

  script: {
    schema: { title: '', hook: '', text: '[Cold open]\n…\n[Act 1]\n…', runtime_minutes: 10 },
    async messages(p, ch, extra = {}) {
      if (ch.pipeline === 'reel') return [
        { role: 'system', content: `You write ReelBite Hollywood Shorts: true Hollywood stories told in 60-90 seconds, sourced like a news report.\n\n${context(ch)}` },
        { role: 'user', content: `Story: ${JSON.stringify(p.idea, null, 1)}\n\nWIKIPEDIA ARTICLE (${p.wiki?.url || ''}) — the ONLY allowed source of facts:\n${(() => { try { return require('fs').readFileSync(require('path').join(store.projectDir(p.id), 'wiki.txt'), 'utf8').slice(0, 14000); } catch { return '(missing)'; } })()}\n\n${ch.script_rules || ''}\n${extra.note ? 'Fix these: ' + extra.note + '\n' : ''}\n${REEL_RULES}\n\n${JSON_ONLY}\n${JSON.stringify(REEL_SCHEMA)}` },
      ];
      return [
        { role: 'system', content: `You are the script writer for a documentary YouTube channel.\n\n${context(ch)}` },
        { role: 'user', content: `Write the narration for this episode:\n${JSON.stringify(p.idea, null, 1)}\n\n${ch.script_rules || ''}\n` +
          `Use [Section] tags on their own lines. Only state facts you are confident about; mark anything uncertain with (verify).\n` +
          `${extra.note ? 'Changes Anand asked for: ' + extra.note + '\n' : ''}\n${JSON_ONLY}\n${JSON.stringify(this.schema)}` },
      ];
    },
    apply(p, out) {
      if (Array.isArray(out.beats) && out.beats.length) { const src = [...(out.sources || [])]; if (p.wiki?.url && !src.some((x) => x.url === p.wiki.url)) src.unshift({ name: `Wikipedia — ${p.wiki.title}`, url: p.wiki.url }); p.script = { ...out, sources: src, text: out.beats.map((b) => b.text).join('\n'), approved: false, checked: false }; p.title = out.title || p.title; return; }
      if (!out.text) throw new Error('No script came back.');
      p.script = { ...out, approved: false };
      p.title = out.title || p.title;
    },
  },

  // The cinematographer / director: one visual plan for the whole song.
  // A small set of reusable PLATES (pictures) — each plate is shot several times with different motion,
  // so 50 scenes may need only ~18–25 pictures. Camera sides are fixed once and never flip.
  images: {
    schema: {
      bible: { sets: { L1: { name: 'main place', description: 'one fixed paragraph' } }, location: 'the main place, described as 4 views (front/back/left/right or N/S/E/W)', positions: 'who stands/sits where, left to right, as seen from the main camera; and the mirrored order for the reverse angle', outfits: 'one line summary', wardrobe: { CharacterName: 'exact clothes for THIS song with colours, e.g. mustard-yellow half-sleeve cotton shirt, white dhoti with thin gold border, barefoot — the same in every picture' }, animals_props: { 'Animal or key object name as used in prompts': 'exact look, e.g. pure white cow, no patches, short curved horns, red kumkum dot, brass bell on a twisted rope' }, light: 'time of day, light, palette' },
      plates: [{ id: 'P1', set: 'L1', characters: ['names in the picture'], view: 'which side of the location the camera sees', image_prompt: '' }],
      scenes: [{ n: 1, plate: 'P1', take: 1, vision: 'what we see and why it matches the words', camera: 'wide | medium | close | reverse | over-shoulder | top', continue_previous: false, motion_prompt: '' }],
    },
    async messages(p, ch) {
      const sc = (p.scenes || []).map((s) => `${s.n}. ${s.start}-${s.end}s (${(s.end - s.start).toFixed(1)}s) ${s.section}${s.setpiece ? ' [BIG SET-PIECE / instrumental gap]' : ''}: ${s.lyric || '(instrumental)'}`).join('\n');
      const kids = p.pipeline === 'kids_song';
      const plates = Math.max(12, Math.min(45, Math.round((p.scenes || []).length * 0.85)));
      const castNames = (ch.cast || []).map((c) => c.name).join(', ');
      const rules = kids ? `${DIRECTOR}${ch.choreography ? '\nCHANNEL SIGNATURE CHOREOGRAPHY (use it — it is the channel trademark):\n' + ch.choreography + '\n' : ''}
PICTURE PROMPT RULES (image_prompt of each plate, in this order):
1. Start with: "${ch.visual_style}"
2. "CHARACTER LOCK: faces, hair and body from the attached character sheets" + each character in the picture with their locked look from CAST AND their clothes copied word for word from bible.wardrobe. Every animal/key object copied word for word from bible.animals_props (its exact colour). Clothes stay the same in every plate; change them only when the lyrics clearly ask for it (e.g. "they put on festival clothes") — then add a second wardrobe entry like "Kumar (from scene 20)" and use it from that point on.
3. "SHOT: ..." from the camera menu, then location and which view of it (from the bible), then who is where LEFT TO RIGHT, then the action/pose and where each one looks, then LIGHT and COMPOSITION.
3b. The ANATOMY lines for every person and animal in the picture, then the avoid line.
4. "Exactly N kids" (and "exactly one elephant" if Aane is there). "All kids the same height, normal slim child build, NOT chubby, NOT fat, no big belly, fully clothed."
5. "No text, letters, numbers, names, labels or captions anywhere in the picture." Anything that must be counted or read (numbers, letters, exactly-N objects) is NOT drawn — leave that area plain; the editor adds it.
6. Safe, tidy behaviour only: nobody stands on furniture, no sharp objects, nothing scary. End with "16:9".
CAMERA LOGIC: decide positions once in the bible and keep them. People look at what they are doing. A shot showing seated kids' faces is a REVERSE angle (camera at the front looking back): the order mirrors and the back wall is behind them — write the mirrored order. Never let left and right flip between plates of the same moment.
MOTION PROMPT RULES (motion_prompt of each scene) — the clip must look like real Pixar animation, not AI:
- ONE main action per clip (each clip is only about 5 seconds). Never a whole routine. Examples: "the four kids clap twice above their heads and sway left, then right, in time"; "Lakshmi holds out the grass, Gowri leans in and takes a bite"; "Kumar turns to the camera and waves". A chorus can use a different simple move in each of its clips.
- Natural timing: easy, unhurried movement at real speed with weight — anticipation before a move, ease-in and ease-out, feet planted on the ground (no sliding or floating), knees softly bending on the beat.
- Secondary motion that makes it feel alive: hair, braids and jasmine swing a little after a move, cloth sways, breathing, blinking, small head tilts. Characters not doing the main action keep small natural idle movement (blink, smile, sway) — never frozen, never all doing identical robotic moves.
- Faces: warm expressions that change gently. Mouths move only on singing lines, in a relaxed natural way; on instrumental or calm lines mouths stay closed and smiling.
- A motion prompt may ONLY move what is already in its plate picture. Never ask for a character, animal or object that is not in that plate (if the lyric needs the cow, use a plate that has the cow).
- Camera: LOCKED. No zoom, no push-in, no pan (the clip tools morph faces and animals when the camera moves; the editor adds the gentle drift).
- Start with a unique 3–5 word label (e.g. "Chorus clap sway wide").
- End every motion prompt with: "Smooth, natural Pixar-quality animation with real weight and timing; no jitter, no warping, no sliding feet, no rubbery limbs. Keep every face, hair style, outfit, body shape and size exactly the same from start to end. Every animal keeps exactly 4 legs (birds 2), 1 head and 1 tail the whole time; no legs appear, split or merge. No new characters, no extra animals, no new objects, no text."
- Never use words video tools refuse in kids' scenes (punch, kick, hit, shake hips, bouncing bodies); say "lifts one hand", "sways", "waves".${CHOREO}`
        : `
PICTURE PROMPT RULES: start with "${ch.visual_style}". Cinematic documentary illustration: places, objects, maps, symbolic moments, silhouettes, crowds, hands at work. Do NOT draw a lifelike face of a real person (use silhouettes, backs, distance, symbolic objects). No text in the picture. End with "16:9".
MOTION PROMPT RULES: slow cinematic camera (slow push-in, slow pan, parallax), gentle natural movement (smoke, cloth, water, light). Start with a 3–5 word label. End with "Slow, steady, cinematic. No new people, no text, no morphing."`;
      return [
        { role: 'system', content: `You are the director and cinematographer of this ${kids ? 'kids music video' : 'documentary episode'}. You plan every shot so the video holds attention: a hook in the first 5 seconds, a new angle or energy change every 25–35 seconds, the biggest visual moment on the biggest musical moment, and clean continuity.\n\n${context(ch)}` },
        { role: 'user', content: `${kids ? 'Song' : 'Episode'}: ${p.title}${p.song?.title_en ? ' — ' + p.song.title_en : ''}\nScenes (one clip each):\n${sc}\n\n` +
          `Make ONE visual plan:\n- "bible": the location as a 360° set (4 views), fixed positions left-to-right (+ mirrored order for reverse angles), ${kids ? '"wardrobe": ONE exact outfit per character for the whole song (garments + colours; fitting the song, e.g. village/festival clothes), and "animals_props": the exact look of every animal and key object (colour, markings, accessories)' : 'period-correct outfits'}, light.\n- About ${plates} reusable "plates" (pictures), at least ${Math.ceil((p.scenes || []).length / 4)}. Almost every scene has its OWN plate (own picture, own camera angle); only chorus repeats of the same dance share a plate (max 3 uses, each with a different take and move).${kids ? ` Only use these characters: ${castNames}${p.song?.lyrics && /Teacher Akka|Ajji/.test(p.song.lyrics) ? ' (and Teacher Akka / Ajji if the lyrics name them)' : ''} plus animals the lyrics name.` : ''}\n- Every scene gets: plate, take, vision, camera, motion_prompt.\n${rules}\n\n${JSON_ONLY}\n${JSON.stringify(this.schema)}` },
      ];
    },
    apply(p, out) {
      const plates = new Map((out.plates || []).map((x) => [String(x.id), x]));
      const by = new Map((out.scenes || []).map((s) => [+s.n, s]));
      if (!by.size || !plates.size) throw new Error('No visual plan came back.');
      // A kids song needs (almost) one picture per scene — the free model sometimes ignores that and reuses a few pictures.
      if (p.pipeline === 'kids_song' && new Set([...by.values()].map((d) => String(d.plate))).size < Math.round(by.size * 0.6)) throw new Error(`the plan reused pictures (${new Set([...by.values()].map((d) => String(d.plate))).size} pictures for ${by.size} scenes) — it must be about one picture per scene; try again (a stronger model or Claude Code)`);
      p.visual_plan = { bible: out.bible || {}, plates: [...plates.values()] };
      p.motion_version = 2;
      // No picture is used more than 3 times: extra uses get their own fresh picture of the same plate.
      const uses = {};
      for (const d of [...by.values()].sort((a, b) => a.n - b.n)) {
        const id = String(d.plate);
        uses[id] = (uses[id] || 0) + 1;
        const copy = Math.floor((uses[id] - 1) / 3);
        if (copy > 0 && plates.has(id)) {
          const nid = `${id}-${copy + 1}`;
          if (!plates.has(nid)) plates.set(nid, { ...plates.get(id), id: nid });
          d.plate = nid;
          d.take = ((uses[id] - 1) % 3) + 1;
        }
      }
      p.visual_plan.plates = [...plates.values()];
      p.scenes = (p.scenes || []).map((s) => {
        const d = by.get(s.n);
        if (!d) return s;
        const pl = plates.get(String(d.plate)) || [...plates.values()][0];
        return { ...s, plate: pl.id, take: d.take || 1, camera: d.camera || '', vision: d.vision || s.vision, image_prompt: pl.image_prompt, motion_prompt: d.motion_prompt || s.motion_prompt, characters: pl.characters || [], continue_previous: !!d.continue_previous && s.n > 1 };
      });
    },
  },

  // Motion prompts are written by the director together with the plan; this job fills gaps
  // (or rewrites every scene when the plan was made before the natural-motion rules: motion_version < 2).
  videos: {
    schema: { scenes: [{ n: 1, motion_prompt: '' }] },
    async messages(p, ch) {
      const all = (p.motion_version || 1) < 2;
      const sc = (p.scenes || []).filter((s) => all || !s.motion_prompt).map((s) => `${s.n}. ${(s.end - s.start || s.len || 5).toFixed?.(1) || s.len}s. Lyric: ${s.lyric || '(instrumental)'}. Picture shows: ${(s.characters || []).join(', ') || 'see vision'} — ${s.vision || ''}`).join('\n') || '(none missing)';
      return [
        { role: 'system', content: `You are the motion director and choreographer of a big Cocomelon-style kids show. You write image-to-video prompts that act out each lyric line clearly and smoothly.\n\n${context(ch)}` },
        { role: 'user', content: `Scenes that need a motion prompt:\n${sc}\n\n${ch.choreography ? 'CHANNEL SIGNATURE CHOREOGRAPHY (use it — it is the channel trademark):\n' + ch.choreography + '\n\n' : ''}${p.pipeline === 'kids_song' ? MOTION_RULES : 'Slow, cinematic, documentary pacing; one smooth camera move; end with "Slow, steady, cinematic. No new people, no text, no morphing."'}\nNo scary, violent or unsafe actions.\n\n${JSON_ONLY}\n${JSON.stringify(this.schema)}` },
      ];
    },
    apply(p, out) {
      const all = (p.motion_version || 1) < 2;
      const by = new Map((out.scenes || []).map((s) => [+s.n, s]));
      p.scenes = (p.scenes || []).map((s) => (by.has(s.n) && (all || !s.motion_prompt) && by.get(s.n).motion_prompt ? { ...s, motion_prompt: by.get(s.n).motion_prompt, ...(all && s.video && !s.video_locked ? { redo: true } : {}) } : s));
      p.motion_version = 2;
    },
  },

  publish: {
    schema: { titles: ['best first'], description: '', tags: [''], hashtags: ['', '', ''], thumbnail_idea: '', thumbnail_text: '', thumbnail_text_alt: '', playlist: '', publish_slot: '', shorts: [{ title: '', start: 0, end: 45 }] },
    async messages(p, ch, extra = {}) {
      const intro = p.edit?.intro_len || 0;
      const chapters = (p.timeline?.lines || []).filter((l, i, a) => i === 0 || l.section !== a[i - 1].section)
        .map((l) => `${fmt(l.start + intro)} ${l.section}`).join('\n');
      // Evidence from the research agents: what wins in this niche right now, and what wins on OUR channel.
      const rep = require('./research').cached(ch.id) || {};
      const own = (rep.own || []).slice(0, 8).map((v) => `- "${v.title}" — ${v.views} views (${v.views_per_day}/day)`).join('\n');
      const niche = (store.readJSON(require('path').join(store.P.stats, ch.id + '_niche.json'), {}).videos || []).slice(0, 12).map((v) => `- "${v.title}" — ${v.views_per_day ?? '?'} views/day`).join('\n');
      const today = new Date().toISOString().slice(0, 10);
      const native = ch.native_name ? `${ch.native_name} / ` : '';
      return [
        { role: 'system', content: `You are the publisher and packaging expert (titles, description, tags, thumbnail) for ${ch.name}. You get the highest click-through and search reach WITHOUT clickbait — ${ch.pipeline === 'kids_song' ? 'this is a kids channel, ' : ''}every promise in the title and thumbnail must be true to the video.\n\n${context(ch)}` },
        { role: 'user', content: `Today is ${today} — the year in any title or tag is ${today.slice(0, 4)}. The channel's exact name: ${native}${ch.name} (spell it exactly like this).\n\nVideo: ${p.title}\nIdea: ${JSON.stringify(p.idea)}\n${p.song ? 'Lyrics:\n' + p.song.lyrics : 'Script hook: ' + (p.script?.hook || '')}\n` +
          `Final length: ${p.edit?.duration ? fmt(p.edit.duration) : 'unknown'} (the first ${fmt(intro)} is the brand intro — chapter times below already include it)\nChapter starts:\n${chapters || 'none'}\n\n` +
          `OUR CHANNEL'S BEST VIDEOS (copy what works for OUR viewers — title pattern, emoji, words):\n${own || '- (no data yet)'}\n\nWINNING VIDEOS IN THIS NICHE NOW (views/day):\n${niche || '- (no data yet)'}\n\n` +
          `CHANNEL PUBLISH RULES: ${ch.publish_rules || ''}\n\n` +
          `PACKAGING RULES (all must hold):\n` +
          `TITLES — 3–4 ALTERNATIVE titles, best first, each one complete on its own, ≤ 95 characters. Pattern that works on this channel: ${ch.packaging?.title_pattern || `"<${ch.language} title> <1–2 emoji> | <English title> | <${ch.language} Kids Song(s)/Story ${today.slice(0, 4)}>"`}. The main search words must be in the first 45 characters. Perfect ${ch.language} spelling, no other scripts mixed in. No ALL CAPS, no "subscribe", no misleading promise.\n` +
          `DESCRIPTION — line 1–2: a warm hook in ${ch.language} + the main keywords (shown in search). Then the same in English. Then chapters exactly as given above (one per line, "m:ss Name"). Then 2–3 lines of what children learn/enjoy. Then a short "More from ${ch.name}" line. End with exactly 3 hashtags. No comment or subscribe asks. Geo: ${ch.packaging?.geo || `write for viewers in ${ch.research?.region || 'India'} first (${ch.language} speakers), and for families abroad (NRI: USA, UAE, UK, Canada, Australia, Singapore) second.`}\n` +
          `TAGS — 25–35 tags, total under 480 characters, tiered: core ${ch.language} search terms → English equivalents → learning/cultural → NRI/global → long-tail. No year-old tags, no competitor channel names.\n` +
          `THUMBNAIL — thumbnail_text: 2–4 BIG ${ch.language} words that create curiosity or emotion (the most clickable words of the title, not the whole title). thumbnail_text_alt: a second option for an A/B test. thumbnail_idea: which moment/frame, the main character's face large with a clear emotion, one bright contrasting background, text placed away from faces, the channel's usual look so viewers recognise it.${ch.thumb_rules ? ' Channel thumbnail rules: ' + ch.thumb_rules : ''}\n` +
          `SHORTS — 3 cut points (seconds in the final video, each ≤ 58 s) that together cover the song, each starting on a hook moment; each title ≤ 60 characters in ${ch.language} + 1 emoji.\n` +
          `${extra.note ? 'Changes Anand asked for: ' + extra.note + '\n' : ''}\n${JSON_ONLY}\n${JSON.stringify(this.schema)}` },
      ];
    },
    apply(p, out) {
      if (!(out.titles || []).length) throw new Error('No titles came back.');
      p.publish = { ...(p.publish || {}), ...out, approved: false };
      delete p.publish.thumbnail; delete p.publish.thumbnail_b; // new text → the thumbnail designer makes it again
    },
  },
};

function fmt(t) { t = Math.max(0, Math.round(t)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; }

// ---- browser jobs: only Claude Code (with Chrome) or you can do these ----
function browserInstruction(p, ch, stage) {
  const dir = `data/projects/${p.id}/`;
  switch (stage) {
    case 'music': return `Open suno.com → Create → Custom in Anand's logged-in Chrome. Title: "${p.song?.title_native || p.title}". Paste the lyrics and style below. Click Create ONCE, wait for both versions, download both, then run:\n  node tools/agent.js attach ${p.id} audio <file> A\n  node tools/agent.js attach ${p.id} audio <file> B\nAlso save each version's Suno link with: node tools/agent.js note ${p.id} "<links>".\nStop and tell Anand on any login, captcha, payment or credit screen.\n\nSTYLE:\n${p.song?.style}\n\nLYRICS:\n${p.song?.lyrics}`;
    case 'voice': return `Record or generate the narration for "${p.title}" from the approved script, export MP3/WAV, then: node tools/agent.js attach ${p.id} audio <file> narration`;
    case 'images': return `The free Hugging Face tools could not finish. Make one 16:9 image per scene that has NO image yet, in Google Flow (labs.google/flow) using only the free/included credits using the character reference sheets in brand/${ch.id}/characters/. Use each scene's image_prompt from the project. Save each as: node tools/agent.js attach ${p.id} image <file> <scene number>. If the same scene goes off-style twice, stop and flag it. Before starting, tell Anand: ${(p.scenes || []).length} scenes = ${(p.scenes || []).length} image generations.`;
    case 'videos': return `For each scene image, make a ${'6 s or 10 s'} clip (see clip_len) with the scene's motion_prompt. Order: Vibes (vibes.ai / Meta AI, free) → Grok Imagine → Seedance on Dola (dola.com) → Kling → Hailuo free tiers. Every scene needs a real moving clip — never fall back to a still or a zoom. Use only Anand's own logged-in accounts and their daily free credits — never create extra accounts, never buy credits, never remove another service's watermark. (Wan 3.0 clips are made by the Studio itself — skip scenes that already have a clip.) Save each: node tools/agent.js attach ${p.id} video <file> <scene number>. Check: faces stay the same, no morphing, motion matches the words.`;
    default: return `Work on stage "${stage}" for ${p.title}. Files go in ${dir}.`;
  }
}

// ---------- run ----------
// The channel's language must be the language of ideas and songs (a small model once wrote Hindi titles for the English channel).
function wrongLanguage(ch, stage, out) {
  if (!out || !['research', 'song'].includes(stage)) return null;
  const texts = stage === 'research' ? (out.ideas || []).map((i) => i.title_native || '') : [out.title_native || '', out.lyrics || ''];
  const all = texts.join(' ');
  const lang = String(ch.language || '').toLowerCase();
  const indic = /[\u0900-\u0DFF]/;
  if (lang.startsWith('english') && indic.test(all)) return `${ch.language} channel but the text is in another script`;
  if (lang.startsWith('kannada') && !texts.every((t) => !t || /[\u0C80-\u0CFF]/.test(t))) return 'Kannada channel but the text is not in Kannada script';
  if (lang.startsWith('hindi') && !texts.every((t) => !t || /[\u0900-\u097F]/.test(t))) return 'Hindi channel but the text is not in Devanagari';
  return null;
}
async function runLLM(p, stage, extra) {
  const ch = store.getChannel(p.channel);
  const job = JOBS[stage];
  const msgs = await job.messages(p, ch, extra);
  // Ideas and songs need a strong model: the small local model on the PC is not allowed to write them.
  const strong = ['research', 'song'].includes(stage);
  let { text, model } = await llm.chat(msgs, { project: p.id, noLocal: strong });
  const bad = wrongLanguage(ch, stage, text);
  if (bad) {
    ({ text, model } = await llm.chat([...msgs, { role: 'user', content: `Your answer was rejected: ${bad}. Write everything (title_native, lyrics) ONLY in ${ch.language}${/english/i.test(ch.language) ? ' (English words, Latin letters only — title_native is the English title)' : ''}. Reply with the full JSON again.` }], { project: p.id, noLocal: strong }));
    const still = wrongLanguage(ch, stage, text);
    if (still) throw new Error(`${stage}: ${still} (${model}) — not used, will try again`);
  }
  job.apply(p, text);
  return model;
}

function enqueue(p, stage, extra = {}) {
  const ch = store.getChannel(p.channel);
  const q = store.getQueue();
  const kind = extra.kind || (JOBS[stage] ? 'write' : 'browser');
  const open = q.find((t) => t.project === p.id && t.stage === stage && (t.kind || 'write') === kind && (t.status === 'open' || t.status === 'running'));
  if (open) return open;
  const t = {
    id: 't' + Date.now().toString(36), project: p.id, channel: p.channel, stage,
    agent: require('./pipelines').AGENTS[stage]?.name || stage,
    title: `${ch.short_name} · ${p.title || 'New ' + (p.pipeline === 'documentary' ? 'episode' : 'song')} · ${kind === 'browser' && JOBS[stage] ? 'make ' + stage : stage}`,
    kind: extra.kind || (JOBS[stage] ? 'write' : 'browser'),
    note: extra.note || extra.focus || '', status: 'open', created: new Date().toISOString(),
  };
  q.unshift(t);
  store.saveQueue(q);
  return t;
}

// Full instructions for Claude Code, built fresh so they include the latest project state.
async function taskBrief(t) {
  const p = store.getProject(t.project);
  const ch = store.getChannel(t.channel);
  if (JOBS[t.stage] && t.kind !== 'browser') {
    const msgs = await JOBS[t.stage].messages(p, ch, { note: t.note, focus: t.note });
    return { kind: 'write', instructions: msgs.map((m) => `### ${m.role.toUpperCase()}\n${m.content}`).join('\n\n'),
      finish: `Write the JSON to a file and run: node tools/agent.js done ${t.id} <file.json>` };
  }
  return { kind: 'browser', instructions: browserInstruction(p, ch, t.stage), finish: `When everything is attached run: node tools/agent.js done ${t.id}` };
}

function completeTask(id, output) {
  const q = store.getQueue();
  const t = q.find((x) => x.id === id);
  if (!t) throw new Error('No such task: ' + id);
  if (output && JOBS[t.stage] && t.kind !== 'browser') {
    const p = store.getProject(t.project);
    JOBS[t.stage].apply(p, output);
    store.log(p, t.agent + ' (Claude Code)', `Finished ${t.stage}`);
    store.saveProject(p);
  }
  t.status = 'done';
  t.finished = new Date().toISOString();
  store.saveQueue(q);
  return t;
}

// Timeline needs no AI: maths on the audio length + lyrics.
function autoTimeline(p, { vocalStart } = {}) {
  const dur = p.audio_info?.duration;
  if (!dur) throw new Error('Pick the audio first.');
  const lines = p.pipeline === 'documentary'
    ? estimateNarration(p.script?.text, dur)
    : estimateLines(p.song?.lyrics, dur, { vocalStart: vocalStart ?? Math.max(2, p.audio_info?.energy_start ?? 6) });
  p.timeline = { duration: dur, lines, approved: false, source: 'estimate' };
  return p.timeline;
}
// Scene length rule for clip videos: one scene = one clip (a clip is ~5.2 s and may be slowed to 1.12x),
// so no scene is longer than 5.8 s — no repeated or zoomed fillers that look like a still picture.
function sceneLen(p, ch) {
  const sl = { ...(ch.scene_len || {}) };
  if (p.pipeline === 'kids_song') { sl.max = Math.min(+sl.max || 5.8, 5.8); sl.min = Math.min(+sl.min || 3.5, 3.5); }
  return sl;
}
// New lyric times (heard from the song) → new scenes, keeping each line's picture, prompts and clip.
function retime(p, lines, source = 'listened') {
  const ch = store.getChannel(p.channel) || {};
  const oldLines = p.timeline?.lines || [];
  const oldScenes = p.scenes || [];
  const lineOf = (t, ls) => { let k = -1; ls.forEach((l, i) => { if (l.start <= t + 0.05) k = i; }); return k; };
  const oldSceneForLine = (k) => oldScenes.find((s) => oldLines[k] && oldLines[k].start >= s.start - 0.05 && oldLines[k].start < s.end - 0.05);
  p.timeline = { duration: p.timeline?.duration || p.audio_info?.duration, lines, approved: false, source };
  const fresh = buildScenes(lines, p.timeline.duration, sceneLen(p, ch));
  const used = new Set();
  const keep = ['plate', 'take', 'camera', 'vision', 'image_prompt', 'motion_prompt', 'characters', 'image', 'image_source', 'image_check'];
  p.scenes = fresh.map((s) => {
    const mid = (s.start + s.end) / 2;
    const k = lineOf(s.start + 0.2, lines);
    const kMid = lineOf(mid, lines);
    let o = (k >= 0 && lines[k].end > s.start + 0.2) || kMid < 0 ? oldSceneForLine(Math.max(k, kMid, 0)) : null;
    if (!o) { // instrumental: same place in the song
      const ratio = mid / (p.timeline.duration || 1);
      o = oldScenes.slice().sort((a, b) => Math.abs((a.start + a.end) / 2 / (p.timeline.duration || 1) - ratio) - Math.abs((b.start + b.end) / 2 / (p.timeline.duration || 1) - ratio))[0];
    }
    const out = { ...s };
    if (o) for (const key of keep) if (o[key] != null) out[key] = o[key];
    if (o?.video && !o.redo && !used.has(o.video)) { out.video = o.video; out.video_source = o.video_source; out.clip_check = o.clip_check; used.add(o.video); }
    return out;
  });
  return p.scenes;
}
function scenesFromTimeline(p) {
  const old = new Map((p.scenes || []).map((s) => [s.n, s]));
  const ch = store.getChannel(p.channel) || {};
  p.scenes = buildScenes(p.timeline.lines, p.timeline.duration, sceneLen(p, ch)).map((s) => {
    const o = old.get(s.n);
    return o ? { ...s, image: o.image, video: o.video, image_prompt: o.image_prompt, motion_prompt: o.motion_prompt, vision: o.vision } : s;
  });
  return p.scenes;
}

// The critic: a second look by the brain before anything is approved without you.
async function review(p, kind) {
  const ch = store.getChannel(p.channel);
  const what = kind === 'song' ? `SONG PACKAGE\nTitle: ${p.song?.title_native} / ${p.song?.title_en}\nSuno style: ${p.song?.style}\nLyrics:\n${p.song?.lyrics}`
    : kind === 'script' ? `NARRATION SCRIPT\n${p.script?.text}`
    : `UPLOAD PACKAGE\nTitle OPTIONS (alternatives — only ONE will be used; judge each on its own, max 100 characters each):\n${(p.publish?.titles || []).map((t, i) => `${i + 1}. ${t} (${[...t].length} chars)`).join('\n')}\nDescription:\n${p.publish?.description}\nTags: ${(p.publish?.tags || []).join(', ')}\nThumbnail text: ${p.publish?.thumbnail_text}`;
  const { text } = await llm.chat([
    { role: 'system', content: `You are the strict quality checker for a YouTube channel. You protect the channel. Judge only against the rules.\n\n${context(ch)}` },
    { role: 'user', content: `${what}\n\nCheck: language and script correct (${ch.language}); every channel rule followed; ${ch.pipeline === 'kids_song' ? 'safe and gentle for small children, simple singable lines, chorus repeats, no "subscribe"/"comment" asks if the rules forbid them' : 'facts plausible, uncertain claims marked (verify), no invented quotes'}; no spelling mistakes; title matches what people search.\nReply JSON only: {"score": 0-10, "problems": ["…"], "verdict": "approve" | "rewrite" | "needs_anand"}` },
  ], { project: p.id, temperature: 0.2 });
  return { score: +text.score || 0, problems: text.problems || [], verdict: text.verdict || 'needs_anand' };
}

module.exports = { review, JOBS, runLLM, enqueue, taskBrief, completeTask, autoTimeline, scenesFromTimeline, retime, context };
