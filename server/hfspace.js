// Free Hugging Face Spaces (ZeroGPU) through their Gradio API.
// Free quota: about 5 GPU-minutes a day with a free HF token (2 without one) — plenty for images, a few video clips.
// Which Spaces to use lives in config/hf_spaces.json, so new ones (e.g. from the Scout) can be added without code.
const fs = require('fs');
const path = require('path');
const store = require('./store');

const FILE = path.join(store.P.root, 'config', 'hf_spaces.json');
const list = (kind) => (store.readJSON(FILE, { images: [], videos: [] })[kind] || []).filter((x) => x.enabled !== false);

const baseOf = (host) => (/^https?:\/\//.test(host) ? host.replace(/\/+$/, '') : `https://${host}`);
function auth() { const t = store.getSettings().hf_token; return t ? { Authorization: 'Bearer ' + t } : {}; }

async function upload(host, file) {
  const fd = new FormData();
  fd.append('files', new Blob([fs.readFileSync(file)]), path.basename(file));
  const r = await fetch(`${baseOf(host)}/gradio_api/upload`, { method: 'POST', headers: auth(), body: fd, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`upload to ${host} failed (${r.status})`);
  const j = await r.json();
  return { path: j[0], meta: { _type: 'gradio.FileData' }, orig_name: path.basename(file) };
}

function fill(template, vars) {
  return template.map((v) => (typeof v === 'string' && v.startsWith('{') && v.endsWith('}') && v.slice(1, -1) in vars ? vars[v.slice(1, -1)] : v));
}

async function run(space, vars) {
  const host = space.host;
  const data = fill(space.inputs, vars);
  const base = `${baseOf(host)}/gradio_api/call/${space.api}`;
  const r = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth() }, body: JSON.stringify({ data }), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`${space.id}: Space answered ${r.status}${r.status === 404 ? ' (it may be asleep or renamed)' : ''}`);
  const { event_id } = await r.json();
  const s = await fetch(`${base}/${event_id}`, { headers: auth(), signal: AbortSignal.timeout((space.timeout_s || 300) * 1000) });
  const text = await s.text();
  const blocks = text.split(/\n\n/);
  for (const b of blocks) {
    const ev = (b.match(/^event:\s*(\S+)/m) || [])[1];
    const dat = (b.match(/^data:\s*(.*)$/m) || [])[1];
    if (ev === 'error') {
      const msg = dat && dat !== 'null' ? dat : 'the Space refused the job (usually today\'s free GPU time is used up — it comes back after about a day)';
      if (/quota|ZeroGPU|exceeded/i.test(text)) throw new Error(`${space.id}: free GPU quota for today is used up`);
      throw new Error(`${space.id}: ${msg.slice(0, 200)}`);
    }
    if (ev === 'complete') {
      const out = JSON.parse(dat);
      const flat = Array.isArray(out) ? out.flat() : [out];
      const f = flat.find((x) => x && (x.url || x.path || x.video || x.image));
      const fileObj = f?.video || f?.image || f;
      const url = fileObj?.url || (fileObj?.path ? `${baseOf(host)}/gradio_api/file=${fileObj.path}` : null);
      if (!url) throw new Error(`${space.id}: finished but returned no file`);
      const d = await fetch(url, { headers: auth(), signal: AbortSignal.timeout(180000) });
      if (!d.ok) throw new Error(`${space.id}: could not download the result (${d.status})`);
      const buf = Buffer.from(await d.arrayBuffer());
      const ext = (path.extname(new URL(url).pathname).slice(1) || (space.kind === 'videos' ? 'mp4' : 'webp')).toLowerCase();
      return { buffer: buf, ext, space: space.id };
    }
  }
  if (/quota|ZeroGPU|exceeded/i.test(text)) throw new Error(`${space.id}: free GPU quota for today is used up`);
  throw new Error(`${space.id}: no result (${text.slice(0, 150)})`);
}

