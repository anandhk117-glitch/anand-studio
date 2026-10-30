// Studio server — no npm packages needed, just Node.js 20+.
// Start:  node server/server.js   (or double-click "Start Studio.bat")
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const { P } = store;
const pipes = require('./pipelines');
const agents = require('./agents');
const media = require('./media');
const yt = require('./youtube');
const llm = require('./llm');
const hf = require('./hf');
const wan = require('./wan');
const autopilot = require('./autopilot');
const scout = require('./scout');
const layers = require('./layers');
const google = require('./google');
const notify = require('./notify');

const PORT = +process.env.STUDIO_PORT || 4600;
const HOST = process.env.STUDIO_HOST || '0.0.0.0'; // other devices still need phone access ON + the PIN

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.srt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.ico': 'image/x-icon' };

// ---------------- helpers ----------------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
const ok = (res, obj = { ok: true }) => send(res, 200, obj);
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const need = (cond, msg, code = 400) => { if (!cond) throw new HttpError(code, msg); };

function readBody(req, limit = 2e9) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'File too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function json(req) {
  const b = await readBody(req, 20e6);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw new HttpError(400, 'Body is not valid JSON'); }
}
function serveFile(req, res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
  const stat = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m[1] ? +m[1] : 0, end = m[2] ? +m[2] : stat.size - 1;
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    return pipeOut(fs.createReadStream(file, { start, end }), res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
  pipeOut(fs.createReadStream(file), res);
}
// A phone that skips around in a video aborts many requests; the file must be closed every time,
// or Windows runs out of file handles (EMFILE) and the whole Studio stops answering.
function pipeOut(stream, res) {
  const close = () => stream.destroy();
  res.on('close', close); res.on('error', close); stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
  stream.pipe(res);
}
const safeName = (n) => String(n || 'file').replace(/[^\w.\-]+/g, '_').slice(-80);
const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 40) || 'song';

function view(p) {
  return { ...p, progress: pipes.progress(p) };
}
function card(p) {
  const pr = pipes.progress(p);
  return { id: p.id, channel: p.channel, title: p.title, title_en: p.idea?.title_en, updated: p.updated, busy: p.busy || null,
    error: p.error || null, current: pr.current, pct: pr.pct, stages: pr.stages,
    waiting: pr.stages.find((s) => s.status === 'waiting')?.label || null, thumb: p.publish?.thumbnail || p.scenes?.find((s) => s.image)?.image || null };
}

// Runs slow work in the background and records progress on the project.
// Jobs run in the background. Every step line is kept (the Studio's live "Working now" panel shows them),
// and Anand can stop a job: the next step line then ends it.
const STOP = new Set();
function background(id, stage, label, fn) {
  const p = store.getProject(id);
  need(!p.busy, `Busy: ${p.busy?.msg}. Wait for it to finish.`, 409);
  STOP.delete(id);
  p.busy = { stage, msg: label, started: new Date().toISOString(), lines: [{ t: new Date().toISOString(), msg: label }] };
  delete p.error;
  store.saveProject(p);
  (async () => {
    try {
      await fn((msg) => {
        if (STOP.has(id)) { STOP.delete(id); const e = new Error('Stopped by you'); e.stopped = true; throw e; }
        const q = store.getProject(id); if (!q.busy) return;
        q.busy = { ...q.busy, msg, lines: [...(q.busy.lines || []).slice(-39), { t: new Date().toISOString(), msg }] };
        store.saveProject(q);
      });
    } catch (e) {
      const q = store.getProject(id);
      q.error = { stage, message: e.message, at: new Date().toISOString(), stopped: !!e.stopped, lines: (q.busy?.lines || []).slice(-15) };
      store.log(q, 'Studio', e.stopped ? `Stopped at ${stage} (you pressed Stop)` : `Failed at ${stage}: ${e.message.split('\n')[0]}`);
      q.last_run = { label, stage, ended: new Date().toISOString(), ok: false, lines: (q.busy?.lines || []).slice(-15) };
      delete q.busy;
      store.saveProject(q);
      return;
    }
    const q = store.getProject(id);
    q.last_run = { label, stage, ended: new Date().toISOString(), ok: true, lines: (q.busy?.lines || []).slice(-15) };
    delete q.busy;
    store.saveProject(q);
  })();
}

function decide(p, text) {
  const line = `- ${new Date().toISOString().slice(0, 10)} · ${p.title || p.id} · ${text}`;
  store.appendMemory(p.channel, 'decisions', line);
  store.log(p, 'Anand', text);
}

// ---------------- routes ----------------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/overview', async (req, res) => {
  const channels = store.listChannels().map((c) => {
    const projects = store.listProjects(c.id);
    return { ...brief(c), stats: yt.cachedStats(c.id), projects: projects.length,
      active: projects.filter((p) => pipes.progress(p).current !== 'finished').length,
      finished: projects.filter((p) => pipes.progress(p).current === 'finished').length,
      latest: projects.slice(0, 3).map(card) };
  });
  const all = store.listProjects();
  const waiting = all.map(card).filter((c) => c.waiting || c.error);
  const busy = all.map(card).filter((c) => c.busy);
  const queue = store.getQueue().filter((t) => t.status === 'open');
  ok(res, { channels, waiting, busy, queue, setup: await setupChecks() });
});

function brief(c) {
  return { id: c.id, name: c.name, short_name: c.short_name, native_name: c.native_name, language: c.language, pipeline: c.pipeline,
    tagline: c.tagline, color: c.color, accent: c.accent, ink: c.ink, kind: c.kind, youtube: c.youtube };
}

async function setupChecks() {
  const s = store.getSettings();
  const [ff, l] = await Promise.all([media.ffmpegOk(), llm.ping()]);
  return {
    google: !!s.google_api_key, ffmpeg: !!ff, ffmpeg_version: ff, llm: l, llm_url: s.llm_base_url, youtube: !!s.youtube_api_key, hf: !!s.hf_token, wan: !!s.wan_api_key,
    git: fs.existsSync(path.join(P.root, '.git')),
  };
}

route('GET', '/api/channels/:id', async (req, res, { id }) => {
  const c = store.getChannel(id);
  need(c, 'No such channel', 404);
  const agentsFor = pipes.stagesFor(c.pipeline).map((s) => ({ stage: s, label: pipes.STAGE_LABEL[s], ...pipes.AGENTS[s] }));
  const brand = fs.existsSync(path.join(P.brand, id)) ? fs.readdirSync(path.join(P.brand, id)).filter((f) => !f.startsWith('.')) : [];
  ok(res, { channel: c, memory: store.getMemory(id), projects: store.listProjects(id).map(card), agents: agentsFor,
    stats: yt.cachedStats(id), niche: yt.cachedNiche(id), brand,
    queue: store.getQueue().filter((t) => t.channel === id && t.status === 'open') });
});

route('PUT', '/api/channels/:id/memory/:file', async (req, res, { id, file }) => {
  need(store.getChannel(id), 'No such channel', 404);
  const { text } = await json(req);
  store.saveMemory(id, file, String(text ?? ''));
  ok(res);
});

route('POST', '/api/channels/:id/lesson', async (req, res, { id }) => {
  const { text } = await json(req);
  need(text && text.trim(), 'Write the lesson first.');
  store.appendMemory(id, 'lessons', `- ${new Date().toISOString().slice(0, 10)}: ${text.trim()}`);
  ok(res);
});

route('POST', '/api/channels/:id/stats', async (req, res, { id }) => {
  const c = store.getChannel(id);
  ok(res, { stats: await yt.channelStats(c) });
});

