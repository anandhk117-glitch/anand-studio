// Everything that needs ffmpeg: measuring songs, building the edit, Shorts, thumbnails.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getSettings } = require('./store');

function run(bin, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    let err = '', out = '';
    let p;
    try { p = spawn(bin, args, { cwd, windowsHide: true }); } catch (e) { return reject(e); }
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => { err += d; if (err.length > 2e6) err = err.slice(-1e6); });
    p.on('error', (e) => reject(new Error(`${bin} could not start (${e.message}). Is ffmpeg installed? Check Settings.`)));
    p.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${path.basename(bin)} failed (code ${code}):\n` + err.split('\n').slice(-12).join('\n')))));
  });
}
const ff = (args, o) => run(getSettings().ffmpeg_path || 'ffmpeg', ['-hide_banner', '-y', ...args], o);
const fp = (args) => run(getSettings().ffprobe_path || 'ffprobe', ['-v', 'error', ...args]);

async function ffmpegOk() {
  try { const { out } = await run(getSettings().ffmpeg_path || 'ffmpeg', ['-version']); return out.split('\n')[0]; } catch { return null; }
}

async function probe(file) {
  const { out } = await fp(['-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', file]);
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  return { duration: +j.format.duration || 0, hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio'),
    width: v?.width || 0, height: v?.height || 0, fps: v?.r_frame_rate ? (([a, b]) => +a / (+b || 1))(v.r_frame_rate.split('/')) : 0 };
}

// ---------------- music analysis ----------------
async function analyzeAudio(file) {
  const { duration } = await probe(file);
  // 1-second loudness curve
  const { err } = await ff(['-i', file, '-af',
    'aresample=8000,asetnsamples=n=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
    '-f', 'null', '-']);
  const rms = [...err.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => (m[1] === '-inf' ? -90 : +m[1]));
  const { err: e2 } = await ff(['-i', file, '-af', 'silencedetect=noise=-38dB:d=1.5', '-f', 'null', '-']);
  const silences = [];
  const starts = [...e2.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]);
  const ends = [...e2.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  starts.forEach((s, i) => silences.push({ start: +s.toFixed(1), end: +(ends[i] ?? duration).toFixed(1) }));
  const { err: e3 } = await ff(['-i', file, '-af', 'ebur128', '-f', 'null', '-']);
  const lufs = +((e3.match(/I:\s+(-?[\d.]+) LUFS/g) || []).pop()?.match(/-?[\d.]+/)?.[0] ?? NaN);

  const sorted = [...rms].filter((x) => x > -80).sort((a, b) => a - b);
  const q = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : -90;
  const median = q(0.5), p90 = q(0.9);
  const energyStart = rms.findIndex((x) => x > median - 4); // when the song "arrives"
  const midGaps = silences.filter((s) => s.start > 3 && s.end < duration - 3);
  const tail = rms.slice(-3);
  const cleanEnd = tail.length === 3 && tail[2] < tail[0] - 3;

  const score = {
    duration: duration >= 140 && duration <= 270 ? 10 : duration >= 100 && duration <= 330 ? 6 : 2,
    hook: energyStart >= 0 && energyStart <= 5 ? 20 : energyStart <= 10 ? 13 : 6,
    lift: Math.max(0, Math.min(15, Math.round((p90 - median) * 2.5))),
    consistency: Math.max(0, 15 - Math.round(Math.abs((q(0.75) - q(0.25)) - 6) * 2)),
    glitches: Math.max(0, 10 - midGaps.length * 5),
    ending: cleanEnd ? 10 : 5,
  };
  const total = Object.values(score).reduce((a, b) => a + b, 0); // out of 80; lyric accuracy (20) needs Suno timestamps
  return {
    duration: +duration.toFixed(2), lufs: isNaN(lufs) ? null : lufs, energy_start: energyStart, median_db: +median.toFixed(1),
    chorus_lift_db: +(p90 - median).toFixed(1), silences, mid_gaps: midGaps.length, clean_end: cleanEnd,
    curve: rms.map((x) => +x.toFixed(1)), score, total, out_of: 80,
  };
}

// ---------------- edit ----------------
const W = 1920, H = 1080, FPS = 30; // 30 fps output like the hand-made videos (YouTube standard); very choppy clips get real in-between frames
const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
const enc = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS)];
const aenc = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];

// Fill the whole 16:9 frame (no black bars): crop the small edge, upscale with lanczos, light sharpen for small clips.
const fill = (srcH) => `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}${srcH && srcH < 900 ? ',unsharp=5:5:0.55:5:5:0' : ''},setsar=1`;
// A closer framing of the same clip (a "punch-in"): reads as a new shot, never as a repeat.
const punch = (srcH, z = 1.22) => `scale=${Math.round(W * z)}:${Math.round(H * z)}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}${srcH && srcH < 900 ? ',unsharp=5:5:0.55:5:5:0' : ''},setsar=1`;
// Kids look: a little brighter and more colourful.
const GRADE = 'eq=saturation=1.1:contrast=1.04:brightness=0.01';
// Living camera: the frame drifts slowly sideways across the shot (alternating direction) so even calm clips feel filmed.
function frame(srcH, len, { zoom, drift } = {}) {
  const z = zoom ? 1.22 : drift ? 1.08 : 1;
  const sharp = srcH && srcH < 900 ? ',unsharp=5:5:0.55:5:5:0' : '';
  const D = Math.max(0.5, len).toFixed(3);
  const x = drift === 'left' ? `(iw-ow)*(1-min(t/${D},1))` : drift === 'right' ? `(iw-ow)*min(t/${D},1)` : '(iw-ow)/2';
  return `scale=${Math.round(W * z)}:${Math.round(H * z)}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}:x='${x}':y='(ih-oh)/2'${sharp},${GRADE},setsar=1`;
}
const MAX_SLOW = 1.12; // the edit rules: speed stays between 0.9x and 1.12x — no slow motion, never reversed

async function clipPart(src, len, out, { delogo, zoom, drift, flash } = {}) {
  const info = await probe(src);
  const clipLen = info.duration || len;
  const ratio = Math.min(MAX_SLOW, Math.max(0.9, len / clipLen));
  const pre = delogo ? `delogo=${delogo},` : '';
  // Choppy sources (16 fps clips, or slowed clips) get real in-between frames made by motion interpolation,
  // so movement looks smooth instead of picture-by-picture.
  const eff = info.fps ? info.fps / ratio : FPS;
  const smooth = eff < FPS - 1 ? `minterpolate=fps=${FPS}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:me=epzs:vsbmc=1,` : '';
  // flash = kids-style transition at a new song section: the shot opens from a quick white flash
  const vf = `${pre}setpts=${ratio.toFixed(4)}*PTS,${smooth}${frame(info.height, len, { zoom, drift })},fps=${FPS},tpad=stop_mode=clone:stop_duration=0.5${flash ? ',fade=t=in:st=0:d=0.22:color=white' : ''}`;
  await ff(['-i', src, '-an', '-vf', vf, '-t', len.toFixed(3), ...enc, out]);
}

async function sceneSegment(scene, dur, out, { delogo, alternates = [], drift, flash } = {}) {
  const d = Math.max(0.5, dur);
  if (scene.videoPath) {
    const clipLen = (await probe(scene.videoPath)).duration || d;
    if (d <= clipLen * MAX_SLOW + 0.05) { await clipPart(scene.videoPath, d, out, { delogo, drift, flash }); return; }
    // Longer than one clip can cover: two shots. Shot A = this clip (gentle speed), shot B = another clip of the
    // same picture if there is one, else a closer framing of this clip. Hard cut between them.
    const a = Math.min(d - 1.5, clipLen * MAX_SLOW);
    const b = d - a;
    const pa = out.replace(/\.mp4$/, '_a.mp4'), pb = out.replace(/\.mp4$/, '_b.mp4');
    await clipPart(scene.videoPath, a, pa, { delogo, drift, flash });
    const alt = alternates.find((x) => x && x !== scene.videoPath && fs.existsSync(x));
    if (alt) await clipPart(alt, b, pb, { delogo, drift: drift === 'left' ? 'right' : 'left' });
    else await clipPart(scene.videoPath, b, pb, { delogo, zoom: true });
    const lst = out.replace(/\.mp4$/, '_list.txt');
    fs.writeFileSync(lst, [pa, pb].map((x) => `file '${x.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    await ff(['-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', out]);
  } else if (scene.imagePath) {
    const F = Math.round(d * FPS);
    // slow push-in so still images still feel alive
    await ff(['-i', scene.imagePath, '-vf',
      `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='1+0.08*on/${F}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${F}:s=${W}x${H}:fps=${FPS},setsar=1`,
      '-frames:v', String(F), ...enc, out]);
  } else {
    await ff(['-f', 'lavfi', '-i', `color=c=0x1b1f3a:s=${W}x${H}:r=${FPS}`, '-t', d.toFixed(3), ...enc, out]);
  }
}

