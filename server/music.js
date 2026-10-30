// Original background music made by code on this PC — nothing downloaded, nothing licensed, so no copyright claims.
// A light, modern "documentary pulse" bed: soft pad chords, a plucked arpeggio, a gentle kick and shaker.
// Written as a 16-bit stereo WAV. Mixed far under the voice and ducked further whenever someone speaks.
const fs = require('fs');

const SR = 44100;
const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDI → Hz

// Progressions (MIDI root notes) — three moods so Shorts don't all sound the same.
const STYLES = {
  tension: { bpm: 100, chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]] }, // Am F C G
  mystery: { bpm: 92, chords: [[50, 53, 57], [46, 50, 53], [53, 57, 60], [52, 55, 59]] },   // Dm Bb F Em
  upbeat: { bpm: 112, chords: [[48, 52, 55], [55, 59, 62], [57, 60, 64], [53, 57, 60]] },   // C G Am F
};

function make(file, { style = 'tension', seconds = 190, seed = 1 } = {}) {
  const st = STYLES[style] || STYLES.tension;
  const beat = 60 / st.bpm, bar = beat * 4;
  const N = Math.floor(seconds * SR);
  const L = new Float32Array(N), R = new Float32Array(N);
  let rnd = seed * 9301 + 49297; const rand = () => ((rnd = (rnd * 9301 + 49297) % 233280) / 233280);
  let lpL = 0, lpR = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const barIdx = Math.floor(t / bar), chord = st.chords[barIdx % st.chords.length];
    const tb = t % bar, tbeat = t % beat, t8 = t % (beat / 2), step8 = Math.floor(tb / (beat / 2));
    // pad: three slightly detuned saw-ish tones per chord note, slow swell each bar
    let pad = 0;
    for (const n of chord) for (const det of [-0.12, 0, 0.11]) {
      const f = NOTE(n + det); const ph = (t * f) % 1;
      pad += (2 * ph - 1) * 0.6 + Math.sin(2 * Math.PI * f * t) * 0.4;
    }
    pad *= 0.018 * (0.55 + 0.45 * Math.min(1, tb / 0.6)) * (1 - 0.25 * Math.max(0, (tb - bar + 0.4) / 0.4));
    // arpeggio pluck on 8ths, an octave up
    const an = chord[[0, 1, 2, 1, 0, 2, 1, 2][step8 % 8]] + 12;
    const af = NOTE(an);
    const arp = (Math.sin(2 * Math.PI * af * t8) + 0.3 * Math.sin(4 * Math.PI * af * t8)) * Math.exp(-7 * t8) * 0.055;
    // bass on the beat
    const bf = NOTE(chord[0] - 12);
    const bass = Math.sin(2 * Math.PI * bf * t) * 0.07 * Math.exp(-2.2 * tbeat);
    // soft kick on beats 1 and 3, shaker on off-beats
    const beatInBar = Math.floor(tb / beat);
    const kick = (beatInBar % 2 === 0) ? Math.sin(2 * Math.PI * (48 + 90 * Math.exp(-30 * tbeat)) * tbeat) * Math.exp(-9 * tbeat) * 0.16 : 0;
    const shk = (t8 > beat / 4 - 0.002 && t8 < beat / 4 + 0.05) ? (rand() * 2 - 1) * 0.018 * Math.exp(-60 * (t8 - beat / 4)) : 0;
    // gentle low-pass on the pad so it never fights the voice
    lpL += 0.06 * (pad - lpL); lpR += 0.06 * (pad * 0.97 - lpR);
    const fadeIn = Math.min(1, t / 1.5), fadeOut = Math.min(1, (seconds - t) / 3);
    const g = fadeIn * fadeOut;
    L[i] = (lpL + arp * 0.9 + bass + kick + shk) * g;
    R[i] = (lpR + arp * 1.1 + bass + kick + shk * 0.8) * g;
  }
  // normalise to about -14 dBFS peak (it is mixed much lower later)
  let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const k = peak ? 0.2 / peak : 1;
  const buf = Buffer.alloc(44 + N * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
  for (let i = 0; i < N; i++) {
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(L[i] * k * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(R[i] * k * 32767))), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
  return file;
}

module.exports = { make, STYLES };