// Research agents' opportunity report (niche researcher + trend/opportunity analyst + own-channel analyst).
route('GET', '/api/channels/:id/opportunities', async (req, res, { id }) => ok(res, { report: require('./research').cached(id) }));
route('POST', '/api/channels/:id/opportunities', async (req, res, { id }) => {
  const c = store.getChannel(id);
  require('./research').run(c).then((r) => autopilot.note(`Research agents: ${c.name} — ${(r.opportunities || []).length} opportunities (${r.model})`)).catch((e) => autopilot.note(`Research agents: ${c.name} — ${e.message.slice(0, 160)}`));
  ok(res, { started: true });
});

route('POST', '/api/channels/:id/scan', async (req, res, { id }) => {
  const c = store.getChannel(id);
  ok(res, { niche: await yt.nicheScan(c) });
});

route('POST', '/api/channels/:id/brand', async (req, res, { id }) => {
  const url = new URL(req.url, 'http://x');
  const name = url.searchParams.get('name');
  const allowed = ['intro.mp4', 'outro.mp4', 'logo.png', 'subscribe.png'];
  need(allowed.includes(name) || /^char_[\w-]+\.(png|jpg|jpeg|webp)$/i.test(name), 'Use one of: ' + allowed.join(', ') + ' or char_<name>.png');
  const buf = await readBody(req);
  const dir = path.join(P.brand, id, name.startsWith('char_') ? 'characters' : '');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buf);
  ok(res);
});

// Start a new song/episode: research agent brings 4 ideas.
// The daily song task (Claude) hands over a finished, approved song package; the Studio does the rest.
route('POST', '/api/channels/:id/new-song', async (req, res, { id }) => {
  const c = store.getChannel(id);
  need(c, 'No such channel', 404);
  const { idea, song } = await json(req);
  need(song && song.lyrics && song.style, 'Send song.lyrics and song.style.');
  const pid = `${id}-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`;
  const title = song.title_native || idea?.title_native || idea?.title_en || 'New song';
  const p = { id: pid, channel: id, pipeline: c.pipeline, title, created: new Date().toISOString(), scenes: [], audio: [], log: [],
    idea: idea || { title_en: song.title_en || title, title_native: song.title_native || title }, song: { ...song, style: String(song.style).slice(0, 200), approved: true },
    full_auto: true, autopilot: true, source: 'daily-song' };
  store.log(p, 'Studio', 'Project started by the daily song task');
  decide(p, `Song by Claude: ${title}${song.title_en ? ' — ' + song.title_en : ''}`);
  store.saveProject(p);
  ok(res, { id: pid });
});
route('GET', '/api/channels/:id/songs', async (req, res, { id }) => {
  ok(res, { songs: store.listProjects().filter((p) => p.channel === id).map((p) => ({ id: p.id, created: p.created, title: p.title, title_en: p.idea?.title_en || p.song?.title_en || '' })) });
});
route('POST', '/api/channels/:id/research', async (req, res, { id }) => {
  const c = store.getChannel(id);
  need(c, 'No such channel', 404);
  const { focus = '', mode = 'llm', scan = true } = await json(req);
  const pid = `${id}-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`;
  const p = { id: pid, channel: id, pipeline: c.pipeline, title: '', created: new Date().toISOString(), focus, scenes: [], audio: [], log: [] };
  store.log(p, 'Studio', 'Project started');
  store.saveProject(p);
  if (mode === 'claude') {
    agents.enqueue(p, 'research', { focus });
    return ok(res, { id: pid, queued: true });
  }
  background(pid, 'research', 'Research agent is studying the niche', async (step) => {
    let niche = null;
    if (scan && store.getSettings().youtube_api_key) {
      step('Scanning YouTube for what is trending');
      try { await require('./research').run(c, step); niche = yt.cachedNiche(c.id); }
      catch (e) {
        const q = store.getProject(pid); store.log(q, 'Research agent', 'Research agents: ' + e.message.slice(0, 200) + ' — using the plain YouTube scan'); store.saveProject(q);
        try { niche = await yt.nicheScan(c); } catch (e2) { const q2 = store.getProject(pid); store.log(q2, 'Research agent', 'YouTube scan skipped: ' + e2.message); store.saveProject(q2); }
      }
    }
    step('Writing 4 ideas');
    const q = store.getProject(pid);
    const model = await agents.runLLM(q, 'research', { focus, niche });
    store.log(q, 'Research agent', `Brought ${q.ideas.length} ideas (${model})`);
    store.saveProject(q);
  });
  ok(res, { id: pid });
});

route('GET', '/api/projects/:id', async (req, res, { id }) => {
  const p = store.getProject(id);
  need(p, 'No such project', 404);
  const c = store.getChannel(p.channel);
  const brandDir = path.join(P.brand, p.channel);
  const brand = fs.existsSync(brandDir) ? fs.readdirSync(brandDir) : [];
  ok(res, { project: view(p), channel: brief(c), wan_ready: !!store.getSettings().wan_api_key, channel_full: { edit: c.edit, suno_style: c.suno_style, visual_style: c.visual_style },
    brand, queue: store.getQueue().filter((t) => t.project === id && t.status === 'open'),
    agents: pipes.stagesFor(p.pipeline).map((s) => ({ stage: s, ...pipes.AGENTS[s] })) });
});

route('DELETE', '/api/projects/:id', async (req, res, { id }) => {
  need(store.getProject(id), 'No such project', 404);
  store.deleteProject(id);
  store.saveQueue(store.getQueue().filter((t) => t.project !== id));
  ok(res);
});

// Edit fields directly (your changes always win).
route('PATCH', '/api/projects/:id', async (req, res, { id }) => {
  const p = store.getProject(id);
  need(p, 'No such project', 404);
  const b = await json(req);
  if ('title' in b) p.title = String(b.title);
  if (b.song) p.song = { ...(p.song || {}), ...b.song, style: String((b.song.style ?? p.song?.style) || '').slice(0, 200) };
  if (b.script) p.script = { ...(p.script || {}), ...b.script };
  if (b.publish) p.publish = { ...(p.publish || {}), ...b.publish };
  if ('allow_image_scenes' in b) p.allow_image_scenes = !!b.allow_image_scenes;
  if ('autopilot' in b) { p.autopilot = !!b.autopilot; p.auto = {}; }
  if ('full_auto' in b) p.full_auto = !!b.full_auto;
  if (Array.isArray(b.scenes)) {
    const by = new Map(b.scenes.map((s) => [+s.n, s]));
    p.scenes = (p.scenes || []).map((s) => {
      const u = by.get(s.n); if (!u) return s;
      const keep = { ...s };
      for (const k of ['vision', 'image_prompt', 'motion_prompt', 'note', 'redo', 'clip_len']) if (k in u) keep[k] = u[k];
      return keep;
    });
  }
  if (b.edit_options) p.edit = { ...(p.edit || {}), options: b.edit_options };
  store.saveProject(p);
  ok(res, { project: view(p) });
});

route('POST', '/api/projects/:id/pick-idea', async (req, res, { id }) => {
  const p = store.getProject(id);
  const { index, custom, full_auto } = await json(req);
  const idea = custom && custom.title_en ? custom : (p.ideas || [])[index];
  p.full_auto = full_auto === undefined ? !!store.getSettings().full_auto_default : !!full_auto;
  need(idea, 'Pick one of the ideas.');
  p.idea = idea;
  p.title = idea.title_native || idea.title_en;
  decide(p, `Picked idea: ${idea.title_en || idea.title_native}${p.full_auto ? ' (topic-only: the brain does the rest)' : ''}`);
  store.saveProject(p);
  ok(res, { project: view(p) });
});

