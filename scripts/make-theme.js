/**
 * Generates the default theme audio: assets/audio/theme.wav
 *
 * This is an ORIGINAL composition written for this project — a driving synth
 * ostinato meant to sit under the scanner bar. It is not, and is not derived
 * from, the Knight Rider theme, which is still under copyright and cannot be
 * redistributed in this repo. To use the real thing on your own cart, drop a
 * legally-obtained file at assets/audio/theme.mp3; the audio service prefers
 * it over this one (see config/audio.json).
 *
 * Everything is synthesised from scratch here rather than shipped as a binary,
 * so the repo stays text-only and the file is rebuilt by the installer.
 *
 *   node scripts/make-theme.js [--out PATH] [--bars N]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(here, '..');

const SAMPLE_RATE = 44100;
const BPM = 124;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;

// A minor. Each entry is one bar: a bass root plus the triad the arpeggio
// walks. Written as MIDI note numbers so the transposition stays readable.
const PROGRESSION = [
  { root: 45, triad: [57, 60, 64] }, // Am
  { root: 41, triad: [53, 57, 60] }, // F
  { root: 48, triad: [60, 64, 67] }, // C
  { root: 43, triad: [55, 59, 62] }, // G
];

const midiToFreq = (note) => 440 * 2 ** ((note - 69) / 12);

/** Exponential decay envelope with a short linear attack to kill clicks. */
function envelope(t, { attack = 0.004, decay }) {
  if (t < 0) return 0;
  if (t < attack) return t / attack;
  return Math.exp(-(t - attack) / decay);
}

// --- oscillators -----------------------------------------------------------
// Naive (non-bandlimited) shapes. At these frequencies through a cart speaker
// the aliasing is inaudible, and it keeps the generator dependency-free.

const saw = (phase) => 2 * (phase - Math.floor(phase + 0.5));
const square = (phase) => (phase % 1 < 0.5 ? 1 : -1);
const sine = (phase) => Math.sin(2 * Math.PI * phase);

/**
 * One-pole lowpass. Used both as a filter proper and, subtracted from the
 * input, as a cheap highpass for the hats.
 */
function lowpassCoefficient(cutoffHz) {
  return 1 - Math.exp((-2 * Math.PI * cutoffHz) / SAMPLE_RATE);
}

function render(bars) {
  const totalSeconds = bars * BAR;
  // A tail beyond the last bar lets the final notes ring out instead of being
  // chopped — which would also click audibly at the loop point.
  const length = Math.ceil((totalSeconds + 0.6) * SAMPLE_RATE);
  const out = new Float32Array(length);

  // Filter state has to persist across samples, so it lives outside the loop.
  let bassLp = 0;
  let hatLp = 0;

  // Deterministic noise: a fixed seed means every build of the same source
  // produces a byte-identical file.
  let seed = 0x2f6e2b1;
  const noise = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed |= 0;
    return (seed / 0x7fffffff) % 1;
  };

  for (let i = 0; i < length; i += 1) {
    const t = i / SAMPLE_RATE;
    const bar = Math.floor(t / BAR);
    const chord = PROGRESSION[bar % PROGRESSION.length];
    const inSong = t < totalSeconds;

    const beatPos = (t % BAR) / BEAT; // 0..4 within the bar
    const beat = Math.floor(beatPos);

    let sample = 0;

    // --- bass: straight eighths, the engine of the whole thing ---
    const eighth = Math.floor((t % BAR) / (BEAT / 2));
    const eighthStart = eighth * (BEAT / 2);
    const tb = (t % BAR) - eighthStart;
    if (inSong) {
      const freq = midiToFreq(chord.root);
      const env = envelope(tb, { decay: 0.16 });
      // Filter sweep tied to the same envelope: the classic synth-bass "pluck".
      const cutoff = 220 + 2600 * env;
      const raw = saw(t * freq) * env * 0.55;
      bassLp += (raw - bassLp) * lowpassCoefficient(cutoff);
      sample += bassLp;
    }

    // --- arpeggio: sixteenths through the triad, up and back down ---
    const sixteenth = Math.floor((t % BAR) / (BEAT / 4));
    const ta = (t % BAR) - sixteenth * (BEAT / 4);
    if (inSong) {
      // 0,1,2,1 keeps the figure rocking rather than resetting each cycle.
      const shape = [0, 1, 2, 1];
      const note = chord.triad[shape[sixteenth % shape.length]];
      const freq = midiToFreq(note);
      const env = envelope(ta, { decay: 0.055 });
      // Two oscillators a few cents apart: the beating between them is what
      // gives a single mono voice some width.
      const voice = square(t * freq) + square(t * freq * 1.004);
      sample += voice * env * 0.09;
    }

    // --- kick on 1 and 3 ---
    if (inSong && (beat === 0 || beat === 2)) {
      const tk = beatPos - beat;
      const env = envelope(tk * BEAT, { decay: 0.09 });
      // Pitch drop from 130Hz to ~48Hz is what reads as a kick rather than a
      // low tom; the exponent controls how fast it falls.
      const freq = 48 + 82 * Math.exp(-(tk * BEAT) / 0.028);
      sample += sine(t * freq) * env * 0.7;
    }

    // --- snare on 2 and 4 ---
    if (inSong && (beat === 1 || beat === 3)) {
      const ts = (beatPos - beat) * BEAT;
      const env = envelope(ts, { decay: 0.075 });
      sample += (noise() * 0.8 + sine(t * 190) * 0.2) * env * 0.32;
    }

    // --- hats on the offbeat eighths ---
    if (inSong && eighth % 2 === 1) {
      const env = envelope(tb, { decay: 0.022 });
      const n = noise();
      hatLp += (n - hatLp) * lowpassCoefficient(6000);
      sample += (n - hatLp) * env * 0.18; // highpass = input minus lowpass
    }

    out[i] = sample;
  }

  return out;
}

/** Normalise to a fixed headroom, then soft-clip anything still hot. */
function normalise(samples, peak = 0.89) {
  let max = 0;
  for (const sample of samples) max = Math.max(max, Math.abs(sample));
  if (max === 0) return samples;

  const gain = peak / max;
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.tanh(samples[i] * gain);
  }
  return samples;
}

/** 16-bit mono PCM WAV. */
function encodeWav(samples) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // PCM header size
  buffer.writeUInt16LE(1, 20); // format: PCM
  buffer.writeUInt16LE(1, 22); // channels: mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }

  return buffer;
}

function main() {
  const args = process.argv.slice(2);
  const readFlag = (name, fallback) => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : args[index + 1];
  };

  const outPath = path.resolve(
    ROOT_DIR,
    readFlag('--out', path.join('assets', 'audio', 'theme.wav'))
  );
  const bars = Number(readFlag('--bars', 8));

  if (!Number.isInteger(bars) || bars < 1 || bars > 64) {
    console.error('--bars must be an integer between 1 and 64');
    process.exit(1);
  }

  const samples = normalise(render(bars));
  const wav = encodeWav(samples);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, wav);

  const seconds = (samples.length / SAMPLE_RATE).toFixed(1);
  console.log(
    `wrote ${path.relative(ROOT_DIR, outPath)} — ${seconds}s, ${bars} bars at ${BPM} BPM, ` +
      `${(wav.length / 1024).toFixed(0)} KB`
  );
}

main();
