// Quality checkers used by the picture and clip agents (free Gemini vision).
// A picture or clip that fails is made again; after two failures the next tool in the layer order is tried.
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const llm = require('./llm');
const media = require('./media');

function channelRules(channelId) {
  try { return fs.readFileSync(path.join(store.P.memory, channelId, 'rules.md'), 'utf8').slice(0, 2500); } catch { return ''; }
}

// Tiny grey thumbnail of a picture (buffer or file) — to spot a result that is really one of the uploaded sheets.
async function thumb(input) {
  const { spawn } = require('child_process');
  return new Promise((res, rej) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', Buffer.isBuffer(input) ? 'pipe:0' : input, '-vf', 'scale=32:18,format=gray', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'];
    const pr = spawn(store.getSettings().ffmpeg_path || 'ffmpeg', args, { windowsHide: true });
    const out = []; pr.stdout.on('data', (d) => out.push(d));
    pr.on('close', (c) => (c === 0 ? res(Buffer.concat(out)) : rej(new Error('thumb failed'))));
    pr.on('error', rej);
    if (Buffer.isBuffer(input)) { pr.stdin.on('error', () => {}); pr.stdin.end(input); }
  });
}
async function isOneOf(buffer, files) {
  let a; try { a = await thumb(buffer); } catch { return false; }
  for (const f of files || []) {
    try {
      const b = await thumb(f);
      if (a.length !== b.length || !a.length) continue;
      let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
      if (d / a.length < 14) return true;
    } catch {}
  }
  return false;
}

// One wardrobe + animal look for the whole song (the director's bible), added to every picture prompt
// and checked in every picture, so outfits and animal colours never change between scenes.
const QUALITY = 'QUALITY: high-end 3D animated feature-film look, not an AI image: soft natural light with real bounce and grounded contact shadows, believable materials (cotton and silk with real folds and weave, polished brass, rough mud and straw, wood grain), small natural imperfections, relaxed natural poses (not stiff or symmetrical), eyes looking at what they are doing, correct hands with five fingers, clean sharp details; no plastic or waxy skin, no glowing oversaturated colours, no blurry smudged background objects, no warped or melted shapes.';
function lockFor(p, sc) {
  const b = p.visual_plan?.bible || {};
  const names = (sc?.characters || []).map(String);
  const pick = (obj) => Object.entries(obj || {}).filter(([k]) => !names.length || names.some((n) => n.toLowerCase() === k.toLowerCase()) || new RegExp('\\b' + k + '\\b', 'i').test(sc?.image_prompt || ''));
  // "Kumar (from scene 20)" entries replace the base outfit from that scene on.
  const wb = {};
  for (const [k, v] of Object.entries(typeof b.wardrobe === 'object' ? b.wardrobe : {})) {
    const m = k.match(/^(.*?)\s*\(from scene (\d+)\)/i);
    if (!m) { if (!(k in wb)) wb[k] = v; continue; }
    if ((sc?.n || 0) >= +m[2]) wb[m[1].trim()] = v;
  }
  const wardrobe = pick(wb);
  const animals = typeof b.animals_props === 'object' ? Object.entries(b.animals_props).filter(([k, v]) => new RegExp('\\b' + k + '\\b', 'i').test((sc?.image_prompt || '') + ' ' + names.join(' ')) || new RegExp(String(k).split(' ').pop(), 'i').test(sc?.image_prompt || '')) : [];
  const w = wardrobe.map(([k, v]) => `${k}: ${v}`).join('; ');
  const a = animals.map(([k, v]) => `${k}: ${v}`).join('; ');
  const text = ` FACES, HAIR AND BODY exactly as on the character sheets.${w ? ` CLOTHES — the same in every picture of this song, exactly: ${w}. Do not change any colour or garment.` : ''}${a ? ` ANIMALS/OBJECTS — exactly: ${a}.` : ''}${p.visual_plan?.costume_sheet ? ' The attached costume line-up of this song shows the exact clothes and animals — match it.' : ''} ${QUALITY}`;
  // Who may be in the picture: the plate's characters plus anyone from the wardrobe named in the prompt. Nobody else.
  const named = Object.keys(wb).filter((k) => new RegExp('\\b' + k + '\\b', 'i').test(sc?.image_prompt || ''));
  const expected = [...new Set([...names, ...named])];
  const nobody = !expected.length ? ' NO PEOPLE AT ALL in this picture — only the animals/objects described. Do not draw any child or adult.' : ` Exactly these people and nobody else: ${expected.join(', ')}.`;
  return { text: nobody + text, wardrobe: w, animals: a, expected };
}