// Run an agent: free LLM now, or hand to Claude Code.
route('POST', '/api/projects/:id/run/:stage', async (req, res, { id, stage }) => {
  const p = store.getProject(id);
  need(p, 'No such project', 404);
  const { mode = 'llm', note = '' } = await json(req);
  const isWrite = !!agents.JOBS[stage];
  // Images/videos: once the prompts exist, a Claude Code job means "make them in the browser".
  const makeJob = (stage === 'images' && (p.scenes || []).some((x) => x.image_prompt)) || (stage === 'videos' && (p.scenes || []).some((x) => x.motion_prompt));
  if (mode === 'claude' || !isWrite) {
    const t = agents.enqueue(p, stage, { note, kind: makeJob && mode === 'claude' && !/prompt/i.test(note) ? 'browser' : undefined });
    store.log(p, 'Studio', `Sent "${stage}" to Claude Code (${t.id})`);
    store.saveProject(p);
    return ok(res, { queued: t });
  }
  const label = { song: 'Songwriter is writing', script: 'Script writer is writing', images: 'Visual director is writing prompts',
    videos: 'Motion director is writing prompts', publish: 'Publisher is writing the package', research: 'Research agent is thinking' }[stage] || 'Working';
  background(id, stage, label, async () => {
    const q = store.getProject(id);
    const model = await agents.runLLM(q, stage, { note });
    store.log(q, pipes.AGENTS[stage].name, `Done (${model})${note ? ' — with your note' : ''}`);
    store.saveProject(q);
  });
  ok(res, { started: true });
});

route('POST', '/api/projects/:id/approve/:stage', async (req, res, { id, stage }) => {
  const p = store.getProject(id);
  need(p, 'No such project', 404);
  const { note = '' } = await json(req);
  const extra = note ? ` — ${note}` : '';
  switch (stage) {
    case 'song': need(p.song?.lyrics, 'No lyrics yet.'); p.song.approved = true; decide(p, 'Approved song package' + extra); break;
    case 'script': need(p.script?.text, 'No script yet.'); p.script.approved = true; decide(p, 'Approved script' + extra); break;
    case 'timeline':
      need(p.timeline?.lines?.length, 'No timeline yet.');
      p.timeline.approved = true;
      agents.scenesFromTimeline(p);
      decide(p, `Approved timeline (${p.scenes.length} scenes)` + extra); break;
    case 'images': p.allow_image_scenes = false; decide(p, 'Images approved' + extra); break;
    case 'videos': if (p.pipeline === 'kids_song') { decide(p, 'Clips approved — every scene still needs its own moving clip (no still pictures in kids songs)' + extra); break; } p.allow_image_scenes = true; decide(p, 'Continue: scenes without clips use the image with a slow zoom' + extra); break;
    case 'edit': need(p.edit?.file, 'No edit yet.'); p.edit.approved = true; decide(p, 'Approved final video' + extra); break;
    case 'publish': need(p.publish?.titles?.length, 'No package yet.'); p.publish.approved = true; decide(p, `Ready to upload. Title: ${p.publish.titles[0]}` + extra); break;
    default: throw new HttpError(400, 'Nothing to approve at ' + stage);
  }
  store.saveProject(p);
  ok(res, { project: view(p) });
});

route('POST', '/api/projects/:id/reopen/:stage', async (req, res, { id, stage }) => {
  const p = store.getProject(id);
  const key = { song: 'song', script: 'script', timeline: 'timeline', edit: 'edit', publish: 'publish' }[stage];
  if (key && p[key]) p[key].approved = false;
  if (stage === 'research') { delete p.idea; }
  if (stage === 'pick') { delete p.picked_audio; }
  store.log(p, 'Anand', `Reopened ${stage}`);
  store.saveProject(p);
  ok(res, { project: view(p) });
});

// Upload: raw body. ?kind=audio|image|video|thumbnail&label=A&scene=3&name=x.mp3
route('POST', '/api/projects/:id/upload', async (req, res, { id }) => {
  const p = store.getProject(id);
  need(p, 'No such project', 404);
  const u = new URL(req.url, 'http://x');
  const kind = u.searchParams.get('kind');
  const ext = (path.extname(u.searchParams.get('name') || '').toLowerCase() || '.bin');
  const buf = await readBody(req);
  need(buf.length > 0, 'Empty file.');
  const dir = store.projectDir(id);
  let file;
  if (kind === 'audio') {
    need(['.mp3', '.wav', '.m4a', '.flac', '.ogg'].includes(ext), 'Audio must be mp3, wav, m4a, flac or ogg.');
    const label = safeName(u.searchParams.get('label') || String.fromCharCode(65 + (p.audio || []).length));
    file = `audio_${label}${ext}`;
    fs.writeFileSync(path.join(dir, file), buf);
    p.audio = [...(p.audio || []).filter((a) => a.file !== file), { file, label, added: new Date().toISOString() }];
    store.log(p, 'Music producer', `Added audio ${label}`);
    store.saveProject(p);
    analyzeInBackground(id, file);
  } else if (kind === 'image' || kind === 'video') {
    const n = +u.searchParams.get('scene');
    const scene = (p.scenes || []).find((s) => s.n === n);
    need(scene, 'Approve the timeline first so scenes exist.');
    need(kind === 'image' ? ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) : ['.mp4', '.webm', '.mov'].includes(ext), `Wrong file type for ${kind}.`);
    file = `${kind === 'image' ? 'scene' : 's'}_${String(n).padStart(2, '0')}${ext}`;
    for (const old of fs.readdirSync(dir)) if (old.startsWith(file.replace(ext, '') + '.')) fs.unlinkSync(path.join(dir, old));
    fs.writeFileSync(path.join(dir, file), buf);
    scene[kind] = file;
    scene.redo = false;
    store.log(p, kind === 'image' ? 'Visual director' : 'Motion director', `Scene ${n} ${kind} added`);
    store.saveProject(p);
  } else if (kind === 'thumbnail') {
    need(['.png', '.jpg', '.jpeg', '.webp'].includes(ext), 'Thumbnail must be an image.');
    file = 'thumbnail' + ext;
    fs.writeFileSync(path.join(dir, file), buf);
    p.publish = { ...(p.publish || {}), thumbnail: file };
    store.saveProject(p);
  } else throw new HttpError(400, 'Unknown upload kind');
  ok(res, { file });
});

function analyzeInBackground(id, file, tries = 0) {
  const p = store.getProject(id);
  if (!p) return;
  if (p.busy) { if (tries < 200) setTimeout(() => analyzeInBackground(id, file, tries + 1), 3000); return; }
  background(id, p.pipeline === 'documentary' ? 'voice' : 'pick', `Music analyst is measuring ${file}`, async () => {
    const a = await media.analyzeAudio(path.join(store.projectDir(id), file));
    const q = store.getProject(id);
    q.audio = q.audio.map((x) => (x.file === file ? { ...x, analysis: a } : x));
    if (q.pipeline === 'documentary') { q.picked_audio = file; q.audio_info = a; }
    store.log(q, 'Music analyst', `${file}: ${fmt(a.duration)}, score ${a.total}/${a.out_of}`);
    store.saveProject(q);
  });
}
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;

route('POST', '/api/projects/:id/analyze', async (req, res, { id }) => {
  const p = store.getProject(id);
  const todo = (p.audio || []).filter((a) => !a.analysis).map((a) => a.file);
  need(todo.length, 'All audio is already measured.');
  background(id, 'pick', 'Music analyst is measuring', async (step) => {
    for (const f of todo) {
      step('Measuring ' + f);
      const a = await media.analyzeAudio(path.join(store.projectDir(id), f));
      const q = store.getProject(id);
      q.audio = q.audio.map((x) => (x.file === f ? { ...x, analysis: a } : x));
      store.saveProject(q);
    }
  });
  ok(res);
});

