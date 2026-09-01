// Pure playback logic: cell grammar → articulation actions, slot timing,
// accents, and position advance (repeats/looping). No Web Audio here — the
// scheduler in the UI maps these to the sampler/synth, and unit tests can
// exercise everything in Node.

import { DEFAULT_SPB, Song, noteToMidi, sigDenom } from "./model";

export type ActionKind =
  | "pick"    // normal picked note
  | "palm"    // pitched palm mute (m3)
  | "dead"    // unpitched dead chug (x)
  | "hammer" | "pull" | "tap" // legato: continue the ringing voice, no pick
  | "slide"   // continuous pitch glide into the target
  | "bend"    // bend the ringing note up a whole step
  | "release" // release the bend back down
  | "repick"; // re-pick the current note (tremolo)

export type NoteAction = {
  si: number;
  kind: ActionKind;
  midi: number;           // target pitch (dead = open-string pitch)
  fromMidi?: number;      // glide origin for slide/bend/release, legato origin for h/p/t
  glideDur?: number;      // seconds of pitch travel
  sustain: number;        // extra ring time from "="/"~" cells
  vibrato: boolean;
  velocity: number;       // 0..1 accent
  sourceKind?: "pick" | "palm" | "dead"; // for repick: what to re-pick
  gap?: number;           // seconds until the next event on this string
};

// one slot's duration: (quarter note at bpm) ÷ grid, scaled by the meter's
// beat unit — an x/8 signature's beats are eighth notes, half a quarter
export const slotDurOf = (song: Song, m: number): number =>
  (60 / song.bpm / (song.measures[m].spb ?? DEFAULT_SPB)) *
  (4 / sigDenom(song.measures[m].sig));

// strong–weak(–medium) accent patterns per grid resolution
const ACCENTS: Record<number, number[]> = {
  1: [1],
  2: [1, 0.85],
  3: [1, 0.72, 0.86], // metalcore chug triplets: strong–weak–medium
  4: [1, 0.78, 0.9, 0.78],
  6: [1, 0.93, 0.95, 0.96, 0.95, 0.93], // 16th triplets: near-even, beat-led
};

// tremolo repicks stay fluid: mostly even, ~8% beat accent, deterministic
function repickVelocity(accent: number): number {
  return accent >= 1 ? 1 : 0.92;
}

export function accentAt(song: Song, m: number, c: number): number {
  const spb = song.measures[m].spb ?? DEFAULT_SPB;
  const pat = ACCENTS[spb] ?? ACCENTS[4];
  return pat[c % pat.length];
}

const isSlideMark = (v: string) => v === "/" || v === "\\";

export function fretOf(v: string | null | undefined): number | null {
  const fm = v?.match(/^[/\\hptm]?(\d{1,2})$/);
  return fm ? parseInt(fm[1], 10) : null;
}

// step one slot backward/forward across bar lines
function stepCell(song: Song, mi: number, ci: number, dir: -1 | 1): [number, number] | null {
  let mm = mi, cc = ci + dir;
  while (cc < 0 || cc >= song.measures[mm].cols.length) {
    mm += dir;
    if (mm < 0 || mm >= song.measures.length) return null;
    cc = dir === -1 ? song.measures[mm].cols.length - 1 : 0;
  }
  return [mm, cc];
}

function cellAt(song: Song, pos: [number, number] | null, si: number): string | null {
  return pos ? song.measures[pos[0]].cols[pos[1]][si] ?? null : null;
}

// seconds of "="/"~" hold cells following (mi, ci)
export function holdAfter(song: Song, si: number, mi: number, ci: number): number {
  let total = 0;
  let mm = mi, cc = ci + 1;
  for (let guard = 0; guard < 64; guard++) {
    if (cc >= song.measures[mm].cols.length) {
      mm++; cc = 0;
      if (mm >= song.measures.length) break;
    }
    const v = song.measures[mm].cols[cc][si];
    if (v !== "=" && v !== "~") break;
    total += slotDurOf(song, mm);
    cc++;
  }
  return total;
}