// Picture vs the character sheets + channel rules (+ the song's wardrobe and animal looks).
// Width/height from the file header (JPEG, PNG, WebP) — no extra packages.
function imgSize(b) {
  try {
    if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const t = b.toString('ascii', 12, 16);
      if (t === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (t === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (t === 'VP8L') { const n = b.readUInt32LE(21); return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 }; }
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      for (let i = 2; i < b.length - 9;) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch {}
  return null;
}

async function checkImage({ buffer, mime }, refs, channelId, prompt, lock = {}) {
  // A scene picture must be a 16:9 frame. Other shapes are usually a screenshot of the site (an "analysis" page, a chat) — reject without asking the model.
  const dim = imgSize(buffer);
  if (!lock.sheet && dim && dim.w && dim.h && (dim.w / dim.h < 1.55 || dim.w / dim.h > 1.95)) return { ok: false, score: 0, problems: [`not a 16:9 scene picture (${dim.w}x${dim.h}) — probably a screenshot of the website`], characters: [] };
  if (lock.place) {
    // An empty set / location picture: only check that it is empty, clean and usable as a background.
    const { json } = await llm.vision(`This picture must be an EMPTY location for a kids' 3D cartoon (a film set with nobody in it). It was asked for as: ${prompt}
Check: are there ANY people, characters or animals in it? any text, letters, logo or watermark (look at all four corners)? is it a screenshot of a website? does it match the asked place reasonably well? Score 0-10 for a clean, beautiful, usable background.
Reply JSON: {"people_or_animals":true|false,"watermark":true|false,"text":true|false,"screenshot":true|false,"matches":true|false,"score":0-10,"problems":["max 3, under 15 words"]}`, [{ mime: mime || 'image/png', data: buffer.toString('base64') }], { temperature: 0 });
    const bad = json.people_or_animals || json.watermark || json.text || json.screenshot || json.matches === false;
    return { ok: !bad && (json.score ?? 7) >= 6, score: json.score ?? null, problems: (json.problems || []).slice(0, 3), characters: [] };
  }
  if (!lock.sheet && await isOneOf(buffer, refs)) return { ok: false, score: 0, problems: ['this is one of the uploaded character sheets, not a new scene'], characters: [] };
  const imgs = [{ mime: mime || 'image/png', data: buffer.toString('base64') }];
  for (const r of (refs || []).slice(0, 5)) imgs.push({ mime: 'image/jpeg', data: fs.readFileSync(r).toString('base64') });
  const names = (refs || []).map((r) => path.basename(r).replace(/^char_/, '').replace(/\.[^.]+$/, ''));
  const cast = (store.getChannel(channelId)?.cast || []).filter((c) => names.some((n) => n.toLowerCase() === String(c.name).toLowerCase()));
  const { json } = await llm.vision(`Image 1 is a new scene for a kids' cartoon. ${names.length ? `Images 2-${names.length + 1} are the references, in this order: ${names.map((n) => (/costume_sheet/.test(n) ? "THIS SONG'S COSTUME LINE-UP (exact clothes and animals)" : /^set_/.test(n) ? 'the LOCATION REFERENCE (the background must be this same place; ignore that it is empty)' : n + ' character sheet')).join(', ')}.` : ''}
The scene was asked for as: ${prompt}
${cast.length ? 'Locked looks: ' + cast.map((c) => `${c.name} — ${c.look}`).join('; ') : ''}
Channel rules: ${channelRules(channelId)}
${lock.wardrobe ? `THIS SONG'S CLOTHES (must be exact in every picture): ${lock.wardrobe}` : ''}
${lock.animals ? `THIS SONG'S ANIMALS/OBJECTS (must be exact): ${lock.animals}` : ''}
${lock.wardrobe ? "IMPORTANT: the character sheets are only for face, hair, headwear and body — they may show different clothes. Judge CLOTHES only against THIS SONG'S CLOTHES above, never against the sheets." : ''}
Step 1 — for EACH character, find them in image 1 and compare: face, hair (style, curls, braids, ribbons, flowers), headwear and body size with their character sheet${lock.wardrobe ? "; CLOTHES (each garment and its colour) with THIS SONG'S CLOTHES above — a different garment or colour is a MISMATCH even if it looks nice" : '; outfit and colours'}. A character missing from image 1 is MISSING.${lock.animals ? " Check every animal/object listed too (e.g. a cow with brown patches when it must be pure white is a MISMATCH) — give each its own entry in characters." : ''}
Step 2 — ${lock.sheet ? 'this picture IS meant to be a costume line-up (all characters standing in a row on a plain background) — that is fine; set "reference_sheet": false.' : 'is image 1 itself a character/reference sheet (the same character shown in several views side by side, plain studio background, a name label)? That is NOT a scene: set "reference_sheet": true.'}
${Array.isArray(lock.expected) && !lock.sheet ? `PEOPLE ALLOWED in image 1: ${lock.expected.length ? lock.expected.join(', ') + ' — nobody else (no extra children, no adults)' : 'NONE — the picture must show no people at all, only animals/objects'}. Count every person you can see and set "people_count"; set "extra_people": true if anyone is there who is not allowed.` : ''}
Step 2b — is image 1 a SCREENSHOT (a web page, chat, app panel, boxes with labels around objects, a white page around a smaller picture)? Set "screenshot": true. Is there ANY watermark or logo stamped on it (a small star/sparkle mark in a corner, an "AI"/"Imagined with AI" badge, a site logo or name)? Set "watermark": true. Look closely at all four corners.
Step 3 — also check: correct number of characters; no extra or duplicated characters or animals; headwear only on the character whose sheet has it; no text, letters or labels; nothing scary or unsafe; kids fully clothed; nobody chubby.
Step 3b — ANATOMY: for EVERY person and animal, count what you can see: legs, arms, heads, tails, horns, trunks, tusks, wings. Correct: people 2 arms 2 legs 5 fingers; cow/calf/dog/goat/horse/cat and other four-legged animals EXACTLY 4 legs, 1 tail, 1 head (cow 2 horns, udder only between the back legs); elephant 4 legs, 1 trunk, 1 tail, 0 or 2 tusks; birds 2 legs 2 wings. A leg hidden behind the body is fine; a 5th or 6th leg, a second tail or head, legs fused together or a body joined to another body is WRONG. Give each animal/person an entry in "anatomy".
Step 4 — does it look AI-made? extra/fused fingers, melted or warped faces or objects, plastic waxy skin, garbled background details, floating objects, stiff mannequin poses. Any of these is a problem and lowers the score.
Score: 9–10 only if every character matches; 6–8 tiny differences a viewer would not notice; below 6 if any MISMATCH, MISSING or extra character.
Reply JSON: {"anatomy":[{"who":"","legs":0,"ok":true,"why":"under 10 words"}],"screenshot":true|false,"watermark":true|false,"people_count":0,"extra_people":true|false,"reference_sheet":true|false,"characters":[{"name":"","verdict":"match|mismatch|missing","why":"under 12 words"}],"ok":true|false,"score":0-10,"problems":["max 3 items, each under 15 words"]}`, imgs, { temperature: 0 });
  if (Array.isArray(lock.expected) && !lock.sheet && (json.extra_people === true || (typeof json.people_count === 'number' && json.people_count > lock.expected.length))) return { ok: false, score: 2, problems: [`wrong people: ${json.people_count ?? '?'} people but only ${lock.expected.length ? lock.expected.join(', ') : 'none'} allowed`], characters: json.characters || [] };
  if (json.screenshot && !lock.sheet) return { ok: false, score: 0, problems: ['this is a screenshot of the website, not a scene picture'], characters: [] };
  const anat = (json.anatomy || []).filter((x) => x && x.ok === false);
  if (anat.length && !lock.sheet) return { ok: false, score: 2, problems: anat.slice(0, 2).map((x) => `wrong body: ${x.who}${x.legs ? ' has ' + x.legs + ' legs' : ''} — ${x.why || ''}`.slice(0, 140)), characters: json.characters || [] };
  if (json.watermark) return { ok: false, score: 2, problems: ['a watermark/logo is stamped on the picture — make it with a tool that does not add one'], characters: json.characters || [] };
  if (json.reference_sheet && !lock.sheet) return { ok: false, score: 0, problems: ['this is a character sheet, not a scene'], characters: [] };
  const bad = (json.characters || []).filter((c) => c.verdict && c.verdict !== 'match');
  const problems = [...bad.map((c) => `${c.name}: ${c.verdict} — ${c.why || ''}`), ...(json.problems || [])].slice(0, 3).map((x) => String(x).slice(0, 140));
  return { ok: !!json.ok && !bad.length && (json.score ?? 7) >= 6, score: bad.length ? Math.min(json.score ?? 5, 5) : json.score ?? null, problems, characters: json.characters || [] };
}

// Clip: 8 frames across the clip (one strip, in order) compared with the scene picture —
// identity AND how natural the motion looks.
async function checkClip(clipPath, imagePath, motionPrompt, channelId) {
  const { duration, fps: srcFps, height } = await media.probe(clipPath);
  if (!duration || duration < 1.2) return { ok: false, score: 0, problems: ['clip is too short or broken'] };
  // Choppy or tiny clips look like stop-motion / "AI slop" in the final video, whatever the content.
  if (srcFps && srcFps < 20) return { ok: false, score: 2, problems: [`choppy clip (${Math.round(srcFps)} fps) — looks like stop-motion`] };
  if (height && height < 400) return { ok: false, score: 2, problems: [`too small (${height}p) — blurry when enlarged`] };
  const strip = clipPath.replace(/\.[^.]+$/, '') + '__strip.jpg';
  const { spawn } = require('child_process');
  const fps = (16 / duration).toFixed(3);
  await new Promise((res, rej) => {
    const pr = spawn(store.getSettings().ffmpeg_path || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', clipPath, '-vf', `fps=${fps},scale=400:-2,tile=4x4`, '-frames:v', '1', '-q:v', '3', strip], { windowsHide: true });
    pr.on('close', (c) => (c === 0 ? res() : rej(new Error('could not read the clip'))));
    pr.on('error', rej);
  });
  // Hard guard before any AI look: the clip's first frame must look like OUR picture (catches demo/sample videos
  // a site shows on its page, and clips made from the wrong picture). Measured, not guessed: SSIM on small grey images.
  const sim = await new Promise((res) => {
    const { spawn: sp } = require('child_process');
    let err = '';
    const pr = sp(store.getSettings().ffmpeg_path || 'ffmpeg', ['-hide_banner', '-i', clipPath, '-i', imagePath, '-filter_complex', '[0:v]trim=start_frame=0:end_frame=1,scale=320:180,format=gray[a];[1:v]scale=320:180,format=gray[b];[a][b]ssim', '-frames:v', '1', '-f', 'null', '-'], { windowsHide: true });
    pr.stderr.on('data', (d) => (err += d));
    pr.on('close', () => { const m = err.match(/All:([0-9.]+)/); res(m ? +m[1] : null); });
    pr.on('error', () => res(null));
  });
  if (sim != null && sim < 0.2) { fs.rmSync(strip, { force: true }); return { ok: false, score: 0, natural: 0, flags: ['not made from our picture'], problems: [`clip does not start from the scene picture (match ${sim.toFixed(2)})`], match: sim }; }
  // Measured liveliness: average change between frames. Clips under ~1.4 look like a still picture with a wobble
  // (Anand: "static image motion"); real dancing/singing clips measure 2–10.
  const motion = await motionLevel(clipPath);
  if (motion != null && motion < MIN_MOTION) { fs.rmSync(strip, { force: true }); return { ok: false, score: 2, natural: 0, flags: ['too still'], problems: [`almost no movement (motion ${motion.toFixed(2)}) — looks like a still picture`], match: sim, motion }; }
  const imgs = [{ mime: 'image/jpeg', data: fs.readFileSync(imagePath).toString('base64') }, { mime: 'image/jpeg', data: fs.readFileSync(strip).toString('base64') }];
  fs.rmSync(strip, { force: true });
  const first = { ...(await clipVerdict(imgs, duration, motionPrompt, channelId)), motion };
  if (first.ok) return first;
  // Clearly bad (several problems or a low score): no second look needed — saves time.
  if ((first.flags || []).length >= 2 || (first.score ?? 5) <= 3) return { ...first, ok: false, problems: (first.problems || []).slice(0, 3) };
  // A second, independent look: a problem only counts when both looks see it (fewer good clips thrown away).
  const second = await clipVerdict(imgs, duration, motionPrompt, channelId).catch(() => first);
  if (second.ok) return { ...second, note: 'passed on second look' };
  const flags = first.flags.filter((f) => second.flags.some((g) => g.split(' ')[0] === f.split(' ')[0]));
  if (!flags.length && Math.max(first.score ?? 0, second.score ?? 0) >= 7) return { ...second, ok: true, flags: [], note: 'the two looks disagreed' };
  return { ...second, ok: false, flags: flags.length ? flags : second.flags, problems: (flags.length ? flags : second.problems).slice(0, 3) };
}

const MIN_MOTION = 1.25; // calm counting/pointing shots measure ~1.3–1.5; still pictures with a wobble measure ~1.0–1.2
function motionLevel(clipPath) {
  return new Promise((res) => {
    const { spawn } = require('child_process');
    let out = '';
    const pr = spawn(store.getSettings().ffmpeg_path || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', clipPath, '-vf', 'scale=320:180,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { windowsHide: true });
    pr.stdout.on('data', (d) => (out += d));
    pr.on('close', () => { const v = [...out.matchAll(/YAVG=([\d.]+)/g)].map((m) => +m[1]); res(v.length ? v.reduce((a, b) => a + b, 0) / v.length : null); });
    pr.on('error', () => res(null));
  });
}

async function clipVerdict(imgs, duration, motionPrompt, channelId) {
  const { json } = await llm.vision(`Image 1 is the approved scene picture. Image 2 is a grid of 16 frames from a ${duration.toFixed(1)}-second clip made from it, in time order (row by row, left to right).
The motion asked for: ${motionPrompt || '(natural movement)'}
Channel rules: ${channelRules(channelId)}
Check 1 — identity: the same characters as image 1 in every frame (faces, hair, outfits, colours, body size); no extra, duplicated or vanishing characters or animals. Normal changes are FINE and must not fail this check: different expressions, mouths opening, head turns, small pose changes, slight lighting change. A small site logo/watermark in a corner (e.g. "Dola AI") is fine. Fail identity only when a character clearly becomes someone else (different outfit colour, face, hair) or appears/disappears.
Check 2 — does the motion look like real, high-quality animation (not "AI")? Look for: limbs that bend wrongly, melt, stretch like rubber or change length; hands/fingers that warp; faces that distort between frames; feet sliding or floating instead of planted; everyone doing identical robotic moves; motion that is jerky or teleports between frames; characters frozen like a still photo; camera drifting away. FAIL also if: more than two different moves happen in this short clip (looks hectic and AI-made); anyone spins, turns their back or blurs from fast motion; the camera suddenly zooms or reframes so characters are cut off at the edges. Natural signs: weight shifts, small secondary movement (hair, cloth), gentle expressions.
Check 3 — nothing scary or unsafe.
Answer each question by looking at the frames one after another:
- distinct_moves: how many clearly different actions/dance moves happen (e.g. wave, then spin, then clap = 3)?
- spin_or_back_turned: does anyone spin around, turn their back to the camera, or blur from very fast motion in any frame?
- zoom_crops: does the framing change during the clip so that a character is cut off at the edge (or leaves the frame) in later frames?
- warping: does any face, hand, limb or outfit melt, stretch, duplicate or change shape between frames?
- passes_through: does any character or animal walk/slide THROUGH or BEHIND another character, animal or object and come out the other side, or swap from in front to behind it (e.g. a kid moves from in front of the cow to behind it)? Real bodies cannot pass through each other — this is the clearest "AI" look.
- backwards_or_flying: does anyone or anything move backwards in a strange way (jumps forward but lands going backwards, moonwalks), or does any object move, fly, jump off a table or get thrown BY ITSELF without a hand moving it?
- extra_limbs: in ANY frame, does an animal show more than 4 legs (birds 2), a second tail or head, or a person a third arm/leg — or do legs split, merge or multiply while walking?
- body_changes: does any animal's body change shape or size (legs get shorter, becomes a dwarf/mini cow, two heads or bodies, splits), or do the kids look older/taller/different age or a different face than in image 1?
- blurry: is the main character smeared or blurred in several frames?
- frozen: is it a completely still picture with no movement at all? (Calm, gentle movement — swaying, nodding, blinking, ears or tail moving — is NOT frozen; we ask for calm motion on purpose.)
Reply JSON: {"identity_ok":true|false,"distinct_moves":0,"spin_or_back_turned":true|false,"zoom_crops":true|false,"warping":true|false,"passes_through":true|false,"extra_limbs":true|false,"backwards_or_flying":true|false,"body_changes":true|false,"blurry":true|false,"frozen":true|false,"natural_motion":0-10,"score":0-10,"problems":["max 3 items, each under 15 words"]}`, imgs, { temperature: 0, strong: true });
  const natural = json.natural_motion ?? json.score ?? 7;
  const flags = [];
  if (json.identity_ok === false) flags.push('characters change during the clip');
  if ((json.distinct_moves ?? 1) > 2) flags.push(`too many moves (${json.distinct_moves}) in one short clip — looks hectic`);
  if (json.spin_or_back_turned) flags.push('spins / turns back / motion blur');
  if (json.zoom_crops) flags.push('camera zooms and cuts characters off');
  if (json.warping) flags.push('faces or limbs warp');
  if (json.passes_through) flags.push('someone passes through or behind another character/object (AI look)');
  if (json.extra_limbs) flags.push('extra or splitting legs / second tail (wrong anatomy)');
  if (json.backwards_or_flying) flags.push('strange backwards move or an object moves by itself');
  if (json.body_changes) flags.push('body shape, size or age changes (dwarf animal / older kids)');
  if (json.blurry) flags.push('main character blurry');
  if (json.frozen) flags.push('no real movement');
  const problems = [...flags, ...(json.problems || [])].slice(0, 3).map((x) => String(x).slice(0, 140));
  return { ok: !flags.length && (json.score ?? 7) >= 6 && natural >= 6, score: flags.length ? Math.min(json.score ?? 5, 5) : json.score ?? null, natural, flags, problems };
}

// ---------- Director's review of the finished video ----------
// Watches the final cut scene by scene (3 frames each) against the lyric line and the plan: does the picture show
// what the words say, and is the animation clean (no dwarf animals, older-looking kids, flying objects, weird bodies)?
async function directorReview(project, finalPath, { onStep = () => {} } = {}) {
  const { spawn } = require('child_process');
  const intro = project.edit?.intro_len || 0;
  const scenes = (project.scenes || []).filter((s) => s.video);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dirrev-'));
  const grab = (t, out) => new Promise((res) => { const pr = spawn(store.getSettings().ffmpeg_path || 'ffmpeg', ['-y', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', finalPath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', out], { windowsHide: true }); pr.on('close', () => res(out)); pr.on('error', () => res(null)); });
  const strip = (files, out) => new Promise((res) => { const pr = spawn(store.getSettings().ffmpeg_path || 'ffmpeg', ['-y', '-loglevel', 'error', ...files.flatMap((f) => ['-i', f]), '-filter_complex', `hstack=inputs=${files.length}`, out], { windowsHide: true }); pr.on('close', () => res(out)); pr.on('error', () => res(null)); });
  const issues = [];
  const ch = store.getChannel(project.channel) || {};
  try {
    for (let i = 0; i < scenes.length; i += 6) {
      const batch = scenes.slice(i, i + 6);
      onStep(`Director watching scenes ${batch[0].n}–${batch[batch.length - 1].n}`);
      const imgs = [];
      for (const s of batch) {
        const fr = [];
        for (const k of [0.2, 0.5, 0.85]) fr.push(await grab(intro + s.start + (s.end - s.start) * k, path.join(work, `s${s.n}_${k}.jpg`)));
        imgs.push(await strip(fr.filter(Boolean), path.join(work, `strip${s.n}.jpg`)));
      }
      const list = batch.map((s, k) => `Image ${k + 1} = scene ${s.n} (3 frames: start, middle, end). Lyric (${ch.language || ''}): "${s.lyric || '(instrumental music)'}"`).join('\n');
      const { json } = await llm.vision(`You are the DIRECTOR of a big Cocomelon-style 3D kids song channel, checking the final edit before upload. Characters: ${(ch.cast || []).map((c) => c.name + ' — ' + c.look).join('; ')}.
Song: "${project.title}". Story and names come from the lyrics below (e.g. a named calf is a calf, not the elephant mascot) — judge only against them:
${String(project.song?.lyrics || '').slice(0, 3000)}
${list}
For each scene judge:
1. matches_lyric: does the picture SHOW what the lyric line says (who, what action, which animal/object)? e.g. a line about a rooster crowing and the sun rising must show a rooster and a sunrise; "come come kids" must show kids beckoning; "grandmother gave milk" must show grandmother giving milk.
2. clean: is the animation clean — no animal that changes size/shape or has short dwarf legs, no kids that look older or different, no object moving or flying by itself, no strange backwards jump, no blur, no body passing through another?
Reply JSON: {"scenes":[{"scene":0,"matches_lyric":true,"clean":true,"problem":"under 15 words, empty if fine","fix":"what the scene should show, under 20 words"}]}`, imgs.map((f) => ({ mime: 'image/jpeg', data: fs.readFileSync(f).toString('base64') })), { temperature: 0, strong: true });
      for (const r of json?.scenes || []) if (r && (r.matches_lyric === false || r.clean === false)) issues.push({ scene: +r.scene, matches_lyric: r.matches_lyric !== false, clean: r.clean !== false, problem: String(r.problem || '').slice(0, 160), fix: String(r.fix || '').slice(0, 200) });
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  return { ok: !issues.length, issues, checked: scenes.length };
}

module.exports = { directorReview, imgSize, checkImage, checkClip, isOneOf, lockFor, QUALITY };
