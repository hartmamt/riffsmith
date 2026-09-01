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
    artist: "RiffSmith",
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
    artist: "RiffSmith",
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

// First-run starter: what a new visitor sees. Grieg's "In the Hall of the
// Mountain King" (Peer Gynt, 1875 — public domain). It is written in B minor,
// so on a Drop B guitar the whole theme lives on the two lowest strings.
// Bars 1-4 palm-muted (the pizzicato opening), 5-8 the answer a fifth up,
// then the theme tremolo-picked in 16th-note triplets and a chord finale.
function barLines(
  tuning: string[], lines: Record<number, string>, sig: string, spb: number,
  label?: string, extra: Partial<ReturnType<typeof emptyMeasure>> = {}
): ReturnType<typeof emptyMeasure> {
  const m = emptyMeasure(tuning.length, sig, spb);
  for (const [siStr, cells] of Object.entries(lines)) {
    const si = Number(siStr);
    cells.trim().split(/\s+/).forEach((t, i) => {
      if (t !== "." && i < m.cols.length) m.cols[i][si] = t;
    });
  }
  if (label) m.label = label;
  return { ...m, ...extra };
}

export function makeStarterSong(): Song {
  const tuning = [...TUNING_PRESETS["Drop B"]];
  // Drop B strings, top to bottom: 0 C#4 · 1 G#3 · 2 E3 · 3 B2 · 4 F#2 · 5 B1
  const B1 = 5, F2 = 4, B2 = 3;
  const chord = (cells: string) => ({ [B1]: cells, [F2]: cells, [B2]: cells });
  const trem = "0 * * 2 * * 3 * * 5 * * 7 * * 3 * * 7 * * * * *";
  return {
    id: Math.random().toString(36).slice(2, 10),
    title: "In the Hall of the Mountain King",
    artist: "Edvard Grieg",
    bpm: 160,
    tuning,
    sound: "guitar",
    measures: [
      // THEME — first phrase on the low B, palm-muted
      barLines(tuning, { [B1]: "m0 m2 m3 m5 m7 m3 m7 =" }, "4/4", 2, "THEME", { repeatStart: true }),
      barLines(tuning, { [B1]: "m6 m2 m6 = m5 m1 m5 =" }, "4/4", 2),
      barLines(tuning, { [B1]: "m0 m2 m3 m5 m7 m3 m7 =" }, "4/4", 2),
      barLines(tuning, { [B1]: "m0 . m7 m3 m7 = . .", [F2]: ". m3 . . . . m3 =" }, "4/4", 2),
      // answer a fifth up, on the F# string, open notes
      barLines(tuning, { [F2]: "0 2 3 5 7 3 7 =" }, "4/4", 2),
      barLines(tuning, { [F2]: "6 2 6 = 5 1 5 =" }, "4/4", 2),
      barLines(tuning, { [F2]: "0 2 3 5 7 3 7 =" }, "4/4", 2),
      barLines(tuning, { [F2]: "0 . 7 3 7 = . .", [B2]: ". 5 . . . . 5 ~" }, "4/4", 2, undefined, { repeatEnd: 2 }),
      // TREMOLO — the theme again, every note tremolo-picked (16th-note triplets)
      barLines(tuning, { [B1]: trem }, "4/4", 6, "TREMOLO"),
      barLines(tuning, { [B1]: "6 * * 2 * * 6 * * * * * 5 * * 1 * * 5 * * * * *" }, "4/4", 6),
      barLines(tuning, { [B1]: trem }, "4/4", 6),
      barLines(tuning, { [B1]: "0 * * 10 * * 7 * * 3 * * 7 * * * * * 10 * * * * *" }, "4/4", 6),
      // FINALE — B5 stabs, then let it ring
      barLines(tuning, chord("0 . 0 . 0 . 0 ."), "4/4", 2, "FINALE"),
      barLines(tuning, chord("0 ~ = = = = = ="), "4/4", 2),
    ],
    updatedAt: Date.now(),
  };
}

export function makeTechniqueTestSong(): Song {
  const tuning = [...TUNING_PRESETS["Drop B"]];
  return {
    id: Math.random().toString(36).slice(2, 10),
    title: "Technique Test",
    artist: "RiffSmith",
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
