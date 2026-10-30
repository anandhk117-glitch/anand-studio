// Autopilot: the agents pick up their own work.
// - Every 30 s it looks at each project and starts the next job that needs no human decision.
// - It stops at every approval point (idea, song, version, timeline, final video, upload) — those stay yours.
// - Jobs that need Claude or your logged-in browser go to the request queue, and the dispatcher
//   runs Claude Code on them (one at a time, with a daily cap).
// - A small scheduler runs the daily YouTube scan, weekly fresh research and the weekly Scout.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const pipes = require('./pipelines');
const llm = require('./llm');

let BASE = 'http://127.0.0.1:4600';
const STATE = path.join(store.P.data, 'autopilot.json');
const RUNS = path.join(store.P.data, 'claude_runs');
const state = () => store.readJSON(STATE, { runs: [], schedule: {}, notes: [] });
const saveState = (s) => store.writeJSON(STATE, s);
const today = () => new Date().toISOString().slice(0, 10);

async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}
function note(text) {
  const s = state();
  s.notes = [{ t: new Date().toISOString(), text }, ...(s.notes || [])].slice(0, 100);
  saveState(s);
}

// ---------------- the project walker ----------------
let llmUp = false, llmChecked = 0;
async function llmReady() {
  if (Date.now() - llmChecked > 60000) { llmUp = await llm.ping(); llmChecked = Date.now(); }
  const st = store.getSettings();
  return llmUp && (!!st.llm_api_key || !!st.aistudio_api_key || (!!st.google_api_key && st.brain === 'google'));
}

function openTask(p, stage) {
  return store.getQueue().find((t) => t.project === p.id && t.stage === stage && (t.status === 'open' || t.status === 'running' || t.status === 'stuck'));
}

