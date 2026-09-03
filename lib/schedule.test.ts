import { describe, expect, it } from "vitest";
import { Measure, Song, TUNING_PRESETS, emptyMeasure, toAscii } from "./model";
import { importAscii } from "./importAscii";
import {
  PlayPos, accentAt, advancePos, columnActions, fretOf, holdAfter,
  slotDurOf, vibratoAfter, songDurationSeconds } from "./schedule";

const TUNING = TUNING_PRESETS["Drop B"]; // C#4 G#3 E3 B2 F#2 B1 — B1 = midi 35
const LOW = TUNING.length - 1;

function song(measures: Measure[], bpm = 120): Song {
  return {
    id: "t", title: "t", artist: "", bpm,
    tuning: [...TUNING], measures, updatedAt: 0,
  };
}

function bar(cells: string, sig = "4/4", spb = 2, extra: Partial<Measure> = {}): Measure {
  const m = emptyMeasure(TUNING.length, sig, spb);
  cells.trim().split(/\s+/).forEach((t, i) => {
    if (t !== "-" && i < m.cols.length) m.cols[i][LOW] = t;
  });
  return { ...m, ...extra };
}

// walk the scheduler's position/time advance and collect onsets
function walk(s: Song, start = 0, end = Infinity, loop = false, maxSteps = 200) {
  const onsets: { t: number; m: number; c: number }[] = [];
  let pos: PlayPos = { m: start, c: 0, taken: {}, done: false };
  let t = 0;
  const endBar = Math.min(end, s.measures.length - 1);
  for (let i = 0; i < maxSteps && !pos.done; i++) {
    onsets.push({ t, m: pos.m, c: pos.c });
    t += slotDurOf(s, pos.m);
    pos = advancePos(s, pos, start, endBar, loop);
  }
  return onsets;
}

describe("slot timing", () => {
  it("computes slot durations from bpm, signature and grid", () => {
    const s = song([bar("", "4/4", 2), bar("", "3/4", 3), bar("", "5/4", 1)], 120);
    expect(slotDurOf(s, 0)).toBeCloseTo(0.25); // 8ths at 120
    expect(slotDurOf(s, 1)).toBeCloseTo(1 / 6); // triplets
    expect(slotDurOf(s, 2)).toBeCloseTo(0.5); // quarters
  });

  it("onset times accumulate exactly across mixed-signature bars", () => {
    const s = song([bar("", "3/4", 2), bar("", "4/4", 4)], 120);
    const onsets = walk(s);
    // bar 1: 6 slots × 0.25s = 1.5s, bar 2 starts exactly there
    const bar2first = onsets.find((o) => o.m === 1 && o.c === 0)!;
    expect(bar2first.t).toBeCloseTo(1.5, 10);
    // last onset of bar 2 = 1.5 + 15 × 0.125
    expect(onsets[onsets.length - 1].t).toBeCloseTo(1.5 + 15 * 0.125, 10);
  });
});

describe("repeats and looping", () => {
  it("plays a ‖: :‖×3 passage three times before the ending", () => {
    const s = song([
      bar("", "4/4", 1, { repeatStart: true }),
      bar("", "4/4", 1, { repeatEnd: 3 }),
      bar("", "4/4", 1),
    ]);
    const orderOfBars = walk(s).filter((o) => o.c === 0).map((o) => o.m);
    expect(orderOfBars).toEqual([0, 1, 0, 1, 0, 1, 2]);
  });

  it("loop wrap resets repeat counters", () => {
    const s = song([
      bar("", "4/4", 1, { repeatStart: true, repeatEnd: 2 }),
      bar("", "4/4", 1),
    ]);
    const bars = walk(s, 0, Infinity, true, 24).filter((o) => o.c === 0).map((o) => o.m);
    // 0,0,1 then loop → 0,0,1 again (taken cleared)
    expect(bars.slice(0, 6)).toEqual([0, 0, 1, 0, 0, 1]);
  });

  it("terminates when not looping", () => {
    const s = song([bar("", "4/4", 1)]);
    const onsets = walk(s, 0, Infinity, false);
    expect(onsets.length).toBe(4);
  });
});