// Images: try each enabled Space in order.
async function image(prompt) {
  const errs = [];
  for (const sp of list('images')) {
    try { return await run({ ...sp, kind: 'images' }, { prompt, width: 1344, height: 768 }); } catch (e) { errs.push(e.message); }
  }
  throw new Error(errs.length ? errs.join(' | ') : 'No image Spaces are switched on in config/hf_spaces.json');
}

async function collage(refs) {
  const os = require('os');
  const out = path.join(os.tmpdir(), `sheets_${Date.now()}.jpg`);
  const n = refs.length;
  const parts = refs.map((_, i) => `[${i}]scale=-2:720,pad=iw+20:720:10:0:white[r${i}]`).join(';');
  const fc = `${parts};${refs.map((_, i) => `[r${i}]`).join('')}${n > 1 ? `hstack=${n},` : ''}scale='min(1344,iw)':-2,scale=-2:'min(768,ih)',pad=1344:768:(ow-iw)/2:(oh-ih)/2:white`;
  const { spawn } = require('child_process');
  await new Promise((res, rej) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', ...refs.flatMap((r) => ['-i', r]), '-filter_complex', fc, '-q:v', '3', out];
    const p = spawn(store.getSettings().ffmpeg_path || 'ffmpeg', args, { windowsHide: true });
    let err = ''; p.stderr.on('data', (d) => (err += d));
    p.on('close', (c) => (c === 0 ? res() : rej(new Error('could not join the character sheets: ' + err.slice(0, 200)))));
    p.on('error', rej);
  });
  return out;
}

// Images that keep the cast: the channel's character sheets go in as reference pictures.
async function imageWithRefs(prompt, refs = []) {
  const errs = [];
  const names = refs.map((r) => path.basename(r).replace(/^char_/, '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
  const lead = refs.length
    ? `Reference images: ${names.map((n, i) => `image ${i + 1} = ${n}`).join(', ')}. Draw these exact characters — same face, hair, outfit, colours and body size as their reference sheet — each one only once, in a new scene. Do not copy the sheet layout, the plain background or any text. `
    : '';
  for (const sp of list('images_ref')) {
    if (sp.needs_refs && !refs.length) continue;
    try {
      if (sp.single_ref) {
        // Tools that take ONE reference picture: the sheets are joined side by side, named left to right.
        const sheet = await collage(refs);
        const lead1 = `The reference picture shows character sheets of ${names.join(', then ')} (left to right). Draw a NEW scene with exactly these characters — same faces, hair, outfits, accessories and body size as their sheets, each only once — fully dressed as on the sheets. Do NOT keep the sheet layout, the plain background, the multiple views or any text: replace the background completely with the full, detailed place described here. `;
        const ref1 = await upload(sp.host, sheet);
        fs.rmSync(sheet, { force: true });
        return await run({ ...sp, kind: 'images' }, { prompt: lead1 + prompt, ref1 });
      }
      const up = [];
      for (const r of refs) up.push({ image: await upload(sp.host, r), caption: null });
      return await run({ ...sp, kind: 'images' }, { prompt: lead + prompt, refs: up, width: 1344, height: 768 });
    } catch (e) { errs.push(e.message); }
  }
  throw new Error(errs.length ? errs.join(' | ') : 'No reference-image Spaces are switched on in config/hf_spaces.json');
}

// Video: image + prompt → clip. Each Space's inputs are described in the config.
async function video(imagePath, prompt, seconds) {
  const errs = [];
  for (const sp of list('videos')) {
    try {
      const img = await upload(sp.host, imagePath);
      const r = await run({ ...sp, kind: 'videos' }, { image: img, prompt, seconds: Math.min(sp.max_seconds || 5, Math.max(2, Math.round(seconds))) });
      if (!['mp4', 'webm', 'mov'].includes(r.ext)) r.ext = 'mp4';
      return r;
    } catch (e) { errs.push(e.message); }
  }
  throw new Error(errs.length ? errs.join(' | ') : 'No video Spaces are switched on in config/hf_spaces.json');
}

module.exports = { image, imageWithRefs, video, list, run };
