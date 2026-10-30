// Free GPU clips on Kaggle (about 30 GPU hours a week on a free account).
// The Studio sends a batch of scene pictures + motion prompts to a private Kaggle notebook through Kaggle's own API,
// the notebook makes the clips with the open-source Wan 2.2 model (no web UI, no tunnel — that is what Kaggle allows),
// and the Studio downloads the finished clips. Nothing is bought; when the weekly GPU time is used up it stops.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');

const API = 'https://www.kaggle.com/api/v1';
const SLUG_WAN = 'studio-wan-clips';
const USAGE = () => path.join(store.P.data, 'kaggle_usage.json');
const WEEK_LIMIT_H = 27; // stay safely under Kaggle's ~30 h/week

function creds() {
  const s = store.getSettings();
  if (!s.kaggle_username || !s.kaggle_key) throw new Error('Add your Kaggle username and API key in Settings.');
  const key = s.kaggle_key.trim();
  // New-style API tokens (KGAT_…) are sent as a Bearer token; legacy kaggle.json keys use username:key.
  const auth = /^KGAT_/i.test(key) || key.length > 40 ? 'Bearer ' + key : 'Basic ' + Buffer.from(`${s.kaggle_username.trim()}:${key}`).toString('base64');
  return { user: s.kaggle_username.trim(), auth };
}
// New API tokens (KGAT_…) talk to api.kaggle.com/v1/<Service>/<Method> (POST + JSON, like Kaggle's own kagglesdk);
// legacy keys use the old www.kaggle.com/api/v1 REST paths.
const RPC = { '/kernels/push': 'SaveKernel', '/kernels/status': 'GetKernelSessionStatus', '/kernels/output': 'ListKernelSessionOutput', '/kernels/list': 'ListKernels' };
async function api(method, p, body) {
  const { auth } = creds();
  if (auth.startsWith('Bearer ')) {
    const [route, qs] = p.split('?');
    const params = Object.fromEntries(new URLSearchParams(qs || ''));
    if (params.pageSize) params.pageSize = +params.pageSize;
    const r = await fetch(`https://api.kaggle.com/v1/kernels.KernelsApiService/${RPC[route]}`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body || params), signal: AbortSignal.timeout(120000) });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 300) }; }
    if (!r.ok) throw new Error(`Kaggle ${r.status}: ${(j.message || j.error || j.raw || '').toString().slice(0, 200)}`);
    return j;
  }
  const r = await fetch(API + p, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 300) }; }
  if (!r.ok) throw new Error(`Kaggle ${r.status}: ${(j.message || j.error || j.raw || '').toString().slice(0, 200)}`);
  return j;
}

function weekKey() { const d = new Date(); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); }
function hoursUsed() { const u = store.readJSON(USAGE(), {}); return u[weekKey()] || 0; }
function addHours(h) { const u = store.readJSON(USAGE(), {}); u[weekKey()] = +((u[weekKey()] || 0) + h).toFixed(2); store.writeJSON(USAGE(), u); }

function ff(args) {
  return new Promise((res, rej) => {
    const p = spawn(store.getSettings().ffmpeg_path || 'ffmpeg', ['-y', '-loglevel', 'error', ...args], { windowsHide: true });
    let e = ''; p.stderr.on('data', (d) => (e += d)); p.on('close', (c) => (c ? rej(new Error(e.slice(-200))) : res())); p.on('error', rej);
  });
}

