// A bass line that follows the guitar: for every slot, the lowest fretted
// guitar note becomes the bass root an octave down (or as low as the bass
// goes), palm mutes stay palm mutes, holds stay holds, and slots where the
// guitar rests stay empty. It's the writing-session bass: the thing a
// bassist would play first, before making it their own.
import { Measure, Song, noteToMidi } from "./model";

const FRET = /^(m?)(\d{1,2})$/;

/** Place a MIDI pitch on the lowest bass string that reaches it (fret 0-24), dropping octaves until it fits. */
export function placeOnBass(midi: number, bassTuning: string[]): { string: number; fret: number } | null {
  const opens = bassTuning.map((n) => noteToMidi(n) ?? 0); // high → low
  const lowest = opens[opens.length - 1];
  let target = midi;
  while (target - 12 >= lowest) target -= 12;   // as low as the bass can go
  while (target < lowest) target += 12;
  for (let s = opens.length - 1; s >= 0; s--) {  // lowest string first
    const fret = target - opens[s];
    if (fret >= 0 && fret <= 24) return { string: s, fret };
  }
  return null;
}

/** Bass columns for one bar, following the guitar's lowest fretted note per slot. */
export function bassColsFollowing(measure: Measure, guitarTuning: string[], bassTuning: string[]): string[][] {
  const opens = guitarTuning.map((n) => noteToMidi(n) ?? 0);
  return measure.cols.map((col) => {
    const out = Array(bassTuning.length).fill("") as string[];
    let best: { midi: number; palm: boolean } | null = null;
    let hold = false;
    for (let s = 0; s < col.length; s++) {
      const v = col[s];
      if (v === "=" || v === "~") { hold = true; continue; }
      const m = FRET.exec(v);
      if (!m) continue;
      const midi = opens[s] + parseInt(m[2], 10);
      if (!best || midi < best.midi) best = { midi, palm: m[1] === "m" };
    }
    if (best) {
      const p = placeOnBass(best.midi, bassTuning);
      if (p) out[p.string] = `${best.palm ? "m" : ""}${p.fret}`;
    } else if (hold) {
      out[bassTuning.length - 1] = "=";
    }
    return out;
  });
}

/** Fill the bass lane of bars [from, to] by following the guitar. */
export function bassFollowGuitar(song: Song, bassTuning: string[], from = 0, to = song.measures.length - 1): Measure[] {
  const lo = Math.max(0, from), hi = Math.min(song.measures.length - 1, to);
  return song.measures.map((m, i) => (i < lo || i > hi ? m : { ...m, bass: bassColsFollowing(m, song.tuning, bassTuning) }));
}
