// Talks to any OpenAI-compatible endpoint. Default is FreeLLMAPI on your PC
// (http://localhost:3001/v1), which pools the free tiers of many providers.
const { getSettings } = require('./store');

// The brain, in order: Gemini on AI Studio's FREE tier → free models through FreeLLMAPI →
// (only if Settings → Brain allows it) Gemini on the paid Google credit.
let freeDownUntil = 0;
async function chat(messages, opts = {}) {
  const s = getSettings();
  const errors = [];
  // Writing goes to FreeLLMAPI (DeepSeek and friends) first, so Gemini's free limit is kept for the picture checks.
  const tryGemini = async () => { if (!s.aistudio_api_key) return null; try { const r = await aistudio(messages, opts); return { text: opts.json === false ? r.text : extractJSON(r.text), model: r.model }; } catch (e) { errors.push(e.message); return null; } };
  const tryFree = async () => {
    if (!freeReady(s) || Date.now() < freeDownUntil) return null;
    for (const m of [...new Set([...(s.llm_writer_models || []), s.llm_model || 'auto'])]) {
      try { const r = await freeChat(messages, opts, m); if (opts.json === false || (r.text && typeof r.text === 'object')) return r; errors.push(`free/${m}: no JSON`); }
      catch (e) { errors.push(`free/${m}: ${e.message.slice(0, 120)}`); }
    }
    freeDownUntil = Date.now() + 20 * 60000; // FreeLLMAPI not answering: skip it for 20 minutes instead of waiting on every job
    return null;
  };
  for (const f of s.brain_first === 'gemini' ? [tryGemini, tryFree] : [tryFree, tryGemini]) { const r = await f(); if (r) return r; }
  if (s.google_api_key && s.brain === 'google') {
    const g = await require('./google').text(messages, { json: opts.json !== false, temperature: opts.temperature ?? 0.8, maxTokens: Math.max(opts.maxTokens || 4000, 8192), project: opts.project });
    return { text: opts.json === false ? g.text : extractJSON(g.text), model: g.model };
  }
  if (s.ollama_text_model && !opts.noLocal) {
    try { const r = await local(messages, { json: opts.json !== false, temperature: opts.temperature ?? 0.7, timeoutMs: 900000 }); return { text: opts.json === false ? r.text : extractJSON(r.text), model: r.model }; }
    catch (e) { errors.push(e.message); }
  }
  throw new Error(errors.length ? 'The brain could not answer: ' + errors.join(' | ') : 'No brain set up. Add a free AI Studio key or the FreeLLMAPI key in Settings.');
}

