// Real lyric timings from the song itself (free): Gemini on AI Studio listens to the audio.
// 1. A rough pass over the whole song says roughly where each line is (long audio drifts, so it is
//    stretched back to the real song length).
// 2. Then the song is cut into short 30-second pieces with overlap; for each piece the model gives
//    exact times of the lines it hears. Short pieces give accurate times (±0.3 s).
// 3. Every line takes its time from the piece where it sits most in the middle. Order is repaired.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const { parseLyrics } = require('./timeline');
const { extractJSON } = require('./llm');

const sick = {};
// "1:23.4", "83.4", 83.4 → seconds
const sec = (v) => { if (typeof v === 'number') return v; const m = String(v || '').trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/); return m ? (+m[1] || 0) * 60 + +m[2] : NaN; };
const rows = (o) => (Array.isArray(o) ? o : o?.lines || o?.result || []).map((x) => ({ n: +x.n || +x.line || +x.id, start: sec(x.start ?? x.start_time), end: sec(x.end ?? x.end_time) }));
function ffcut(src, start, len, out) {
  return new Promise((res, rej) => {
    const p = spawn(store.getSettings().ffmpeg_path || 'ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(start), '-t', String(len), '-i', src, '-ac', '1', '-ar', '22050', '-b:a', '64k', out], { windowsHide: true });
    let e = ''; p.stderr.on('data', (d) => (e += d)); p.on('close', (c) => (c ? rej(new Error(e.slice(-200))) : res(out))); p.on('error', rej);
  });
}
async function ask(audioFile, prompt, s, models, good = () => true) {
  const data = fs.readFileSync(audioFile).toString('base64');
  const errs = [];
  for (const m of models) {
    if (sick[m] > Date.now()) continue;
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.aistudio_api_key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'audio/mpeg', data } }, { text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 16384 } }),
        signal: AbortSignal.timeout(150000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`AI Studio ${r.status}: ${(j.error?.message || '').slice(0, 120)}`);
      const out = extractJSON((j.candidates?.[0]?.content?.parts || []).filter((x) => !x.thought).map((x) => x.text || '').join(''));
      if (!good(out)) throw new Error('answer not usable: ' + JSON.stringify(out).slice(0, 120));
      return { out, model: m };
    } catch (e) { errs.push(`${m}: ${e.message}`); if (/timeout|aborted|429|503/i.test(e.message)) sick[m] = Date.now() + 30 * 60000; }
  }
  throw new Error(errs.slice(-2).join(' | ') || 'no model');
}

