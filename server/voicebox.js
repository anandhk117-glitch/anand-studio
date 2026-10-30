// Free narration on this PC with Voicebox (open source, MIT): no key, no daily limit, nothing leaves the PC.
// Voicebox runs a local server at 127.0.0.1:17493 while its app is open; the Studio starts the app if needed.
// Legends uses a preset voice (no cloning). Settings: voicebox_engine (default kokoro), voicebox_voice (default bm_george).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');

const BASE = 'http://127.0.0.1:17493';
const APP = path.join(process.env.LOCALAPPDATA || '', 'Voicebox', 'voicebox.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body, { raw = false, timeout = 60000 } = {}) {
  const r = await fetch(BASE + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`Voicebox ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return raw ? Buffer.from(await r.arrayBuffer()) : r.json();
}
const up = () => api('GET', '/health', null, { timeout: 4000 }).then(() => true).catch(() => false);

async function ensureUp(onStep = () => {}) {
  if (await up()) return;
  if (!fs.existsSync(APP)) throw new Error('Voicebox is not installed on this PC');
  onStep('Starting Voicebox on this PC');
  spawn(APP, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let k = 0; k < 40; k++) { await sleep(5000); if (await up()) return; }
  throw new Error('Voicebox did not start');
}

async function ensureModel(engine, onStep) {
  const st = await api('GET', '/models/status');
  const m = (st.models || []).find((x) => x.model_name === engine || x.model_name.startsWith(engine));
  if (!m || m.downloaded) return;
  onStep(`Voicebox: downloading the ${m.display_name} voice model (one time)`);
  await api('POST', '/models/download', { model_name: m.model_name });
  for (let k = 0; k < 240; k++) { await sleep(5000); const s2 = await api('GET', '/models/status'); if ((s2.models || []).find((x) => x.model_name === m.model_name)?.downloaded) return; }
  throw new Error('Voicebox model download took too long');
}

async function profileFor(engine, voice, language = 'en') {
  const name = `Studio ${engine} ${voice}`;
  const list = await api('GET', '/profiles');
  const found = (Array.isArray(list) ? list : list.profiles || []).find((p) => p.name === name);
  if (found) return found.id;
  const p = await api('POST', '/profiles', { name, description: 'Made by the Studio for narration (preset voice, not a clone)', language, voice_type: 'preset', preset_engine: engine, preset_voice_id: voice, default_engine: engine });
  return p.id;
}

// text → WAV file. Long scripts are split by Voicebox itself (max_chunk_chars) and crossfaded.
async function speech(text, { outFile, engine, voice, language = 'en', onStep = () => {} } = {}) {
  const s = store.getSettings();
  engine = engine || s.voicebox_engine || 'kokoro';
  voice = voice || s.voicebox_voice || 'bm_george';
  await ensureUp(onStep);
  await ensureModel(engine, onStep);
  const profile_id = await profileFor(engine, voice, language);
  onStep(`Voicebox: speaking (${engine} / ${voice})`);
  let g = await api('POST', '/generate', { profile_id, text, language, engine, normalize: true, max_chunk_chars: 600, crossfade_ms: 60 }, { timeout: 1800000 });
  for (let k = 0; g.status && !/complete|done|success/i.test(g.status); k++) {
    if (/fail|error|cancel/i.test(g.status)) throw new Error('Voicebox: ' + (g.error || g.status));
    if (k > 720) throw new Error('Voicebox: took more than an hour');
    await sleep(5000);
    g = { ...g, ...(await api('GET', `/history/${g.id}`)) }; // (the /status route is a live event stream; history gives the plain state)
    if (k % 6 === 0) onStep(`Voicebox: ${g.status}${g.progress != null ? ' ' + Math.round(g.progress) + '%' : ''}`);
  }
  const audio = await api('GET', `/audio/${g.id}`, null, { raw: true, timeout: 300000 });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, audio);
  return outFile;
}

module.exports = { speech, up, ensureUp };
