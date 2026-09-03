// Guitar Pro import (gp3/gp4/gp5/gpx/gp, also MusicXML and alphaTex) via
// alphaTab's parser. The score's first guitar-like staff becomes the song,
// a bass-like staff becomes the bass lane, a percussion staff the drum lane.
// Every bar keeps its meter and repeats; the grid is chosen per bar from the
// finest note value present, and each articulation maps to our notation.
import { Measure, Song, defaultBassTuning, newSong, SIGS } from "./model";
import { DRUM_ROWS, withDrumTrack } from "./drums";
import { withBassTrack } from "./model";

// alphaTab types are large; we only touch a handful of fields
type ATNote = {
  fret: number; string: number; isPalmMute: boolean; isDead: boolean; isTieDestination: boolean; isLetRing: boolean;
  isHammerPullDestination: boolean; hammerPullOrigin: ATNote | null; slideOutType: number; slideOrigin: ATNote | null;
  hasBend: boolean; bendType: number; vibrato: number; harmonicType: number; percussionArticulation: number; isPercussion: boolean;
};
type ATBeat = { notes: ATNote[]; isRest: boolean; isPalmMute: boolean; isLetRing: boolean; isTremolo: boolean; playbackStart: number; playbackDuration: number; duration: number; tupletNumerator: number; tupletDenominator: number; vibrato: number; isEmpty: boolean };
type ATVoice = { beats: ATBeat[] };
type ATBar = { voices: ATVoice[]; masterBar: ATMasterBar };
type ATMasterBar = { timeSignatureNumerator: number; timeSignatureDenominator: number; isRepeatStart: boolean; repeatCount: number; section: { text: string; marker: string } | null; calculateDuration: () => number; index: number };
type ATStaff = { bars: ATBar[]; tuning: number[]; isPercussion: boolean; isStringed: boolean };
type ATTrack = { name: string; staves: ATStaff[]; percussionArticulations: { outputMidiNumber: number }[] };
type ATScore = { title: string; artist: string; tempo: number; tracks: ATTrack[]; masterBars: ATMasterBar[] };

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const midiToName = (m: number) => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

export type GpTrackInfo = { index: number; name: string; strings: number; kind: "guitar" | "bass" | "drums" | "other"; bars: number };
export type GpImportResult = { song: Song; tracks: GpTrackInfo[]; used: { guitar: number; bass: number | null; drums: number | null }; warnings: string[] };

function kindOf(t: ATTrack): GpTrackInfo["kind"] {
  const st = t.staves[0];
  if (!st) return "other";
  if (st.isPercussion) return "drums";
  if (!st.isStringed || !st.tuning.length) return "other";
  const lowest = Math.min(...st.tuning);
  if (st.tuning.length <= 5 && lowest < 36) return "bass";
  if (st.tuning.length >= 6 && st.tuning.length <= 9) return "guitar";
  return "other";
}

/** Grid (slots per beat) that represents every beat start in this bar exactly: 1, 2, 3, 4 or 6. */
function gridFor(bar: ATBar, barTicks: number, beats: number): number {
  const starts: number[] = [];
  for (const v of bar.voices) for (const b of v.beats) if (!b.isEmpty) starts.push(b.playbackStart);
  for (const spb of [1, 2, 4, 3, 6]) {
    const slotTicks = barTicks / (beats * spb);
    if (starts.every((s) => Math.abs(s / slotTicks - Math.round(s / slotTicks)) < 0.02)) return spb;
  }
  return 6;
}

/** Load a Guitar Pro file (any format alphaTab reads) and convert it. */
export async function importGuitarPro(bytes: Uint8Array, opts: { track?: number; bass?: number | null; drums?: number | null } = {}): Promise<GpImportResult | { error: string }> {
  let score: ATScore;
  try {
    const at = await import("@coderline/alphatab");
    score = at.importer.ScoreLoader.loadScoreFromBytes(bytes) as unknown as ATScore;
  } catch (e) {
    return { error: `Could not read the file: ${e instanceof Error ? e.message : String(e)}` };
  }
  return convertScore(score, opts);
}

