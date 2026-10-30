// ReelBite Shorts (v2, "top editor" cut): a sourced Hollywood story told beat by beat, 1080x1920, 30 fps.
// Each beat = one spoken line + 1-3 SHOTS (a new picture about every 1.5-2 s):
//   photo    — a REAL free-licence photo (Wikimedia Commons, credited); people only from their own Wikidata photo
//   clip     — a short clip Anand dropped into the project's your_clips folder (b05.mp4 = beat 5)
//   panel    — a drawn comic panel, only where no real image can exist
//   stat / quote / headline / chart — proof cards with their source on screen
//   end      — loop-friendly outro (logo + follow line), last beat only
// Extras per shot: kicker (label), pop (comic sound word), emoji (pops in), arrow (points at the subject).
// Per beat: punch (a short stamp line, e.g. "$44 MILLION."), shown big in the last part of the beat.
// Layout keeps everything inside the Shorts safe zone (top bar, right-hand buttons and bottom title area stay clear).
// Voice: Voicebox, one take per beat (exact timings), 1.15x, pauses cut. Sound: own music bed (music.js), ducked
// under the voice, plus whoosh / shutter / pop / glitch / boom effects on every cut and pop-up.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');

const W = 1080, H = 1920, FPS = 30;
// Shorts safe zone (YouTube app overlays): top ~200, bottom ~420, right-hand buttons ~150 from x=930 down.
const SAFE = { top: 210, bottom: 1480, left: 60, right: 920 };
const FRAME = { left: 60, top: 360, width: 860, height: 880 };
const CAPTION_Y = 1335;
const OK_LICENCE = /^(cc0|public domain|pd|cc by(-sa)?( \d\.\d)?|cc-by(-sa)?|attribution)/i;
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const strip = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');
const UA = { 'User-Agent': 'AnandYouTubeStudio/1.0 (ReelBite)' };

function run(bin, args, { cwd, timeout = 20 * 60000 } = {}) {
  return new Promise((res, rej) => {
    const p = spawn(bin, args, { cwd, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => { p.kill(); rej(new Error(bin + ' took too long')); }, timeout);
    p.on('close', (c) => { clearTimeout(t); c ? rej(new Error(err.slice(-400) || bin + ' failed')) : res(out); });
    p.on('error', (e) => { clearTimeout(t); rej(e); });
  });
}
const ff = (args, o) => run(store.getSettings().ffmpeg_path || 'ffmpeg', ['-y', '-loglevel', 'error', ...args], o);
const dur = async (f) => parseFloat(await run(store.getSettings().ffprobe_path || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f])) || 0;

// ---------- real photos ----------
async function commons(query, { min = 700, must = [] } = {}) {
  const u = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=12&gsrsearch=${encodeURIComponent(query + ' filetype:bitmap')}&prop=imageinfo&iiprop=url|size|extmetadata|mime&iiurlwidth=1600`;
  const j = await (await fetch(u, { headers: UA, signal: AbortSignal.timeout(30000) })).json();
  const pages = Object.values(j.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  for (const pg of pages) {
    const ii = pg.imageinfo?.[0]; if (!ii || !/jpe?g|png/i.test(ii.mime || '')) continue;
    const m = ii.extmetadata || {};
    const lic = strip(m.LicenseShortName?.value || m.License?.value || '');
    if (!OK_LICENCE.test(lic) || /non-?commercial|nc|nd/i.test(lic) || (m.Restrictions?.value || '').match(/trademark|personality/i)) continue;
    if (Math.min(ii.width, ii.height) < min) continue;
    const about = (pg.title + ' ' + strip(m.ImageDescription?.value) + ' ' + strip(m.ObjectName?.value)).toLowerCase();
    if (must.some((w) => !about.includes(String(w).toLowerCase()))) continue; // never the wrong subject
    return { url: ii.thumburl || ii.url, page: ii.descriptionurl, title: pg.title.replace(/^File:/, ''), licence: lic, author: strip(m.Artist?.value || '').slice(0, 80) || 'Wikimedia Commons' };
  }
  return null;
}
// A named PERSON: only the photo Wikidata lists for that exact person (P18), checked by name and job.
async function personPhoto(name, role = '') {
  const o = { headers: UA, signal: AbortSignal.timeout(30000) };
  const s = await (await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&type=item&limit=7&search=${encodeURIComponent(name)}`, o)).json();
  const cand = (s.search || []).filter((x) => String(x.label || '').toLowerCase() === name.toLowerCase() && (!role || new RegExp(role, 'i').test(x.description || '')));
  for (const c of cand) {
    const e = await (await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${c.id}.json`, o)).json();
    const file = e.entities?.[c.id]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    if (!file) continue;
    const j = await (await fetch(`https://commons.wikimedia.org/w/api.php?action=query&format=json&titles=${encodeURIComponent('File:' + file)}&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1600`, o)).json();
    const ii = Object.values(j.query?.pages || {})[0]?.imageinfo?.[0]; if (!ii) continue;
    const m = ii.extmetadata || {}; const lic = strip(m.LicenseShortName?.value || '');
    if (!OK_LICENCE.test(lic) || /non-?commercial|nc|nd/i.test(lic)) continue;
    return { url: ii.thumburl || ii.url, page: ii.descriptionurl, title: file, licence: lic, author: strip(m.Artist?.value || '').slice(0, 80) || 'Wikimedia Commons', who: `${c.label} (${c.description || c.id})` };
  }
  return null;
}
async function download(url, file) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('download ' + r.status);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}

