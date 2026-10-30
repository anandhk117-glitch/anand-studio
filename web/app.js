/* Anand's YouTube Studio — frontend (no build step, no framework). */
'use strict';

// ---------------- small helpers ----------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtT = (t) => { t = Math.max(0, +t || 0); return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };
const fmtN = (n) => n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
const ago = (iso) => { if (!iso) return ''; const s = (Date.now() - new Date(iso)) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return Math.floor(s / 86400) + ' days ago'; };
const LANG = { Kannada: 'kn', Hindi: 'hi', English: 'en' };
const file = (pid, f) => `/files/${encodeURIComponent(pid)}/${encodeURIComponent(f)}?v=${Date.now() % 1e7}`;

async function api(method, url, body, raw) {
  const opt = { method, headers: {} };
  if (raw) { opt.body = body; opt.headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  let r;
  try { r = await fetch(url, opt); } catch { throw new Error('The Studio server is not answering. Is the black "Start Studio" window still open?'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}
let toastTimer;
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast on' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = 'toast'), bad ? 6500 : 3200);
}
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message, true); return null; }
}
function theme(c) {
  const s = document.documentElement.style;
  s.setProperty('--c', c?.color || '#3B5BDB'); s.setProperty('--ca', c?.accent || '#12B5A6'); s.setProperty('--ci', c?.ink || '#0B2550');
}
const isDark = (c) => c?.pipeline === 'documentary';
const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

// ---------------- state + routing ----------------
const S = { ov: null, route: [], ch: null, pj: null, stage: null, tab: 'projects', lastUpdated: null };