// Brand clips (intro/outro) re-encoded to the same format so they join cleanly.
async function normalizeClip(src, out, maxLen, { fillFrame } = {}) {
  const info = await probe(src);
  if (fillFrame && info.width && info.height && Math.abs(info.width / info.height - W / H) > 0.05) {
    const args = ['-i', src];
    if (!info.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    args.push('-filter_complex', `[0:v]split[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2,eq=brightness=-0.05[bg];[b]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=${FPS},setsar=1[v]`,
      '-map', '[v]', '-map', info.hasAudio ? '0:a:0' : '1:a:0', '-shortest', ...enc, ...aenc, out);
    return ff(args);
  }
  const args = ['-i', src];
  if (!info.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  const cut = maxLen && info.duration > maxLen + 0.1 ? maxLen : 0;
  const vfx = cut ? `,fade=t=out:st=${(cut - 0.3).toFixed(2)}:d=0.3` : '';
  args.push('-vf', `${fit},fps=${FPS}${vfx}`, '-map', '0:v:0', '-map', info.hasAudio ? '0:a:0' : '1:a:0', ...(cut ? ['-af', `afade=t=out:st=${(cut - 0.5).toFixed(2)}:d=0.5`, '-t', cut.toFixed(3)] : []), '-shortest', ...enc, ...aenc, out);
  await ff(args);
}

function srtTime(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
function makeSrt(lines, offset = 0) {
  const { isInstrumental } = require('./timeline');
  return lines.filter((l) => l.text && !isInstrumental(l.text) && !l.instrumental)
    .map((l, i) => `${i + 1}\n${srtTime(l.start + offset)} --> ${srtTime(l.end + offset)}\n${l.text}\n`).join('\n');
}

/**
 * Builds final.mp4 in the project folder.
 * opts: { intro, outro, logo, subscribe, lyrics, subscribeTimes:[sec…], delogo, font }
 */
async function renderEdit(dir, project, brandDir, opts, onStep = () => {}) {
  const work = path.join(dir, 'edit_work');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const audio = path.join(dir, project.picked_audio);
  const { duration: songLen } = await probe(audio);
  const scenes = project.scenes || [];
  if (!scenes.length) throw new Error('No scenes yet. Approve the timeline first.');

  // 1. one clip per scene, cut to the exact scene length
  const list = [];
  const T = 0.4; // transition length between song sections
  const useX = opts.transitions !== false;
  const isNew = (i) => i > 0 && scenes[i].section && scenes[i].section !== scenes[i - 1].section;
  const groups = [[]];
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    if (useX && isNew(i)) groups.push([]);
    // the last shot before a new section runs T seconds longer: the transition blends over it, so timing stays exact
    const extra = useX && i < scenes.length - 1 && isNew(i + 1) ? T : 0;
    const end = (i === scenes.length - 1 ? Math.max(s.end, songLen) : s.end) + extra;
    const seg = path.join(work, `seg_${String(i + 1).padStart(2, '0')}.mp4`);
    onStep(`Cutting scene ${i + 1} of ${scenes.length}`);
    // other clips made from the same picture (used as the second shot when a scene is longer than one clip)
    const alternates = scenes.filter((x, k) => k !== i && x.video && x.image === s.image).sort((x, y) => Math.abs(x.n - s.n) < Math.abs(y.n - s.n) ? 1 : -1).map((x) => path.join(dir, x.video));
    await sceneSegment({ videoPath: s.video && path.join(dir, s.video), imagePath: s.image && path.join(dir, s.image) },
      end - s.start, seg, { delogo: opts.delogo, alternates, drift: opts.camera === false || s.continue_previous || scenes[i + 1]?.continue_previous ? null : (i % 2 ? 'left' : 'right') });
    list.push(`file '${seg.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    groups[groups.length - 1].push(seg);
  }
  // 1b. HyperFrames: the opening shot gets the song title animating in over the first scene.
  const hf = require('./hyperframes');
  const useHF = opts.hyperframes !== false && hf.ready();
  const ch = require('./store').getChannel(project.channel) || {};
  if (useHF && scenes[0]) {
    try {
      onStep('HyperFrames: animated title on the opening shot');
      const seg1 = path.join(work, 'seg_01.mp4');
      const len = (await probe(seg1)).duration;
      const raw = path.join(work, 'hf_open.mp4');
      await hf.titleOpening({ clip: seg1, titleNative: project.song?.title_native || project.title, titleEn: project.song?.title_en || project.idea?.title_en || '', color: ch.brand_color || '#ffd400', dur: +len.toFixed(2) }, raw);
      await ff(['-i', raw, '-an', '-vf', `${fit},fps=${FPS}`, '-t', len.toFixed(3), ...enc, path.join(work, 'seg_01_hf.mp4')]);
      fs.renameSync(path.join(work, 'seg_01_hf.mp4'), seg1);
    } catch (e) { onStep('HyperFrames opening skipped: ' + e.message.slice(0, 120)); }
  }
  if (useX && groups.length > 1) {
    // Smooth kids transitions between song sections, made locally at each section change (a long chained
    // crossfade froze the picture): the shot before a new section was made T seconds longer; its last T seconds
    // are cut off and blended into the start of the next shot. Every file keeps its exact length -> timing exact.
    onStep('Adding transitions between song sections');
    const TYPES = ['circleopen', 'smoothleft', 'zoomin', 'wiperight', 'radial', 'smoothup', 'circleclose', 'slideleft'];
    const segs = groups.flat();
    let k = 0;
    for (let i = 0; i < segs.length - 1; i++) {
      if (!groups.some((g, gi) => gi > 0 && g[0] === segs[i + 1])) continue;
      const A = segs[i], B = segs[i + 1];
      const lenA = (await probe(A)).duration;
      const keep = Math.max(0.5, lenA - T);
      const tail = A.replace(/\.mp4$/, '_tail.mp4'), cutA = A.replace(/\.mp4$/, '_cut.mp4'), xB = B.replace(/\.mp4$/, '_x.mp4');
      await ff(['-ss', keep.toFixed(3), '-i', A, '-t', T.toFixed(3), ...enc, tail]);
      await ff(['-i', A, '-t', keep.toFixed(3), ...enc, cutA]);
      await ff(['-i', tail, '-i', B, '-filter_complex', `[0:v]settb=1/${FPS * 512},setpts=PTS-STARTPTS[a];[1:v]settb=1/${FPS * 512},setpts=PTS-STARTPTS[b];[a][b]xfade=transition=${TYPES[k++ % TYPES.length]}:duration=${(T - 0.02).toFixed(3)}:offset=0[v]`, '-map', '[v]', ...enc, xB]);
      fs.renameSync(cutA, A); fs.renameSync(xB, B); fs.rmSync(tail, { force: true });
    }
  }
  fs.writeFileSync(path.join(work, 'scenes.txt'), list.join('\n'));
  onStep('Joining scenes');
  await ff(['-f', 'concat', '-safe', '0', '-i', 'scenes.txt', '-c', 'copy', 'body_video.mp4'], { cwd: work });

  // 2. music + logo + lyrics + subscribe pop-ups on top
  onStep('Adding music, logo and lyrics');
  const inputs = ['-i', 'body_video.mp4', '-i', audio];
  const fc = [];
  let last = '0:v';
  let idx = 2;
  const logo = path.join(brandDir, 'logo.png');
  if (opts.logo && fs.existsSync(logo)) {
    inputs.push('-i', logo);
    fc.push(`[${idx}:v]scale=170:-1[lg]`, `[${last}][lg]overlay=W-w-40:H-h-40[v${idx}]`);
    last = `v${idx}`; idx++;
  }
  const sub = path.join(brandDir, 'subscribe.png');
  if (opts.subscribe && fs.existsSync(sub) && (opts.subscribeTimes || []).length) {
    inputs.push('-i', sub);
    const n = opts.subscribeTimes.length;
    fc.push(`[${idx}:v]scale=520:-1,split=${n}${opts.subscribeTimes.map((_, k) => `[sb${k}]`).join('')}`);
    opts.subscribeTimes.forEach((t, k) => {
      const a = (+t).toFixed(2), b = (+t + 4).toFixed(2);
      fc.push(`[${last}][sb${k}]overlay=40:H-h-50:enable='between(t,${a},${b})'[s${k}]`);
      last = `s${k}`;
    });
    idx++;
  }
  if (opts.lyrics && project.timeline?.lines?.length) {
    // Karaoke line at the bottom + the sung-back echo word "(ಅಂಬಾ!)" popping up big in the middle (kids repeat it).
    const font = (opts.font || 'Nirmala UI').replace(/[,:']/g, '');
    fs.writeFileSync(path.join(work, 'lyrics.ass'), lyricsAss(project.timeline.lines, font, { pops: opts.popwords === true, numbers: opts.numbers !== false }));
    fc.push(`[${last}]subtitles=lyrics.ass[vl]`);
    last = 'vl';
  }
  // Sound effects (made here, nothing downloaded): a soft whoosh on every new section, a light "pop" on echo words.
  let aOut = '1:a';
  if (opts.sfx !== false) {
    const ev = sfxEvents(scenes, project.timeline?.lines || [], { pops: opts.popwords === true }).slice(0, 60);
    if (ev.length) {
      ev.forEach((e, k) => {
        const ms = Math.round(e.t * 1000);
        fc.push(e.kind === 'whoosh'
          ? `anoisesrc=d=0.5:c=pink:a=0.6:r=48000,bandpass=f=1600:w=1400,afade=t=in:d=0.18,afade=t=out:st=0.2:d=0.3,volume=0.22,aformat=sample_rates=48000:channel_layouts=stereo,adelay=${ms}|${ms}[x${k}]`
          : `sine=f=1100:d=0.12:r=48000,afade=t=out:st=0.02:d=0.1,volume=0.10,aformat=sample_rates=48000:channel_layouts=stereo,adelay=${ms}|${ms}[x${k}]`);
      });
      fc.push(`[1:a]aformat=sample_rates=48000:channel_layouts=stereo[mus];[mus]${ev.map((_, k) => `[x${k}]`).join('')}amix=inputs=${ev.length + 1}:duration=first:dropout_transition=0:normalize=0[aout]`);
      aOut = '[aout]';
    }
  }
  // the song fades out over its last 1.8 s (Suno songs often stop abruptly) and the picture fades to the end card
  // the song plays to its very last note (only a 0.25 s fade so it does not click), then the outro starts
  const fadeAt = Math.max(0, songLen - 0.25).toFixed(2);
  fc.push(`[${aOut.replace(/[\[\]]/g, '')}]afade=t=out:st=${fadeAt}:d=0.25[afin]`); aOut = '[afin]';
  const mapV = fc.length ? `[${last}]` : '0:v';
  await ff([...inputs, ...(fc.length ? ['-filter_complex', fc.join(';')] : []), '-map', mapV, '-map', aOut, '-t', songLen.toFixed(3), ...enc, ...aenc, 'body.mp4'], { cwd: work });

  // 3. intro + body + outro
  const parts = [];
  let introLen = 0;
  // HOOK: the first 3 seconds show the most exciting moment of the song (with its own music and a big pop-up
  // question), then the brand intro — shortened so the song still starts at the same time as before.
  let hookLen = 0;
  if (opts.hook !== false) {
    try {
      onStep('Making the 3-second hook');
      hookLen = await makeHook(work, dir, project, scenes, audio, (opts.font || 'Nirmala UI').replace(/[,:']/g, ''));
    } catch (e) { onStep('Hook skipped: ' + e.message.slice(0, 120)); hookLen = 0; }
  }
  for (const [key, name] of [['intro', 'intro.mp4'], ['outro', 'outro.mp4']]) {
    const src = path.join(brandDir, name);
    if (opts[key] && fs.existsSync(src)) {
      onStep(`Preparing ${key}`);
      const full = key === 'intro' ? (await probe(src)).duration : 0;
      await normalizeClip(src, path.join(work, key + '.mp4'), key === 'intro' && hookLen ? Math.max(3, full - hookLen) : 0, { fillFrame: true });
      if (key === 'intro') introLen = (await probe(path.join(work, 'intro.mp4'))).duration;
    }
  }
  if (hookLen) { parts.push('hook.mp4'); introLen += hookLen; }
  if (fs.existsSync(path.join(work, 'intro.mp4')) && opts.intro) parts.push('intro.mp4');
  parts.push('body.mp4');
  // HyperFrames end card (warm goodbye + logo over the last picture) before the brand outro.
  if (useHF && opts.endcard !== false) {
    try {
      onStep('HyperFrames: end card');
      const last = [...scenes].reverse().find((x) => x.image);
      const lines = { kn: ['ಮತ್ತೆ ಸಿಗೋಣ!', ''], hi: ['फिर मिलेंगे!', ''], en: ['See you next time!', ''] };
      const [line, sub] = ch.end_card ? [ch.end_card.line, ch.end_card.sub] : lines[ch.lang_code] || lines.en;
      const logoP = path.join(brandDir, 'logo.png');
      await hf.endCard({ image: last && path.join(dir, last.image), logo: fs.existsSync(logoP) ? logoP : null, line, sub: sub || ch.name, color: ch.brand_color || '#ffd400', dur: 6 }, path.join(work, 'hf_end_raw.mp4'));
      await normalizeClip(path.join(work, 'hf_end_raw.mp4'), path.join(work, 'endcard.mp4'));
      parts.push('endcard.mp4');
    } catch (e) { onStep('HyperFrames end card skipped: ' + e.message.slice(0, 120)); }
  }
  if (fs.existsSync(path.join(work, 'outro.mp4')) && opts.outro) parts.push('outro.mp4');
  fs.writeFileSync(path.join(work, 'final.txt'), parts.map((p) => `file '${p}'`).join('\n'));
  onStep('Joining intro, video and outro');
  await ff(['-f', 'concat', '-safe', '0', '-i', 'final.txt', '-c', 'copy', '-movflags', '+faststart', path.join(dir, 'final.mp4')], { cwd: work });

  // captions file for YouTube (times shifted by the intro)
  if (project.timeline?.lines?.length) fs.writeFileSync(path.join(dir, 'captions.srt'), makeSrt(project.timeline.lines, introLen));
  const info = await probe(path.join(dir, 'final.mp4'));
  fs.rmSync(work, { recursive: true, force: true });
  return { file: 'final.mp4', duration: +info.duration.toFixed(2), intro_len: +introLen.toFixed(2), song_len: +songLen.toFixed(2), parts };
}

// ---------- kids-style edit helpers ----------
const assTime = (t) => { const cs = Math.max(0, Math.round(t * 100)); const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), x = Math.floor((cs % 6000) / 100); return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; };
const assClean = (t) => String(t || '').replace(/[{}\\]/g, '').replace(/[\p{Extended_Pictographic}️‍]/gu, '').trim();
function splitEcho(text) {
  const m = String(text || '').match(/^(.*?)\s*\(([^()]{1,40})\)\s*$/);
  return m ? { main: m[1].trim(), echo: m[2].trim() } : { main: String(text || '').trim(), echo: '' };
}
// Spacing must stay 0: letter spacing breaks Kannada/Hindi letter joining in libass.
function lyricsAss(lines, font, { pops = true, numbers = true } = {}) {
  const { isInstrumental } = require('./timeline');
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `Style: Lyric,${font},74,&H0000E6FF,&H0000E6FF,&H00201010,&H64000000,1,0,0,0,100,100,0,0,1,6,2,2,120,120,60,1\n` +
    `Style: Num,Arial Black,230,&H0000D7FF,&H0000D7FF,&H00FFFFFF,&H96000000,1,0,0,0,100,100,0,0,1,14,6,9,90,90,60,1\n` +
    `Style: Pop,${font},132,&H00FFFFFF,&H00FFFFFF,&H00B03A0A,&H96000000,1,0,0,0,100,100,0,0,1,11,5,8,80,80,36,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const ev = [];
  const colours = ['&H0000D7FF', '&H0066FF66', '&H00FF9E3D', '&H00FF66CC', '&H0033CCFF'];
  lines.filter((l) => l.text && !isInstrumental(l.text) && !l.instrumental).forEach((l, i) => {
    const { main, echo } = splitEcho(l.text);
    if (main) ev.push(`Dialogue: 0,${assTime(l.start)},${assTime(l.end)},Lyric,,0,0,0,,{\\fad(120,120)}${assClean(main)}`);
    if (pops && echo) {
      const a = Math.max(l.start + 0.6, l.end - 1.5), b = l.end + 0.15;
      ev.push(`Dialogue: 1,${assTime(a)},${assTime(b)},Pop,,0,0,0,,{\\fad(60,150)\\1c${colours[i % colours.length]}\\fscx40\\fscy40\\t(0,180,\\fscx118\\fscy118)\\t(180,320,\\fscx100\\fscy100)}${assClean(echo)}`);
    }
  });
  if (numbers) ev.push(...numberEvents(lines));
  return head + ev.join('\n') + '\n';
}
// Counting lines (ಒಂದು ಎರಡು …) get big numerals on screen, one after the other, top-right.
const KN_NUM = [['ಒಂಬತ್ತು', 9], ['ಒಂದು', 1], ['ಎರಡು', 2], ['ಮೂರು', 3], ['ನಾಲ್ಕು', 4], ['ಐದು', 5], ['ಆರು', 6], ['ಏಳು', 7], ['ಎಂಟು', 8], ['ಹತ್ತು', 10]];
const HI_NUM = [['एक', 1], ['दो', 2], ['तीन', 3], ['चार', 4], ['पांच', 5], ['पाँच', 5], ['छह', 6], ['सात', 7], ['आठ', 8], ['नौ', 9], ['दस', 10]];
const EN_NUM = [['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10]];
function numbersIn(text) {
  const main = splitEcho(text).main;
  const found = [];
  for (const [w, n] of [...KN_NUM, ...HI_NUM]) { let i = main.indexOf(w); while (i >= 0) { if (!found.some((f) => i >= f.i && i < f.i + f.len)) found.push({ i, n, len: w.length }); i = main.indexOf(w, i + 1); } }
  for (const [w, n] of EN_NUM) { const m = new RegExp('\\b' + w + '\\b', 'gi'); let r; while ((r = m.exec(main))) found.push({ i: r.index, n, len: w.length }); }
  return found.sort((a, b) => a.i - b.i).map((f) => f.n);
}
function numberEvents(lines) {
  const ev = [];
  const colours = ['&H0000D7FF', '&H0066FF66', '&H00FF9E3D', '&H00FF66CC', '&H0033CCFF'];
  for (const l of lines) {
    const nums = numbersIn(l.text);
    if (!nums.length || nums.length > 3) continue;
    const span = (l.end - l.start) / nums.length;
    nums.forEach((n, k) => {
      const a = l.start + k * span, b = k === nums.length - 1 ? l.end + 0.2 : a + span;
      ev.push(`Dialogue: 2,${assTime(a)},${assTime(b)},Num,,0,0,0,,{\\fad(80,120)\\1c${colours[n % colours.length]}\\fscx40\\fscy40\\t(0,200,\\fscx115\\fscy115)\\t(200,340,\\fscx100\\fscy100)}${n}`);
    });
  }
  return ev;
}
function sfxEvents(scenes, lines, { pops = true } = {}) {
  const ev = [];
  scenes.forEach((s, i) => { if (i > 0 && s.section && s.section !== scenes[i - 1].section) ev.push({ kind: 'whoosh', t: Math.max(0, s.start - 0.12) }); });
  if (pops) for (const l of lines) if (splitEcho(l.text).echo) ev.push({ kind: 'pop', t: Math.max(l.start + 0.6, l.end - 1.5) });
  return ev.sort((a, b) => a.t - b.t);
}
// 3-second hook: the liveliest clip from the story's peak, its own music, a whoosh and the big curiosity words.
async function makeHook(work, dir, project, scenes, audio, font) {
  const songLen = (await probe(audio)).duration;
  const lo = songLen * 0.35, hi = songLen * 0.85;
  const cands = scenes.filter((s) => s.video && s.start >= lo && s.end <= hi && fs.existsSync(path.join(dir, s.video)));
  if (!cands.length) throw new Error('no clip for the hook');
  const words = assClean(project.publish?.thumbnail_text || project.song?.title_native || project.title).slice(0, 30);
  // The hook must SHOW what the words ask: a scene whose lyric has the hook words, else the thumbnail's picture,
  // else the best-scored lively clip of the story's peak.
  const key = words.replace(/[?!.,]/g, '').split(/\s+/).filter((w) => w.length > 2);
  const byWords = key.length ? scenes.filter((s) => s.video && key.some((w) => String(s.lyric || '').includes(w)) && fs.existsSync(path.join(dir, s.video))) : [];
  const thumbImg = project.publish?.thumb_pick?.image;
  const byThumb = thumbImg ? cands.concat(scenes.filter((s) => s.video && fs.existsSync(path.join(dir, s.video)))).filter((s) => s.image === thumbImg) : [];
  const rank = (a, b) => ((b.clip_check?.score ?? 0) - (a.clip_check?.score ?? 0)) || ((b.clip_check?.motion ?? 0) - (a.clip_check?.motion ?? 0));
  const best = (byWords.length ? byWords : byThumb.length ? byThumb : cands).sort(rank)[0];
  const L = 3;
  fs.writeFileSync(path.join(work, 'hook.ass'), `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: H,${font},170,&H0000E6FF,&H0000E6FF,&H00100808,&H96000000,1,0,0,0,100,100,0,0,1,14,6,8,80,80,90,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.15,0:00:03.00,H,,0,0,0,,{\\fscx30\\fscy30\\t(0,220,\\fscx115\\fscy115)\\t(220,380,\\fscx100\\fscy100)}${words}\n`);
  const t0 = Math.max(0, best.start);
  await ff(['-i', path.join(dir, best.video), '-ss', t0.toFixed(2), '-t', String(L), '-i', audio,
    '-filter_complex', `[0:v]setpts=PTS-STARTPTS,${frame(720, L, { drift: 'right' })},fps=${FPS},tpad=stop_mode=clone:stop_duration=3,trim=duration=${L},setpts=PTS-STARTPTS,subtitles=hook.ass,fade=t=out:st=${L - 0.2}:d=0.2:color=white[v];` +
    `anoisesrc=d=0.5:c=pink:a=0.6:r=48000,bandpass=f=1600:w=1400,afade=t=in:d=0.15,afade=t=out:st=0.2:d=0.3,volume=0.3,aformat=sample_rates=48000:channel_layouts=stereo[w];` +
    `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,afade=t=in:d=0.15,afade=t=out:st=${L - 0.5}:d=0.5[m];[m][w]amix=inputs=2:duration=first:normalize=0[a]`,
    '-map', '[v]', '-map', '[a]', '-t', String(L), ...enc, ...aenc, 'hook.mp4'], { cwd: work });
  return L;
}

async function grabFrame(dir, video, t, out) {
  await ff(['-ss', String(t), '-i', path.join(dir, video), '-frames:v', '1', '-vf', 'scale=1280:720', '-q:v', '2', path.join(dir, out)]);
  return out;
}

// Vertical Shorts (1080×1920) with a blurred background, from the finished video.
// A hook title sits in the empty band above the picture (the karaoke line is already in the picture).
async function makeShort(dir, start, len, out, { title = '', font = 'Nirmala UI' } = {}) {
  let vf = '[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:2,eq=brightness=-0.08[bg];' +
    '[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1';
  const hook = String(title || '').split('|')[0].replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').replace(/[{}\\]/g, '').trim();
  const ass = path.join(dir, out.replace(/\.mp4$/, '') + '_hook.ass');
  if (hook) {
    fs.writeFileSync(ass, `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: H,${font.replace(/[,:']/g, '')},92,&H0000E6FF,&H0000E6FF,&H00100808,&H96000000,1,0,0,0,100,100,0,0,1,8,4,8,60,60,330,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,9:00:00.00,H,,0,0,0,,${hook}\n`);
    vf += `,subtitles=${path.basename(ass)}`;
  }
  vf += '[v]';
  await ff(['-ss', String(start), '-t', String(Math.min(len, 59)), '-i', 'final.mp4',
    '-filter_complex', vf, '-map', '[v]', '-map', '0:a?', ...enc, ...aenc, '-movflags', '+faststart', out], { cwd: dir });
  fs.rmSync(ass, { force: true });
  return out;
}

// Quality gate for the finished video: frozen picture, black screens, loudness, length.
async function qa(file, { expected } = {}) {
  const info = await probe(file);
  const { err } = await ff(['-i', file, '-vf', 'freezedetect=n=0.003:d=2.5,blackdetect=d=2:pix_th=0.08', '-af', 'ebur128', '-f', 'null', '-']);
  const freezes = [...err.matchAll(/freeze_duration: ([\d.]+)/g)].map((m) => +m[1]);
  const blacks = [...err.matchAll(/black_duration:([\d.]+)/g)].map((m) => +m[1]);
  const lufs = +((err.match(/I:\s+(-?[\d.]+) LUFS/g) || []).pop()?.match(/-?[\d.]+/)?.[0] ?? NaN);
  const problems = [];
  if (freezes.length) problems.push(`${freezes.length} frozen moment(s), longest ${Math.max(...freezes).toFixed(1)} s`);
  if (blacks.length) problems.push(`${blacks.length} black screen(s) over 2 s`);
  if (!isNaN(lufs) && lufs < -26) problems.push(`too quiet (${lufs} LUFS)`);
  if (!info.hasAudio) problems.push('no sound');
  if (expected && Math.abs(info.duration - expected) > 3) problems.push(`length ${info.duration.toFixed(1)} s, expected about ${expected.toFixed(1)} s`);
  return { ok: problems.length === 0, problems, duration: +info.duration.toFixed(2), lufs: isNaN(lufs) ? null : lufs, freezes: freezes.length, blacks: blacks.length };
}

module.exports = { qa, ffmpegOk, probe, analyzeAudio, renderEdit, sceneSegment, grabFrame, makeShort, makeSrt };
