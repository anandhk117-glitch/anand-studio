// Thumbnails that win the click.
// 1. make(project): picks the strongest picture of the song (clean plate pictures + clip frames, no subtitles),
//    puts big native-language text on it with a thick outline, checks it, and makes an A/B second version.
// 2. doctor(channel): the weekly thumbnail doctor. Reads the channel's uploads (free YouTube key),
//    finds videos pulling fewer views per day than the channel's usual, compares their thumbnails with
//    the channel's winners and the niche's winners, and makes a replacement thumbnail for each.
//    Real CTR is only in YouTube Studio: Anand can paste it in config/ctr/<channel>.json ({"videoId": 6.5}).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const llm = require('./llm');

const FF = () => store.getSettings().ffmpeg_path || 'ffmpeg';
function ff(args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(FF(), ['-y', '-loglevel', 'error', ...args], { cwd, windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg: ' + err.slice(-300)))));
    p.on('error', reject);
  });
}
const b64 = (f) => ({ mime: 'image/jpeg', data: fs.readFileSync(f).toString('base64') });
const noEmoji = (s) => String(s || '').replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍⃣]/gu, '').replace(/\s+/g, ' ').trim();
const clusters = (s) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length;

// ---------- text on a picture (libass shapes Kannada / Hindi conjuncts correctly) ----------
const POS = { top: 8, bottom: 2, 'top-left': 7, 'top-right': 9, 'bottom-left': 1, 'bottom-right': 3 };
function assFor(text, { pos = 'top', font = 'Nirmala UI', color = '&H0000E6FF', accent = '&H00FFFFFF' } = {}) {
  const t = noEmoji(text);
  let lines = [t];
  if (clusters(t) > 11 && t.includes(' ')) { // two lines, split near the middle
    const words = t.split(' '); let best = 1, diff = 1e9;
    for (let i = 1; i < words.length; i++) { const d = Math.abs(clusters(words.slice(0, i).join(' ')) - clusters(words.slice(i).join(' '))); if (d < diff) { diff = d; best = i; } }
    lines = [words.slice(0, best).join(' '), words.slice(best).join(' ')];
  }
  const longest = Math.max(...lines.map(clusters));
  const size = Math.round(Math.max(78, Math.min(150, 1150 / (longest * 0.78))));
  const align = POS[pos] || 8;
  const body = lines.map((l, i) => (i === 0 ? `{\\c${color}}` : `{\\c${accent}}`) + l).join('\\N');
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: T,${font},${size},${color},${color},&H00100808,&H96000000,1,0,0,0,100,100,0,0,1,${Math.round(size / 11)},${Math.round(size / 22)},${align},40,40,34,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:05.00,T,,0,0,0,,${body}\n`;
}

// picture → 1280×720 thumbnail with text + small logo
async function render(src, text, out, { pos = 'top', logo, font, color } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-'));
  fs.writeFileSync(path.join(work, 't.ass'), assFor(text, { pos, font, color }));
  const base = `scale=1280:720:force_original_aspect_ratio=increase:flags=lanczos,crop=1280:720,eq=saturation=1.22:contrast=1.07:brightness=0.02,unsharp=5:5:0.7`;
  const args = ['-i', path.resolve(src)];
  let fc = `[0:v]${base}[b]`;
  let last = 'b';
  if (logo && fs.existsSync(logo)) { args.push('-i', path.resolve(logo)); fc += `;[1:v]scale=150:-1[lg];[b][lg]overlay=W-w-22:H-h-18[b2]`; last = 'b2'; }
  fc += `;[${last}]subtitles=t.ass[v]`;
  await ff([...args, '-filter_complex', fc, '-map', '[v]', '-frames:v', '1', '-q:v', '2', path.resolve(out)], work);
  fs.rmSync(work, { recursive: true, force: true });
  return out;
}

async function frameAt(video, t, out) {
  await ff(['-ss', String(Math.max(0, t)), '-i', video, '-frames:v', '1', '-vf', 'scale=1280:720:force_original_aspect_ratio=increase:flags=lanczos,crop=1280:720', '-q:v', '2', out]);
  return out;
}
async function small(src, out) { await ff(['-i', src, '-frames:v', '1', '-vf', 'scale=512:288:force_original_aspect_ratio=increase,crop=512:288', '-q:v', '4', out]); return out; }

const THUMB_RULES = `What wins the click on a kids channel (CTR):
- ONE clear hero (the animal / main kid) big in the frame, face and eyes clearly visible, a strong emotion (surprise, joy, wonder).
- Bright saturated colours, warm light, simple background; nothing dark, muddy or blurred; no tiny crowd shots.
- Curiosity: something is about to happen or a question (where did the calf go?), but never misleading.
- 2-4 big words, readable on a phone, in the channel language; text must not cover any face or the hero.
- Kids-safe: nothing scary, no danger, no clickbait arrows/red circles.`;

// ---------- 1. thumbnail for a finished song ----------
async function make(project, { onStep = () => {} } = {}) {
  const dir = store.projectDir(project.id);
  const ch = store.getChannel(project.channel) || {};
  const pub = project.publish || {};
  const text = pub.thumbnail_text || project.idea?.title || project.title;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbc-'));
  const cands = [];
  // clean plate pictures first (sharpest, no subtitles), then the middle of a few clips
  const seen = new Set();
  for (const s of project.scenes || []) {
    if (s.image && !seen.has(s.image) && fs.existsSync(path.join(dir, s.image))) { seen.add(s.image); cands.push({ kind: 'image', src: path.join(dir, s.image), scene: s.n }); }
  }
  const clips = (project.scenes || []).filter((s) => s.video && fs.existsSync(path.join(dir, s.video)) && (s.clip_check?.score || 0) >= 7);
  for (const s of clips.filter((_, i) => i % Math.max(1, Math.ceil(clips.length / 6)) === 0)) cands.push({ kind: 'clip', video: path.join(dir, s.video), t: (s.len || 5) / 2, scene: s.n });
  const pool = cands.slice(0, 16);
  onStep(`Thumbnail: looking at ${pool.length} pictures`);
  for (let i = 0; i < pool.length; i++) {
    const c = pool[i];
    c.full = path.join(work, `c${i}.jpg`);
    if (c.kind === 'image') await ff(['-i', c.src, '-frames:v', '1', '-vf', 'scale=1280:720:force_original_aspect_ratio=increase:flags=lanczos,crop=1280:720', '-q:v', '2', c.full]);
    else await frameAt(c.video, c.t, c.full);
    c.small = await small(c.full, path.join(work, `s${i}.jpg`));
  }
  if (!pool.length) throw new Error('No pictures to make a thumbnail from.');
  let pick = { index: 0, text_position: 'top' };
  try {
    const { json } = await llm.vision(`You are the thumbnail designer for "${ch.name}", a ${ch.language} kids channel. The video: "${pub.titles?.[0] || project.title}".
The ${pool.length} images are candidate backgrounds (numbered 0..${pool.length - 1} in order). The big text "${noEmoji(text)}" will be written on it.
${THUMB_RULES}
Pick the ONE image that will get the most clicks from parents and kids on a phone, and where the text can sit without covering a face.
JSON: {"index": n, "text_position": "top|bottom|top-left|top-right|bottom-left|bottom-right", "why": "one line", "runner_up": n}`, pool.map((c) => b64(c.small)));
    if (json && Number.isInteger(+json.index) && pool[+json.index]) pick = { ...json, index: +json.index };
  } catch (e) { onStep('Thumbnail: picture judge unavailable, using the first plate (' + e.message.slice(0, 60) + ')'); }
  const logo = path.join(store.P.brand, project.channel, 'logo.png');
  const color = ch.thumb_color || '&H0000E6FF';
  onStep('Thumbnail: writing the text');
  await render(pool[pick.index].full, text, path.join(dir, 'thumbnail.jpg'), { pos: pick.text_position, logo, color });
  // check the result once; move the text if it covers a face
  try {
    const { json } = await llm.vision(`This is a finished YouTube thumbnail for a ${ch.language} kids song. ${THUMB_RULES}
Score it 1-10 for click-through on a phone. Does the text cover any face or the main subject? Is the text readable?
JSON: {"score": n, "covers_face": true|false, "readable": true|false, "better_position": "top|bottom|top-left|top-right|bottom-left|bottom-right", "fix": "one line"}`, [b64(path.join(dir, 'thumbnail.jpg'))]);
    if (json?.covers_face && json.better_position && json.better_position !== pick.text_position) {
      pick.text_position = json.better_position;
      await render(pool[pick.index].full, text, path.join(dir, 'thumbnail.jpg'), { pos: pick.text_position, logo, color });
    }
    pick.score = json?.score; pick.fix = json?.fix;
  } catch { /* the check is a bonus */ }
  // A/B version: other text on the runner-up picture (YouTube Test & Compare takes up to 3)
  let alt = null;
  const ri = Number.isInteger(+pick.runner_up) && pool[+pick.runner_up] && +pick.runner_up !== pick.index ? +pick.runner_up : (pick.index + 1) % pool.length;
  if (pub.thumbnail_text_alt && pool.length > 1) {
    alt = await render(pool[ri].full, pub.thumbnail_text_alt, path.join(dir, 'thumbnail_b.jpg'), { pos: pick.text_position, logo, color });
  }
  fs.rmSync(work, { recursive: true, force: true });
  return { thumbnail: 'thumbnail.jpg', thumbnail_b: alt ? 'thumbnail_b.jpg' : null, thumb_pick: { scene: pool[pick.index].scene, image: (project.scenes || []).find((x) => x.n === pool[pick.index].scene)?.image || null, kind: pool[pick.index].kind, why: pick.why, score: pick.score ?? null, fix: pick.fix || null } };
}

// ---------- 2. weekly thumbnail doctor ----------
async function yt(endpoint, params) {
  const key = store.getSettings().youtube_api_key;
  if (!key) throw new Error('No YouTube API key yet. Add it in Settings.');
  const r = await fetch('https://www.googleapis.com/youtube/v3/' + endpoint + '?' + new URLSearchParams({ ...params, key }), { signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  if (!r.ok) throw new Error('YouTube: ' + (j.error?.message || r.status));
  return j;
}
const isoSecs = (d) => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || '') || []; return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0); };
async function fetchImg(url, out) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 3000) return null; // YouTube's grey "no image" placeholder
  fs.writeFileSync(out, buf); return out;
}

async function uploads(ch, max = 60) {
  const params = { part: 'contentDetails,snippet' };
  if (ch.youtube?.channel_id) params.id = ch.youtube.channel_id; else if (ch.youtube?.handle) params.forHandle = ch.youtube.handle.replace(/^@/, ''); else throw new Error('No YouTube handle in the channel settings.');
  const c = (await yt('channels', params)).items?.[0];
  if (!c) throw new Error('Channel not found on YouTube — check the handle.');
  const list = c.contentDetails.relatedPlaylists.uploads;
  const ids = []; let token;
  do {
    const pl = await yt('playlistItems', { part: 'contentDetails', playlistId: list, maxResults: 50, ...(token ? { pageToken: token } : {}) });
    ids.push(...pl.items.map((x) => x.contentDetails.videoId)); token = pl.nextPageToken;
  } while (token && ids.length < max);
  const vids = [];
  for (let i = 0; i < ids.length; i += 50) vids.push(...(await yt('videos', { part: 'snippet,statistics,contentDetails,player', maxWidth: 480, id: ids.slice(i, i + 50).join(',') })).items);
  return vids.map((v) => {
    const age = Math.max(1, (Date.now() - new Date(v.snippet.publishedAt)) / 86400000);
    const views = +v.statistics.viewCount || 0;
    const th = v.snippet.thumbnails || {};
    return { id: v.id, title: v.snippet.title, published: v.snippet.publishedAt.slice(0, 10), age: Math.round(age), views, vpd: +(views / age).toFixed(1),
      secs: isoSecs(v.contentDetails.duration), vertical: +v.player?.embedHeight > +v.player?.embedWidth, thumb: (th.maxres || th.standard || th.high || th.medium || {}).url };
  });
}

function median(a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; }

async function doctor(channelId, { maxFix = 3, onStep = () => {} } = {}) {
  const ch = store.getChannel(channelId);
  const day = new Date().toISOString().slice(0, 10);
  const root = path.join(store.P.data, 'thumb_doctor', channelId);
  const outDir = path.join(root, day);
  fs.mkdirSync(outDir, { recursive: true });
  const histFile = path.join(root, 'history.json');
  const hist = store.readJSON(histFile, { fixed: {} });
  const ctr = store.readJSON(path.join(store.P.root, 'config', 'ctr', channelId + '.json'), {});
  onStep('Thumbnail doctor: reading the channel uploads');
  const all = await uploads(ch);
  const longs = all.filter((v) => v.secs > 70 && !v.vertical); // Shorts are judged by the feed, not the thumbnail
  const settled = longs.filter((v) => v.age >= 7);
  const med = median(settled.map((v) => v.vpd));
  const ctrMed = median(Object.values(ctr).map(Number).filter((x) => x > 0));
  for (const v of settled) { v.ratio = med ? +(v.vpd / med).toFixed(2) : null; v.ctr = ctr[v.id] != null ? +ctr[v.id] : null; }
  const winners = [...settled].sort((a, b) => b.vpd - a.vpd).slice(0, 3);
  const weak = settled
    .filter((v) => !winners.includes(v))
    .filter((v) => !hist.fixed[v.id] || (Date.now() - new Date(hist.fixed[v.id])) / 86400000 > 28)
    .filter((v) => (v.ctr != null && ctrMed ? v.ctr < Math.max(ctrMed, 6) : v.ratio != null && v.ratio < 0.6))
    .sort((a, b) => (a.ctr ?? a.ratio * 10) - (b.ctr ?? b.ratio * 10))
    .slice(0, maxFix);
  // pictures of the channel's winners and the niche's winners
  const refs = [];
  for (const w of winners) { const f = w.thumb && await fetchImg(w.thumb, path.join(outDir, `win_${w.id}.jpg`)); if (f) refs.push({ f, label: `OUR WINNER (${w.vpd} views/day${w.ctr != null ? ', CTR ' + w.ctr + '%' : ''}): ${w.title}` }); }
  const niche = (store.readJSON(path.join(store.P.stats, channelId + '_niche.json'), {}).videos || []).slice(0, 2);
  for (const n of niche) { const id = (n.url || '').split('/').pop(); const f = id && await fetchImg(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, path.join(outDir, `niche_${id}.jpg`)); if (f) refs.push({ f, label: `NICHE WINNER (${n.views_per_day} views/day): ${n.title}` }); }
  const projects = store.listProjects(channelId);
  const report = { channel: channelId, day, median_views_per_day: med, median_ctr: ctrMed || null, ctr_source: Object.keys(ctr).length ? 'your YouTube Studio numbers' : 'views per day (no CTR numbers given)', winners, fixes: [] };
  for (const v of weak) {
    onStep(`Thumbnail doctor: ${v.title.slice(0, 40)}`);
    const cur = v.thumb && await fetchImg(v.thumb, path.join(outDir, `now_${v.id}.jpg`));
    if (!cur) continue;
    // clean backgrounds: our own project plates if we made it, else YouTube's own frames from the video
    const proj = projects.find((p) => (p.publish?.youtube_id === v.id) || [p.title, ...(p.publish?.titles || [])].some((t) => t && noEmoji(t).split('|')[0].trim().length > 3 && v.title.includes(noEmoji(t).split('|')[0].trim())));
    const bgs = [];
    if (proj) {
      const pdir = store.projectDir(proj.id); const seen = new Set();
      for (const s of proj.scenes || []) if (s.image && !seen.has(s.image) && fs.existsSync(path.join(pdir, s.image)) && bgs.length < 8) { seen.add(s.image); bgs.push(path.join(pdir, s.image)); }
    }
    for (const k of [1, 2, 3]) {
      if (bgs.length >= 8) break;
      const f = await fetchImg(`https://i.ytimg.com/vi/${v.id}/maxres${k}.jpg`, path.join(outDir, `f${k}_${v.id}.jpg`)) || await fetchImg(`https://i.ytimg.com/vi/${v.id}/hq${k}.jpg`, path.join(outDir, `f${k}_${v.id}.jpg`));
      if (f) bgs.push(f);
    }
    const smalls = [];
    for (let i = 0; i < bgs.length; i++) smalls.push(await small(bgs[i], path.join(outDir, `bg${i}_${v.id}.jpg`)));
    let advice;
    try {
      const imgs = [b64(cur), ...refs.map((r) => b64(r.f)), ...smalls.map(b64)];
      const { json } = await llm.vision(`You are the thumbnail doctor for "${ch.name}", a ${ch.language} kids channel (audience: ${ch.audience || 'kids and parents'}).
Image 1 is the CURRENT thumbnail of an under-performing video: "${v.title}" — ${v.vpd} views/day vs the channel's usual ${med}${v.ctr != null ? `, CTR ${v.ctr}% (channel usual ${ctrMed || '?'}%)` : ''}.
Images 2-${refs.length + 1}: ${refs.map((r, i) => `[${i + 2}] ${r.label}`).join(' ; ')}.
Images ${refs.length + 2}-${refs.length + 1 + smalls.length} are clean pictures from this video that a new thumbnail can use (background index 0..${smalls.length - 1}).
${THUMB_RULES}
Say exactly what holds the current thumbnail back compared with the winners, and design the replacement.
The new text must be in ${ch.language} script (2-4 words), may end with one emoji, and must fit the video honestly.
JSON: {"problems": ["..."], "changes": ["..."], "background": n, "text": "...", "text_position": "top|bottom|top-left|top-right|bottom-left|bottom-right", "title_tweak": "better title or empty", "expected": "low|medium|high lift"}`, imgs);
      advice = json;
    } catch (e) { advice = { problems: ['vision check unavailable: ' + e.message.slice(0, 80)] }; }
    let newThumb = null;
    const bi = Number.isInteger(+advice?.background) && bgs[+advice.background] ? +advice.background : 0;
    if (bgs.length && advice?.text) {
      const fromVideo = bgs[bi].startsWith(outDir); // YouTube's own frames already carry the logo
      newThumb = await render(bgs[bi], advice.text, path.join(outDir, `new_${v.id}.jpg`), { pos: advice.text_position, logo: fromVideo ? null : path.join(store.P.brand, channelId, 'logo.png') });
    }
    report.fixes.push({ ...v, project: proj?.id || null, now: path.basename(cur), new: newThumb && path.basename(newThumb), advice });
    hist.fixed[v.id] = new Date().toISOString();
  }
  for (const f of fs.readdirSync(outDir)) if (/^(bg\d|f\d)_/.test(f)) fs.rmSync(path.join(outDir, f), { force: true });
  store.writeJSON(path.join(outDir, 'report.json'), report);
  fs.writeFileSync(path.join(outDir, 'index.html'), html(ch, report));
  store.writeJSON(histFile, hist);
  return report;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function html(ch, r) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thumbnail doctor · ${esc(ch.name)}</title>
