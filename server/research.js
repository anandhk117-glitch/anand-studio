// Research agents — niche researcher, trend & opportunity analyst, own-channel analyst.
// Free sources only:
//   • YouTube search through yt-dlp (from the Agent-Reach kit) — costs no API quota
//   • your YouTube API key for exact numbers (videos.list / channels.list = 1 unit per 50)
//   • (later) Vane search for festival dates and fact checks
// The brain (FreeLLMAPI → Gemini → Ollama) turns the numbers into a ranked opportunity list,
// which the idea writer then uses as evidence.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const llm = require('./llm');

const daysSince = (d) => Math.max(1, (Date.now() - new Date(d).getTime()) / 86400000);

// yt-dlp is run as a Python module (python -m yt_dlp): Windows Smart App Control blocks the unsigned yt-dlp.exe,
// but the venv's python.exe is signed and allowed.
function ytdlpCmd() {
  const s = store.getSettings();
  if (s.ytdlp_path) return [s.ytdlp_path, []];
  const dir = path.join(store.P.root, 'tools', 'reach-venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  const py = path.join(dir, process.platform === 'win32' ? 'python.exe' : 'python');
  if (fs.existsSync(py)) return [py, ['-m', 'yt_dlp']];
  return ['yt-dlp', []];
}

// YouTube search without the API: yt-dlp "ytsearchN:query".
function ytdlpSearch(q, n = 20) {
  return new Promise((res) => {
    const out = [];
    let buf = '';
    const [cmd, pre] = ytdlpCmd();
    const pr = spawn(cmd, [...pre, `ytsearch${n}:${q}`, '--flat-playlist', '--dump-json', '--no-warnings', '--quiet'], { windowsHide: true });
    pr.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const j = JSON.parse(line); if (j.id) out.push({ id: j.id, title: j.title, channel: j.channel || j.uploader, channel_id: j.channel_id, views: j.view_count, duration: j.duration }); } catch {}
      }
    });
    const t = setTimeout(() => pr.kill(), 90000);
    pr.on('close', () => { clearTimeout(t); res(out); });
    pr.on('error', () => { clearTimeout(t); res(out); });
  });
}

