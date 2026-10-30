// Free backup image maker: Hugging Face Inference (needs a free HF token).
// Character consistency is weaker than Google Flow, so this is a fallback, not the main path.
const { getSettings } = require('./store');

async function textToImage(prompt) {
  const s = getSettings();
  if (!s.hf_token) throw new Error('No Hugging Face token. Add a free token in Settings (huggingface.co → Settings → Access Tokens).');
  const url = `https://router.huggingface.co/hf-inference/models/${s.hf_image_model}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + s.hf_token, 'Content-Type': 'application/json', Accept: 'image/png' },
    body: JSON.stringify({ inputs: prompt, parameters: { width: 1344, height: 768 } }),
    signal: AbortSignal.timeout(180000),
  });
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !type.startsWith('image/')) {
    const t = await r.text().catch(() => '');
    if (r.status === 402 || /credit/i.test(t)) throw new Error('Hugging Face free credits for this month are used up.');
    throw new Error(`Hugging Face answered ${r.status}: ${t.slice(0, 200)}`);
  }
  return { buffer: Buffer.from(await r.arrayBuffer()), ext: type.includes('jpeg') ? 'jpg' : 'png' };
}

module.exports = { textToImage };
