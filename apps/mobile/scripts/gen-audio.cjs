#!/usr/bin/env node
/**
 * Placeholder sound effects and the bundler's audio table.
 *
 *   node scripts/gen-audio.cjs          (from apps/mobile)
 *
 * 1. For every cue in assets/audio/manifest.json marked "placeholder": true, synthesises a short mono
 *    16-bit WAV (sine tones and filtered noise, deterministic) at the manifest's path. Cues marked
 *    "placeholder": false are commissioned recordings and are never touched; if their file is missing
 *    the app simply does without that sound (a voice call then shows as a banner only).
 * 2. Writes src/audio/sources.ts: one static require() per cue whose file exists, because the bundler
 *    can only include assets named literally in the source.
 *
 * Fails if any file is over the manifest's maxBytes.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AUDIO = path.join(ROOT, 'assets', 'audio');
const manifest = JSON.parse(fs.readFileSync(path.join(AUDIO, 'manifest.json'), 'utf8'));
const RATE = manifest.sampleRate;

// ---- synthesis ---------------------------------------------------------------------------------------

/** Deterministic PRNG so regenerated files are byte-identical. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const buffer = (seconds) => new Float32Array(Math.round(seconds * RATE));

/** Adds a sine tone with an attack/decay envelope, optionally gliding from `hz` to `toHz`. */
function tone(buf, { at = 0, dur, hz, toHz = hz, gain = 0.5, attack = 0.005, harmonics = [1] }) {
  const start = Math.round(at * RATE);
  const n = Math.round(dur * RATE);
  let phase = 0;
  for (let i = 0; i < n && start + i < buf.length; i++) {
    const t = i / RATE;
    const f = hz + (toHz - hz) * (i / n);
    phase += (2 * Math.PI * f) / RATE;
    const env = Math.min(1, t / attack) * Math.exp((-5 * i) / n);
    let v = 0;
    harmonics.forEach((h, k) => (v += Math.sin(phase * (k + 1)) * h));
    buf[start + i] += v * env * gain;
  }
}

/** Adds a burst of low-passed noise: the body of a click or clack. */
function noise(buf, { at = 0, dur, gain = 0.5, smooth = 0.3, seed = 1 }) {
  const r = rng(seed);
  const start = Math.round(at * RATE);
  const n = Math.round(dur * RATE);
  let y = 0;
  for (let i = 0; i < n && start + i < buf.length; i++) {
    y += smooth * (r() * 2 - 1 - y);
    buf[start + i] += y * Math.exp((-7 * i) / n) * gain;
  }
}

