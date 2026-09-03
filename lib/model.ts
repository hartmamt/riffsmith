// Core data model for RiffSmith tabs.

// Cells hold short strings: fret numbers ("0".."24"), technique glyphs
// ("h","p","b","r","/","\\","x","~","t"), or "" for empty.
export type Measure = {
  cols: string[][]; // cols[col][string], string 0 = top (highest pitch)
  label?: string;   // section header, e.g. "0:01 · INTRO RIFF · 3/4"
  sig?: string;     // time signature, e.g. "3/4"
  spb?: number;     // grid slots per beat (1=quarters, 2=8ths, 3=triplets, 4=16ths)
  repeatStart?: boolean; // ‖: opens a repeated passage here
  repeatEnd?: number;    // :‖×N — play the passage N times total, then continue
  bass?: string[][];     // the bass lane: cols[col][bassString], same slots as `cols`; present when the song has a bass track
  drums?: string[][];    // the drum lane: cols[col][row], rows = crash · hat · snare · kick (see lib/drums.ts)
};

export type Song = {
  id: string;
  title: string;
  artist: string;
  bpm: number;
  sound?: "synth" | "guitar" | "guitar-di"; // playback instrument (new songs: guitar; legacy songs without it: synth); guitar-di = clean debug monitoring
  tuning: string[]; // top-to-bottom as displayed (high → low), e.g. ["E4","B3","G3","D3","A2","E2"]
  bassTuning?: string[]; // set when the song has a bass track (high → low), e.g. ["G2","D2","A1","E1"]
  drums?: boolean;       // the song has a drum track (a lane under every bar)
  measures: Measure[];
  updatedAt: number;
};

/** The bass tuning that matches a guitar tuning (drop tunings get the dropped bass). */
export function defaultBassTuning(guitarTuning: string[]): string[] {
  const low = noteToMidi(guitarTuning[guitarTuning.length - 1]) ?? 40;
  return low <= 35 ? [...TUNING_PRESETS["Bass Drop B"]] : [...TUNING_PRESETS["Bass E Std"]];
}

/** The bass lane as its own Song (same bars, bass tuning), for scheduling and export. */
export function bassView(song: Song): Song | null {
  if (!song.bassTuning) return null;
  const n = song.bassTuning.length;
  return {
    ...song,
    tuning: song.bassTuning,
    bassTuning: undefined,
    measures: song.measures.map((m) => ({
      ...m,
      bass: undefined,
      cols: m.cols.map((_, ci) => Array.from({ length: n }, (_x, si) => m.bass?.[ci]?.[si] ?? "")),
    })),
  };
}

/** Add (with empty bars) or remove the bass track. */
export function withBassTrack(song: Song, on: boolean, tuning?: string[]): Song {
  if (!on) return { ...song, bassTuning: undefined, measures: song.measures.map((m) => ({ ...m, bass: undefined })) };
  const bt = tuning ?? song.bassTuning ?? defaultBassTuning(song.tuning);
  return {
    ...song,
    bassTuning: bt,
    measures: song.measures.map((m) => ({
      ...m,
      bass: m.cols.map((_, ci) => Array.from({ length: bt.length }, (_x, si) => m.bass?.[ci]?.[si] ?? "")),
    })),
  };
}

export const DEFAULT_SIG = "4/4";
export const DEFAULT_SPB = 4;
export const SIGS = ["2/4", "3/4", "4/4", "5/4", "6/4", "7/4", "6/8", "9/8", "12/8"];
export const GRIDS: [number, string][] = [
  [1, "quarters"], [2, "8ths"], [3, "triplets"], [4, "16ths"], [6, "16th triplets"],
];
export const GRID_VALUES = GRIDS.map(([n]) => n);