// Busy (503) → wait and retry once; daily limit (429) or a stuck model (timeout) → next free model at once.
const textSick = {};
async function aistudio(messages, opts = {}) {
  const s = getSettings();
  const all = [...new Set([s.aistudio_model || 'gemini-3-flash-preview', ...(s.aistudio_fallback_models || [])].filter(Boolean))];
  const well = all.filter((m) => !(textSick[m] > Date.now()));
  const models = well.length ? well : all;
  const errs = [];
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const r = await aistudioOnce(model, messages, opts); delete textSick[model]; return r; } catch (e) {
        errs.push(e.message);
        if (/timeout|aborted|AI Studio 429/i.test(e.message)) { textSick[model] = Date.now() + 30 * 60000; break; } // stuck or used up: next model now
        const busy = /AI Studio (500|502|503|504)|fetch failed/i.test(e.message);
        if (!busy) break;
        await new Promise((r) => setTimeout(r, [6000, 15000, 0][attempt]));
      }
    }
  }
  throw new Error(errs.slice(-2).join(' | '));
}
async function aistudioOnce(model, messages, { json = true, temperature = 0.8, maxTokens = 8192 } = {}) {
  const s = getSettings();
  const sys = messages.filter((x) => x.role === 'system').map((x) => x.content).join('\n\n');
  const contents = messages.filter((x) => x.role !== 'system').map((x) => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] }));
  const r = await fetch(`${(s.aistudio_base_url || 'https://generativelanguage.googleapis.com/v1beta/models').replace(/\/+$/, '')}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.aistudio_api_key },
    body: JSON.stringify({ contents, ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}), generationConfig: { temperature, maxOutputTokens: Math.max(maxTokens, 32768), ...(json ? { responseMimeType: 'application/json' } : {}) } }),
    signal: AbortSignal.timeout(150000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`AI Studio ${r.status}: ${(j.error?.message || '').slice(0, 200)}${r.status === 429 ? ' (free daily limit reached)' : ''}`);
  const text = (j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  if (!text) throw new Error('AI Studio returned nothing (' + (j.candidates?.[0]?.finishReason || 'no reason') + ')');
  return { text, model: 'aistudio/' + model };
}

// Free local model in Ollama on this PC — no daily limit, slower (CPU). images: [{mime,data}] for a vision model.
async function local(messages, { json = true, temperature = 0.2, model, images, timeoutMs = 240000 } = {}) {
  const s = getSettings();
  const m = model || s.ollama_text_model;
  if (!m) throw new Error('No local model set.');
  const msgs = messages.map((x, i) => (images && i === messages.length - 1 ? { ...x, images: images.map((im) => im.data) } : x));
  const r = await fetch((s.ollama_url || 'http://localhost:11434').replace(/\/+$/, '') + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: m, messages: msgs, stream: false, ...(json ? { format: 'json' } : {}), options: { temperature, num_ctx: 8192 }, keep_alive: '30m' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.message) throw new Error(`Local model ${m}: ${j.error || r.status}`);
  return { text: j.message.content || '', model: 'local/' + m };
}

const freeReady = (s) => !!s.llm_base_url && (!!s.llm_api_key || /localhost|127\.0\.0\.1/.test(s.llm_base_url));

async function freeChat(messages, { json = true, temperature = 0.8, maxTokens = 4000 } = {}, model) {
  const s = getSettings();
  if (!s.llm_base_url) throw new Error('No free LLM set up. Open Settings and add the FreeLLMAPI address, or send this job to Claude Code.');
  const url = s.llm_base_url.replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (s.llm_api_key) headers.Authorization = 'Bearer ' + s.llm_api_key;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ model: model || s.llm_model || 'auto', messages, temperature, max_tokens: Math.max(maxTokens, 16000) }),
      signal: AbortSignal.timeout(300000),
    });
  } catch (e) {
    throw new Error(`Could not reach the free LLM at ${s.llm_base_url}. Is FreeLLMAPI running? (${e.message})`);
  }
  const body = await res.text();
  if (!res.ok) throw new Error(`Free LLM answered ${res.status}: ${body.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('Free LLM sent something that is not JSON.'); }
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('empty answer');
  return { text: json ? extractJSON(text) : text, model: 'free/' + (data.model || model || s.llm_model) };
}

