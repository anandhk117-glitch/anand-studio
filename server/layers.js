// The layer engine: every making-stage (images, videos, voice, music) has an ordered list of tools.
// The brain tries them in order; if one runs out (budget, daily limit, error) it moves to the next.
const fs = require('fs');
const path = require('path');
const store = require('./store');

const FILE = path.join(store.P.root, 'config', 'layers.json');
const DEFAULT = { images: ['browser_agent', 'hf_space_ref', 'manual'], videos: ['kaggle_wan', 'browser_agent', 'wan', 'hf_space', 'manual'], voice: ['voicebox', 'google_tts', 'manual'], music: ['claude_browser', 'manual'] };
const order = (stage) => (store.readJSON(FILE, DEFAULT)[stage] || DEFAULT[stage] || []);
function setOrder(stage, list) {
  const cur = store.readJSON(FILE, { ...DEFAULT });
  cur[stage] = list.filter((x) => TOOLS[x]);
  store.writeJSON(FILE, cur);
  return cur[stage];
}

// What each tool is and whether it can run right now.
const TOOLS = {
  hf_space_ref: { name: 'Free HF Spaces with your character sheets (FLUX.2 Klein / Qwen Edit / FLUX.2 Dev)', stages: ['images'], auto: true, ready: (s) => !!s.hf_token },
  hf_space: { name: 'Free Hugging Face Spaces (FLUX images, Wan/LTX clips)', stages: ['images', 'videos'], auto: true, ready: (s) => !!s.hf_token },
  google_image: { name: 'Gemini image (Google credit)', stages: ['images'], auto: true, ready: (s) => !!s.google_api_key && !s.free_only },
  huggingface: { name: 'Hugging Face (free token)', stages: ['images'], auto: true, ready: (s) => !!s.hf_token },
  google_veo: { name: 'Veo (Google credit — expensive)', stages: ['videos'], auto: true, ready: (s) => !!s.google_api_key && !s.free_only },
  kaggle_wan: { name: 'Kaggle free GPU — Wan 2.2 (your free Kaggle account, ~30 h/week)', stages: ['videos'], auto: true, ready: (s) => !!s.kaggle_username && !!s.kaggle_key },
  wan: { name: 'Wan 3.0 (Alibaba free quota)', stages: ['videos'], auto: true, ready: (s) => !!s.wan_api_key },
  voicebox: { name: 'Voicebox on this PC (free, no limit — Legends narrator)', stages: ['voice'], auto: true, ready: () => require('fs').existsSync(require('path').join(process.env.LOCALAPPDATA || '', 'Voicebox', 'voicebox.exe')) },
  google_tts: { name: 'Gemini voice (Google credit)', stages: ['voice'], auto: true, ready: (s) => !!s.google_api_key },
  browser_agent: { name: 'Free browser agent in Studio Chrome (Flow / Meta AI pictures, Vibes / Grok clips)', stages: ['images', 'videos'], auto: true, ready: (s) => s.browser_agent !== false },
  claude_browser: { name: 'Claude Code in your Chrome (Suno / Flow / Vibes·Grok·Dola)', stages: ['images', 'videos', 'voice', 'music'], auto: false, ready: (s, stage) => !!s.claude_auto && (!stage || (s.claude_stages || []).includes(stage)) },
  browser_worker: { name: 'Free browser worker (Suno/Grok/Vibes)', stages: ['music', 'videos'], auto: false, ready: (s) => !!s.browser_worker },
  image_zoom: { name: 'Slow zoom on the image (no clip — lowers retention, off by default)', stages: ['videos'], auto: true, ready: () => true },
  manual: { name: 'You add the file', stages: ['images', 'videos', 'voice', 'music'], auto: false, ready: () => true },
};

function plan(stage) {
  const s = store.getSettings();
  return order(stage).filter((t) => TOOLS[t] && TOOLS[t].stages.includes(stage)).map((t) => ({ id: t, ...TOOLS[t], ready: TOOLS[t].ready(s, stage) }));
}

