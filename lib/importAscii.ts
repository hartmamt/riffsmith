// ASCII tab importer. Handles the common hand-written format:
//
//   [1] 0:01  INTRO RIFF   3/4   ~159 BPM
//   E |----------3--2----|----------0-------|
//   B |----0--3--------3-|----2--3-----3--2-|
//   F#|------------------|-0----------------|
//   B |-0----------------|------------------|
//     B  B  D  G  F# D     (note-name lines are ignored)
//
// Any string count (4-string bass, 6/7-string guitar), evenly spaced slots
// (2- or 3-char, detected per system), multi-digit frets, technique glyphs,
// inline 5/7 slides, |: :| repeat marks. Nothing is dropped silently —
// anything the parser had to skip or adapt comes back in `warnings`.

import { GRID_VALUES, Measure, Song, newSong, sigBeats } from "./model";

const TAB_LINE = /^\s*([A-Ga-g][#b]?)\s*\|(.*)$/;
// prefixed techniques ("m3", "/7", "h12") parse as single tokens so palm
// mutes and slide/hammer targets survive a round trip
const TOKEN = /(\d{1,2}[/\\hpt]\d{1,2})|([/\\hptm^]\d{1,2})|(\d{1,2})|([hpbrstx~/\\=*])/g;

type System = { labels: string[]; rows: string[]; header: string | null; sig: string | null };

function isTabLine(line: string): boolean {
  const m = line.match(TAB_LINE);
  if (!m) return false;
  const dashes = (m[2].match(/-/g) || []).length;
  return dashes >= 3;
}

const NOTE_ORDER: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6,
  Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};

// Assign octaves to bare string letters (top → bottom = high → low).
function assignOctaves(rawLabels: string[]): string[] {
  const labels = rawLabels.map((l) => l[0].toUpperCase() + l.slice(1));
  const count = labels.length;
  const bottom = labels[count - 1];
  const idx = NOTE_ORDER[bottom] ?? 4;
  const baseOct = count <= 5 ? 1 : 2;
  const bottomOct = idx >= 9 ? baseOct - 1 : baseOct; // A/A#/B sit below C of the octave
  const out: string[] = new Array(count);
  out[count - 1] = `${bottom}${bottomOct}`;
  let prevMidi = (bottomOct + 1) * 12 + idx;
  for (let s = count - 2; s >= 0; s--) {
    const ni = NOTE_ORDER[labels[s]] ?? 4;
    let oct = Math.floor(prevMidi / 12) - 1;
    while ((oct + 1) * 12 + ni <= prevMidi) oct++;
    out[s] = `${labels[s]}${oct}`;
    prevMidi = (oct + 1) * 12 + ni;
  }
  return out;
}

// Most common gap between token starts in this system's rows → slot width.
// Per-system, so a 2-char 16th-note section doesn't get flattened by a
// 3-char section elsewhere in the paste (and vice versa).
function detectStride(sys: System, fallback: number): number {
  const gaps: number[] = [];
  for (const row of sys.rows) {
    for (const seg of row.split("|")) {
      const positions: number[] = [];
      TOKEN.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TOKEN.exec(seg))) positions.push(m.index);
      for (let i = 1; i < positions.length; i++) {
        const g = positions[i] - positions[i - 1];
        if (g >= 2 && g <= 8) gaps.push(g);
      }
    }
  }
  if (!gaps.length) return fallback;
  const counts = new Map<number, number>();
  for (const g of gaps) counts.set(g, (counts.get(g) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function parseSystemMeasures(
  sys: System,
  stride: number,
  strings: number,
  warnings: string[]
): Measure[] {
  const perRow = sys.rows.map((r) => r.split("|").map((seg) => seg.replace(/\s+$/, "")));
  const barCount = Math.min(...perRow.map((segs) => segs.length));
  const measures: Measure[] = [];
  const where = sys.header ? `"${sys.header}"` : "an unlabeled system";
  let droppedTechniques = 0;

  // repeat marks: "|:" opens, ":|" closes, "xN" right after the closing bar
  // carries the count. Detect, then scrub so they never tokenize as notes.
  const repeatStartBars = new Set<number>();
  const repeatEndBars = new Map<number, number>();
  for (let b = 0; b < barCount; b++) {
    if (perRow.some((segs) => segs[b]?.trimStart().startsWith(":"))) repeatStartBars.add(b);
    if (perRow.some((segs) => segs[b]?.trimEnd().endsWith(":"))) {
      const xm = perRow[0]?.[b + 1]?.match(/^x(\d{1,2})/);
      repeatEndBars.set(b, xm ? parseInt(xm[1], 10) : 2);
    }
  }
  for (let r = 0; r < perRow.length; r++) {
    for (let b = 0; b < perRow[r].length; b++) {
      let seg = perRow[r][b].replace(/:/g, " ");
      if (b > 0 && repeatEndBars.has(b - 1)) {
        seg = seg.replace(/^x\d{1,2}/, (mm) => " ".repeat(mm.length));
      }
      perRow[r][b] = seg.replace(/\s+$/, "");
    }
  }

  for (let b = 0; b < barCount; b++) {
    const segs = perRow.map((segs) => segs[b] ?? "");
    const width = Math.max(...segs.map((s) => s.length));
    if (width < 2) continue; // empty trailing split
    if (!segs.some((sg) => /[^\s]/.test(sg))) continue; // scrubbed repeat-count remnant

    const tokens: { s: number; pos: number; v: string }[] = [];
    segs.forEach((rawSeg, s) => {
      if (s >= strings) return;
      // dense same-digit runs ("00000000", "8888") are repeated single-digit
      // hits, not multi-digit frets — emit one hit per 2 chars and mask the
      // run so the greedy tokenizer never reads "88" as fret 88
      let seg = rawSeg;
      const runRe = /(\d)\1{2,}/g;
      let rm: RegExpExecArray | null;
      const masks: [number, number][] = [];
      while ((rm = runRe.exec(rawSeg))) {
        for (let k = 0; k < rm[0].length; k += 2) {
          tokens.push({ s, pos: rm.index + k, v: rm[1] });
        }
        masks.push([rm.index, rm[0].length]);
      }
      for (const [at, len] of masks) {
        seg = seg.slice(0, at) + " ".repeat(len) + seg.slice(at + len);
      }
      TOKEN.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TOKEN.exec(seg))) {
        const combined = m[0].match(/^(\d{1,2})([/\\hpt])(\d{1,2})$/);
        if (combined) {
          // "5/7", "5h7" — source note on this slot, slide/hammer/pull/tap
          // note on the next
          tokens.push({ s, pos: m.index, v: combined[1] });
          tokens.push({ s, pos: m.index + stride, v: combined[2] + combined[3] });
        } else {
          tokens.push({ s, pos: m.index, v: m[0] });
        }
      }
    });

    const offset = tokens.length ? Math.min(...tokens.map((t) => t.pos)) % stride : 1;
    const nCols = Math.max(1, Math.ceil((width - offset) / stride));
    const cols = Array.from({ length: nCols }, () => Array(strings).fill(""));
    const isNote = (v: string) => /^[/\\hptm^]?\d/.test(v);
    let outOfRange = 0;
    for (const t of tokens) {
      const fretMatch = t.v.match(/(\d{1,2})/);
      if (fretMatch && parseInt(fretMatch[1], 10) > 24) { outOfRange++; continue; }
      const c = Math.min(nCols - 1, Math.max(0, Math.round((t.pos - offset) / stride)));
      const cur = cols[c][t.s];
      if (cur === t.v) continue; // dense-run duplicate landing on the same slot
      if (!cur) {
        cols[c][t.s] = t.v;
      } else if (isNote(t.v) && !isNote(cur)) {
        cols[c][t.s] = t.v; // frets win — relocate the displaced mark if possible
        if (c > 0 && !cols[c - 1][t.s]) cols[c - 1][t.s] = cur;
        else if (c + 1 < nCols && !cols[c + 1][t.s]) cols[c + 1][t.s] = cur;
        else droppedTechniques++;
      } else if (!isNote(t.v)) {
        // technique colliding with a note: try the neighboring empty slot
        if (c + 1 < nCols && !cols[c + 1][t.s]) cols[c + 1][t.s] = t.v;
        else if (c > 0 && !cols[c - 1][t.s]) cols[c - 1][t.s] = t.v;
        else droppedTechniques++;
      }
      // two notes landing on one slot: keep the first, count the loss
      else droppedTechniques++;
    }
    if (outOfRange > 0) {
      warnings.push(`${outOfRange} out-of-range fret(s) (>24) in ${where} were skipped.`);
    }
    const measure: Measure = { cols };
    if (b === 0 && sys.header) measure.label = sys.header;
    if (repeatStartBars.has(b)) measure.repeatStart = true;
    const repEnd = repeatEndBars.get(b);
    if (repEnd && repEnd > 1) measure.repeatEnd = Math.min(16, repEnd);
    if (sys.sig) {
      measure.sig = sys.sig;
      const raw = nCols / sigBeats(sys.sig);
      // snap to the nearest supported grid (incl. 6 for 16th triplets)
      measure.spb = GRID_VALUES.reduce((best, g) =>
        Math.abs(g - raw) < Math.abs(best - raw) ? g : best, GRID_VALUES[0]);
    } else {
      measure.spb = stride <= 2 ? 4 : 2;
    }
    measures.push(measure);
  }
  if (droppedTechniques > 0) {
    warnings.push(`${droppedTechniques} overlapping mark(s) in ${where} could not be placed and were dropped.`);
  }
  return measures;
}

