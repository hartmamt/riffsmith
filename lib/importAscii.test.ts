import { describe, expect, it } from "vitest";
import { importAscii } from "./importAscii";
import { DEFAULT_SIG, DEFAULT_SPB, Song, TUNING_PRESETS, emptyMeasure, toAscii } from "./model";

// A song whose bars deliberately disagree with each other: three meters, four
// grids, repeats, and tokens of every width ("0", "m10", "^12", "/7"). The
// exporter and importer must agree on slot width per line for this to survive.
function mixedSong(): Song {
  const tuning = [...TUNING_PRESETS["Drop B"]];
  const bar = (sig: string, spb: number, cells: Record<number, string[]>, extra: Partial<ReturnType<typeof emptyMeasure>> = {}) => {
    const m = emptyMeasure(tuning.length, sig, spb);
    for (const [si, toks] of Object.entries(cells)) toks.forEach((t, c) => { if (t !== ".") m.cols[c][Number(si)] = t; });
    return { ...m, ...extra };
  };
  return {
    id: "rt", title: "Round trip", artist: "QA", bpm: 150, tuning, sound: "guitar", updatedAt: 0,
    measures: [
      bar("3/4", 4, { 5: "m0 m0 m10 m0 m0 x m0 m0 3 = m0 m0".split(" ") }, { label: "A", repeatStart: true }),
      bar("3/4", 4, { 5: "0 /7 = = ^12 ~ = = 5 h7 p5 =".split(" ") }, { repeatEnd: 2 }),
      bar("5/4", 3, { 5: "m0 m0 m0 m3 m3 m3 m5 m5 m5 m6 m6 m6 m8 m8 m8".split(" "), 4: ". . . . . . . . . . . . 5 . .".split(" ") }, { label: "B" }),
      bar("5/4", 3, { 5: "0 = = 3 = = 5 = = 6 = = 8 = =".split(" ") }),
      bar("3/4", 4, { 5: "m0 m0 m0 m0 m0 m0 m0 m0 m0 m0 m0 m0".split(" ") }, { label: "C" }),
      bar("6/8", 2, { 5: "0 . 0 . 0 . 3 . 3 . 3 .".split(" ") }, { label: "D" }),
      bar("6/8", 2, { 5: "5 = = = = = 3 ~ = = = =".split(" ") }),
    ],
  };
}

describe("ASCII round trip", () => {
  it("preserves signatures, grids, slot counts, repeats and every token across mixed bars", () => {
    const song = mixedSong();
    const res = importAscii(toAscii(song));
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.warnings).toEqual([]);
    expect(res.song.measures.length).toBe(song.measures.length);
    song.measures.forEach((m, i) => {
      const r = res.song.measures[i];
      expect([i, r.sig ?? DEFAULT_SIG]).toEqual([i, m.sig ?? DEFAULT_SIG]);
      expect([i, r.spb ?? DEFAULT_SPB]).toEqual([i, m.spb ?? DEFAULT_SPB]);
      expect([i, r.cols.length]).toEqual([i, m.cols.length]);
      expect([i, !!r.repeatStart, r.repeatEnd ?? 0]).toEqual([i, !!m.repeatStart, m.repeatEnd ?? 0]);
      expect([i, r.cols]).toEqual([i, m.cols]);
    });
  });

  it("does not let a wide token in one bar change the slot width of its neighbours", () => {
    const song = mixedSong();
    const text = toAscii(song);
    // every bar segment on a line must be a multiple of that line's slot width
    for (const line of text.split("\n").filter((l) => /^[A-G]#?\s*\|/.test(l))) {
      const segs = line.split("|").slice(1).map((s) => s.replace(/^:|:$/g, "").replace(/^x\d+/, "")).filter((s) => s.length > 1);
      const widths = segs.map((s) => s.length);
      const w = Math.min(...widths.map((n) => n % 2 === 0 ? 2 : n % 3 === 0 ? 3 : 4));
      for (const n of widths) expect(n % w).toBe(0);
    }
  });
});
