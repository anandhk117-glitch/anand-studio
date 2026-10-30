// Simple file store. Every read hits disk, so the website, the Claude Code
// agent CLI and you editing files by hand always see the same data.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const P = {
  root: ROOT,
  data: DATA,
  projects: path.join(DATA, 'projects'),
  stats: path.join(DATA, 'stats'),
  queue: path.join(DATA, 'queue.json'),
  settings: path.join(DATA, 'settings.json'),
  channels: path.join(ROOT, 'config', 'channels'),
  memory: path.join(ROOT, 'memory'),
  brand: path.join(ROOT, 'brand'),
  apps: path.join(ROOT, 'apps', 'apps.json'),
  web: path.join(ROOT, 'web'),
};

for (const d of [P.data, P.projects, P.stats]) fs.mkdirSync(d, { recursive: true });

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}
function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  // Windows: a virus scanner or another reader can hold the file for a moment (EPERM/EBUSY) — wait and try again.
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (!/EPERM|EBUSY|EACCES/.test(e.code || '') || i >= 20) {
        if (i >= 20) { try { fs.copyFileSync(tmp, file); fs.rmSync(tmp, { force: true }); return; } catch {} }
        throw e;
      }
      const until = Date.now() + 100 * (i + 1); while (Date.now() < until) { /* short wait */ }
    }
  }
}
function readText(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  llm_base_url: 'http://localhost:3001/v1',
  llm_api_key: '',
  llm_model: 'auto',
  youtube_api_key: '',
  hf_token: '',
  hf_image_model: 'black-forest-labs/FLUX.1-schnell',
  ffmpeg_path: 'ffmpeg',
  ffprobe_path: 'ffprobe',
  wan_api_key: '',
  wan_workspace_id: '',
  wan_base_url: 'https://dashscope-intl.aliyuncs.com/api/v1',
  wan_model: 'wan3.0-video',
  wan_resolution: '720P',
  // Google Agent Platform (Vertex AI) — paid from the Google Cloud free-trial credit
  google_api_key: '',
  google_base_url: 'https://aiplatform.googleapis.com/v1/publishers/google/models',
  google_text_model: 'gemini-2.5-flash',
  google_image_model: 'gemini-2.5-flash-image',
  google_video_model: 'veo-3.1-fast-generate-001',
  google_video_resolution: '720p',
  google_tts_model: 'gemini-2.5-flash-tts',
  google_tts_voice: 'Charon',
  google_budget_inr: 27000,       // stop before the ₹28,664 trial credit runs out
  google_song_cap_inr: 2500,      // most one video may spend
  google_credit_expiry: '2026-12-27',
  usd_inr: 88,
  price_veo_lite: 0.05, price_veo_fast: 0.10, price_veo: 0.40, price_image: 0.04, price_text_in: 0.3, price_text_out: 2.5,
  brain: 'free',                  // 'free' = AI Studio free Gemini, then FreeLLMAPI. 'google' = also allow the paid credit as a last resort
  aistudio_api_key: '',           // Google AI Studio key from a project WITHOUT billing = free tier
  aistudio_model: 'gemini-3.8-flash',
  aistudio_fallback_models: ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-flash-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'], // free-tier models tried when the main one is busy or out for the day
  aistudio_base_url: 'https://generativelanguage.googleapis.com/v1beta/models',
  claude_stages: ['music'], // Claude Code: the song, plus Flow / Grok-Vibes-Dola only after the free API tools have failed
  free_only: true,                // never use paid tools (Veo, Gemini image); trial credit only for narration
  full_auto_default: true,        // picking a topic is enough — the brain approves the rest after its checks
  ntfy_topic: '',                 // phone notifications through the free ntfy app (pick a long secret name)                // 'google' = Gemini first, free AI as backup; 'free' = free AI only
  // autopilot
  autopilot: true,          // agents start their own jobs up to each approval
  autopilot_wan: true,      // autopilot may use Wan 3.0 for missing clips (only if a Wan key is set)
  claude_auto: true,        // Claude Code makes the Suno song (only the stages in claude_stages)
  claude_daily_cap: 6,      // at most this many Claude Code runs a day (your plan has usage limits)
  claude_max_turns: 80,
  claude_timeout_min: 45,
  claude_path: 'claude',
  daily_scan: true,         // 6 AM: YouTube stats + niche scan (needs YouTube key)
  weekly_research: true,    // Monday 7 AM: 4 fresh ideas per channel
  scout: true,              // Sunday 8 AM: look for new free tools
  freellmapi_dir: 'C:\\putaniloka-tools\\freellmapi',
  browser_agent: true,       // free browser agent in Studio Chrome (Flow / Meta AI / Vibes / Grok)
  chrome_path: '',           // leave empty to find Chrome automatically
  vision_model: '',          // Gemini model for the agent's eyes (empty = brain model)
  brain_first: 'free',                  // 'free' = FreeLLMAPI (DeepSeek…) writes first; Gemini kept for picture checks
  llm_writer_models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'qwen3.5-397b'],
  llm_vision_model: 'qwen2.5-vl-72b',   // FreeLLMAPI eyes when Gemini is used up
  ollama_url: 'http://localhost:11434', // free local models on this PC (no daily limit)
  ollama_text_model: 'qwen2.5:7b',      // steers the browser from the page's button list; backup writer
  ollama_vision_model: '',              // e.g. qwen2.5vl:3b — backup eyes when Gemini is used up
  kaggle_username: '',      // free Kaggle account (phone-verified) — ~30 GPU hours/week for Wan 2.2 clips
  kaggle_key: '',
  pexels_api_key: '',
  kaggle_width: 832, kaggle_height: 480, kaggle_frames: 81, kaggle_fps: 16, kaggle_steps: 30, kaggle_batch: 6,
  phone_access: true,       // open the Studio from your phone (same Wi-Fi, or Tailscale) with a PIN
  phone_pin: '',            // made automatically the first time
};
function getSettings() {
  const s = { ...DEFAULT_SETTINGS, ...readJSON(P.settings, {}) };
  if (!/^\d{6}$/.test(s.phone_pin || '')) {
    s.phone_pin = String(require('crypto').randomInt(100000, 1000000));
    writeJSON(P.settings, { ...readJSON(P.settings, {}), phone_pin: s.phone_pin });
  }
  return s;
}
function saveSettings(patch) {
  const cur = readJSON(P.settings, {});
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const t = typeof DEFAULT_SETTINGS[k];
    if (Array.isArray(DEFAULT_SETTINGS[k])) { next[k] = Array.isArray(v) ? v.map(String) : String(v || '').split(/[,\s]+/).filter(Boolean); continue; }
    next[k] = t === 'boolean' ? (v === true || v === 'true' || v === 'on') : t === 'number' ? (Number(v) || DEFAULT_SETTINGS[k]) : String(v ?? '').trim();
  }
  writeJSON(P.settings, next);
  return getSettings();
}
function publicSettings() {
  const s = getSettings();
  const mask = (v) => (v ? '••••' + v.slice(-4) : '');
  return { ...s, llm_api_key: mask(s.llm_api_key), youtube_api_key: mask(s.youtube_api_key), hf_token: mask(s.hf_token), wan_api_key: mask(s.wan_api_key), google_api_key: mask(s.google_api_key), aistudio_api_key: mask(s.aistudio_api_key), kaggle_key: mask(s.kaggle_key), pexels_api_key: mask(s.pexels_api_key),
    has: { llm: !!s.llm_api_key || /localhost|127\.0\.0\.1/.test(s.llm_base_url), youtube: !!s.youtube_api_key, hf: !!s.hf_token, wan: !!s.wan_api_key, google: !!s.google_api_key } };
}

