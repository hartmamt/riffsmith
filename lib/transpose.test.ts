import { describe, expect, it } from "vitest";
import { TUNING_PRESETS, emptyMeasure, noteToMidi, Song } from "./model";
import { moveString, transposeMeasures, transposeToken } from "./transpose";

function song(cells: Record<number, string>[]): Song {
  const tuning = [...TUNING_PRESETS["E Standard"]];
  return {
    id: "t", title: "t", artist: "", bpm: 120, tuning, updatedAt: 0,
    measures: cells.map((lines) => {
      const m = emptyMeasure(tuning.length, "4/4", 2);
      for (const [si, toks] of Object.entries(lines)) toks.split(" ").forEach((t, c) => { if (t !== ".") m.cols[c][Number(si)] = t; });
      return m;
    }),
  };
}

describe("transpose", () => {
  it("moves every fret-bearing token and leaves marks alone", () => {
    expect(transposeToken("7", 2)).toBe("9");
    expect(transposeToken("m0", 3)).toBe("m3");
    expect(transposeToken("/5", -2)).toBe("/3");
    expect(transposeToken("h12", 1)).toBe("h13");
    expect(transposeToken("^7", 5)).toBe("^12");
    for (const mark of ["x", "~", "=", "*", "b", "r", ""]) expect(transposeToken(mark, 4)).toBe(mark);
  });

  it("refuses to push a note off the fretboard, naming the cell", () => {
    expect(transposeToken("0", -1)).toBeNull();
    expect(transposeToken("24", 1)).toBeNull();
    const r = transposeMeasures(song([{ 5: "m0 m0 3 =" }]), -1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Bar 1, slot 1, string 6/);
  });

  it("transposes only the requested bar range", () => {
    const r = transposeMeasures(song([{ 5: "0 2 3 =" }, { 5: "0 2 3 =" }]), 2, 1, 1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.measures[0].cols.map((c) => c[5])).toEqual(["0", "2", "3", "=", "", "", "", ""]);
      expect(r.measures[1].cols.map((c) => c[5])).toEqual(["2", "4", "5", "=", "", "", "", ""]);
    }
  });

  it("moves notes to another string at the same pitch", () => {
    // E standard: A string (4) fret 5 = D3 = D string (3) open
    const r = moveString(song([{ 4: "5 7 . ." }]), 4, 3, noteToMidi);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.measures[0].cols[0][3]).toBe("0");
      expect(r.measures[0].cols[1][3]).toBe("2");
      expect(r.measures[0].cols[0][4]).toBe("");
    }
    const bad = moveString(song([{ 4: "3 . . ." }]), 4, 3, noteToMidi); // A string fret 3 = C3, below the open D
    expect(bad.ok).toBe(false);
  });
});