// Decide the one next action for a project, or null.
async function nextAction(p) {
  const s = store.getSettings();
  const pr = pipes.progress(p);
  const cur = pr.current;
  if (cur === 'finished') return null;
  const waiting = pr.stages.find((x) => x.key === cur)?.status === 'waiting';
  const writeMode = (await llmReady()) ? 'llm' : null; // writing always uses the free brain, never Claude
  const scenes = p.scenes || [];

  // Clips that failed on every free tool (site down, daily limit, sign-in) are tried again every 26 minutes (matches the Vibes send gap).
  if (['images', 'videos', 'edit'].includes(cur) && p.pipeline === 'kids_song' && p.waiting_manual?.videos && Date.now() - Date.parse(p.waiting_manual.videos) > 26 * 60e3 && scenes.some((x) => x.image && (!x.video || x.redo))) {
    const q = store.getProject(p.id); delete q.waiting_manual.videos; q.auto = {}; store.log(q, 'Autopilot', 'Trying the remaining clips again'); store.saveProject(q);
    return { stage: cur, post: 'make/videos' };
  }
  // Lyric times must be HEARD from the song, never guessed: an estimated timeline is replaced first.
  if (p.pipeline === 'kids_song' && p.picked_audio && p.song?.lyrics && p.timeline?.source === 'estimate') {
    // Free Gemini quota runs out some days: try listening again every 2 hours; never build scenes on a guessed timeline.
    const failed = p.timeline.listen_failed ? Date.parse(p.timeline.listen_failed) : 0;
    if (!failed || Date.now() - failed > 2 * 3600e3) return { stage: cur, post: 'timeline/listen' };
    return null;
  }
  if (p.pipeline === 'reel') {
    // ReelBite: script (from the saved Wikipedia text) → fact-check → voice → visuals → edit → check → package
    if (cur === 'script') { if (!p.script?.beats?.length) return writeMode ? { stage: cur, run: 'script', mode: 'llm' } : null; return !p.script.checked ? { stage: cur, post: 'reel/factcheck' } : null; }
    if (cur === 'voice') return !(p.audio || []).length ? { stage: cur, post: 'reel/voice' } : null;
    if (cur === 'images') return { stage: cur, post: 'reel/visuals' };
    if (cur === 'edit') return !p.edit?.file ? { stage: cur, post: 'reel/edit' } : !p.edit.approved ? { stage: cur, post: 'reel/check' } : null;
    if (cur === 'publish') return !p.publish?.titles?.length ? { stage: cur, post: 'reel/package' } : null;
    return null;
  }
  // Your turn — unless this is a topic-only project, where the brain decides after its checks.
  if (waiting && cur !== 'publish') {
    if (cur === 'research') return (p.ideas || []).length && !p.notified_ideas ? { stage: cur, decide: 'ideas_ready' } : null;
    return p.full_auto ? { stage: cur, decide: cur } : null;
  }
  switch (cur) {
    case 'research': return !(p.ideas || []).length && writeMode && !openTask(p, 'research') ? { stage: cur, run: 'research', mode: writeMode } : null;
    case 'song': return !p.song?.lyrics && writeMode && !openTask(p, 'song') ? { stage: cur, run: 'song', mode: writeMode } : null;
    case 'script': return !p.script?.text && writeMode && !openTask(p, 'script') ? { stage: cur, run: 'script', mode: writeMode } : null;
    case 'music': case 'voice':
      return !(p.audio || []).length && !openTask(p, cur) && !p.waiting_manual?.[cur] ? { stage: cur, post: 'make/' + cur } : null;
    case 'images': {
      if (!scenes.some((x) => x.image_prompt)) return writeMode && !openTask(p, 'images') ? { stage: cur, run: 'images', mode: writeMode } : null;
      const stuck = p.waiting_manual?.images;
      // Stubborn pictures: try again every 2 hours (free limits refill), and meanwhile make clips for the scenes that are ready.
      if (stuck && Date.now() - Date.parse(stuck) > 2 * 3600e3) {
        const q = store.getProject(p.id); delete q.waiting_manual.images; q.auto = {}; store.log(q, 'Autopilot', 'Trying the remaining pictures again'); store.saveProject(q);
        return { stage: cur, post: 'make/images' };
      }
      if (stuck && p.pipeline === 'kids_song' && (p.motion_version || 1) < 2 && writeMode && !openTask(p, 'videos')) return { stage: cur, run: 'videos', mode: writeMode };
      if (stuck && scenes.some((x) => x.image && !x.video) && scenes.some((x) => x.motion_prompt)) return { stage: cur, post: 'make/videos' };
      return scenes.some((x) => !x.image) && !openTask(p, 'images') && !stuck ? { stage: cur, post: 'make/images' } : null;
    }
    case 'videos':
      if (p.pipeline === 'kids_song' && (p.motion_version || 1) < 2 && writeMode && !openTask(p, 'videos')) return { stage: cur, run: 'videos', mode: writeMode };
      if (!scenes.some((x) => x.motion_prompt)) return writeMode && !openTask(p, 'videos') ? { stage: cur, run: 'videos', mode: writeMode } : null;
      return scenes.some((x) => x.image && !x.video) && !openTask(p, 'videos') ? { stage: cur, post: 'make/videos' } : null;
    case 'edit':
      if (p.edit_hold) return scenes.some((x) => x.image && (!x.video || x.redo)) && !openTask(p, 'videos') ? { stage: cur, post: 'make/videos' } : null; // Anand is reviewing the clips — make clips, but no edit
      // a clip marked for remaking comes first — never edit with a rejected clip
      if (scenes.some((x) => x.redo && x.image)) return !openTask(p, 'videos') ? { stage: cur, post: 'make/videos' } : null;
      return !p.edit?.file ? { stage: cur, post: 'edit' } : null;
    case 'publish':
      if (!p.publish?.titles?.length) return writeMode && !openTask(p, 'publish') ? { stage: cur, run: 'publish', mode: writeMode } : null;
      if (p.edit?.file && !p.publish?.thumbnail) return { stage: cur, post: 'thumbnail' };
      if (p.edit?.file && (p.publish.shorts || []).length && !(p.publish.shorts || []).some((x) => x.file)) return { stage: cur, post: 'shorts' };
      if (waiting && p.full_auto) return { stage: cur, decide: 'publish' };
      return null;
    default: return null;
  }
}