// ---------- channels ----------
function listChannels() {
  return fs.readdirSync(P.channels).filter((f) => f.endsWith('.json'))
    .map((f) => readJSON(path.join(P.channels, f))).filter(Boolean)
    .sort((a, b) => (a.order || 99) - (b.order || 99));
}
function getChannel(id) { return readJSON(path.join(P.channels, id + '.json'), null); }

// ---------- memory layers ----------
const MEMORY_FILES = ['rules', 'lessons', 'decisions'];
function getMemory(channel) {
  const out = {};
  for (const m of MEMORY_FILES) out[m] = readText(path.join(P.memory, channel, m + '.md'));
  return out;
}
function saveMemory(channel, file, text) {
  if (!MEMORY_FILES.includes(file)) throw new Error('Unknown memory file: ' + file);
  writeText(path.join(P.memory, channel, file + '.md'), text);
}
function appendMemory(channel, file, line) {
  const f = path.join(P.memory, channel, file + '.md');
  const cur = readText(f);
  writeText(f, (cur.trim() ? cur.replace(/\s*$/, '\n') : '') + line + '\n');
}

// ---------- projects ----------
function projectDir(id) {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('Bad project id');
  return path.join(P.projects, id);
}
function getProject(id) { return readJSON(path.join(projectDir(id), 'project.json'), null); }
function saveProject(p) {
  p.updated = new Date().toISOString();
  writeJSON(path.join(projectDir(p.id), 'project.json'), p);
  return p;
}
function listProjects(channel) {
  if (!fs.existsSync(P.projects)) return [];
  return fs.readdirSync(P.projects)
    .map((d) => readJSON(path.join(P.projects, d, 'project.json'), null))
    .filter((p) => p && (!channel || p.channel === channel))
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
}
function deleteProject(id) {
  fs.rmSync(projectDir(id), { recursive: true, force: true });
}
function log(p, who, text) {
  p.log = p.log || [];
  p.log.unshift({ t: new Date().toISOString(), who, text });
  p.log = p.log.slice(0, 200);
}

// ---------- queue (requests for the Claude Code agent) ----------
function getQueue() { return readJSON(P.queue, []); }
function saveQueue(q) { writeJSON(P.queue, q); }

module.exports = {
  P, readJSON, writeJSON, readText, writeText,
  getSettings, saveSettings, publicSettings,
  listChannels, getChannel,
  getMemory, saveMemory, appendMemory,
  projectDir, getProject, saveProject, listProjects, deleteProject, log,
  getQueue, saveQueue,
};
