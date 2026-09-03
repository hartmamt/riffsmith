// Drums: a synthesized metal kit (no samples to license) plus the drum lane
// model and a "follow the guitar" first pass.
//
// Lane rows, top to bottom (like a drum tab): crash · hi-hat · snare · kick.
// Tokens: "x" hit, "X" accent, "o" open hi-hat (hat row) / choke (crash row),
// "" rest. Rows are addressed by index like strings, so write_notes works.
import { Measure, Song, sigBeats } from "./model";

export const DRUM_ROWS = ["crash", "hat", "snare", "kick"] as const;
export type DrumRow = (typeof DRUM_ROWS)[number];
export const DRUM_LABELS = ["C", "H", "S", "K"];
export const ROW_INDEX: Record<DrumRow, number> = { crash: 0, hat: 1, snare: 2, kick: 3 };

// ---------------------------------------------------------------------------
// synthesis: each voice is rendered once into an AudioBuffer at the context's
// sample rate, then played like a sample (cheap at 16th-note density)

function noise(n: number, seed = 1): Float32Array {
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; out[i] = (s / 0x7fffffff) * 2 - 1; }
  return out;
}
function onePole(x: Float32Array, sr: number, hz: number, highpass = false): Float32Array {
  const a = Math.exp(-2 * Math.PI * hz / sr); const out = new Float32Array(x.length); let y = 0;
  for (let i = 0; i < x.length; i++) { y = a * y + (1 - a) * x[i]; out[i] = highpass ? x[i] - y : y; }
  return out;
}
function bandpass(x: Float32Array, sr: number, hz: number, q: number): Float32Array {
  // biquad bandpass (constant skirt gain)
  const w = 2 * Math.PI * hz / sr, alpha = Math.sin(w) / (2 * q);
  const b0 = alpha, b1 = 0, b2 = -alpha, a0 = 1 + alpha, a1 = -2 * Math.cos(w), a2 = 1 - alpha;
  const out = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y; out[i] = y;
  }
  return out;
}
const sat = (v: number, k: number) => Math.tanh(k * v) / Math.tanh(k);

function renderKick(sr: number): Float32Array {
  const n = Math.floor(sr * 0.5); const out = new Float32Array(n); let ph = 0;
  const click = onePole(onePole(noise(n, 7), sr, 3000, true), sr, 9000);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    // pitch drops 140 → 45 Hz in ~60 ms: the "punch", then the sustain tone
    const f = 45 + 95 * Math.exp(-t * 28);
    ph += 2 * Math.PI * f / sr;
    const body = Math.sin(ph) * Math.exp(-t * 9);
    const beater = click[i] * Math.exp(-t * 160) * 0.9;           // the beater's click (triggered-metal kick)
    const thump = Math.sin(ph * 0.5) * Math.exp(-t * 14) * 0.3;   // sub weight
    out[i] = sat(body * 1.1 + beater + thump, 1.8) * 0.95;
  }
  return out;
}
function renderSnare(sr: number, seed: number): Float32Array {
  const n = Math.floor(sr * 0.45); const out = new Float32Array(n);
  const wires = onePole(bandpass(noise(n, seed), sr, 4200, 0.6), sr, 1800, true);
  const crack = onePole(noise(n, seed + 3), sr, 6000, true);
  let p1 = 0, p2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f1 = 185 + 60 * Math.exp(-t * 40), f2 = 330 + 40 * Math.exp(-t * 40); // shell modes with a fast pitch drop
    p1 += 2 * Math.PI * f1 / sr; p2 += 2 * Math.PI * f2 / sr;
    const shell = (Math.sin(p1) * 0.7 + Math.sin(p2) * 0.4) * Math.exp(-t * 22);
    const snap = wires[i] * Math.exp(-t * 13) * 0.9 + crack[i] * Math.exp(-t * 90) * 0.6;
    out[i] = sat(shell * 0.8 + snap, 2.2) * 0.9;
  }
  return out;
}
function renderHat(sr: number, open: boolean, seed: number): Float32Array {
  const n = Math.floor(sr * (open ? 0.6 : 0.09)); const out = new Float32Array(n);
  // a cluster of inharmonic bands through a highpass reads as metal
  const src = noise(n, seed);
  const bands = [bandpass(src, sr, 6400, 4), bandpass(src, sr, 8900, 4), bandpass(src, sr, 11700, 5), bandpass(src, sr, 14500, 5)];
  const hp = onePole(src, sr, 7000, true);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = open ? Math.exp(-t * 6) : Math.exp(-t * 55);
    let v = hp[i] * 0.5; for (const b of bands) v += b[i] * 0.9;
    out[i] = sat(v * env, 1.5) * (open ? 0.5 : 0.55);
  }
  return out;
}
function renderCrash(sr: number, seed: number): Float32Array {
  const n = Math.floor(sr * 2.2); const out = new Float32Array(n);
  const src = noise(n, seed);
  const bands = [3100, 4700, 6200, 7900, 9800, 12400, 15100].map((hz, k) => bandpass(src, sr, hz, 3 + k * 0.4));
  const hp = onePole(src, sr, 3000, true);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = hp[i] * 0.35; for (const b of bands) v += b[i] * 1.1;
    const env = Math.exp(-t * 1.6) * (1 - Math.exp(-t * 400)); // fast bloom, long wash
    out[i] = sat(v * env, 1.3) * 0.6;
  }
  return out;
}