// ---------- cinema b-roll (Pexels, free licence; needs Anand's free API key in Settings) ----------
// Returns a 1080x1920 30 fps MP4 (max 6 s) cut from a stock clip, cached in data/broll. Never the real subject — atmosphere only.
async function broll(query, avoid = new Set()) {
  const key = store.getSettings().pexels_api_key; if (!key || !query) return null;
  const cache = path.join(store.P.data, 'broll'); fs.mkdirSync(cache, { recursive: true });
  const get = async (orient) => { const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=15${orient ? '&orientation=' + orient : ''}`, { headers: { Authorization: key }, signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error('Pexels ' + r.status); return (await r.json()).videos || []; };
  let vids = await get('portrait').catch(() => []);
  if (vids.length < 3) vids = [...vids, ...(await get('').catch(() => []))];
  for (const v of vids) {
    if (avoid.has(v.id) || (v.duration || 0) < 3) continue;
    const files = (v.video_files || []).filter((f) => /mp4/.test(f.file_type || '') && f.width && f.height && Math.max(f.width, f.height) <= 2560 && Math.min(f.width, f.height) >= 720);
    const f = files.sort((a, b) => (b.height > b.width) - (a.height > a.width) || Math.abs(a.height - 1920) - Math.abs(b.height - 1920))[0];
    if (!f) continue;
    const raw = path.join(cache, `px_${v.id}.mp4`), cut = path.join(cache, `px_${v.id}_v.mp4`);
    if (!fs.existsSync(cut)) {
      if (!fs.existsSync(raw)) { const r = await fetch(f.link, { signal: AbortSignal.timeout(120000) }).catch(() => null); if (!r || !r.ok) continue; fs.writeFileSync(raw, Buffer.from(await r.arrayBuffer())); }
      const from = Math.min(1, Math.max(0, (v.duration || 6) - 6) / 2);
      await ff(['-ss', String(from), '-i', raw, '-t', '6', '-an', '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-crf', '19', '-preset', 'veryfast', cut]).catch(() => null);
      try { fs.unlinkSync(raw); } catch {}
      if (!fs.existsSync(cut)) continue;
    }
    return { file: cut, id: v.id, author: v.user?.name || 'Pexels', page: v.url, title: query, licence: 'Pexels licence' };
  }
  return null;
}

// ---------- shots of a beat ----------
// Old scripts used beat.visual (+ visual2); new ones use beat.shots. A clip in your_clips/bNN*.mp4 becomes the first shot.
function shotsOf(b, n, dir) {
  let shots = Array.isArray(b.shots) && b.shots.length ? b.shots.slice() : [b.visual || { type: 'quote', text: b.text }, ...(b.visual2 ? [b.visual2] : [])];
  const yc = path.join(dir, 'your_clips');
  if (fs.existsSync(yc)) {
    const mine = fs.readdirSync(yc).filter((f) => new RegExp(`^b${pad(n)}(_\\d+)?\\.(mp4|mov|webm)$`, 'i').test(f)).sort();
    shots = [...mine.map((f) => ({ type: 'clip', file: path.join('your_clips', f), kicker: (b.shots?.[0] || b.visual || {}).kicker })), ...shots];
  }
  // never shorter than ~1.4 s per shot
  const maxShots = Math.max(1, Math.floor((+b.dur || 3) / 1.4));
  return shots.slice(0, maxShots);
}
function splitTimes(d, k) { const base = d / k; return Array.from({ length: k }, (_, i) => +(i === k - 1 ? d - base * (k - 1) : base).toFixed(3)); }

// ---------- HyperFrames page (vertical) ----------
const FONTS = "'Montserrat','Arial Black','Segoe UI','Segoe UI Emoji',sans-serif";
function page(id, d, body, script, ch) {
  const gold = ch.accent || '#D9B26A';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#0B0B0B}#stage{position:relative;width:${W}px;height:${H}px;overflow:hidden;font-family:${FONTS};background:#0B0B0B;color:#F5EBD7}
.full{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.grain{position:absolute;inset:-20px;background-image:radial-gradient(rgba(255,255,255,.07) 1.4px,transparent 1.8px),radial-gradient(rgba(0,0,0,.18) 1.6px,transparent 2px);background-size:9px 9px,13px 13px;mix-blend-mode:overlay}
.vig{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 45%,transparent 50%,rgba(0,0,0,.6) 100%)}
.shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.55) 0%,rgba(0,0,0,0) 22%,rgba(0,0,0,0) 55%,rgba(0,0,0,.72) 82%,rgba(0,0,0,.85) 100%)}
.leak{position:absolute;left:-40%;top:-10%;width:90%;height:70%;background:radial-gradient(circle,rgba(255,150,60,.28),transparent 65%);mix-blend-mode:screen}
.frame{position:absolute;left:${FRAME.left}px;top:${FRAME.top}px;width:${FRAME.width}px;height:${FRAME.height}px;border:10px solid #F5EBD7;box-shadow:0 0 0 6px #000,16px 20px 0 6px ${gold};overflow:hidden;background:#111}
.frame img,.frame video{width:100%;height:100%;object-fit:cover}
.kicker{position:absolute;left:${SAFE.left}px;top:258px;font-size:50px;font-weight:900;letter-spacing:2px;color:#000;background:${gold};padding:6px 18px;text-transform:uppercase;box-shadow:6px 6px 0 #000;max-width:820px;white-space:nowrap;overflow:hidden}
.credit{position:absolute;left:${SAFE.left}px;width:${SAFE.right - SAFE.left}px;top:1250px;font-size:22px;color:#bbb;text-align:right;text-shadow:0 2px 4px #000}
.pop{position:absolute;left:${SAFE.left + 20}px;top:1060px;font-size:118px;font-weight:900;color:#FFD400;-webkit-text-stroke:6px #000;transform:rotate(-8deg)}
.emoji{position:absolute;left:${SAFE.right - 200}px;top:${FRAME.top + 20}px;font-size:150px;filter:drop-shadow(6px 8px 0 #000)}
.punch{position:absolute;left:${SAFE.left}px;width:${SAFE.right - SAFE.left}px;top:690px;text-align:center;font-size:118px;line-height:1.02;font-weight:900;color:#fff;-webkit-text-stroke:7px #000;text-shadow:10px 10px 0 ${gold};transform:rotate(-4deg);text-transform:uppercase}
.arrow{position:absolute;width:150px;height:150px;font-size:150px;line-height:150px;color:#FFD400;-webkit-text-stroke:5px #000}
.flash{position:absolute;width:520px;height:520px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.95) 0%,rgba(255,255,255,.5) 18%,transparent 60%);opacity:0;mix-blend-mode:screen}
.beam{position:absolute;left:50%;top:-200px;width:1400px;height:2400px;margin-left:-700px;background:conic-gradient(from 168deg at 50% 0%,transparent 0deg,rgba(255,240,200,.22) 12deg,transparent 24deg);mix-blend-mode:screen;transform-origin:50% 0}
</style></head><body>
<div id="stage" data-composition-id="${id}" data-start="0" data-width="${W}" data-height="${H}">
${body}
<div id="lk" class="leak clip" data-start="0" data-duration="${d}" data-track-index="17"></div>
<div class="vig clip" data-start="0" data-duration="${d}" data-track-index="18"></div>
<div id="gr" class="grain clip" data-start="0" data-duration="${d}" data-track-index="19"></div>
<div id="hold" class="clip" data-start="0" data-duration="${d}" data-track-index="20" style="position:absolute;left:0;top:0;width:2px;height:2px;opacity:0"></div>
</div>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script>
const tl = gsap.timeline({ paused: true });
tl.fromTo("#hold",{x:0},{x:1,duration:${d},ease:"none"},0);
tl.fromTo("#gr",{x:0,y:0},{x:9,y:7,duration:${d},ease:"steps(${Math.max(2, Math.round(d * 12))})"},0);
tl.fromTo("#lk",{x:-200,opacity:0},{x:${W + 400},opacity:.9,duration:${d},ease:"sine.inOut"},0);
${script}
window.__timelines = window.__timelines || {}; window.__timelines["${id}"] = tl;
</script></body></html>`;
}

// Full-screen background for cards/stats/charts/fx/punch: the beat's b-roll video, else its photo, else moving spotlights.
function bgLayer(d, bg) {
  if (bg === 'video') return { body: `<video id="bgv" class="clip full" data-start="0" data-duration="${d}" data-track-index="0" src="bg.mp4" muted playsinline style="filter:brightness(.38) saturate(.9)"></video>`, js: '' };
  if (bg === 'image') return { body: `<img id="bgi" class="full clip" data-start="0" data-duration="${d}" data-track-index="0" src="bg.jpg" style="filter:blur(14px) brightness(.34)">`, js: `tl.fromTo("#bgi",{scale:1.15},{scale:1.28,duration:${d},ease:"none"},0);` };
  return { body: `<div class="clip" data-start="0" data-duration="${d}" data-track-index="0" style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 30%,#2a2216 0%,#0b0b0b 70%)"></div><div id="b1" class="beam clip" data-start="0" data-duration="${d}" data-track-index="1"></div><div id="b2" class="beam clip" data-start="0" data-duration="${d}" data-track-index="1" style="opacity:.7"></div>`,
    js: `tl.fromTo("#b1",{rotation:-24},{rotation:18,duration:${d},ease:"sine.inOut"},0);tl.fromTo("#b2",{rotation:22},{rotation:-16,duration:${d},ease:"sine.inOut"},0);` };
}

// Extras that sit on any shot: kicker, pop word, emoji, arrow, paparazzi flashes.
function extras(v, d, opt = {}) {
  let body = '', js = '';
  if (v.kicker && !opt.noKicker) { body += `<div id="k" class="kicker clip" data-start="0" data-duration="${d}" data-track-index="11">${esc(v.kicker)}</div>`; js += 'tl.from("#k",{x:-140,opacity:0,duration:.28,ease:"power3.out"},0.04);'; }
  if (v.pop) { const t = Math.min(0.45, d / 3); body += `<div id="pop" class="pop clip" data-start="${t.toFixed(2)}" data-duration="${(d - t).toFixed(2)}" data-track-index="12">${esc(v.pop)}</div>`; js += `tl.from("#pop",{scale:0,rotation:-40,duration:.24,ease:"back.out(3)"},${t.toFixed(2)});tl.fromTo("#pop",{x:-12},{x:0,duration:.3,ease:"elastic.out(1,.3)",immediateRender:false},${(t + 0.24).toFixed(2)});`; }
  if (v.emoji) { const t = Math.min(0.3, d / 4); body += `<div id="em" class="emoji clip" data-start="${t.toFixed(2)}" data-duration="${(d - t).toFixed(2)}" data-track-index="13">${esc(v.emoji)}</div>`; js += `tl.from("#em",{scale:0,y:60,rotation:25,duration:.3,ease:"back.out(2.5)"},${t.toFixed(2)});tl.to("#em",{y:-14,duration:${Math.max(0.2, d - t - 0.3).toFixed(2)},ease:"sine.inOut",immediateRender:false},${(t + 0.3).toFixed(2)});`; }
  if (v.arrow && opt.frame) {
    const fx = v.focus_x ?? 50, fy = v.focus_y ?? 40;
    const x = Math.min(SAFE.right - 160, SAFE.left + (SAFE.right - SAFE.left) * fx / 100 + 60), y = 360 + 880 * fy / 100 - 40;
    body += `<div id="ar" class="arrow clip" data-start="0.25" data-duration="${Math.max(0.1, d - 0.25).toFixed(2)}" data-track-index="14" style="left:${x}px;top:${y}px">⬅</div>`;
    js += `tl.from("#ar",{x:80,opacity:0,duration:.25,ease:"power3.out"},0.25);tl.to("#ar",{x:-18,duration:.35,yoyo:true,repeat:${Math.max(1, Math.floor((d - 0.5) / 0.35))},ease:"sine.inOut",immediateRender:false},0.5);`;
  }
  if (v.flashes) {
    // paparazzi: bright camera flashes popping around the subject
    const spots = [[80, 300], [620, 520], [220, 900], [700, 1080], [360, 420], [560, 260]];
    const n = Math.max(3, Math.min(6, Math.round(d * 1.6)));
    for (let i = 0; i < n; i++) { const [x, y] = spots[i % spots.length]; const t = (0.15 + i * (d - 0.4) / n).toFixed(2); body += `<div id="fl${i}" class="flash clip" data-start="0" data-duration="${d}" data-track-index="15" style="left:${x - 260}px;top:${y - 260}px"></div>`; js += `tl.fromTo("#fl${i}",{opacity:1,scale:.6},{opacity:0,scale:1.3,duration:.22,immediateRender:false},${t});`; }
  }
  return { body, js };
}

// One shot → an MP4 of length d. opt.bg: 'video' | 'image' | null (background for non-photo shots).
function shotHtml(n, k, v, d, ch, hasImg, opt = {}) {
  const id = `b${n}s${k}`;
  const gold = ch.accent || '#D9B26A';
  const ex = extras(v, d, { ...opt, frame: hasImg, noKicker: opt.noKicker || (/^(fx|broll)$/.test(v.type) && !opt.video && !!v.text) });
  const flashDiv = `<div id="wf" class="clip" data-start="0" data-duration="${d}" data-track-index="16" style="position:absolute;inset:0;background:#fff;opacity:0"></div>`;
  // B-ROLL: real footage, full screen
  if (v.type === 'broll' && opt.video) {
    const body = `<video id="bv" class="clip full" data-start="0" data-duration="${d}" data-track-index="0" src="fg.mp4" muted playsinline></video><div class="shade clip" data-start="0" data-duration="${d}" data-track-index="2"></div>${v.credit ? `<div class="credit clip" data-start="0" data-duration="${d}" data-track-index="3">${esc(v.credit)}</div>` : ''}${flashDiv}${ex.body}`;
    return page(id, d, body, `tl.fromTo("#wf",{opacity:.45},{opacity:0,duration:.14,immediateRender:false},0);` + ex.js, ch);
  }
  if (hasImg && /^(photo|panel|clip)$/.test(v.type)) {
    const isClip = v.type === 'clip';
    const fx = v.focus_x ?? 50, fy = v.focus_y ?? 40;
    const mid = d >= 2.6 ? +(d / 2).toFixed(2) : null;
    if ((v.hires || isClip) && !v.framed) {
      // FULL SCREEN: the picture fills the phone; half-way a hard punch-in on the subject (still full screen)
      const media = isClip ? `<video id="fg" class="clip full" data-start="0" data-duration="${d}" data-track-index="0" src="fg.mp4" muted playsinline></video>` : `<img id="fg" class="full clip" data-start="0" data-duration="${d}" data-track-index="0" src="fg.jpg" style="object-position:${fx}% ${Math.min(fy, 35)}%">`;
      const body = `${media}<div class="shade clip" data-start="0" data-duration="${d}" data-track-index="2"></div>${v.credit ? `<div class="credit clip" data-start="0" data-duration="${d}" data-track-index="3">${esc(v.credit)}</div>` : ''}${flashDiv}${ex.body}`;
      let js = `tl.fromTo("#wf",{opacity:.4},{opacity:0,duration:.12,immediateRender:false},0);`;
      if (!isClip) {
        js += `tl.fromTo("#fg",{scale:1.04,xPercent:0},{scale:1.14,xPercent:${(n + k) % 2 ? -2.5 : 2.5},duration:${mid || d},ease:"none"},0);`;
        if (mid) js += `tl.set("#fg",{scale:1.38,xPercent:0,transformOrigin:"${fx}% ${fy}%"},${mid});tl.to("#fg",{scale:1.5,duration:${(d - mid).toFixed(2)},ease:"none"},${mid});tl.fromTo("#wf",{opacity:.5},{opacity:0,duration:.12,immediateRender:false},${mid});tl.fromTo("#fg",{x:-16},{x:0,duration:.2,ease:"elastic.out(1,.4)",immediateRender:false},${mid});`;
      }
      return page(id, d, body, js + ex.js, ch);
    }
    // FRAMED (small or soft pictures): a comic frame over its own blurred, full-screen copy
    const media = `<img id="fg" src="fg.jpg">`;
    const body = `<img id="bgi" class="full clip" data-start="0" data-duration="${d}" data-track-index="0" src="fg.jpg" style="filter:blur(30px) brightness(.42)">
<div id="fr" class="frame clip" data-start="0" data-duration="${d}" data-track-index="2">${media}</div>
${v.credit ? `<div class="credit clip" data-start="0" data-duration="${d}" data-track-index="3">${esc(v.credit)}</div>` : ''}${flashDiv}${ex.body}`;
    let js = `tl.fromTo("#bgi",{scale:1.25},{scale:1.4,duration:${d},ease:"none"},0);tl.from("#fr",{y:${k % 2 ? -120 : 160},rotation:${(n + k) % 2 ? 3 : -3},scale:.88,opacity:0,duration:.26,ease:"power4.out"},0);`;
    js += `tl.fromTo("#fg",{scale:1.02,xPercent:0},{scale:1.12,xPercent:${(n + k) % 2 ? -3 : 3},duration:${mid || d},ease:"none"},0);`;
    if (mid) js += `tl.set("#fg",{scale:1.32,xPercent:0,transformOrigin:"${fx}% ${fy}%"},${mid});tl.to("#fg",{scale:1.4,duration:${(d - mid).toFixed(2)},ease:"none"},${mid});tl.fromTo("#wf",{opacity:.5},{opacity:0,duration:.12,immediateRender:false},${mid});tl.fromTo("#fr",{x:-14},{x:0,duration:.18,ease:"elastic.out(1,.4)",immediateRender:false},${mid});`;
    return page(id, d, body, js + ex.js, ch);
  }
  const bg = bgLayer(d, opt.bg);
  if (v.type === 'fx' || v.type === 'broll') return page(id, d, ...fxScene(v, d, ch, bg, ex), ch);
  if (v.type === 'chart') {
    const bars = (v.bars || []).slice(0, 3); const max = Math.max(...bars.map((b) => +b.value || 0)) || 1;
    const unit = v.unit || ''; const pre = v.prefix ?? '$';
    const colW = Math.min(260, 760 / bars.length - 60), area = 700, base = 1180;
    const body = `${bg.body}<div class="kicker clip" id="k2" data-start="0" data-duration="${d}" data-track-index="5">${esc(v.kicker || v.title || '')}</div>
${bars.map((b, i) => `<div class="clip" data-start="0" data-duration="${d}" data-track-index="${6 + i}" style="position:absolute;left:${SAFE.left + 60 + i * (760 / bars.length)}px;top:${base - Math.round(area * (+b.value / max))}px;width:${colW}px;height:${Math.round(area * (+b.value / max))}px">
  <div id="bar${i}" style="position:absolute;left:0;right:0;bottom:0;height:100%;background:${i === bars.length - 1 && v.bad !== false && +b.value < max ? '#E5484D' : gold};border:8px solid #000;box-shadow:12px 12px 0 #000;transform-origin:bottom"></div>
  <div id="num${i}" style="position:absolute;left:-60px;right:-60px;top:-112px;text-align:center;font-size:84px;font-weight:900;color:#fff;-webkit-text-stroke:3px #000">${esc(pre)}0${esc(unit)}</div>
  <div style="position:absolute;left:-70px;right:-70px;bottom:-96px;text-align:center;font-size:42px;font-weight:800;color:#F5EBD7;text-shadow:0 3px 6px #000">${esc(b.label)}</div>
</div>`).join('\n')}
${v.source ? `<div class="credit clip" data-start="0" data-duration="${d}" data-track-index="10" style="top:${base + 120}px;text-align:center">Source: ${esc(v.source)}</div>` : ''}${ex.body.replace(/<div id="k"[^]*?<\/div>/, '')}`;
    const ramp = Math.min(1.0, d / 2.2);
    const js = bg.js + bars.map((b, i) => `tl.from("#bar${i}",{scaleY:0,duration:${ramp.toFixed(2)},ease:"power2.out"},${(0.1 + i * 0.25).toFixed(2)});` + Array.from({ length: 13 }, (_, q) => { const f = 1 - Math.pow(1 - q / 12, 2); const val = +b.value * f; const txt = pre + (Number.isInteger(+b.value) ? Math.round(val) : val.toFixed(1)) + unit; return `tl.set("#num${i}",{textContent:${JSON.stringify(q === 12 ? pre + b.value + unit : txt)}},${(0.1 + i * 0.25 + q * ramp / 12).toFixed(3)});`; }).join('')).join('\n')
      + 'tl.from("#k2",{x:-140,opacity:0,duration:.28,ease:"power3.out"},0.04);' + ex.js.replace(/tl\.from\("#k"[^;]*;/, '');
    return page(id, d, body, js, ch);
  }
  if (v.type === 'stat') {
    const body = `${bg.body}<div id="sv" class="clip" data-start="0" data-duration="${d}" data-track-index="2" style="position:absolute;left:${SAFE.left}px;width:${SAFE.right - SAFE.left}px;top:600px;text-align:center;font-size:${String(v.value).length > 6 ? 170 : 230}px;font-weight:900;color:${gold};-webkit-text-stroke:7px #000;text-shadow:14px 14px 0 #000">${esc(v.value)}</div>
<div id="sl" class="clip" data-start="0" data-duration="${d}" data-track-index="3" style="position:absolute;left:${SAFE.left}px;width:${SAFE.right - SAFE.left}px;top:900px;text-align:center;font-size:60px;font-weight:900;color:#F5EBD7;text-transform:uppercase;text-shadow:0 4px 10px #000">${esc(v.label || '')}</div>${ex.body}`;
    const js = bg.js + `tl.from("#sv",{scale:2.4,opacity:0,duration:.24,ease:"power4.out"},0);tl.from("#sl",{y:60,opacity:0,duration:.25},0.12);tl.fromTo("#sv",{scale:1},{scale:1.08,duration:${Math.max(0.1, d - 0.24).toFixed(2)},ease:"none",immediateRender:false},0.24);` + ex.js;
    return page(id, d, body, js, ch);
  }
  if (v.type === 'end') return page(id, d, ...endScene(v, d, ch, bg), ch);
  // quote / headline: a paper card over the full-screen background
  const big = v.type === 'quote' ? `“${v.text}”` : v.text;
  const body = `${bg.body}<div id="card" class="clip" data-start="0" data-duration="${d}" data-track-index="2" style="position:absolute;left:${SAFE.left + 10}px;width:${SAFE.right - SAFE.left - 100}px;top:470px;padding:60px 50px;background:#F5EBD7;color:#111;border:10px solid #000;box-shadow:20px 20px 0 ${gold};transform:rotate(${(n + k) % 2 ? 1.5 : -1.5}deg)">
  ${v.kicker ? `<div style="font-size:42px;font-weight:900;letter-spacing:3px;color:#B3261E;margin-bottom:22px;text-transform:uppercase">${esc(v.kicker)}</div>` : ''}
  <div id="big" style="font-family:Georgia,'Times New Roman',serif;font-size:${big.length > 70 ? 64 : 84}px;font-weight:700;line-height:1.12">${esc(big)}</div>
  ${v.source ? `<div style="margin-top:34px;font-size:32px;font-style:italic;color:#444">— ${esc(v.source)}</div>` : ''}
</div>${ex.body.replace(/<div id="k"[^]*?<\/div>/, '')}`;
  const js = bg.js + `tl.from("#card",{scale:.6,opacity:0,rotation:-8,duration:.32,ease:"back.out(2)"},0);tl.from("#big",{opacity:0,y:30,duration:.35},0.16);
tl.fromTo("#card",{scale:1},{scale:1.05,duration:${Math.max(0.1, d - 0.32).toFixed(2)},ease:"none",immediateRender:false},0.32);` + ex.js.replace(/tl\.from\("#k"[^;]*;/, '');
  return page(id, d, body, js, ch);
}

// Cinema motion graphics (made here): flashes, film strip, spotlight stage, clapperboard, marquee, film reel.
function fxStyle(v) {
  if (v.style) return v.style;
  const q = String(v.query || v.text || '').toLowerCase();
  if (/carpet|premiere|paparazz|press|photograph|media|fame|celebr/.test(q)) return 'flashes';
  if (/theat|cinema|marquee|box office|ticket|audience|screening/.test(q)) return 'marquee';
  if (/director|shoot|filming|take|scene|set|camera|production/.test(q)) return 'clapper';
  if (/stage|award|oscar|spotlight|perform/.test(q)) return 'spotlight';
  if (/footage|reel|film stock|edit|cut|projector|hollywood/.test(q)) return 'filmstrip';
  const pick = ['clapper', 'filmstrip', 'marquee', 'spotlight', 'flashes'];
  return pick[[...q].reduce((a, c) => a + c.charCodeAt(0), 0) % pick.length];
}
function fxScene(v, d, ch, bg, ex) {
  const gold = ch.accent || '#D9B26A';
  const style = fxStyle(v); const label = esc(v.text || v.kicker || '');
  let body = bg.body, js = bg.js;
  if (style === 'flashes') {
    const pts = [[160, 420], [820, 600], [300, 980], [760, 1120], [520, 330], [240, 700], [880, 900], [480, 1180]];
    pts.forEach(([x, y], i) => { const t = (0.1 + i * (d - 0.3) / pts.length).toFixed(2); body += `<div id="f${i}" class="flash clip" data-start="0" data-duration="${d}" data-track-index="${3 + (i % 3)}" style="left:${x - 260}px;top:${y - 260}px"></div>`; js += `tl.fromTo("#f${i}",{opacity:1,scale:.5},{opacity:0,scale:1.4,duration:.24,immediateRender:false},${t});`; });
    body += `<div id="cam" class="clip" data-start="0" data-duration="${d}" data-track-index="8" style="position:absolute;left:0;right:0;top:640px;text-align:center;font-size:200px">📸</div>`;
    js += `tl.from("#cam",{scale:0,rotation:-20,duration:.3,ease:"back.out(2.5)"},0.05);tl.to("#cam",{rotation:6,duration:.12,yoyo:true,repeat:${Math.max(2, Math.floor(d / 0.24))},immediateRender:false},0.4);`;
  } else if (style === 'marquee') {
    const bulbs = Array.from({ length: 26 }, (_, i) => { const a = i / 26; const x = a < .5 ? 110 + a * 2 * 760 : 110 + (1 - a) * 2 * 760; const y = a < .5 ? 560 : 1000; return `<div class="bulb" style="position:absolute;left:${x}px;top:${y}px;width:26px;height:26px;border-radius:50%;background:#ffe9a8;box-shadow:0 0 18px #ffcc55"></div>`; }).join('');
    body += `<div id="mq" class="clip" data-start="0" data-duration="${d}" data-track-index="5" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px">${bulbs}<div style="position:absolute;left:150px;width:700px;top:610px;height:360px;background:#111;border:12px solid ${gold};display:flex;align-items:center;justify-content:center;text-align:center;font-size:${label.length > 22 ? 64 : 88}px;font-weight:900;color:#fff;text-transform:uppercase;line-height:1.05;padding:20px;box-sizing:border-box">${label || 'NOW SHOWING'}</div></div>`;
    js += `tl.from("#mq",{scale:.7,opacity:0,duration:.3,ease:"back.out(2)"},0);` + Array.from({ length: Math.max(3, Math.floor(d / 0.25)) }, (_, i) => `tl.set(".bulb",{opacity:${i % 2 ? 1 : .35}},${(i * 0.25).toFixed(2)});`).join('');
  } else if (style === 'clapper') {
    body += `<div id="cp" class="clip" data-start="0" data-duration="${d}" data-track-index="5" style="position:absolute;left:190px;top:560px;width:620px;height:460px">
<div id="cpt" style="position:absolute;left:0;top:0;width:620px;height:90px;background:repeating-linear-gradient(-45deg,#111 0 50px,#f3f3f3 50px 100px);border:6px solid #000;transform-origin:0 100%;transform:rotate(-24deg)"></div>
<div style="position:absolute;left:0;top:96px;width:620px;height:90px;background:repeating-linear-gradient(-45deg,#f3f3f3 0 50px,#111 50px 100px);border:6px solid #000"></div>
<div style="position:absolute;left:0;top:192px;width:620px;height:268px;background:#151515;border:6px solid #000;color:#fff;font-size:${label.length > 24 ? 46 : 60}px;font-weight:900;display:flex;align-items:center;justify-content:center;text-align:center;padding:16px;box-sizing:border-box;text-transform:uppercase">${label || 'SCENE 1 · TAKE 50'}</div></div>`;
    js += `tl.from("#cp",{y:220,opacity:0,duration:.3,ease:"power3.out"},0);tl.to("#cpt",{rotation:0,duration:.12,ease:"power4.in"},0.45);tl.fromTo("#cp",{x:-12},{x:0,duration:.25,ease:"elastic.out(1,.3)",immediateRender:false},0.57);`;
  } else if (style === 'spotlight') {
    body += `<div id="cl" class="clip" data-start="0" data-duration="${d}" data-track-index="4" style="position:absolute;left:0;top:0;width:${W / 2}px;height:${H}px;background:repeating-linear-gradient(90deg,#5a0b0b 0 40px,#7d1414 40px 80px)"></div><div id="cr" class="clip" data-start="0" data-duration="${d}" data-track-index="4" style="position:absolute;left:${W / 2}px;top:0;width:${W / 2}px;height:${H}px;background:repeating-linear-gradient(90deg,#7d1414 0 40px,#5a0b0b 40px 80px)"></div>
<div id="sl2" class="clip" data-start="0" data-duration="${d}" data-track-index="6" style="position:absolute;left:${SAFE.left}px;width:${SAFE.right - SAFE.left}px;top:720px;text-align:center;font-size:${label.length > 20 ? 74 : 100}px;font-weight:900;color:${gold};-webkit-text-stroke:5px #000;text-transform:uppercase">${label}</div>`;
    js += `tl.to("#cl",{xPercent:-82,duration:.7,ease:"power2.inOut"},0.1);tl.to("#cr",{xPercent:82,duration:.7,ease:"power2.inOut"},0.1);tl.from("#sl2",{scale:.5,opacity:0,duration:.3,ease:"back.out(2)"},0.55);`;
  } else if (style === 'filmstrip') {
    const frames = Array.from({ length: 6 }, (_, i) => `<div style="position:absolute;left:120px;top:${i * 420}px;width:520px;height:380px;background:${bg.body.includes('bg.jpg') ? 'url(bg.jpg) center/cover' : '#2a2216'};filter:sepia(.4) contrast(1.1)"></div>`).join('');
    const holes = Array.from({ length: 40 }, (_, i) => `<div style="position:absolute;left:30px;top:${i * 64}px;width:46px;height:34px;background:#ddd;border-radius:6px"></div><div style="position:absolute;left:684px;top:${i * 64}px;width:46px;height:34px;background:#ddd;border-radius:6px"></div>`).join('');
    body += `<div id="fs" class="clip" data-start="0" data-duration="${d}" data-track-index="5" style="position:absolute;left:170px;top:-400px;width:760px;height:2600px;background:#0d0d0d;transform:rotate(-6deg)">${holes}${frames}</div><div id="bm" class="beam clip" data-start="0" data-duration="${d}" data-track-index="7"></div>`;
    js += `tl.fromTo("#fs",{y:0},{y:-840,duration:${d},ease:"none"},0);tl.fromTo("#bm",{opacity:.4},{opacity:.9,duration:.2,yoyo:true,repeat:${Math.max(2, Math.floor(d / 0.2))},immediateRender:false},0);`;
  } else {
    body += `<div id="rl" class="clip" data-start="0" data-duration="${d}" data-track-index="5" style="position:absolute;left:240px;top:500px;width:600px;height:600px;border-radius:50%;background:radial-gradient(circle,#222 0 14%,#bbb 14% 18%,#222 18% 30%,transparent 30%),conic-gradient(#999 0 10%,#222 10% 20%,#999 20% 30%,#222 30% 45%,#999 45% 55%,#222 55% 70%,#999 70% 80%,#222 80% 100%);border:14px solid #555"></div>
<div id="rt" class="clip" data-start="0" data-duration="${d}" data-track-index="6" style="position:absolute;left:${SAFE.left}px;width:${SAFE.right - SAFE.left}px;top:1150px;text-align:center;font-size:64px;font-weight:900;color:${gold};-webkit-text-stroke:3px #000;text-transform:uppercase">${label}</div>`;
    js += `tl.fromTo("#rl",{rotation:0},{rotation:${Math.round(d * 160)},duration:${d},ease:"none"},0);tl.from("#rt",{y:50,opacity:0,duration:.3},0.2);`;
  }
  return [body + ex.body, js + ex.js];
}

// Outro: the question, the logo, and a SUBSCRIBE button that gets tapped (bell rings).
function endScene(v, d, ch, bg) {
  const gold = ch.accent || '#D9B26A'; const cx = (SAFE.left + SAFE.right) / 2;
  const cta = v.cta || ch.cta || 'for more Hollywood stories';
  const tap = Math.min(1.1, d * 0.45).toFixed(2);
  const body = `${bg.body}<div id="q" class="clip" data-start="0" data-duration="${d}" data-track-index="2" style="position:absolute;left:${SAFE.left + 10}px;width:${SAFE.right - SAFE.left - 100}px;top:330px;padding:40px 40px;background:#F5EBD7;color:#111;border:10px solid #000;box-shadow:16px 16px 0 ${gold};font-family:Georgia,serif;font-size:62px;font-weight:700;line-height:1.1;transform:rotate(-1.5deg)">${esc(v.text || '')}</div>
<img id="lg" class="clip" data-start="0" data-duration="${d}" data-track-index="4" src="logo.png" style="position:absolute;left:${cx - 100}px;top:640px;width:200px">
<div id="sb" class="clip" data-start="0" data-duration="${d}" data-track-index="5" style="position:absolute;left:${cx - 300}px;top:950px;width:600px;height:130px;border-radius:65px;background:#FF0033;color:#fff;font-size:62px;font-weight:900;display:flex;align-items:center;justify-content:center;gap:18px;box-shadow:0 10px 0 #000;letter-spacing:2px"><span id="sbt">SUBSCRIBE</span><span id="bell" style="font-size:58px">🔔</span></div>
<div id="cta" class="clip" data-start="0" data-duration="${d}" data-track-index="6" style="position:absolute;left:${SAFE.left}px;width:${SAFE.right - SAFE.left}px;top:868px;text-align:center;font-size:46px;font-weight:900;color:${gold};text-transform:uppercase;letter-spacing:1px;text-shadow:0 3px 8px #000">${esc(cta)}</div>
<div id="hand" class="clip" data-start="0" data-duration="${d}" data-track-index="7" style="position:absolute;left:${cx + 170}px;top:1030px;font-size:120px">👆</div>`;
  const js = bg.js + `tl.from("#q",{scale:.6,opacity:0,rotation:-8,duration:.3,ease:"back.out(2)"},0);tl.from("#lg",{scale:0,rotation:-90,duration:.35,ease:"back.out(2)"},0.12);
tl.from("#sb",{scale:0,duration:.3,ease:"back.out(2.5)"},0.25);tl.from("#cta",{y:40,opacity:0,duration:.25},0.35);
tl.from("#hand",{x:200,y:200,opacity:0,duration:.35,ease:"power2.out"},${(tap - 0.4).toFixed(2)});tl.to("#hand",{scale:.85,duration:.08,yoyo:true,repeat:1,immediateRender:false},${tap});
tl.to("#sb",{scale:.92,duration:.08,yoyo:true,repeat:1,immediateRender:false},${tap});tl.set("#sb",{backgroundColor:"#3a3a3a"},${(+tap + 0.08).toFixed(2)});tl.set("#sbt",{textContent:"SUBSCRIBED"},${(+tap + 0.08).toFixed(2)});
tl.to("#bell",{rotation:22,duration:.08,yoyo:true,repeat:7,immediateRender:false},${(+tap + 0.2).toFixed(2)});tl.to("#hand",{opacity:0,duration:.2,immediateRender:false},${(+tap + 0.35).toFixed(2)});`;
  return [body, js];
}

// Punch stamp over the last part of a beat (rendered as its own short shot), on the beat's background.
function punchHtml(n, text, d, ch, bgKind = null) {
  const bg = bgLayer(d, bgKind);
  const body = `${bg.body}<div id="pn" class="punch clip" data-start="0" data-duration="${d}" data-track-index="2">${esc(text)}</div>`;
  const js = bg.js + `tl.from("#pn",{scale:3,opacity:0,duration:.18,ease:"power4.out"},0);tl.fromTo("#pn",{x:-10},{x:0,duration:.25,ease:"elastic.out(1,.3)",immediateRender:false},0.18);tl.to("#pn",{scale:1.06,duration:${Math.max(0.1, d - 0.4).toFixed(2)},ease:"none",immediateRender:false},0.4);`;
  return page(`p${n}`, d, body, js, ch);
}

async function hyperRender(name, html, media, out, d) {
  const hf = require('./hyperframes');
  if (!hf.render) throw new Error('HyperFrames renderer not available');
  let last; // one worker (lighter on this PC), up to 3 tries — the renderer sometimes cancels itself
  for (let k = 0; k < 3; k++) {
    try { return await hf.render(name + (k ? '_r' + k : ''), html, media, out, d, ['render', '.', '-o', '{out}', '--fps', String(FPS), '--quality', 'delivery', '--workers', '1', '--quiet']); }
    catch (e) { last = e; await new Promise((r) => setTimeout(r, 5000)); }
  }
  throw last;
}

// ---------- captions (ASS) ----------
function assTime(t) { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = (t % 60).toFixed(2).padStart(5, '0'); return `${h}:${pad(m)}:${s}`; }
function captions(beats, file, hook = '') {
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n`
    + `Style: W,Arial Black,92,&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,1,0,0,0,100,100,0,0,1,9,5,5,60,160,0,1\n`
    + `Style: H,Arial Black,78,&H0000E5FF,&H0000E5FF,&H00000000,&HD0000000,1,0,0,0,100,100,0,0,3,18,0,5,60,160,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const ev = [];
  const cx = (SAFE.left + SAFE.right) / 2;
  for (const b of beats) {
    // 1-2 words per caption (two short words stay together), white with black stroke; key words neon yellow / red
    const words = String(b.text).replace(/[“”"]/g, '').split(/\s+/).filter(Boolean);
    const chunks = []; for (let i = 0; i < words.length; i++) { const w = words[i], nx = words[i + 1]; if (nx && w.length + nx.length <= 9 && !/[,.;:!?]$/.test(w)) { chunks.push([w, nx]); i++; } else chunks.push([w]); }
    const weights = chunks.map((c) => c.reduce((a, w) => a + 0.32 + w.replace(/[^\w$]/g, '').length * 0.085 + (/[,.;:!?]$/.test(w) ? 0.3 : 0), 0));
    const total = weights.reduce((a, c) => a + c, 0); const span = b.dur - 0.06;
    let t = b.start; let first = true;
    chunks.forEach((c, i) => {
      const len = (weights[i] / total) * span;
      const txt = c.map((w) => {
        const clean = w.replace(/[,;:]$/, '').toUpperCase().replace(/[{}\\]/g, '');
        const num = /[\d$%]/.test(w); const name = !first && /^[A-Z][a-z]/.test(w);
        first = /[.!?]$/.test(w);
        return num ? `{\\1c&H003B3BFF&}${clean}{\\1c&H00FFFFFF&}` : name ? `{\\1c&H0000E5FF&}${clean}{\\1c&H00FFFFFF&}` : clean;
      }).join(' ');
      ev.push(`Dialogue: 0,${assTime(t)},${assTime(t + len)},W,,0,0,0,,{\\pos(${cx},${CAPTION_Y})\\fscx72\\fscy72\\t(0,70,\\fscx104\\fscy104)\\t(70,130,\\fscx100\\fscy100)}${txt}`);
      t += len;
    });
  }
  if (hook) {
    const hw = String(hook).toUpperCase().replace(/[{}\\]/g, '').split(/\s+/);
    let cut = 1, best = 1e9; for (let k = 1; k < hw.length; k++) { const a = hw.slice(0, k).join(' ').length, b2 = hw.slice(k).join(' ').length; if (Math.abs(a - b2) < best) { best = Math.abs(a - b2); cut = k; } }
    const h = hw.length > 3 ? hw.slice(0, cut).join(' ') + '\\N' + hw.slice(cut).join(' ') : hw.join(' ');
    ev.unshift(`Dialogue: 1,${assTime(0)},${assTime(2.6)},H,,0,0,0,,{\\pos(${cx},300)\\fscx55\\fscy55\\t(0,120,\\fscx104\\fscy104)\\t(120,180,\\fscx100\\fscy100)\\t(2400,2600,\\alpha&HFF&)}${h}`);
  }
  fs.writeFileSync(file, '﻿' + head + ev.join('\n') + '\n');
}

// ---------- steps ----------
function dirOf(p) { return store.projectDir(p.id); }
function save(p) { store.saveProject(p); }

// Voice: one Voicebox take per beat → exact beat timings; 1.15x and every pause cut (jump-cut style).
async function voice(id, step = () => {}) {
  let p = store.getProject(id); const ch = store.getChannel(p.channel); const dir = dirOf(p);
  const beats = p.script?.beats || []; if (!beats.length) throw new Error('No script beats.');
  const vb = require('./voicebox');
  const speed = +(ch.voice?.speed || 1.15), gap = 0.05;
  let t = 0; const parts = [];
  for (let i = 0; i < beats.length; i++) {
    step(`Narrator: beat ${i + 1}/${beats.length}`);
    const f = path.join(dir, `vo_${pad(i + 1)}.wav`);
    const textFile = f + '.txt';
    if (fs.existsSync(f) && (!fs.existsSync(textFile) || fs.readFileSync(textFile, 'utf8') !== beats[i].text)) { fs.rmSync(f); for (const x of fs.readdirSync(dir)) if (x.startsWith(`vo_${pad(i + 1)}_x`)) fs.rmSync(path.join(dir, x)); }
    if (!fs.existsSync(f)) {
      // Gemini voice first when the channel says so; Voicebox otherwise, and Gemini whenever Voicebox cannot run
      // (Windows Smart App Control blocks a Voicebox file).
      const gem = () => require('./gemtts').speech(beats[i].text, { outFile: f, voice: ch.voice?.gemini_voice || 'Charon', style: ch.voice?.gemini_style || 'a confident, energetic movie-trailer narrator, American accent, clear and lively', onStep: step });
      if (ch.voice?.engine === 'gemini') await gem();
      else await vb.speech(beats[i].text, { outFile: f, engine: ch.voice?.engine, voice: ch.voice?.voice, onStep: step }).catch(async (e) => { step(`Voicebox failed (${e.message.slice(0, 60)}) — Gemini voice instead`); await gem(); });
      fs.writeFileSync(textFile, beats[i].text);
    }
    const fast = path.join(dir, `vo_${pad(i + 1)}_x${speed}.wav`);
    if (!fs.existsSync(fast)) await ff(['-i', f, '-af', `atempo=${speed},silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_duration=0.12:stop_threshold=-45dB,apad=pad_dur=0.02`, fast]);
    const d = await dur(fast); parts.push(fast);
    beats[i] = { ...beats[i], start: +t.toFixed(3), dur: +(d + gap).toFixed(3) }; t += d + gap;
  }
  const list = path.join(dir, 'vo_list.txt');
  const sil = path.join(dir, 'vo_gap.wav'); await ff(['-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(gap), sil]);
  fs.writeFileSync(list, parts.map((f) => `file '${f.replace(/\\/g, '/')}'\nfile '${sil.replace(/\\/g, '/')}'`).join('\n'));
  const out = path.join(dir, 'audio_narration.wav');
  await ff(['-f', 'concat', '-safe', '0', '-i', list, '-ar', '48000', '-ac', '2', out]);
  p = store.getProject(id);
  p.script = { ...p.script, beats };
  p.audio = [{ file: 'audio_narration.wav', label: 'narration', added: new Date().toISOString(), source: 'voicebox' }];
  p.picked_audio = 'audio_narration.wav';
  p.scenes = beats.map((b, i) => ({ n: i + 1, start: b.start, end: +(b.start + b.dur).toFixed(3), lyric: b.text, image: null }));
  store.log(p, 'Voice producer', `Narration by ${ch.voice?.engine === 'gemini' ? 'Gemini voice' : 'Voicebox'}: ${beats.length} beats, ${t.toFixed(1)} s at ${speed}x`);
  save(p);
  return t;
}

// Fetch / make the picture for one shot. Returns { img, media, v } (v may change type if nothing usable was found).
async function prepareShot(p, ch, dir, b, n, k, v0, step, credits) {
  const v = { ...v0 }; const media = {}; let img = null; const tag = `${pad(n)}${k ? '_' + k : ''}`;
  if (v.type === 'photo') {
    step(`Sources: beat ${n} shot ${k + 1} — ${v.person ? 'photo of ' + v.person : 'free-licence photo (' + v.query + ')'}`);
    let hit = null;
    if (v.person) {
      hit = await personPhoto(v.person, v.role || '').catch(() => null);
      // no Wikidata photo: a Commons file whose title/description names the person in full (never just the surname)
      // Commons fallback: the FILE NAME must be this person (full name), a photo (not an old engraving/painting of someone else),
      // and only them (no second person named in the file name).
      const nameParts = v.person.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
      const okFile = (h) => {
        const t = String(h?.title || '').toLowerCase().replace(/\.[a-z]+$/, '').replace(/[_().,'’-]/g, ' ');
        if (!nameParts.every((w) => new RegExp('\\b' + w + '\\b').test(t))) return false;
        if (/portret|portrait of|engraving|etching|painting|keizer|kaiser|emperor|king |queen |\b1[5-8]\d\d\b/.test(t)) return false;
        const rest = String(h.title).replace(/\.[a-z]+$/i, '').split(/[\s_]+/).filter((w) => /^[A-Z][a-z]{2,}$/.test(w) && !nameParts.includes(w.toLowerCase()) && !/^(At|In|The|And|With|During|Event|Launch|Premiere|Festival|Award|Awards|Smiling|Photo|Image|Concert|Live|Studio|Film|Movie|Press|Meet|Show|Music|Mumbai|Delhi|London|Paris|Cannes|India|Indian)$/.test(w));
        return rest.length < 2; // two extra capitalised words = most likely another person in the photo
      };
      if (!hit) for (const q of [`${v.person} portrait`, `${v.person} ${v.role ? v.role.split('|')[0] : ''}`, v.person]) { const h = await commons(q, { must: nameParts }).catch(() => null); if (h && okFile(h)) { hit = h; break; } }
    } else for (const q of [v.query, ...(v.fallback_queries || [])].filter(Boolean)) {
      // a named place/thing must really be in the file: every proper noun of the query (e.g. "Rivoli", "New", "York")
      const proper = (q.match(/\b[A-ZÀ-Ý][\wÀ-ÿ'.-]{2,}/g) || []).filter((w) => !/^(Studios?|Theatre|Theater|Film|Movie|Set|Building|Photo|Hollywood)$/i.test(w));
      hit = await commons(q, { must: [...(v.must || []), ...proper] }).catch(() => null); if (hit) break;
    }
    if (hit) img = await download(hit.url, path.join(dir, `src_${tag}.jpg`)).catch((e) => { step(`Sources: download failed (${e.message.slice(0, 60)}) — using a card`); return null; });
    if (hit && img) { v.credit = `Photo: ${hit.author} / ${hit.licence} (Wikimedia Commons)`; credits.push({ beat: n, shot: k, ...hit }); }
    if (!img) {
      v.type = v.fallback_type || 'headline';
      // a card that still says something: the planned fallback, else the beat's punch line, else its first clause
      v.text = v.fallback_text || b.punch || String(b.text).split(/[.;:—]/)[0].slice(0, 70);
      if (v.person && !v.kicker) v.kicker = v.person;
      step(`Sources: beat ${n} — no free photo, using a ${v.type} card`);
    }
  }
  if (v.type === 'panel') {
    const old = fs.readdirSync(dir).find((f) => new RegExp(`^src_${tag}\\.(jpe?g|png|webp)$`).test(f));
    if (old) img = path.join(dir, old);
    else {
      step(`Comic panel: beat ${n}`);
      try {
        const pr = `${ch.visual_style || ''} ${v.prompt} Comic-book panel, bold black ink outlines, halftone shading, strong colours, no text, no real person's face, no known characters. Vertical 4:5.`;
        const r = await require('./hfspace').image(pr).catch(async () => (await require('./browser').runTask('meta_image', { kind: 'images', prompt: pr, files: [] }, step)).results[0]);
        img = path.join(dir, `src_${tag}.${r.ext || 'jpg'}`); fs.writeFileSync(img, r.buffer);
      } catch (e) { step(`Comic panel failed (${e.message.slice(0, 80)}) — using a text card`); v.type = 'headline'; v.text = v.fallback_text || b.punch || b.text; }
    }
  }
  if (v.type === 'broll') {
    if (!v.kicker && v.text) v.kicker = v.text;
    step(`B-roll: beat ${n} — "${v.query}"`);
    const avoid = new Set((p.broll_used || []));
    const hit = await broll(v.query, avoid).catch(() => null);
    if (hit) {
      media['fg.mp4'] = hit.file; v.video = true; v.credit = `Footage: ${hit.author} / Pexels`;
      credits.push({ beat: n, shot: k, kind: 'video', ...hit });
      const q = store.getProject(p.id); q.broll_used = [...new Set([...(q.broll_used || []), hit.id])]; store.saveProject(q); p.broll_used = q.broll_used;
      const still = path.join(dir, `src_${tag}.jpg`); await ff(['-ss', '0.5', '-i', hit.file, '-frames:v', '1', still]).catch(() => {}); if (fs.existsSync(still)) { img = still; media['bgstill.jpg'] = still; }
    } else { v.type = 'fx'; step(`B-roll: none for "${v.query}"${store.getSettings().pexels_api_key ? '' : ' (no Pexels key yet)'} — cinema graphics instead`); }
  }
  if (v.type === 'clip') {
    const src = v.file && path.join(dir, v.file);
    if (src && fs.existsSync(src)) {
      const cut = path.join(dir, `clip_${tag}.mp4`);
      await ff(['-ss', String(v.from || 0), '-i', src, '-t', '6', '-an', '-vf', 'scale=1080:-2,fps=30', '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', cut]);
      media['fg.mp4'] = cut;
      const still = path.join(dir, `src_${tag}.jpg`); await ff(['-ss', '0.4', '-i', cut, '-frames:v', '1', still]); media['bgstill.jpg'] = still; img = still;
    } else { v.type = 'headline'; v.text = v.fallback_text || b.punch || b.text; }
  }
  // a card left with nothing to say (its claim was removed by the fact-checker) becomes cinema graphics
  if (/^(headline|quote)$/.test(v.type) && !String(v.text || '').trim()) { v.type = 'fx'; v.text = v.kicker || ''; }
  if (v.type === 'stat' && !String(v.value || '').trim()) { v.type = 'fx'; v.text = v.label || ''; }
  if (v.type === 'chart' && !(v.bars || []).length) { v.type = 'fx'; v.text = v.kicker || ''; }
  // Charts and stats: every number must be in the source article (no made-up comparisons like "average epic $150M").
  if (/^(chart|stat)$/.test(v.type)) {
    let src = ''; try { src = fs.readFileSync(path.join(dir, 'wiki.txt'), 'utf8').replace(/,/g, ''); } catch {}
    const inSrc = (x) => { const n = String(x).replace(/[^0-9.]/g, ''); return !src || (n && new RegExp('(^|[^0-9.])' + n.replace('.', '\\.') + '([^0-9]|$)').test(src)); };
    if (v.type === 'chart') {
      const good = (v.bars || []).filter((b) => inSrc(b.value));
      if (good.length < (v.bars || []).length) step(`Fact guard: chart beat ${n} — ${((v.bars || []).length - good.length)} number(s) not in the source removed`);
      if (good.length >= 2) v.bars = good;
      else if (good.length === 1) { v.type = 'stat'; v.value = `${v.prefix ?? ''}${good[0].value}${v.unit || ''}`; v.label = good[0].label; }
      else { v.type = 'fx'; v.text = v.kicker || ''; }
    } else if (!inSrc(v.value)) { step(`Fact guard: stat "${v.value}" not in the source — cinema graphic instead`); v.type = 'fx'; v.text = v.label || ''; }
  }
  if (img && !media['fg.mp4']) media['fg.jpg'] = img;
  if (img) { const sz = require('./quality').imgSize(fs.readFileSync(img)); v.hires = !!(sz && (Math.min(sz.w, sz.h) >= 1000 || (sz.h >= sz.w * 1.1 && sz.w >= 700))); }
  if (v.type === 'end') { const logo = path.join(store.P.root, 'brand', p.channel, 'logo.png'); if (fs.existsSync(logo)) media['logo.png'] = logo; }
  return { img, media, v };
}

// Visuals: every beat → its shots (+ punch stamp) rendered and joined into seg_NN.mp4, exactly the beat's length.
async function visuals(id, step = () => {}) {
  let p = store.getProject(id); const ch = store.getChannel(p.channel); const dir = dirOf(p);
  const beats = p.script.beats; const credits = []; let lastBg = null;
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i]; const n = i + 1;
    const seg = path.join(dir, `seg_${pad(n)}.mp4`);
    if (fs.existsSync(seg) && p.scenes?.[i]?.image) { const im = p.scenes[i].image; if (/\.jpe?g$/i.test(im) && fs.existsSync(path.join(dir, im))) lastBg = { kind: 'image', media: { 'bg.jpg': path.join(dir, im) } }; continue; }
    const d = +(+b.dur).toFixed(3);
    let shots = shotsOf(b, n, dir);
    const punchLen = b.punch && d >= 3 && !shots.some((x) => x.type === 'end') ? Math.min(1.3, Math.max(0.9, d * 0.25)) : 0;
    while (shots.length > 1 && (d - punchLen) / shots.length < 1.4) shots.pop();
    const times = splitTimes(d - punchLen, shots.length);
    const parts = []; const used = [];
    // pass 1: fetch every shot's picture/footage, so a card can sit on top of this beat's photo or footage
    const prep = [];
    for (let k = 0; k < shots.length; k++) prep.push(await prepareShot(p, ch, dir, b, n, k, shots[k], step, credits));
    const vid = prep.find((x) => x.media['fg.mp4'] && x.v.type === 'broll');
    const pic = prep.find((x) => x.img);
    let bg = null; const bgMedia = {};
    if (vid) { bg = 'video'; bgMedia['bg.mp4'] = vid.media['fg.mp4']; }
    else if (pic) { bg = 'image'; bgMedia['bg.jpg'] = pic.img; }
    else if (lastBg) { bg = lastBg.kind; Object.assign(bgMedia, lastBg.media); }
    if (bg) lastBg = { kind: bg, media: { ...bgMedia } };
    const cta = p.idea?.type === 'actor' ? 'for more legend stories' : p.idea?.type === 'movie' ? 'for more movie facts' : (ch.cta || 'for more Hollywood stories');
    for (let k = 0; k < shots.length; k++) {
      const { img, media, v } = prep[k];
      if (v.type === 'end') v.cta = v.cta || cta;
      const noKicker = n === 1 && k === 0 && (p.script.hook_title || p.script.title); // the hook title owns the top of the first shot
      step(`Rendering beat ${n}/${beats.length}, shot ${k + 1}/${shots.length} (${v.type})`);
      const out = path.join(dir, `seg_${pad(n)}_${k}.mp4`);
      const usesBg = !(img && /^(photo|panel|clip)$/.test(v.type)) && !(v.type === 'broll' && v.video);
      // cinema graphics with no picture of their own in this beat get the moving spotlight stage, not an older photo
      const ownBg = v.type === 'fx' && !vid && !pic ? null : bg;
      await hyperRender(`reel_${p.id}_b${n}s${k}`, shotHtml(n, k, v, times[k], ch, !!img, { noKicker, bg: usesBg ? ownBg : null, video: !!v.video }), usesBg && ownBg ? { ...media, ...bgMedia } : media, out, times[k]);
      parts.push([out, times[k]]); used.push({ ...v, img: img ? path.basename(img) : null, dur: times[k] });
    }
    if (punchLen) {
      const out = path.join(dir, `seg_${pad(n)}_p.mp4`);
      step(`Rendering beat ${n}: punch line "${b.punch}"`);
      await hyperRender(`reel_${p.id}_b${n}p`, punchHtml(n, b.punch, punchLen, ch, bg), bgMedia, out, punchLen);
      parts.push([out, punchLen]);
    }
    const l = path.join(dir, `seg_${pad(n)}_list.txt`);
    fs.writeFileSync(l, parts.map(([f, t]) => `file '${f.replace(/\\/g, '/')}'\noutpoint ${t.toFixed(3)}`).join('\n'));
    await ff(['-f', 'concat', '-safe', '0', '-i', l, '-an', '-vf', `fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-crf', '17', '-preset', 'veryfast', seg]);
    p = store.getProject(id);
    p.scenes[i] = { ...p.scenes[i], image: used.find((u) => u.img)?.img || `seg_${pad(n)}.mp4`, segment: path.basename(seg), shots: used.map((u) => ({ type: u.type, kicker: u.kicker || '', img: u.img, dur: u.dur, flashes: !!u.flashes || (u.type === 'fx' && fxStyle(u) === 'flashes') })), cuts: times.slice(0, -1).reduce((a, t) => [...a, (a[a.length - 1] || 0) + t], []).concat(punchLen ? [d - punchLen] : []), credit: credits.find((c) => c.beat === n) || null, credits: credits.filter((c) => c.beat === n) };
    save(p);
  }
  p = store.getProject(id);
  store.log(p, 'Visual director', `All ${beats.length} beats rendered (${(p.scenes || []).reduce((a, s) => a + (s.credits || []).length, 0)} real photos, all credited)`);
  save(p);
}

// Sound effects per cut, made here (nothing downloaded).
function sfx(kind, ms, k) {
  const tail = `aformat=sample_rates=48000:channel_layouts=stereo,adelay=${ms}|${ms}[s${k}]`;
  switch (kind) {
    case 'boom': return `aevalsrc='0.95*sin(2*PI*(42+140*exp(-22*t))*t)*exp(-5*t)':d=0.7:s=48000,volume=0.7,${tail}`;
    case 'hit': return `aevalsrc='0.9*sin(2*PI*(45+120*exp(-25*t))*t)*exp(-7*t)':d=0.45:s=48000,volume=0.5,${tail}`;
    case 'shutter': return `aevalsrc='(random(0)-0.5)*(exp(-300*t)+exp(-300*abs(t-0.045))*0.8)':d=0.12:s=48000,highpass=f=1800,volume=0.9,${tail}`;
    case 'click': return `aevalsrc='0.8*sin(2*PI*2200*t)*exp(-90*t)+0.5*(random(0)-0.5)*exp(-200*t)':d=0.08:s=48000,volume=0.8,${tail}`;
    case 'bell': return `aevalsrc='0.35*(sin(2*PI*1320*t)+0.6*sin(2*PI*1980*t)+0.3*sin(2*PI*2640*t))*exp(-4*t)':d=0.9:s=48000,volume=0.35,${tail}`;
    case 'pop': return `aevalsrc='0.5*sin(2*PI*(700+900*t*8)*t)*exp(-28*t)':d=0.14:s=48000,volume=0.45,${tail}`;
    case 'glitch': return `aevalsrc='0.4*sgn(sin(2*PI*180*t))*gt(random(0),0.5)*exp(-14*t)':d=0.16:s=48000,lowpass=f=5000,volume=0.25,${tail}`;
    default: return `anoisesrc=d=0.32:c=pink:a=0.7:r=48000,highpass=f=900,lowpass=f=6500,afade=t=in:d=0.11,afade=t=out:st=0.13:d=0.19,volume=0.13,${tail}`; // whoosh
  }
}

// Edit: join beats, narration, captions, hook, progress bar, music bed (ducked), sound effects, logo; Shorts spec.
async function edit(id, step = () => {}) {
  const p = store.getProject(id); const ch = store.getChannel(p.channel); const dir = dirOf(p);
  const beats = p.script.beats;
  step('Editor: joining beats');
  const list = path.join(dir, 'seg_list.txt');
  fs.writeFileSync(list, beats.map((b, i) => `file '${path.join(dir, `seg_${pad(i + 1)}.mp4`).replace(/\\/g, '/')}'\noutpoint ${(+b.dur).toFixed(3)}`).join('\n'));
  const joined = path.join(dir, 'reel_joined.mp4');
  await ff(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `scale=${W}:${H},fps=${FPS},format=yuv420p`, '-an', '-c:v', 'libx264', '-crf', '17', '-preset', 'veryfast', joined]);
  const ass = path.join(dir, 'reel_words.ass'); captions(beats, ass, p.script.hook_title || p.script.title || '');
  const logo = path.join(store.P.root, 'brand', p.channel, 'logo.png');
  const out = path.join(dir, 'final.mp4');
  const assArg = ass.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
  const total = await dur(path.join(dir, 'audio_narration.wav'));
  // music bed (made by code, see music.js) — one of three moods, picked per project so Shorts don't all sound alike
  const moods = ['tension', 'mystery', 'upbeat']; const mood = p.script.music || moods[[...p.id].reduce((a, c) => a + c.charCodeAt(0), 0) % 3];
  const bed = path.join(store.P.root, 'brand', p.channel, `bed_${mood}.wav`);
  if (!fs.existsSync(bed)) { step(`Editor: composing the ${mood} music bed`); require('./music').make(bed, { style: mood, seconds: 190 }); }
  const inputs = ['-i', joined, '-i', path.join(dir, 'audio_narration.wav'), '-i', bed];
  const gold = (ch.accent || '#D9B26A').replace('#', '0x');
  // video: captions + hook; progress bar just above the bottom title area; small logo top-left (inside the safe zone)
  let vf = `color=c=${gold}:s=${W}x8:r=${FPS}[pb];[0:v][pb]overlay=x='-W+W*t/${total.toFixed(2)}':y=${SAFE.bottom + 6}:shortest=1[vp];[vp]ass='${assArg}'[v0]`; let last = 'v0';
  if (fs.existsSync(logo)) { inputs.push('-i', logo); vf += `;[3:v]scale=96:-1[lg];[v0][lg]overlay=x=${W - 96 - 150}:y=${SAFE.top - 6}[v1]`; last = 'v1'; }
  // sound: a boom on the very first frame (auditory hook), whoosh/shutter/pop/glitch on every cut, a hit under pop words
  const ev = [{ t: 0, kind: 'boom' }];
  beats.forEach((b, i) => {
    const sc = (p.scenes || [])[i] || {}; const shots = sc.shots || [];
    if (i > 0) ev.push({ t: b.start, kind: 'whoosh' });
    (sc.cuts || []).forEach((c, q) => ev.push({ t: b.start + c, kind: q === (sc.cuts.length - 1) && b.punch ? 'hit' : 'whoosh' }));
    shots.forEach((s, q) => { const at = q === 0 ? b.start : b.start + (sc.cuts?.[q - 1] || 0); ev.push({ t: at + 0.02, kind: s.type === 'photo' ? 'shutter' : s.type === 'chart' ? 'glitch' : s.type === 'broll' ? 'whoosh' : 'pop' }); });
    for (const s of (b.shots || [b.visual].filter(Boolean))) if (s?.pop) ev.push({ t: b.start + 0.45, kind: 'hit' });
    shots.forEach((s, q) => {
      const at = q === 0 ? b.start : b.start + (sc.cuts?.[q - 1] || 0); const sd = s.dur || 1.5;
      if (s.type === 'end') { const tap = Math.min(1.1, sd * 0.45); ev.push({ t: at + tap, kind: 'click' }, { t: at + tap + 0.2, kind: 'bell' }); }
      if (s.flashes) for (let f = 0; f < Math.max(3, Math.min(6, Math.round(sd * 1.6))); f++) ev.push({ t: at + 0.15 + f * (sd - 0.4) / Math.max(3, Math.min(6, Math.round(sd * 1.6))), kind: 'shutter' });
    });
  });
  const evs = ev.filter((e) => e.t < total - 0.2).sort((a, b) => a.t - b.t).slice(0, 120);
  const fx = evs.map((e, k) => sfx(e.kind, Math.max(0, Math.round((e.t - (e.kind === 'whoosh' ? 0.1 : 0)) * 1000)), k));
  // the bed sits ~20 dB under the voice and ducks a further ~8 dB whenever the narrator speaks (sidechain)
  fx.push(`[2:a]atrim=0:${(total + 0.3).toFixed(2)},aformat=sample_rates=48000:channel_layouts=stereo,volume=${ch.music_volume ?? 0.55},afade=t=out:st=${Math.max(0, total - 1.2).toFixed(2)}:d=1.2[bedr]`);
  fx.push(`[1:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit=2[vo][vok]`);
  fx.push(`[bedr][vok]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=350:makeup=1[bedd]`);
  fx.push(`[vo][bedd]${evs.map((_, k) => `[s${k}]`).join('')}amix=inputs=${evs.length + 2}:duration=first:dropout_transition=0:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=9[aout]`);
  vf += ';' + fx.join(';');
  step('Editor: captions, hook, bar, logo, music bed, sound effects');
  const script = path.join(dir, 'reel_filter.txt'); fs.writeFileSync(script, vf);
  // YouTube Shorts spec: 1080x1920, H.264 High, 30 fps, yuv420p; AAC-LC 48 kHz stereo; MP4 with faststart
  await ff([...inputs, '-/filter_complex', script, '-map', `[${last}]`, '-map', '[aout]', '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-crf', '17', '-maxrate', '16M', '-bufsize', '24M', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-shortest', '-movflags', '+faststart', out], { timeout: 40 * 60000 });
  const q = store.getProject(id);
  const len = await dur(out);
  q.edit = { ...(q.edit || {}), file: 'final.mp4', approved: false, made: new Date().toISOString(), vertical: true, seconds: +len.toFixed(1), music: mood };
  store.log(q, 'Editor', `ReelBite Short ready (${len.toFixed(1)} s, 1080x1920, ${mood} bed)`);
  save(q);
  return out;
}

// Sources block for the description (every fact source + every photo credit).
function sourcesText(p) {
  const s = (p.script?.sources || []).map((x) => `• ${x.name}${x.url ? ' — ' + x.url : ''}`);
  const all = (p.scenes || []).flatMap((x) => x.credits || (x.credit ? [x.credit] : []));
  const seen = new Set(); const c = all.filter((x) => !seen.has(x.page) && seen.add(x.page)).map((x) => x.kind === 'video' ? `• Footage (illustrative): ${x.author}, Pexels — ${x.page}` : `• Photo: "${x.title}" by ${x.author}, ${x.licence} — ${x.page}`);
  return ['Sources:', ...s, ...(c.length ? ['', 'Image & footage credits:', ...c] : [])].join('\n');
}

// ---------- daily stories, grounded in Wikipedia ----------
async function wikiText(title) {
  const u = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts|info&inprop=url&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(title)}`;
  const j = await (await fetch(u, { headers: UA, signal: AbortSignal.timeout(30000) })).json();
  const pg = Object.values(j.query?.pages || {})[0];
  if (!pg || pg.missing !== undefined || !pg.extract) return null;
  return { title: pg.title, url: pg.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(pg.title.replace(/ /g, '_'))}`, text: pg.extract };
}

// Start one new ReelBite story: the brain proposes stories with their exact Wikipedia article; the first one with a
// solid article that was not done before becomes a full-auto project (script → fact-check → voice → visuals → edit → package).
async function newStory(channelId, step = () => {}) {
  const ch = store.getChannel(channelId);
  const done = store.listProjects(channelId).map((x) => store.getProject(x.id)).filter(Boolean);
  const used = new Set(done.map((x) => (x.wiki?.title || '').toLowerCase()).filter(Boolean));
  const recent = done.slice(0, 40).map((x) => '- ' + (x.title || x.idea?.title_en)).join('\n');
  const llm = require('./llm');
  // alternate: movie story, actor/actress legend biography, movie story ...
  const last = done.find((x) => x.idea?.type);
  const type = last?.idea?.type === 'movie' ? 'actor' : 'movie';
  const playlist = type === 'actor' ? 'Actor Facts' : 'Movie Facts';
  const ask = type === 'actor'
    ? 'Give 8 different LEGEND ACTORS or ACTRESSES of Hollywood (classic or modern, no longer controversial, well documented) whose life has a surprising turn. For each: the EXACT title of their English Wikipedia article (the person), a 3-7 word hook title about the surprising part, and why people will watch to the end.'
    : 'Give 8 different true MOVIE stories (a film\'s making, disaster, record, secret or comeback). For each: the EXACT title of the English Wikipedia article about that film or event (it must exist), a 3-7 word hook title, and why people will watch to the end.';
  step(`Story finder: looking for a ${type === 'actor' ? 'legend actor biography' : 'true movie story'} with a twist`);
  const { text: out } = await llm.chat([
    { role: 'system', content: 'You pick true Hollywood stories for 60-90 second YouTube Shorts (US/UK/Australia/Europe adults). Real, verifiable, surprising; a clear twist; no gossip, no rumours, nothing about minors, no living private persons.' },
    { role: 'user', content: `${ch.research?.brief || ''}\nAlready done (do NOT repeat):\n${recent || '- none'}\n\n${ask}\nJSON only: {"stories":[{"wiki_title":"","hook_title":"","angle":"","why":""}]}` },
  ], { noLocal: true, temperature: 0.9 });
  const cands = (out?.stories || []).filter((x) => x.wiki_title && !used.has(String(x.wiki_title).toLowerCase()));
  for (const c of cands) {
    const w = await wikiText(c.wiki_title).catch(() => null);
    if (!w || w.text.length < 4000 || used.has(w.title.toLowerCase())) continue;
    const pid = `${channelId}-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`;
    const p = { id: pid, channel: channelId, pipeline: ch.pipeline, title: c.hook_title || w.title, created: new Date().toISOString(), scenes: [], audio: [], log: [],
      idea: { title_en: c.hook_title || w.title, title_native: c.hook_title || w.title, angle: c.angle, why_it_can_go_viral: c.why, type, playlist }, wiki: { title: w.title, url: w.url },
      full_auto: true, autopilot: true, source: 'reel-daily' };
    store.log(p, 'Story finder', `Picked "${c.hook_title}" (${playlist}) — source: Wikipedia, ${w.title}`);
    store.saveProject(p);
    fs.writeFileSync(path.join(store.projectDir(pid), 'wiki.txt'), w.text);
    return pid;
  }
  throw new Error('no new story with a solid Wikipedia article this time');
}

// Fact-check: every spoken line, punch line and card text is checked against the article. One rewrite, then Anand.
async function factcheck(id, step = () => {}) {
  const p = store.getProject(id);
  const text = (() => { try { return fs.readFileSync(path.join(store.projectDir(id), 'wiki.txt'), 'utf8').slice(0, 16000); } catch { return ''; } })();
  if (!text) throw new Error('no source article saved for this story');
  const claims = (p.script.beats || []).map((b, i) => `${i + 1}. SAID: ${b.text}${b.punch ? ' | PUNCH: ' + b.punch : ''}${(b.shots || [b.visual].filter(Boolean)).map((v) => v.text || v.value || (v.bars ? v.bars.map((x) => x.label + ' ' + x.value).join(', ') : '') || '').filter(Boolean).map((t) => ' | CARD: ' + t).join('')}`).join('\n');
  step('Fact-checker: checking every line against the source');
  const { text: out } = await require('./llm').chat([
    { role: 'system', content: 'You are a strict fact-checker for a news channel. You compare claims with a source text only.' },
    { role: 'user', content: `SOURCE TEXT:\n${text}\n\nCLAIMS (one line per beat):\n${claims}\n\nFor every beat, list any fact, number, date, name or quote that is NOT supported by the source text (wording may differ, meaning must match; a rounded number is fine). Also flag anything stated as fact that the source calls a rumour or claim. The LAST beat may repeat or lead back into beat 1's fact (a loop) — that is fine if beat 1's fact is supported. Opinions clearly worded as opinion are fine; hype stated as fact ("changed history forever") is not.\nJSON only: {"ok":true,"problems":[{"beat":1,"claim":"","why":""}]}` },
  ], { noLocal: true, temperature: 0 });
  const problems = (out?.problems || []).filter((x) => x && x.claim);
  const q = store.getProject(id);
  if (!problems.length) {
    q.script = { ...q.script, checked: true, approved: true };
    store.log(q, 'Fact-checker', 'Every line matches the source — script approved');
    store.saveProject(q); return { ok: true };
  }
  store.log(q, 'Fact-checker', `${problems.length} unsupported: ${problems.map((x) => `beat ${x.beat}: ${x.claim}`).join('; ').slice(0, 500)}`);
  if ((q.factcheck_rounds || 0) >= 2) { q.hold = 'facts still not supported after a rewrite: ' + problems.map((x) => x.claim).join('; ').slice(0, 300); store.log(q, 'Brain', 'Needs Anand: ' + q.hold); store.saveProject(q); try { await require('./notify').send(`ReelBite · ${q.title}: needs you — ${q.hold}`, { project: id, priority: 4 }); } catch {} return { ok: false, held: true }; }
  q.factcheck_rounds = (q.factcheck_rounds || 0) + 1;
  // targeted fix: only the flagged beats are rewritten (the story, hook, twist and shots stay as they are)
  const bad = [...new Set(problems.map((x) => +x.beat).filter((n) => n >= 1 && n <= q.script.beats.length))];
  step(`Fact-checker: fixing beat${bad.length > 1 ? 's' : ''} ${bad.join(', ')}`);
  const { text: fix } = await require('./llm').chat([
    { role: 'system', content: 'You correct single lines of a short-video script so every fact matches the source text. Keep the same energy and length; change as little as possible.' },
    { role: 'user', content: `SOURCE TEXT:\n${text}\n\nWHOLE SCRIPT (for context):\n${q.script.beats.map((b, i) => `${i + 1}. ${b.text}${b.punch ? ' [PUNCH: ' + b.punch + ']' : ''}`).join('\n')}\n\nPROBLEMS:\n${problems.map((x) => `beat ${x.beat}: "${x.claim}" — ${x.why}`).join('\n')}\n\nRewrite ONLY beats ${bad.join(', ')}: drop or correct the unsupported part, using only facts in the source. Keep a punch line (1-4 words, true) where there was one; the last beat must still lead back into beat 1.\nJSON only: {"beats":[{"n":1,"text":"","punch":""}]}` },
  ], { noLocal: true, temperature: 0.2 });
  for (const f of (fix?.beats || [])) { const b = q.script.beats[+f.n - 1]; if (b && f.text && bad.includes(+f.n)) { b.text = f.text; b.punch = f.punch || ''; } }
  // cards (headline / quote / stat / chart / labels) that carry an unsupported claim are taken out of the video
  const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const x of problems) {
    const b = q.script.beats[+x.beat - 1]; if (!b || !Array.isArray(b.shots)) continue;
    const c = norm(x.claim); if (!c) continue;
    const hit = (v) => [v.text, v.value, v.label, v.kicker, v.pop, ...(v.bars || []).map((y) => y.label + ' ' + y.value)].some((t) => { const n = norm(t); return n && (n.includes(c) || c.includes(n)); });
    if (b.punch && (norm(b.punch).includes(c) || c.includes(norm(b.punch)))) b.punch = '';
    const keep = b.shots.filter((v) => v.type === 'end' || /^(photo|broll|fx|panel|clip)$/.test(v.type) || !hit(v));
    b.shots = keep.length ? keep.map((v) => (/^(photo|broll|fx|panel)$/.test(v.type) && hit(v) ? { ...v, kicker: '', pop: '', text: '' } : v)) : [{ type: 'fx', text: '' }];
  }
  q.script.text = q.script.beats.map((b) => b.text).join('\n');
  store.saveProject(q);
  return factcheck(id, step);
}

// ---------- upload package: SEO + geo for US / UK / Australia / Europe ----------
// Real search demand: YouTube's own search suggestions (what people type) in each target country.
async function suggestions(q, gl) {
  try {
    const r = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=en&gl=${gl}&q=${encodeURIComponent(q)}`, { headers: UA, signal: AbortSignal.timeout(15000) });
    const j = JSON.parse(Buffer.from(await r.arrayBuffer()).toString('latin1'));
    return (j[1] || []).map(String);
  } catch { return []; }
}
// What already wins for this topic (titles + views), via the Studio's own free YouTube key.
async function topVideos(q) {
  const key = store.getSettings().youtube_api_key; if (!key) return [];
  try {
    const s = await (await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=12&relevanceLanguage=en&regionCode=US&q=${encodeURIComponent(q)}&key=${key}`)).json();
    const ids = (s.items || []).map((i) => i.id.videoId).join(',');
    if (!ids) return [];
    const v = await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${ids}&key=${key}`)).json();
    return (v.items || []).map((x) => ({ title: x.snippet.title, views: +x.statistics.viewCount || 0, channel: x.snippet.channelTitle, short: /^PT(\d+S|[0-2]M(\d+S)?)$/.test(x.contentDetails.duration) }));
  } catch { return []; }
}
function srt(beats) {
  const t = (x) => { const ms = Math.round(x * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s2 = Math.floor(ms / 1000) % 60; return `${pad(h)}:${pad(m)}:${pad(s2)},${String(ms % 1000).padStart(3, '0')}`; };
  return beats.map((b, i) => `${i + 1}\n${t(b.start)} --> ${t(b.start + b.dur)}\n${b.text}\n`).join('\n');
}
// Evening prime time of the target audience, shown in IST (Anand schedules the upload).
const SLOTS_IST = [
  { ist: '05:30', why: 'US evening (7 pm New York / 4 pm Los Angeles)' },
  { ist: '23:30', why: 'UK & Europe evening (6 pm London / 7 pm Paris)' },
  { ist: '14:30', why: 'Australia evening (8 pm Sydney) + UK morning commute' },
];

async function packageShort(id, step = () => {}) {
  const p = store.getProject(id); const ch = store.getChannel(p.channel); const dir = store.projectDir(id);
  const subject = p.wiki?.title?.replace(/\s*\([^)]*\)\s*$/, '') || p.title;
  step('Publisher: reading search demand (US, UK, Australia) and what already ranks');
  const playlist = p.idea?.playlist || (p.idea?.type === 'actor' ? 'Actor Facts' : 'Movie Facts');
  const seeds = [subject, p.idea?.type === 'actor' ? `${subject} biography` : `${subject} movie`, `${subject} facts`, ...(p.script.beats || []).flatMap((b) => (b.shots || []).map((v) => v.person)).filter(Boolean).slice(0, 2)];
  const sugg = {};
  for (const gl of ['US', 'GB', 'AU']) for (const q of seeds.slice(0, 4)) for (const x of await suggestions(q, gl)) sugg[x] = (sugg[x] || 0) + 1;
  const demand = Object.entries(sugg).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, n]) => `${k} (${n})`);
  const ranks = (await topVideos(subject)).slice(0, 10);
  step('Publisher: titles, description, tags');
  const { text: out } = await require('./llm').chat([
    { role: 'system', content: `You are the head of packaging for ${ch.name}, a YouTube Shorts channel of true Hollywood stories for adults in the US, UK, Australia and Europe. You write titles that win the Shorts feed AND search, with zero clickbait: every promise must be true to the video. US spelling.` },
    { role: 'user', content: `VIDEO: ${p.title} (${p.edit?.seconds || ''} s)\nSubject: ${subject}\nScript: ${(p.script.beats || []).map((b) => b.text).join(' ')}\n\nREAL SEARCH SUGGESTIONS people type on YouTube (US/UK/AU; number = how many lists it appeared in):\n${demand.join('\n') || '(none found)'}\n\nWHAT RANKS NOW for "${subject}" (title — views):\n${ranks.map((r) => `- ${r.title} — ${r.views.toLocaleString('en-US')}${r.short ? ' (Short)' : ''}`).join('\n') || '(no data)'}\n\n${ch.publish_rules || ''}\n` +
      `RULES:\n- titles: 3 alternatives, best first. Under 60 characters (the Shorts feed shows ~40). The searchable subject (film/person name) inside the first 40 characters, then the surprising fact. 0-1 emoji at the end. Title Case. No ALL CAPS words, no "you won't believe".\n- description_first_line: one sentence with the main keywords (it is what search shows).\n- description_body: 2-3 short natural sentences (no keyword stuffing — a human must enjoy reading them) that add context and work in 3-5 of the real search phrases (subject, year, studio, people).\n- tags: 18-25 tags, most specific first (exact film/person names, then the real search phrases above, then broad: hollywood history, movie facts, box office...). Total under 450 characters.\n- hashtags: exactly 3: "#shorts" then the two strongest topic hashtags (no spaces).\n- pinned_comment: one question that makes people answer (a debate, not "like and subscribe").\n- search_phrases: the 5 real phrases you targeted.\nJSON only: {"titles":["","",""],"description_first_line":"","description_body":"","tags":[""],"hashtags":["#shorts","",""],"pinned_comment":"","search_phrases":[""]}` },
  ], { noLocal: true, temperature: 0.6 });
  let titles = (out?.titles || []).map((t) => String(t).trim()).filter(Boolean);
  titles = titles.map((t) => (t.length > 60 ? t.slice(0, 59).replace(/\s+\S*$/, '') : t));
  if (!titles.length) throw new Error('no titles came back');
  let tags = [...new Set((out.tags || []).map((t) => String(t).replace(/[#<>,]/g, '').trim()).filter((t) => t && !/trailer|full movie|reaction|official clip|free download/i.test(t)))];
  while (tags.join(',').length > 480) tags.pop();
  const hashtags = ['#shorts', ...(out.hashtags || []).filter((h) => !/^#shorts$/i.test(h)).map((h) => '#' + String(h).replace(/[^A-Za-z0-9]/g, '')).filter((h) => h.length > 2)].slice(0, 3);
  const description = `${out.description_first_line || ''}\n${out.description_body || ''}\n\n${sourcesText(p)}\n\n${hashtags.join(' ')}`;
  // captions file (uploading it helps search and sound-off viewers) + cover frame (the hook frame with the title)
  fs.writeFileSync(path.join(dir, 'captions_en.srt'), srt(p.script.beats));
  await ff(['-ss', '1.2', '-i', path.join(dir, 'final.mp4'), '-frames:v', '1', '-q:v', '2', path.join(dir, 'cover.jpg')]).catch(() => {});
  const done = store.listProjects(p.channel).map((x) => store.getProject(x.id)).filter((x) => x && x.publish?.titles && x.id !== id).length;
  const slot = SLOTS_IST[done % SLOTS_IST.length];
  const q = store.getProject(id);
  q.publish = { titles, description, tags, hashtags, pinned_comment: out.pinned_comment || '', search_phrases: out.search_phrases || [], demand: demand.slice(0, 15), approved: true, cover: 'cover.jpg', captions: 'captions_en.srt', schedule_ist: slot.ist, schedule_why: slot.why, category: 'Entertainment', language: 'English', playlist };
  const upload = [
    'REELBITE — UPLOAD SHEET', '',
    `TITLE (use this):  ${titles[0]}`, `Other options:     ${titles.slice(1).join('  |  ')}`, '',
    'DESCRIPTION (paste as is):', description, '',
    `TAGS (paste, comma-separated):\n${tags.join(', ')}`, '',
    `PINNED COMMENT: ${out.pinned_comment || ''}`, '',
    'SETTINGS:',
    '- File: final.mp4 (1080x1920, 30 fps, H.264, AAC 48 kHz, under 3 min → a Short)',
    '- Audience: No, it\'s not made for kids',
    '- Category: Entertainment · Video language: English · Caption language: English',
    '- Subtitles: upload captions_en.srt (Studio → Subtitles → Upload file → With timing)',
    `- Thumbnail: in the YouTube app pick the frame at 0:01 (the hook title frame — cover.jpg shows it)`,
    '- Comments: on, Hold potentially inappropriate comments → Strict',
    `- Playlist: ${playlist}  (make both playlists once on YouTube: "Movie Facts" and "Actor Facts")`,
    '- Remix: allowed (helps reach)',
    '- Related video: your best-performing ReelBite Short',
    `- Visibility: Schedule for ${slot.ist} IST — ${slot.why}. (Or Private first, public after ~2 hours.)`, '',
    `SEARCH PHRASES TARGETED: ${(out.search_phrases || []).join(' · ')}`,
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'upload.txt'), upload);
  fs.writeFileSync(path.join(dir, 'upload.json'), JSON.stringify(q.publish, null, 2));
  store.log(q, 'Publisher', `Ready to upload: "${titles[0]}" — schedule ${slot.ist} IST (${slot.why}); upload.txt has everything`);
  store.saveProject(q);
  try { await require('./notify').send(`ReelBite · "${titles[0]}" is ready — upload at ${slot.ist} IST. Title, description, tags and captions are in upload.txt.`, { project: id, priority: 3 }); } catch {}
}

// Final check before the package: length, loudness, black frames/freezes (shared QA), Shorts limit.
async function check(id, step = () => {}) {
  const p = store.getProject(id); const dir = store.projectDir(id);
  step('Quality checker: watching the final cut');
  const r = await require('./media').qa(path.join(dir, p.edit.file)).catch((e) => ({ ok: false, problems: [e.message] }));
  const len = await dur(path.join(dir, p.edit.file));
  if (len > 179) r.problems = [...(r.problems || []), `too long for a Short (${len.toFixed(0)} s)`];
  const q = store.getProject(id);
  q.qa = { ...r, ok: r.ok && len <= 179 };
  if (q.qa.ok) { q.edit = { ...q.edit, approved: true }; store.log(q, 'Quality checker', `Final cut passed (${len.toFixed(1)} s): no freezes or black frames, loudness fine`); }
  else { q.hold = 'final cut problems: ' + (q.qa.problems || []).join('; '); store.log(q, 'Quality checker', q.hold); }
  store.saveProject(q);
}

// One button: make the whole Short from wherever the project is (used by the Studio page and by story ideas picked by hand).
async function auto(id, step = () => {}) {
  let p = store.getProject(id); const dir = store.projectDir(id);
  if (!fs.existsSync(path.join(dir, 'wiki.txt'))) {
    // no source saved (idea picked from research): find its Wikipedia article so every fact can be checked
    const q = p.idea?.subject || p.idea?.title_en || p.title;
    step(`Source: finding the Wikipedia article for "${q}"`);
    const llm = require('./llm');
    // Real candidates from Wikipedia search (newest films included), then the brain picks the one the story is really about.
    const about = [q, p.idea?.angle, p.idea?.why_it_can_go_viral, p.idea?.evidence].filter(Boolean).join(' — ').slice(0, 600);
    const cands = [];
    for (const term of [q, `${q} film`, String(p.idea?.evidence || '').split(/[—|]/)[0]].filter(Boolean)) {
      try { const j = await (await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=6&srsearch=${encodeURIComponent(term.slice(0, 120))}`, { headers: UA, signal: AbortSignal.timeout(20000) })).json(); for (const x of j.query?.search || []) if (!cands.some((c) => c.title === x.title)) cands.push({ title: x.title, snippet: strip(x.snippet).slice(0, 160), words: x.wordcount }); } catch {}
    }
    const { text: o } = await llm.chat([{ role: 'user', content: `Story: ${about}\nScript start: ${(p.script?.beats || []).slice(0, 2).map((b) => b.text).join(' ')}\n\nWikipedia articles found:\n${cands.map((c, i) => `${i + 1}. ${c.title} (${c.words} words) — ${c.snippet}`).join('\n')}\n\nWhich ONE article is this story really about (the same film/person/event, the right year)? If none fits, answer "". JSON only: {"wiki_title":""}` }], { noLocal: true, temperature: 0 });
    if (!o?.wiki_title) throw new Error('no Wikipedia article clearly matches this story — pick another story or tell the agents which film it is');
    const w = await wikiText(o.wiki_title);
    if (!w || w.text.length < 3000) throw new Error('no Wikipedia article found to check the facts against — pick another story');
    fs.writeFileSync(path.join(dir, 'wiki.txt'), w.text);
    p = store.getProject(id); p.wiki = { title: w.title, url: w.url };
    const src = p.script?.sources || []; if (p.script && !src.some((x) => x.url === w.url)) p.script.sources = [{ name: `Wikipedia — ${w.title}`, url: w.url }, ...src];
    if (p.script) p.script.checked = false;
    store.log(p, 'Source finder', `Source: Wikipedia, ${w.title}`); store.saveProject(p);
  }
  p = store.getProject(id);
  if (!p.script?.beats?.length) { await require('./agents').runLLM(p, 'script', { note: p.script_note || '' }); store.saveProject(p); }
  p = store.getProject(id);
  if (!p.script.checked) { const r = await factcheck(id, step); if (!r.ok) return { held: true }; }
  p = store.getProject(id);
  if (!(p.audio || []).length) await voice(id, step);
  await visuals(id, step);
  await edit(id, step);
  await check(id, step);
  if (store.getProject(id).hold) return { held: true };
  await packageShort(id, step);
  return { done: true };
}

// Start again from one step (Studio "Restart from" and the chat). Later steps are cleared; files of earlier steps are kept.
function restartFrom(id, from, note = '') {
  const order = ['script', 'voice', 'visuals', 'edit', 'publish'];
  const k = order.indexOf(from); if (k < 0) throw new Error('unknown step ' + from);
  const p = store.getProject(id); const dir = store.projectDir(id);
  const rm = (re) => { for (const f of fs.readdirSync(dir)) if (re.test(f)) try { fs.rmSync(path.join(dir, f), { force: true }); } catch {} };
  if (k <= 0) { p.script = null; p.script_note = note; p.factcheck_rounds = 0; }
  if (k <= 1) { rm(/^vo_/); p.audio = []; p.picked_audio = null; p.scenes = []; }
  if (k <= 2) { rm(/^(seg_|src_|clip_)/); p.scenes = (p.scenes || []).map((x) => ({ ...x, image: null, segment: null })); }
  if (k <= 3) { rm(/^(final\.mp4|reel_joined\.mp4)$/); p.edit = {}; p.qa = null; }
  p.publish = null;
  delete p.hold; delete p.error;
  store.log(p, 'Anand', `Restart from ${from}${note ? ' — ' + note : ''}`);
  store.saveProject(p);
}

module.exports = { auto, restartFrom, voice, visuals, edit, factcheck, check, packageShort, newStory, wikiText, commons, personPhoto, sourcesText, captions, shotHtml, punchHtml, SAFE };