// The notebook (Python) — inputs are embedded so no dataset upload is needed.
function notebook(jobs, { width, height, frames, fps, steps }) {
  const payload = Buffer.from(JSON.stringify(jobs)).toString('base64');
  return `# Made by Anand's YouTube Studio. Image-to-video clips with Wan 2.2 (open source). Batch job, no web UI.
import base64, gc, json, os, subprocess, sys, time, traceback
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
OUT = '/kaggle/working'
JOBS = json.loads(base64.b64decode("${payload}").decode())
log = {"started": time.time(), "done": [], "errors": []}
def save_log():
    json.dump(log, open(os.path.join(OUT, "studio_log.json"), "w"))
try:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U", "diffusers>=0.35.0", "transformers>=4.51", "accelerate", "ftfy", "imageio", "imageio-ffmpeg", "sentencepiece"], check=True)
    import torch, io
    from PIL import Image
    from diffusers import AutoencoderKLWan, WanImageToVideoPipeline
    from diffusers.utils import export_to_video
    model_id = "Wan-AI/Wan2.2-TI2V-5B-Diffusers"
    # T4 has no bf16 support: bf16 attention falls back to the slow full-matrix path and runs out of memory.
    dtype = torch.float16 if torch.cuda.is_available() and torch.cuda.get_device_capability(0)[0] < 8 else torch.bfloat16
    vae = AutoencoderKLWan.from_pretrained(model_id, subfolder="vae", torch_dtype=torch.float32)
    pipe = WanImageToVideoPipeline.from_pretrained(model_id, vae=vae, torch_dtype=dtype)
    # Kaggle's free T4 has 15 GB: keep the 5B transformer's weights in 8-bit (computed in bf16), offload idle parts,
    # and decode the video in tiles — otherwise it runs out of GPU memory.
    try: pipe.transformer.enable_layerwise_casting(storage_dtype=torch.float8_e4m3fn, compute_dtype=dtype)
    except Exception as e: log["note_cast"] = str(e)[:200]
    pipe.enable_model_cpu_offload()
    try: pipe.vae.enable_tiling()
    except Exception as e: log["note_tiling"] = str(e)[:200]
    log["gpu"] = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none"; log["dtype"] = str(dtype)
    save_log()
    SIZES = [(${width}, ${height}, ${frames}), (704, 384, 81), (640, 352, 61), (512, 288, 49)]
    neg = "blurry, low quality, distorted face, extra limbs, deformed animal, two heads, cut in half, morphing, camera zoom, text, watermark, static image"
    for job in JOBS:
        t0 = time.time()
        try:
            src = Image.open(io.BytesIO(base64.b64decode(job["img"]))).convert("RGB")
            made = False
            # If the GPU runs out of memory, try a smaller size / fewer frames (the editor scales and fits them).
            for (w, h, f) in SIZES:
                try:
                    video = pipe(image=src.resize((w, h)), prompt=job["prompt"], negative_prompt=neg, height=h, width=w, num_frames=f, guidance_scale=5.0, num_inference_steps=${steps}).frames[0]
                    export_to_video(video, os.path.join(OUT, job["id"] + ".mp4"), fps=${fps})
                    log["done"].append({"id": job["id"], "seconds": round(time.time() - t0), "size": [w, h, f]})
                    made = True
                    break
                except torch.cuda.OutOfMemoryError as e:
                    log.setdefault("oom", []).append({"id": job["id"], "size": [w, h, f], "where": traceback.format_exc()[-400:]})
                    video = None; gc.collect(); torch.cuda.empty_cache(); save_log()
            if not made: log["errors"].append({"id": job["id"], "error": "out of GPU memory at every size"})
            torch.cuda.empty_cache()
        except Exception as e:
            log["errors"].append({"id": job["id"], "error": traceback.format_exc()[-400:]})
            torch.cuda.empty_cache()
        save_log()
except Exception as e:
    log["fatal"] = traceback.format_exc()[-1500:]
log["ended"] = time.time()
save_log()
`;
}

// LTX-Video (2B, open source): small enough for Kaggle's free T4. Picture → clip, about a minute each.
function notebookLTX(jobs, { width, height, frames, fps, steps }) {
  const payload = Buffer.from(JSON.stringify(jobs)).toString('base64');
  return `# Made by Anand's YouTube Studio. Image-to-video clips with LTX-Video (open source). Batch job, no web UI.
import base64, gc, json, os, subprocess, sys, time, traceback
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
OUT = '/kaggle/working'
JOBS = json.loads(base64.b64decode("${payload}").decode())
log = {"engine": "ltx", "started": time.time(), "done": [], "errors": []}
def save_log():
    json.dump(log, open(os.path.join(OUT, "studio_log.json"), "w"))
try:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U", "diffusers>=0.33.0", "transformers>=4.47", "accelerate", "sentencepiece", "imageio", "imageio-ffmpeg"], check=True)
    import torch, io
    from PIL import Image
    from diffusers import LTXImageToVideoPipeline
    from diffusers.utils import export_to_video
    log["gpu"] = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none"
    pipe = None
    for dtype in (torch.bfloat16, torch.float16):
        try:
            pipe = LTXImageToVideoPipeline.from_pretrained("Lightricks/LTX-Video", torch_dtype=dtype)
            pipe.enable_model_cpu_offload()
            try: pipe.vae.enable_tiling()
            except Exception: pass
            # tiny warm-up: proves this number format works on this card (fp16 can give black frames)
            w = pipe(image=Image.new("RGB", (256, 256), (120, 160, 200)), prompt="a calm blue sky", width=256, height=256, num_frames=9, num_inference_steps=2).frames[0]
            import numpy as np
            if np.asarray(w[0]).std() == 0 and np.asarray(w[0]).mean() == 0: raise RuntimeError("black frames")
            log["dtype"] = str(dtype); break
        except Exception as e:
            log.setdefault("dtype_fail", []).append(str(dtype) + ": " + str(e)[:200]); pipe = None; gc.collect(); torch.cuda.empty_cache()
    if pipe is None: raise RuntimeError("no working number format on this GPU")
    save_log()
    neg = "worst quality, inconsistent motion, blurry, jittery, distorted, deformed face, extra limbs, morphing, text, watermark"
    for job in JOBS:
        t0 = time.time()
        try:
            img = Image.open(io.BytesIO(base64.b64decode(job["img"]))).convert("RGB").resize((${width}, ${height}))
            video = pipe(image=img, prompt=job["prompt"], negative_prompt=neg, width=${width}, height=${height}, num_frames=${frames}, frame_rate=${fps}, num_inference_steps=${steps}, guidance_scale=3.0).frames[0]
            export_to_video(video, os.path.join(OUT, job["id"] + ".mp4"), fps=${fps})
            log["done"].append({"id": job["id"], "seconds": round(time.time() - t0)})
        except Exception as e:
            tb = traceback.format_exc(); log["errors"].append({"id": job["id"], "error": tb[:900] + " ... " + tb[-500:]})
        gc.collect(); torch.cuda.empty_cache(); save_log()
except Exception as e:
    log["fatal"] = traceback.format_exc()[-1500:]
log["ended"] = time.time()
save_log()
`;
}

