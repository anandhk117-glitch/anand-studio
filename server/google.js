// Google Agent Platform (Vertex AI) with an express-mode API key — paid from the Google Cloud free-trial credit.
// Text (Gemini = the brain), images (Gemini image, with character sheets as references), video (Veo), voice (Gemini TTS).
// Every paid call is written to data/spend.json and checked against the rupee budget first.
const fs = require('fs');
const path = require('path');
const store = require('./store');

const BASE = 'https://aiplatform.googleapis.com/v1/publishers/google/models';
const SPEND = path.join(store.P.data, 'spend.json');

const s = () => store.getSettings();
const key = () => { const k = s().google_api_key; if (!k) throw new Error('No Google Agent Platform key. Add it in Settings → Google.'); return k; };
const url = (model, method) => `${(s().google_base_url || BASE).replace(/\/+$/, '')}/${encodeURIComponent(model)}:${method}?key=${encodeURIComponent(key())}`;

// ---------------- money ----------------
function ledger() { return store.readJSON(SPEND, { entries: [] }); }
function spent(filter = () => true) { return ledger().entries.filter(filter).reduce((a, e) => a + (e.inr || 0), 0); }
function usdToInr(usd) { return usd * (+s().usd_inr || 84); }
function record(kind, model, usd, project, units) {
  const l = ledger();
  l.entries.push({ t: new Date().toISOString(), kind, model, usd: +usd.toFixed(5), inr: +usdToInr(usd).toFixed(2), project: project || null, units });
  if (l.entries.length > 20000) l.entries = l.entries.slice(-20000);
  store.writeJSON(SPEND, l);
}
function budget() {
  const st = s();
  const total = +st.google_budget_inr || 28000;
  const used = spent();
  return { total, used: +used.toFixed(0), left: +(total - used).toFixed(0), expiry: st.google_credit_expiry || '2026-12-27',
    today: +spent((e) => e.t.slice(0, 10) === new Date().toISOString().slice(0, 10)).toFixed(0) };
}
function songSpent(project) { return spent((e) => e.project === project); }
function guard(estimateUsd, project) {
  const st = s();
  const b = budget();
  const est = usdToInr(estimateUsd);
  if (b.used + est > b.total) throw new Error(`Google budget reached: ₹${b.used} of ₹${b.total} used. Raise it in Settings or wait for other tools.`);
  if (new Date() > new Date(b.expiry + 'T23:59:59')) throw new Error(`Google trial credit expired on ${b.expiry}.`);
  const cap = +st.google_song_cap_inr || 2500;
  if (project && songSpent(project) + est > cap) throw new Error(`This video reached its Google cap of ₹${cap}. Raise "per video cap" in Settings to continue.`);
}
// list prices in US$ — editable in Settings if Google changes them
function price(kind, model) {
  const st = s();
  if (kind === 'video') return /lite/i.test(model) ? +st.price_veo_lite || 0.05 : /fast/i.test(model) ? +st.price_veo_fast || 0.10 : +st.price_veo || 0.40;
  if (kind === 'image') return +st.price_image || 0.04;
  return 0;
}

// ---------------- calls ----------------
async function call(model, method, body, timeoutMs = 180000) {
  const r = await fetch(url(model, method), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = {}; }
  if (!r.ok) {
    const m = j.error?.message || text.slice(0, 300);
    if (r.status === 401 || r.status === 403) throw new Error(`Google refused the key (${r.status}): ${m}`);
    if (r.status === 404) throw new Error(`Google model "${model}" not found for this key. Use "Find models" in Settings.`);
    if (r.status === 429) throw new Error(`Google says slow down (429): ${m}`);
    throw new Error(`Google error ${r.status}: ${m}`);
  }
  return j;
}

// Text — the brain.
async function text(messages, { json = true, temperature = 0.8, maxTokens = 8192, project, model } = {}) {
  const m = model || s().google_text_model || 'gemini-2.5-flash';
  const sys = messages.filter((x) => x.role === 'system').map((x) => x.content).join('\n\n');
  const contents = messages.filter((x) => x.role !== 'system').map((x) => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] }));
  guard(0.01, project);
  const j = await call(m, 'generateContent', {
    contents, ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
    generationConfig: { temperature, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) },
  });
  const out = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  if (!out) throw new Error('Gemini returned nothing' + (j.candidates?.[0]?.finishReason ? ` (${j.candidates[0].finishReason})` : '') + '.');
  const u = j.usageMetadata || {};
  const usd = ((u.promptTokenCount || 0) * (+s().price_text_in || 0.3) + ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)) * (+s().price_text_out || 2.5)) / 1e6;
  record('text', m, usd, project, u.totalTokenCount);
  return { text: out, model: m };
}