export function vibratoAfter(song: Song, si: number, mi: number, ci: number): boolean {
  let mm = mi, cc = ci + 1;
  for (let guard = 0; guard < 64; guard++) {
    if (cc >= song.measures[mm].cols.length) {
      mm++; cc = 0;
      if (mm >= song.measures.length) break;
    }
    const v = song.measures[mm].cols[cc][si];
    if (v === "~") return true;
    if (v !== "=") break;
    cc++;
  }
  return false;
}

// nearest sounding note behind (mi,ci) on string si: its fret and cell value.
// Skips holds, vibrato, bend marks and repicks; stops at gaps.
function noteBehind(
  song: Song, si: number, mi: number, ci: number
): { fret: number; value: string } | null {
  let back: [number, number] | null = [mi, ci];
  for (let g = 0; g < 96; g++) { // long tremolo runs scan far back
    back = stepCell(song, back[0], back[1], -1);
    if (!back) return null;
    const pv = cellAt(song, back, si);
    if (pv === null || pv === "") return null;
    const pf = fretOf(pv);
    if (pf !== null) return { fret: pf, value: pv };
    if (pv === "x") return { fret: -1, value: pv }; // dead hit
    const skippable =
      pv === "=" || pv === "~" || pv === "b" || pv === "r" || pv === "*" ||
      pv === "h" || pv === "p" || pv === "t" || isSlideMark(pv);
    if (!skippable) return null;
  }
  return null;
}

// seconds until the next sounding cell on string si after (mi, ci); capped.
export function gapAhead(song: Song, si: number, mi: number, ci: number, cap = 2): number {
  let t = slotDurOf(song, mi);
  let fwd: [number, number] | null = [mi, ci];
  for (let g = 0; g < 64 && t < cap; g++) {
    fwd = stepCell(song, fwd[0], fwd[1], 1);
    if (!fwd) return cap;
    const v = cellAt(song, fwd, si);
    if (v && v !== "=" && v !== "~") return t;
    t += slotDurOf(song, fwd[0]);
  }
  return Math.min(t, cap);
}