describe("articulation selection", () => {
  it("plain fret is a pick with sustain from holds and vibrato from ~", () => {
    const s = song([bar("7 = ~ =", "4/4", 2)]);
    const a = columnActions(s, 0, 0);
    expect(a).toHaveLength(1);
    expect(a[0].kind).toBe("pick");
    expect(a[0].midi).toBe(35 + 7);
    expect(a[0].sustain).toBeCloseTo(3 * 0.25);
    expect(a[0].vibrato).toBe(true);
    // hold cells themselves are silent
    expect(columnActions(s, 0, 1)).toHaveLength(0);
    expect(columnActions(s, 0, 2)).toHaveLength(0);
  });

  it("h7 is a hammer carrying the source note", () => {
    const s = song([bar("5 h7 - -", "4/4", 2)]);
    const a = columnActions(s, 0, 1)[0];
    expect(a.kind).toBe("hammer");
    expect(a.midi).toBe(35 + 7);
    expect(a.fromMidi).toBe(35 + 5);
  });

  it("bare h marker (imported style) makes the following fret legato", () => {
    const s = song([bar("5 h 7 -", "4/4", 2)]);
    const a = columnActions(s, 0, 2)[0];
    expect(a.kind).toBe("hammer");
    expect(a.fromMidi).toBe(35 + 5);
  });

  it("b and r bend a whole step up and back on the same note", () => {
    const s = song([bar("5 b = r", "4/4", 2)]);
    const b = columnActions(s, 0, 1)[0];
    expect(b.kind).toBe("bend");
    expect(b.midi).toBe(35 + 7); // +200 cents target
    const r = columnActions(s, 0, 3)[0];
    expect(r.kind).toBe("release");
    expect(r.midi).toBe(35 + 5);
    expect(r.fromMidi).toBe(35 + 7);
  });

  it("m3 is a pitched palm mute; x is a dead hit", () => {
    const s = song([bar("m3 x - -", "4/4", 2)]);
    expect(columnActions(s, 0, 0)[0]).toMatchObject({ kind: "palm", midi: 35 + 3 });
    expect(columnActions(s, 0, 1)[0]).toMatchObject({ kind: "dead", midi: 35 });
  });

  it("* is ONE repick per cell, carrying the source articulation", () => {
    const s = song([bar("m0 * * *", "4/4", 4)]);
    for (const c of [1, 2, 3]) {
      const a = columnActions(s, 0, c);
      expect(a).toHaveLength(1);
      expect(a[0].kind).toBe("repick");
      expect(a[0].sourceKind).toBe("palm");
      expect(a[0].midi).toBe(35);
    }
  });

  it("/7 slides from the previous note into 7", () => {
    const s = song([bar("5 /7 - -", "4/4", 2)]);
    const a = columnActions(s, 0, 1)[0];
    expect(a.kind).toBe("slide");
    expect(a.fromMidi).toBe(35 + 5);
    expect(a.midi).toBe(35 + 7);
  });

  it("a fret covered by a standalone slide run is suppressed", () => {
    const s = song([bar("5 / 7 -", "4/4", 2)]);
    expect(columnActions(s, 0, 1)[0].kind).toBe("slide"); // glide starts here
    expect(columnActions(s, 0, 2)).toHaveLength(0); // 7 already sounded
  });
});

describe("accents", () => {
  it("triplet grid gets strong–weak–medium", () => {
    const s = song([bar("m0 m0 m0 m0 m0 m0 m0 m0 m0 m0 m0 m0", "4/4", 3)]);
    expect(accentAt(s, 0, 0)).toBe(1);
    expect(accentAt(s, 0, 1)).toBeCloseTo(0.72);
    expect(accentAt(s, 0, 2)).toBeCloseTo(0.86);
    expect(accentAt(s, 0, 3)).toBe(1);
    const acts = [0, 1, 2].map((c) => columnActions(s, 0, c)[0].velocity);
    expect(acts).toEqual([1, 0.72, 0.86]);
  });

  it("16th grid accents beats", () => {
    const s = song([bar("", "4/4", 4)]);
    expect(accentAt(s, 0, 0)).toBe(1);
    expect(accentAt(s, 0, 2)).toBeCloseTo(0.9);
  });
});