const RECIPES = {
  'sfx.draw': () => {
    const b = buffer(0.12);
    noise(b, { dur: 0.11, gain: 0.5, smooth: 0.08, seed: 11 });
    tone(b, { at: 0.01, dur: 0.08, hz: 520, toHz: 640, gain: 0.08 });
    return b;
  },
  'sfx.discard': () => {
    const b = buffer(0.16);
    noise(b, { dur: 0.05, gain: 0.9, smooth: 0.55, seed: 7 });
    tone(b, { dur: 0.14, hz: 1350, gain: 0.35, attack: 0.001, harmonics: [1, 0.4, 0.2] });
    tone(b, { at: 0.004, dur: 0.1, hz: 290, gain: 0.3, attack: 0.001 });
    return b;
  },
  'sfx.drawGame': () => {
    const b = buffer(0.55);
    tone(b, { dur: 0.26, hz: 440, toHz: 420, gain: 0.35, attack: 0.02, harmonics: [1, 0.3] });
    tone(b, { at: 0.24, dur: 0.3, hz: 330, toHz: 300, gain: 0.35, attack: 0.02, harmonics: [1, 0.3] });
    return b;
  },
  'sfx.fanfare': () => {
    const b = buffer(0.6);
    [523.25, 659.25, 783.99].forEach((hz, i) => tone(b, { at: i * 0.09, dur: 0.18, hz, gain: 0.28, harmonics: [1, 0.5, 0.25] }));
    [1046.5, 1318.5, 1568].forEach((hz) => tone(b, { at: 0.27, dur: 0.33, hz, gain: 0.16, attack: 0.01, harmonics: [1, 0.3] }));
    return b;
  },
  'sfx.tick': () => {
    const b = buffer(0.06);
    tone(b, { dur: 0.05, hz: 1900, gain: 0.4, attack: 0.001 });
    noise(b, { dur: 0.015, gain: 0.3, smooth: 0.7, seed: 3 });
    return b;
  },
  'sfx.tap': () => {
    const b = buffer(0.045);
    tone(b, { dur: 0.04, hz: 880, toHz: 1100, gain: 0.3, attack: 0.001 });
    return b;
  },
  // Voice placeholders: not speech, but a distinct musical motif per call so each is recognisable.
  'voice.mandarin.chi': () => {
    const b = buffer(0.3);
    tone(b, { dur: 0.12, hz: 660, gain: 0.45, harmonics: [1, 0.4] });
    tone(b, { at: 0.13, dur: 0.15, hz: 880, gain: 0.45, harmonics: [1, 0.4] });
    return b;
  },
  'voice.mandarin.pong': () => {
    const b = buffer(0.32);
    noise(b, { dur: 0.04, gain: 0.6, smooth: 0.4, seed: 21 });
    tone(b, { dur: 0.3, hz: 392, toHz: 370, gain: 0.55, attack: 0.002, harmonics: [1, 0.6, 0.3] });
    return b;
  },
  'voice.mandarin.kong': () => {
    const b = buffer(0.42);
    [392, 392, 523.25].forEach((hz, i) => tone(b, { at: i * 0.12, dur: 0.14, hz, gain: 0.45, harmonics: [1, 0.5, 0.2] }));
    return b;
  },
  'voice.mandarin.hu': () => {
    const b = buffer(0.45);
    tone(b, { dur: 0.42, hz: 523.25, toHz: 784, gain: 0.4, attack: 0.01, harmonics: [1, 0.5, 0.3] });
    tone(b, { dur: 0.42, hz: 659.25, toHz: 987.8, gain: 0.25, attack: 0.01 });
    return b;
  },
  'voice.mandarin.selfdraw': () => {
    const b = buffer(0.5);
    [523.25, 659.25, 783.99, 1046.5].forEach((hz, i) => tone(b, { at: i * 0.08, dur: 0.2, hz, gain: 0.35, harmonics: [1, 0.4] }));
    return b;
  },
};

function wav(samples) {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const scale = peak > 0.98 ? 0.98 / peak : 1;
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s * scale)) * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// ---- run -------------------------------------------------------------------------------------------

let bad = 0;
for (const cue of manifest.cues) {
  const file = path.join(AUDIO, cue.file);
  if (cue.placeholder) {
    const recipe = RECIPES[cue.id];
    if (!recipe) {
      console.error(`no placeholder recipe for ${cue.id}`);
      bad++;
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, wav(recipe()));
  }
  if (fs.existsSync(file) && fs.statSync(file).size > manifest.maxBytes) {
    console.error(`${cue.file} is ${fs.statSync(file).size} bytes (limit ${manifest.maxBytes})`);
    bad++;
  }
}

const present = manifest.cues.filter((c) => fs.existsSync(path.join(AUDIO, c.file)));
const lines = present.map((c) => `  '${c.id}': require('../../assets/audio/${c.file}'),`);
const out = `// Generated by scripts/gen-audio.cjs from assets/audio/manifest.json — do not edit by hand.
// One static require per cue whose file exists; a cue missing here is silent (voice calls fall back to the banner).
/* eslint-disable @typescript-eslint/no-require-imports */
export const AUDIO_SOURCES: Record<string, number> = {
${lines.join('\n')}
};
`;
fs.writeFileSync(path.join(ROOT, 'src', 'audio', 'sources.ts'), out);
console.log(`audio: ${present.length}/${manifest.cues.length} cues present, sources.ts written`);
if (bad) process.exit(1);
