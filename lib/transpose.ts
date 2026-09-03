// Transpose tab cells by semitones. Every fret number in a token moves,
// including the targets of slides/hammers/pulls/taps/pinches and palm
// mutes; unpitched marks (x ~ = * b r) are untouched. A fret that would
// leave 0..24 makes the whole operation fail (the caller reports it) so a
// riff never silently loses notes.
import { Measure, Song } from "./model";

const TOKEN = /^([/\\hptm^]?)(\d{1,2})$/;

export function transposeToken(v: string, semis: number): string | null {
  const m = TOKEN.exec(v);
  if (!m) return v; // not a fret: leave it
  const fret = parseInt(m[2], 10) + semis;
  if (fret < 0 || fret > 24) return null;
  return `${m[1]}${fret}`;
}

export type TransposeResult =
  | { ok: true; measures: Measure[] }
  | { ok: false; error: string };

/** Transpose bars [from, to] (0-based, inclusive) of a song by `semis`. */
export function transposeMeasures(song: Song, semis: number, from = 0, to = song.measures.length - 1): TransposeResult {
  if (!Number.isInteger(semis) || semis === 0) return { ok: true, measures: song.measures };
  const lo = Math.max(0, from), hi = Math.min(song.measures.length - 1, to);
  const out: Measure[] = [];
  for (let mi = 0; mi < song.measures.length; mi++) {
    const meas = song.measures[mi];
    if (mi < lo || mi > hi) { out.push(meas); continue; }
    const cols: string[][] = [];
    for (let ci = 0; ci < meas.cols.length; ci++) {
      const col: string[] = [];
      for (let si = 0; si < meas.cols[ci].length; si++) {
        const v = meas.cols[ci][si];
        const t = transposeToken(v, semis);
        if (t === null) {
          return { ok: false, error: `Bar ${mi + 1}, slot ${ci + 1}, string ${si + 1}: "${v}" would leave the fretboard (0-24) when moved ${semis > 0 ? "up" : "down"} ${Math.abs(semis)}.` };
        }
        col.push(t);
      }
      cols.push(col);
    }
    out.push({ ...meas, cols });
  }
  return { ok: true, measures: out };
}

/**
 * Move every note on `fromString` to `toString` (0-based from the top),
 * keeping pitch: the fret shifts by the interval between the two strings.
 * Fails if a note collides with an occupied cell or leaves 0..24.
 */
export function moveString(song: Song, fromString: number, toString: number, midiOf: (note: string) => number | null, from = 0, to = song.measures.length - 1): TransposeResult {
  if (fromString === toString) return { ok: true, measures: song.measures };
  const a = midiOf(song.tuning[fromString]), b = midiOf(song.tuning[toString]);
  if (a === null || b === null) return { ok: false, error: "Unknown tuning notes." };
  const semis = a - b; // a higher-pitched target string needs a lower fret
  const lo = Math.max(0, from), hi = Math.min(song.measures.length - 1, to);
  const out: Measure[] = [];
  for (let mi = 0; mi < song.measures.length; mi++) {
    const meas = song.measures[mi];
    if (mi < lo || mi > hi) { out.push(meas); continue; }
    const cols = meas.cols.map((col) => [...col]);
    for (let ci = 0; ci < cols.length; ci++) {
      const v = cols[ci][fromString];
      if (!v) continue;
      const t = transposeToken(v, semis);
      if (t === null) return { ok: false, error: `Bar ${mi + 1}, slot ${ci + 1}: "${v}" has no fret on that string.` };
      if (cols[ci][toString]) return { ok: false, error: `Bar ${mi + 1}, slot ${ci + 1}: the target string already has "${cols[ci][toString]}".` };
      cols[ci][toString] = t;
      cols[ci][fromString] = "";
    }
    out.push({ ...meas, cols });
  }
  return { ok: true, measures: out };
}