// All actions for one grid column. `base` per string comes from tuning.
export function columnActions(song: Song, m: number, c: number): NoteAction[] {
  const meas = song.measures[m];
  if (!meas) return [];
  const midis = song.tuning.map(noteToMidi);
  const out: NoteAction[] = [];
  const velocity = accentAt(song, m, c);

  meas.cols[c].forEach((v, si) => {
    const base = midis[si];
    if (base == null || !v) return;
    const sustain = holdAfter(song, si, m, c);
    const vibrato = vibratoAfter(song, si, m, c);

    if (/^\d{1,2}$/.test(v)) {
      // suppressed when a slide-run behind it already covers this note
      const prevPos = stepCell(song, m, c, -1);
      const prev = cellAt(song, prevPos, si);
      if (prev && isSlideMark(prev)) {
        const src = noteBehind(song, si, m, c);
        if (src && src.fret >= 0) return; // sounded by the glide
      }
      // a bare h/p/t marker behind it (imported tabs) = legato
      const legatoStyle = prev === "h" ? "hammer" : prev === "p" ? "pull" : prev === "t" ? "tap" : null;
      if (legatoStyle) {
        const src = noteBehind(song, si, m, c);
        out.push({
          si, kind: legatoStyle, midi: base + parseInt(v, 10),
          fromMidi: src && src.fret >= 0 ? base + src.fret : undefined,
          sustain, vibrato, velocity,
        });
      } else {
        out.push({ si, kind: "pick", midi: base + parseInt(v, 10), sustain, vibrato, velocity });
      }
    } else if (/^[hpt]\d{1,2}$/.test(v)) {
      const kind = v[0] === "h" ? "hammer" : v[0] === "p" ? "pull" : "tap";
      const src = noteBehind(song, si, m, c);
      out.push({
        si, kind, midi: base + fretOf(v)!,
        fromMidi: src && src.fret >= 0 ? base + src.fret : undefined,
        sustain, vibrato, velocity,
      });
    } else if (/^m\d{1,2}$/.test(v)) {
      out.push({
        si, kind: "palm", midi: base + fretOf(v)!, sustain: 0, vibrato: false, velocity,
        gap: gapAhead(song, si, m, c),
      });
    } else if (v === "x") {
      out.push({ si, kind: "dead", midi: base, sustain: 0, vibrato: false, velocity });
    } else if (v === "*") {
      const src = noteBehind(song, si, m, c);
      if (!src) return;
      const sourceKind = src.value === "x" ? "dead" : src.value.startsWith("m") ? "palm" : "pick";
      out.push({
        si, kind: "repick",
        midi: src.fret >= 0 ? base + src.fret : base,
        sustain: 0, vibrato: false, velocity: repickVelocity(velocity), sourceKind,
        gap: gapAhead(song, si, m, c),
      });
    } else if (v === "b" || v === "r") {
      const src = noteBehind(song, si, m, c);
      if (!src || src.fret < 0) return;
      const gdur = Math.min(0.3, Math.max(0.12, slotDurOf(song, m) * 1.1));
      out.push({
        si, kind: v === "b" ? "bend" : "release",
        midi: base + src.fret + (v === "b" ? 2 : 0),
        fromMidi: base + src.fret + (v === "r" ? 2 : 0),
        glideDur: gdur, sustain, vibrato, velocity,
      });
    } else if (/^[/\\]\d{1,2}$/.test(v)) {
      const target = fretOf(v)!;
      const src = noteBehind(song, si, m, c);
      const fromFret = src && src.fret >= 0 ? src.fret : Math.max(0, target + (v[0] === "/" ? -4 : 4));
      out.push({
        si, kind: "slide", midi: base + target, fromMidi: base + fromFret,
        glideDur: Math.min(0.25, slotDurOf(song, m) * 0.6),
        sustain, vibrato, velocity,
      });
    } else if (isSlideMark(v)) {
      // standalone slide cell (imported tabs): glide from the note behind to
      // the note ahead; only the first mark of a run acts
      const prev = cellAt(song, stepCell(song, m, c, -1), si);
      if (prev && isSlideMark(prev)) return;
      const src = noteBehind(song, si, m, c);
      if (!src || src.fret < 0) return;
      let fwd: [number, number] | null = [m, c];
      let gdur = slotDurOf(song, m);
      let tgt: number | null = null;
      for (let g = 0; g < 12; g++) {
        fwd = stepCell(song, fwd[0], fwd[1], 1);
        if (!fwd) break;
        const nv = cellAt(song, fwd, si);
        if (nv === null) break;
        const nf = fretOf(nv);
        if (nf !== null) { tgt = nf; break; }
        if (!isSlideMark(nv)) break;
        gdur += slotDurOf(song, fwd[0]);
      }
      const target = tgt !== null ? tgt : Math.max(0, src.fret + (v === "/" ? 5 : -5));
      const tailSustain = tgt !== null && fwd ? holdAfter(song, si, fwd[0], fwd[1]) : 0;
      out.push({
        si, kind: "slide", midi: base + target, fromMidi: base + src.fret,
        glideDur: gdur, sustain: tailSustain, vibrato, velocity,
      });
    }
  });
  return out;
}

// ---- position advance with repeats & looping --------------------------------

export type PlayPos = { m: number; c: number; taken: Record<number, number>; done: boolean };

function repeatJumpTarget(song: Song, mi: number, start: number): number {
  for (let i = mi; i >= start; i--) if (song.measures[i]?.repeatStart) return i;
  return start;
}

export function advancePos(
  song: Song, pos: PlayPos, start: number, end: number, loop: boolean
): PlayPos {
  const last = Math.min(end, song.measures.length - 1);
  let { m, c } = pos;
  const taken = { ...pos.taken };
  c++;
  while (m <= last && c >= song.measures[m].cols.length) {
    c = 0;
    const reps = song.measures[m].repeatEnd ?? 0;
    if (reps > 1 && (taken[m] ?? 0) < reps - 1) {
      taken[m] = (taken[m] ?? 0) + 1;
      m = repeatJumpTarget(song, m, start);
    } else {
      m++;
      if (m > last) {
        if (loop) {
          m = Math.min(start, last);
          for (const k of Object.keys(taken)) delete taken[Number(k)];
        } else {
          return { m, c: 0, taken, done: true };
        }
      }
    }
  }
  if (m > last) return { m, c: 0, taken, done: true };
  return { m, c, taken, done: false };
}