route('POST', '/api/projects/:id/pick-audio', async (req, res, { id }) => {
  const p = store.getProject(id);
  const { file } = await json(req);
  const a = (p.audio || []).find((x) => x.file === file);
  need(a, 'Unknown audio file.');
  need(a.analysis, 'Wait until the analyst has measured this file.');
  p.picked_audio = file;
  p.audio_info = a.analysis;
  // Only one song goes forward: the other version is moved out of the project.
  const spare = path.join(store.projectDir(id), '_unused');
  for (const o of (p.audio || []).filter((x) => x.file !== file && x.label !== 'narration')) {
    try { fs.mkdirSync(spare, { recursive: true }); fs.renameSync(path.join(store.projectDir(id), o.file), path.join(spare, o.file)); } catch {}
  }
  p.audio = (p.audio || []).filter((x) => x.file === file || x.label === 'narration');
  decide(p, `Picked version ${a.label}`);
  agents.autoTimeline(p);
  store.log(p, 'Timeline mapper', `Estimated ${p.timeline.lines.length} lines — please check the times`);
  store.saveProject(p);
  ok(res, { project: view(p) });
});

route('POST', '/api/projects/:id/timeline/auto', async (req, res, { id }) => {
  const p = store.getProject(id);
  const { vocalStart } = await json(req);
  agents.autoTimeline(p, { vocalStart: vocalStart === '' || vocalStart == null ? undefined : +vocalStart });
  store.saveProject(p);
  ok(res, { project: view(p) });
});

// Exact lyric times heard from the song (free, Gemini listens in 30-second pieces). Replaces the even-spread estimate;
// scenes are rebuilt on the new times and keep their pictures, prompts and clips.
route('POST', '/api/projects/:id/timeline/listen', async (req, res, { id }) => {
  const p = store.getProject(id);
  need(p.picked_audio && p.song?.lyrics, 'Pick the song audio first.');
  background(id, 'timeline', 'Listening to the song for exact lyric times', async (step) => {
    const q0 = store.getProject(id);
    const dur = q0.audio_info?.duration || q0.timeline?.duration;
    let r;
    try { r = await require('./align').align(path.join(store.projectDir(id), q0.picked_audio), q0.song.lyrics, dur, { onStep: step }); }
    catch (e) { const q = store.getProject(id); q.timeline = { ...(q.timeline || {}), listen_failed: new Date().toISOString() }; store.log(q, 'Timeline mapper', 'Could not listen to the song yet (' + e.message.slice(0, 120) + ') — trying again in 2 hours; scenes wait for the real times'); store.saveProject(q); return; }
    const q = store.getProject(id);
    const before = (q.scenes || []).filter((x) => x.video).length;
    agents.retime(q, r.lines, 'listened');
    const after = q.scenes.filter((x) => x.video).length;
    store.log(q, 'Timeline mapper', `Heard the song: exact times for ${r.lines.length} lines${r.flagged ? ` (${r.flagged} to double-check)` : ''}. ${q.scenes.length} scenes of max 5.8 s; ${after}/${q.scenes.length} keep their clip${before ? '' : 's'}, the rest get new clips.`);
    if (q.edit) { q.edit = { ...q.edit, file: null, approved: false }; }
    store.saveProject(q);
  });
  ok(res);
});

route('PUT', '/api/projects/:id/timeline', async (req, res, { id }) => {
  const p = store.getProject(id);
  const { lines } = await json(req);
  need(Array.isArray(lines) && lines.length, 'No lines.');
  const clean = lines.map((l, i) => ({ n: i + 1, start: +(+l.start).toFixed(2), end: +(+l.end).toFixed(2), section: String(l.section || ''), text: String(l.text || ''), estimated: false }))
    .filter((l) => !isNaN(l.start) && !isNaN(l.end) && l.end > l.start);
  need(clean.length, 'Every line needs a start before its end.');
  p.timeline = { ...(p.timeline || {}), lines: clean, source: 'edited', approved: false };
  if (!p.timeline.duration) p.timeline.duration = p.audio_info?.duration;
  store.log(p, 'Anand', 'Corrected the timeline by hand');
  store.saveProject(p);
  ok(res, { project: view(p) });
});

// Paste Suno aligned words (tools/suno_timeline.js output or the raw aligned JSON).
route('POST', '/api/projects/:id/timeline/words', async (req, res, { id }) => {
  const p = store.getProject(id);
  const b = await json(req);
  const words = Array.isArray(b) ? b : b.aligned_words || b.words || b.lines;
  need(Array.isArray(words) && words.length, 'Paste the aligned words JSON.');
  let lines;
  if (words[0] && 'text' in words[0] && 'start' in words[0]) lines = words.map((l, i) => ({ n: i + 1, start: +l.start, end: +l.end, section: l.section || '', text: l.text }));
  else lines = require('./timeline').linesFromWords(p.song?.lyrics, words);
  need(lines?.length, 'Could not read those timestamps.');
  p.timeline = { duration: p.audio_info?.duration, lines, source: 'suno', approved: false };
  store.log(p, 'Timeline mapper', `Used real timestamps for ${lines.length} lines`);
  store.saveProject(p);
  ok(res, { project: view(p) });
});

// Free backup images from Hugging Face, one scene or all missing.
route('POST', '/api/projects/:id/hf-images', async (req, res, { id }) => {
  const p = store.getProject(id);
  const { scene } = await json(req);
  const targets = (p.scenes || []).filter((s) => (scene ? s.n === +scene : !s.image) && s.image_prompt);
  need(targets.length, 'No scenes with an image prompt to make. Write prompts first.');
  background(id, 'images', 'Making images on Hugging Face', async (step) => {
    for (const s of targets) {
      step(`Hugging Face: scene ${s.n} (${targets.indexOf(s) + 1}/${targets.length})`);
      const img = await hf.textToImage(s.image_prompt);
      const file = `scene_${String(s.n).padStart(2, '0')}.${img.ext}`;
      fs.writeFileSync(path.join(store.projectDir(id), file), img.buffer);
      const q = store.getProject(id);
      q.scenes = q.scenes.map((x) => (x.n === s.n ? { ...x, image: file, image_source: 'huggingface' } : x));
      store.saveProject(q);
    }
  });
  ok(res);
});

// Wan 3.0 (Alibaba Model Studio): turn scene images into clips automatically.
route('POST', '/api/projects/:id/wan-videos', async (req, res, { id }) => {
  const p = store.getProject(id);
  need(p, 'No such project', 404);
  need(store.getSettings().wan_api_key, 'Add your Alibaba Model Studio key in Settings first.');
  const { scene, redoAll } = await json(req);
  const targets = (p.scenes || []).filter((s) => s.image && (scene ? s.n === +scene : (redoAll || !s.video || s.redo)));
  need(targets.length, scene ? 'That scene has no image yet.' : 'Every scene with an image already has a clip. Tick "Redo clip" on a scene or pick one scene.');
  const seconds = targets.reduce((a, s) => a + Math.max(2, Math.min(30, Math.ceil(s.len))), 0);
  background(id, 'videos', `Wan 3.0: ${targets.length} clips (${seconds}s)`, async (step) => {
    let done = 0, used = 0;
    for (const s of targets) {
      const dur = Math.max(2, Math.min(30, Math.ceil(s.len)));
      step(`Wan 3.0: scene ${s.n} — sending (${done + 1}/${targets.length})`);
      const prompt = s.motion_prompt || s.vision || s.image_prompt || s.lyric || 'Gentle camera move, characters move naturally.';
      const task = await wan.createTask({ imagePath: path.join(store.projectDir(id), s.image), prompt, duration: dur });
      const out = await wan.waitTask(task, (st) => step(`Wan 3.0: scene ${s.n} — ${String(st || '').toLowerCase()} (${done + 1}/${targets.length})`));
      const file = `s_${String(s.n).padStart(2, '0')}.mp4`;
      await wan.download(out.url, path.join(store.projectDir(id), file));
      done++; used += out.seconds || dur;
      const q = store.getProject(id);
      q.scenes = q.scenes.map((x) => (x.n === s.n ? { ...x, video: file, video_source: 'wan3', redo: false } : x));
      store.log(q, 'Motion director', `Scene ${s.n} clip made with Wan 3.0 (${out.seconds || dur}s)`);
      store.saveProject(q);
    }
    const q = store.getProject(id);
    store.log(q, 'Motion director', `Wan 3.0 finished ${done} clip${done === 1 ? '' : 's'}, ${used}s of video used from your quota`);
    store.saveProject(q);
  });
  ok(res, { clips: targets.length, seconds });
});