export class DrumKit {
  private buffers = new Map<string, AudioBuffer[]>();
  private out: GainNode;
  private rr = new Map<string, number>();
  constructor(private ctx: BaseAudioContext, outputTo: AudioNode) {
    this.out = ctx.createGain();
    this.out.gain.value = 0.2; // the voices are rendered hot; the rig runs around -13 dB RMS
    this.out.connect(outputTo);
    const sr = ctx.sampleRate;
    const mk = (data: Float32Array) => { const b = ctx.createBuffer(1, data.length, sr); b.getChannelData(0).set(data); return b; };
    this.buffers.set("kick", [mk(renderKick(sr))]);
    this.buffers.set("snare", [mk(renderSnare(sr, 11)), mk(renderSnare(sr, 23)), mk(renderSnare(sr, 37))]);
    this.buffers.set("hat", [mk(renderHat(sr, false, 5)), mk(renderHat(sr, false, 9))]);
    this.buffers.set("hatopen", [mk(renderHat(sr, true, 13))]);
    this.buffers.set("crash", [mk(renderCrash(sr, 17))]);
  }
  setLevel(x: number) { this.out.gain.value = 0.2 * x; }
  /** Play one hit. token: "x" | "X" (accent) | "o" (open hat / choked crash). */
  hit(row: DrumRow, token: string, when: number) {
    if (!token) return;
    const accent = token === "X";
    const key = row === "hat" && token === "o" ? "hatopen" : row;
    const set = this.buffers.get(key); if (!set) return;
    const i = (this.rr.get(key) ?? 0) % set.length; this.rr.set(key, i + 1);
    const src = this.ctx.createBufferSource(); src.buffer = set[i];
    const g = this.ctx.createGain();
    const base = row === "kick" ? 1.0 : row === "snare" ? 0.85 : row === "hat" ? 0.55 : 0.7;
    const vel = accent ? 1.0 : 0.72 + (this.ctx instanceof OfflineAudioContext ? 0 : (Math.random() - 0.5) * 0.06);
    g.gain.setValueAtTime(base * vel, when);
    if (row === "crash" && token === "o") { g.gain.setValueAtTime(base * vel, when + 0.25); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.32); } // choke
    src.connect(g).connect(this.out);
    src.start(when);
    src.stop(when + set[i].duration + 0.05);
  }
}

// ---------------------------------------------------------------------------
// lane model

export function emptyDrumCols(measure: Measure): string[][] {
  return measure.cols.map(() => Array(DRUM_ROWS.length).fill(""));
}
export function withDrumTrack(song: Song, on: boolean): Song {
  if (!on) return { ...song, drums: undefined, measures: song.measures.map((m) => ({ ...m, drums: undefined })) };
  return { ...song, drums: true, measures: song.measures.map((m) => ({ ...m, drums: m.cols.map((_, ci) => Array.from({ length: DRUM_ROWS.length }, (_x, r) => m.drums?.[ci]?.[r] ?? "")) })) };
}

/**
 * A first-pass metal beat that follows the guitar: kick on every guitar attack
 * on the two lowest strings (chugs), snare on the backbeats, hats on the 8ths
 * (16ths when the bar is a 16th grid and the riff is busy), crash on the first
 * slot of a section and after a repeat.
 */
export function drumsFollowGuitar(song: Song, from = 0, to = song.measures.length - 1): Measure[] {
  const lo = Math.max(0, from), hi = Math.min(song.measures.length - 1, to);
  const nStr = song.tuning.length;
  return song.measures.map((m, mi) => {
    if (mi < lo || mi > hi) return m;
    const spb = m.spb ?? 4; const beats = sigBeats(m.sig); const nCols = m.cols.length;
    const drums = m.cols.map(() => Array(DRUM_ROWS.length).fill("") as string[]);
    const attack = (v: string) => /^(m?\d{1,2}|x|\^\d{1,2})$/.test(v);
    let busy = 0;
    for (let c = 0; c < nCols; c++) if (attack(m.cols[c][nStr - 1] ?? "") || attack(m.cols[c][nStr - 2] ?? "")) busy++;
    const sixteenths = spb >= 4 && busy > nCols / 2;
    for (let c = 0; c < nCols; c++) {
      const onBeat = c % spb === 0;
      const beat = Math.floor(c / spb);
      // hats: 8ths (every spb/2 slots), or 16ths when the riff is dense
      const hatStep = sixteenths ? Math.max(1, Math.floor(spb / 4)) : Math.max(1, Math.floor(spb / 2));
      if (c % hatStep === 0) drums[c][ROW_INDEX.hat] = onBeat ? "X" : "x";
      // snare: backbeats (2 and 4 in 4/4; every other beat generally, the last beat in odd meters)
      if (onBeat && (beats % 2 === 0 ? beat % 2 === 1 : beat === beats - 1)) drums[c][ROW_INDEX.snare] = "X";
      // kick: the guitar's low-string attacks; plus the downbeat if the guitar rests there
      const low = m.cols[c][nStr - 1] ?? "", low2 = m.cols[c][nStr - 2] ?? "";
      if (attack(low) || attack(low2)) drums[c][ROW_INDEX.kick] = onBeat ? "X" : "x";
      else if (c === 0) drums[c][ROW_INDEX.kick] = "X";
      if (drums[c][ROW_INDEX.kick] && drums[c][ROW_INDEX.snare]) drums[c][ROW_INDEX.kick] = ""; // don't double the backbeat
    }
    if (m.label || m.repeatStart) { drums[0][ROW_INDEX.crash] = "X"; drums[0][ROW_INDEX.hat] = ""; }
    return { ...m, drums };
  });
}
