// "Technique Test" audition song: isolated examples of each articulation for
// A/B-ing the voice engine through clean DI, the built-in amp, and NAM.

import { Song, TUNING_PRESETS, emptyMeasure, withBassTrack } from "./model";
import { bassFollowGuitar } from "./bassFollow";
import { drumsFollowGuitar, withDrumTrack } from "./drums";

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
// so the whole theme lives on the two lowest strings (E standard: E and A).
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

/** Guitar riff → the same song with a bass lane and a drum lane following it. */
export function fullBand(song: Song): Song {
  const withBass = withBassTrack(song, true);
  const bassed = { ...withBass, measures: bassFollowGuitar(withBass, withBass.bassTuning!) };
  const withDrums = withDrumTrack(bassed, true);
  return { ...withDrums, measures: drumsFollowGuitar(withDrums) };
}

export function makeStarterSong(): Song {
  const tuning = [...TUNING_PRESETS["E Standard"]];
  // E standard strings, top to bottom: 0 E4 · 1 B3 · 2 G3 · 3 D3 · 4 A2 · 5 E2
  const B1 = 5, F2 = 4, B2 = 3; // low E, A, D
  // E5: open low E, A and D at the 2nd fret
  const chord = (cells: string) => ({ [B1]: cells, [F2]: cells.replace(/0/g, "2"), [B2]: cells.replace(/0/g, "2") });
  const trem = "0 * * 2 * * 3 * * 5 * * 7 * * 3 * * 7 * * * * *";
  const song: Song = {
    id: Math.random().toString(36).slice(2, 10),
    title: "In the Hall of the Mountain King",
    artist: "Edvard Grieg",
    bpm: 160,
    tuning,
    sound: "guitar",
    measures: [
      // THEME — first phrase on the low E, palm-muted
      barLines(tuning, { [B1]: "m0 m2 m3 m5 m7 m3 m7 =" }, "4/4", 2, "THEME", { repeatStart: true }),
      barLines(tuning, { [B1]: "m6 m2 m6 = m5 m1 m5 =" }, "4/4", 2),
      barLines(tuning, { [B1]: "m0 m2 m3 m5 m7 m3 m7 =" }, "4/4", 2),
      barLines(tuning, { [B1]: "m0 . m7 m3 m7 = . .", [F2]: ". m3 . . . . m3 =" }, "4/4", 2),
      // answer a fourth up, on the A string, open notes
      barLines(tuning, { [F2]: "0 2 3 5 7 3 7 =" }, "4/4", 2),
      barLines(tuning, { [F2]: "6 2 6 = 5 1 5 =" }, "4/4", 2),
      barLines(tuning, { [F2]: "0 2 3 5 7 3 7 =" }, "4/4", 2),
      barLines(tuning, { [F2]: "0 . 7 3 7 = . .", [B2]: ". 5 . . . . 5 ~" }, "4/4", 2, undefined, { repeatEnd: 2 }),
      // TREMOLO — the theme again, every note tremolo-picked (16th-note triplets)
      barLines(tuning, { [B1]: trem }, "4/4", 6, "TREMOLO"),
      barLines(tuning, { [B1]: "6 * * 2 * * 6 * * * * * 5 * * 1 * * 5 * * * * *" }, "4/4", 6),
      barLines(tuning, { [B1]: trem }, "4/4", 6),
      barLines(tuning, { [B1]: "0 * * 10 * * 7 * * 3 * * 7 * * * * * 10 * * * * *" }, "4/4", 6),
      // FINALE — E5 stabs, then let it ring
      barLines(tuning, chord("0 . 0 . 0 . 0 ."), "4/4", 2, "FINALE"),
      barLines(tuning, chord("0 ~ = = = = = ="), "4/4", 2),
    ],
    updatedAt: Date.now(),
  };
  return fullBand(song);
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

// String-model audition: one articulation per section, so the "hybrid ·
// string model" engine can be A/B'd against "new · voices" phrase by phrase.
// Drop B. Strings top→bottom: 0 C#4 · 1 G#3 · 2 E3 · 3 B2 · 4 F#2 · 5 B1.
export function makeStringAuditionSong(): Song {
  const tuning = [...TUNING_PRESETS["Drop B"]];
  const B1 = 5, F2 = 4, B2 = 3, E3 = 2, G3 = 1;
  const bl = (lines: Record<number, string>, sig: string, spb: number, label?: string) =>
    barLines(tuning, lines, sig, spb, label);
  return {
    id: Math.random().toString(36).slice(2, 10),
    title: "String Model Audition",
    artist: "RiffSmith",
    bpm: 150,
    tuning,
    sound: "guitar",
    measures: [
      // 1 · sustain and vibrato: the ring-out is 100% model after ~120 ms
      bl({ [B1]: "0 = = = = ~ = =" }, "4/4", 2, "1 · SUSTAIN + VIBRATO (model owns the tail)"),
      bl({ [F2]: "5 = = = ~ = = =" }, "4/4", 2),
      bl({ [E3]: "7 = = ~ = = = =" }, "4/4", 2),
      // 2 · legato: one pick, the termination moves
      bl({ [B1]: "0 h2 h3 h5 p3 p2 p0 =" }, "4/4", 2, "2 · LEGATO RUNS (one pick per bar)"),
      bl({ [F2]: "0 h2 h3 h5 p3 p2 p0 =" }, "4/4", 2),
      bl({ [E3]: "5 h7 h9 p7 p5 ~ = =" }, "4/4", 2),
      // 3 · slides: continuous pitch on the same vibration
      bl({ [B1]: "0 /5 = /7 = \\5 = =" }, "4/4", 2, "3 · SLIDES"),
      bl({ [F2]: "2 /4 = /7 = = \\2 =" }, "4/4", 2),
      // 4 · bends: tension, not retuned recordings
      bl({ [E3]: "7 b = r = = = =" }, "4/4", 2, "4 · BENDS + RELEASE"),
      bl({ [E3]: "9 b = = ~ = = =" }, "4/4", 2),
      bl({ [B2]: "5 b = r 5 b = r" }, "4/4", 2),
      // 5 · tremolo: the same string re-excited
      bl({ [B1]: "0 * * * * * * * 3 * * * 5 * * *" }, "4/4", 4, "5 · TREMOLO (re-excited loop)"),
      bl({ [F2]: "0 * * * * * * * 2 * * * 3 * * *" }, "4/4", 4),
      // 6 · chugs: palm pressure as a lossy contact
      bl({ [B1]: "m0 m0 m0 m0 m0 m0 m0 m0" }, "4/4", 2, "6 · CHUGS (mute = contact)"),
      bl({ [B1]: "m0 m0 x m0 m0 x 3 m0" }, "4/4", 2),
      // 7 · power chords, let ring: bridge coupling and beating
      bl({ [B1]: "0 = = = . 3 = =", [F2]: "0 = = = . 3 = =", [B2]: "0 = = = . 3 = =" }, "4/4", 2, "7 · POWER CHORDS, LET RING"),
      bl({ [B1]: "5 = = = = = = =", [F2]: "5 = = = = = = =", [B2]: "5 = = = = = = =" }, "4/4", 2),
      // 8 · a lead phrase mixing everything
      bl({ [E3]: "7 h9 = /12 ~ = = =" }, "4/4", 2, "8 · LEAD PHRASE"),
      bl({ [E3]: "10 p9 p7 = . 5 b =", [G3]: ". . . . . . . ." }, "4/4", 2),
      bl({ [E3]: "r = = = 7 ~ = =" }, "4/4", 2),
      bl({ [B2]: "7 /9 = = = ~ = =" }, "4/4", 2),
    ],
    updatedAt: Date.now(),
  };
}

// Bass audition: Bass Drop B (E2 B1 F#1 B0). One thing per section so the
// bass bank can be judged phrase by phrase.
// Strings top→bottom: 0 E2 · 1 B1 · 2 F#1 · 3 B0.
export function makeBassAuditionSong(): Song {
  const tuning = [...TUNING_PRESETS["Bass Drop B"]];
  const B0 = 3, F1 = 2, B1 = 1, E2 = 0;
  const bl = (lines: Record<number, string>, sig: string, spb: number, label?: string) =>
    barLines(tuning, lines, sig, spb, label);
  return {
    id: Math.random().toString(36).slice(2, 10),
    title: "Bass Audition",
    artist: "RiffSmith",
    bpm: 140,
    tuning,
    sound: "guitar",
    measures: [
      bl({ [B0]: "0 = = = = ~ = =" }, "4/4", 2, "1 · LOW B, LET RING"),
      bl({ [B1]: "3 = = = ~ = = =" }, "4/4", 2),
      bl({ [B0]: "m0 m0 m0 m0 m0 m0 m0 m0" }, "4/4", 2, "2 · CHUGS (hard, then soft)"),
      bl({ [B0]: "m0 m0 x m0 m0 x 3 m0" }, "4/4", 2),
      bl({ [B0]: "0 . 0 . 3 . 5 .", [F1]: ". . . . . . . ." }, "4/4", 2, "3 · ROOT–FIFTH RIFF"),
      bl({ [B0]: "0 . 0 .", [F1]: ". 0 . 0" }, "4/4", 2),
      bl({ [B0]: "0 0 0 0 0 0 0 0 3 3 3 3 5 5 5 5" }, "4/4", 4, "4 · 16TH GALLOP"),
      bl({ [B0]: "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0" }, "4/4", 4),
      bl({ [B0]: "0 /5 = /7 = \\3 = =" }, "4/4", 2, "5 · SLIDES"),
      bl({ [B1]: "0 h2 h3 p2 p0 = = =" }, "4/4", 2, "6 · HAMMER-ONS / PULL-OFFS"),
      bl({ [F1]: "5 h7 p5 = 3 h5 = =" }, "4/4", 2),
      bl({ [B0]: "0 = . 0 = . 0 =", [F1]: "7 = . 7 = . 7 =" }, "4/4", 2, "7 · OCTAVES"),
      bl({ [B1]: "0 = = = = = = =", [E2]: "2 = = = = = = =" }, "4/4", 2, "8 · TWO-NOTE CHORD, LET RING"),
    ],
    updatedAt: Date.now(),
  };
}

// "Guitar Showcase": one short piece in E standard that runs through everything
// the engine does — let-ring chords with vibrato, a pinch squeal, gallop
// chugs with grip, a slide into a chug, a legato run, a bend with vibrato,
// tremolo picking, dead-note chops, and a held final chord (turn `feedback`
// on in the rig to hear it swell).
export function makeGuitarShowcaseSong(): Song {
  const tuning = [...TUNING_PRESETS["E Standard"]];
  // E standard, strings top to bottom: 0 E4 · 1 B3 · 2 G3 · 3 D3 · 4 A2 · 5 E2
  const B1 = 5, F2 = 4, B2 = 3, E3 = 2, G3 = 1, C4 = 0; // (names kept from the Drop B draft: low E, A, D, G, B, high E)
  const bl = (lines: Record<number, string>, sig: string, spb: number, label?: string, extra: Partial<ReturnType<typeof emptyMeasure>> = {}) =>
    barLines(tuning, lines, sig, spb, label, extra);
  return {
    id: Math.random().toString(36).slice(2, 10),
    title: "Guitar Showcase",
    artist: "RiffSmith",
    bpm: 150,
    tuning,
    sound: "guitar",
    measures: [
      // a big open B5 rings with vibrato, then a pinch squeal answers it
      bl({ [B1]: "0 ~ = = = = = =", [F2]: "2 = = = = = = =", [B2]: "2 = = = = = = =" }, "4/4", 2, "INTRO · chord, then a pinch squeal"),
      bl({ [B1]: "^7 ~ = = = = = =" }, "4/4", 2),
      bl({ [B1]: "0 ~ = = = = = =", [F2]: "2 = = = = = = =", [B2]: "2 = = = = = = =" }, "4/4", 2),
      bl({ [B1]: "^5 ~ = = = = \\3 =" }, "4/4", 2),
      // gallops, open hits, a slide into the chug on fret 8
      bl({ [B1]: "m0 m0 m0 3 m0 m0 5 = m0 m0 m0 6 m0 m0 /8 =" }, "4/4", 4, "RIFF · gallops, slides, chops", { repeatStart: true }),
      bl({ [B1]: "m0 m0 m0 3 m0 m0 x x m0 m0 m0 6 5 3 0 =" }, "4/4", 4),
      bl({ [B1]: "m0 m0 m0 3 m0 m0 5 = m0 m0 m0 6 m0 m0 /8 =" }, "4/4", 4),
      bl({ [B1]: "m0 m0 x m0 m0 x m0 m0 8 = \\6 = 5 = 3 =", [F2]: ". . . . . . . . . . . . . . . ." }, "4/4", 4, undefined, { repeatEnd: 2 }),
      // legato on the middle strings, then a bend that sings
      bl({ [E3]: "5 h7 p5 . 7 h9 p7 .", [G3]: ". . . 7 . . . 9" }, "4/4", 2, "LEAD · legato, bend, vibrato"),
      bl({ [G3]: "9 b = = = r = =", [C4]: ". . . . . . . ." }, "4/4", 2),
      bl({ [E3]: "7 h9 p7 h9 p7 h9 p7 =", [G3]: ". . . . . . . ." }, "4/4", 2),
      bl({ [G3]: "/12 ~ = = = = = =", [C4]: ". . . . . . . ." }, "4/4", 2),
      // tremolo on the low string, moving
      bl({ [B1]: "0 * * * 3 * * * 5 * * * 6 * * *" }, "4/4", 4, "TREMOLO"),
      bl({ [B1]: "8 * * * 6 * * * 5 * * * 3 * * *" }, "4/4", 4),
      // dead-note chops against the chord, then the final chord held
      bl({ [B1]: "x x m0 x x m0 3 =", [F2]: ". . . . . . 5 =", [B2]: ". . . . . . 5 =" }, "4/4", 2, "OUTRO · chops, then hold it (try feedback)"),
      bl({ [B1]: "x x m0 x x 5 = =", [F2]: ". . . . . 7 = =", [B2]: ". . . . . 7 = =" }, "4/4", 2),
      bl({ [B1]: "0 ~ = = = = = =", [F2]: "2 = = = = = = =", [B2]: "2 = = = = = = =" }, "4/4", 2),
      bl({ [B1]: "= = = = = = = =", [F2]: "= = = = = = = =", [B2]: "= = = = = = = =" }, "4/4", 2),
    ],
    updatedAt: Date.now(),
  };
}

// "Bass Showcase": the same idea for a 4-string in E standard — let-ring
// low E, gallops with dead-note chops, a root/fifth/octave groove with
// hammer-ons and pull-offs, slides both ways, and a held two-note chord.
export function makeBassShowcaseSong(): Song {
  const tuning = [...TUNING_PRESETS["Bass E Std"]];
  // E standard bass, strings top to bottom: 0 G2 · 1 D2 · 2 A1 · 3 E1
  const B0 = 3, F1 = 2, B1 = 1, E2 = 0; // (names kept from the Drop B draft: lowest → highest string)
  const bl = (lines: Record<number, string>, sig: string, spb: number, label?: string, extra: Partial<ReturnType<typeof emptyMeasure>> = {}) =>
    barLines(tuning, lines, sig, spb, label, extra);
  return {
    id: Math.random().toString(36).slice(2, 10),
    title: "Bass Showcase",
    artist: "RiffSmith",
    bpm: 150,
    tuning,
    sound: "guitar",
    measures: [
      bl({ [B0]: "0 = = = ~ = = =" }, "4/4", 2, "INTRO · low E, let ring"),
      bl({ [B0]: "0 = = /5 = = \\3 =" }, "4/4", 2),
      bl({ [B0]: "m0 m0 m0 3 m0 m0 5 = m0 m0 m0 6 m0 m0 /8 =" }, "4/4", 4, "RIFF · gallops, slides, chops", { repeatStart: true }),
      bl({ [B0]: "m0 m0 m0 3 m0 m0 x x m0 m0 m0 6 5 3 0 =" }, "4/4", 4),
      bl({ [B0]: "m0 m0 m0 3 m0 m0 5 = m0 m0 m0 6 m0 m0 /8 =" }, "4/4", 4),
      bl({ [B0]: "m0 m0 x m0 m0 x m0 m0 8 = \\6 = 5 = 3 =" }, "4/4", 4, undefined, { repeatEnd: 2 }),
      bl({ [B0]: "0 . 0 . . . 0 .", [F1]: ". 0 . . 0 h2 . 0" }, "4/4", 2, "GROOVE · root, fifth, octave, legato"),
      bl({ [B0]: "0 . 0 . . . 3 .", [F1]: ". 0 . . 2 p0 . ." }, "4/4", 2),
      bl({ [B0]: "0 . 0 . . . 0 .", [B1]: ". 0 . . 0 h2 . 0" }, "4/4", 2),
      bl({ [B0]: "3 . 3 . 5 . 6 .", [F1]: ". 3 . . . 5 . 6" }, "4/4", 2),
      bl({ [B0]: "0 /7 = = \\0 = = =" }, "4/4", 2, "FILL · slides, then a held two-note chord"),
      bl({ [F1]: "5 h7 p5 = 3 h5 p3 =" }, "4/4", 2),
      bl({ [B1]: "0 ~ = = = = = =", [E2]: "2 = = = = = = =" }, "4/4", 2),
      bl({ [B1]: "= = = = = = = =", [E2]: "= = = = = = = =" }, "4/4", 2),
    ],
    updatedAt: Date.now(),
  };
}

// "Clean Showcase": E standard through the clean channel — arpeggios that
// ring into each other, a legato melody with vibrato and slides, double
// stops, and open chords let ring. Picking it in the audition menu also
// switches the rig to the clean capture with the boost pedal off.
export function makeCleanShowcaseSong(): Song {
  const tuning = [...TUNING_PRESETS["E Standard"]];
  const E4 = 0, B3 = 1, G3 = 2, D3 = 3, A2 = 4, E2 = 5;
  const bl = (lines: Record<number, string>, sig: string, spb: number, label?: string, extra: Partial<ReturnType<typeof emptyMeasure>> = {}) =>
    barLines(tuning, lines, sig, spb, label, extra);
  return {
    id: Math.random().toString(36).slice(2, 10),
    title: "Clean Showcase",
    artist: "RiffSmith",
    bpm: 96,
    tuning,
    sound: "guitar",
    measures: [
      // arpeggios: Em · C · G · D, every note left ringing under the next
      bl({ [E2]: "0 . . . . . . .", [D3]: ". 2 . . . . 2 .", [G3]: ". . 0 . . . . .", [B3]: ". . . 0 . . . 0", [E4]: ". . . . 0 . . ." }, "4/4", 2, "ARPEGGIOS · let ring", { repeatStart: true }),
      bl({ [A2]: "3 . . . . . . .", [D3]: ". 2 . . . . 2 .", [G3]: ". . 0 . . . . .", [B3]: ". . . 1 . . . 1", [E4]: ". . . . 0 . . ." }, "4/4", 2),
      bl({ [E2]: "3 . . . . . . .", [D3]: ". 0 . . . . 0 .", [G3]: ". . 0 . . . . .", [B3]: ". . . 0 . . . 0", [E4]: ". . . . 3 . . ." }, "4/4", 2),
      bl({ [D3]: "0 . . . . . . .", [G3]: ". 2 . . . . 2 .", [B3]: ". . 3 . . . . .", [E4]: ". . . 2 . . . 2" }, "4/4", 2, undefined, { repeatEnd: 2 }),
      // a melody on the top two strings: hammer-ons, pull-offs, slides, vibrato
      bl({ [B3]: "7 h8 p7 . 5 . 3 ~", [E4]: ". . . 7 . . . ." }, "4/4", 2, "MELODY · legato, slides, vibrato"),
      bl({ [B3]: "3 /5 = = 5 h7 p5 =", [E4]: ". . . . . . . ." }, "4/4", 2),
      bl({ [B3]: "8 ~ = = 7 . 5 .", [E4]: ". . . . . 7 . 5" }, "4/4", 2),
      bl({ [B3]: "3 . 3 b = r ~ =", [E4]: "0 . . . . . . ." }, "4/4", 2),
      // double stops in fourths, then thirds
      bl({ [B3]: "3 . 3 . 5 . 7 =", [E4]: "3 . 3 . 5 . 7 =" }, "4/4", 2, "DOUBLE STOPS"),
      bl({ [G3]: "4 . 4 . 5 . 7 =", [B3]: "5 . 5 . 7 . 8 =" }, "4/4", 2),
      // open chords, strummed and left to ring
      bl({ [E2]: "0 ~ = = = = = =", [A2]: "2 = = = = = = =", [D3]: "2 = = = = = = =", [G3]: "0 = = = = = = =", [B3]: "0 = = = = = = =", [E4]: "0 = = = = = = =" }, "4/4", 2, "CHORDS · let ring"),
      bl({ [A2]: "3 ~ = = = = = =", [D3]: "2 = = = = = = =", [G3]: "0 = = = = = = =", [B3]: "1 = = = = = = =", [E4]: "0 = = = = = = =" }, "4/4", 2),
      bl({ [E2]: "3 ~ = = = = = =", [A2]: "2 = = = = = = =", [D3]: "0 = = = = = = =", [G3]: "0 = = = = = = =", [B3]: "0 = = = = = = =", [E4]: "3 = = = = = = =" }, "4/4", 2),
      bl({ [E2]: "0 ~ = = = = = =", [A2]: "2 = = = = = = =", [D3]: "2 = = = = = = =", [G3]: "0 = = = = = = =", [B3]: "0 = = = = = = =", [E4]: "0 = = = = = = =" }, "4/4", 2),
      bl({ [E2]: "= = = = = = = =", [A2]: "= = = = = = = =", [D3]: "= = = = = = = =", [G3]: "= = = = = = = =", [B3]: "= = = = = = = =", [E4]: "= = = = = = = =" }, "4/4", 2),
    ],
    updatedAt: Date.now(),
  };
}
