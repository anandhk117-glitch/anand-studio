// Wan 3.0 image-to-video through Alibaba Cloud Model Studio (official API).
// New international accounts get a free quota on many models. Turn on
// "Free Quota Only" in the Model Studio console so it can never bill you.
const fs = require('fs');
const path = require('path');
const { getSettings } = require('./store');

function base() {
  const s = getSettings();
  if (s.wan_workspace_id) return `https://${s.wan_workspace_id}.ap-southeast-1.maas.aliyuncs.com/api/v1`;
  return (s.wan_base_url || 'https://dashscope-intl.aliyuncs.com/api/v1').replace(/\/+$/, '');
}

function headers(extra = {}) {
  const key = getSettings().wan_api_key;
  if (!key) throw new Error('No Alibaba Model Studio key. Add it in Settings → Wan 3.0.');
  return { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...extra };
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp' };

function explain(status, body) {
  const code = body?.code || '';
  const msg = body?.message || '';
  if (code === 'AllocationQuota.FreeTierOnly') return 'Your free Wan quota is used up (Free Quota Only is on, so nothing was charged).';
  if (status === 401 || /InvalidApiKey/i.test(code)) return 'Model Studio refused the key. Check the key and that it is from the Singapore (international) region.';
  if (/Throttling|RateQuota/i.test(code)) return 'Model Studio says too many requests. Wait a minute and run again.';
  if (/DataInspection/i.test(code)) return 'Model Studio blocked this image or prompt by its content check. Change the prompt or image.';
  return `Model Studio error ${status}${code ? ' ' + code : ''}: ${msg}`.trim();
}

async function createTask({ imagePath, prompt, duration }) {
  const s = getSettings();
  const buf = fs.readFileSync(imagePath);
  if (buf.length > 20e6) throw new Error('Scene image is over 20 MB — Wan accepts 20 MB at most.');
  const mime = MIME[path.extname(imagePath).toLowerCase()] || 'image/png';
  const body = {
    model: s.wan_model || 'wan3.0-video',
    input: { prompt: String(prompt || '').slice(0, 2000), media: [{ type: 'first_frame', url: `data:${mime};base64,${buf.toString('base64')}` }] },
    parameters: { resolution: s.wan_resolution || '720P', ratio: '16:9', duration: Math.max(2, Math.min(30, Math.round(duration))), audio: false, prompt_extend: true, watermark: false },
  };
  const r = await fetch(base() + '/services/aigc/video-generation/video-synthesis', {
    method: 'POST', headers: headers({ 'X-DashScope-Async': 'enable' }), body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.output?.task_id) throw new Error(explain(r.status, j));
  return j.output.task_id;
}

async function waitTask(taskId, onTick = () => {}, { maxMinutes = 20 } = {}) {
  const until = Date.now() + maxMinutes * 60000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 15000));
    const r = await fetch(`${base()}/tasks/${taskId}`, { headers: headers(), signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(explain(r.status, j));
    const st = j.output?.task_status;
    onTick(st);
    if (st === 'SUCCEEDED') return { url: j.output.video_url, seconds: j.usage?.output_video_duration ?? j.usage?.duration ?? null };
    if (st === 'FAILED' || st === 'CANCELED' || st === 'UNKNOWN') throw new Error(explain(400, { code: j.output?.code, message: j.output?.message || st }));
  }
  throw new Error('Wan took longer than 20 minutes for this clip. Try again later.');
}

async function download(url, out) {
  const r = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error('Could not download the Wan clip (' + r.status + ').');
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
}

async function ping() {
  const s = getSettings();
  return !!s.wan_api_key;
}

module.exports = { createTask, waitTask, download, ping };
