import { describe, expect, it } from "vitest";
import { TUNING_PRESETS, emptyMeasure } from "./model";
import { bassColsFollowing, placeOnBass } from "./bassFollow";

const GUITAR = TUNING_PRESETS["E Standard"];
const BASS = TUNING_PRESETS["Bass E Std"];

function bar(lines: Record<number, string>) {
  const m = emptyMeasure(GUITAR.length, "4/4", 2);
  for (const [si, toks] of Object.entries(lines)) toks.split(" ").forEach((t, c) => { if (t !== ".") m.cols[c][Number(si)] = t; });
  return m;
}

describe("bass follows guitar", () => {
  it("puts the guitar's lowest note an octave down on the lowest bass string that reaches it", () => {
    // E standard low E fret 3 = G2 (43) → bass G1 (31) = E string fret 3
    expect(placeOnBass(43, BASS)).toEqual({ string: 3, fret: 3 });
    // A string fret 7 on guitar = E3 (52) → E1 (28) = open E on bass, not E2 on the D string
    expect(placeOnBass(52, BASS)).toEqual({ string: 3, fret: 0 });
  });

  it("keeps palm mutes, holds and rests", () => {
    const cols = bassColsFollowing(bar({ 5: "m0 m3 . 5 = . x ~", 4: ". . 2 . . . . ." }), GUITAR, BASS);
    const low = cols.map((c) => c[3]);
    expect(low[0]).toBe("m0");   // palm-muted E → palm-muted bass E
    expect(low[1]).toBe("m3");
    expect(low[2]).toBe("7");    // only the A-string B2 (47) sounds → bass B1 = E string fret 7
    expect(low[3]).toBe("5");
    expect(low[4]).toBe("=");    // hold follows
    expect(low[5]).toBe("");     // rest stays a rest
    expect(low[6]).toBe("");     // a dead chug has no pitch to follow
    expect(low[7]).toBe("=");    // vibrato on the guitar reads as a hold for the bass
  });

  it("chooses the lowest guitar note when a chord is played", () => {
    const cols = bassColsFollowing(bar({ 5: "0 . . . . . . .", 4: "2 . . . . . . .", 3: "2 . . . . . . ." }), GUITAR, BASS);
    expect(cols[0][3]).toBe("0"); // E5 chord → E
  });
});