/** Same, from alphaTex text (used by tests and agents that write alphaTex). */
export async function importAlphaTex(tex: string, opts: { track?: number; bass?: number | null; drums?: number | null } = {}): Promise<GpImportResult | { error: string }> {
  try {
    const at = await import("@coderline/alphatab");
    const score = at.importer.ScoreLoader.loadAlphaTex(tex) as unknown as ATScore;
    return convertScore(score, opts);
  } catch (e) {
    return { error: `Could not read the alphaTex: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function convertScore(score: ATScore, opts: { track?: number; bass?: number | null; drums?: number | null } = {}): GpImportResult | { error: string } {
  const warnings: string[] = [];
  const tracks: GpTrackInfo[] = score.tracks.map((t, i) => ({ index: i, name: t.name, strings: t.staves[0]?.tuning.length ?? 0, kind: kindOf(t), bars: t.staves[0]?.bars.length ?? 0 }));
  const guitarIdx = opts.track ?? tracks.find((t) => t.kind === "guitar")?.index ?? tracks.find((t) => t.kind === "bass")?.index;
  if (guitarIdx === undefined || !score.tracks[guitarIdx]) return { error: `No guitar or bass track found (${tracks.map((t) => `${t.index}: ${t.name} · ${t.kind}`).join(", ") || "no tracks"}).` };
  const main = score.tracks[guitarIdx].staves[0];
  if (!main || !main.isStringed) return { error: `Track ${guitarIdx} (${score.tracks[guitarIdx].name}) has no string staff.` };
  const bassIdx = opts.bass === null ? null : opts.bass ?? tracks.find((t) => t.kind === "bass" && t.index !== guitarIdx)?.index ?? null;
  const drumIdx = opts.drums === null ? null : opts.drums ?? tracks.find((t) => t.kind === "drums")?.index ?? null;

  // tunings: alphaTab lists strings high → low? Its tuning array is ordered by string number 1..n = lowest..highest? Normalise: high → low as we store it.
  const toHighLow = (tun: number[]) => [...tun].sort((a, b) => b - a);
  const tuning = toHighLow(main.tuning).map(midiToName);
  const nStr = tuning.length;
  const bassStaff = bassIdx !== null ? score.tracks[bassIdx]?.staves[0] : null;
  const bassTuning = bassStaff ? toHighLow(bassStaff.tuning).map(midiToName) : null;
  const drumTrack = drumIdx !== null ? score.tracks[drumIdx] : null;

  const measures: Measure[] = [];
  const nBars = main.bars.length;
  let dropped = 0;
  for (let mi = 0; mi < nBars; mi++) {
    const bar = main.bars[mi];
    const mb = bar.masterBar;
    const beats = mb.timeSignatureNumerator, denom = mb.timeSignatureDenominator;
    const sig = `${beats}/${denom}`;
    const barTicks = mb.calculateDuration();
    const spb = gridFor(bar, barTicks, beats);
    const nCols = beats * spb;
    const slotTicks = barTicks / nCols;
    const cols: string[][] = Array.from({ length: nCols }, () => Array(nStr).fill(""));
    const fill = (staff: ATStaff, target: string[][], strings: number, stringTuningHighLow: number[]) => {
      const b = staff.bars[mi]; if (!b) return;
      for (const v of b.voices) {
        for (const beat of v.beats) {
          if (beat.isEmpty || beat.isRest) continue;
          const c = Math.min(nCols - 1, Math.round(beat.playbackStart / slotTicks));
          const durSlots = Math.max(1, Math.round(beat.playbackDuration / slotTicks));
          for (const n of beat.notes) {
            // alphaTab string 1 = lowest → our index 0 = highest
            const si = strings - n.string;
            if (si < 0 || si >= strings) continue;
            if (n.isTieDestination) { if (!target[c][si]) target[c][si] = "="; continue; }
            let tok: string;
            if (n.isDead) tok = "x";
            else if (n.harmonicType === 3 /* Pinch */) tok = `^${n.fret}`;
            else if (n.isHammerPullDestination && n.hammerPullOrigin) tok = `${n.fret < n.hammerPullOrigin.fret ? "p" : "h"}${n.fret}`;
            else if (n.slideOrigin && (n.slideOrigin.slideOutType === 1 || n.slideOrigin.slideOutType === 2)) tok = `${n.fret > n.slideOrigin.fret ? "/" : "\\"}${n.fret}`;
            else tok = `${(n.isPalmMute || beat.isPalmMute) ? "m" : ""}${n.fret}`;
            if (n.fret > 24) { dropped++; continue; }
            if (target[c][si] && target[c][si] !== "=") dropped++;
            target[c][si] = tok;
            // what happens after the attack: bend, vibrato, or a hold for long notes
            const after = c + 1;
            if (n.hasBend && after < nCols && !target[after][si]) target[after][si] = n.bendType === 3 /* Release */ ? "r" : "b";
            else if ((n.vibrato || beat.vibrato) && after < nCols && !target[after][si]) target[after][si] = "~";
            if (beat.isTremolo) { for (let k = 1; k < durSlots && c + k < nCols; k++) if (!target[c + k][si]) target[c + k][si] = "*"; }
            else if (durSlots > 1 && !n.isPalmMute && !beat.isPalmMute && !n.isDead) {
              // held longer than a slot: mark the hold so the ring matches the written value (skip for chugs)
              for (let k = 1; k < durSlots && c + k < nCols; k++) if (!target[c + k][si]) target[c + k][si] = "=";
            }
          }
        }
      }
    };
    fill(main, cols, nStr, toHighLow(main.tuning));
    const measure: Measure = { cols, sig: SIGS.includes(sig) ? sig : undefined, spb };
    if (!SIGS.includes(sig)) warnings.push(`Bar ${mi + 1}: ${sig} isn't a supported meter; treated as 4/4.`);
    if (mb.isRepeatStart) measure.repeatStart = true;
    if (mb.repeatCount > 1) measure.repeatEnd = Math.min(16, mb.repeatCount);
    if (mb.section?.text || mb.section?.marker) measure.label = (mb.section.text || mb.section.marker).trim();
    if (bassStaff && bassTuning) {
      const bcols: string[][] = Array.from({ length: nCols }, () => Array(bassTuning.length).fill(""));
      fill(bassStaff, bcols, bassTuning.length, toHighLow(bassStaff.tuning));
      measure.bass = bcols;
    }
    if (drumTrack) {
      const dst = drumTrack.staves[0];
      const dcols: string[][] = Array.from({ length: nCols }, () => Array(DRUM_ROWS.length).fill(""));
      const b = dst?.bars[mi];
      if (b) for (const v of b.voices) for (const beat of v.beats) {
        if (beat.isEmpty || beat.isRest) continue;
        const c = Math.min(nCols - 1, Math.round(beat.playbackStart / slotTicks));
        for (const n of beat.notes) {
          const midi = drumTrack.percussionArticulations[n.percussionArticulation]?.outputMidiNumber ?? n.percussionArticulation;
          const row = drumRowFor(midi);
          if (row < 0) continue;
          dcols[c][row] = midi === 46 ? "o" : dcols[c][row] || "x";
        }
      }
      measure.drums = dcols;
    }
    measures.push(measure);
  }
  if (dropped) warnings.push(`${dropped} note(s) could not be placed (frets above 24 or two notes on one string in one slot).`);

  let song: Song = {
    ...newSong(score.title?.trim() || "Imported Guitar Pro"),
    artist: score.artist?.trim() ?? "",
    bpm: Math.min(300, Math.max(30, Math.round(score.tempo || 120))),
    tuning,
    measures,
  };
  if (bassTuning) song = withBassTrack(song, true, bassTuning);
  else if (opts.bass !== null && !bassStaff) { /* no bass in the file */ }
  if (drumTrack) song = withDrumTrack(song, true);
  void defaultBassTuning;
  return { song, tracks, used: { guitar: guitarIdx, bass: bassIdx, drums: drumIdx }, warnings };
}

/** GM/GP7 percussion number → our drum row (crash · hat · snare · kick), -1 to skip. */
export function drumRowFor(midi: number): number {
  if (midi === 35 || midi === 36) return 3;
  if ([31, 33, 34, 37, 38, 40, 39].includes(midi)) return 2;
  if ([42, 44, 46, 51, 53, 59].includes(midi)) return 1;
  if ([49, 57, 55, 52, 30, 29].includes(midi)) return 0;
  return -1;
}