route('POST', '/api/projects/:id/edit', async (req, res, { id }) => {
  const p = store.getProject(id);
  need(p.picked_audio, 'Pick the audio first.');
  need((p.scenes || []).length, 'Approve the timeline first.');
  const c = store.getChannel(p.channel);
  const b = await json(req);
  const opts = { ...(c.edit || {}), ...(p.edit?.options || {}), ...b };
  background(id, 'edit', 'Editor is cutting the video', async (step) => {
    const out = await media.renderEdit(store.projectDir(id), store.getProject(id), path.join(P.brand, p.channel), opts, step);
    const q = store.getProject(id);
    q.edit = { ...out, options: opts, approved: false, made: new Date().toISOString() };
    store.log(q, 'Editor', `Final video ${fmt(out.duration)} (${out.parts.join(' + ')})`);
    store.saveProject(q);
  });
  ok(res);
});

route('POST', '/api/projects/:id/thumbnail-frame', async (req, res, { id }) => {
  const p = store.getProject(id);
  need(p.edit?.file, 'Make the final video first.');
  const { t = 10 } = await json(req);
  const file = await media.grabFrame(store.projectDir(id), p.edit.file, +t, 'thumbnail_frame.jpg');
  p.publish = { ...(p.publish || {}), thumbnail: file };
  store.saveProject(p);
  ok(res, { file });
});

// Best thumbnail: strongest clean picture + big native text, checked, plus an A/B version.
route('POST', '/api/projects/:id/thumbnail', async (req, res, { id }) => {
  const p = store.getProject(id);
  need(p.edit?.file, 'Make the final video first.');
  background(id, 'publish', 'Thumbnail designer at work', async (step) => {
    const out = await require('./thumbs').make(store.getProject(id), { onStep: step });
    const q = store.getProject(id);
    q.publish = { ...(q.publish || {}), ...out };
    store.log(q, 'Thumbnail designer', `Thumbnail made from scene ${out.thumb_pick.scene}${out.thumb_pick.score ? ` (scored ${out.thumb_pick.score}/10)` : ''}${out.thumbnail_b ? ' + an A/B version' : ''}`);
    store.saveProject(q);
  });
  ok(res);
});

// Weekly thumbnail doctor (also runs by itself on Sundays).
route('POST', '/api/channels/:id/thumb-doctor', async (req, res, { id }) => {
  const r = await require('./thumbs').doctor(id);
  ok(res, { report: `/doctor/${id}/${r.day}/index.html`, fixes: r.fixes.length });
});
route('GET', '/api/channels/:id/thumb-doctor', async (req, res, { id }) => {
  const root = path.join(P.data, 'thumb_doctor', id);
  const days = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => /^\d{4}-/.test(d)).sort() : [];
  const day = days.pop();
  ok(res, day ? { day, url: `/doctor/${id}/${day}/index.html`, report: store.readJSON(path.join(root, day, 'report.json'), null) } : { day: null });
});

route('POST', '/api/projects/:id/shorts', async (req, res, { id }) => {
  const p = store.getProject(id);
  need(p.edit?.file, 'Make the final video first.');
  const cuts = (p.publish?.shorts || []).filter((s) => +s.end > +s.start).slice(0, 3);
  need(cuts.length, 'Write the upload package first — it picks the 3 Shorts.');
  background(id, 'publish', 'Cutting Shorts', async (step) => {
    const made = [];
    for (let i = 0; i < cuts.length; i++) {
      step(`Short ${i + 1} of ${cuts.length}`);
      made.push({ ...cuts[i], file: await media.makeShort(store.projectDir(id), +cuts[i].start, +cuts[i].end - +cuts[i].start, `short_${i + 1}.mp4`, { title: cuts[i].hook || cuts[i].title, font: store.getChannel(p.channel)?.edit?.font }) });
    }
    const q = store.getProject(id);
    q.publish = { ...(q.publish || {}), shorts: made };
    store.log(q, 'Editor', `${made.length} Shorts ready`);
    store.saveProject(q);
  });
  ok(res);
});