// ---------------- the brain's own decisions (topic-only projects) ----------------
async function hold(id, why) {
  const q = store.getProject(id);
  q.hold = why;
  store.log(q, 'Brain', 'Needs Anand: ' + why);
  store.saveProject(q);
  await require('./notify').send(`${store.getChannel(q.channel).short_name} · ${q.title}: needs you — ${why}`, { project: id, priority: 4 });
}
async function decide(p, what) {
  const id = p.id;
  const notify = require('./notify');
  const agents = require('./agents');
  if (what === 'ideas_ready') {
    const q = store.getProject(id); q.notified_ideas = true; store.saveProject(q);
    await notify.send(`${store.getChannel(p.channel).short_name}: 4 new ideas are ready. Pick one and the brain makes the video.`, { project: id });
    return;
  }
  if (what === 'song' || what === 'script' || what === 'publish') {
    const kind = what === 'publish' ? 'package' : what;
    const r = await agents.review(p, kind);
    const q = store.getProject(id);
    store.log(q, 'Quality checker', `${kind}: ${r.score}/10${r.problems.length ? ' — ' + r.problems.slice(0, 3).join('; ') : ''}`);
    q.reviews = { ...(q.reviews || {}), [kind]: r };
    store.saveProject(q);
    if (r.verdict === 'approve' || r.score >= 7) {
      await api('POST', `/api/projects/${id}/approve/${what}`, { note: `approved by the brain (${r.score}/10)` });
      if (what === 'publish') await notify.send(`${store.getChannel(p.channel).short_name} · ${p.title} is finished and ready to upload.`, { project: id, priority: 4 });
      return;
    }
    const rewrites = (q.rewrites || {})[kind] || 0;
    if (rewrites < 1 && r.verdict !== 'needs_anand') {
      const q2 = store.getProject(id); q2.rewrites = { ...(q2.rewrites || {}), [kind]: rewrites + 1 }; store.saveProject(q2);
      await api('POST', `/api/projects/${id}/run/${what}`, { mode: 'llm', note: 'Fix these problems: ' + r.problems.join('; ') });
      return;
    }
    return hold(id, `the ${kind} scored ${r.score}/10 after a rewrite: ${r.problems.slice(0, 2).join('; ')}`);
  }
  if (what === 'pick') {
    const best = (p.audio || []).filter((a) => a.analysis).sort((a, b) => b.analysis.total - a.analysis.total)[0];
    if (!best) return;
    await api('POST', `/api/projects/${id}/pick-audio`, { file: best.file });
    return;
  }
  if (what === 'timeline') { await api('POST', `/api/projects/${id}/approve/timeline`, { note: 'approved by the brain' }); return; }
  if (what === 'edit') {
    const media = require('./media');
    const q = store.getProject(id);
    const r = await media.qa(require('path').join(store.projectDir(id), q.edit.file));
    q.qa = r; store.log(q, 'Quality checker', r.ok ? 'Final video passed: no freezes, no black screens, loudness fine' : 'Final video problems: ' + r.problems.join('; '));
    store.saveProject(q);
    if (r.ok && q.pipeline === 'kids_song' && q.edit?.made && q.director_checked !== q.edit.made) {
      // Director's review: every scene against its lyric + clean animation, before anything goes to Anand.
      let rev = null;
      try { rev = await require('./quality').directorReview(q, require('path').join(store.projectDir(id), q.edit.file)); } catch (e) { rev = null; }
      const q2 = store.getProject(id);
      q2.director_checked = q.edit.made; q2.director_review = rev;
      if (rev && !rev.ok) {
        const auto = rev.issues.filter((x) => x.matches_lyric && !x.clean);
        const needsAnand = rev.issues.filter((x) => !x.matches_lyric);
        store.log(q2, 'Director', `Watched the final cut: ${rev.issues.length} scene(s) not good enough — ${rev.issues.map((x) => `${x.scene}: ${x.problem}`).join('; ').slice(0, 600)}`);
        if (auto.length && (q2.director_rounds || 0) < 2) {
          q2.director_rounds = (q2.director_rounds || 0) + 1;
          for (const x of auto) { const sc = q2.scenes.find((y) => y.n === x.scene); if (sc?.video) { sc.redo = true; sc.clip_rejects = (sc.clip_rejects || 0) + 1; sc.clip_check = { ok: false, problems: [x.problem] }; } }
          q2.edit = { ...q2.edit, file: null, approved: false };
          store.saveProject(q2);
          if (!needsAnand.length) return;
        } else store.saveProject(q2);
        if (needsAnand.length) return hold(id, 'the director found scenes that do not show what the lyric says: ' + needsAnand.map((x) => `scene ${x.scene} — ${x.problem} (should show: ${x.fix})`).join('; '));
        if ((q2.director_rounds || 0) >= 2) return hold(id, 'the director still sees unclean scenes after 2 remakes: ' + auto.map((x) => `scene ${x.scene} — ${x.problem}`).join('; '));
      } else {
        store.log(q2, 'Director', rev ? `Watched all ${rev.checked} scenes: every scene shows its lyric and looks clean` : 'Director review skipped (picture checker not available)');
        store.saveProject(q2);
      }
    }
    if (r.ok) { await api('POST', `/api/projects/${id}/approve/edit`, { note: 'passed the quality check and the director' }); return; }
    return hold(id, 'the final video failed its check: ' + r.problems.join('; '));
  }
}

