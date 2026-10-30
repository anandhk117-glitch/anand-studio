// Free narration with the Gemini voices on Anand's AI Studio key (no install — works with Windows Smart App Control on).
// Tries the newest TTS models first; 429 (free daily limit) or an error moves to the next model.
const fs = require('fs');
const { spawn } = require('child_process');
const store = require('./store');

const MODELS = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-2.5-flash-preview-tts', 'gemini-3.1-flash-tts-preview'];
const sick = {};

function ff(args) {
  return new Promise((res, rej) => {
    const p = spawn(store.getSettings().ffmpeg_path || 'ffmpeg', ['-y', '-loglevel', 'error', ...args], { windowsHide: true });
    let err = ''; p.stderr.on('data', (d) => (err += d));
    p.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg: ' + err.slice(0, 200))))); p.on('error', rej);
  });
}

// text → WAV file. style: a short direction read before the line (not spoken), e.g. "a confident movie-trailer narrator".
async function speech(text, { outFile, voice = 'Charon', style = '', onStep = () => {} } = {}) {
  const key = store.getSettings().aistudio_api_key;
  if (!key) throw new Error('Gemini voice needs the AI Studio key in Settings');
  const errs = [];
  for (const m of MODELS) {
    if (sick[m] > Date.now()) continue;
    for (let attempt = 0; attempt < 2; attempt++) try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, signal: AbortSignal.timeout(180000),
        body: JSON.stringify({ contents: [{ parts: [{ text: (style ? `Say as ${style}: ` : '') + text }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { if (r.status === 429) { const daily = /per.?day|daily|RPD/i.test(JSON.stringify(j)); if (!daily && attempt === 0) { onStep(`Gemini voice: per-minute limit — waiting 30 s`); await new Promise((z) => setTimeout(z, 30000)); continue; } sick[m] = Date.now() + (daily ? 6 * 3600000 : 120000); } throw new Error(`${r.status} ${(j.error?.message || '').slice(0, 120)}`); }
      const a = (j.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data);
      if (!a) throw new Error('no audio came back');
      const buf = Buffer.from(a.inlineData.data, 'base64');
      const mime = String(a.inlineData.mimeType || '');
      if (/wav/i.test(mime)) fs.writeFileSync(outFile, buf);
      else { const raw = outFile + '.pcm'; fs.writeFileSync(raw, buf); await ff(['-f', 's16le', '-ar', mime.match(/rate=(\d+)/)?.[1] || '24000', '-ac', '1', '-i', raw, outFile]); fs.rmSync(raw, { force: true }); }
      onStep(`Gemini voice (${m} / ${voice})`);
      return outFile;
    } catch (e) { errs.push(`${m}: ${e.message}`); break; }
  }
  throw new Error('Gemini voice failed: ' + errs.join(' | ').slice(0, 400));
}

module.exports = { speech, MODELS };