async function ytApi(endpoint, params) {
  const key = store.getSettings().youtube_api_key;
  if (!key) return null;
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?` + new URLSearchParams({ ...params, key }), { signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('YouTube API: ' + (j.error?.message || r.status));
  return j;
}

// Exact numbers for a list of video ids (1 unit per 50 videos) + subscriber counts of their channels.
async function enrich(ids) {
  const vids = [];
  for (let i = 0; i < ids.length; i += 50) {
    const v = await ytApi('videos', { part: 'snippet,statistics,contentDetails', id: ids.slice(i, i + 50).join(',') });
    if (!v) return null;
    vids.push(...v.items);
  }
  const chIds = [...new Set(vids.map((v) => v.snippet.channelId))];
  const subs = {};
  for (let i = 0; i < chIds.length; i += 50) {
    const c = await ytApi('channels', { part: 'statistics', id: chIds.slice(i, i + 50).join(',') });
    (c?.items || []).forEach((x) => (subs[x.id] = +x.statistics.subscriberCount || 0));
  }
  return vids.map((v) => {
    const views = +v.statistics.viewCount || 0, s = subs[v.snippet.channelId] || 0;
    return {
      title: v.snippet.title, channel: v.snippet.channelTitle, published: v.snippet.publishedAt.slice(0, 10),
      views, views_per_day: Math.round(views / daysSince(v.snippet.publishedAt)), subs: s,
      outlier: s ? +(views / s).toFixed(2) : null, duration: v.contentDetails.duration, url: 'https://youtu.be/' + v.id,
    };
  });
}

// Your own channel: which of your videos did best (search = 100 units, once a run).
async function ownTop(ch) {
  const id = ch.youtube?.channel_id;
  if (!id) return [];
  try {
    const s = await ytApi('search', { part: 'id', channelId: id, type: 'video', order: 'viewCount', maxResults: 15 });
    if (!s) return [];
    return (await enrich(s.items.map((i) => i.id.videoId))) || [];
  } catch { return []; }
}

async function run(ch, onStep = () => {}) {
  const r = ch.research || {};
  const queries = [...new Set([...(r.keywords || []), ...(r.trend_queries || [])])].slice(0, 10);
  if (!queries.length) throw new Error(`No research keywords for ${ch.id} (config/channels/${ch.id}.json → research.keywords).`);
  onStep(`Niche researcher: searching YouTube for ${queries.length} topics (no API quota)`);
  const found = new Map();
  for (const q of queries) for (const v of await ytdlpSearch(q, 20)) if (!found.has(v.id)) found.set(v.id, { ...v, query: q });
  let rows = null;
  if (found.size && store.getSettings().youtube_api_key) {
    onStep(`Niche researcher: exact numbers for ${found.size} videos`);
    try { rows = await enrich([...found.keys()]); } catch (e) { onStep('YouTube API: ' + e.message); }
  }
  if (!rows) rows = [...found.values()].map((v) => ({ title: v.title, channel: v.channel, views: v.views || 0, views_per_day: null, url: 'https://youtu.be/' + v.id }));
  rows.sort((a, b) => (b.views_per_day ?? 0) - (a.views_per_day ?? 0) || b.views - a.views);
  const fresh = rows.filter((v) => !v.published || daysSince(v.published) <= 120);
  onStep('Own-channel analyst: your best videos');
  const own = await ownTop(ch);
  // same file the idea writer already reads
  const niche = { channel: ch.id, scanned: new Date().toISOString(), keywords: queries, videos: (fresh.length >= 10 ? fresh : rows).slice(0, 40), source: 'yt-dlp + YouTube API' };
  store.writeJSON(path.join(store.P.stats, ch.id + '_niche.json'), niche);

  onStep('Trend & opportunity analyst: reading the numbers');
  const recent = store.listProjects(ch.id).filter((x) => x.idea || x.title).slice(0, 20).map((x) => '- ' + (x.title || x.idea?.title_en)).join('\n');
  const today = new Date().toISOString().slice(0, 10);
  const { text: out, model } = await llm.chat([
    { role: 'system', content: `You are the trend and opportunity analyst for the YouTube channel "${ch.name}" (${ch.language}, ${ch.pipeline === 'documentary' ? 'documentary' : 'kids songs'}). You only claim what the numbers show. Kids-safe ideas only for kids channels.` },
    { role: 'user', content: `Today is ${today}.\n\nNICHE VIDEOS (views/day, total views, channel subscribers, outlier = views ÷ subscribers):\n${niche.videos.slice(0, 35).map((v) => `- "${v.title}" — ${v.channel} — ${v.views_per_day ?? '?'} /day, ${v.views} views, ${v.subs ?? '?'} subs, ${v.outlier ?? '?'}×, ${v.published || ''}`).join('\n')}\n\nOUR CHANNEL'S BEST VIDEOS:\n${own.slice(0, 12).map((v) => `- "${v.title}" — ${v.views} views, ${v.views_per_day}/day`).join('\n') || '- (no data)'}\n\nALREADY MADE (don't repeat):\n${recent || '- none'}\n\n` +
      `Find: (1) trends — topics rising right now (high views/day, recent); (2) outliers — small channels with huge views (copy the FORMAT, never the content); (3) gaps — strong demand but few good ${ch.language} videos; (4) dated moments in the next 3–8 weeks (festivals, school events, seasons — mark each date "(verify)"); (5) what works on OUR channel.\nThen rank the 6 best opportunities for our next videos.\n\nReply JSON only: {"trends":["…"],"outliers":["…"],"gaps":["…"],"dated":[{"what":"","date":"(verify)"}],"what_works_for_us":["…"],"opportunities":[{"idea_native":"","idea_en":"","why":"one line citing the numbers above","proof":"title + views/day","score":0-10}],"avoid":["…"]}` },
  ], { json: true, temperature: 0.4, maxTokens: 6000 });
  const report = { channel: ch.id, made: new Date().toISOString(), model, queries, own: own.slice(0, 12), ...out };
  store.writeJSON(path.join(store.P.stats, ch.id + '_opportunities.json'), report);
  return report;
}

const cached = (id) => store.readJSON(path.join(store.P.stats, id + '_opportunities.json'), null);

module.exports = { run, cached, ytdlpSearch };
