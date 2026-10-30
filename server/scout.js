// Scout agent: once a week it looks for new free tools that could help a layer of the work.
// It only suggests. Nothing is installed until you press "Try" and follow the steps.
const path = require('path');
const store = require('./store');
const llm = require('./llm');

const FILE = path.join(store.P.data, 'discoveries.json');
const load = () => store.readJSON(FILE, { items: [], lastRun: null, models: [] });
const save = (d) => store.writeJSON(FILE, d);

// What to look for, per layer of the work. Edit freely.
const SEARCHES = [
  { layer: 'Writing (free AI)', q: 'free llm api openai compatible' },
  { layer: 'Writing (free AI)', q: 'llm router free tier' },
  { layer: 'Music', q: 'text to music lyrics song generation' },
  { layer: 'Narration', q: 'text to speech hindi' },
  { layer: 'Narration', q: 'text to speech indic' },
  { layer: 'Images', q: 'consistent character image generation' },
  { layer: 'Videos', q: 'image to video generation' },
  { layer: 'Edit', q: 'automatic video editing ffmpeg' },
  { layer: 'Timeline', q: 'lyrics alignment forced alignment' },
  { layer: 'Research', q: 'youtube trends analysis' },
];

async function gh(q) {
  const since = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}+pushed:>${since}+stars:>150&sort=stars&order=desc&per_page=8`;
  const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'anand-studio-scout' }, signal: AbortSignal.timeout(20000) });
  if (r.status === 403 || r.status === 429) throw new Error('GitHub asked us to slow down — the Scout will try again next week.');
  if (!r.ok) throw new Error('GitHub search failed: ' + r.status);
  return (await r.json()).items || [];
}

// New free models showing up in FreeLLMAPI's catalog (it refreshes its own list every 12 h).
async function freeModels() {
  const s = store.getSettings();
  if (!s.llm_api_key) return null;
  try {
    const r = await fetch(s.llm_base_url.replace(/\/+$/, '') + '/models', { headers: { Authorization: 'Bearer ' + s.llm_api_key }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    return ((await r.json()).data || []).map((m) => m.id);
  } catch { return null; }
}

async function run() {
  const d = load();
  const known = new Set([
    ...d.items.map((i) => i.repo.toLowerCase()),
    ...store.readJSON(store.P.apps, { apps: [] }).apps.map((a) => (a.repo || '').toLowerCase().replace('https://github.com/', '')),
  ]);
  const found = [];
  for (const s of SEARCHES) {
    let items = [];
    try { items = await gh(s.q); } catch (e) { d.error = e.message; break; }
    for (const it of items) {
      const repo = it.full_name;
      if (known.has(repo.toLowerCase())) continue;
      known.add(repo.toLowerCase());
      found.push({ id: repo.replace(/[^\w-]/g, '_'), repo, url: it.html_url, stars: it.stargazers_count, pushed: it.pushed_at?.slice(0, 10),
        license: it.license?.spdx_id || 'unknown', layer: s.layer, desc: (it.description || '').slice(0, 300), status: 'new', found: new Date().toISOString() });
    }
    await new Promise((r) => setTimeout(r, 7000)); // GitHub allows ~10 searches a minute without a key
  }

  // Ask the free AI for a plain verdict on each find (if it is running).
  if (found.length && (await llm.ping()) && store.getSettings().llm_api_key) {
    try {
      const { text } = await llm.chat([
        { role: 'system', content: 'You help a YouTube creator who makes Kannada/Hindi/English 3D kids songs and an English documentary channel. His Windows PC has NO dedicated GPU (Intel graphics, 16 GB RAM). Be honest and short.' },
        { role: 'user', content: `For each GitHub project, give: "use" (one sentence: what it would do for his pipeline, or "not useful"), "pc" ("runs on his PC" / "needs a GPU" / "cloud API"), "score" 0-10 for usefulness to him. Reply JSON only: {"items":[{"repo":"","use":"","pc":"","score":0}]}\n\n` +
          found.map((f) => `- ${f.repo} (${f.stars}★, ${f.license}): ${f.desc}`).join('\n') },
      ], { maxTokens: 3000 });
      const by = new Map((text.items || []).map((x) => [String(x.repo).toLowerCase(), x]));
      for (const f of found) { const v = by.get(f.repo.toLowerCase()); if (v) Object.assign(f, { use: v.use, pc: v.pc, score: +v.score || 0 }); }
    } catch { /* verdicts are a bonus */ }
  }

  const models = await freeModels();
  if (models) {
    const before = new Set(d.models || []);
    d.newModels = d.models?.length ? models.filter((m) => !before.has(m)) : [];
    d.models = models;
  }
  d.items = [...found.sort((a, b) => (b.score ?? 5) - (a.score ?? 5) || b.stars - a.stars), ...d.items].slice(0, 300);
  d.lastRun = new Date().toISOString();
  d.lastFound = found.length;
  save(d);
  return { found: found.length, newModels: d.newModels?.length || 0, error: d.error || null };
}

function setStatus(id, status) {
  const d = load();
  const it = d.items.find((x) => x.id === id);
  if (!it) throw new Error('Unknown discovery');
  it.status = status;
  save(d);
  return it;
}

module.exports = { run, load, setStatus, SEARCHES };
