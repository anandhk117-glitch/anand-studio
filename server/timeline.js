// Turns lyrics (or a narration script) + audio length into timed lines and 5–10 s scenes.
// If real word timestamps exist (Suno aligned words, Whisper), they are used instead of estimates.

const TAG = /^\s*\[([^\]]+)\]\s*$/;
// "[INSTRUMENTAL] rooster crow", "[Music]", "(instrumental)" → no words sung here
const isInstrumental = (t) => !String(t || '').trim() || /^\s*[\[(]\s*(instrumental|music|inst\b|intro music|outro music|break)[^\])]*[\])]/i.test(t) || /^\s*\[[^\]]*\]\s*$/.test(t);

function parseLyrics(text) {
  const out = [];
  let section = 'Verse';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(TAG);
    if (m) { section = m[1]; continue; }
    out.push({ section, text: line });
  }
  return out;
}

// Estimate when each line is sung: spread lines over the vocal part, weighted by length,
// with a short breath between sections. Marked "estimated" so you know to check it.
function estimateLines(lyrics, duration, { vocalStart = 6, outro = 6, gap = 1.6 } = {}) {
  const lines = parseLyrics(lyrics);
  if (!lines.length || !duration) return [];
  const sectionBreaks = lines.filter((l, i) => i > 0 && l.section !== lines[i - 1].section).length;
  const start = Math.min(vocalStart, duration * 0.15);
  const usable = Math.max(10, duration - start - outro - sectionBreaks * gap);
  const weight = (l) => [...l.text].length + 10;
  const total = lines.reduce((a, l) => a + weight(l), 0);
  let t = start;
  const out = [];
  lines.forEach((l, i) => {
    if (i > 0 && l.section !== lines[i - 1].section) t += gap;
    const d = (weight(l) / total) * usable;
    out.push({ n: i + 1, start: +t.toFixed(2), end: +(t + d).toFixed(2), section: l.section, text: l.text, estimated: true });
    t += d;
  });
  return out;
}

// Narration: same idea, one line per sentence-ish chunk.
function estimateNarration(script, duration, { start = 1.5, outro = 3 } = {}) {
  const sections = [];
  let section = 'Opening';
  for (const raw of String(script || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(TAG) || line.match(/^#+\s*(.+)$/);
    if (m) { section = m[1]; continue; }
    for (const chunk of line.split(/(?<=[.!?])\s+/)) if (chunk.trim()) sections.push({ section, text: chunk.trim() });
  }
  const words = (s) => s.text.split(/\s+/).length + 1;
  const total = sections.reduce((a, s) => a + words(s), 0) || 1;
  const usable = Math.max(10, duration - start - outro);
  let t = start;
  return sections.map((s, i) => {
    const d = (words(s) / total) * usable;
    const row = { n: i + 1, start: +t.toFixed(2), end: +(t + d).toFixed(2), section: s.section, text: s.text, estimated: true };
    t += d;
    return row;
  });
}

// Lines → contiguous scenes covering 0…duration, each 5–10 s.
function buildScenes(lines, duration, { min = 5, max = 10 } = {}) {
  min = +min || 5; max = Math.max(+max || 10, min + 1);
  const segs = [];
  let t = 0;
  const sorted = [...lines].sort((a, b) => a.start - b.start);
  for (const l of sorted) {
    if (l.start - t > 0.3) segs.push({ start: t, end: l.start, text: '', section: 'Instrumental', instrumental: true });
    const inst = isInstrumental(l.text);
    segs.push({ start: Math.max(t, l.start), end: Math.max(l.end, l.start + 0.5), text: inst ? '' : l.text, section: l.section, instrumental: inst });
    t = Math.max(t, l.end);
  }
  if (duration - t > 0.3) segs.push({ start: t, end: duration, text: '', section: 'Outro', instrumental: true });

  // tiny breaths between lines belong to the line before
  const merged = [];
  for (const s of segs) {
    const prev = merged[merged.length - 1];
    if (s.instrumental && prev && s.end - s.start < 1.5) prev.end = s.end;
    else merged.push({ ...s });
  }
  // split anything longer than max into equal parts
  const pieces = [];
  for (const s of merged) {
    const len = s.end - s.start;
    const n = Math.max(1, Math.ceil(len / max));
    for (let k = 0; k < n; k++) pieces.push({ ...s, start: s.start + (len * k) / n, end: s.start + (len * (k + 1)) / n, cont: k > 0 });
  }
  // greedy: grow each scene to about 7–8 s, never past max
  const target = (min + max) / 2 + 0.5;
  const scenes = [];
  let cur = null;
  const open = (p) => ({ start: p.start, end: p.end, parts: [p] });
  for (const p of pieces) {
    if (!cur) { cur = open(p); continue; }
    const curLen = cur.end - cur.start, both = p.end - cur.start;
    if (both <= max && (curLen < min || both <= target)) { cur.end = p.end; cur.parts.push(p); }
    else { scenes.push(cur); cur = open(p); }
  }
  if (cur) scenes.push(cur);
  // a scene that is still too short joins its shorter neighbour if that fits
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    if (s.end - s.start >= min || scenes.length < 2) continue;
    const prev = scenes[i - 1], next = scenes[i + 1];
    const withPrev = prev ? s.end - prev.start : Infinity, withNext = next ? next.end - s.start : Infinity;
    if (Math.min(withPrev, withNext) > max + 1.5) continue;
    if (withPrev <= withNext) { prev.end = s.end; prev.parts.push(...s.parts); }
    else { next.start = s.start; next.parts.unshift(...s.parts); }
    scenes.splice(i, 1); i--;
  }
  let longest = -1, longestLen = 0;
  const out = scenes.map((s, i) => {
    const len = s.end - s.start;
    const sung = s.parts.filter((p) => p.text);
    const lyrics = sung.filter((p) => !p.cont).map((p) => p.text);
    const instrumental = !sung.length;
    if (instrumental && len > longestLen) { longest = i; longestLen = len; }
    return {
      n: i + 1, start: +s.start.toFixed(2), end: +s.end.toFixed(2), len: +len.toFixed(2),
      section: instrumental ? (i === 0 ? 'Intro' : i === scenes.length - 1 ? 'Outro' : 'Instrumental') : sung[0].section,
      lyric: lyrics.length ? lyrics.join(' / ') : sung.length ? '(continues) ' + sung[0].text : '', clip_len: len > 6.2 ? 10 : 6,
    };
  });
  if (longest >= 0) out[longest].setpiece = true;
  return out;
}

// Suno aligned words → lines. Expects [{word, start_s, end_s}] or [{word,start,end}].
function linesFromWords(lyrics, words) {
  const lines = parseLyrics(lyrics);
  const w = (words || []).map((x) => ({ word: String(x.word || '').trim(), start: +(x.start_s ?? x.start), end: +(x.end_s ?? x.end) }))
    .filter((x) => x.word && !isNaN(x.start));
  if (!w.length) return null;
  let wi = 0;
  return lines.map((l, i) => {
    const count = Math.max(1, l.text.split(/\s+/).length);
    const chunk = w.slice(wi, wi + count);
    wi += count;
    const s = chunk[0]?.start ?? (w[w.length - 1].end);
    const e = chunk[chunk.length - 1]?.end ?? s + 2;
    return { n: i + 1, start: +s.toFixed(2), end: +e.toFixed(2), section: l.section, text: l.text, estimated: !chunk.length };
  });
}

module.exports = { isInstrumental, parseLyrics, estimateLines, estimateNarration, buildScenes, linesFromWords };