// ---- live control of a project: stop, retry, restart from a step, and talk to the agents ----
route('POST', '/api/projects/:id/stop', async (req, res, { id }) => {
  const p = store.getProject(id); need(p, 'No such project', 404);
  if (p.busy) STOP.add(id);
  p.autopilot = false; store.log(p, 'Anand', 'Stop pressed — autopilot paused for this project'); store.saveProject(p);
  ok(res, { stopping: !!p.busy });
});
function startAgain(id) {
  const p = store.getProject(id);
  delete p.error; delete p.hold; p.auto = {}; p.autopilot = true; store.saveProject(p);
  if (p.pipeline === 'reel') background(id, 'voice', 'ReelBite: making the Short', async (st) => { await require('./reel').auto(id, st); });
  else setTimeout(() => require('./autopilot').walk().catch(() => {}), 500);
}
route('POST', '/api/projects/:id/retry', async (req, res, { id }) => {
  const p = store.getProject(id); need(p, 'No such project', 404); need(!p.busy, 'It is still working — press Stop first.', 409);
  store.log(p, 'Anand', 'Retry pressed'); store.saveProject(p);
  startAgain(id); ok(res, { started: true });
});
route('POST', '/api/projects/:id/restart', async (req, res, { id }) => {
  const p = store.getProject(id); need(p, 'No such project', 404); need(!p.busy, 'It is still working — press Stop first.', 409);
  need(p.pipeline === 'reel', 'Restart from a step is for ReelBite Shorts; for songs use the step buttons.');
  const { from, note } = await json(req);
  require('./reel').restartFrom(id, from, note || '');
  startAgain(id); ok(res, { started: true });
});
// Chat: Anand writes in plain words; the brain answers and, when it is clear, does it (stop, retry, redo a step with his note).
route('POST', '/api/projects/:id/tell', async (req, res, { id }) => {
  const p = store.getProject(id); need(p, 'No such project', 404);
  const { text } = await json(req); need(text && text.trim(), 'Write something.');
  p.chat = [...(p.chat || []).slice(-40), { who: 'Anand', text: text.trim(), t: new Date().toISOString() }]; p.chat_pending = true;
  store.saveProject(p); ok(res, { ok: true });
  (async () => {
    let out = null;
    const q = store.getProject(id);
    const reel = q.pipeline === 'reel';
    const ctx = { title: q.title, channel: q.channel, pipeline: q.pipeline, stage: pipes.progress(q).current, working_now: q.busy ? q.busy.msg : null, recent_steps: (q.busy?.lines || q.last_run?.lines || []).slice(-8).map((x) => x.msg),
      error: q.error?.message || null, needs_you: q.hold || null, autopilot: q.autopilot !== false, recent_log: (q.log || []).slice(0, 8).map((l) => `${l.who}: ${l.text}`),
      script: reel ? (q.script?.beats || []).map((b, i) => `${i + 1}. ${b.text}`) : undefined, done: !!(q.publish?.titles?.length) };
    const actions = reel ? 'none | stop | retry | pause | resume | restart_script | restart_voice | restart_visuals | restart_edit | restart_publish' : 'none | stop | retry | pause | resume';
    try {
      ({ text: out } = await require('./llm').chat([
        { role: 'system', content: 'You are the production manager inside Anand\'s YouTube Studio. Anand talks to you in simple (sometimes broken) English about ONE project. Answer in 1-3 short, plain sentences: what is happening and what you will do. Never say you are doing or changing something unless your action does it (action none = you only answer). Do not call him Boss. Pick an action only when he clearly asks for it or it obviously fixes his complaint. A change to the words/story = restart_script with his request as note; voice/speed complaints = restart_voice; pictures/design = restart_visuals; music/captions/sound = restart_edit; title/tags/description = restart_publish.' },
        { role: 'user', content: `PROJECT NOW:\n${JSON.stringify(ctx, null, 1)}\n\nCHAT SO FAR:\n${(q.chat || []).slice(-8).map((m) => m.who + ': ' + m.text).join('\n')}\n\nAllowed actions: ${actions}.\nJSON only: {"reply":"","action":"none","note":"what to change, in his words, for the redo"}` },
      ], { noLocal: true, temperature: 0.2 }));
    } catch (e) { out = { reply: 'I could not think right now (the free brain is busy): ' + e.message.slice(0, 120) + '. Use the buttons above, or try again in a minute.', action: 'none' }; }
    const r = store.getProject(id); r.chat_pending = false;
    let act = String(out?.action || 'none'); let did = '';
    try {
      if (act === 'stop') { if (r.busy) STOP.add(id); r.autopilot = false; did = 'Stopped.'; }
      else if (act === 'pause') { r.autopilot = false; did = 'Autopilot paused for this project.'; }
      else if (act === 'resume') { r.autopilot = true; did = 'Autopilot on.'; }
      else if (act === 'retry' || act.startsWith('restart_')) {
        if (r.busy) { did = 'It is still working — press Stop first, then ask again.'; act = 'none'; }
      }
    } catch {}
    r.chat = [...(r.chat || []), { who: 'Studio', text: (out?.reply || 'OK.') + (did ? ' ' + did : ''), t: new Date().toISOString(), action: act }];
    store.saveProject(r);
    try {
      if (act === 'retry') startAgain(id);
      else if (act.startsWith('restart_') && reel) { require('./reel').restartFrom(id, act.slice(8), out.note || ''); startAgain(id); }
    } catch (e) { const z = store.getProject(id); z.chat.push({ who: 'Studio', text: 'Could not start it: ' + e.message, t: new Date().toISOString() }); store.saveProject(z); }
  })();
});

route('POST', '/api/projects/:id/clear-error', async (req, res, { id }) => {
  const p = store.getProject(id); delete p.error; delete p.busy; delete p.hold; delete p.waiting_manual; p.auto = {}; store.saveProject(p); ok(res);
});

route('POST', '/api/projects/:id/request', async (req, res, { id }) => {
  const p = store.getProject(id);
  const { stage, note } = await json(req);
  need(note && note.trim(), 'Write what should change.');
  const t = agents.enqueue(p, stage || pipes.progress(p).current, { note: note.trim() });
  ok(res, { queued: t });
});

// ---------------- queue ----------------
route('GET', '/api/queue', async (req, res) => ok(res, { queue: store.getQueue().slice(0, 100) }));
route('GET', '/api/queue/:id/brief', async (req, res, { id }) => {
  const t = store.getQueue().find((x) => x.id === id);
  need(t, 'No such task', 404);
  ok(res, { task: t, ...(await agents.taskBrief(t)) });
});
route('POST', '/api/queue/:id/cancel', async (req, res, { id }) => {
  const q = store.getQueue(); const t = q.find((x) => x.id === id);
  need(t, 'No such task', 404); t.status = 'cancelled'; store.saveQueue(q); ok(res);
});
route('POST', '/api/queue/:id/done', async (req, res, { id }) => {
  const b = await json(req);
  ok(res, { task: agents.completeTask(id, b && Object.keys(b).length ? b : null) });
});

// ---------------- layer engine ----------------
route('GET', '/api/layers', async (req, res) => {
  const stages = {};
  for (const st of ['images', 'videos', 'voice', 'music']) stages[st] = layers.plan(st);
  ok(res, { stages, tools: Object.entries(layers.TOOLS).map(([id, t]) => ({ id, name: t.name, stages: t.stages, auto: t.auto, ready: t.ready(store.getSettings()) })) });
});
route('PUT', '/api/layers/:stage', async (req, res, { stage }) => {
  const { order } = await json(req);
  need(Array.isArray(order), 'Send the order as a list.');
  ok(res, { order: layers.setOrder(stage, order) });
});
route('POST', '/api/channels/:id/reel-story', async (req, res, { id }) => {
  need(store.getChannel(id)?.pipeline === 'reel', 'Not a ReelBite-style channel');
  ok(res, { id: await require('./reel').newStory(id) });
});
// ReelBite Shorts: narration per beat → sourced visuals → vertical comic edit.
route('POST', '/api/projects/:id/reel/:step', async (req, res, { id, step }) => {
  const p = store.getProject(id);
  need(p, 'No such project', 404);
  const FN = { voice: 'voice', visuals: 'visuals', edit: 'edit', factcheck: 'factcheck', check: 'check', package: 'packageShort', auto: 'auto' };
  need(FN[step], 'Unknown step');
  const stage = { visuals: 'images', factcheck: 'script', check: 'edit', package: 'publish', auto: 'voice' }[step] || step;
  background(id, stage, `ReelBite: ${step}`, async (st) => { await require('./reel')[FN[step]](id, st); });
  ok(res, { started: true });
});
route('POST', '/api/projects/:id/make/:stage', async (req, res, { id, stage }) => {
  const p = store.getProject(id);
  need(p, 'No such project', 404);
  need(['images', 'videos', 'voice', 'music'].includes(stage), 'Unknown stage');
  background(id, stage, `Brain is making the ${stage}`, async (step) => {
    const r = await layers.make(id, stage, step);
    const q = store.getProject(id);
    if (r.handoff === 'claude_browser') {
      const t = agents.enqueue(q, stage, { kind: 'browser', note: 'make the missing ' + stage });
      store.log(q, 'Brain', `Handed the rest of the ${stage} to Claude Code (${t.id})`); store.saveProject(q); return;
    }
    if (r.handoff === 'manual') {
      if (!q.waiting_manual?.[stage]) {
        q.waiting_manual = { ...(q.waiting_manual || {}), [stage]: new Date().toISOString() };
        store.log(q, 'Brain', stage === 'videos' || stage === 'images' ? `Paused: every free ${stage === 'videos' ? 'clip' : 'picture'} tool is at its limit or the checker is used up — tries again by itself (every 26 min for clips, 2 h for pictures)` : `Waiting for you to add the ${stage}`); store.saveProject(q);
        if (stage === 'music' || stage === 'voice') notify.send(`${store.getChannel(q.channel).short_name} · ${q.title}: please add the ${stage === 'music' ? 'Suno song' : stage}`, { project: id });
      }
      return;
    }
    if (r.measure) {
      step('Measuring the narration');
      const a = await media.analyzeAudio(path.join(store.projectDir(id), r.measure));
      const q2 = store.getProject(id);
      q2.audio = q2.audio.map((x) => (x.file === r.measure ? { ...x, analysis: a } : x));
      q2.picked_audio = r.measure; q2.audio_info = a;
      store.saveProject(q2);
      return;
    }
    if (!r.done) throw new Error(`No tool could finish the ${stage}:\n` + r.notes.join('\n'));
  });
  ok(res, { started: true });
});

