// HyperFrames (HeyGen, Apache-2.0): HTML + GSAP → MP4, rendered in headless Chrome + FFmpeg on this PC.
// Used by the editor for the animated title opening and the end card. If anything fails the editor
// simply continues with the plain FFmpeg version — a video is never blocked by this.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');

const DIR = path.join(store.P.root, 'tools', 'hf-render');
const BIN = path.join(DIR, 'node_modules', '.bin', process.platform === 'win32' ? 'hyperframes.cmd' : 'hyperframes');
const ready = () => fs.existsSync(BIN) && store.getSettings().edit_hyperframes !== false;

const esc = (t) => String(t || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FONTS = "'Nirmala UI','Noto Sans Kannada','Noto Sans Devanagari','Segoe UI',sans-serif";

function run(args, cwd, timeoutMs = 15 * 60000) {
  return new Promise((res, rej) => {
    const pr = spawn(BIN, args, { cwd, windowsHide: true, shell: process.platform === 'win32' });
    let log = '';
    pr.stdout.on('data', (d) => (log += d));
    pr.stderr.on('data', (d) => (log += d));
    const t = setTimeout(() => { pr.kill(); rej(new Error('HyperFrames took too long')); }, timeoutMs);
    pr.on('close', (c) => { clearTimeout(t); c === 0 ? res(log) : rej(new Error('HyperFrames: ' + log.slice(-400))); });
    pr.on('error', (e) => { clearTimeout(t); rej(e); });
  });
}

// Writes one composition folder (index.html + copied media) and renders it to `out`.
async function render(name, html, media, out, dur, argsOverride) {
  const work = path.join(store.P.root, 'data', 'hf_work', name + '_' + Date.now());
  fs.mkdirSync(work, { recursive: true });
  for (const [k, src] of Object.entries(media)) if (src && fs.existsSync(src)) fs.copyFileSync(src, path.join(work, k));
  fs.writeFileSync(path.join(work, 'index.html'), html);
  const gsapJs = path.join(DIR, 'node_modules', 'gsap', 'dist', 'gsap.min.js');
  if (fs.existsSync(gsapJs)) { fs.copyFileSync(gsapJs, path.join(work, 'gsap.min.js')); html = html.replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/gsap@[^"]+/, 'gsap.min.js'); fs.writeFileSync(path.join(work, 'index.html'), html); }
  const flags = argsOverride || store.getSettings().hyperframes_render_args || ['render', '.', '-o', '{out}', '--fps', '30', '--quality', 'delivery', '--workers', '2', '--quiet'];
  try {
    await run(flags.map((f) => (f === '{out}' ? out : f)), work, Math.max(5, dur) * 60000);
    if (!fs.existsSync(out)) throw new Error('HyperFrames finished but no video file was written');
    return out;
  } finally { try { fs.rmSync(work, { recursive: true, force: true }); } catch {} }
}

const page = (id, dur, body, script) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#000}#stage{position:relative;width:1920px;height:1080px;overflow:hidden;font-family:${FONTS}}
.full{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
</style></head><body>
<div id="stage" data-composition-id="${id}" data-start="0" data-width="1920" data-height="1080">
${body}
</div>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script>
const tl = gsap.timeline({ paused: true });
${script}
window.__timelines = window.__timelines || {}; window.__timelines["${id}"] = tl;
</script></body></html>`;

// Opening shot: the first scene clip (or picture) with the song title animating in — the hook stays on screen.
async function titleOpening({ clip, image, titleNative, titleEn, color = '#ffd400', dur = 4.5 }, out) {
  const bg = clip ? `<video class="clip full" data-start="0" data-duration="${dur}" data-track-index="0" src="bg.mp4" muted playsinline></video>`
    : `<img id="bgimg" class="clip full" data-start="0" data-duration="${dur}" data-track-index="0" src="bg.jpg">`;
  const body = `${bg}
<div id="shade" class="clip" data-start="0" data-duration="${dur}" data-track-index="1" style="position:absolute;left:0;right:0;bottom:0;height:420px;background:linear-gradient(transparent,rgba(0,0,0,.65))"></div>
<div id="t1" class="clip" data-start="0.3" data-duration="${dur - 0.3}" data-track-index="2" style="position:absolute;left:0;right:0;bottom:170px;text-align:center;font-size:118px;font-weight:800;color:${color};text-shadow:0 6px 0 #3a1a00,0 10px 30px rgba(0,0,0,.6)">${esc(titleNative)}</div>
<div id="t2" class="clip" data-start="0.8" data-duration="${dur - 0.8}" data-track-index="3" style="position:absolute;left:0;right:0;bottom:95px;text-align:center;font-size:52px;font-weight:700;color:#fff;text-shadow:0 4px 14px rgba(0,0,0,.7)">${esc(titleEn)}</div>`;
  const script = `${clip ? '' : 'tl.fromTo("#bgimg",{scale:1},{scale:1.08,duration:' + dur + ',ease:"none"},0);'}
tl.from("#t1",{y:80,opacity:0,scale:.85,duration:.7,ease:"back.out(1.8)"},0.3);
tl.from("#t2",{y:40,opacity:0,duration:.6,ease:"power2.out"},0.8);
tl.to(["#t1","#t2","#shade"],{opacity:0,duration:.5},${(dur - 0.6).toFixed(2)});`;
  return render('opening', page('opening', dur, body, script), { 'bg.mp4': clip, 'bg.jpg': image }, out, dur);
}

// End card: last picture softly zooming, logo, a warm goodbye line (no subscribe ask on kids channels).
async function endCard({ image, logo, line, sub, color = '#ffd400', dur = 6 }, out) {
  const body = `<img id="bg" class="clip full" data-start="0" data-duration="${dur}" data-track-index="0" src="bg.jpg" style="filter:blur(6px) brightness(.7)">
${logo ? `<img id="lg" class="clip" data-start="0.2" data-duration="${dur - 0.2}" data-track-index="1" src="logo.png" style="position:absolute;left:50%;top:210px;width:300px;transform:translateX(-50%)">` : ''}
<div id="l1" class="clip" data-start="0.6" data-duration="${dur - 0.6}" data-track-index="2" style="position:absolute;left:0;right:0;top:${logo ? 560 : 420}px;text-align:center;font-size:96px;font-weight:800;color:${color};text-shadow:0 6px 0 #3a1a00">${esc(line)}</div>
${sub ? `<div id="l2" class="clip" data-start="1.1" data-duration="${dur - 1.1}" data-track-index="3" style="position:absolute;left:0;right:0;top:${logo ? 700 : 560}px;text-align:center;font-size:48px;color:#fff">${esc(sub)}</div>` : ''}`;
  const script = `tl.fromTo("#bg",{scale:1.05},{scale:1.15,duration:${dur},ease:"none"},0);
${logo ? 'tl.from("#lg",{scale:.4,opacity:0,duration:.7,ease:"back.out(2)"},0.2);' : ''}
tl.from("#l1",{y:60,opacity:0,duration:.6,ease:"power2.out"},0.6);
${sub ? 'tl.from("#l2",{opacity:0,duration:.6},1.1);' : ''}
tl.to("#stage",{opacity:0,duration:.6},${(dur - 0.6).toFixed(2)});`;
  return render('endcard', page('endcard', dur, body, script), { 'bg.jpg': image, 'logo.png': logo }, out, dur);
}

module.exports = { ready, titleOpening, endCard, render, BIN };