// Wan2GP (open source, made for small GPUs): runs Wan 2.2 14B image-to-video with offloading/quantization through
// its own Python API (headless, no web UI). Tries the 4-step Lightning model first, then the normal ones.
function notebookWan2GP(jobs, { width, height, frames, fps, steps }) {
  const payload = Buffer.from(JSON.stringify(jobs)).toString('base64');
  return `# Made by Anand's YouTube Studio. Image-to-video with WanGP (Wan2GP by DeepBeepMeep, open source) through its Python API. Batch job, no web UI.
import base64, gc, glob, json, os, shutil, subprocess, sys, time, traceback
OUT = '/kaggle/working'
JOBS = json.loads(base64.b64decode("${payload}").decode())
log = {"engine": "wan2gp", "started": time.time(), "done": [], "errors": [], "steps": []}
def save_log():
    json.dump(log, open(os.path.join(OUT, "studio_log.json"), "w"))
def note(m):
    log["steps"].append([round(time.time() - log["started"]), str(m)[:400]]); save_log(); print(m, flush=True)
try:
    ROOT = "/tmp/Wan2GP"
    subprocess.run(["git", "clone", "--depth", "1", "https://github.com/deepbeepmeep/Wan2GP.git", ROOT], check=True)
    note("cloned")
    req = open(ROOT + "/requirements.txt").read().splitlines()
    req = [r for r in req if r.strip() and not r.strip().startswith("#") and not r.lower().startswith(("torch", "torchvision", "torchaudio"))]
    open("/tmp/req.txt", "w").write("\\n".join(req))
    r = subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", "/tmp/req.txt"], capture_output=True, text=True)
    note("pip " + str(r.returncode) + " " + r.stderr[-300:])
    sys.path.insert(0, ROOT); os.chdir(ROOT)
    import torch
    log["gpu"] = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none"
    from pathlib import Path
    from shared.api import init
    session = init(root=Path(ROOT), output_dir=Path("/tmp/wgp_out"), cli_args=["--attention", "sdpa", "--profile", "5", "--fp16", "--perc-reserved-mem-max", "0.25"], console_output=True)
    note("session ready")
    os.makedirs("/tmp/in", exist_ok=True)
    model = None
    for mt in ["i2v_2_2_Enhanced_Lightning_v2", "i2v_2_2", "i2v"]:
        try:
            d = session.get_default_settings(mt); model = mt; log["model"] = mt; log["schema"] = str(session.get_model_schema(mt))[:1500]; note("model " + mt); break
        except Exception as e:
            note("no model " + mt + ": " + str(e)[:200])
    for job in JOBS:
        t0 = time.time()
        try:
            ip = "/tmp/in/" + job["id"] + ".jpg"; open(ip, "wb").write(base64.b64decode(job["img"]))
            st = dict(session.get_default_settings(model))
            st.update({"prompt": job["prompt"], "image_prompt_type": "S", "image_start": [ip], "resolution": "${width}x${height}", "video_length": ${frames}, "seed": 42})
            if "Lightning" not in model: st["num_inference_steps"] = ${steps}
            before = set(glob.glob("/tmp/wgp_out/**/*.mp4", recursive=True))
            res = session.submit_task(st).result()
            files = [f for f in (getattr(res, "generated_files", None) or []) if str(f).endswith(".mp4")] or sorted(set(glob.glob("/tmp/wgp_out/**/*.mp4", recursive=True)) - before)
            if getattr(res, "success", False) and files:
                shutil.copy(str(files[-1]), os.path.join(OUT, job["id"] + ".mp4"))
                log["done"].append({"id": job["id"], "seconds": round(time.time() - t0)})
            else:
                log["errors"].append({"id": job["id"], "error": str([getattr(e, "message", e) for e in (getattr(res, "errors", None) or [])])[:400]})
        except Exception as e:
            log["errors"].append({"id": job["id"], "error": traceback.format_exc()[-500:]})
        gc.collect(); torch.cuda.empty_cache(); save_log()
except Exception as e:
    log["fatal"] = traceback.format_exc()[-1500:]
log["ended"] = time.time()
save_log()
`;
}