function parse() {
  const h = location.hash.replace(/^#\/?/, '');
  return h ? h.split('/').map(decodeURIComponent) : [];
}
window.addEventListener('hashchange', () => go());
async function go() {
  S.route = parse();
  const [page, id, sub] = S.route;
  $('#main').scrollTo?.(0, 0); window.scrollTo(0, 0);
  try {
    if (!page) await pageHome();
    else if (page === 'c') { S.tab = sub || 'projects'; await pageChannel(id); }
    else if (page === 'p') { S.stage = sub || null; await pageProject(id, true); }
    else if (page === 'requests') await pageRequests();
    else if (page === 'apps') await pageApps();
    else if (page === 'settings') await pageSettings();
    else await pageHome();
  } catch (e) {
    $('#main').innerHTML = `<div class="note bad">${esc(e.message)}</div>`;
  }
  side();
}

// ---------------- sidebar ----------------
async function side() {
  try { S.ov = await api('GET', '/api/overview'); } catch { /* keep old */ }
  const ov = S.ov; if (!ov) return;
  const [page, id] = S.route;
  const waitCount = (cid) => ov.waiting.filter((w) => w.channel === cid).length;
  const st = ov.setup;
  $('#side').innerHTML = `
    <a class="brand" href="#/"><div class="brand-mark"><i></i><i></i><i></i><i></i></div><div><b>Studio</b><span>Anand's channels</span></div></a>
    <nav class="nav">
      <a href="/live.html" style="font-weight:700">● Live, chat &amp; progress</a>
      <a href="#/" class="${!page ? 'on' : ''}">Home ${ov.waiting.length ? `<span class="count" title="Waiting for you">${ov.waiting.length}</span>` : ''}</a>
      <div class="nav-h">Channels</div>
      ${ov.channels.map((c) => `<a href="#/c/${c.id}" class="${(page === 'c' && id === c.id) || (page === 'p' && S.pj?.project?.channel === c.id) ? 'on' : ''}">
        <span class="dot" style="background:${c.pipeline === 'documentary' ? c.accent : c.color}"></span>${esc(c.short_name)}
        ${waitCount(c.id) ? `<span class="count">${waitCount(c.id)}</span>` : `<span class="native" lang="${LANG[c.language]}">${c.language}</span>`}</a>`).join('')}
      <div class="nav-h">Workshop</div>
      <a href="#/requests" class="${page === 'requests' ? 'on' : ''}">Requests for Claude Code ${ov.queue.length ? `<span class="count" style="background:#3B5BDB">${ov.queue.length}</span>` : ''}</a>
      <a href="#/apps" class="${page === 'apps' ? 'on' : ''}">Free apps &amp; repos</a>
      <a href="#/settings" class="${page === 'settings' ? 'on' : ''}">Settings</a>
    </nav>
    <div class="side-foot">
      <div class="chk ${st.ffmpeg ? 'ok' : ''}"><i></i>ffmpeg ${st.ffmpeg ? 'ready' : 'not found'}</div>
      <div class="chk ${st.llm ? 'ok' : ''}"><i></i>Free AI ${st.llm ? 'connected' : 'not connected'}</div>
      <div class="chk ${st.youtube ? 'ok' : ''}"><i></i>YouTube key ${st.youtube ? 'added' : 'missing'}</div>
      <div class="chk ${st.wan ? 'ok' : ''}"><i></i>Wan 3.0 ${st.wan ? 'key added' : 'not set'}</div>
      <div class="chk ${st.git ? 'ok' : ''}"><i></i>GitHub ${st.git ? 'linked' : 'not linked'}</div>
    </div>`;
}

// ---------------- HOME ----------------
async function pageHome() {
  theme(null);
  const [ov, ap] = await Promise.all([api('GET', '/api/overview'), api('GET', '/api/autopilot').catch(() => null)]);
  S.ov = ov;
  const hour = new Date().getHours();
  const hi = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const summary = [
    ov.waiting.length ? `${ov.waiting.length} waiting for you` : 'nothing waiting for you',
    ov.busy.length ? `${ov.busy.length} agent${ov.busy.length > 1 ? 's' : ''} working` : null,
    ov.queue.length ? `${ov.queue.length} request${ov.queue.length > 1 ? 's' : ''} for Claude Code` : null,
  ].filter(Boolean).join(', ');
  const st = ov.setup;
  const setupMissing = [!st.ffmpeg && 'ffmpeg', !st.llm && 'free AI (FreeLLMAPI)', !st.youtube && 'YouTube API key'].filter(Boolean);
  $('#main').innerHTML = `
    <div class="hello">
      <div><h1>${hi}, Anand</h1><p>${esc(summary[0].toUpperCase() + summary.slice(1))}.</p></div>
      <div class="row"><a class="btn" href="#/requests">Requests</a><button class="btn primary" data-act="sync">Save to GitHub</button></div>
    </div>
    ${setupMissing.length ? `<div class="note warn" style="margin-bottom:18px">Still to set up: ${setupMissing.join(', ')}. <a href="#/settings">Open Settings</a> — the Studio works without them, but those agents will hand their jobs to Claude Code instead.</div>` : ''}
    ${ap ? autopilotPanel(ap) : ''}
    <div class="posters">${ov.channels.map(poster).join('')}</div>
    <div class="home-cols">
      <section class="panel">
        <div class="panel-h"><h2>Waiting for you</h2><span class="muted small">Your decisions keep the line moving</span></div>
        ${ov.waiting.length ? ov.waiting.map((w) => listItem(w, w.error ? `Problem at ${w.error.stage}` : `Decide: ${w.waiting}`)).join('')
          : `<div class="empty"><h3>All clear</h3><p>Start research on a channel to make the next video.</p></div>`}
      </section>
      <section class="panel">
        <div class="panel-h"><h2>Working now</h2></div>
        ${ov.busy.length ? ov.busy.map((w) => listItem(w, w.busy.msg)).join('') : '<p class="muted">No agent is busy right now.</p>'}
        ${ov.queue.length ? `<h4 style="margin-top:18px">With Claude Code</h4>${ov.queue.slice(0, 6).map((t) => `<a class="list-item" href="#/p/${t.project}"><span class="chip" style="background:#3B5BDB"></span><div><b>${esc(t.title)}</b><span class="muted small">${esc(t.agent)} · ${ago(t.created)}</span></div></a>`).join('')}` : ''}
      </section>
    </div>`;
}
function autopilotPanel(ap) {
  const g = ap.google;
  const on = ap.settings.autopilot;
  const sch = ap.schedule || {};
  const last = (k) => (sch[k] ? ago(sch[k]) : 'not yet');
  return `<section class="panel autopilot ${on ? 'on' : ''}" style="margin-bottom:18px">
    <div class="spread"><div class="row"><span class="pulse ${on ? 'live' : ''}"></span><div><h3>Autopilot is ${on ? 'on' : 'off'}</h3>
      <p class="small muted">${on ? 'Agents start their own jobs and stop at every decision that is yours.' : 'Agents wait until you press their buttons.'}</p></div></div>
      <div class="row"><button class="btn sm" data-act="ap-now" ${on ? '' : 'disabled'}>Check for work now</button>
      <button class="btn sm ${on ? '' : 'go'}" data-act="ap-toggle" data-on="${on ? '0' : '1'}">${on ? 'Pause autopilot' : 'Turn autopilot on'}</button></div></div>
    ${g && g.total ? `<div class="budget"><div class="spread small"><span><b>Google credit</b> ₹${g.used.toLocaleString('en-IN')} of ₹${g.total.toLocaleString('en-IN')} used · ₹${g.today} today</span><span class="muted">${Math.max(0, Math.ceil((new Date(g.expiry) - Date.now()) / 86400000))} days left (until ${esc(g.expiry)})</span></div><div class="bar"><i style="width:${Math.min(100, (g.used / g.total) * 100).toFixed(1)}%"></i></div></div>` : ''}
    <div class="ap-grid">
      <div><b>Claude Code</b><span>${ap.running ? 'working on ' + esc(ap.running.title) : ap.settings.claude_auto ? 'idle' : 'off'} · ${ap.runs_today}/${ap.settings.claude_daily_cap} runs today</span></div>
      <div><b>Requests</b><span>${ap.queue.open} waiting · ${ap.queue.running} running${ap.queue.stuck ? ` · <a href="#/requests">${ap.queue.stuck} blocked</a>` : ''}</span></div>
      <div><b>Daily scan</b><span>${ap.settings.daily_scan ? '6 AM · last ' + last('daily_scan') : 'off'}</span></div>
      <div><b>Weekly research</b><span>${ap.settings.weekly_research ? 'Mon 7 AM · last ' + last('weekly_research') : 'off'}</span></div>
      <div><b>Scout</b><span>${ap.settings.scout ? 'Sun 8 AM · last ' + last('scout') : 'off'} · <a href="#/apps">finds</a></span></div>
    </div>
    ${ap.notes?.length ? `<details style="margin-top:10px"><summary class="small">What autopilot did lately</summary><div class="log" style="margin-top:6px">${ap.notes.slice(0, 10).map((n) => `<div><span class="muted tiny">${ago(n.t)}</span> ${esc(n.text)}</div>`).join('')}</div></details>` : ''}
  </section>`;
}
function poster(c) {
  const s = c.stats;
  return `<a class="poster ${isDark(c) ? 'dark' : ''}" href="#/c/${c.id}" style="--c:${c.color};--ca:${c.accent};--ci:${c.ink}">
    <span class="lang">${esc(c.language)} · ${esc(c.kind)}</span>
    <span class="native" lang="${LANG[c.language]}">${esc(c.native_name)}</span>
    ${c.native_name !== c.name ? `<span class="en">${esc(c.name)}</span>` : ''}
    <span class="line">${esc(c.tagline)}</span>
    <div class="stats">
      ${s ? `<div><b>${fmtN(s.subscribers)}</b><span>subscribers</span></div><div><b>${fmtN(s.views)}</b><span>views</span></div>`
        : `<div><b>—</b><span>add YouTube key for stats</span></div>`}
      <div><b>${c.active}</b><span>in progress</span></div>
      <div><b>${c.finished}</b><span>finished here</span></div>
      <span class="open">Open channel</span>
    </div></a>`;
}
function listItem(w, line) {
  const c = S.ov.channels.find((x) => x.id === w.channel) || {};
  return `<a class="list-item" href="#/p/${w.id}"><span class="chip" style="background:${isDark(c) ? c.accent : c.color}"></span>
    <div class="grow"><b lang="${LANG[c.language]}">${esc(w.title || 'New ' + (c.pipeline === 'documentary' ? 'episode' : 'song'))}</b>
    <span class="muted small">${esc(c.short_name)} · ${esc(line)}</span></div><span class="tag ${w.error ? 'bad' : w.busy ? 'now' : 'wait'}">${w.pct}%</span></a>`;
}

// ---------------- CHANNEL ----------------
async function pageChannel(id) {
  const d = S.ch = await api('GET', `/api/channels/${id}`);
  const c = d.channel;
  theme(c);
  const lang = LANG[c.language];
  const tabs = [['projects', c.pipeline === 'documentary' ? 'Episodes' : 'Songs', d.projects.length], ['team', 'Agent team'], ['research', 'Niche research'], ['memory', 'Memory'], ['brand', 'Brand kit']];
  $('#main').innerHTML = `
    <section class="ch-hero ${isDark(c) ? 'dark' : ''}">
      <div class="native" lang="${lang}">${esc(c.native_name)}</div>
      <div class="sub">${esc(c.name)} · ${esc(c.language)} · ${esc(c.kind)}</div>
      <p class="about">${esc(c.about)}</p>
      <div class="meta">
        <div><b>Who watches</b>${esc(c.audience)}</div>
        <div><b>Length</b>${esc(c.runtime)}</div>
        <div><b>Subscribers</b>${d.stats ? fmtN(d.stats.subscribers) : '—'}</div>
        <div><b>Views</b>${d.stats ? fmtN(d.stats.views) : '—'}</div>
      </div>
      ${c.cast?.length ? `<div class="cast">${c.cast.map((x) => `<span title="${esc(x.look)}">${esc(x.name)}</span>`).join('')}</div>` : ''}
      <div class="start">
        <input id="focus" placeholder="${c.pipeline === 'documentary' ? 'Optional: a direction, e.g. “Einstein” or “a sports legend”' : 'Optional: a direction, e.g. “Diwali song” or “an elephant song”'}">
        <button class="btn go" data-act="research" data-mode="llm">Find the next ${c.pipeline === 'documentary' ? 'episode' : 'song'}</button>
        <button class="btn" data-act="research" data-mode="claude" title="Claude Code does the research (uses vidIQ and web search)">Ask Claude Code instead</button>
      </div>
    </section>
    <div class="tabs" role="tablist">${tabs.map(([k, l, n]) => `<button role="tab" class="${S.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${l}${n != null ? `<span class="n">${n}</span>` : ''}</button>`).join('')}</div>
    <div id="tab"></div>`;
  renderTab();
}
function renderTab() {
  const d = S.ch, c = d.channel, el = $('#tab');
  history.replaceState(null, '', `#/c/${c.id}${S.tab === 'projects' ? '' : '/' + S.tab}`);
  if (S.tab === 'projects') {
    el.innerHTML = d.projects.length ? d.projects.map((p) => `
      <a class="proj" href="#/p/${p.id}">
        <div><h3 lang="${LANG[c.language]}">${esc(p.title || 'New ' + (c.pipeline === 'documentary' ? 'episode' : 'song') + ' — research')}</h3>
        <span class="muted small">${esc(p.title_en && p.title_en !== p.title ? p.title_en + ' · ' : '')}updated ${ago(p.updated)}</span></div>
        <div class="row">${p.error ? '<span class="tag bad">Needs a look</span>' : p.busy ? `<span class="tag now">${esc(p.busy.msg)}</span>` : p.waiting ? `<span class="tag wait">Waiting: ${esc(p.waiting)}</span>` : p.current === 'finished' ? '<span class="tag done">Finished</span>' : ''}<b>${p.pct}%</b></div>
        <div class="reel-mini">${reel(p.stages, null, true)}</div>
      </a>`).join('')
      : `<div class="empty"><h3>No ${c.pipeline === 'documentary' ? 'episodes' : 'songs'} yet</h3><p>Press “Find the next ${c.pipeline === 'documentary' ? 'episode' : 'song'}”. The research agent brings 4 ideas; you pick one and the team builds it step by step.</p></div>`;
  } else if (S.tab === 'team') {
    el.innerHTML = `<p class="muted" style="margin-bottom:14px">Every ${c.pipeline === 'documentary' ? 'episode' : 'song'} passes through these agents in this order. Each one stops for you where your eye or ear matters.</p>
      <div class="agents-seq">${d.agents.map((a, i) => `
      <div class="agent-row"><div class="avatar">${i + 1}</div>
        <div><h4>${esc(a.name)}</h4><p class="small">${esc(a.job)}</p><div class="tools">${a.tools.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></div>
        <span class="mode ${a.mode}">${{ llm: 'Writes — free AI or Claude', auto: 'Automatic on your PC', browser: 'Your browser / Claude Code' }[a.mode]}</span></div>`).join('')}</div>`;
  } else if (S.tab === 'memory') {
    const m = d.memory;
    el.innerHTML = `<div class="note" style="margin-bottom:16px">Agents read Rules and Lessons before every job. Decisions fill in by themselves when you press buttons. Your edits here are saved straight to <span class="mono">memory/${c.id}/</span>.</div>
      <div class="row" style="margin-bottom:16px"><input id="lesson" class="grow" placeholder="Add a lesson, e.g. “Classroom backgrounds get blocked — use a simple room”"><button class="btn primary" data-act="lesson">Add lesson</button></div>
      <div class="three mem">${[['rules', 'Rules'], ['lessons', 'Lessons learned'], ['decisions', 'Your decisions']].map(([k, l]) => `
        <div class="stack"><h3>${l}</h3><textarea id="mem-${k}">${esc(m[k])}</textarea><button class="btn sm" data-act="mem-save" data-file="${k}">Save ${l.toLowerCase()}</button></div>`).join('')}</div>`;
  } else if (S.tab === 'research') {
    const n = d.niche;
    el.innerHTML = `<div class="panel"><div class="panel-h"><div><h3>What's pulling views in this niche</h3><p class="muted small">${n ? `Last scan ${ago(n.scanned)} · keywords: ${esc(n.keywords.join(', '))}` : 'No scan yet.'} A scan costs about ${(c.research?.keywords?.length || 4) * 100 + 5} of your 10,000 free daily YouTube units.</p></div>
      <div class="row"><button class="btn" data-act="stats">Refresh channel stats</button><button class="btn primary" data-act="scan">Scan YouTube now</button></div></div>
      ${n?.videos?.length ? `<div style="overflow:auto"><table><thead><tr><th>Video</th><th>Channel</th><th>Views/day</th><th>Views</th><th>× subs</th><th>Published</th></tr></thead><tbody>
      ${n.videos.map((v) => `<tr><td><a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.title)}</a></td><td>${esc(v.channel)}</td><td><b>${fmtN(v.views_per_day)}</b></td><td>${fmtN(v.views)}</td><td>${v.outlier ?? '—'}</td><td class="muted">${esc(v.published)}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty"><p>Add your YouTube API key in <a href="#/settings">Settings</a>, then scan. The research agent uses these numbers as evidence for its 4 ideas.</p></div>`}
      <p class="small muted" style="margin-top:12px">Research brief: ${esc(c.research?.brief || '')}</p></div>`;
  } else if (S.tab === 'brand') {
    const has = (f) => d.brand.includes(f);
    const slot = (f, label, kind) => `<div class="brand-slot"><h4>${label}</h4><div class="prev">${has(f) ? (kind === 'video' ? `<video src="/brand/${c.id}/${f}?v=${Date.now() % 1e6}" controls preload="metadata"></video>` : `<img src="/brand/${c.id}/${f}?v=${Date.now() % 1e6}" alt="">`) : 'Not added'}</div>
      <label class="btn sm">${has(f) ? 'Replace' : 'Add'} file<input type="file" hidden data-brand="${f}" accept="${kind === 'video' ? 'video/mp4' : 'image/png'}"></label></div>`;
    el.innerHTML = `<p class="muted" style="margin-bottom:14px">The Editor uses these on every video of this channel. Files live in <span class="mono">brand/${c.id}/</span>.</p>
      <div class="brand-slots">${slot('intro.mp4', 'Intro (4–6 s)', 'video')}${slot('outro.mp4', 'Outro', 'video')}${slot('logo.png', 'Logo (transparent PNG)', 'img')}${slot('subscribe.png', 'Subscribe pop-up (PNG)', 'img')}</div>
      <div class="panel" style="margin-top:18px"><h3>Character and place sheets</h3><p class="muted small" style="margin:6px 0 12px">Lock how everyone looks. The Visual director names them in every prompt; Claude Code uploads them to Flow as references.</p>
      <div class="row">${(d.brand.includes('characters') ? '<span class="tag done">characters/ folder exists</span>' : '<span class="tag">No sheets yet</span>')}
      <label class="btn sm">Add a sheet<input type="file" hidden data-brand="char" accept="image/*"></label></div></div>
      ${c.notes ? `<div class="note warn" style="margin-top:16px">${esc(c.notes)}</div>` : ''}`;
  }
}

// ---------------- reel ----------------
function reel(stages, sel, mini) {
  return `<div class="reel ${mini ? 'mini' : ''}">${stages.map((s, i) => {
    const tag = mini ? 'span' : 'button';
    return `<${tag} class="st ${s.status} ${sel === s.key ? 'sel' : ''}" ${mini ? '' : `data-act="stage" data-stage="${s.key}"`} title="${esc(s.label)} — ${esc(s.agent)}">
      <span class="dot">${s.status === 'done' ? '✓' : i + 1}</span><span class="lbl">${esc(s.label)}</span></${tag}>`;
  }).join('')}</div>`;
}

// ---------------- PROJECT ----------------
async function pageProject(id, fresh) {
  const d = S.pj = await api('GET', `/api/projects/${id}`);
  const p = d.project, c = d.channel;
  theme(c);
  S.lastUpdated = p.updated;
  const pr = p.progress;
  if (!S.stage || !pr.stages.find((s) => s.key === S.stage)) S.stage = pr.current === 'finished' ? 'publish' : pr.current;
  const ag = d.agents.find((a) => a.stage === S.stage);
  const queued = d.queue.find((t) => t.stage === S.stage);
  $('#main').innerHTML = `
    <div class="p-head">
      <div><a class="crumb" href="#/c/${c.id}"><i></i>${esc(c.name)}</a>
      <h1 class="p-title" lang="${LANG[c.language]}">${esc(p.title || 'New ' + (p.pipeline === 'documentary' ? 'episode' : 'song'))}</h1>
      ${p.idea?.title_en && p.idea.title_en !== p.title ? `<p class="muted">${esc(p.idea.title_en)}</p>` : ''}</div>
      <div class="row"><span class="tag ${pr.current === 'finished' ? 'done' : ''}">${pr.pct}% done</span>
      <label class="check small" title="When on, agents start this ${p.pipeline === 'documentary' ? 'episode' : 'song'}'s next job by themselves"><input type="checkbox" data-autopilot ${p.autopilot === false ? '' : 'checked'}> Autopilot</label>
      <label class="check small" title="The brain approves each step after its quality checks"><input type="checkbox" data-fullauto ${p.full_auto ? 'checked' : ''}> Topic only</label>
      <button class="btn ghost sm danger" data-act="delete">Delete</button></div>
    </div>
    <div style="margin-top:18px">${reel(pr.stages, S.stage)}</div>
    <div class="p-grid">
      <div>
        ${livePanel(p)}
        ${Object.keys(p.waiting_manual || {}).length ? `<div class="note" style="margin-bottom:16px"><b>Waiting for you to add:</b> ${Object.keys(p.waiting_manual).map((k) => k === 'music' ? 'the Suno song (Music step)' : k).join(', ')}.</div>` : ''}
        ${queued ? `<div class="note" style="margin-bottom:16px">Sent to Claude Code ${ago(queued.created)}. In Claude Code (opened in the Studio folder) say <b>“do the open requests”</b>. This page updates when it's done. <a href="#/requests">See request</a></div>` : ''}
        ${ag ? `<div class="agent-strip"><div class="avatar">${esc(initials(ag.name))}</div><div class="grow"><b>${esc(ag.name)}</b><span class="small muted">${esc(ag.job)}</span></div><span class="mode ${ag.mode}">${{ llm: 'Writes', auto: 'Automatic', browser: 'Browser job' }[ag.mode]}</span></div>` : ''}
        <section class="panel" id="stage">${STAGES[S.stage] ? STAGES[S.stage](p, d) : ''}</section>
      </div>
      <aside class="panel"><h3>Activity</h3><div class="log" style="margin-top:10px">${(p.log || []).slice(0, 60).map((l) => `<div><b>${esc(l.who)}</b> <span class="muted tiny">${ago(l.t)}</span><br>${esc(l.text)}</div>`).join('') || '<p class="muted">Nothing yet.</p>'}</div></aside>
    </div>`;
  history.replaceState(null, '', `#/p/${p.id}/${S.stage}`);
  bindCounters();
}
const reload = () => pageProject(S.pj.project.id);

// ---------------- live "Working now" panel: see the agents work, stop, retry, restart, talk ----------------
function since(t) { const s = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; }
function livePanel(p) {
  const reel = p.pipeline === 'reel';
  const lines = p.busy?.lines || p.error?.lines || p.last_run?.lines || [];
  let state, cls;
  if (p.busy) { state = `<span class="spinner"></span> Working: ${esc(p.busy.msg)} <span class="muted small">· ${since(p.busy.started)}</span>`; cls = 'live-on'; }
  else if (p.hold) { state = `⏸ Needs you: ${esc(p.hold)}`; cls = 'live-warn'; }
  else if (p.error) { state = p.error.stopped ? '⏹ Stopped by you' : `⚠ Failed at ${esc(p.error.stage)}: ${esc(p.error.message)}`; cls = p.error.stopped ? 'live-warn' : 'live-bad'; }
  else if (reel && p.publish?.titles?.length) { state = '✔ Finished — ready to upload'; cls = 'live-ok'; }
  else { state = p.autopilot === false ? '⏸ Paused (autopilot off for this project)' : 'Waiting for the next job (the agents check every few minutes)'; cls = ''; }
  const chat = (p.chat || []).slice(-8);
  const steps = ['script', 'voice', 'visuals', 'edit', 'publish'];
  return `<section class="panel live ${cls}" style="margin-bottom:16px">
    <div class="panel-h"><div><h3 style="margin:0">Working now</h3><div class="small" style="margin-top:6px">${state}</div></div>
      <div class="row">
        ${p.busy ? '<button class="btn sm danger" data-act="live-stop">Stop</button>' : `<button class="btn sm go" data-act="live-retry">${p.error || p.hold ? 'Retry' : 'Start / continue'}</button>`}
        ${reel && !p.busy ? `<select id="live-from" class="sm">${steps.map((x) => `<option value="${x}">${x}</option>`).join('')}</select><button class="btn sm" data-act="live-restart">Restart from</button>` : ''}
      </div></div>
    ${lines.length ? `<div class="live-log">${lines.slice(-12).map((l) => `<div><span class="muted tiny">${new Date(l.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span> ${esc(l.msg)}</div>`).join('')}</div>` : ''}
    <div class="live-chat">${chat.map((m) => `<div class="msg ${m.who === 'Anand' ? 'me' : ''}"><b>${esc(m.who === 'Anand' ? 'You' : 'Studio')}</b> ${esc(m.text)}</div>`).join('')}${p.chat_pending ? '<div class="msg"><b>Studio</b> <span class="spinner"></span> thinking…</div>' : ''}</div>
    <div class="row" style="margin-top:8px"><input id="live-say" class="grow" placeholder="Tell the agents, e.g. “the voice is too fast” or “make the hook about Eric Stoltz”"><button class="btn sm primary" data-act="live-tell">Send</button></div>
  </section>`;
}

function writeButtons(stage, label, note) {
  return `<div class="row">
    <button class="btn go" data-act="run" data-stage="${stage}" data-mode="llm" ${note ? 'data-note-from="note-' + stage + '"' : ''}>${label} with free AI</button>
    <button class="btn" data-act="run" data-stage="${stage}" data-mode="claude" ${note ? 'data-note-from="note-' + stage + '"' : (stage === 'images' || stage === 'videos') ? 'data-note="write the prompts"' : ''}>${stage === 'images' || stage === 'videos' ? 'Claude writes prompts' : 'Send to Claude Code'}</button></div>`;
}
function rewriteBox(stage, what) {
  return `<details style="margin-top:16px"><summary>Not right? Rewrite ${what} with a note</summary>
    <div class="stack" style="margin-top:10px"><textarea id="note-${stage}" placeholder="What should change? e.g. “shorter verses, add the elephant in the chorus”"></textarea>${writeButtons(stage, 'Rewrite')}</div></details>`;
}
// ReelBite: everything after the script is automatic — one button, and where the files are.
function reelAuto(p) {
  const done = !!p.publish?.titles?.length;
  const dir = `data\\projects\\${p.id}`;
  return `<div class="panel-h"><div><h2>Make the Short</h2><p class="muted small">Automatic: Wikipedia source → fact-check → narration (Voicebox) → photos, b-roll and cinema graphics → edit (captions, music, sound effects, subscribe end) → upload sheet. About 15–25 minutes.</p></div>${done ? '<span class="tag done">Ready to upload</span>' : p.hold ? '<span class="tag wait">Needs you</span>' : ''}</div>
    ${p.hold ? `<p class="small" style="color:#b3261e">${esc(p.hold)}</p>` : ''}
    ${p.busy ? `<p class="small">Working: ${esc(p.busy.msg || p.busy.stage || '')}</p>` : `<div class="row" style="margin:16px 0"><button class="btn go" data-act="reel-auto">${done ? 'Make it again' : 'Make the Short now'}</button></div>`}
    ${done ? `<p class="small">Files on this PC: <b>${esc(dir)}</b> — final.mp4 (upload this), upload.txt (title, description, tags, playlist), captions_en.srt, cover.jpg.</p>` : ''}`;
}
function copyBox(label, text, id) {
  return `<div><h4 style="margin-bottom:6px">${label}</h4><div class="copybox"><pre id="${id}">${esc(text)}</pre><button class="btn sm" data-act="copy" data-from="${id}">Copy</button></div></div>`;
}
function gate(html) { return `<div class="gates">${html}</div>`; }

const STAGES = {
  research(p, d) {
    const ideas = p.ideas || [];
    if (!ideas.length) return `<div class="empty"><h3>No ideas yet</h3><p>${p.busy ? 'The research agent is working on it.' : 'Run the research agent to get 4 ideas.'}</p>
      ${p.busy ? '' : `<div style="margin-top:14px;display:flex;justify-content:center">${writeButtons('research', 'Research')}</div>`}</div>`;
    const lang = LANG[d.channel.language];
    return `<div class="panel-h"><div><h2>Pick one of 4 ideas</h2><p class="muted small">Each idea comes with the reason it can go viral and the evidence behind it.</p></div></div>
      <div class="ideas">${ideas.map((x, i) => `
        <div class="idea ${p.idea && (p.idea.title_en === x.title_en) ? 'picked' : ''}">
          <span class="num">Idea ${i + 1}${x.type ? ` · ${esc(x.type)}` : ''}</span>
          <h3 lang="${lang}">${esc(x.title_native || x.title_en)}</h3>
          ${x.title_native ? `<span class="muted small">${esc(x.title_en)}</span>` : ''}
          <p class="why">${esc(x.why_it_can_go_viral)}</p>
          ${x.evidence ? `<p class="ev">${esc(x.evidence)}</p>` : ''}
          ${x.hook ? `<p class="small"><b>Hook:</b> ${esc(x.hook)}</p>` : ''}
          <div class="foot"><span class="muted tiny">${esc(x.playlist || '')}${x.characters ? ' · ' + esc(x.characters) : ''}</span>
          ${p.idea && p.idea.title_en === x.title_en ? '<span class="tag done">Picked</span>' : `<span class="row"><button class="btn ghost sm" data-act="pick-idea" data-i="${i}" data-full="0" title="You approve each step">Step by step</button><button class="btn primary sm" data-act="pick-idea" data-i="${i}" data-full="1" title="The brain makes the whole video and checks its own work">Make this one</button></span>`}</div>
        </div>`).join('')}</div>
      <details style="margin-top:18px"><summary>None of these? Ask again or write your own</summary>
        <div class="two" style="margin-top:12px">
          <div class="stack"><textarea id="note-research" placeholder="Steer the research, e.g. “Ganesha festival song for toddlers”"></textarea>${writeButtons('research', 'Research again', true)}</div>
          <div class="stack"><input id="own-en" placeholder="Your idea in English"><input id="own-native" placeholder="Title in ${esc(d.channel.language)} (optional)" lang="${lang}"><textarea id="own-why" placeholder="What is it about?"></textarea><button class="btn" data-act="own-idea">Use my idea</button></div>
        </div></details>
      ${p.idea ? gate(`<button class="btn go" data-act="stage" data-stage="${p.pipeline === 'documentary' ? 'script' : 'song'}">Next: ${p.pipeline === 'documentary' ? 'script' : 'song'}</button>`) : ''}`;
  },

  song(p, d) {
    if (!p.idea) return `<div class="empty"><h3>Pick an idea first</h3></div>`;
    const s = p.song;
    if (!s?.lyrics) return `<div class="empty"><h3>Write the song for “${esc(p.idea.title_en)}”</h3><p>Lyrics with section tags, the Suno style and the title.</p><div style="margin-top:14px;display:flex;justify-content:center">${p.busy ? '' : writeButtons('song', 'Write')}</div></div>`;
    const lang = LANG[d.channel.language];
    return `<div class="panel-h"><div><h2>Song package</h2><p class="muted small">Change anything — your version is what goes to Suno.</p></div>${s.approved ? '<span class="tag done">Approved</span>' : '<span class="tag wait">Waiting for your OK</span>'}</div>
      <div class="two"><label class="f">Title (${esc(d.channel.language)})<input id="s-title_native" value="${esc(s.title_native)}" lang="${lang}"></label><label class="f">Title (English)<input id="s-title_en" value="${esc(s.title_en)}"></label></div>
      <label class="f" style="margin-top:12px">Suno style <span class="counter" data-count="s-style" data-max="200"></span><textarea id="s-style" style="min-height:70px">${esc(s.style)}</textarea></label>
      <label class="f" style="margin-top:12px">Lyrics<textarea id="s-lyrics" class="lyrics" lang="${lang}">${esc(s.lyrics)}</textarea></label>
      ${s.retention_notes ? `<div class="note" style="margin-top:12px"><b>Retention notes:</b> ${esc(s.retention_notes)}</div>` : ''}
      ${rewriteBox('song', 'the song')}
      ${gate(`<button class="btn" data-act="save-song">Save changes</button>${s.approved ? `<button class="btn" data-act="reopen" data-stage="song">Unlock</button><button class="btn go" data-act="stage" data-stage="music">Next: music</button>` : `<button class="btn ok" data-act="approve-song">Approve song</button>`}`)}`;
  },

  script(p) {
    if (!p.idea) return `<div class="empty"><h3>Pick an idea first</h3></div>`;
    const s = p.script;
    if (!s?.text) return `<div class="empty"><h3>Write the narration for “${esc(p.idea.title_en)}”</h3><p>In The Decoder voice, with section tags.</p><div style="margin-top:14px;display:flex;justify-content:center">${p.busy ? '' : writeButtons('script', 'Write')}</div></div>`;
    const words = s.text.split(/\s+/).length;
    return `<div class="panel-h"><div><h2>Narration script</h2><p class="muted small">${words} words ≈ ${Math.round(words / 150)} min at a calm pace. Check every fact marked (verify).</p></div>${s.approved ? '<span class="tag done">Approved</span>' : '<span class="tag wait">Waiting for your OK</span>'}</div>
      <label class="f">Title<input id="sc-title" value="${esc(s.title)}"></label>
      <label class="f" style="margin-top:12px">Hook (first 30 seconds)<textarea id="sc-hook" style="min-height:70px">${esc(s.hook)}</textarea></label>
      <label class="f" style="margin-top:12px">Script<textarea id="sc-text" class="lyrics">${esc(s.text)}</textarea></label>
      ${rewriteBox('script', 'the script')}
      ${gate(`<button class="btn" data-act="save-script">Save changes</button>${s.approved ? `<button class="btn" data-act="reopen" data-stage="script">Unlock</button><button class="btn go" data-act="stage" data-stage="voice">Next: narration</button>` : `<button class="btn ok" data-act="approve-script">Approve script</button>`}`)}`;
  },

  music(p, d) {
    if (!p.song?.approved) return `<div class="empty"><h3>Approve the song first</h3></div>`;
    return `<div class="panel-h"><div><h2>Make the music</h2><p class="muted small">Suno gives two versions. Bring both here — the analyst measures them.</p></div></div>
      <div class="stack">
        ${copyBox('Title', p.song.title_native || p.song.title_en, 'cb-title')}
        ${copyBox('Style box', p.song.style, 'cb-style')}
        ${copyBox('Lyrics box', p.song.lyrics, 'cb-lyrics')}
      </div>
      <div class="row" style="margin:16px 0"><a class="btn" href="https://suno.com/create" target="_blank" rel="noopener">Open Suno</a>
        <button class="btn primary" data-act="run" data-stage="music" data-mode="claude">Send to Claude Code (makes it on Suno)</button>
        <a class="btn ghost" href="#/apps">Free music app (ACE-Step)</a></div>
      <div class="two">${dropZone('audio', 'A', 'Version A')}${dropZone('audio', 'B', 'Version B')}</div>
      ${audioList(p)}
      ${(p.audio || []).length ? gate(`<button class="btn go" data-act="stage" data-stage="pick">Next: pick a version</button>`) : ''}`;
  },

  voice(p) {
    if (p.pipeline === 'reel') return reelAuto(p);
    if (!p.script?.approved) return `<div class="empty"><h3>Approve the script first</h3></div>`;
    return `<div class="panel-h"><div><h2>Narration</h2><p class="muted small">Record it yourself, use a free voice app (Kokoro via Pinokio), or send it to Claude Code.</p></div></div>
      ${copyBox('Script to read', p.script.text, 'cb-script')}
      <div class="row" style="margin:16px 0"><button class="btn primary" data-act="run" data-stage="voice" data-mode="claude">Send to Claude Code</button><a class="btn ghost" href="#/apps">Free voice apps</a></div>
      ${dropZone('audio', 'narration', 'Narration audio (MP3 or WAV)')}
      ${audioList(p)}
      ${p.picked_audio ? gate(`<button class="btn go" data-act="stage" data-stage="timeline">Next: timeline</button>`) : ''}`;
  },

  pick(p) {
    const a = p.audio || [];
    if (!a.length) return `<div class="empty"><h3>No music yet</h3><p>Add the Suno versions in the Music step.</p></div>`;
    const best = a.filter((x) => x.analysis).sort((x, y) => y.analysis.total - x.analysis.total)[0];
    return `<div class="panel-h"><div><h2>Pick the best version</h2><p class="muted small">The analyst measured length, how fast the song arrives, chorus lift, gaps and the ending. It can't hear the words — listen, your ear wins.</p></div>
      ${a.some((x) => !x.analysis) && !p.busy ? '<button class="btn" data-act="analyze">Measure again</button>' : ''}</div>
      <div class="two">${a.map((x) => {
        const m = x.analysis;
        return `<div class="idea ${p.picked_audio === x.file ? 'picked' : ''}">
          <div class="spread"><h3>Version ${esc(x.label)}</h3>${m ? `<span class="score-cell"><b>${m.total}</b><span class="muted small">/${m.out_of}</span></span>` : '<span class="tag now">Measuring…</span>'}</div>
          <audio controls preload="none" src="${file(p.id, x.file)}"></audio>
          ${m ? `${spark(m.curve)}
          <dl class="kv small"><dt>Length</dt><dd>${fmtT(m.duration)}</dd>
          <dt>Music arrives at</dt><dd>${m.energy_start}s ${m.energy_start <= 5 ? '✓ fast hook' : ''}</dd>
          <dt>Chorus lift</dt><dd>${m.chorus_lift_db} dB</dd>
          <dt>Silent gaps</dt><dd>${m.mid_gaps === 0 ? 'none ✓' : m.mid_gaps}</dd>
          <dt>Ending</dt><dd>${m.clean_end ? 'clean fade ✓' : 'abrupt'}</dd>
          <dt>Loudness</dt><dd>${m.lufs ?? '—'} LUFS</dd></dl>` : ''}
          <div class="foot">${best?.file === x.file ? '<span class="tag done">Analyst’s pick</span>' : '<span></span>'}
          ${p.picked_audio === x.file ? '<span class="tag done">Your pick</span>' : `<button class="btn primary sm" data-act="pick-audio" data-file="${esc(x.file)}" ${m ? '' : 'disabled'}>Use this version</button>`}</div></div>`;
      }).join('')}</div>
      ${p.picked_audio ? gate(`<button class="btn go" data-act="stage" data-stage="timeline">Next: timeline</button>`) : ''}`;
  },

  timeline(p) {
    if (!p.picked_audio) return `<div class="empty"><h3>Pick the ${p.pipeline === 'documentary' ? 'narration' : 'music'} first</h3></div>`;
    const t = p.timeline;
    if (!t?.lines?.length) return `<div class="empty"><h3>No timeline yet</h3><button class="btn go" data-act="tl-auto" style="margin-top:12px">Map the timeline</button></div>`;
    const preview = previewScenes(t);
    return `<div class="panel-h"><div><h2>Timeline</h2><p class="muted small">${t.source === 'estimate' ? 'These times are estimates. Play the audio and correct them, or paste real Suno timestamps — then approve.' : t.source === 'suno' ? 'Times come from Suno word timestamps.' : 'Corrected by you — final.'}</p></div>${t.approved ? '<span class="tag done">Approved</span>' : '<span class="tag wait">Check the times</span>'}</div>
      <audio controls preload="none" src="${file(p.id, p.picked_audio)}" id="tl-audio"></audio>
      <div class="row" style="margin:12px 0"><label class="f" style="width:170px">${p.pipeline === 'documentary' ? 'Speech starts at (s)' : 'Singing starts at (s)'}<input type="number" step="0.1" id="tl-start" value="${t.lines[0]?.start ?? ''}"></label>
        <button class="btn" data-act="tl-auto" style="align-self:flex-end">Re-estimate</button>
        <span class="muted small" style="align-self:flex-end">Tip: play, pause at a line, and the time box shows the player's time when you click it.</span></div>
      <details style="margin-bottom:12px"><summary>Paste real timestamps (Suno aligned words, Whisper, or tools/suno_timeline.js output)</summary>
        <div class="stack" style="margin-top:8px"><textarea id="tl-words" placeholder='[{"word":"ಆನೆ","start_s":6.2,"end_s":6.6}, …]  or  {"lines":[{"start":6.2,"end":11.8,"text":"…"}]}'></textarea><button class="btn sm" data-act="tl-words">Use these timestamps</button></div></details>
      <div style="overflow:auto;max-height:520px"><table><thead><tr><th>#</th><th>Start</th><th>End</th><th>Section</th><th>${p.pipeline === 'documentary' ? 'Narration' : 'Lyric line'}</th></tr></thead><tbody>
      ${t.lines.map((l, i) => `<tr data-line="${i}"><td class="muted">${i + 1}</td><td class="num"><input type="number" step="0.1" data-k="start" value="${l.start}"></td><td class="num"><input type="number" step="0.1" data-k="end" value="${l.end}"></td><td><input data-k="section" value="${esc(l.section)}" style="width:110px"></td><td><input data-k="text" value="${esc(l.text)}"></td></tr>`).join('')}
      </tbody></table></div>
      <p class="small" style="margin-top:12px"><b>${preview.length} scenes</b> of 5–10 s · ${preview.filter((s) => s.clip_len === 10).length} need 10 s clips, ${preview.filter((s) => s.clip_len === 6).length} need 6 s · total ${fmtT(t.duration)}</p>
      ${gate(`<button class="btn" data-act="tl-save">Save corrections</button>${t.approved ? `<button class="btn" data-act="reopen" data-stage="timeline">Unlock</button><button class="btn go" data-act="stage" data-stage="images">Next: images</button>` : `<button class="btn ok" data-act="approve" data-stage="timeline">Approve and make scenes</button>`}`)}`;
  },

  images(p, d) {
    const sc = p.scenes || [];
    if (!sc.length) return `<div class="empty"><h3>Approve the timeline first</h3><p>That cuts the ${p.pipeline === 'documentary' ? 'narration' : 'song'} into scenes.</p></div>`;
    const hasPrompts = sc.some((s) => s.image_prompt);
    const done = sc.filter((s) => s.image).length;
    return `<div class="panel-h"><div><h2>Scene images</h2><p class="muted small">${done} of ${sc.length} made. One 16:9 image per scene, characters from the Brand kit.</p></div>
      <div class="row">${p.busy ? '' : writeButtons('images', hasPrompts ? 'Rewrite prompts' : 'Write prompts')}</div></div>
      ${sceneBar(sc)}
      ${hasPrompts ? `<div class="row" style="margin-bottom:14px">
        <button class="btn go" data-act="make" data-stage="images" ${p.busy ? 'disabled' : ''}>Make images (brain picks the tool)</button>
        <button class="btn" data-act="run" data-stage="images" data-mode="claude" data-note="make the images in Google Flow">Claude Code (Google Flow)</button>
        <button class="btn" data-act="hf-all">Make missing images free (Hugging Face)</button>
        <button class="btn ghost" data-act="save-prompts" data-field="image_prompt">Save prompt edits</button>
        <span class="muted small">${sc.length} scenes = ${sc.length - done} image generations left</span></div>` : ''}
      <div class="scenes">${sc.map((s) => `
        <div class="scene" id="scene-${s.n}">
          <div class="media">${s.image ? `<img src="${file(p.id, s.image)}" alt="Scene ${s.n}" loading="lazy">` : 'No image yet'}<span class="n">${s.n} · ${fmtT(s.start)}–${fmtT(s.end)}</span>${s.setpiece ? '<span class="star">Set-piece</span>' : ''}</div>
          <div class="body">
            <span class="lyric" lang="${LANG[d.channel.language]}">${esc(s.lyric || '(instrumental)')}</span>
            ${s.vision ? `<span class="muted">${esc(s.vision)}</span>` : ''}
            <textarea data-scene="${s.n}" data-field="image_prompt" placeholder="Image prompt">${esc(s.image_prompt || '')}</textarea>
            <div class="row"><label class="btn sm">${s.image ? 'Replace' : 'Add'} image<input type="file" hidden accept="image/*" data-upload="image" data-scene="${s.n}"></label>
            ${s.image_prompt ? `<button class="btn sm ghost" data-act="hf-one" data-scene="${s.n}">Free (HF)</button><button class="btn sm ghost" data-act="copy-text" data-text="${esc(s.image_prompt)}">Copy prompt</button>` : ''}</div>
          </div></div>`).join('')}</div>
      ${done === sc.length ? gate(`<button class="btn go" data-act="stage" data-stage="videos">Next: videos</button>`) : ''}`;
  },

  videos(p, d) {
    const sc = p.scenes || [];
    if (!sc.length) return `<div class="empty"><h3>Approve the timeline first</h3></div>`;
    const hasPrompts = sc.some((s) => s.motion_prompt);
    const done = sc.filter((s) => s.video).length;
    return `<div class="panel-h"><div><h2>Scene videos</h2><p class="muted small">${done} of ${sc.length} clips. Order: Wan 3.0 (automatic, free quota) → Grok → Kling → Hailuo → Dola/Seedance (browser). Never buy credits.</p></div>
      <div class="row">${p.busy ? '' : writeButtons('videos', hasPrompts ? 'Rewrite motion' : 'Write motion prompts')}</div></div>
      ${sceneBar(sc)}
      <div class="row" style="margin-bottom:14px">
        <button class="btn go" data-act="make" data-stage="videos" ${p.busy ? 'disabled' : ''}>Make clips (brain picks the tool)</button>
        <button class="btn" data-act="wan-all" ${p.busy ? 'disabled' : ''}>Wan 3.0 only</button>
        ${hasPrompts ? `<button class="btn primary" data-act="run" data-stage="videos" data-mode="claude">Send to Claude Code (Grok / Kling / Hailuo / Dola)</button>
        <button class="btn ghost" data-act="save-prompts" data-field="motion_prompt">Save prompt edits</button>` : ''}</div>
      ${d.wan_ready ? '' : '<div class="note warn" style="margin-bottom:14px">Wan 3.0 needs your Alibaba Model Studio key — add it in <a href="#/settings">Settings</a>. Turn on “Free Quota Only” in Model Studio so it can never charge you.</div>'}
      <div class="scenes">${sc.map((s) => `
        <div class="scene" id="scene-${s.n}">
          <div class="media">${s.video ? `<video src="${file(p.id, s.video)}" controls preload="metadata" muted></video>` : s.image ? `<img src="${file(p.id, s.image)}" alt="" loading="lazy" style="opacity:.55">` : 'No image'}<span class="n">${s.n} · ${fmtT(s.start)}–${fmtT(s.end)} · ${s.len}s${s.video_source === 'wan3' ? ' · Wan' : ''}</span></div>
          <div class="body">
            <span class="lyric" lang="${LANG[d.channel.language]}">${esc(s.lyric || '(instrumental)')}</span>
            <textarea data-scene="${s.n}" data-field="motion_prompt" placeholder="Motion prompt">${esc(s.motion_prompt || '')}</textarea>
            <div class="row"><label class="btn sm">${s.video ? 'Replace' : 'Add'} clip<input type="file" hidden accept="video/*" data-upload="video" data-scene="${s.n}"></label>
            ${s.image ? `<button class="btn sm ghost" data-act="wan-one" data-scene="${s.n}" ${p.busy ? 'disabled' : ''}>Wan 3.0</button>` : ''}
            ${s.video ? `<label class="check small"><input type="checkbox" data-redo="${s.n}" ${s.redo ? 'checked' : ''}> Redo clip</label>` : ''}
            ${s.image ? `<a class="btn sm ghost" href="${file(p.id, s.image)}" download>Image</a>` : ''}
            ${s.motion_prompt ? `<button class="btn sm ghost" data-act="copy-text" data-text="${esc(s.motion_prompt)}">Copy prompt</button>` : ''}</div>
          </div></div>`).join('')}</div>
      ${gate(done === sc.length ? `<button class="btn go" data-act="stage" data-stage="edit">Next: edit</button>`
        : `<span class="muted small" style="align-self:center">${sc.length - done} scenes have no clip.</span><button class="btn" data-act="approve" data-stage="videos">Continue — use a slow zoom on their images</button>`)}`;
  },

  edit(p, d) {
    if (!(p.scenes || []).length) return `<div class="empty"><h3>Approve the timeline first</h3></div>`;
    const o = { ...(d.channel_full.edit || {}), ...(p.edit?.options || {}) };
    const has = (f) => d.brand.includes(f);
    const missing = (p.scenes || []).filter((s) => !s.video && !s.image).length;
    return `<div class="panel-h"><div><h2>Final edit</h2><p class="muted small">Intro → every scene cut to its exact time → music → logo, lyrics and pop-ups → outro. 1920×1080, 30 fps.</p></div>${p.edit?.approved ? '<span class="tag done">Approved</span>' : p.edit?.file ? '<span class="tag wait">Watch it and approve</span>' : ''}</div>
      ${missing ? `<div class="note warn" style="margin-bottom:14px">${missing} scenes have neither a clip nor an image — they will show a plain colour.</div>` : ''}
      <div class="two">
        <div class="stack">
          <label class="check"><input type="checkbox" id="o-intro" ${o.intro ? 'checked' : ''}> Intro ${has('intro.mp4') ? '' : '<span class="tag">not in Brand kit</span>'}</label>
          <label class="check"><input type="checkbox" id="o-outro" ${o.outro ? 'checked' : ''}> Outro ${has('outro.mp4') ? '' : '<span class="tag">not in Brand kit</span>'}</label>
          <label class="check"><input type="checkbox" id="o-logo" ${o.logo ? 'checked' : ''}> Logo bottom-right ${has('logo.png') ? '' : '<span class="tag">not in Brand kit</span>'}</label>
          <label class="check"><input type="checkbox" id="o-lyrics" ${o.lyrics ? 'checked' : ''}> ${p.pipeline === 'documentary' ? 'Burn subtitles' : 'Lyrics on screen'}</label>
          <label class="check"><input type="checkbox" id="o-subscribe" ${o.subscribe ? 'checked' : ''}> Subscribe pop-ups ${has('subscribe.png') ? '' : '<span class="tag">not in Brand kit</span>'}</label>
          ${p.pipeline === 'kids_song' ? `<p class="small muted">${esc(d.channel_full.edit?.subscribe ? '' : 'Off by default on this kids channel — see the channel rules before turning on.')}</p>` : ''}
        </div>
        <div class="stack">
          <label class="f">Pop-up times (seconds, comma separated)<input id="o-times" value="${esc((o.subscribeTimes || []).join(', '))}"></label>
          <label class="f">Lyrics font<input id="o-font" value="${esc(o.font || '')}"></label>
          <label class="f">Remove watermark area (ffmpeg delogo, blank = off)<input id="o-delogo" value="${esc(o.delogo || '')}" placeholder="x=660:y=362:w=70:h=30"></label>
        </div>
      </div>
      <div class="row" style="margin-top:16px"><button class="btn go" data-act="render" ${p.busy ? 'disabled' : ''}>${p.edit?.file ? 'Make the video again' : 'Make the video'}</button>
      <a class="btn ghost" href="#/c/${d.channel.id}/brand">Brand kit</a></div>
      ${p.edit?.file ? `<div style="margin-top:18px"><video controls preload="metadata" src="${file(p.id, p.edit.file)}"></video>
        <p class="small muted" style="margin-top:8px">${fmtT(p.edit.duration)} · made ${ago(p.edit.made)} · <a href="${file(p.id, p.edit.file)}" download="${esc((p.title_en || p.idea?.title_en || p.id).replace(/[^\w-]+/g, '_'))}.mp4">Download final.mp4</a> · <a href="${file(p.id, 'captions.srt')}" download>captions.srt</a></p></div>
        <details style="margin-top:14px"><summary>Something to change? Send it to Claude Code</summary><div class="stack" style="margin-top:10px"><textarea id="edit-note" placeholder="Use times or scene numbers, e.g. “scene 7 clip morphs at 0:41 — redo it”"></textarea><button class="btn sm" data-act="request" data-stage="edit" data-from="edit-note">Send change request</button></div></details>
        ${gate(p.edit.approved ? `<button class="btn" data-act="reopen" data-stage="edit">Unlock</button><button class="btn go" data-act="stage" data-stage="publish">Next: publish</button>` : `<button class="btn ok" data-act="approve" data-stage="edit">Approve final video</button>`)}` : ''}`;
  },

  publish(p, d) {
    const pb = p.publish || {};
    const kids = p.pipeline === 'kids_song';
    if (!pb.titles?.length) return `<div class="empty"><h3>Write the upload package</h3><p>Titles, description with chapters, tags, thumbnail idea and 3 Shorts.</p><div style="margin-top:14px;display:flex;justify-content:center">${p.busy ? '' : writeButtons('publish', 'Write')}</div></div>`;
    const checks = kids ? ['Made for Kids: Yes', 'Category: Education', 'Language set to ' + d.channel.language, 'No end screen, no comment or subscribe asks', 'Captions: upload captions.srt', 'Correct channel open in YouTube Studio', 'Added to playlist']
      : ['Not made for kids', 'Altered or synthetic content declared if needed', 'Every fact checked', 'Captions: upload captions.srt', 'Added to playlist', 'Thumbnail follows the brand formula'];
    return `<div class="panel-h"><div><h2>Upload package</h2><p class="muted small">Edit anything here. Claude Code can score titles with vidIQ — send a note below.</p></div>${pb.approved ? '<span class="tag done">Ready to upload</span>' : '<span class="tag wait">Check and approve</span>'}</div>
      <label class="f">Titles (one per line, best first)<textarea id="pb-titles" style="min-height:110px">${esc((pb.titles || []).join('\n'))}</textarea></label>
      <label class="f" style="margin-top:12px">Description<textarea id="pb-description" style="min-height:240px">${esc(pb.description)}</textarea></label>
      <div class="two" style="margin-top:12px"><label class="f">Tags (comma separated)<textarea id="pb-tags">${esc((pb.tags || []).join(', '))}</textarea></label><label class="f">Hashtags<textarea id="pb-hashtags">${esc((pb.hashtags || []).join(' '))}</textarea></label></div>
      <div class="three" style="margin-top:12px"><label class="f">Thumbnail idea<textarea id="pb-thumbnail_idea">${esc(pb.thumbnail_idea)}</textarea></label><label class="f">Thumbnail text<textarea id="pb-thumbnail_text">${esc(pb.thumbnail_text)}</textarea></label>
        <div class="stack"><label class="f">Playlist<input id="pb-playlist" value="${esc(pb.playlist)}"></label><label class="f">Publish slot<input id="pb-publish_slot" value="${esc(pb.publish_slot)}"></label></div></div>
      <div class="row" style="margin-top:12px"><button class="btn" data-act="save-publish">Save changes</button></div>
      ${rewriteBox('publish', 'the package')}
      <h3 style="margin-top:22px">Thumbnail</h3>
      <div class="two" style="margin-top:10px">
        <div>${pb.thumbnail ? `<img src="${file(p.id, pb.thumbnail)}" alt="Thumbnail" style="width:100%;border-radius:12px">` : '<div class="empty">No thumbnail yet</div>'}</div>
        <div class="stack"><label class="drop">${'<b>Drop your designed thumbnail</b>1280×720 PNG or JPG'}<input type="file" accept="image/*" data-upload="thumbnail"></label>
        ${p.edit?.file ? `<div class="row"><input type="number" id="thumb-t" value="12" style="width:90px"> <button class="btn sm" data-act="thumb-frame">Use the frame at this second</button></div>` : ''}</div>
      </div>
      <h3 style="margin-top:22px">Shorts</h3>
      <table style="margin-top:8px"><thead><tr><th>Title</th><th>Start (s)</th><th>End (s)</th><th></th></tr></thead><tbody>
      ${(pb.shorts || []).map((s, i) => `<tr data-short="${i}"><td><input data-k="title" value="${esc(s.title)}"></td><td class="num"><input type="number" data-k="start" value="${s.start}"></td><td class="num"><input type="number" data-k="end" value="${s.end}"></td><td>${s.file ? `<a href="${file(p.id, s.file)}" download>Download</a>` : ''}</td></tr>`).join('')}
      </tbody></table>
      <div class="row" style="margin-top:10px"><button class="btn sm" data-act="save-publish">Save Shorts times</button><button class="btn sm primary" data-act="shorts" ${p.edit?.file ? '' : 'disabled title="Make the final video first"'}>Cut the Shorts</button></div>
      ${(pb.shorts || []).some((s) => s.file) ? `<div class="three" style="margin-top:12px">${pb.shorts.filter((s) => s.file).map((s) => `<video controls preload="metadata" src="${file(p.id, s.file)}" style="aspect-ratio:9/16;max-height:420px"></video>`).join('')}</div>` : ''}
      <h3 style="margin-top:22px">YouTube Studio checklist</h3>
      <div class="checklist" style="margin-top:10px">${checks.map((c, i) => `<label class="check"><input type="checkbox" data-check="${p.id}-${i}"> ${esc(c)}</label>`).join('')}</div>
      ${gate(`${p.edit?.file ? `<a class="btn" href="${file(p.id, p.edit.file)}" download>Download video</a>` : ''}${pb.approved ? `<button class="btn" data-act="reopen" data-stage="publish">Unlock</button>` : `<button class="btn ok" data-act="approve" data-stage="publish">Mark ready to upload</button>`}`)}`;
  },
};

function dropZone(kind, label, title) {
  return `<label class="drop" data-drop="${kind}" data-label="${label}"><b>${esc(title)}</b>Drop the file here or click to choose<input type="file" accept="audio/*" data-upload="${kind}" data-label="${label}"></label>`;
}
function audioList(p) {
  const a = p.audio || [];
  if (!a.length) return '';
  return `<div class="stack" style="margin-top:16px">${a.map((x) => `<div class="row"><span class="tag ${x.analysis ? 'done' : 'now'}">${esc(x.label)}</span><audio controls preload="none" src="${file(p.id, x.file)}" style="flex:1"></audio><span class="muted small">${x.analysis ? fmtT(x.analysis.duration) : 'measuring…'}</span></div>`).join('')}</div>`;
}
function spark(curve) {
  if (!curve?.length) return '';
  const w = 300, h = 46, min = -60, max = -5;
  const pts = curve.map((v, i) => `${(i / Math.max(1, curve.length - 1)) * w},${h - ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * h}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="Loudness over time"><polyline points="${pts}" fill="none" stroke="var(--c)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}
function sceneBar(sc) {
  return `<div class="scene-bar" title="Scenes: dark = clip done, light = image only, orange = marked for redo">${sc.map((s) => `<a href="javascript:void 0" data-act="jump" data-n="${s.n}" class="${s.redo ? 'redo' : s.video ? 'vid' : s.image ? 'img' : ''}" title="Scene ${s.n}"></a>`).join('')}</div>`;
}
function previewScenes(t) {
  // same rule as the server (5–10 s), used only for the count shown before approval
  const out = []; let cur = 0;
  const total = t.duration || 0;
  while (cur < total - 0.5) { const len = Math.min(10, Math.max(5, Math.min(8, total - cur))); out.push({ clip_len: len > 6.2 ? 10 : 6 }); cur += len; }
  return out;
}
function bindCounters() {
  $$('[data-count]').forEach((el) => {
    const src = $('#' + el.dataset.count); const max = +el.dataset.max;
    const upd = () => { const n = src.value.length; el.textContent = `${n}/${max}`; el.classList.toggle('over', n > max); };
    src.addEventListener('input', upd); upd();
  });
  $$('[data-check]').forEach((el) => { try { el.checked = localStorage.getItem('chk-' + el.dataset.check) === '1'; } catch {} });
}

// ---------------- REQUESTS ----------------
async function pageRequests() {
  theme(null);
  const [{ queue }, ap] = await Promise.all([api('GET', '/api/queue'), api('GET', '/api/autopilot')]);
  const active = queue.filter((t) => ['open', 'running', 'stuck'].includes(t.status)), rest = queue.filter((t) => !['open', 'running', 'stuck'].includes(t.status)).slice(0, 20);
  $('#main').innerHTML = `<h1>Requests for Claude Code</h1>
    <p class="muted" style="margin:8px 0 20px;max-width:72ch">Jobs that need Claude (better writing) or your logged-in browser (Suno, Flow, Grok, Dola). ${ap.settings.claude_auto ? `Autopilot runs Claude Code on them one at a time — up to ${ap.settings.claude_daily_cap} a day (${ap.runs_today} used today).` : 'Autopilot for Claude Code is off: open Claude Code in the Studio folder and say <b>“do the open requests”</b>.'}</p>
    ${ap.running ? `<div class="busy"><span class="spinner"></span>Claude Code is working on ${esc(ap.running.title)} — started ${ago(ap.running.started)}</div>` : ''}
    <div class="panel"><h3>Active (${active.length})</h3><div style="margin-top:12px">${active.length ? active.map(qItem).join('') : '<p class="muted">Nothing waiting for Claude Code.</p>'}</div></div>
    ${ap.runs?.length ? `<div class="panel"><h3>Claude Code runs</h3><table style="margin-top:10px"><thead><tr><th>Started</th><th>Request</th><th>Result</th><th></th></tr></thead><tbody>
      ${ap.runs.slice(0, 15).map((r) => `<tr><td class="muted">${ago(r.started)}</td><td>${esc(r.title)}</td><td>${r.ended ? esc(r.result || '') : '<span class="tag now">running</span>'}</td><td><button class="btn sm ghost" data-act="run-log" data-log="${esc(r.log)}">Log</button></td></tr>`).join('')}</tbody></table><pre id="run-log" class="hide" style="white-space:pre-wrap;font:12px/1.5 var(--mono);background:#F6F7FB;border-radius:10px;padding:12px;max-height:380px;overflow:auto;margin-top:10px"></pre></div>` : ''}
    ${rest.length ? `<div class="panel"><h3>Finished or cancelled</h3><div style="margin-top:12px">${rest.map(qItem).join('')}</div></div>` : ''}`;
}
function qItem(t) {
  const tag = { open: 'now', running: 'now', done: 'done', stuck: 'bad' }[t.status] || '';
  const label = { open: 'waiting', running: 'Claude Code working', stuck: 'blocked' }[t.status] || t.status;
  return `<div class="queue-item"><div class="spread"><div><b>${esc(t.title)}</b><div class="muted small">${esc(t.agent)} · ${t.kind === 'browser' ? 'browser job' : 'writing job'} · ${ago(t.created)}${t.note ? ' · note: ' + esc(t.note) : ''}</div></div>
    <div class="row"><span class="tag ${tag}">${label}</span><a class="btn sm" href="#/p/${t.project}">Open project</a>
    ${t.status === 'stuck' ? `<button class="btn sm" data-act="q-retry" data-id="${t.id}">Try again</button>` : ''}
    ${['open', 'stuck'].includes(t.status) ? `<button class="btn sm ghost" data-act="q-cancel" data-id="${t.id}">Cancel</button>` : ''}</div></div>
    ${t.blocked ? `<div class="note warn" style="margin-top:10px"><b>Blocked:</b> ${esc(t.blocked)}</div>` : ''}
    ${['open', 'stuck'].includes(t.status) ? `<details style="margin-top:10px" data-brief="${t.id}"><summary>Show the full instructions Claude Code will get</summary><pre>Loading…</pre></details>` : ''}</div>`;
}

// ---------------- APPS ----------------
async function pageApps() {
  theme(null);
  const [{ apps, providers }, sc] = await Promise.all([api('GET', '/api/apps'), api('GET', '/api/scout')]);
  const tab = S.appsTab || 'tools';
  const items = (sc.items || []).filter((i) => i.status !== 'dismissed');
  $('#main').innerHTML = `<h1>Free apps &amp; repos</h1>
    <p class="muted" style="margin:8px 0 6px;max-width:72ch">Everything free that plugs into a layer of the work. The Scout looks for new ones every Sunday; nothing gets installed until you choose to try it.</p>
    <div class="tabs">${[['tools', 'Tools in use', apps.length], ['ai', 'Free AI providers', providers?.providers?.length], ['finds', 'Scout finds', items.filter((i) => i.status === 'new').length], ['layers', 'Layer order', null]].map(([k, l, n]) => `<button class="${tab === k ? 'on' : ''}" data-act="apps-tab" data-tab="${k}">${l}${n != null ? `<span class="n">${n}</span>` : ''}</button>`).join('')}</div>
    <div id="apps-body"></div>`;
  const body = $('#apps-body');
  if (tab === 'tools') {
    body.innerHTML = `<div class="grid-apps">${apps.map((a) => `<div class="app">
      <div class="spread"><h3>${esc(a.name)}</h3>${a.health ? `<span class="tag ${a.up ? 'done' : ''}">${a.up ? 'Running' : 'Not running'}</span>` : `<span class="tag ${/not for/.test(a.status) ? 'bad' : ''}">${esc(a.status)}</span>`}</div>
      <span class="small"><b>Layer:</b> ${esc(a.layer)}</span>
      <p class="small">${esc(a.what)}</p>
      <p class="small muted"><b>Needs:</b> ${esc(a.needs)}</p>
      <details><summary>How to set it up</summary><ol>${a.install.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></details>
      <div class="row" style="margin-top:auto">${a.repo ? `<a class="btn sm" href="${esc(a.repo)}" target="_blank" rel="noopener">Repo</a>` : ''}${a.url ? `<a class="btn sm" href="${esc(a.url)}" target="_blank" rel="noopener">Open</a>` : ''}</div>
    </div>`).join('')}</div>`;
  } else if (tab === 'layers') {
    const L = await api('GET', '/api/layers');
    const label = { images: 'Scene images', videos: 'Scene clips', voice: 'Narration', music: 'Songs' };
    body.innerHTML = `<p class="small muted" style="margin-bottom:14px;max-width:72ch">For each stage the brain tries these tools from the top. If one runs out (budget, daily limit, error) it moves to the next. Move tools up or down, or switch them on and off. Saved in <span class="mono">config/layers.json</span>.</p>
      <div class="grid-apps">${Object.entries(L.stages).map(([st, list]) => {
        const order = list.map((t) => t.id);
        const others = L.tools.filter((t) => t.stages.includes(st) && !order.includes(t.id));
        return `<div class="app"><h3>${label[st]}</h3><ol class="layers">${list.map((t, i) => `<li><span class="grow">${esc(t.name)} ${t.ready ? '' : '<span class="tag">not set up</span>'} ${t.auto ? '' : '<span class="tag">hands off</span>'}</span>
          <button class="btn sm ghost" data-act="layer-move" data-stage="${st}" data-order='${JSON.stringify(order)}' data-i="${i}" data-dir="-1" aria-label="Move up">↑</button><button class="btn sm ghost" data-act="layer-move" data-stage="${st}" data-order='${JSON.stringify(order)}' data-i="${i}" data-dir="1" aria-label="Move down">↓</button><button class="btn sm ghost" data-act="layer-toggle" data-stage="${st}" data-order='${JSON.stringify(order)}' data-id="${t.id}">Remove</button></li>`).join('')}</ol>
          ${others.length ? `<div class="row small">Add: ${others.map((t) => `<button class="btn sm" data-act="layer-toggle" data-stage="${st}" data-order='${JSON.stringify(order)}' data-id="${t.id}">${esc(t.name)}</button>`).join('')}</div>` : ''}</div>`;
      }).join('')}</div>`;
  } else if (tab === 'ai') {
    const pv = providers;
    body.innerHTML = `<div class="note" style="margin-bottom:12px"><b>The honest number:</b> ${esc(pv.truth)}</div>
      <div class="note warn" style="margin-bottom:16px"><b>Privacy:</b> ${esc(pv.privacy)}</div>
      <p class="small" style="margin-bottom:12px">${esc(pv.how)} <a href="http://localhost:3001" target="_blank" rel="noopener">Open FreeLLMAPI</a></p>
      <table><thead><tr><th>#</th><th>Provider</th><th>Why</th><th>Free limit</th><th>Signup</th><th></th></tr></thead><tbody>
      ${pv.providers.map((x) => `<tr><td>${x.rank}</td><td><b>${esc(x.name)}</b><br><span class="tag ${x.status === 'already added' ? 'done' : /first/.test(x.status) ? 'wait' : ''}">${esc(x.status)}</span></td><td class="small">${esc(x.why)}</td><td class="small">${esc(x.limits)}</td><td class="small">${esc(x.signup)}</td><td>${x.key_url ? `<a class="btn sm" href="${esc(x.key_url)}" target="_blank" rel="noopener">Get key</a>` : ''}</td></tr>`).join('')}
      </tbody></table>
      <h3 style="margin-top:20px">Skip these</h3>${pv.avoid.map((x) => `<p class="small" style="margin-top:6px"><b>${esc(x.name)}:</b> ${esc(x.why)}</p>`).join('')}
      <p class="muted tiny" style="margin-top:14px">Checked ${esc(pv.checked)}. Free tiers change often — the Scout watches FreeLLMAPI's model list for changes.</p>`;
  } else {
    body.innerHTML = `<div class="spread" style="margin-bottom:14px"><p class="small muted">${sc.lastRun ? `Last look ${ago(sc.lastRun)} — found ${sc.lastFound ?? 0} new.` : 'The Scout has not looked yet.'}${sc.newModels?.length ? ` ${sc.newModels.length} new free models appeared in FreeLLMAPI.` : ''}${sc.models?.length ? ` FreeLLMAPI offers ${sc.models.length} free models right now.` : ''}</p>
      <button class="btn primary" data-act="scout-run">Look now</button></div>
      ${sc.error ? `<div class="note warn" style="margin-bottom:12px">${esc(sc.error)}</div>` : ''}
      ${items.length ? `<div class="grid-apps">${items.slice(0, 60).map((i) => `<div class="app">
        <div class="spread"><h3 style="font-size:17px;word-break:break-word">${esc(i.repo)}</h3><span class="tag ${i.status === 'trying' ? 'now' : i.status === 'adopted' ? 'done' : ''}">${esc(i.status)}</span></div>
        <span class="small"><b>Layer:</b> ${esc(i.layer)} · ${i.stars}★ · ${esc(i.license)} · updated ${esc(i.pushed)}</span>
        <p class="small">${esc(i.use || i.desc)}</p>
        ${i.pc ? `<p class="small muted"><b>On your PC:</b> ${esc(i.pc)}${i.score != null ? ` · usefulness ${i.score}/10` : ''}</p>` : ''}
        <div class="row" style="margin-top:auto"><a class="btn sm" href="${esc(i.url)}" target="_blank" rel="noopener">Repo</a>
        ${i.status === 'new' ? `<button class="btn sm" data-act="scout-set" data-id="${esc(i.id)}" data-status="trying">I'll try it</button>` : ''}
        ${i.status === 'trying' ? `<button class="btn sm ok" data-act="scout-set" data-id="${esc(i.id)}" data-status="adopted">It works — keep</button>` : ''}
        <button class="btn sm ghost" data-act="scout-set" data-id="${esc(i.id)}" data-status="dismissed">Not useful</button></div></div>`).join('')}</div>`
        : '<div class="empty"><h3>No finds yet</h3><p>Press “Look now”. It checks GitHub for active free projects in every layer — music, narration, images, video, editing, timing and free AI.</p></div>'}`;
  }
}

// ---------------- SETTINGS ----------------
async function pageSettings() {
  theme(null);
 const [{ settings: s, setup }, as, acc, br] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/autostart').catch(() => ({})), api('GET', '/api/access').catch(() => ({ urls: [] })), api('GET', '/api/browser').catch(() => null)]);
  const cb = (k, label, help) => `<label class="check" style="align-items:flex-start"><input type="checkbox" id="set-${k}" ${s[k] ? 'checked' : ''}><span>${label}<br><span class="muted tiny">${help}</span></span></label>`;
  // Key boxes are text boxes shown as dots: a real password box lets the browser auto-fill a saved password into it,
  // which then got saved as the key on every "Save".
  const f = (k, label, help, type = 'text') => `<label class="f">${label}<input id="set-${k}" type="text" value="${esc(s[k])}" autocomplete="off" data-lpignore="true" data-1p-ignore spellcheck="false"${type === 'password' ? ' style="-webkit-text-security:disc"' : ''}><span class="muted tiny" style="font-weight:400">${help}</span></label>`;
  $('#main').innerHTML = `<h1>Settings</h1><p class="muted" style="margin:8px 0 20px">Keys stay on this PC in <span class="mono">data/settings.json</span>, which never goes to GitHub.</p>
    <div class="panel"><h3>Open on your phone</h3><div class="stack" style="margin-top:12px">
      <p class="small muted">On this PC: <b class="mono">http://localhost:4600</b>. On your phone (same Wi-Fi as this PC) open the address below and type the PIN once — the phone remembers it for a year.</p>
      ${(acc.urls || []).filter((u) => u.kind === 'wifi').map((u) => `<div class="mono" style="font-size:18px">${esc(u.url)}</div>`).join('') || '<div class="muted small">No Wi-Fi address found.</div>'}
      ${(acc.urls || []).filter((u) => u.kind === 'tailscale').map((u) => `<div><span class="muted tiny">Anywhere (Tailscale):</span> <span class="mono" style="font-size:18px">${esc(u.url)}</span></div>`).join('')}
      ${acc.pin ? `<div>PIN: <b class="mono" style="font-size:22px;letter-spacing:4px">${esc(acc.pin)}</b></div>` : ''}
      ${cb('phone_access', 'Allow phone access (with PIN)', 'Off = only this PC can open the Studio.')}
    </div></div>
    <div class="panel"><h3>Browser agent — Studio Chrome</h3><div class="stack" style="margin-top:12px">
      <p class="small muted">When the free Hugging Face time is used up, the Studio makes pictures in <b>Google Flow</b> / <b>Meta AI</b> and clips in <b>Vibes</b> / <b>Grok</b> by itself, in its own Chrome window. Sign in there <b>once</b> (Google, Meta, X/Grok). It stops and pings you if a site asks for sign-in, a human check or credits.</p>
      ${br ? `<div class="small">${br.chrome ? '🟢 Studio Chrome is open' : '⚪ Studio Chrome is closed (it opens by itself when needed)'}</div>
      <div class="small">${br.sites.map((x) => `${x.enabled ? '✅' : '⛔'} ${esc(x.name)} — today ${x.used_today}${x.daily_cap ? '/' + x.daily_cap : ''}${x.learned ? ' · learned' : ' · learns on first run'}`).join('<br>')}</div>` : '<div class="muted small">Not available.</div>'}
      <div class="row"><button class="btn go sm" data-act="browser-open">Open Studio Chrome to sign in</button></div>
      ${cb('browser_agent', 'Let the browser agent make pictures and clips', 'Free features only. Never buys, never types passwords.')}
    </div></div>
    <div class="panel"><h3>The brain (free)</h3><div class="stack" style="margin-top:12px">
      <p class="small muted">The brain writes research, lyrics, scripts, prompts and upload text, and checks its own work. It uses <b>Gemini on AI Studio's free tier</b> first, then the free models in FreeLLMAPI.</p>
      <div class="note warn small">Create the AI Studio key in a Google project <b>without billing</b> (AI Studio → Get API key → Create API key in new project). A key in a project with billing is charged to your card — the trial credit does not pay for AI Studio.</div>
      ${f('aistudio_api_key', 'AI Studio API key (free tier)', 'aistudio.google.com → Get API key.', 'password')}
      ${f('aistudio_model', 'Brain model', 'gemini-3-flash-preview (what your AI Studio shows).')}
      <label class="f">If the free brain is out for the day<select id="set-brain"><option value="free" ${s.brain !== 'google' ? 'selected' : ''}>Wait / use FreeLLMAPI only (never spend credit)</option><option value="google" ${s.brain === 'google' ? 'selected' : ''}>Also allow Gemini on the Google credit</option></select></label>
    </div></div>
    <div class="panel"><h3>Google credit — narration (and optional extras)</h3><div class="stack" style="margin-top:12px">
      <p class="small muted">Your Google Cloud free-trial credit through an <b>Agent Platform API key</b> (Google Cloud console → "Get Agent Platform API key"). Used for Legends narration. Gemini images and Veo clips are available in Layer order but switched off to save credit.</p>
      ${f('google_api_key', 'Agent Platform API key', 'Starts with AQ… Stays on this PC.', 'password')}
      <div class="row"><button class="btn sm" data-act="find-models" ${setup.google ? '' : 'disabled'}>Find models for this key</button><span class="muted tiny">Save the key first.</span></div>
      <div class="two">${f('google_text_model', 'Brain model', 'Gemini text model.')}${f('google_image_model', 'Image model', 'Gemini image model (uses your character sheets).')}</div>
      <div class="two">${f('google_video_model', 'Video model', 'veo-…-lite (cheapest) / -fast / full.')}${f('google_tts_model', 'Voice model', 'For Legends narration.')}</div>
      <div class="three">${f('google_budget_inr', 'Total budget (₹)', 'Stops before this. Your credit is ₹28,664.', 'number')}${f('google_song_cap_inr', 'Per video cap (₹)', 'A 3-min song with Veo Fast ≈ ₹1,600.', 'number')}${f('google_credit_expiry', 'Credit expires', 'YYYY-MM-DD')}</div>
    </div></div>
    <div class="panel"><h3>Autopilot</h3><div class="stack" style="margin-top:12px">
      ${cb('full_auto_default', 'Picking a topic is enough', 'New videos run in "topic only" mode: the brain approves the song, version, timeline, final video and package after its own checks, and stops for you only if a check fails.')}
      ${cb('autopilot', 'Agents start their own jobs', 'Writing, prompts, edit, Shorts and thumbnail start by themselves. Every decision — idea, song, version, timeline, final video, upload — still waits for you.')}
      ${cb('claude_auto', 'Let Claude Code make the Suno song', 'Claude Code makes the song on Suno (2 versions) and the brain picks the better one. Uses your Claude plan for this step only.')}
      ${f('claude_stages', 'Stages Claude Code may do', 'Comma separated. music = the Suno song. images = Google Flow and videos = Vibes → Grok → Dola, only after the free Hugging Face / Wan tools fail.')}
      ${f('ntfy_topic', 'Phone notifications (ntfy topic)', 'Install the free “ntfy” app, subscribe to a long secret name, type the same name here.')}
      <div class="row"><button class="btn sm" data-act="notify-test">Send a test notification</button></div>
      ${f('claude_daily_cap', 'Claude Code runs per day (max)', 'Keeps your Claude plan limits safe. 6 is a good start.', 'number')}
      ${cb('autopilot_wan', 'Make missing clips with Wan 3.0 by itself', 'Only when a Wan key is set. Uses your Model Studio free quota.')}
      ${cb('daily_scan', 'Daily YouTube scan at 6 AM', 'Channel stats + what is trending in each niche. Needs the YouTube key.')}
      ${cb('weekly_research', 'Fresh ideas every Monday at 7 AM', 'Starts research on each channel that has no ideas waiting.')}
      ${cb('scout', 'Scout every Sunday at 8 AM', 'Looks on GitHub for new free tools and new free AI models.')}
      ${f('claude_path', 'Claude Code program', 'Usually just “claude”.')}
      ${as.supported ? `<div class="spread" style="border-top:1px solid var(--line);padding-top:12px"><div><b>Start with Windows</b><br><span class="muted tiny">Starts FreeLLMAPI and the Studio quietly when you log in, and restarts them if they stop.</span></div><button class="btn ${as.on ? '' : 'go'}" data-act="autostart" data-on="${as.on ? '0' : '1'}">${as.on ? 'Turn off' : 'Turn on'}</button></div>` : ''}
    </div></div>
    <div class="panel"><h3>Free AI for the writing agents</h3><div class="stack" style="margin-top:12px">
      ${f('llm_base_url', 'Address', 'FreeLLMAPI runs at http://localhost:3001/v1. Any OpenAI-compatible address works.')}
      ${f('llm_api_key', 'Key', 'The unified key from the FreeLLMAPI dashboard.', 'password')}
      ${f('llm_model', 'Model', '“auto” lets FreeLLMAPI pick the best free model.')}
      <div class="note ${setup.llm ? 'good' : 'warn'}">${setup.llm ? 'Connected.' : 'Not reachable right now. Start FreeLLMAPI, or use “Send to Claude Code” on every writing job.'}</div></div></div>
    <div class="panel"><h3>Kaggle — free GPU clips (Wan 2.2)</h3><div class="stack" style="margin-top:12px">
      <p class="small muted">A free Kaggle account with a verified phone number gets about 30 GPU hours a week. The Studio sends batches of scenes to a private notebook and downloads the clips. It stops by itself when the weekly time is used.</p>
      ${f('kaggle_username', 'Kaggle username', 'Your Kaggle username (top-right on kaggle.com → profile).')}
      ${f('pexels_api_key', 'Pexels API key (free b-roll for ReelBite)', 'Free: pexels.com/api → sign in → Your API key, copy it here. Real movie-theatre, red-carpet and film-set footage between photos.', 'password')}
      ${f('kaggle_key', 'Kaggle API key', 'kaggle.com → Settings → API Tokens → Generate New Token, copy the token here (or the "key" from a legacy kaggle.json).', 'password')}</div></div>
    <div class="panel"><h3>YouTube</h3><div class="stack" style="margin-top:12px">
      ${f('youtube_api_key', 'YouTube Data API key', 'Free from Google Cloud Console → YouTube Data API v3. 10,000 units/day.', 'password')}</div></div>
    <div class="panel"><h3>Wan 3.0 — automatic scene clips</h3><div class="stack" style="margin-top:12px">
      <p class="small muted">Alibaba Cloud Model Studio, Singapore (international) region. New accounts get a free quota. In the console turn on <b>Free Quota Only</b> for the Wan model so it stops instead of billing.</p>
      ${f('wan_api_key', 'API key', 'Model Studio console → API Keys (Singapore region).', 'password')}
      ${f('wan_workspace_id', 'Workspace ID (optional)', 'Only if your console shows a workspace-specific address. Leave blank to use the standard international address.')}
      ${f('wan_model', 'Model', 'wan3.0-video (standard) or wan3.0-video-prime (faster).')}
      ${f('wan_resolution', 'Resolution', '720P (uses less quota) or 1080P.')}</div></div>
    <div class="panel"><h3>Hugging Face (free images and clips)</h3><div class="stack" style="margin-top:12px">
      ${f('hf_token', 'Token', 'Free: huggingface.co → Settings → Access Tokens → “Read” token. Needed for the free FLUX image and Wan/LTX video Spaces (about 5 GPU-minutes a day).', 'password')}
      ${f('hf_image_model', 'Image model', 'Default: black-forest-labs/FLUX.1-schnell')}</div></div>
    <div class="panel"><h3>ffmpeg</h3><div class="stack" style="margin-top:12px">
      <div class="note ${setup.ffmpeg ? 'good' : 'bad'}">${setup.ffmpeg ? esc(setup.ffmpeg_version) : 'ffmpeg was not found. Install it (winget install Gyan.FFmpeg) or put the full path below.'}</div>
      ${f('ffmpeg_path', 'ffmpeg path', 'Usually just “ffmpeg”.')}${f('ffprobe_path', 'ffprobe path', 'Usually just “ffprobe”.')}</div></div>
    <div class="row" style="margin:18px 0"><button class="btn primary" data-act="save-settings">Save settings</button></div>
    <div class="panel"><h3>GitHub</h3><p class="small muted" style="margin:6px 0 12px">${setup.git ? 'This folder is a git repo. “Save to GitHub” commits your memory, configs and project notes and pushes them. Audio, video, images and keys stay on this PC.' : 'Not linked yet. Follow step 4 in README.md once, then use “Save to GitHub”.'}</p>
      <button class="btn" data-act="sync" ${setup.git ? '' : 'disabled'}>Save to GitHub</button></div>`;
}

// ---------------- actions ----------------
const A = {
  tab: (el) => { S.tab = el.dataset.tab; $$('.tabs button').forEach((b) => b.classList.toggle('on', b === el)); renderTab(); },
  stage: (el) => { S.stage = el.dataset.stage; reload(); },
  async research(el) {
    const r = await act(() => api('POST', `/api/channels/${S.ch.channel.id}/research`, { focus: $('#focus').value, mode: el.dataset.mode }));
    if (r) location.hash = `#/p/${r.id}/research`;
  },
  async 'live-stop'() { if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/stop`, {}), 'Stopping — it ends at its next step.')) reload(); },
  async 'live-retry'() { if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/retry`, {}), 'Started again.')) reload(); },
  async 'live-restart'() {
    const from = $('#live-from').value;
    if (!confirm(`Start again from "${from}"? Everything after it is made again.`)) return;
    const note = prompt('Anything to change? (optional, e.g. "shorter hook")') || '';
    if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/restart`, { from, note }), `Restarting from ${from}.`)) reload();
  },
  async 'live-tell'() {
    const el = $('#live-say'); const text = el.value.trim(); if (!text) return;
    el.value = ''; el.blur();
    if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/tell`, { text }))) reload();
  },
  async 'reel-auto'() {
    const id = S.pj.project.id;
    if (await act(() => api('POST', `/api/projects/${id}/reel/auto`, {}), 'Started — the agents make the whole Short now.')) reload();
  },
  async run(el) {
    const note = el.dataset.noteFrom ? ($('#' + el.dataset.noteFrom)?.value || '') : (el.dataset.note || '');
    const r = await act(() => api('POST', `/api/projects/${S.pj.project.id}/run/${el.dataset.stage}`, { mode: el.dataset.mode, note }));
    if (r) { toast(r.queued ? 'Sent to Claude Code.' : 'The agent started.'); reload(); }
  },
  async 'pick-idea'(el) { const full = el.dataset.full !== '0'; if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/pick-idea`, { index: +el.dataset.i, full_auto: full }), full ? 'Picked. The brain will make the whole video and check its own work.' : 'Picked. You approve each step.')) { S.stage = null; reload(); } },
  async 'own-idea'() {
    const custom = { title_en: $('#own-en').value.trim(), title_native: $('#own-native').value.trim(), why_it_can_go_viral: $('#own-why').value.trim(), type: 'your idea' };
    if (!custom.title_en) return toast('Write your idea in English first.', true);
    if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/pick-idea`, { custom }), 'Your idea is set.')) { S.stage = null; reload(); }
  },
  async 'save-song'() { await saveSong(); reload(); },
  async 'approve-song'() { if (await saveSong() && await act(() => api('POST', `/api/projects/${S.pj.project.id}/approve/song`, {}), 'Song approved.')) { S.stage = 'music'; reload(); } },
  async 'save-script'() { await saveScript(); reload(); },
  async 'approve-script'() { if (await saveScript() && await act(() => api('POST', `/api/projects/${S.pj.project.id}/approve/script`, {}), 'Script approved.')) { S.stage = 'voice'; reload(); } },
  async approve(el) { if (el.dataset.stage === 'timeline' && !(await saveTimeline(true))) return; if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/approve/${el.dataset.stage}`, {}), 'Approved.')) { S.stage = null; reload(); } },
  async reopen(el) { if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/reopen/${el.dataset.stage}`, {}), 'Unlocked for changes.')) reload(); },
  async analyze() { if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/analyze`, {}))) reload(); },
  async 'pick-audio'(el) { if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/pick-audio`, { file: el.dataset.file }), 'Version picked. Timeline mapped — check it.')) { S.stage = 'timeline'; reload(); } },
  async 'tl-auto'() { const v = $('#tl-start')?.value; if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/timeline/auto`, { vocalStart: v ?? '' }), 'Timeline estimated.')) reload(); },
  async 'tl-words'() {
    let j; try { j = JSON.parse($('#tl-words').value); } catch { return toast('That is not valid JSON.', true); }
    if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/timeline/words`, j), 'Timestamps used.')) reload();
  },
  async 'tl-save'() { if (await saveTimeline()) reload(); },
  async 'save-prompts'(el) { await savePrompts(el.dataset.field); toast('Prompts saved.'); },
  async 'hf-all'() { await savePrompts('image_prompt'); if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/hf-images`, {}), 'Making images on Hugging Face.')) reload(); },
  async 'hf-one'(el) { await savePrompts('image_prompt'); if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/hf-images`, { scene: el.dataset.scene }), 'Making the image.')) reload(); },
  async 'wan-all'() {
    await savePrompts('motion_prompt');
    const sc = S.pj.project.scenes || [];
    const t = sc.filter((s) => s.image && (!s.video || s.redo));
    if (!t.length) return toast(sc.some((s) => s.image) ? 'Every scene already has a clip. Tick “Redo clip” on the ones to remake.' : 'Make the scene images first.', true);
    const secs = t.reduce((a, s) => a + Math.max(2, Math.min(30, Math.ceil(s.len))), 0);
    if (!confirm(`Wan 3.0 will make ${t.length} clips, about ${secs} seconds of video from your Model Studio quota.\n\nIs “Free Quota Only” switched on in Model Studio? (Otherwise extra seconds are billed.)`)) return;
    if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/wan-videos`, {}), 'Wan 3.0 started. Each clip takes a few minutes.')) reload();
  },
  async 'wan-one'(el) {
    await savePrompts('motion_prompt');
    if (!confirm(`Make scene ${el.dataset.scene} with Wan 3.0? It uses a few seconds of your Model Studio quota.`)) return;
    if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/wan-videos`, { scene: el.dataset.scene }), 'Wan 3.0 started.')) reload();
  },
  async render() {
    const times = $('#o-times').value.split(/[,\s]+/).map(Number).filter((n) => !isNaN(n) && n >= 0 && $('#o-times').value.trim());
    const opts = { intro: $('#o-intro').checked, outro: $('#o-outro').checked, logo: $('#o-logo').checked, lyrics: $('#o-lyrics').checked,
      subscribe: $('#o-subscribe').checked, subscribeTimes: times, font: $('#o-font').value.trim(), delogo: $('#o-delogo').value.trim() };
    await act(() => api('PATCH', `/api/projects/${S.pj.project.id}`, { edit_options: opts }));
    if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/edit`, opts), 'The editor started. This takes a few minutes.')) reload();
  },
  async 'save-publish'() { await savePublish(); toast('Saved.'); reload(); },
  async 'thumb-frame'() { if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/thumbnail-frame`, { t: +$('#thumb-t').value }), 'Frame saved as thumbnail.')) reload(); },
  async shorts() { await savePublish(); if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/shorts`, {}), 'Cutting Shorts.')) reload(); },
  async request(el) { const note = $('#' + el.dataset.from).value; if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/request`, { stage: el.dataset.stage, note }), 'Sent to Claude Code.')) reload(); },
  async 'clear-error'() { await act(() => api('POST', `/api/projects/${S.pj.project.id}/clear-error`, {})); reload(); },
  async delete() { if (!confirm('Delete this project and all its files? This cannot be undone.')) return; if (await act(() => api('DELETE', `/api/projects/${S.pj.project.id}`), 'Deleted.')) location.hash = `#/c/${S.pj.channel.id}`; },
  jump: (el) => $('#scene-' + el.dataset.n)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
  copy: (el) => copyText($('#' + el.dataset.from).textContent),
  'copy-text': (el) => copyText(el.dataset.text),
  async lesson() { const text = $('#lesson').value; if (await act(() => api('POST', `/api/channels/${S.ch.channel.id}/lesson`, { text }), 'Lesson saved. Agents will read it next time.')) pageChannel(S.ch.channel.id); },
  async 'mem-save'(el) { const f = el.dataset.file; await act(() => api('PUT', `/api/channels/${S.ch.channel.id}/memory/${f}`, { text: $('#mem-' + f).value }), 'Saved.'); },
  async scan() { toast('Scanning YouTube…'); if (await act(() => api('POST', `/api/channels/${S.ch.channel.id}/scan`, {}), 'Scan done.')) pageChannel(S.ch.channel.id); },
  async stats() { if (await act(() => api('POST', `/api/channels/${S.ch.channel.id}/stats`, {}), 'Stats refreshed.')) pageChannel(S.ch.channel.id); },
  async 'q-cancel'(el) { if (await act(() => api('POST', `/api/queue/${el.dataset.id}/cancel`, {}), 'Cancelled.')) pageRequests(); },
  async 'browser-open'() { toast('Opening Studio Chrome…'); if (await act(() => api('POST', '/api/browser/open'), 'Studio Chrome is open. Sign in to Google, Meta and Grok there once, then close nothing — the Studio takes it from here.')) pageSettings(); },
  async 'save-settings'() {
    const body = {}; $$('[id^=set-]').forEach((i) => (body[i.id.slice(4)] = i.type === 'checkbox' ? i.checked : i.value));
    if (await act(() => api('PUT', '/api/settings', body), 'Settings saved.')) { pageSettings(); side(); }
  },
  async 'ap-toggle'(el) { if (await act(() => api('PUT', '/api/settings', { autopilot: el.dataset.on === '1' }), el.dataset.on === '1' ? 'Autopilot is on.' : 'Autopilot paused.')) { pageHome(); } },
  async 'ap-now'() { if (await act(() => api('POST', '/api/autopilot/now', {}), 'Checked — agents started any work that was ready.')) pageHome(); },
  async 'q-retry'(el) { if (await act(() => api('POST', `/api/queue/${el.dataset.id}/retry`, {}), 'Back in the queue.')) pageRequests(); },
  async 'run-log'(el) { const r = await act(() => api('GET', '/api/autopilot/runs/' + encodeURIComponent(el.dataset.log))); if (r) { const pre = $('#run-log'); pre.textContent = r.text; pre.classList.remove('hide'); pre.scrollTop = pre.scrollHeight; } },
  'apps-tab': (el) => { S.appsTab = el.dataset.tab; pageApps(); },
  async make(el) { if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/make/${el.dataset.stage}`, {}), 'The brain is on it — it tries each tool in your layer order.')) reload(); },
  async 'layer-move'(el) {
    const st = el.dataset.stage, list = JSON.parse(el.dataset.order), i = +el.dataset.i, j = i + (+el.dataset.dir);
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    if (await act(() => api('PUT', `/api/layers/${st}`, { order: list }))) pageApps();
  },
  async 'layer-toggle'(el) {
    const st = el.dataset.stage, list = JSON.parse(el.dataset.order), id = el.dataset.id;
    const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    if (await act(() => api('PUT', `/api/layers/${st}`, { order: next }))) pageApps();
  },
  async 'find-models'() { toast('Asking Google which models your key can use…'); const r = await act(() => api('POST', '/api/google/find-models', {})); if (r) { toast(Object.keys(r.found).length ? 'Found: ' + Object.values(r.found).join(', ') : 'No models confirmed. ' + (r.notes[0] || ''), !Object.keys(r.found).length); pageSettings(); } },
  async 'notify-test'() { await act(() => api('POST', '/api/notify/test', {}), 'Sent — check your phone.'); },
  async 'scout-run'() { const r = await act(() => api('POST', '/api/scout/run', {})); if (r) toast(r.started ? 'The Scout is looking — about 2 minutes. Come back to this tab.' : r.note); },
  async 'scout-set'(el) { if (await act(() => api('POST', `/api/scout/${encodeURIComponent(el.dataset.id)}/${el.dataset.status}`, {}))) pageApps(); },
  async autostart(el) { toast('Changing auto-start…'); if (await act(() => api('POST', '/api/autostart', { on: el.dataset.on === '1' }), el.dataset.on === '1' ? 'Auto-start is on. The Studio will start by itself when you log in.' : 'Auto-start is off.')) pageSettings(); },
  async sync() { const r = await act(() => api('POST', '/api/git/sync', {})); if (r) toast(r.result, /fail/i.test(r.result)); },
};
async function copyText(t) { try { await navigator.clipboard.writeText(t); toast('Copied.'); } catch { toast('Copy failed — select the text and press Ctrl+C.', true); } }
async function saveSong() {
  const song = { title_native: $('#s-title_native').value, title_en: $('#s-title_en').value, style: $('#s-style').value, lyrics: $('#s-lyrics').value };
  if (song.style.length > 200) { toast('The Suno style box must be 200 characters or fewer.', true); return false; }
  return !!(await act(() => api('PATCH', `/api/projects/${S.pj.project.id}`, { song, title: song.title_native || song.title_en }), 'Saved.'));
}
async function saveScript() {
  const script = { title: $('#sc-title').value, hook: $('#sc-hook').value, text: $('#sc-text').value };
  return !!(await act(() => api('PATCH', `/api/projects/${S.pj.project.id}`, { script, title: script.title }), 'Saved.'));
}
async function saveTimeline(quiet) {
  const lines = $$('tr[data-line]').map((tr) => Object.fromEntries($$('input', tr).map((i) => [i.dataset.k, i.value])));
  if (!lines.length) return true;
  return !!(await act(() => api('PUT', `/api/projects/${S.pj.project.id}/timeline`, { lines }), quiet ? null : 'Timeline saved.'));
}
async function savePrompts(field) {
  const scenes = $$(`textarea[data-field=${field}]`).map((t) => ({ n: +t.dataset.scene, [field]: t.value }));
  if (scenes.length) await act(() => api('PATCH', `/api/projects/${S.pj.project.id}`, { scenes }));
}
async function savePublish() {
  const v = (k) => $('#pb-' + k)?.value ?? '';
  const shorts = $$('tr[data-short]').map((tr) => { const o = Object.fromEntries($$('input', tr).map((i) => [i.dataset.k, i.value])); return { title: o.title, start: +o.start, end: +o.end }; });
  const publish = { titles: v('titles').split('\n').map((s) => s.trim()).filter(Boolean), description: v('description'),
    tags: v('tags').split(',').map((s) => s.trim()).filter(Boolean), hashtags: v('hashtags').split(/\s+/).filter(Boolean),
    thumbnail_idea: v('thumbnail_idea'), thumbnail_text: v('thumbnail_text'), playlist: v('playlist'), publish_slot: v('publish_slot') };
  if (shorts.length) publish.shorts = shorts.map((s, i) => ({ ...(S.pj.project.publish?.shorts?.[i] || {}), ...s }));
  await act(() => api('PATCH', `/api/projects/${S.pj.project.id}`, { publish }));
}

document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'live-say') { e.preventDefault(); A['live-tell'](); } });
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = A[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el); }
});
// timeline: clicking a time box while the player is paused fills in the player's time
document.addEventListener('focusin', (e) => {
  const i = e.target;
  if (i.matches('tr[data-line] input[data-k=start], tr[data-line] input[data-k=end]')) {
    const au = $('#tl-audio');
    if (au && au.currentTime > 0 && au.paused && i.dataset.filled !== String(au.currentTime)) { i.value = au.currentTime.toFixed(1); i.dataset.filled = String(au.currentTime); }
  }
});
document.addEventListener('toggle', async (e) => {
  const d = e.target;
  if (d.matches?.('details[data-brief]') && d.open && $('pre', d).textContent === 'Loading…') {
    try { const b = await api('GET', `/api/queue/${d.dataset.brief}/brief`); $('pre', d).textContent = b.instructions + '\n\n→ ' + b.finish; } catch (err) { $('pre', d).textContent = err.message; }
  }
}, true);
document.addEventListener('change', async (e) => {
  const i = e.target;
  if (i.matches('[data-fullauto]')) { await act(() => api('PATCH', `/api/projects/${S.pj.project.id}`, { full_auto: i.checked }), i.checked ? 'Topic only: the brain approves each step after checking it.' : 'Step by step: you approve each step.'); return; }
  if (i.matches('[data-autopilot]')) { await act(() => api('PATCH', `/api/projects/${S.pj.project.id}`, { autopilot: i.checked }), i.checked ? 'Autopilot on for this one.' : 'Autopilot off for this one.'); return; }
  if (i.matches('[data-redo]')) { await act(() => api('PATCH', `/api/projects/${S.pj.project.id}`, { scenes: [{ n: +i.dataset.redo, redo: i.checked }] })); return; }
  if (i.matches('[data-check]')) { try { localStorage.setItem('chk-' + i.dataset.check, i.checked ? '1' : '0'); } catch {} return; }
  if (i.matches('input[type=file][data-upload]') && i.files[0]) return upload(i.files[0], i.dataset.upload, i.dataset);
  if (i.matches('input[type=file][data-brand]') && i.files[0]) {
    let name = i.dataset.brand;
    if (name === 'char') name = 'char_' + i.files[0].name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_') + '.' + (i.files[0].name.split('.').pop() || 'png').toLowerCase();
    toast('Uploading…');
    if (await act(() => api('POST', `/api/channels/${S.ch.channel.id}/brand?name=${encodeURIComponent(name)}`, i.files[0], true), 'Added to the Brand kit.')) pageChannel(S.ch.channel.id);
  }
});
['dragover', 'dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
  const z = e.target.closest?.('.drop');
  if (!z) return;
  e.preventDefault();
  z.classList.toggle('over', ev === 'dragover');
  if (ev === 'drop' && e.dataTransfer.files[0]) { const inp = $('input', z); upload(e.dataTransfer.files[0], inp.dataset.upload, inp.dataset); }
}));
async function upload(f, kind, ds) {
  const q = new URLSearchParams({ kind, name: f.name });
  if (ds.label) q.set('label', ds.label);
  if (ds.scene) q.set('scene', ds.scene);
  toast(`Uploading ${f.name} (${(f.size / 1e6).toFixed(1)} MB)…`);
  if (await act(() => api('POST', `/api/projects/${S.pj.project.id}/upload?${q}`, f, true), 'Added.')) reload();
}

// ---------------- live refresh ----------------
setInterval(async () => {
  const [page, id] = S.route;
  const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (page === 'p' && S.pj && !typing) {
    try {
      const d = await api('GET', `/api/projects/${id}`);
      if (d.project.updated !== S.lastUpdated && !$$('audio,video').some((m) => !m.paused)) { await pageProject(id); side(); }
    } catch { /* ignore */ }
  } else if (!page && !typing) {
    try { const ov = await api('GET', '/api/overview'); if (JSON.stringify(ov.waiting) + JSON.stringify(ov.busy) + ov.queue.length !== JSON.stringify(S.ov?.waiting) + JSON.stringify(S.ov?.busy) + S.ov?.queue.length) { await pageHome(); side(); } } catch {}
  }
}, 3000);

go();