// ---------------- Google credit ----------------
route('GET', '/api/google', async (req, res) => {
  const l = google.ledger().entries;
  const by = {};
  for (const e of l) by[e.kind] = (by[e.kind] || 0) + e.inr;
  ok(res, { budget: google.budget(), by_kind: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, Math.round(v)])), recent: l.slice(-20).reverse() });
});
route('POST', '/api/google/find-models', async (req, res) => {
  const r = await google.findModels();
  if (Object.keys(r.found).length) store.saveSettings(r.found);
  ok(res, r);
});
route('POST', '/api/notify/test', async (req, res) => {
  const r = await notify.send('Test from your Studio — notifications work.');
  need(r.ok, r.error || 'Could not send. Set the ntfy topic in Settings.');
  ok(res);
});

// ---------------- autopilot + scout ----------------
route('GET', '/api/autopilot', async (req, res) => {
  const st = autopilot.state();
  const q = store.getQueue();
  ok(res, { settings: (({ autopilot: a, autopilot_wan, claude_auto, claude_daily_cap, daily_scan, weekly_research, scout: sc }) => ({ autopilot: a, autopilot_wan, claude_auto, claude_daily_cap, daily_scan, weekly_research, scout: sc }))(store.getSettings()),
    google: store.getSettings().google_api_key ? google.budget() : null,
    running: autopilot.running(), runs: (st.runs || []).slice(0, 30), runs_today: (st.runs || []).filter((r) => r.day === new Date().toISOString().slice(0, 10)).length,
    schedule: st.schedule || {}, notes: (st.notes || []).slice(0, 30),
    queue: { open: q.filter((t) => t.status === 'open').length, running: q.filter((t) => t.status === 'running').length, stuck: q.filter((t) => t.status === 'stuck').length } });
});
route('POST', '/api/autopilot/now', async (req, res) => {
  await autopilot.walk(); autopilot.dispatch();
  ok(res);
});
route('GET', '/api/autopilot/runs/:log', async (req, res, { log }) => {
  need(/^[\w.-]+\.log$/.test(log), 'Bad log name');
  const f = path.join(P.data, 'claude_runs', log);
  ok(res, { text: store.readText(f, '(no output yet)').slice(-20000) });
});
route('POST', '/api/queue/:id/note', async (req, res, { id }) => {
  const { text } = await json(req);
  const q = store.getQueue(); const t = q.find((x) => x.id === id);
  need(t, 'No such task', 404);
  t.status = 'stuck'; t.blocked = String(text || '').slice(0, 500);
  store.saveQueue(q);
  const p = store.getProject(t.project);
  if (p) { store.log(p, t.agent + ' (Claude Code)', 'Blocked: ' + t.blocked); store.saveProject(p); }
  ok(res);
});
route('POST', '/api/queue/:id/retry', async (req, res, { id }) => {
  const q = store.getQueue(); const t = q.find((x) => x.id === id);
  need(t, 'No such task', 404);
  t.status = 'open'; t.claude_tries = 0; delete t.blocked;
  store.saveQueue(q); ok(res);
});
route('GET', '/api/scout', async (req, res) => ok(res, scout.load()));
route('POST', '/api/scout/run', async (req, res) => {
  const st = autopilot.state();
  if (st.scoutRunning && Date.now() - new Date(st.scoutRunning) < 10 * 60000) return ok(res, { started: false, note: 'The Scout is already looking.' });
  autopilot.note('Scout started by you'); const s2 = autopilot.state(); s2.scoutRunning = new Date().toISOString(); store.writeJSON(path.join(P.data, 'autopilot.json'), s2);
  scout.run().then((r) => autopilot.note(`Scout found ${r.found} new projects${r.newModels ? ', ' + r.newModels + ' new free models' : ''}${r.error ? ' (' + r.error + ')' : ''}`))
    .catch((e) => autopilot.note('Scout failed: ' + e.message))
    .finally(() => { const s3 = autopilot.state(); delete s3.scoutRunning; store.writeJSON(path.join(P.data, 'autopilot.json'), s3); });
  ok(res, { started: true });
});
route('POST', '/api/scout/:id/:status', async (req, res, { id, status }) => {
  need(['new', 'trying', 'dismissed', 'adopted'].includes(status), 'Unknown status');
  ok(res, { item: scout.setStatus(id, status) });
});

// ---------------- settings, apps, git ----------------
route('GET', '/api/settings', async (req, res) => ok(res, { settings: store.publicSettings(), setup: await setupChecks() }));
route('PUT', '/api/settings', async (req, res) => {
  const b = await json(req);
  for (const k of Object.keys(b)) if (typeof b[k] === 'string' && b[k].startsWith('••••')) delete b[k];
  store.saveSettings(b);
  ok(res, { settings: store.publicSettings() });
});

route('GET', '/api/apps', async (req, res) => {
  const apps = store.readJSON(P.apps, { apps: [] }).apps;
  const out = await Promise.all(apps.map(async (a) => {
    let up = null;
    if (a.health) { try { const r = await fetch(a.health, { signal: AbortSignal.timeout(2500) }); up = r.status < 500; } catch { up = false; } }
    return { ...a, up };
  }));
  ok(res, { apps: out, providers: store.readJSON(path.join(P.root, 'apps', 'providers.json'), null), custom: store.readJSON(path.join(P.data, 'apps_custom.json'), { apps: [] }).apps });
});

// Windows auto-start (a small file in the Startup folder)
const startupVbs = () => process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Anand Studio.vbs') : null;
route('GET', '/api/autostart', async (req, res) => {
  const f = startupVbs();
  ok(res, { supported: !!f && process.platform === 'win32', on: !!f && fs.existsSync(f) });
});
route('POST', '/api/autostart', async (req, res) => {
  need(process.platform === 'win32', 'Auto-start can only be set on Windows.');
  const { on } = await json(req);
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(P.root, 'tools', 'autostart.ps1')];
  if (!on) args.push('-Off');
  const r = await new Promise((resolve) => {
    const c = spawn('powershell.exe', args, { windowsHide: true });
    let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ code, out })); c.on('error', (e) => resolve({ code: -1, out: e.message }));
  });
  need(r.code === 0, 'Could not change auto-start: ' + r.out.trim().split('\n').pop());
  ok(res, { on: fs.existsSync(startupVbs()), message: r.out.trim() });
});

route('POST', '/api/git/sync', async (req, res) => {
  need(fs.existsSync(path.join(P.root, '.git')), 'This folder is not a git repo yet. Run setup step 4 in the README (git init + connect GitHub).');
  const { message } = await json(req);
  const sh = (args) => new Promise((resolve) => {
    const g = spawn('git', args, { cwd: P.root, windowsHide: true });
    let out = ''; g.stdout.on('data', (d) => (out += d)); g.stderr.on('data', (d) => (out += d));
    g.on('close', (code) => resolve({ code, out })); g.on('error', (e) => resolve({ code: -1, out: e.message }));
  });
  const steps = [];
  steps.push(await sh(['add', '-A']));        // .gitignore keeps media, keys and settings out
  const diff = await sh(['diff', '--cached', '--quiet']);
  if (diff.code === 0) return ok(res, { result: 'Nothing new to save.' });
  steps.push(await sh(['commit', '-m', message || `studio: sync ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`]));
  steps.push(await sh(['push']));
  const failed = steps.find((s) => s.code !== 0);
  ok(res, { result: failed ? 'Saved locally, push failed: ' + failed.out.trim().split('\n').pop() : 'Saved and pushed to GitHub.', log: steps.map((s) => s.out).join('\n') });
});