let walking = false;
async function walk() {
  const s = store.getSettings();
  if (!s.autopilot || walking) return;
  walking = true;
  try {
    // The free clip tools give about 20-30 good clips a day — shared by every channel. They all go to ONE song at a time
    // (the one closest to finished), so one full-motion video is finished every day instead of three half-done ones.
    const needClips = (p) => p.pipeline === 'kids_song' && (p.scenes || []).length && (p.scenes || []).every((x) => x.image) && (p.scenes || []).some((x) => !x.video || x.redo);
    const leader = store.listProjects().map((x) => store.getProject(x.id)).filter((x) => x && !x.hold && x.autopilot !== false && needClips(x))
      .sort((a, b) => ((b.scenes.filter((x) => x.video && !x.redo).length / b.scenes.length) - (a.scenes.filter((x) => x.video && !x.redo).length / a.scenes.length)) || String(a.created).localeCompare(String(b.created)))[0];
    for (const p of store.listProjects()) {
      if (p.busy || p.error || p.hold || p.autopilot === false || store.getChannel(p.channel)?.paused) continue;
      let a;
      try { a = await nextAction(p); } catch { continue; }
      if (!a) continue;
      if (a.post === 'make/videos' && p.pipeline === 'kids_song' && leader && leader.id !== p.id) continue; // waits its turn for the clip tools
      const key = `${a.stage}:${a.run || a.post || 'decide-' + a.decide}:${a.mode || ''}`;
      if (((p.auto || {})[key] || 0) >= 2) continue; // tried twice — leave it for you
      const q = store.getProject(p.id);
      q.auto = { ...(q.auto || {}), [key]: ((q.auto || {})[key] || 0) + 1 };
      if (!a.decide) store.log(q, 'Autopilot', a.run ? `Started ${a.run} (${a.mode === 'claude' ? 'Claude Code' : 'brain'})` : `Started ${a.post}`);
      store.saveProject(q);
      try {
        if (a.decide) await decide(p, a.decide);
        else if (a.run) await api('POST', `/api/projects/${p.id}/run/${a.run}`, { mode: a.mode, note: a.note || '' });
        else await api('POST', `/api/projects/${p.id}/${a.post}`, a.body || {});
      } catch (e) {
        const r = store.getProject(p.id);
        store.log(r, 'Autopilot', `Could not ${a.decide ? 'decide ' + a.decide : 'start ' + (a.run || a.post)}: ${e.message}`);
        store.saveProject(r);
      }
    }
  } finally { walking = false; }
}

// When a stage moves on, its try-counter resets (called from the server on approvals).
function resetTries(p) { p.auto = {}; }

// ---------------- Claude Code dispatcher ----------------
let child = null;
function claudeRunsToday() { return (state().runs || []).filter((r) => r.day === today()).length; }