function cleanHeader(line: string): string {
  return line.replace(/^\s*\[\d+\]\s*/, "").replace(/\s{2,}/g, " · ").replace(/--/g, "—").trim();
}

export type ImportResult = {
  song: Song;
  systems: number;
  bars: number;
  strings: number;
  warnings: string[];
};

export function importAscii(text: string, title?: string): ImportResult | { error: string } {
  const lines = text.split(/\r?\n/);
  const systems: System[] = [];
  const warnings: string[] = [];
  let i = 0;
  let lastHeader: string | null = null;
  let lastSig: string | null = null;

  while (i < lines.length) {
    const line = lines[i];
    if (isTabLine(line)) {
      const labels: string[] = [];
      const rows: string[] = [];
      while (i < lines.length && isTabLine(lines[i])) {
        const m = lines[i].match(TAB_LINE)!;
        labels.push(m[1]);
        rows.push(m[2]);
        i++;
      }
      systems.push({ labels, rows, header: lastHeader, sig: lastSig });
      lastHeader = null; // sig persists until the next header changes it
      continue;
    }
    // "[ LABEL · SIG ]" (ours) or "[Riff C] (note...)" — bracket must START
    // the line, so prose like "Play [Riff A] four times" stays ignored
    const bracket = line.match(/^\s*\[\s*([^\]]+?)\s*\]/);
    if (/^\s*\[\d+\]/.test(line) || bracket) {
      if (lastHeader) warnings.push(`Header "${lastHeader}" had no tab lines under it — skipped.`);
      const sigMatch = line.match(/(\d+\/\d+)/);
      lastSig = sigMatch ? sigMatch[1] : null;
      if (bracket && !/^\s*\[\d+\]/.test(line)) {
        // strip the sig and separators; remainder (if any) is the label
        const label = bracket[1]
          .replace(/\d+\/\d+/, "")
          .replace(/[·|,]+\s*$/, "").replace(/^\s*[·|,]+/, "")
          .trim();
        lastHeader = label || null;
      } else {
        lastHeader = cleanHeader(line);
      }
    }
    i++;
  }
  if (lastHeader) warnings.push(`Header "${lastHeader}" had no tab lines under it — skipped.`);

  if (!systems.length) {
    return { error: "No tab lines found — expected lines like  E |--3--5--|" };
  }

  // string count = the most common across systems; others get adapted
  const countTally = new Map<number, number>();
  for (const sys of systems) countTally.set(sys.labels.length, (countTally.get(sys.labels.length) ?? 0) + 1);
  const strings = [...countTally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const refSystem = systems.find((sys) => sys.labels.length === strings)!;
  const tuning = assignOctaves(refSystem.labels);

  const globalStride = detectStride(
    { labels: [], rows: systems.flatMap((s) => s.rows), header: null, sig: null },
    3
  );

  const measures: Measure[] = [];
  for (const sys of systems) {
    if (sys.labels.length !== strings) {
      warnings.push(
        `${sys.header ? `"${sys.header}"` : "An unlabeled system"} has ${sys.labels.length} strings (song has ${strings}) — adapted by string position; check it.`
      );
    }
    const stride = detectStride(sys, globalStride);
    const ms = parseSystemMeasures(sys, stride, strings, warnings);
    // "… 2 bars, x10" in a header → the system's bars repeat 10 times
    // (explicit |: :| marks in the tab win over the header hint)
    const rep = sys.header?.match(/x(\d+)\b/i);
    const hasExplicit = ms.some((m) => m.repeatStart || m.repeatEnd);
    if (!hasExplicit && rep && ms.length && parseInt(rep[1], 10) > 1) {
      ms[0].repeatStart = true;
      ms[ms.length - 1].repeatEnd = Math.min(16, parseInt(rep[1], 10));
    }
    measures.push(...ms);
  }
  if (!measures.length) return { error: "Found tab lines but no readable bars." };

  // "Title — Artist" on a line above the tab (our own export format)
  let parsedTitle: string | undefined;
  let parsedArtist = "";
  for (const line of lines.slice(0, 4)) {
    if (isTabLine(line) || /^\s*\[/.test(line) || /tuning/i.test(line) || !line.trim()) continue;
    const m = line.match(/^\s*(.+?)\s+[—–-]\s+(.+?)\s*$/);
    if (m) {
      parsedTitle = m[1];
      parsedArtist = m[2];
    } else {
      parsedTitle = line.trim(); // title-only header line
    }
    break;
  }

  const bpmMatch = text.match(/~?\s*(\d{2,3})\s*BPM/i) ?? text.match(/♩\s*=\s*(\d{2,3})/);
  const song: Song = {
    ...newSong(title ?? parsedTitle ?? "Imported tab"),
    artist: parsedArtist,
    tuning,
    bpm: bpmMatch ? parseInt(bpmMatch[1], 10) : 120,
    measures,
  };
  return { song, systems: systems.length, bars: measures.length, strings, warnings };
}