// jobs: [{ id, imagePath, prompt }] → { id: Buffer }
async function runBatch(jobs, { onStep = () => {}, engine = 'wan' } = {}) {
  const { user } = creds();
  if (hoursUsed() >= WEEK_LIMIT_H) { const e = new Error(`Kaggle: this week's free GPU time is used up (${hoursUsed()} h) — back on Monday`); e.cap = true; throw e; }
  const s = store.getSettings();
  const opt = engine === 'wan2gp' ? { width: 832, height: 480, frames: 81, fps: 16, steps: 20 } : engine === 'ltx' ? { width: 736, height: 416, frames: 97, fps: 24, steps: +s.kaggle_ltx_steps || 40 } : { width: +s.kaggle_width || 832, height: +s.kaggle_height || 480, frames: +s.kaggle_frames || 81, fps: +s.kaggle_fps || 16, steps: +s.kaggle_steps || 30 };
  const SLUG = engine === 'ltx' ? 'studio-ltx-clips' : engine === 'wan2gp' ? 'studio-wan2gp-clips' : SLUG_WAN;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kaggle-'));
  const payload = [];
  try {
    for (const j of jobs.slice(0, +s.kaggle_batch || 6)) {
      const small = path.join(work, j.id + '.jpg');
      await ff(['-i', j.imagePath, '-vf', `scale=${opt.width}:${opt.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${opt.width}:${opt.height}`, '-q:v', '4', small]);
      payload.push({ id: j.id, prompt: j.prompt, img: fs.readFileSync(small).toString('base64') });
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  // One notebook slot: if a batch is still running there, pushing again would overwrite it.
  const now = await api('GET', `/kernels/status?userName=${encodeURIComponent(user)}&kernelSlug=${SLUG}`).catch(() => ({}));
  if (/running|queued/i.test(now.status || '')) throw new Error('Kaggle: another batch is still running on the free GPU — trying again later');
  onStep(`Kaggle: sending ${payload.length} scene(s) to the free GPU`);
  const pushed = await api('POST', '/kernels/push', {
    slug: `${user}/${SLUG}`, newTitle: SLUG, text: (engine === 'ltx' ? notebookLTX : engine === 'wan2gp' ? notebookWan2GP : notebook)(payload, opt), language: 'python', kernelType: 'script',
    isPrivate: true, enableGpu: true, enableTpu: false, enableInternet: true,
    datasetDataSources: [], competitionDataSources: [], kernelDataSources: [], modelDataSources: [], categoryIds: [],
  });
  if (pushed.error) throw new Error('Kaggle push: ' + pushed.error);
  const t0 = Date.now();
  let st = {};
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 60000));
      st = await api('GET', `/kernels/status?userName=${encodeURIComponent(user)}&kernelSlug=${SLUG}`).catch((e) => ({ status: 'unknown', failureMessage: e.message }));
      const mins = Math.round((Date.now() - t0) / 60000);
      onStep(`Kaggle: ${st.status || 'waiting'} (${mins} min)`);
      if (/complete|error|cancel/i.test(st.status || '')) break;
      if (mins > 200) throw new Error('Kaggle: the batch took more than 3 hours — stopped waiting');
    }
  } finally { addHours((Date.now() - t0) / 3600000); }
  const out = await api('GET', `/kernels/output?userName=${encodeURIComponent(user)}&kernelSlug=${SLUG}`);
  const files = out.files || [];
  const result = {};
  let log = null;
  for (const f of files) {
    const name = f.fileName || f.name || '';
    if (!/\.(mp4|json)$/.test(name)) continue;
    const r = await fetch(f.url, { signal: AbortSignal.timeout(300000) });
    if (!r.ok) continue;
    const buf = Buffer.from(await r.arrayBuffer());
    if (name.endsWith('studio_log.json')) { try { log = JSON.parse(buf.toString()); } catch {} continue; }
    result[path.basename(name, '.mp4')] = buf;
  }
  if (!Object.keys(result).length) throw new Error('Kaggle: no clips came back (' + (st.failureMessage || log?.fatal?.split('\n').slice(-2).join(' ') || log?.errors?.[0]?.error || st.status || 'unknown') + ')');
  return { clips: result, log };
}

async function test() {
  const { user } = creds();
  const r = await api('GET', `/kernels/list?user=${encodeURIComponent(user)}&pageSize=5`).catch((e) => ({ error: e.message }));
  return { ok: !r.error, user, error: r.error || null, hours_this_week: hoursUsed() };
}

module.exports = { runBatch, test, hoursUsed };