<style>body{font-family:system-ui,'Nirmala UI',sans-serif;background:#faf7f0;color:#222;margin:0;padding:16px;max-width:1100px;margin:auto}h1{font-size:22px}.v{background:#fff;border-radius:12px;padding:14px;margin:14px 0;box-shadow:0 1px 4px #0001}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}img{width:100%;border-radius:8px}.k{font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.05em}ul{margin:6px 0 0 18px;padding:0}@media(max-width:640px){.row{grid-template-columns:1fr}}</style>
<h1>Thumbnail doctor · ${esc(ch.name)} · ${r.day}</h1>
<p>Channel usual: <b>${r.median_views_per_day}</b> views/day per video${r.median_ctr ? `, CTR ${r.median_ctr}%` : ''}. Judged by: ${esc(r.ctr_source)}.</p>
<p class="k">Winners we learn from</p><p>${r.winners.map((w) => `${esc(w.title)} — ${w.vpd}/day`).join('<br>')}</p>
${r.fixes.length ? r.fixes.map((f) => `<div class="v"><b>${esc(f.title)}</b><br><span class="k">${f.vpd} views/day · ${f.ratio}× usual${f.ctr != null ? ' · CTR ' + f.ctr + '%' : ''} · <a href="https://studio.youtube.com/video/${f.id}/edit" target="_blank">open in YouTube Studio</a></span>
<div class="row"><div><p class="k">Now</p><img src="${f.now}"></div><div><p class="k">Suggested</p>${f.new ? `<img src="${f.new}">` : '<p>(no clean picture found)</p>'}</div></div>
<p class="k">What holds it back</p><ul>${(f.advice?.problems || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<p class="k">Change</p><ul>${(f.advice?.changes || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
${f.advice?.title_tweak ? `<p class="k">Title idea</p><p>${esc(f.advice.title_tweak)}</p>` : ''}</div>`).join('') : '<p>No thumbnail needs changing this week.</p>'}
<p class="k">How to use</p><p>In YouTube Studio open the video → Thumbnail → Upload, or use "Test &amp; compare" with the old one so YouTube picks the winner. To judge by real CTR next week, paste each video's CTR into config/ctr/${esc(r.channel)}.json like {"VIDEO_ID": 6.5}.</p>`;
}

module.exports = { make, doctor, render, uploads };