// Image — 16:9, with up to 3 reference images (character sheets) for consistency.
async function image(prompt, { refs = [], project } = {}) {
  const m = s().google_image_model || 'gemini-2.5-flash-image';
  guard(price('image', m), project);
  const parts = [{ text: prompt }];
  for (const f of refs.slice(0, 3)) {
    const ext = path.extname(f).toLowerCase();
    parts.push({ inlineData: { mimeType: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg', data: fs.readFileSync(f).toString('base64') } });
  }
  const j = await call(m, 'generateContent', { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } } });
  const img = (j.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data);
  if (!img) throw new Error('Gemini made no image' + (j.candidates?.[0]?.finishReason ? ` (${j.candidates[0].finishReason} — the prompt may have been blocked)` : '') + '.');
  record('image', m, price('image', m), project, 1);
  return { buffer: Buffer.from(img.inlineData.data, 'base64'), ext: /png/.test(img.inlineData.mimeType) ? 'png' : 'jpg', model: m };
}

// Video — Veo image-to-video. Veo makes 4, 6 or 8 second clips; the editor fits them to the scene.
async function video(imagePath, prompt, seconds, { project, onTick = () => {} } = {}) {
  const m = s().google_video_model || 'veo-3.1-fast-generate-001';
  const dur = seconds <= 4.2 ? 4 : seconds <= 6.2 ? 6 : 8;
  guard(price('video', m) * dur, project);
  const ext = path.extname(imagePath).toLowerCase();
  const op = await call(m, 'predictLongRunning', {
    instances: [{ prompt: String(prompt || '').slice(0, 2000), image: { bytesBase64Encoded: fs.readFileSync(imagePath).toString('base64'), mimeType: ext === '.png' ? 'image/png' : 'image/jpeg' } }],
    parameters: { durationSeconds: dur, aspectRatio: '16:9', resolution: s().google_video_resolution || '720p', generateAudio: false, sampleCount: 1 },
  });
  if (!op.name) throw new Error('Veo did not start a job.');
  const until = Date.now() + 15 * 60000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 10000));
    const st = await call(m, 'fetchPredictOperation', { operationName: op.name }, 60000);
    onTick(st.done ? 'done' : 'running');
    if (st.error) throw new Error('Veo failed: ' + (st.error.message || JSON.stringify(st.error)));
    if (st.done) {
      const v = st.response?.videos?.[0];
      if (st.response?.raiMediaFilteredCount) throw new Error('Veo blocked this clip by its safety filter. Change the motion prompt or image.');
      if (!v?.bytesBase64Encoded) throw new Error('Veo finished without a video' + (v?.gcsUri ? ' (it saved to Cloud Storage instead)' : '') + '.');
      record('video', m, price('video', m) * dur, project, dur);
      return { buffer: Buffer.from(v.bytesBase64Encoded, 'base64'), seconds: dur, model: m };
    }
  }
  throw new Error('Veo took longer than 15 minutes.');
}

// Voice — Gemini TTS → WAV (needs ffmpeg to wrap the raw audio).
async function speech(textIn, { voice, project, outFile } = {}) {
  const m = s().google_tts_model || 'gemini-2.5-flash-tts';
  guard(0.05, project);
  const j = await call(m, 'generateContent', {
    contents: [{ role: 'user', parts: [{ text: textIn }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || s().google_tts_voice || 'Charon' } } } },
  }, 600000);
  const a = (j.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data);
  if (!a) throw new Error('Gemini voice returned no audio.');
  const u = j.usageMetadata || {};
  record('voice', m, ((u.promptTokenCount || 0) * 0.5 + (u.candidatesTokenCount || 0) * 10) / 1e6, project, u.totalTokenCount);
  const raw = outFile + '.pcm';
  fs.writeFileSync(raw, Buffer.from(a.inlineData.data, 'base64'));
  const rate = +(String(a.inlineData.mimeType).match(/rate=(\d+)/)?.[1] || 24000);
  await new Promise((resolve, reject) => {
    const p = require('child_process').spawn(s().ffmpeg_path || 'ffmpeg', ['-y', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', raw, outFile], { windowsHide: true });
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg could not save the voice audio'))));
    p.on('error', reject);
  });
  fs.unlinkSync(raw);
  return outFile;
}

// Find which model names this key can use (text is checked with a tiny real call; others by asking Google if the model exists).
const CANDIDATES = {
  google_text_model: ['gemini-3.5-flash', 'gemini-3-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  google_image_model: ['gemini-3.5-flash-image', 'gemini-3-pro-image-preview', 'gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview'],
  google_video_model: ['veo-3.1-lite-generate-001', 'veo-3.1-lite-generate-preview', 'veo-3.1-fast-generate-001', 'veo-3.1-fast-generate-preview', 'veo-3.1-generate-001', 'veo-3.0-fast-generate-001'],
  google_tts_model: ['gemini-2.5-flash-tts', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-tts'],
};
async function exists(model) {
  try {
    const r = await fetch(`https://aiplatform.googleapis.com/v1beta1/publishers/google/models/${encodeURIComponent(model)}?key=${encodeURIComponent(key())}`, { signal: AbortSignal.timeout(15000) });
    return r.status === 200 ? true : r.status === 404 ? false : null;
  } catch { return null; }
}
async function findModels() {
  const found = {}, notes = [];
  for (const m of CANDIDATES.google_text_model) {
    try { await call(m, 'generateContent', { contents: [{ role: 'user', parts: [{ text: 'Reply with OK' }] }], generationConfig: { maxOutputTokens: 5 } }, 30000); found.google_text_model = m; break; }
    catch (e) { if (/refused the key/.test(e.message)) throw e; notes.push(`${m}: ${e.message.split(':')[0]}`); }
  }
  for (const k of ['google_image_model', 'google_video_model', 'google_tts_model']) {
    for (const m of CANDIDATES[k]) {
      const ok = await exists(m);
      if (ok === true) { found[k] = m; break; }
      if (ok === null) { notes.push(`Could not check ${k.replace('google_', '').replace('_model', '')} models with this key — keeping the default; it is tested on first real use.`); break; }
    }
  }
  return { found, notes };
}

module.exports = { text, image, video, speech, budget, songSpent, findModels, ledger, CANDIDATES };