export function sigBeats(sig: string | undefined): number {
  const m = (sig ?? DEFAULT_SIG).match(/^(\d+)\//);
  return m ? parseInt(m[1], 10) : 4;
}

// denominator of the signature: a 6/8 "beat" is an eighth note, so bar
// duration = beats × (4/denominator) quarter notes
export function sigDenom(sig: string | undefined): number {
  const m = (sig ?? DEFAULT_SIG).match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 4;
}

export const TUNING_PRESETS: Record<string, string[]> = {
  "E Standard": ["E4", "B3", "G3", "D3", "A2", "E2"],
  "Eb Standard": ["Eb4", "Bb3", "Gb3", "Db3", "Ab2", "Eb2"],
  "D Standard": ["D4", "A3", "F3", "C3", "G2", "D2"],
  "Drop D": ["E4", "B3", "G3", "D3", "A2", "D2"],
  "Drop C#": ["Eb4", "Bb3", "Gb3", "Db3", "Ab2", "Db2"],
  "Drop C": ["D4", "A3", "F3", "C3", "G2", "C2"],
  "Drop B": ["C#4", "G#3", "E3", "B2", "F#2", "B1"],
  "7-string B Standard": ["E4", "B3", "G3", "D3", "A2", "E2", "B1"],
  "7-string Drop A": ["E4", "B3", "G3", "D3", "A2", "E2", "A1"],
  "8-string F# Standard": ["E4", "B3", "G3", "D3", "A2", "E2", "B1", "F#1"],
  "8-string Drop E": ["E4", "B3", "G3", "D3", "A2", "E2", "B1", "E1"],
  "Bass E Std": ["G2", "D2", "A1", "E1"],
  "Bass Drop B": ["E2", "B1", "F#1", "B0"],
};

const NOTE_INDEX: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6,
  Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};