// ---------------- static ----------------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      try { return await r.handler(req, res, params); } catch (e) {
        if (!res.headersSent) return send(res, e.code && e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message });
        return;
      }
    }
    return send(res, 404, { error: 'No such API route' });
  }
  if (pathname.startsWith('/files/')) {
    const [, , pid, ...rest] = pathname.split('/');
    const file = path.join(store.projectDir(pid), ...rest);
    if (!file.startsWith(store.projectDir(pid))) { res.writeHead(403); return res.end(); }
    return serveFile(req, res, file);
  }
  if (pathname.startsWith('/doctor/')) {
    const base = path.join(P.data, 'thumb_doctor');
    const file = path.join(base, decodeURIComponent(pathname.slice(8)));
    if (!file.startsWith(base)) { res.writeHead(403); return res.end(); }
    return serveFile(req, res, file);
  }
  if (pathname.startsWith('/brand/')) {
    const file = path.join(P.brand, pathname.slice(7));
    if (!file.startsWith(P.brand)) { res.writeHead(403); return res.end(); }
    return serveFile(req, res, file);
  }
  const file = path.join(P.web, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(P.web) || !fs.existsSync(file)) return serveFile(req, res, path.join(P.web, 'index.html'));
  return serveFile(req, res, file);
}

// clear stale "busy" flags left by a crash or restart
for (const p of store.listProjects()) if (p.busy) { delete p.busy; p.error = { stage: '?', message: 'The Studio was restarted while this was running. Run it again.' }; store.saveProject(p); }

// ---------------- phone / other-device access ----------------
const os = require('os');
const isLocal = (req) => /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress || '');
const fails = new Map(); // ip -> { n, until }
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; })); }
function pinPage(res, msg = '') {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Studio</title>
<body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0">
<form method="POST" action="/pin" style="text-align:center;padding:24px"><h2>Anand's Studio</h2>
<p style="color:#aaa">Type the 6-digit PIN shown in Studio → Settings on your PC.</p>
<input name="pin" inputmode="numeric" maxlength="6" autofocus style="font-size:28px;letter-spacing:8px;width:190px;text-align:center;padding:10px;border-radius:10px;border:1px solid #555;background:#222;color:#fff">
<p style="color:#f88">${msg}</p><button style="font-size:18px;padding:10px 28px;border-radius:10px;border:0;background:#f5a623">Open</button></form></body>`);
}
async function gate(req, res) {
  if (isLocal(req)) return true;
  const s = store.getSettings();
  if (!s.phone_access) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Phone access is off. Turn it on in Studio → Settings on your PC.'); return false; }
  if (cookies(req).studio_pin === s.phone_pin) return true;
  const ip = req.socket.remoteAddress || '?';
  const f = fails.get(ip) || { n: 0, until: 0 };
  if (req.method === 'POST' && req.url.startsWith('/pin')) {
    if (f.until > Date.now()) { pinPage(res, 'Too many wrong tries. Wait 15 minutes.'); return false; }
    const pin = new URLSearchParams((await readBody(req, 1000)).toString()).get('pin');
    if (pin === s.phone_pin) {
      fails.delete(ip);
      res.writeHead(302, { Location: '/', 'Set-Cookie': `studio_pin=${s.phone_pin}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax` });
      res.end(); return false;
    }
    f.n += 1; if (f.n >= 8) { f.until = Date.now() + 15 * 60e3; f.n = 0; } fails.set(ip, f);
    pinPage(res, 'Wrong PIN.'); return false;
  }
  if (req.url.startsWith('/api/')) { send(res, 401, { error: 'Type the PIN first.' }); return false; }
  pinPage(res); return false;
}
function lanUrls() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
    if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
    out.push({ url: `http://${a.address}:${PORT}`, kind: a.address.startsWith('100.') ? 'tailscale' : 'wifi', name });
  }
  return out;
}
route('GET', '/api/kaggle/test', async (req, res) => ok(res, await require('./kaggle').test().catch((e) => ({ ok: false, error: e.message }))));
route('GET', '/api/browser', async (req, res) => ok(res, await require('./browser').status()));
route('POST', '/api/browser/open', async (req, res) => ok(res, { opened: await require('./browser').openForSignIn() }));
// Live view: watch Studio Chrome and sign in to sites from the phone.
route('GET', '/api/live', async (req, res) => {
  const projects = store.listProjects().filter((p) => p.busy || (p.stage && !/done|published/.test(p.stage))).slice(0, 6).map((p) => ({
    id: p.id, title: p.title, stage: p.stage, busy: p.busy?.msg || null,
    scenes: (p.scenes || []).length, images: (p.scenes || []).filter((x) => x.image).length, videos: (p.scenes || []).filter((x) => x.video).length,
    log: (p.log || []).slice(0, 5).map((l) => `${l.who}: ${String(l.text).slice(0, 160)}`),
  }));
  ok(res, { browser: require('./browser').liveInfo(), projects, alerts: require('./notify').recent().slice(0, 5) });
});
route('GET', '/api/live/shot', async (req, res) => {
  const buf = await require('./browser').liveShot().catch(() => null);
  if (!buf) { res.writeHead(204); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); res.end(buf);
});
route('POST', '/api/live/act', async (req, res) => ok(res, await require('./browser').liveAct(JSON.parse((await readBody(req, 5000)).toString() || '{}'))));
route('POST', '/api/live/open/:site', async (req, res, { site }) => ok(res, await require('./browser').liveOpen(site)));
route('POST', '/api/live/close', async (req, res) => ok(res, await require('./browser').liveClose()));

// Studio Assistant chat (website, PC or phone).
route('GET', '/api/assistant', async (req, res) => ok(res, { history: require('./assistant').history().slice(-30), state: require('./assistant').snapshot() }));
route('POST', '/api/assistant', async (req, res) => {
  const { message } = JSON.parse((await readBody(req, 10000)).toString() || '{}');
  ok(res, await require('./assistant').ask(message));
});

route('GET', '/api/access', async (req, res) => {
  const s = store.getSettings();
  ok(res, { phone_access: s.phone_access, pin: isLocal(req) ? s.phone_pin : null, urls: lanUrls(), pc: os.hostname() });
});

// Never let one bad request stop the Studio.
async function safeHandle(req, res) {
  try { if (!(await gate(req, res))) return; await handle(req, res); } catch (e) {
    if (!res.headersSent) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Bad request'); }
  }
}
process.on('uncaughtException', (e) => console.error('[studio] kept running after an error:', e.message));
process.on('unhandledRejection', (e) => console.error('[studio] kept running after an error:', e?.message || e));

const server = http.createServer(safeHandle);
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\n  The Studio is already running (port ${PORT} is in use).\n  Just open http://localhost:${PORT} in your browser.\n`);
  else console.error(e);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  autopilot.start(PORT);
  console.log(`\n  Studio is running → http://localhost:${PORT}\n  Phone (same Wi-Fi): ${lanUrls().map((u) => u.url).join('  ') || '—'}  PIN in Settings\n  Keep this window open. Close it to stop the Studio.\n`);
});