function dispatch() {
  const s = store.getSettings();
  if (!s.claude_auto || child) return;
  const cap = +s.claude_daily_cap || 6;
  if (claudeRunsToday() >= cap) return;
  const q = store.getQueue();
  const allowed = s.claude_stages || ['music'];
  const t = [...q].reverse().find((x) => x.status === 'open' && (x.claude_tries || 0) < 2 && allowed.includes(x.stage));
  if (!t) return;
  t.status = 'running';
  t.claude_tries = (t.claude_tries || 0) + 1;
  store.saveQueue(q);
  fs.mkdirSync(RUNS, { recursive: true });
  const logFile = path.join(RUNS, `${new Date().toISOString().replace(/[:.]/g, '-')}_${t.id}.log`);
  const prompt = [
    `You are the Studio agent. Read CLAUDE.md in this folder first.`,
    `Do exactly one request: ${t.id} (${t.title}).`,
    `Run: node tools/agent.js show ${t.id}   — it prints the full brief.`,
    `Finish it and run the "done" command it tells you. If you cannot finish (login, captcha, payment, missing account, daily limit), do NOT mark it done: run  node tools/agent.js note-task ${t.id} "<what blocked you>"  and stop.`,
    `Never buy credits, never type passwords, never create accounts.`,
  ].join('\n');
  const args = ['-p', prompt, '--permission-prompts', 'none', '--max-turns', String(+s.claude_max_turns || 80), '--output-format', 'text',
    '--allowedTools', 'Bash(node tools/agent.js *)', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'mcp__claude-in-chrome__*', 'mcp__vidIQ_for_Claude__*'];
  if (t.kind === 'browser') args.push('--chrome');
  const run = { id: t.id, title: t.title, started: new Date().toISOString(), day: today(), log: path.basename(logFile) };
  const st = state(); st.runs = [run, ...(st.runs || [])].slice(0, 200); saveState(st);
  const out = fs.openSync(logFile, 'a');
  try {
    child = spawn(s.claude_path || 'claude', args, { cwd: store.P.root, windowsHide: true, stdio: ['ignore', out, out], shell: false });
  } catch (e) { try { fs.closeSync(out); } catch {} finish(t.id, run, -1, 'Claude Code could not start: ' + e.message); return; }
  const timer = setTimeout(() => { try { child.kill(); } catch {} }, (+s.claude_timeout_min || 45) * 60000);
  child.on('error', (e) => { clearTimeout(timer); child = null; try { fs.closeSync(out); } catch {} finish(t.id, run, -1, 'Claude Code could not start: ' + e.message + '. Check the Claude Code path in Settings.'); });
  child.on('exit', (code) => { clearTimeout(timer); child = null; try { fs.closeSync(out); } catch {} finish(t.id, run, code); });
}

function finish(taskId, run, code, err) {
  const q = store.getQueue();
  const t = q.find((x) => x.id === taskId);
  if (t && t.status === 'running') {
    t.status = (t.claude_tries || 0) >= 2 ? 'stuck' : 'open';
    if (err) t.blocked = err;
    store.saveQueue(q);
  }
  const st = state();
  st.runs = (st.runs || []).map((r) => (r.log === run.log ? { ...r, ended: new Date().toISOString(), exit: code, result: t?.status === 'done' ? 'done' : (err || 'not finished') } : r));
  saveState(st);
}
function running() { return child ? state().runs?.[0] : null; }

// ---------------- scheduler ----------------
function due(key, hour, weekday) {
  const st = state();
  const now = new Date();
  const last = st.schedule?.[key];
  if (weekday != null && now.getDay() !== weekday) return false;
  if (now.getHours() < hour) return false;
  if (last && last.slice(0, 10) === today()) return false;
  return true;
}
function mark(key) { const st = state(); st.schedule = { ...(st.schedule || {}), [key]: new Date().toISOString() }; saveState(st); }

