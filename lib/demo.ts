// "Technique Test" audition song: isolated examples of each articulation for
// A/B-ing the voice engine through clean DI, the built-in amp, and NAM.

import { Song, TUNING_PRESETS, emptyMeasure } from "./model";

function bar(
  tuning: string[], cells: string, sig: string, spb: number, label?: string
): ReturnType<typeof emptyMeasure> {
  const m = emptyMeasure(tuning.length, sig, spb);
  const si = tuning.length - 1; // everything on the lowest string (Drop B)
  cells.trim().split(/\s+/).forEach((t, i) => {
    if (t !== "-" && i < m.cols.length) m.cols[i][si] = t;
  });
  if (label) m.label = label;
  return m;
}

// Palm-mute audition: isolated A/B sections. Flip "sound" (DI ↔ amp),
// "pm bank" (bass VI ↔ custom), "picking" and "mute grip" while it loops.
export function makeChugAuditionSong(): Song {
  const tuning = [...TUNING_PRESETS["Drop B"]];
  return {
    id: Math.random().toString(36).slice(2, 10),
    title: "Chug Audition",
    artist: "GuitarScrobble",
    bpm: 140,
    tuning,
    sound: "guitar",
    measures: [
      bar(tuning, "0 - m0 - 0 - m0 -", "4/4", 2, "1 · open B vs muted B (same velocity)"),
      bar(tuning, "m0 - m0 - m0 - m0 -", "4/4", 2, "2 · isolated hard mutes — set picking: all down"),
      bar(tuning, "m0 m0 m0 m0 m0 m0 m0 m0", "4/4", 2, "3 · continuous 8th chugs"),
      bar(tuning, "m0 m0 m0 m0 m0 m0 m0 m0 m0 m0 m0 m0", "4/4", 3, "4 · muted triplets"),
      bar(tuning, "m0 m0 x -", "2/4", 2, "5 · breakdown"),
      bar(tuning, "m0 3 m0 -", "2/4", 2),
      bar(tuning, "m0 m0 m0 m0 m0 m0 m0 m0", "4/4", 2, "6-8 · A/B here: sound DI↔amp · pm bank · double"),
    ],
    updatedAt: Date.now(),
  };
}

// Death-metal tremolo audition. One song bpm applies to all bars — labels
// carry the target tempo for each example; change the header bpm to match.
// A/B the repick engine with the "engine" selector (new · voices = overlap,
// old · retrigger = choke-and-restart).
export function makeTremoloAuditionSong(): Song {
  const tuning = [...TUNING_PRESETS["Drop B"]];
  const trem16 = "0 " + Array(15).fill("*").join(" ");
  const song: Song = {
    id: Math.random().toString(36).slice(2, 10),
    title: "Tremolo Audition",
    artist: "GuitarScrobble",
    bpm: 180,
    tuning,
    sound: "guitar",
    measures: [
      bar(tuning, trem16, "4/4", 4, "1 · open-B 16ths @180"),
      bar(tuning, trem16, "4/4", 4, "2 · same — set bpm to 220"),
      bar(tuning, "5 * * * 7 * * * 8 * 7 * 5 * * *", "4/4", 4, "3 · melodic line — set bpm 200"),
      bar(tuning, "0 " + Array(23).fill("*").join(" "), "4/4", 6, "4 · 16th-note triplets @180"),
      bar(tuning, trem16, "4/4", 4, "5 · power chord tremolo (3 strings)"),
      bar(tuning, trem16, "4/4", 4, "6-8 · A/B: sound DI↔amp · engine new↔old · ⧉ double"),
    ],
    updatedAt: Date.now(),
  };
  // bar 5: stack the lowest three strings for a B5 chord tremolo
  const chordBar = song.measures[4];
  const low = tuning.length - 1;
  chordBar.cols.forEach((col, c) => {
    col[low - 1] = col[low];      // F#2 mirrors the low-B pattern
    col[low - 2] = col[low];      // B2 too
  });
  return song;
}

// First-run starter: what a new visitor sees. A real riff with sections,
// a repeat, and every notation family, so the app opens looking alive.
export function makeStarterSong(): Song {
  const tuning = [...TUNING_PRESETS["Drop B"]];
  const b = (cells: string, sig: string, spb: number, label?: string, extra: Partial<ReturnType<typeof emptyMeasure>> = {}) =>
    ({ ...bar(tuning, cells, sig, spb, label), ...extra });
  const song: Song = {
    id: Math.random().toString(36).slice(2, 10),
    title: "Starter Riff",
    artist: "",
    bpm: 150,
    tuning,
    sound: "guitar",
    measures: [
      b("m0 m0 m0 3 m0 m0 5 =", "4/4", 2, "INTRO", { repeatStart: true }),
      b("m0 m0 m0 3 m0 m0 /7 ~", "4/4", 2, undefined, { repeatEnd: 2 }),
      b("0 * * * * * * * 5 * * * 7 * * *", "4/4", 4, "TREMOLO"),
      b("m0 m0 x m0 m0 x m0 m0 m0 m0 x m0", "4/4", 3, "BREAKDOWN"),
      b("m0 m0 x m0 m0 x 3 h5 p3 m0 m0 x", "4/4", 3),
      b("0 b = r 5 = = =", "4/4", 2, "OUTRO"),
    ],
    updatedAt: Date.now(),
  };
  // the breakdown's fret-3 accents also hit the F# string a fifth up (power chord)
  const low = tuning.length - 1;
  for (const mi of [3, 4]) {
    song.measures[mi].cols.forEach((col) => {
      if (col[low] === "3") col[low - 1] = "3";
    });
  }
  return song;
}

export function makeTechniqueTestSong(): Song {
  const tuning = [...TUNING_PRESETS["Drop B"]];
  return {
    id: Math.random().toString(36).slice(2, 10),
    title: "Technique Test",
    artist: "GuitarScrobble",
    bpm: 180,
    tuning,
    sound: "guitar",
    measures: [
      bar(tuning, "0 - h3 - p0 - = -", "4/4", 2, "1 · pick → hammer → pull"),
      bar(tuning, "5 b = = r = = -", "4/4", 2, "2 · bend & release"),
      bar(tuning, "7 ~ = =", "4/4", 1, "3 · vibrato (1.3s)"),
      bar(tuning, "m0 m0 m0 m0 m0 m0 m0 m0", "4/4", 2, "4 · chugs ×8 (accents + RR)"),
      bar(tuning, "m0 m0 m0 m0 m0 x m0 - m0 3 m0 m0", "4/4", 3, "5 · triplet mutes"),
      bar(tuning, "0 * * * * * * * * * * * * * * *", "4/4", 4, "6 · tremolo 16ths @180"),
    ],
    updatedAt: Date.now(),
  };
}
