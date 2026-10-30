// Studio Assistant: chat with the Studio from the website (PC or phone).
// It reads the live state of every video, answers in plain words, and can take safe actions:
// continue / retry a stage, switch the autopilot on or off, run the research agents, open a site to sign in.
// Brain: the free chain (FreeLLMAPI → Gemini → Ollama). "continue" works even when no brain is free.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const llm = require('./llm');
const pipes = require('./pipelines');

const PORT = +process.env.STUDIO_PORT || 4600;
const HIST = path.join(store.P.root, 'data', 'assistant_chat.json');
const history = () => store.readJSON(HIST, []);
const remember = (role, text) => { const h = history(); h.push({ role, text, t: new Date().toISOString() }); store.writeJSON(HIST, h.slice(-60)); };

async function api(method, url, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

function projectView(p) {
  const pr = pipes.progress(p);
  const scenes = p.scenes || [];
  return {
    id: p.id, channel: p.channel, title: p.title || p.idea?.title_en || p.id, pct: pr.pct, current: pr.current,
    stages: pr.stages.map((s) => ({ key: s.key, label: s.label, status: s.status })),
    scenes: scenes.length, images: scenes.filter((x) => x.image).length, videos: scenes.filter((x) => x.video).length,
    busy: p.busy?.msg || null, error: p.error?.message || null, stuck: Object.keys(p.waiting_manual || {}),
    final: !!p.edit?.file, log: (p.log || []).slice(0, 6).map((l) => `${l.who}: ${String(l.text).slice(0, 220)}`),
    updated: p.updated,
  };
}

function snapshot() {
  const all = store.listProjects().map(projectView);
  const active = all.filter((p) => p.current !== 'finished').sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  let browser = {};
  try { browser = require('./browser').liveInfo(); } catch {}
  const s = store.getSettings();
  return {
    now: new Date().toISOString(), autopilot: !!s.autopilot,
    projects: active.slice(0, 8), finished: all.filter((p) => p.current === 'finished').length,
    browser: { site: browser.site || null, needs: browser.needs || null, active: !!browser.active },
    alerts: require('./notify').recent().slice(0, 5).map((a) => `${a.t.slice(5, 16)} ${a.text}`),
    channels: store.listChannels ? store.listChannels().map((c) => ({ id: c.id, name: c.name })) : [],
  };
}

// "Continue": clear stops and start the current step of every stopped (or chosen) video again.
async function doContinue(projectId) {
  const done = [];
  for (const p of store.listProjects()) {
    if (projectId && p.id !== projectId) continue;
    const pr = pipes.progress(p);
    if (pr.current === 'finished' || p.busy) continue;
    const stopped = p.error || p.hold || Object.keys(p.waiting_manual || {}).length;
    if (!projectId && !stopped) continue;
    await api('POST', `/api/projects/${p.id}/clear-error`);
    if (['music', 'voice', 'images', 'videos'].includes(pr.current)) { await api('POST', `/api/projects/${p.id}/make/${pr.current}`).catch(() => {}); done.push(`${p.title || p.id}: started ${pr.current} again`); }
    else done.push(`${p.title || p.id}: cleared — the autopilot picks up "${pr.current}" within a minute`);
  }
  const s = store.getSettings();
  if (!s.autopilot) { const f = path.join(store.P.root, 'data', 'settings.json'); const j = store.readJSON(f, {}); j.autopilot = true; store.writeJSON(f, j); done.push('autopilot switched on'); }
  return done.length ? done : ['Nothing was stopped — everything is already running.'];
}

const ACTIONS = {
  async continue(a) { return (await doContinue(a.project)).join('\n'); },
  async retry(a) {
    if (!a.project || !['music', 'voice', 'images', 'videos', 'edit'].includes(a.stage)) throw new Error('retry needs a project and a stage');
    await api('POST', `/api/projects/${a.project}/clear-error`);
    await api('POST', a.stage === 'edit' ? `/api/projects/${a.project}/edit` : `/api/projects/${a.project}/make/${a.stage}`);
    return `Started ${a.stage} again.`;
  },
  async autopilot(a) { const f = path.join(store.P.root, 'data', 'settings.json'); const j = store.readJSON(f, {}); j.autopilot = !!a.on; store.writeJSON(f, j); return `Autopilot ${a.on ? 'on' : 'off'}.`; },
  async research(a) { await api('POST', `/api/channels/${a.channel}/opportunities`); return `Research agents started for ${a.channel}.`; },
  async signin(a) { await api('POST', `/api/live/open/${a.site}`); return 'Opened it on the Live screen — sign in there.'; },
};

const SYSTEM = `You are the Studio Assistant inside Anand's YouTube Studio (4 channels: Putani Loka Kids (Kannada), Bumbu Ki Duniya (Hindi), Sparkle Kids Planet (English), Legends Decoded (English documentary)).
The Studio makes each video by itself: research → song (Claude makes it on Suno) → timeline → pictures (Google Flow, checked against the character sheets) → clips (Vibes, checked for natural motion) → edit (FFmpeg + HyperFrames title and end card) → publish package. It uses free tools only.
You get a live STATE snapshot. Answer like a helpful producer: short, plain, simple English (Anand may write in mixed English/Kannada), exact numbers from STATE, what is happening now, what is stuck and why (read the log lines), and what happens next. Never invent progress. If something needs Anand (sign-in, human check, approval), say exactly what to press.
You can act. Allowed actions:
- {"type":"continue","project":"<id or omit for all stopped>"} — clear a stop and start again
- {"type":"retry","project":"<id>","stage":"images|videos|music|voice|edit"}
- {"type":"autopilot","on":true|false}
- {"type":"research","channel":"putani|bumbu|sparkle|legends"}
- {"type":"signin","site":"flow_image|meta_image|vibes_video|meta_animate"}
Only act when Anand asks for it (or says continue/start/retry). Never buy, never change accounts, never type passwords.
Reply JSON only: {"reply":"text for Anand","actions":[...]}`;

async function ask(message) {
  const msg = String(message || '').trim().slice(0, 2000);
  if (!msg) return { reply: 'Ask me anything about your videos.' };
  remember('user', msg);
  let reply, actions = [], model = null;
  if (/^\s*(continue|resume|start again|go on|carry on|restart|start)\b/i.test(msg) && msg.length < 40) {
    const lines = await doContinue();
    reply = 'Done:\n' + lines.map((l) => '• ' + l).join('\n');
  } else {
    const state = snapshot();
    const recent = history().slice(-10, -1).map((h) => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text }));
    try {
      const r = await llm.chat([{ role: 'system', content: SYSTEM }, ...recent, { role: 'user', content: `STATE:\n${JSON.stringify(state)}\n\nAnand: ${msg}` }], { json: true, temperature: 0.3, maxTokens: 2000 });
      reply = r.text?.reply || 'OK.'; actions = Array.isArray(r.text?.actions) ? r.text.actions.slice(0, 4) : []; model = r.model;
    } catch (e) {
      // No free brain right now: give the plain facts.
      reply = 'The free brain is busy right now, so here are the plain facts:\n' + state.projects.map((p) => `• ${p.title}: ${p.pct}% — now ${p.current}${p.busy ? ' (' + p.busy + ')' : ''}${p.stuck.length ? ' — STOPPED at ' + p.stuck.join(', ') + ' (say "continue")' : ''} — pictures ${p.images}/${p.scenes}, clips ${p.videos}/${p.scenes}`).join('\n');
    }
    const results = [];
    for (const a of actions) {
      try { if (!ACTIONS[a.type]) throw new Error('not allowed'); results.push('✓ ' + await ACTIONS[a.type](a)); }
      catch (e) { results.push(`✗ ${a.type}: ${e.message}`); }
    }
    if (results.length) reply += '\n\n' + results.join('\n');
  }
  remember('assistant', reply);
  return { reply, model };
}

module.exports = { ask, snapshot, history, doContinue };