async function schedule() {
  const s = store.getSettings();
  try {
    if (s.daily_scan && s.youtube_api_key && due('daily_scan', 6)) {
      mark('daily_scan');
      for (const c of store.listChannels()) {
        try { await api('POST', `/api/channels/${c.id}/stats`); } catch {}
        try { await api('POST', `/api/channels/${c.id}/scan`); } catch {}
      }
      note('Daily YouTube scan done for all channels');
    }
    // ReelBite-style channels: start up to per_day new stories a day (07:00, 12:00, 17:00 IST), one in production at a time
    for (const c of store.listChannels().filter((x) => x.pipeline === 'reel' && !x.paused)) {
      const ist = new Date(Date.now() + 5.5 * 3600e3); const day = ist.toISOString().slice(0, 10); const hour = ist.getUTCHours();
      const mine = store.listProjects(c.id).map((x) => store.getProject(x.id)).filter(Boolean);
      const today = mine.filter((x) => x.source === 'reel-daily' && new Date(Date.parse(x.created) + 5.5 * 3600e3).toISOString().slice(0, 10) === day).length;
      const slots = (c.slots || [7, 12, 17]).slice(0, c.per_day || 3);
      const busy = mine.some((x) => x.source === 'reel-daily' && !x.hold && !(x.publish?.titles?.length));
      const st = state(); const last = (st.reel_started || {})[c.id] || 0;
      if (!busy && today < slots.length && hour >= slots[today] && Date.now() - last > 30 * 60e3) {
        st.reel_started = { ...(st.reel_started || {}), [c.id]: Date.now() }; saveState(st);
        try { const r = await api('POST', `/api/channels/${c.id}/reel-story`, {}); note(`${c.short_name}: new story started (${r.id})`); } catch (e) { note(`${c.short_name}: no new story (${e.message.slice(0, 120)})`); }
      }
    }
    if (s.weekly_research && due('weekly_research', 7, 1)) {
      mark('weekly_research');
      for (const c of store.listChannels()) {
        if (c.paused || c.pipeline === 'reel') continue; // paused channels wait; ReelBite finds its own stories daily
        const waiting = store.listProjects(c.id).some((p) => !p.idea);
        if (!waiting) { try { await api('POST', `/api/channels/${c.id}/research`, { mode: (await llmReady()) ? 'llm' : 'claude', focus: '' }); } catch {} }
      }
      note('Weekly research: 4 fresh ideas started for each channel');
    }
    if (s.youtube_api_key && s.thumb_doctor !== false && due('thumb_doctor', 9, 0)) {
      mark('thumb_doctor');
      for (const c of store.listChannels().filter((x) => x.youtube?.handle || x.youtube?.channel_id)) {
        try {
          const r = await require('./thumbs').doctor(c.id);
          note(`Thumbnail doctor (${c.short_name || c.name}): ${r.fixes.length} thumbnail${r.fixes.length === 1 ? '' : 's'} to change`);
          if (r.fixes.length) await require('./notify').send(`${c.short_name || c.name}: ${r.fixes.length} thumbnail${r.fixes.length === 1 ? '' : 's'} could get more clicks — new ones are ready. http://localhost:4600/doctor/${c.id}/${r.day}/index.html`, { title: 'Thumbnail doctor', priority: 3 });
        } catch (e) { note(`Thumbnail doctor (${c.short_name || c.name}) failed: ${e.message}`); }
      }
    }
    if (s.scout && due('scout', 8, 0)) {
      mark('scout');
      try { await require('./scout').run(); note('Scout finished its weekly look for new free tools'); } catch (e) { note('Scout failed: ' + e.message); }
    }
  } catch { /* never let the scheduler stop the Studio */ }
}

function start(port) {
  BASE = `http://127.0.0.1:${port}`;
  // tasks left "running" by a restart go back to open
  const q = store.getQueue(); let changed = false;
  for (const t of q) if (t.status === 'running') { t.status = 'open'; changed = true; }
  if (changed) store.saveQueue(q);
  setInterval(() => walk().catch(() => {}), 30000);
  setInterval(dispatch, 60000);
  setInterval(() => schedule().catch(() => {}), 5 * 60000);
  setTimeout(() => { walk().catch(() => {}); schedule().catch(() => {}); }, 8000);
}

module.exports = { start, walk, dispatch, schedule, state, running, resetTries, note };