describe("meter denominators", () => {
  it("6/8 bars last half as long per slot as 6/4 (beat = eighth note)", () => {
    const s = song([bar("", "6/8", 2), bar("", "6/4", 2), bar("", "4/4", 2)], 300);
    expect(slotDurOf(s, 0)).toBeCloseTo(0.05, 6);  // (60/300/2) × 4/8
    expect(slotDurOf(s, 1)).toBeCloseTo(0.1, 6);
    expect(slotDurOf(s, 2)).toBeCloseTo(0.1, 6);
    // whole 6/8 bar = 3 quarter notes = 0.6s at ♩=300
    expect(slotDurOf(s, 0) * s.measures[0].cols.length).toBeCloseTo(0.6, 6);
  });
});

describe("ascii round trip", () => {
  it("export → import preserves bars, bpm, sections, sigs, repeats, techniques", () => {
    const src = song([
      bar("m0 m0 x /5 = h7", "3/4", 2, { label: "INTRO", repeatStart: true }),
      bar("5 b = r 0 * * * ~ =", "5/4", 2, { repeatEnd: 3 }),
    ], 159);
    src.title = "RT"; src.artist = "QA";
    const res = importAscii(toAscii(src));
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    const out = res.song;
    expect(out.measures).toHaveLength(2);
    expect(out.bpm).toBe(159);
    expect(out.title).toBe("RT");
    expect(out.artist).toBe("QA");
    expect(out.measures[0].label).toContain("INTRO");
    expect(out.measures[0].sig).toBe("3/4");
    expect(out.measures[1].sig).toBe("5/4");
    expect(out.measures[0].repeatStart).toBe(true);
    expect(out.measures[1].repeatEnd).toBe(3);
    expect(out.measures[0].cols.length).toBe(6);
    expect(out.measures[1].cols.length).toBe(10);
    // techniques survive verbatim on the low string
    expect(out.measures[0].cols.map((c) => c[LOW])).toEqual(["m0", "m0", "x", "/5", "=", "h7"]);
    expect(out.measures[1].cols.map((c) => c[LOW])).toEqual(["5", "b", "=", "r", "0", "*", "*", "*", "~", "="]);
  });
});

describe("tremolo picking", () => {
  it("grid=6 gives six onsets per beat with 55.6ms spacing at 180 BPM", () => {
    const s = song([bar("0 " + Array(23).fill("*").join(" "), "4/4", 6)], 180);
    expect(s.measures[0].cols.length).toBe(24);
    expect(slotDurOf(s, 0)).toBeCloseTo(60 / 180 / 6, 6); // 55.55ms
    const onsets = walk(s);
    expect(onsets.length).toBe(24);
    for (let i = 1; i < onsets.length; i++) {
      expect(onsets[i].t - onsets[i - 1].t).toBeCloseTo(0.05556, 4);
    }
    // exactly one action (attack) per cell — no sub-picks
    for (let c = 0; c < 24; c++) {
      expect(columnActions(s, 0, c)).toHaveLength(1);
    }
  });

  it("16ths at 220 BPM stay exact", () => {
    const s = song([bar("0 " + Array(15).fill("*").join(" "), "4/4", 4)], 220);
    expect(slotDurOf(s, 0)).toBeCloseTo(60 / 220 / 4, 6); // 68.2ms
    expect(walk(s).length).toBe(16);
  });

  it("repick velocities are near-even with a beat accent, deterministic", () => {
    const s = song([bar("0 " + Array(15).fill("*").join(" "), "4/4", 4)], 180);
    const vels = Array.from({ length: 16 }, (_, c) => columnActions(s, 0, c)[0].velocity);
    // beat-start repicks get 1.0, the rest 0.92 — no wide 0.78 swings
    expect(vels[4]).toBe(1);
    expect(vels[5]).toBe(0.92);
    expect(Math.min(...vels.slice(1))).toBeGreaterThanOrEqual(0.92);
    // deterministic: same input, same output
    const again = Array.from({ length: 16 }, (_, c) => columnActions(s, 0, c)[0].velocity);
    expect(again).toEqual(vels);
  });

  it("pitch changes inside a tremolo line stay on their cells", () => {
    const s = song([bar("5 * * * 7 * * * 8 * 7 * 5 * * *", "4/4", 4)], 200);
    const acts = Array.from({ length: 16 }, (_, c) => columnActions(s, 0, c)[0]);
    expect(acts[0]).toMatchObject({ kind: "pick", midi: 40 });
    expect(acts[3]).toMatchObject({ kind: "repick", midi: 40 });
    expect(acts[4]).toMatchObject({ kind: "pick", midi: 42 });
    expect(acts[9]).toMatchObject({ kind: "repick", midi: 43 });
    expect(acts[10]).toMatchObject({ kind: "pick", midi: 42 }); // the "7" after "8 *"
  });
});

