import { describe, expect, it } from "vitest";
import { importAlphaTex, drumRowFor } from "./importGp";

// alphaTex: fret.string.duration, string 1 = high E. {pm} palm mute, x = dead,
// {h} hammer-on, {ss} shift slide, {b (0 4)} bend, {v} vibrato, r = rest.
const TEX = `\\title "Tex Riff"
\\tempo 150
\\track "Guitar"
\\ts 4 4
0.6{pm}.8 0.6{pm}.8 3.6{pm}.8 0.6{pm}.8 5.6.4 r.4 |
\\ts 3 4
0.6.8 2.6{h}.8 4.6.8 x.6.8 7.5{v}.4 |
\\track "Bass"
\\tuning e1 a1 d2 g2
0.4{pm}.4 3.4.4 5.4.2 |
0.4.2 2.4.4 |
`;

describe("Guitar Pro / alphaTex import", () => {
  it("maps meters, grids, techniques and tracks", async () => {
    const res = await importAlphaTex(TEX);
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    const { song, tracks, used } = res;
    expect(song.title).toBe("Tex Riff");
    expect(song.bpm).toBe(150);
    expect(tracks.map((t) => t.kind)).toEqual(["guitar", "bass"]);
    expect(used).toEqual({ guitar: 0, bass: 1, drums: null });
    expect(song.tuning).toEqual(["E4", "B3", "G3", "D3", "A2", "E2"]);
    // bar 1: 4/4, 8ths → grid 2, 8 slots
    const b1 = song.measures[0];
    expect(b1.sig).toBe("4/4"); expect(b1.spb).toBe(2); expect(b1.cols.length).toBe(8);
    expect(b1.cols.map((c) => c[5])).toEqual(["m0", "m0", "m3", "m0", "5", "=", "", ""]); // quarter note holds one extra slot, then a rest
    // bar 2: 3/4, hammer-on, dead note, vibrato on the A string
    const b2 = song.measures[1];
    expect(b2.sig).toBe("3/4"); expect(b2.cols.length).toBe(6);
    expect(b2.cols.map((c) => c[5])).toEqual(["0", "2", "h4", "x", "", ""]); // {h} on 2 makes 4 the hammered note
    expect(b2.cols[4][4]).toBe("7"); expect(b2.cols[5][4]).toBe("~");
    // bass lane on the same bars
    expect(song.bassTuning).toEqual(["G2", "D2", "A1", "E1"]);
    expect(b1.bass!.map((c) => c[3])).toEqual(["m0", "", "3", "=", "5", "=", "=", "="]);
  });

  it("maps GM percussion numbers onto the drum rows", () => {
    expect(drumRowFor(36)).toBe(3); expect(drumRowFor(38)).toBe(2); expect(drumRowFor(42)).toBe(1); expect(drumRowFor(49)).toBe(0); expect(drumRowFor(41)).toBe(-1);
  });
});