export function noteToMidi(note: string): number | null {
  const m = note.match(/^([A-G][#b]?)(-?\d)$/);
  if (!m) return null;
  const idx = NOTE_INDEX[m[1]];
  if (idx === undefined) return null;
  return (parseInt(m[2], 10) + 1) * 12 + idx;
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function emptyMeasure(strings: number, sig = DEFAULT_SIG, spb = DEFAULT_SPB): Measure {
  const nCols = sigBeats(sig) * spb;
  return { cols: Array.from({ length: nCols }, () => Array(strings).fill("")), sig, spb };
}

// Resize a measure to a new signature/grid, preserving what fits.
export function reshapeMeasure(m: Measure, strings: number, sig: string, spb: number): Measure {
  const nCols = sigBeats(sig) * spb;
  const cols = Array.from({ length: nCols }, (_, c) =>
    Array.from({ length: strings }, (_, s) => m.cols[c]?.[s] ?? "")
  );
  return { ...m, cols, sig, spb };
}

export function newSong(title = "Untitled riff"): Song {
  const tuning = [...TUNING_PRESETS["E Standard"]];
  return {
    id: Math.random().toString(36).slice(2, 10),
    title,
    artist: "",
    bpm: 120,
    tuning,
    sound: "guitar", // the sampled guitar through the rig; samples load on first play
    measures: Array.from({ length: 4 }, () => emptyMeasure(tuning.length)),
    updatedAt: Date.now(),
  };
}

export function isFret(v: string): boolean {
  return /^\d{1,2}$/.test(v);
}

// Render the song as classic ASCII tab, wrapping at ~4 measures per line.
export function toAscii(song: Song, perLine = 4): string {
  const strings = song.tuning.length;
  const label = song.tuning.map((n) => n.replace(/\d/g, ""));
  const labelW = Math.max(...label.map((l) => l.length));
  const lines: string[] = [];
  lines.push(song.artist ? `${song.title} — ${song.artist}` : song.title);
  lines.push(`Tuning: ${[...song.tuning].reverse().join(" ")}   ♩=${song.bpm}`);
  lines.push("");

  // group measures into lines; new line at section labels and sig changes so
  // every line's header can carry the signature (round-trip fidelity)
  const chunks: Measure[][] = [];
  for (const m of song.measures) {
    const cur = chunks[chunks.length - 1];
    const sigChanged = cur && (m.sig ?? DEFAULT_SIG) !== (cur[cur.length - 1].sig ?? DEFAULT_SIG);
    if (!cur || cur.length >= perLine || m.label || sigChanged) chunks.push([m]);
    else cur.push(m);
  }

  for (const chunk of chunks) {
    const header = [chunk[0].label, chunk[0].sig ?? DEFAULT_SIG].filter(Boolean).join(" · ");
    lines.push(`[ ${header} ]`);
    const rows = Array.from({ length: strings }, (_, s) => `${label[s].padEnd(labelW)}|`);
    // ONE column width for the whole line: the importer infers slot width per
    // system, so a bar with "m10" must not be wider-slotted than its neighbours
    const w = Math.max(1, ...chunk.flatMap((mm) => mm.cols.flat().map((v) => v.length))) + 1;
    for (const measure of chunk) {
      if (measure.repeatStart) for (let s = 0; s < strings; s++) rows[s] += ":";
      for (let c = 0; c < measure.cols.length; c++) {
        const col = measure.cols[c];
        for (let s = 0; s < strings; s++) {
          rows[s] += (col[s] || "").padEnd(w, "-");
        }
      }
      if (measure.repeatEnd && measure.repeatEnd > 1) {
        const tag = `x${measure.repeatEnd}`;
        for (let s = 0; s < strings; s++) {
          rows[s] += ":|" + (s === 0 ? tag : " ".repeat(tag.length));
        }
      } else {
        for (let s = 0; s < strings; s++) rows[s] += "|";
      }
    }
    lines.push(...rows, "");
    // the bass lane, as its own system under the guitar's (the importer
    // recognises the [ bass ] header and reattaches it to these bars)
    if (song.bassTuning && chunk.some((m) => m.bass?.some((col) => col.some((v) => v)))) {
      const bt = song.bassTuning;
      const bl = bt.map((n) => n.replace(/\d/g, ""));
      const blW = Math.max(...bl.map((l) => l.length));
      const brows = bt.map((_, s) => `${bl[s].padEnd(blW)}|`);
      const bw = Math.max(1, ...chunk.flatMap((mm) => (mm.bass ?? []).flat().map((v) => v.length))) + 1;
      lines.push(`[ bass · ${chunk[0].sig ?? DEFAULT_SIG} ]`);
      for (const measure of chunk) {
        if (measure.repeatStart) for (let s = 0; s < bt.length; s++) brows[s] += ":";
        for (let c = 0; c < measure.cols.length; c++) {
          const col = measure.bass?.[c] ?? [];
          for (let s = 0; s < bt.length; s++) brows[s] += (col[s] || "").padEnd(bw, "-");
        }
        if (measure.repeatEnd && measure.repeatEnd > 1) {
          const tag = `x${measure.repeatEnd}`;
          for (let s = 0; s < bt.length; s++) brows[s] += ":|" + (s === 0 ? tag : " ".repeat(tag.length));
        } else {
          for (let s = 0; s < bt.length; s++) brows[s] += "|";
        }
      }
      lines.push(...brows, "");
    }
    if (song.drums && chunk.some((m) => m.drums?.some((col) => col.some((v) => v)))) {
      const labels = ["C", "H", "S", "K"];
      const drows = labels.map((l) => `${l}|`);
      lines.push(`[ drums · ${chunk[0].sig ?? DEFAULT_SIG} ]`);
      for (const measure of chunk) {
        if (measure.repeatStart) for (let s = 0; s < labels.length; s++) drows[s] += ":";
        for (let c = 0; c < measure.cols.length; c++) {
          const col = measure.drums?.[c] ?? [];
          for (let s = 0; s < labels.length; s++) drows[s] += (col[s] || "").padEnd(2, "-");
        }
        if (measure.repeatEnd && measure.repeatEnd > 1) {
          const tag = `x${measure.repeatEnd}`;
          for (let s = 0; s < labels.length; s++) drows[s] += ":|" + (s === 0 ? tag : " ".repeat(tag.length));
        } else {
          for (let s = 0; s < labels.length; s++) drows[s] += "|";
        }
      }
      lines.push(...drows, "");
    }
  }
  return lines.join("\n");
}
