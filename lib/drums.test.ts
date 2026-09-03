import { describe, expect, it } from "vitest";
import { TUNING_PRESETS, emptyMeasure, Song } from "./model";
import { ROW_INDEX, drumsFollowGuitar } from "./drums";

function song(cells: Record<number, string>[], spb = 4, sig = "4/4"): Song {
  const tuning = [...TUNING_PRESETS["E Standard"]];
  return {
    id: "d", title: "d", artist: "", bpm: 120, tuning, updatedAt: 0,
    measures: cells.map((lines, i) => {
      const m = emptyMeasure(tuning.length, sig, spb);
      for (const [si, toks] of Object.entries(lines)) toks.split(" ").forEach((t, c) => { if (t !== ".") m.cols[c][Number(si)] = t; });
      if (i === 0) m.label = "RIFF";
      return m;
    }),
  };
}

describe("drums follow guitar", () => {
  it("kicks with the chugs, snares the backbeats, rides the hats, crashes the section", () => {
    const [m] = drumsFollowGuitar(song([{ 5: "m0 m0 m0 3 m0 m0 5 . m0 m0 m0 6 m0 m0 . ." }]));
    const row = (r: keyof typeof ROW_INDEX) => m.drums!.map((c) => c[ROW_INDEX[r]] || ".").join(" ");
    expect(row("kick")).toBe("X x x x . x x . X x x x . x . .");     // chug attacks, no kick under the snare
    expect(row("snare")).toBe(". . . . X . . . . . . . X . . .");    // beats 2 and 4
    expect(row("hat")).toBe(". x x x X x x x X x x x X x x x");      // 16ths (dense riff), accented on beats, crash takes slot 1
    expect(row("crash")).toBe("X . . . . . . . . . . . . . . .");
  });

  it("uses 8th-note hats on a sparse riff and puts a kick on a silent downbeat", () => {
    const [m] = drumsFollowGuitar(song([{ 5: ". . . . 3 . . . . . . . 5 . . ." }]));
    m.label = undefined;
    const row = (r: keyof typeof ROW_INDEX) => m.drums!.map((c) => c[ROW_INDEX[r]] || ".").join(" ");
    expect(row("hat")).toBe(". . x . X . x . X . x . X . x .");
    expect(row("kick")).toBe("X . . . . . . . . . . . . . . .");   // downbeat kick; beat 2/4 attacks are under the snare
  });

  it("puts the snare on the last beat in odd meters", () => {
    const [m] = drumsFollowGuitar(song([{ 5: "0 . . . . . . . . . . ." }], 4, "3/4"));
    const snare = m.drums!.map((c) => c[ROW_INDEX.snare] || ".").join(" ");
    expect(snare).toBe(". . . . . . . . X . . .");
  });
});