// Which character sheets to send with a scene: the ones whose name appears in the prompt, else the first ones.
function refsFor(p, prompt) {
  const dir = path.join(store.P.brand, p.channel, 'characters');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  const low = String(prompt || '').toLowerCase();
  const hit = files.filter((f) => /^char_/i.test(f) && new RegExp('\\b' + f.replace(/^char_/i, '').replace(/\.[^.]+$/, '').split(/[_ -]/)[0].toLowerCase() + '\\b').test(low));
  return hit.slice(0, 4).map((f) => path.join(dir, f)); // nobody named → no sheets (so no extra kids appear)
}

const pad = (n) => String(n).padStart(2, '0');
function saveScene(id, n, patch) {
  const q = store.getProject(id);
  q.scenes = q.scenes.map((x) => (x.n === n ? { ...x, ...patch } : x));
  return q;
}

// Runs the automatic tools for a stage. Returns { done, left, stoppedAt, notes }.
async function make(id, stage, step = () => {}) {
  const notes = [];
  for (const tool of plan(stage)) {
    const p = store.getProject(id);
    const ch = store.getChannel(p.channel);
    const dir = store.projectDir(id);
    if (!tool.ready) { notes.push(`${tool.name}: not set up`); continue; }
    if (!tool.auto) return { handoff: tool.id, notes };
    try {
      if (stage === 'images') {
        // Plates: one picture per plate; every scene on that plate shares it.
        const sharePlates = () => {
          const q = store.getProject(id);
          const byPlate = new Map((q.scenes || []).filter((x) => x.plate && x.image).map((x) => [x.plate, x]));
          let changed = false;
          q.scenes = (q.scenes || []).map((x) => (!x.image && x.plate && byPlate.has(x.plate) ? (changed = true, { ...x, image: byPlate.get(x.plate).image, image_source: byPlate.get(x.plate).image_source, image_check: byPlate.get(x.plate).image_check }) : x));
          if (changed) store.saveProject(q);
        };
        sharePlates();
        // Costume line-up for THIS song first (all characters in this song's clothes + its animals),
        // then it goes with every scene picture so clothes and animal colours never change.
        if (tool.id === 'browser_agent' && store.getProject(id).visual_plan?.bible?.wardrobe && !store.getProject(id).visual_plan?.costume_sheet) {
          const q = store.getProject(id);
          const b = q.visual_plan.bible;
          const names = Object.keys(b.wardrobe || {});
          const animals = Object.keys(b.animals_props || {});
          const sheetSc = { n: 0, characters: names, image_prompt: `${ch.visual_style || ''} COSTUME LINE-UP for one song: ${names.join(', ')}${animals.length ? ' and ' + animals.join(', ') : ''} standing in one row, left to right in that order, full body, front view, facing the camera, relaxed natural pose, on a plain light warm-grey studio background with a soft floor shadow. Exactly ${names.length} characters${animals.length ? ' plus ' + animals.length + ' animal(s)/object(s)' : ''}. No text, letters, names or labels. 16:9` };
          step('Costume line-up for this song (clothes + animals, used for every scene)');
          try {
            const img = await require('./browser').makeImage(q, sheetSc, refsFor(q, names.join(' ')), step, { sheet: true });
            const file = `costume_sheet.${img.ext}`;
            fs.writeFileSync(path.join(dir, file), img.buffer);
            const q2 = store.getProject(id); q2.visual_plan.costume_sheet = file;
            store.log(q2, 'Visual director', `Costume line-up made — check ${img.check?.score ?? '?'}/10; every scene now matches it`);
            store.saveProject(q2);
          } catch (e) {
            if (e.blocked) throw e;
            const q2 = store.getProject(id); store.log(q2, 'Visual director', 'Costume line-up not right yet — scenes use the written wardrobe for now'); store.saveProject(q2);
          }
        }
        // FIXED SETS (studio production): one empty reference picture per location, made once, then attached to every
        // picture shot there, so the houses, tree and colours never change between shots.
        const plateOf = (sc) => (store.getProject(id).visual_plan?.plates || []).find((x) => String(x.id) === String(sc.plate));
        if (tool.id === 'browser_agent') {
          const q = store.getProject(id); const sets = q.visual_plan?.bible?.sets || {};
          const need = [...new Set((q.scenes || []).filter((x) => !x.image).map((x) => plateOf(x)?.set).filter((k) => k && sets[k] && !(q.visual_plan.set_sheets || {})[k] && (q.visual_plan.set_failed || {})[k] !== new Date().toISOString().slice(0, 10)))];
          for (const k of need) {
            const st = sets[k];
            step(`Set design: empty location picture for ${st.name || k} (every shot there will match it)`);
            try {
              const img = await require('./browser').makeImage(q, { n: 0, characters: [], image_prompt: `${ch.visual_style || ''} LOCATION REFERENCE for a film set — EMPTY, no characters, no people, no animals: ${st.description}. Wide establishing shot at eye level from the front, everything clearly visible, soft even daylight. No text. 16:9.` }, [], step, { plain: true });
              const file = `set_${k}.${img.ext}`;
              fs.writeFileSync(path.join(dir, file), img.buffer);
              const q2 = store.getProject(id); q2.visual_plan.set_sheets = { ...(q2.visual_plan.set_sheets || {}), [k]: file };
              store.log(q2, 'Set designer', `Fixed set made for ${st.name || k} — every shot there uses it as the background reference`);
              store.saveProject(q2);
            } catch (e) { if (e.blocked) throw e; { const q3 = store.getProject(id); q3.visual_plan.set_failed = { ...(q3.visual_plan.set_failed || {}), [k]: new Date().toISOString().slice(0, 10) }; store.saveProject(q3); } step(`Set design for ${k} not right yet — scenes use the written description (${e.message.slice(0, 80)})`); }
          }
        }
        const setRef = (sc) => { const q = store.getProject(id); const k = plateOf(sc)?.set; const f = k && q.visual_plan?.set_sheets?.[k]; return f && fs.existsSync(path.join(dir, f)) ? [path.join(dir, f)] : []; };
        const withSet = (sc) => (setRef(sc).length ? { ...sc, image_prompt: sc.image_prompt + ' BACKGROUND LOCK: the place must be exactly the attached location picture (same buildings, tree, arch, walls, colours and props), only seen from this shot\'s camera angle.' } : sc);
        // The costume line-up only goes with pictures that have people (it would put people into an animals-only shot).
        const sheetRef = (sc) => { const q = store.getProject(id); const f = q.visual_plan?.costume_sheet; return f && fs.existsSync(path.join(dir, f)) && (!sc || (sc.characters || []).length) ? [path.join(dir, f)] : []; };
        const seen = new Set();
        const todo = (store.getProject(id).scenes || []).filter((x) => !x.image && x.image_prompt && (!x.plate || !seen.has(x.plate)) && (x.plate ? seen.add(x.plate) : true));
        if (!todo.length) return { done: true, notes };
        const failedPlates = [];
        for (const sc of todo) {
          step(`${tool.name}: scene ${sc.n} (${todo.indexOf(sc) + 1}/${todo.length})`);
          let img;
          try {
          if (tool.id === 'google_image') img = await require('./google').image(sc.image_prompt, { refs: refsFor(p, sc.image_prompt), project: id });
          else if (tool.id === 'browser_agent') img = await require('./browser').makeImage(store.getProject(id), withSet(sc), [...refsFor(p, (sc.characters || []).join(' ') + ' ' + sc.image_prompt), ...sheetRef(sc), ...setRef(sc)], step);
          else if (tool.id === 'hf_space_ref') {
            // Free HF with sheets, checked against the sheets; remade once, then the next tool takes over.
            const refs = refsFor(p, (sc.characters || []).join(' ') + ' ' + sc.image_prompt);
            let last = null;
            for (let k = 0; k < 2 && !img; k++) {
              const lock = require('./quality').lockFor(store.getProject(id), sc);
              const cand = !refs.length ? await require('./hfspace').image(sc.image_prompt + lock.text) : await require('./hfspace').imageWithRefs(sc.image_prompt + lock.text + (k ? ' Follow the character sheets exactly.' : ''), refs);
              const c = await require('./quality').checkImage({ buffer: cand.buffer, mime: 'image/' + (cand.ext === 'jpg' ? 'jpeg' : cand.ext) }, [...refs, ...sheetRef(sc)], p.channel, sc.image_prompt, lock).catch(() => ({ ok: false, score: null, problems: ['the picture checker could not run'] }));
              last = c;
              if (c.ok) img = { ...cand, check: c };
            }
            if (!img) throw new Error(`picture failed the check twice (${(last?.problems || []).slice(0, 2).join('; ')})`);
          }
          else if (tool.id === 'hf_space') img = await require('./hfspace').image(sc.image_prompt);
          else img = await require('./hf').textToImage(sc.image_prompt);
          } catch (e) {
            if (e.blocked || e.quota) throw e; // sign-in / human check / checker limit: stop, don't burn the other plates
            failedPlates.push(`${sc.plate || 'scene ' + sc.n}: ${e.message.split(' | ')[0].slice(0, 160)}`);
            const q0 = store.getProject(id);
            store.log(q0, 'Picture checker', `${sc.plate ? 'Plate ' + sc.plate : 'Scene ' + sc.n} not right yet with ${tool.name} — moving on, will retry`);
            store.saveProject(q0);
            continue;
          }
          const file = `scene_${pad(sc.n)}.${img.ext}`;
          for (const old of fs.readdirSync(dir)) if (old.startsWith(`scene_${pad(sc.n)}.`)) fs.unlinkSync(path.join(dir, old));
          fs.writeFileSync(path.join(dir, file), img.buffer);
          const q = saveScene(id, sc.n, { image: file, image_source: tool.id, ...(img.check ? { image_check: img.check } : {}) });
          store.log(q, 'Visual director', `${sc.plate ? 'Plate ' + sc.plate + ' (scene ' + sc.n + ')' : 'Scene ' + sc.n} picture by ${tool.name}${img.check ? ` — check ${img.check.score}/10` : ''}`);
          store.saveProject(q);
          sharePlates();
        }
        if (failedPlates.length) throw new Error(`${failedPlates.length} picture(s) still not right: ${failedPlates.join(' || ')}`);
        return { done: true, notes };
      }
      if (stage === 'videos') {
        if (tool.id === 'image_zoom') {
          const q = store.getProject(id); q.allow_image_scenes = true;
          store.log(q, 'Motion director', 'Scenes without a clip will use a slow zoom on their image');
          store.saveProject(q);
          return { done: true, notes };
        }
        // Clips saved while the checker was out of free quota get checked now; a bad one is made again.
        for (const sc of (p.scenes || []).filter((x) => x.video && x.clip_check?.pending && x.image)) {
          const cc = await require('./quality').checkClip(path.join(dir, sc.video), path.join(dir, sc.image), sc.motion_prompt, p.channel).catch((e) => (e.quota ? null : { ok: true, score: null, problems: ['check failed'] }));
          if (!cc) break;
          const q0 = saveScene(id, sc.n, cc.ok ? { clip_check: cc } : { clip_check: cc, redo: true });
          store.log(q0, 'Clip checker', `Scene ${sc.n}: earlier clip ${cc.ok ? 'passed' : 'rejected (' + (cc.problems || []).slice(0, 2).join('; ') + ') — making it again'}`);
          store.saveProject(q0);
        }
        const todo = (store.getProject(id).scenes || []).filter((x) => x.image && (!x.video || x.redo));
        // Scenes that share a picture go one after another: one Vibes send (4 takes) can then fill several scenes.
        const perPlate = {}; for (const x of todo) perPlate[x.image] = (perPlate[x.image] || 0) + 1;
        todo.sort((a, b) => (perPlate[b.image] - perPlate[a.image]) || String(a.image).localeCompare(String(b.image)) || a.n - b.n);
        if (!todo.length) return { done: true, notes };
        const clipTries = new Map();
        const skipped = [];
        const pairs = new Map(); // head scene → next scene, when one 10 s clip covers both
        const splitDone = new Set();
        for (const sc of todo) {
          if (splitDone.has(sc.n)) continue; // its clip came from the 10 s clip of the scene before
          step(`${tool.name}: scene ${sc.n} (${todo.indexOf(sc) + 1}/${todo.length})`);
          // After a rejected clip the motion is made calmer — the same prompt usually fails the same way.
          const calm = (sc.clip_rejects || 0) > 0 || clipTries.get(sc.n);
          const base = sc.motion_prompt || sc.vision || sc.lyric || 'Gentle natural movement.';
          const prompt = calm ? calmMotion(base, sc.clip_check?.problems || []) : base;
          if (calm) step(`${tool.name}: scene ${sc.n} — calmer motion this time (${(sc.clip_check?.problems || []).slice(0, 1).join('') || 'earlier clip rejected'})`);
          // after a re-timing another scene may already use s_NN.mp4 — never overwrite its clip
          const file = (store.getProject(id).scenes || []).some((x) => x.n !== sc.n && x.video === `s_${pad(sc.n)}.mp4`) ? `s_${pad(sc.n)}_${Date.now().toString(36)}.mp4` : `s_${pad(sc.n)}.mp4`;
          // Spare takes: Vibes makes 4 clips per send. Every take is kept in takes/ and used first by any
          // scene that shares the same picture, before a new generation is spent.
          const poolDir = path.join(dir, 'takes'); fs.mkdirSync(poolDir, { recursive: true });
          // Spare takes are shared only between scenes with the SAME action (same motion prompt) — a take made for
          // another line's action is never reused (that made characters repeat the same move again and again).
          const act = require('crypto').createHash('md5').update(String(base).slice(0, 400)).digest('hex').slice(0, 8);
          // Continuous shot: this scene starts from the LAST frame of the previous scene's clip (no visible cut).
          let startImg = path.join(dir, sc.image);
          let contKey = '';
          if (sc.continue_previous) {
            const prev = (store.getProject(id).scenes || []).find((x) => x.n === sc.n - 1);
            if (prev?.video && !prev.redo && fs.existsSync(path.join(dir, prev.video))) {
              const lf = path.join(dir, `cont_${pad(sc.n)}.jpg`);
              await new Promise((res) => { const pr = require('child_process').spawn(store.getSettings().ffmpeg_path || 'ffmpeg', ['-y', '-loglevel', 'error', '-sseof', '-0.15', '-i', path.join(dir, prev.video), '-frames:v', '1', '-q:v', '2', lf], { windowsHide: true }); pr.on('close', res); pr.on('error', res); });
              if (fs.existsSync(lf)) { startImg = lf; contKey = `cont${pad(sc.n)}_${path.parse(prev.video).name}`; }
            } else if (!sc._deferred && todo.some((x) => x.n === sc.n - 1)) { todo.push({ ...sc, _deferred: true }); continue; }
          }
          const plate = contKey || `${path.parse(sc.image).name}~${act}`;
          const poolFor = () => fs.readdirSync(poolDir).filter((f) => f.startsWith(plate + '__') && f.endsWith('.mp4')).sort();
          let fromPool = poolFor();
          let source = tool.id;
          if (fromPool.length) step(`${tool.name}: scene ${sc.n} — trying ${fromPool.length} spare take(s) of the same picture first (no new generation)`);
          else {
            const stamp = Date.now();
            const put = (buf, k, src) => { const n = `${plate}__${src}__${stamp}_${k}.mp4`; fs.writeFileSync(path.join(poolDir, n), buf); return n; };
            if (tool.id === 'kaggle_wan') {
              // One Kaggle run makes the clips for this scene AND the next waiting scenes (batch), each into its own pool slot.
              const crypto = require('crypto');
              const batch = [{ sc, key: plate, prompt, img: startImg }];
              for (const o of todo) {
                if (batch.length >= (+store.getSettings().kaggle_batch || 6)) break;
                if (o === sc || o.continue_previous || batch.some((b) => b.sc.n === o.n)) continue;
                const ob = o.motion_prompt || o.vision || o.lyric || 'Gentle natural movement.';
                const oKey = `${path.parse(o.image).name}~${crypto.createHash('md5').update(String(ob).slice(0, 400)).digest('hex').slice(0, 8)}`;
                if (fs.readdirSync(poolDir).some((f) => f.startsWith(oKey + '__'))) continue;
                batch.push({ sc: o, key: oKey, prompt: (o.clip_rejects || 0) > 0 ? calmMotion(ob, o.clip_check?.problems || []) : ob, img: path.join(dir, o.image) });
              }
              const r = await require('./kaggle').runBatch(batch.map((b) => ({ id: 's' + b.sc.n, imagePath: b.img, prompt: b.prompt })), { onStep: (m) => step(`${m} — scenes ${batch.map((b) => b.sc.n).join(', ')}`) });
              for (const b of batch) if (r.clips['s' + b.sc.n]) fs.writeFileSync(path.join(poolDir, `${b.key}__kaggle_wan__${stamp}_0.mp4`), r.clips['s' + b.sc.n]);
              if (!r.clips['s' + sc.n]) throw new Error('Kaggle made no clip for scene ' + sc.n + (r.log?.errors?.[0] ? ' (' + r.log.errors[0].error.slice(0, 120) + ')' : ''));
            } else if (tool.id === 'hf_space') {
              const v = await require('./hfspace').video(startImg, prompt, sc.len);
              put(v.buffer, 0, tool.id);
            } else if (tool.id === 'browser_agent') {
              // Calm continuous shot: the next scene continues this one on the same picture → ask ONE 10-second clip
              // for both (one send instead of two). If no 10 s site works, the normal 5 s clip is made.
              const nx = !calm && !sc.continue_previous ? (store.getProject(id).scenes || []).find((x) => x.n === sc.n + 1 && x.continue_previous && x.image === sc.image && (!x.video || x.redo) && !(x.clip_rejects > 0)) : null;
              let v = null;
              if (nx && (+sc.len || 5) + (+nx.len || 5) <= 10.6) {
                const nb = nx.motion_prompt || nx.vision || nx.lyric || '';
                v = await require('./browser').makeClip(p, { ...sc, motion_prompt: `${prompt} Then, continuing smoothly in the same shot: ${nb}` }, startImg, step, { long: true }).catch((e) => { step(`${tool.name}: no 10 s clip (${e.message.split(' | ')[0].slice(0, 90)}) — making the normal clip`); return null; });
                if (v) pairs.set(sc.n, nx.n);
              }
              if (!v) v = await require('./browser').makeClip(p, { ...sc, motion_prompt: prompt }, startImg, step);
              (v.takes || [v]).forEach((t, k) => put(t.buffer, k, tool.id));
              if ((v.takes || []).length > 1) step(`${tool.name}: scene ${sc.n} — ${v.takes.length} takes saved; spares go to the other scenes of this picture`);
            } else if (tool.id === 'google_veo') {
              const v = await require('./google').video(startImg, prompt, sc.len, { project: id, onTick: (st) => step(`${tool.name}: scene ${sc.n} ${st} (${todo.indexOf(sc) + 1}/${todo.length})`) });
              put(v.buffer, 0, tool.id);
            } else {
              const wan = require('./wan');
              const task = await wan.createTask({ imagePath: startImg, prompt, duration: Math.max(2, Math.min(30, Math.ceil(sc.len))) });
              const out = await wan.waitTask(task, (st) => step(`${tool.name}: scene ${sc.n} ${String(st).toLowerCase()} (${todo.indexOf(sc) + 1}/${todo.length})`));
              const tmp = path.join(poolDir, `${plate}__${tool.id}__${stamp}_0.mp4`);
              await wan.download(out.url, tmp);
            }
            fromPool = poolFor();
          }
          // Clip checker: all takes of this picture are checked AT THE SAME TIME (fast); the best passing take is used,
          // the other passing takes stay as spares for the next scenes of the same picture, failed takes are thrown away.
          let cc = null;
          const verdicts = await Promise.all(fromPool.slice(0, 4).map(async (t) => {
            // No clip is used unchecked: if the checker is unavailable the take waits in the pool for a later check.
            const v = await require('./quality').checkClip(path.join(poolDir, t), startImg, prompt, p.channel).catch((e) => ({ ok: false, pending: true, score: null, problems: ['waiting for the clip checker (' + (e.quota ? 'free checker limit' : 'checker error') + ')'] }));
            return { t, v };
          }));
          for (const { t, v } of verdicts) if (!v.ok && !v.pending) { fs.rmSync(path.join(poolDir, t), { force: true }); store.log(store.getProject(id), 'Clip checker', `Scene ${sc.n}: one take rejected (${(v.problems || []).slice(0, 2).join('; ')})`); }
          // best = highest score; between equal scores the livelier take wins
          const best = verdicts.filter((x) => x.v.ok).sort((a, b) => ((b.v.score ?? 0) - (a.v.score ?? 0)) || ((b.v.motion ?? 0) - (a.v.motion ?? 0)))[0];
          if (best) {
            fs.copyFileSync(path.join(poolDir, best.t), path.join(dir, file));
            fs.rmSync(path.join(poolDir, best.t), { force: true });
            source = best.t.split('__')[1] || tool.id; cc = best.v;
            const spare = verdicts.filter((x) => x.v.ok && x !== best).length;
            if (spare) step(`${tool.name}: scene ${sc.n} — ${spare} more good take(s) kept for the next scenes of this picture`);
          } else cc = verdicts.length ? verdicts[verdicts.length - 1].v : null;
          if (!cc) cc = { ok: false, problems: ['no clip came back'] };
          if (!cc.ok && cc.pending) { step(`${tool.name}: scene ${sc.n} — take kept, waiting for the clip checker`); skipped.push(sc.n); continue; }
          if (!cc.ok) {
            fs.rmSync(path.join(dir, file), { force: true });
            const tries = (clipTries.get(sc.n) || 0) + 1; clipTries.set(sc.n, tries);
            const q0 = saveScene(id, sc.n, { clip_check: cc, clip_rejects: (sc.clip_rejects || 0) + 1 });
            store.log(q0, 'Clip checker', `Scene ${sc.n}: clip from ${tool.name} rejected (${(cc.problems || []).slice(0, 2).join('; ')}) — ${tries < 2 ? 'making it again with calmer motion' : 'leaving it for the next tool, carrying on with the other scenes'}`);
            store.saveProject(q0);
            if (tries >= 2) { skipped.push(sc.n); continue; }
            todo.push({ ...sc, clip_check: cc });
            continue;
          }
          // A 10 s clip for two scenes: the first part is this scene, the rest is the next scene (same shot, no cut).
          const nxN = pairs.get(sc.n);
          if (nxN) {
            pairs.delete(sc.n);
            const full = path.join(dir, file);
            const dur = await clipDur(full);
            const nxs = (store.getProject(id).scenes || []).find((x) => x.n === nxN);
            if (nxs && dur >= (+sc.len || 5) + Math.min(+nxs.len || 5, 4) - 0.3) {
              const cut = Math.min(+sc.len || 5, dur / 2 + 0.6);
              const tmp = path.join(dir, `_long_${pad(sc.n)}.mp4`); fs.renameSync(full, tmp);
              const nfile = (store.getProject(id).scenes || []).some((x) => x.n !== nxN && x.video === `s_${pad(nxN)}.mp4`) ? `s_${pad(nxN)}_${Date.now().toString(36)}.mp4` : `s_${pad(nxN)}.mp4`;
              await ffcut(tmp, 0, cut, full); await ffcut(tmp, cut, dur - cut, path.join(dir, nfile));
              fs.rmSync(tmp, { force: true });
              const q2 = saveScene(id, nxN, { video: nfile, video_source: source + ' (10 s shot)', redo: false, clip_check: cc });
              store.log(q2, 'Motion director', `Scenes ${sc.n}+${nxN}: one 10 s continuous clip by ${tool.name} (one send for two scenes)`);
              store.saveProject(q2);
              splitDone.add(nxN);
            }
          }
          const q = saveScene(id, sc.n, { video: file, video_source: source, redo: false, clip_check: cc });
          store.log(q, 'Motion director', `Scene ${sc.n} clip by ${tool.name}${fromPool.length > 1 || source !== tool.id ? ' (spare take)' : ''}`);
          store.saveProject(q);
        }
        if (skipped.length) throw new Error(`scene${skipped.length > 1 ? 's' : ''} ${skipped.join(', ')}: clip failed the check twice — the next tool tries ${skipped.length > 1 ? 'them' : 'it'}`);
        return { done: true, notes };
      }
      if (stage === 'voice') {
        if (!p.script?.text) throw new Error('No approved script.');
        step(`${tool.name}: recording the narration`);
        const clean = p.script.text.replace(/^\s*\[[^\]]*\]\s*$/gm, '').replace(/\(verify\)/gi, '').trim();
        const style = `Read this as "The Decoder": a calm, precise, intriguing documentary narrator. Natural pauses between sections.\n\n`;
        if (tool.id === 'voicebox') await require('./voicebox').speech(clean, { outFile: path.join(dir, 'audio_narration.wav'), onStep: step });
        else await require('./google').speech(style + clean, { project: id, outFile: path.join(dir, 'audio_narration.wav') });
        const q = store.getProject(id);
        q.audio = [...(q.audio || []).filter((a) => a.label !== 'narration'), { file: 'audio_narration.wav', label: 'narration', added: new Date().toISOString(), source: tool.id }];
        store.log(q, 'Voice producer', `Narration recorded by ${tool.name}`);
        store.saveProject(q);
        return { done: true, measure: 'audio_narration.wav', notes };
      }
    } catch (e) {
      notes.push(`${tool.name}: ${e.message}`);
      if (e.quota) { const q = store.getProject(id); store.log(q, 'Brain', 'Free Gemini checker limit used up for today — pictures wait until it resets (about 12:30 PM IST)'); store.saveProject(q); return { done: false, notes, waiting: true }; }
      if (e.blocked && e.kind !== 'offline' && !/no internet right now/.test(e.message)) require('./notify').send(`Studio needs you once: ${e.message.split(' | ')[0]}`, { project: id, priority: 4 }).catch(() => {});
      const q = store.getProject(id);
      store.log(q, 'Brain', `${tool.name} stopped (${e.message.split('\n')[0]}) — trying the next tool`);
      store.saveProject(q);
    }
  }
  return { done: false, notes };
}