describe("gap awareness", () => {
  it("palm actions carry the distance to the next hit", () => {
    const s = song([bar("m0 m0 - - m0 - - -", "4/4", 2)]); // 0.25s slots at 120
    expect(columnActions(s, 0, 0)[0].gap).toBeCloseTo(0.25); // next hit adjacent
    expect(columnActions(s, 0, 1)[0].gap).toBeCloseTo(0.75); // two rests
    expect(columnActions(s, 0, 4)[0].gap).toBeCloseTo(2.0); // nothing after → cap (base decay wins)
  });

  it("gap scan skips holds and crosses bar lines", () => {
    const s = song([bar("- - m0 =", "2/4", 2), bar("7 - - -", "2/4", 2)]);
    expect(columnActions(s, 0, 2)[0].gap).toBeCloseTo(0.5); // = then bar 2's 7
  });
});

describe("helpers", () => {
  it("fretOf handles all prefixes", () => {
    expect(fretOf("7")).toBe(7);
    expect(fretOf("/12")).toBe(12);
    expect(fretOf("h3")).toBe(3);
    expect(fretOf("m0")).toBe(0);
    expect(fretOf("x")).toBeNull();
    expect(fretOf("=")).toBeNull();
  });

  it("holdAfter and vibratoAfter scan across bar lines", () => {
    const s = song([bar("- - - 7", "2/4", 2), bar("= ~ - -", "2/4", 2)]);
    expect(holdAfter(s, LOW, 0, 3)).toBeCloseTo(0.5);
    expect(vibratoAfter(s, LOW, 0, 3)).toBe(true);
  });
});

describe("pinch harmonics (^fret)", () => {
  const mk = (): Song => {
    const m = emptyMeasure(6, "4/4", 2);
    m.cols[0][5] = "0";
    m.cols[1][5] = "^7";
    m.cols[2][5] = "=";
    m.cols[3][5] = "~";
    return { id: "p", title: "P", artist: "", bpm: 120, tuning: [...TUNING_PRESETS["Drop B"]], measures: [m], updatedAt: 0 };
  };
  it("schedules a picked pinch action at the fretted pitch, holding and vibrato applied", () => {
    const s = mk();
    const a = columnActions(s, 0, 1);
    expect(a).toHaveLength(1);
    expect(a[0].kind).toBe("pinch");
    expect(a[0].midi).toBe(35 + 7);
    expect(a[0].vibrato).toBe(true);
    expect(a[0].sustain).toBeGreaterThan(0);
  });
  it("round-trips through ASCII export and import", () => {
    const s = mk();
    const res = importAscii(toAscii(s));
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.song.measures[0].cols[1][5]).toBe("^7");
    expect(res.song.measures[0].cols[0][5]).toBe("0");
  });
});

describe("songDurationSeconds", () => {
  it("expands repeats and honours per-bar meters", () => {
    // 8ths at 120 BPM: a 4/4 bar is 2 s, a 3/4 bar is 1.5 s
    const s = song([bar("0 0 0 0 0 0 0 0"), bar("0 0 0 0 0 0 0 0")], 120);
    expect(songDurationSeconds(s)).toBeCloseTo(4, 5);
    s.measures[0].repeatStart = true; s.measures[1].repeatEnd = 2;
    expect(songDurationSeconds(s)).toBeCloseTo(8, 5);
    const mixed = song([bar("0 0 0 0 0 0 0 0"), bar("0 0 0 0 0 0", "3/4")], 120);
    expect(songDurationSeconds(mixed)).toBeCloseTo(3.5, 5);
  });
});
