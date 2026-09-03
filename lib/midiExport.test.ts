import { describe, expect, it } from "vitest";
import { TUNING_PRESETS, emptyMeasure, Song, withBassTrack } from "./model";
import { withDrumTrack } from "./drums";
import { songToMidi } from "./midiExport";

function song(): Song {
  const tuning = [...TUNING_PRESETS["E Standard"]];
  const m = emptyMeasure(tuning.length, "4/4", 2);
  "m0 m0 3 . 5 = = =".split(" ").forEach((t, c) => { if (t !== ".") m.cols[c][5] = t; });
  let s: Song = { id: "m", title: "MIDI test", artist: "", bpm: 120, tuning, updatedAt: 0, measures: [m, { ...m, cols: m.cols.map((c) => [...c]), repeatEnd: 2 }] };
  s.measures[0].repeatStart = true;
  s = withBassTrack(s, true); s.measures[0].bass![0][3] = "0"; s.measures[0].bass![4][3] = "5";
  s = withDrumTrack(s, true); s.measures[0].drums![0][3] = "X"; s.measures[0].drums![4][2] = "X";
  return s;
}

function parse(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer);
  expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("MThd");
  const format = dv.getUint16(8), nTracks = dv.getUint16(10), ppq = dv.getUint16(12);
  const tracks: { name: string; noteOns: number; channels: Set<number> }[] = [];
  let p = 14;
  for (let t = 0; t < nTracks; t++) {
    expect(String.fromCharCode(...bytes.slice(p, p + 4))).toBe("MTrk");
    const len = dv.getUint32(p + 4); const end = p + 8 + len; let i = p + 8; let name = ""; let noteOns = 0; const channels = new Set<number>(); let running = 0;
    while (i < end) {
      while (bytes[i] & 0x80) i++; i++; // delta time
      let st = bytes[i];
      if (st === 0xff) { const type = bytes[i + 1]; let l = 0, j = i + 2; while (bytes[j] & 0x80) { l = (l << 7) | (bytes[j] & 0x7f); j++; } l = (l << 7) | bytes[j]; j++; if (type === 3) name = String.fromCharCode(...bytes.slice(j, j + l)); i = j + l; continue; }
      if (st & 0x80) { running = st; i++; } else st = running;
      const kind = st & 0xf0; channels.add(st & 0x0f);
      if (kind === 0x90 && bytes[i + 1] > 0) noteOns++;
      i += kind === 0xc0 || kind === 0xd0 ? 1 : 2;
    }
    tracks.push({ name, noteOns, channels }); p = end;
  }
  return { format, nTracks, ppq, tracks };
}

describe("MIDI export", () => {
  it("writes a format-1 file with guitar, bass and drum tracks and expands repeats", () => {
    const f = parse(songToMidi(song()));
    expect(f.format).toBe(1); expect(f.ppq).toBe(480); expect(f.nTracks).toBe(4);
    expect(f.tracks.map((t) => t.name)).toEqual(["MIDI test", "Guitar", "Bass", "Drums"]);
    // 4 attacks per bar × 2 bars × played twice (repeat) = 16 guitar notes
    expect(f.tracks[1].noteOns).toBe(16);
    expect(f.tracks[2].noteOns).toBe(4);   // 2 bass notes per pass × 2 passes (bar 2's bass lane is empty)
    expect(f.tracks[3].noteOns).toBe(4);   // kick + snare per pass × 2
    expect([...f.tracks[3].channels]).toEqual([9]);
  });
});