// Calmer motion prompt after a rejected clip: one small action, locked camera, nobody changes.
function ffcut(src, start, len, out) {
  return new Promise((res, rej) => {
    const pr = require('child_process').spawn(store.getSettings().ffmpeg_path || 'ffmpeg', ['-y', '-loglevel', 'error', '-ss', start.toFixed(2), '-i', src, '-t', len.toFixed(2), '-an', '-c:v', 'libx264', '-crf', '16', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', out], { windowsHide: true });
    let e = ''; pr.stderr.on('data', (d) => (e += d)); pr.on('close', (c) => (c ? rej(new Error(e.slice(-200))) : res(out))); pr.on('error', rej);
  });
}
function clipDur(f) {
  return new Promise((res) => {
    const pr = require('child_process').spawn(store.getSettings().ffprobe_path || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { windowsHide: true });
    let o = ''; pr.stdout.on('data', (d) => (o += d)); pr.on('close', () => res(parseFloat(o) || 0)); pr.on('error', () => res(0));
  });
}
function calmMotion(base, problems) {
  const pr = problems.join(' ').toLowerCase();
  // Rejected for being too still → ask for MORE visible movement, not less.
  if (/still|no movement|frozen|static/.test(pr)) {
    const first = String(base).split(/[.;]/)[0].replace(/^[^:]{3,40}:\s*/, '').trim().slice(0, 160);
    return [`${first}.`,
      'Lively, clearly visible movement from the first to the last frame: everyone sways and claps on the beat, nods, smiles and sings with mouths moving; the animals flick ears, swish tails and nod their heads.',
      'Real speed, smooth motion, no slow motion, no frozen moments. Everyone stays in the same place facing the camera. Locked camera.',
      'Keep every face, outfit, colour and body exactly as in the picture. No new characters or objects.'].join(' ');
  }
  const first = String(base).split(/[.;]/)[0].replace(/^[^:]{3,40}:\s*/, '').replace(/\b(form(s|ing)? a (small |big )?circle( and)?|in a circle|walk(s|ing)?|run(s|ning)?|spin\w*|turn(s)? (round|around)|jump(s|ing)?( up and down)?|dance(s)? wildly)\b/gi, '').replace(/\s{2,}/g, ' ').trim().slice(0, 160);
  return [`${first}.`,
    'Calm, gentle motion only: ONE small action (smile and nod, a soft wave, the animal flicks its ears and tail), slow and natural. Everyone stays in the same place facing the camera.',
    /zoom|cut|camera/.test(pr) ? 'Camera completely still: no zoom, no pan, no cuts; everyone stays fully in the frame.' : 'Locked camera, no zoom, no cuts.',
    /change|warp|face|limb/.test(pr) ? 'Keep every face, outfit, colour and body exactly as in the picture from the first to the last frame. No new characters or objects.' : 'Keep every character exactly as in the picture. No new characters.',
    'No spinning, no turning around, no jumping, no fast moves.'].join(' ');
}

module.exports = { TOOLS, plan, order, setOrder, make, refsFor };