// Models often wrap JSON in ``` fences or add a sentence. Pull out the object.
function extractJSON(text) {
  const t = String(text).replace(/```(?:json)?/gi, '');
  const start = t.search(/[\[{]/);
  if (start < 0) throw new Error('The model did not return JSON. Try again or use Claude Code.');
  const open = t[start], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(t.slice(start, i + 1));
  }
  throw new Error('The model returned cut-off JSON. Try again.');
}

async function ping() {
  const s = getSettings();
  if (s.aistudio_api_key || (s.google_api_key && s.brain === 'google')) return true;
  try {
    const r = await fetch(s.llm_base_url.replace(/\/+$/, '') + '/models', {
      headers: s.llm_api_key ? { Authorization: 'Bearer ' + s.llm_api_key } : {}, signal: AbortSignal.timeout(4000),
    });
    return r.ok;
  } catch { return false; }
}

// Gemini looks at pictures (screenshots, generated images, character sheets) and answers in JSON.
// images: [{ mime: 'image/jpeg', data: <base64> }]. Free AI Studio tier only.
// Models that just timed out or were overloaded are skipped for a while, so one stuck model
// does not make every picture check wait minutes (it tries the next model at once).
const visionSick = {};
async function vision(text, images = [], { system = '', temperature = 0.2, strong = false } = {}) {
  const s = getSettings();
  if (!s.aistudio_api_key) throw new Error('Vision needs the free AI Studio key (Settings).');
  // strong: quality judges (clip checker, director) never use "lite" models — they pass broken clips with 10/10.
  const all = [...new Set([s.vision_model || s.aistudio_model || 'gemini-3-flash-preview', ...(s.aistudio_fallback_models || [])].filter(Boolean))].filter((m) => !strong || !/lite/i.test(m));
  const well = all.filter((m) => !(visionSick[m] > Date.now()));
  const models = well.length ? well : all;
  const parts = [...images.map((im) => ({ inline_data: { mime_type: im.mime || 'image/jpeg', data: im.data } })), { text }];
  const errs = [];
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`${(s.aistudio_base_url || 'https://generativelanguage.googleapis.com/v1beta/models').replace(/\/+$/, '')}/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.aistudio_api_key },
          body: JSON.stringify({ contents: [{ role: 'user', parts }], ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), generationConfig: { temperature, maxOutputTokens: 16384, responseMimeType: 'application/json' } }),
          signal: AbortSignal.timeout(90000),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(`AI Studio ${r.status}: ${(j.error?.message || '').slice(0, 160)}`);
        const out = (j.candidates?.[0]?.content?.parts || []).filter((x) => !x.thought).map((x) => x.text || '').join('');
        delete visionSick[model];
        return { json: extractJSON(out), model };
      } catch (e) {
        errs.push(e.message);
        if (/timeout|aborted|AI Studio (429|503)/i.test(e.message)) { visionSick[model] = Date.now() + 30 * 60000; break; } // stuck or busy: next model now
        if (!/AI Studio (500|502|504)|fetch failed/i.test(e.message)) break;
        await new Promise((res) => setTimeout(res, [5000, 12000, 0][attempt]));
      }
    }
  }
  // All free Gemini models used up → try the FreeLLMAPI backup (if it has a model that can see pictures).
  if (strong) { const err = new Error('Vision judge unavailable (strong models used up): ' + errs.slice(-1).join('')); err.quota = true; throw err; }
  if (freeReady(s)) {
    try {
      const r = await fetch(s.llm_base_url.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(s.llm_api_key ? { Authorization: 'Bearer ' + s.llm_api_key } : {}) },
        body: JSON.stringify({ model: s.llm_vision_model || s.llm_model || 'auto', temperature, max_tokens: 4000, messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: [...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime || 'image/jpeg'};base64,${im.data}` } })), { type: 'text', text: text + '\nReply with JSON only.' }] }] }),
        signal: AbortSignal.timeout(120000),
      });
      const j = await r.json().catch(() => ({}));
      const out = j.choices?.[0]?.message?.content || '';
      if (r.ok && out) { const json = extractJSON(out); if (json && typeof json === 'object') return { json, model: 'free/' + (j.model || 'auto') }; }
      errs.push(`FreeLLMAPI vision ${r.status}`);
    } catch (e) { errs.push('FreeLLMAPI vision: ' + e.message); }
  }
  if (s.ollama_vision_model) {
    try { const r = await local([...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: text + '\nReply with JSON only.' }], { images, model: s.ollama_vision_model, temperature, timeoutMs: 600000 }); const json = extractJSON(r.text); if (json && typeof json === 'object') return { json, model: r.model, local: true }; }
    catch (e) { errs.push(e.message); }
  }
  const err = new Error('Vision failed: ' + errs.slice(-2).join(' | '));
  err.quota = errs.some((x) => /429|quota/i.test(x)) && !errs.some((x) => /AI Studio (400|401|403)/.test(x));
  throw err;
}

module.exports = { chat, vision, local, extractJSON, ping };