async function align(audioPath, lyrics, duration, { onStep = () => {} } = {}) {
  const s = store.getSettings();
  if (!s.aistudio_api_key) throw new Error('Lyric timing needs the free AI Studio key.');
  const lines = parseLyrics(lyrics);
  if (!lines.length) throw new Error('No lyrics to time.');
  const models = [...new Set([...(s.audio_models || []), s.aistudio_model, ...(s.aistudio_fallback_models || [])].filter(Boolean))];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'align-'));
  try {
    // 1. rough pass — two full-strength models (lite models drift badly on a whole song); answers that run past
    //    the song or go backwards are thrown away.
    onStep('Listening to the whole song');
    const whole = await ffcut(audioPath, 0, duration + 1, path.join(work, 'all.mp3'));
    const list = lines.map((l, i) => `${i + 1}. ${l.text}`).join('\n');
    const roughPrompt = `Listen to this song. Its sung lyric lines in order (${lines.length} lines; words in brackets are echoes sung right after):\n${list}\nFor every line give the second where the singer starts it. Follow the voice, never spread lines evenly. Seconds as plain numbers (e.g. 83.5, not 1:23). JSON only: {"lines":[{"n":1,"start":0.0}]}`;
    const sane = (o) => { const r = rows(o).filter((x) => !isNaN(x.start)).sort((a, b) => a.n - b.n); if (r.length < lines.length * 0.8) return false; const max = Math.max(...r.map((x) => x.start)); let back = 0; for (let i = 1; i < r.length; i++) if (r[i].start < r[i - 1].start - 1) back++; return max <= duration * 1.15 && max >= duration * 0.6 && back <= 2; };
    const strong = models.filter((m) => !/lite/i.test(m));
    const roughs = [];
    let model = null;
    for (let k = 0; k < 2; k++) {
      try { const a = await ask(whole, roughPrompt, s, strong.filter((m) => !roughs.some((r) => r.model === m)), sane); roughs.push(a); model = model || a.model; } catch (e) { if (!roughs.length && k === 1) throw new Error('could not hear the song: ' + e.message); }
    }
    if (!roughs.length) throw new Error('could not hear the song');
    const scaled = roughs.map(({ out }) => { const r = rows(out); const max = Math.max(...r.filter((x) => !isNaN(x.start)).map((x) => x.start)); const k = max > duration - 2 ? (duration - 4) / max : 1; return { k, at: (n) => { const x = r.find((y) => y.n === n); return x && !isNaN(x.start) ? x.start * k : null; } }; });
    const scale = scaled[0].k;
    const approx = lines.map((_, i) => { const v = scaled.map((q) => q.at(i + 1)).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; });
    for (let i = 0; i < approx.length; i++) if (approx[i] == null) approx[i] = i ? approx[i - 1] + 4 : 2;

    // 2. short pieces
    const WIN = 30, STEP = 24;
    const got = {}; // n -> [{start,end,centre}]
    for (let w0 = 0; w0 < duration - 3; w0 += STEP) {
      const w1 = Math.min(duration, w0 + WIN);
      const cand = lines.map((l, i) => ({ n: i + 1, text: l.text })).filter((l) => approx[l.n - 1] > w0 - 10 && approx[l.n - 1] < w1 + 6);
      if (!cand.length) continue;
      onStep(`Timing lyrics ${Math.round(w0)}–${Math.round(w1)} s`);
      const f = await ffcut(audioPath, w0, w1 - w0, path.join(work, `w${Math.round(w0)}.mp3`));
      let r;
      try {
        ({ out: r } = await ask(f, `This is a ${(w1 - w0).toFixed(0)}-second piece of a song. Some of these lyric lines are sung in it (numbers are line ids; words in brackets are echoes):\n${cand.map((c) => `${c.n}. ${c.text}`).join('\n')}\nFor each line whose FIRST word you hear in this piece, give start (first word begins) and end (line and its echo finish), in seconds from the start of THIS piece as plain numbers with one decimal (e.g. 12.5). Skip lines not started in this piece. JSON only: {"lines":[{"n":0,"start":0.0,"end":0.0}]}`, s, [...strong, ...models.filter((m) => !strong.includes(m))]));
      } catch (e) { onStep('piece skipped: ' + e.message.slice(0, 80)); continue; }
      for (const x of rows(r)) {
        const n = x.n, st = x.start, en = x.end;
        if (!cand.some((c) => c.n === n) || isNaN(st) || st < 0 || st > w1 - w0) continue;
        const len = w1 - w0, first = w0 === 0, last = w1 >= duration - 0.5;
        const centre = first && last ? 99 : first ? len - st : last ? st : Math.min(st, len - st); // distance from a cut edge
        (got[n] = got[n] || []).push({ start: w0 + st, end: w0 + (isNaN(en) || en <= st ? st + 3 : Math.min(en, len + 3)), centre });
      }
    }
    // 3. pick and repair
    const outLines = lines.map((l, i) => {
      const g = (got[i + 1] || []).sort((a, b) => b.centre - a.centre)[0];
      const near = g && Math.abs(g.start - approx[i]) < 7 && !(i === 0 && g.start < 0.5 && approx[0] > 1); // a first line "at 0.0" is a guess
      return { n: i + 1, start: near ? g.start : approx[i], end: near ? g.end : approx[i] + 3.5, section: l.section, text: l.text, ...(near ? {} : { check: true }) };
    });
    for (let i = 0; i < outLines.length; i++) {
      const l = outLines[i], prev = outLines[i - 1];
      if (prev && l.start < prev.start + 0.8) { l.start = prev.start + 0.8; l.check = true; }
      if (l.end <= l.start + 0.5) l.end = l.start + 2.5;
      l.start = Math.min(l.start, duration - 0.5); l.end = Math.min(l.end, duration);
      if (prev && prev.end > l.start) prev.end = l.start;
    }
    for (const l of outLines) { l.start = +l.start.toFixed(2); l.end = +l.end.toFixed(2); }
    return { lines: outLines, model, scale: +scale.toFixed(3), flagged: outLines.filter((l) => l.check).length };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

module.exports = { align };
