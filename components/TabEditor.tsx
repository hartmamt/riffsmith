"use client";

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_SIG, DEFAULT_SPB, GRIDS, Measure as MeasureT, SIGS, Song, TUNING_PRESETS,
  emptyMeasure, isFret, midiToFreq, newSong, noteToMidi, reshapeMeasure, toAscii,
} from "@/lib/model";
import { importAscii } from "@/lib/importAscii";
import { WebMcpActions, notifyWebMcpCommit, registerWebMcp } from "@/lib/webmcp";
import { GuitarSampler } from "@/lib/sampler";
import {
  NoteAction, PlayPos as PlayPosT, advancePos, columnActions, slotDurOf,
} from "@/lib/schedule";
import { makeChugAuditionSong, makeStarterSong, makeStringAuditionSong, makeTechniqueTestSong, makeTremoloAuditionSong } from "@/lib/demo";
import { clearPmBank, kvDelete, kvGet, kvSet, loadPmSamples, parsePmFilename, savePmSamples } from "@/lib/pmbank";

const STORE_KEY = "guitarscrobble.songs.v1";

type BundledNam = { name: string; url: string; credit?: string; creditUrl?: string };

// Guitar-TECHS palm mutes as a pm bank: one LP-humbucker take per string×fret;
// takes of the same pitch on different strings become the round robins
async function loadGtechsPm(s: GuitarSampler): Promise<number> {
  try {
    const man = await fetch("/samples/gtechs/manifest.json").then((r) => (r.ok ? r.json() : null));
    const seen = new Map<number, number>();
    const files = ((man?.files ?? []) as { file: string; kind: string; midi: number }[])
      .filter((f) => f.kind === "palm")
      .map((f) => {
        const rr = (seen.get(f.midi) ?? 0) + 1;
        seen.set(f.midi, rr);
        return { midi: f.midi, vel: 3, rr, url: `/samples/gtechs/${f.file}` };
      });
    return files.length ? await s.loadPmFromUrls(files) : 0;
  } catch {
    return 0;
  }
}
let bundledNamCache: Promise<BundledNam[]> | null = null;
function fetchBundledNam(): Promise<BundledNam[]> {
  if (!bundledNamCache) {
    bundledNamCache = fetch("/nam/models/manifest.json")
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((j) => (Array.isArray(j?.models) ? (j.models as BundledNam[]) : []))
      .catch(() => []);
  }
  return bundledNamCache;
}
const TECHNIQUES: [string, string][] = [
  ["b", "bend note up"], ["r", "release bend"],
  ["x", "dead chug"], ["~", "vibrato (holds)"],
  ["=", "hold note out"], ["*", "repick prev note (tremolo)"],
];
const PREFIX_KEYS = ["/", "\\", "h", "p", "t", "m", "^"];

type Sel = { m: number; c: number; s: number };

// One bar's grid, memoized: only the bar whose content, selection, or
// playhead changed re-renders — sequential edits on large songs stay fast.
const MeasureGrid = memo(function MeasureGrid({
  measure, m, nStrings, tuning, selC, selS, playC, onSelect,
}: {
  measure: MeasureT;
  m: number;
  nStrings: number;
  tuning: string[];
  selC: number; // selected column in this bar, -1 if selection is elsewhere
  selS: number;
  playC: number; // playhead column in this bar, -1 otherwise
  onSelect: (m: number, c: number, s: number) => void;
}) {
  const spb = measure.spb ?? DEFAULT_SPB;
  return (
    <div
      className={
        "measure" +
        (measure.repeatStart ? " repeat-start" : "") +
        (measure.repeatEnd && measure.repeatEnd > 1 ? " repeat-end" : "")
      }
    >
      <div className="measure-num">
        {measure.repeatStart ? "‖: " : ""}
        {m + 1}{measure.sig ? ` · ${measure.sig}` : ""}
        {measure.repeatEnd && measure.repeatEnd > 1 ? ` :‖ ×${measure.repeatEnd}` : ""}
      </div>
      <div
        className="grid"
        style={{ gridTemplateColumns: `auto repeat(${measure.cols.length}, 1fr)` }}
      >
        {Array.from({ length: nStrings }, (_, s) => (
          <div className="row" key={s} style={{ display: "contents" }}>
            <div className="stringlabel">{tuning[s].replace(/\d/g, "")}</div>
            {measure.cols.map((col, c) => {
              const v = col[s];
              return (
                <button
                  key={c}
                  className={
                    "cell" +
                    (selC === c && selS === s ? " sel" : "") +
                    (playC === c ? " playing" : "") +
                    (c % spb === 0 ? " beat" : "") +
                    (v ? " filled" : "")
                  }
                  onClick={() => onSelect(m, c, s)}
                  tabIndex={-1}
                >
                  {v || "—"}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
});

function loadSongs(): Song[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Song[];
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch {}
  return [makeStarterSong()];
}

export default function TabEditor() {
  const [songs, setSongs] = useState<Song[] | null>(null);
  const [activeId, setActiveId] = useState<string>("");
  const [sel, setSel] = useState<Sel>({ m: 0, c: 0, s: 0 });
  const [playPos, setPlayPos] = useState<[number, number] | null>(null); // [measure, col]
  const [copied, setCopied] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[] | null>(null);
  const [rigOpen, setRigOpen] = useState(() =>
    typeof window === "undefined" ? true : localStorage.getItem("gs.rigOpen") !== "0");
  const [auditionOpen, setAuditionOpen] = useState(false);
  const [asciiOpen, setAsciiOpen] = useState(false);
  const [loopMode, setLoopMode] = useState(() =>
    typeof window === "undefined" ? true : localStorage.getItem("gs.loop") !== "0");
  const [legacyEngine, setLegacyEngine] = useState(() =>
    typeof window === "undefined" ? false : localStorage.getItem("gs.engine") === "old");
  const legacyRef = useRef(false);
  const [hybridEngine, setHybridEngine] = useState(() =>
    typeof window === "undefined" ? false : ["hybrid", "model"].includes(localStorage.getItem("gs.engine") ?? ""));
  const [modelOnly, setModelOnly] = useState(() =>
    typeof window === "undefined" ? false : localStorage.getItem("gs.engine") === "model");
  const hybridRef = useRef(false);
  const modelOnlyRef = useRef(false);
  const [hybridStatus, setHybridStatus] = useState<"off" | "loading" | "ready" | "unavailable">("off");
  const armHybrid = (s: GuitarSampler) => {
    setHybridStatus(s.hybridReady ? "ready" : "loading");
    void s.enableHybrid().then((ok) => setHybridStatus(ok ? "ready" : "unavailable"));
  };
  const [namStatus, setNamStatus] = useState<string | null>(null); // loaded model name or error
  const [namLibrary, setNamLibrary] = useState<string[]>([]); // every .nam the user has loaded (IDB)
  // captures shipped with the site (public/nam/models/manifest.json — optional, gitignored)
  const [bundledNam, setBundledNam] = useState<BundledNam[]>([]);
  useEffect(() => { fetchBundledNam().then(setBundledNam); }, []);
  useEffect(() => {
    kvGet<{ name: string; json: string }[]>("namLibrary")
      .then((lib) => { if (lib?.length) setNamLibrary(lib.map((m) => m.name)); })
      .catch(() => {});
  }, []);
  const [cabOn, setCabOn] = useState(false); // synthetic cab on top of a NAM model
  const [ampLevel, setAmpLevel] = useState(() => {
    if (typeof window === "undefined") return 1;
    const v = parseFloat(localStorage.getItem("gs.ampLevel") ?? "1");
    return isFinite(v) ? v : 1;
  });
  const namFileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const playTimer = useRef<number | null>(null);
  const songRef = useRef<Song | null>(null);
  const loopRef = useRef(true);
  const samplerRef = useRef<GuitarSampler | null>(null);

  const levelRef = useRef(1);
  useEffect(() => { levelRef.current = ampLevel; samplerRef.current?.setLevel(ampLevel); }, [ampLevel]);

  // chug character controls (persisted)
  const [tight, setTight] = useState(() =>
    typeof window === "undefined" ? 0.35 : parseFloat(localStorage.getItem("gs.tight") ?? "0.35") || 0.35);
  const [muteStr, setMuteStr] = useState(() =>
    typeof window === "undefined" ? 0.5 : parseFloat(localStorage.getItem("gs.mute") ?? "0.5") || 0.5);
  const [picking, setPicking] = useState<"alternate" | "down" | "up">(() =>
    typeof window === "undefined" ? "alternate" : (localStorage.getItem("gs.picking") as "down" | "up" | null) ?? "alternate");
  const [doubled, setDoubled] = useState(() =>
    typeof window === "undefined" ? false : localStorage.getItem("gs.double") === "1");
  const [pmBankInfo, setPmBankInfo] = useState<string | null>(null);
  const [pmSource, setPmSource] = useState<"bassvi" | "gtx" | "gtechs" | "custom">(() =>
    typeof window === "undefined" ? "gtechs"
      : (localStorage.getItem("gs.pmSource") as "bassvi" | "gtx" | "gtechs" | "custom" | null) ?? "gtechs");
  const [noteBank, setNoteBankState] = useState<"gtechs" | "fsbs">(() =>
    typeof window === "undefined" ? "gtechs" : ((localStorage.getItem("gs.noteBank") as "gtechs" | "fsbs" | null) ?? "gtechs"));
  const noteBankRef = useRef<"gtechs" | "fsbs">("gtechs");
  noteBankRef.current = noteBank;
  const [playerRules, setPlayerRules] = useState(() =>
    typeof window === "undefined" ? true : localStorage.getItem("gs.rules") !== "0");
  const rulesRef = useRef(true);
  const [namInput, setNamInput] = useState(() =>
    typeof window === "undefined" ? 0.45 : parseFloat(localStorage.getItem("gs.namInput") ?? "0.45"));
  const namInputRef = useRef(0.45);
  useEffect(() => {
    namInputRef.current = namInput;
    localStorage.setItem("gs.namInput", String(namInput));
    samplerRef.current?.setNamInput(namInput);
  }, [namInput]);
  useEffect(() => {
    rulesRef.current = playerRules;
    localStorage.setItem("gs.rules", playerRules ? "1" : "0");
    if (samplerRef.current) samplerRef.current.playerRules = playerRules;
  }, [playerRules]);
  const pmFileRef = useRef<HTMLInputElement>(null);
  const chugCfgRef = useRef({ tight, muteStr, picking, doubled });
  chugCfgRef.current = { tight, muteStr, picking, doubled };
  useEffect(() => {
    const s = samplerRef.current;
    if (!s) return;
    s.setTight(tight);
    s.muteStrength = muteStr;
    s.pickingMode = picking;
    s.setDoubleTrack(doubled);
  }, [tight, muteStr, picking, doubled]);

  const ensureSampler = useCallback((): GuitarSampler => {
    if (!audioRef.current) audioRef.current = new AudioContext({ sampleRate: 48000 }); // NAM models train at 48k
    if (!samplerRef.current) {
      const s = new GuitarSampler(audioRef.current);
      samplerRef.current = s;
      s.noteBank = noteBankRef.current;
      s.playerRules = rulesRef.current;
      s.setNamInput(namInputRef.current);
      s.hybridSampleAttack = !modelOnlyRef.current;
      if (hybridRef.current) { s.engineMode = "hybrid"; armHybrid(s); }
      s.setLevel(levelRef.current);
      const cfg = chugCfgRef.current;
      s.setTight(cfg.tight);
      s.muteStrength = cfg.muteStr;
      s.pickingMode = cfg.picking;
      s.setDoubleTrack(cfg.doubled);
      // restore persisted setup: pm bank choice, custom samples, NAM model + cab
      s.ready().then(async () => {
        try {
          // default chug source is the real 7-string mutes (Metal GTX); the
          // flatwound Bass VI bank stays available as a choice
          const src = localStorage.getItem("gs.pmSource") ?? "gtechs";
          if (src === "gtechs") {
            const n = await loadGtechsPm(s);
            if (n) { setPmSource("gtechs"); setPmBankInfo(`LP mutes ×${n}`); }
          } else if (src === "custom") {
            const recs = await loadPmSamples();
            if (recs.length) {
              const n = await s.loadCustomPm(recs);
              if (n) { setPmSource("custom"); setPmBankInfo(`custom ×${n}`); }
            }
          } else if (src === "gtx") {
            const man = await fetch("/samples/gtx/manifest.json").then((r) => r.json());
            const n = await s.loadPmFromUrls(
              man.files.map((f: { midi: number; vel: number; rr: number; file: string; stroke?: "d" | "u" }) => ({
                ...f, url: `/samples/gtx/${f.file}`,
              }))
            );
            if (n) { setPmSource("gtx"); setPmBankInfo(`GTX ×${n}`); }
          }
        } catch {}
        try {
          const saved = await kvGet<{ name: string; json: string }>("namModel");
          if (saved) {
            const res = await s.loadNamModel(saved.json, saved.name);
            if (res.ok) {
              setNamStatus(saved.name);
              const cab = localStorage.getItem("gs.cabOn") === "1";
              setCabOn(cab);
              s.setCabBypass(!cab);
            }
          } else if (localStorage.getItem("gs.namChoice") !== "1") {
            // first run: ship the demo capture as the default amp until the user picks something
            const first = (await fetchBundledNam())[0];
            if (first) {
              const text = await fetch(first.url).then((r) => r.text());
              const res = await s.loadNamModel(text, first.name);
              if (res.ok) {
                setNamStatus(first.name);
                setCabOn(false); localStorage.setItem("gs.cabOn", "0");
                s.setCabBypass(true);
              }
            }
          }
        } catch {}
      });
    }
    (window as unknown as Record<string, unknown>).__sampler = samplerRef.current;
    (window as unknown as Record<string, unknown>).__GuitarSampler = GuitarSampler;
    return samplerRef.current;
  }, []);

  // ---- persistence ----
  useEffect(() => {
    const loaded = loadSongs();
    setSongs(loaded);
    setActiveId(loaded[0].id);
  }, []);

  useEffect(() => {
    if (!songs) return;
    // debounced: rapid sequential edits (typing, agent writes) coalesce
    const t = window.setTimeout(
      () => localStorage.setItem(STORE_KEY, JSON.stringify(songs)),
      250
    );
    return () => window.clearTimeout(t);
  }, [songs]);

  const song = useMemo(
    () => songs?.find((s) => s.id === activeId) ?? songs?.[0] ?? null,
    [songs, activeId]
  );
  const nStrings = song?.tuning.length ?? 6;
  useEffect(() => { songRef.current = song; }, [song]);
  useEffect(() => {
    loopRef.current = loopMode;
    localStorage.setItem("gs.loop", loopMode ? "1" : "0");
  }, [loopMode]);
  useEffect(() => {
    legacyRef.current = legacyEngine;
    hybridRef.current = hybridEngine;
    modelOnlyRef.current = modelOnly;
    localStorage.setItem("gs.engine", legacyEngine ? "old" : modelOnly ? "model" : hybridEngine ? "hybrid" : "new");
    const smp = samplerRef.current;
    if (smp) {
      smp.engineMode = hybridEngine ? "hybrid" : "samples";
      smp.setHybridSampleAttack(!modelOnly);
      if (hybridEngine) armHybrid(smp); else setHybridStatus("off");
    }
  }, [legacyEngine, hybridEngine, modelOnly]);

  // sections: labeled measure → range of bars until the next label
  const sections = useMemo(() => {
    if (!song) return [];
    const out: { label: string; start: number; end: number }[] = [];
    song.measures.forEach((m, i) => {
      if (m.label) out.push({ label: m.label, start: i, end: song.measures.length - 1 });
      if (out.length > 1 && m.label) out[out.length - 2].end = i - 1;
    });
    return out;
  }, [song]);

  const updateSong = useCallback((fn: (s: Song) => Song) => {
    setSongs((prev) =>
      prev ? prev.map((s) => (s.id === activeId ? { ...fn(s), updatedAt: Date.now() } : s)) : prev
    );
  }, [activeId]);

  const onSelectCell = useCallback((m: number, c: number, s: number) => {
    setSel({ m, c, s });
  }, []);

  const setCell = useCallback((m: number, c: number, st: number, value: string) => {
    updateSong((s) => {
      const measures = s.measures.map((meas, mi) =>
        mi !== m ? meas : {
          ...meas,
          cols: meas.cols.map((col, ci) =>
            ci !== c ? col : col.map((v, si) => (si === st ? value : v))
          ),
        }
      );
      return { ...s, measures };
    });
  }, [updateSong]);

  // ---- keyboard entry ----
  useEffect(() => {
    if (!song) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (showImport) return;
      const { m, c, s } = sel;
      const cur = song.measures[m]?.cols[c]?.[s] ?? "";
      const move = (dm: number, dc: number, ds: number) => {
        let nm = m, nc = c + dc, ns = Math.min(nStrings - 1, Math.max(0, s + ds));
        if (nc >= song.measures[nm].cols.length) {
          if (m < song.measures.length - 1) { nm = m + 1; nc = 0; }
          else nc = song.measures[nm].cols.length - 1;
        }
        if (nc < 0) {
          if (m > 0) { nm = m - 1; nc = song.measures[nm].cols.length - 1; }
          else nc = 0;
        }
        nm = Math.min(song.measures.length - 1, Math.max(0, nm + dm));
        nc = Math.min(song.measures[nm].cols.length - 1, nc);
        setSel({ m: nm, c: nc, s: ns });
      };

      if (/^\d$/.test(e.key)) {
        let value: string;
        const prefixed = cur.match(/^([/\\hptm^])(\d{0,2})$/);
        if (prefixed) {
          // completing a slide/hammer/pull/tap note: prefix + digits
          const frets = prefixed[2] + e.key;
          value =
            frets.length <= 2 && parseInt(frets, 10) <= 24
              ? prefixed[1] + frets
              : prefixed[1] + e.key;
        } else {
          const appended = cur + e.key;
          value = isFret(cur) && parseInt(appended, 10) <= 24 ? appended : e.key;
        }
        setCell(m, c, s, value);
        e.preventDefault();
        return;
      }
      if (PREFIX_KEYS.includes(e.key) && !e.metaKey && !e.ctrlKey) {
        // technique prefix: "/" "\" slide, "h" hammer, "p" pull, "t" tap —
        // then type the fret; the technique rides on that note's slot
        setCell(m, c, s, e.key);
        e.preventDefault();
        return;
      }
      const tech = TECHNIQUES.find(([k]) => k === e.key.toLowerCase());
      if (tech && !e.metaKey && !e.ctrlKey) {
        setCell(m, c, s, tech[0]);
        move(0, 1, 0);
        e.preventDefault();
        return;
      }
      switch (e.key) {
        case "Backspace":
        case "Delete":
          setCell(m, c, s, "");
          e.preventDefault();
          break;
        case "ArrowRight": move(0, 1, 0); e.preventDefault(); break;
        case "ArrowLeft": move(0, -1, 0); e.preventDefault(); break;
        case "ArrowUp": move(0, 0, -1); e.preventDefault(); break;
        case "ArrowDown": move(0, 0, 1); e.preventDefault(); break;
        case " ": move(0, 1, 0); e.preventDefault(); break;
        case "Enter": move(1, 0, 0); e.preventDefault(); break;
        case "Escape": setShowImport(false); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, song, setCell, nStrings, showImport]);

  // ---- playback ----
  const stop = useCallback(() => {
    if (playTimer.current !== null) {
      window.clearInterval(playTimer.current);
      playTimer.current = null;
    }
    samplerRef.current?.allNotesOff();
    setPlayPos(null);
  }, []);

  // 5.5Hz pitch wobble on an oscillator/source detune param (in cents)
  const addVibrato = useCallback((detune: AudioParam, when: number, until: number) => {
    const ctx = audioRef.current!;
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 5.5;
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(0, when);
    depth.gain.linearRampToValueAtTime(30, when + 0.22); // eases in, ±30 cents
    lfo.connect(depth).connect(detune);
    lfo.start(when);
    lfo.stop(until);
  }, []);

  // legato slide: starts at f0, bends to f1 over glideDur, then rings
  const glideNote = useCallback((f0: number, f1: number, when: number, glideDur: number, sustain = 0, opts: { vibrato?: boolean } = {}) => {
    const ctx = audioRef.current!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    const dur = glideDur + 0.6 + sustain;
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(f0, when);
    osc.frequency.exponentialRampToValueAtTime(f1, when + glideDur);
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(2200, when);
    filter.frequency.exponentialRampToValueAtTime(400, when + Math.max(0.4, dur * 0.7));
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.2, when + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(filter).connect(gain).connect(ctx.destination);
    if (opts.vibrato) addVibrato(osc.detune, when + glideDur, when + dur + 0.1);
    osc.start(when);
    osc.stop(when + dur + 0.1);
  }, [addVibrato]);

  // sustain = extra seconds the note should ring beyond the default decay
  const pluck = useCallback((freq: number, when: number, muted: boolean, sustain = 0, opts: { legato?: boolean; vibrato?: boolean } = {}) => {
    const ctx = audioRef.current!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    const dur = muted ? 0.12 : 0.6 + sustain;
    osc.type = "sawtooth";
    osc.frequency.value = freq;
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(muted ? 500 : opts.legato ? 1300 : 2200, when);
    filter.frequency.exponentialRampToValueAtTime(muted ? 200 : 400, when + Math.max(0.4, dur * 0.7));
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(muted ? 0.12 : opts.legato ? 0.15 : 0.22, when + (opts.legato ? 0.02 : 0.005));
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(filter).connect(gain).connect(ctx.destination);
    if (opts.vibrato && !muted) addVibrato(osc.detune, when + 0.1, when + dur + 0.1);
    osc.start(when);
    osc.stop(when + dur + 0.1);
  }, [addVibrato]);

  const playRef = useRef<(start?: number, end?: number) => void>(() => {});

  // Lookahead scheduler: audio events are placed ~130ms ahead on the
  // AudioContext clock, refreshed every 25ms. JS timers only decide when to
  // SCHEDULE — never the audible onset itself. Song state is re-read as the
  // schedule advances, so edits made while a riff loops land on the next pass.
  const play = useCallback((start = 0, end = Infinity) => {
    stop();
    if (!songRef.current) return;
    if (!audioRef.current) audioRef.current = new AudioContext({ sampleRate: 48000 }); // NAM models train at 48k
    const ctx = audioRef.current;
    ctx.resume();
    const sound = songRef.current.sound ?? "synth";
    if (sound === "guitar" || sound === "guitar-di") {
      const sampler = ensureSampler();
      sampler.diMode = sound === "guitar-di";
      sampler.resetPickDirection(); // phrase boundary: hand starts on a downstroke
      sampler.stringCount = songRef.current.tuning.length;
      if (!sampler.loaded) {
        sampler.ready().then(() => playRef.current(start, end));
        return;
      }
    }
    const LOOKAHEAD = 0.13;
    let pos: PlayPosT = {
      m: Math.max(0, Math.min(start, songRef.current.measures.length - 1)),
      c: 0, taken: {}, done: false,
    };
    let nextTime = ctx.currentTime + 0.08;
    let endAt = Infinity;
    const uiQueue: { t: number; m: number; c: number }[] = [];

    const dispatchLegacy = (sampler: GuitarSampler, a: NoteAction, when: number, sd: number) => {
      // pre-StringVoice behavior for A/B: every technique retriggers a sample,
      // no accents, tremolo as sub-picks
      switch (a.kind) {
        case "pick":
          sampler.pickNote(a.si, a.midi, when, { sustain: a.sustain, vibrato: a.vibrato });
          break;
        case "palm": sampler.pickNote(a.si, a.midi, when, { articulation: "palm" }); break;
        case "dead": sampler.pickNote(a.si, a.midi, when, { articulation: "dead" }); break;
        case "pinch": sampler.pickNote(a.si, a.midi, when, { articulation: "pinch", sustain: a.sustain, vibrato: a.vibrato }); break;
        case "repick": {
          const picks = Math.max(2, Math.min(4, Math.round(sd / 0.07)));
          for (let k = 0; k < picks; k++) {
            sampler.pickNote(a.si, a.midi, when + (k * sd) / picks, {
              articulation: a.sourceKind === "palm" ? "palm" : a.sourceKind === "dead" ? "dead" : "open",
            });
          }
          break;
        }
        case "hammer": case "pull": case "tap":
          sampler.pickNote(a.si, a.midi, when, { pickless: true, sustain: a.sustain, vibrato: a.vibrato });
          break;
        case "bend": case "release": case "slide":
          sampler.pickNote(a.si, a.midi, when, {
            pickless: true, glideFromMidi: a.fromMidi ?? a.midi - 2,
            glideDur: a.glideDur ?? 0.15, sustain: a.sustain, vibrato: a.vibrato,
          });
          break;
      }
    };

    const dispatch = (s: Song, a: NoteAction, when: number, chord?: { stroke: "d" | "u" }) => {
      const sampler = samplerRef.current;
      const useGuitar = (s.sound === "guitar" || s.sound === "guitar-di") && sampler?.loaded;
      if (useGuitar && sampler) {
        const sd = slotDurOf(s, pos.m);
        if (legacyRef.current) { dispatchLegacy(sampler, a, when, sd); return; }
        // micro-timing (Phase 0 player rules): metal is metronomic, so feel is
        // systematic, not noisy. Random jitter is small and TIGHTER on low
        // strings (timing errors are most audible in the bass register); an
        // open pick sits ~2.5ms earlier than a chug because a softer attack is
        // perceived later (perceptual-center alignment). Chord notes get their
        // spread from the strum instead of jitter.
        const rules = rulesRef.current;
        const lowness = Math.max(0, Math.min(1, (64 - a.midi) / 24));
        const jit = !rules ? (Math.random() - 0.5) * 0.003 : chord ? 0 : (Math.random() - 0.5) * (0.002 + 0.003 * (1 - lowness));
        const t = when + jit + (rules && a.kind === "pick" ? -0.0025 : 0);
        switch (a.kind) {
          case "pick":
            sampler.pickNote(a.si, a.midi, t, { velocity: a.velocity, sustain: a.sustain, vibrato: a.vibrato, stroke: chord?.stroke });
            break;
          case "palm":
            sampler.pickNote(a.si, a.midi, t, { articulation: "palm", velocity: a.velocity, gap: a.gap, stroke: chord?.stroke });
            break;
          case "dead":
            sampler.pickNote(a.si, a.midi, t, { articulation: "dead", velocity: a.velocity, stroke: chord?.stroke });
            break;
          case "pinch":
            sampler.pickNote(a.si, a.midi, t, { articulation: "pinch", velocity: a.velocity, sustain: a.sustain, vibrato: a.vibrato, stroke: chord?.stroke });
            break;
          case "repick":
            // overlapping stroke — the ringing body continues underneath
            sampler.repickNote(a.si, a.midi, t, {
              articulation: a.sourceKind === "palm" ? "palm" : a.sourceKind === "dead" ? "dead" : "open",
              velocity: a.velocity,
            });
            break;
          case "hammer": case "pull": case "tap":
            sampler.legatoTo(a.si, a.midi, t, a.kind, { sustain: a.sustain, vibrato: a.vibrato, velocity: a.velocity });
            break;
          case "bend":
            sampler.bendTo(a.si, t, 200, a.glideDur ?? 0.2, { sustain: a.sustain, vibrato: a.vibrato, fallbackMidi: a.midi });
            break;
          case "release":
            sampler.bendTo(a.si, t, 0, a.glideDur ?? 0.2, { sustain: a.sustain, vibrato: a.vibrato, fallbackMidi: a.midi });
            break;
          case "slide":
            sampler.slideTo(a.si, a.midi, t, a.glideDur ?? 0.1, { sustain: a.sustain, vibrato: a.vibrato, fromMidi: a.fromMidi });
            break;
        }
        return;
      }
      // synth path
      switch (a.kind) {
        case "pick":
          pluck(midiToFreq(a.midi), when, false, a.sustain, { vibrato: a.vibrato });
          break;
        case "palm": case "dead":
          pluck(midiToFreq(a.midi), when, true);
          break;
        case "pinch":
          pluck(midiToFreq(a.midi + 19), when, false, a.sustain, { vibrato: a.vibrato }); // ~ the 3rd harmonic
          break;
        case "repick":
          pluck(midiToFreq(a.midi), when, a.sourceKind !== "pick", 0);
          break;
        case "hammer": case "pull": case "tap":
          pluck(midiToFreq(a.midi), when, false, a.sustain, { legato: true, vibrato: a.vibrato });
          break;
        case "bend": case "release": case "slide":
          glideNote(midiToFreq(a.fromMidi ?? a.midi), midiToFreq(a.midi), when, a.glideDur ?? 0.15, a.sustain, { vibrato: a.vibrato });
          break;
      }
    };

    const timerFn = () => {
      const s = songRef.current;
      if (!s || !s.measures.length) { stop(); return; }
      const endBar = Math.min(end, s.measures.length - 1);
      const startBar = Math.min(start, endBar);
      while (!pos.done && nextTime < ctx.currentTime + LOOKAHEAD) {
        if (pos.m >= s.measures.length) pos = { ...pos, m: startBar, c: 0 };
        if (pos.c >= s.measures[pos.m].cols.length) pos = { ...pos, c: 0 };
        const acts = columnActions(s, pos.m, pos.c);
        const smp = samplerRef.current;
        const strumming = (s.sound === "guitar" || s.sound === "guitar-di") && smp?.loaded && !legacyRef.current && rulesRef.current
          ? acts.filter((a) => a.kind === "pick" || a.kind === "palm" || a.kind === "dead" || a.kind === "pinch")
          : [];
        if (smp && strumming.length >= 2) {
          // a chord is ONE stroke: pick the direction once, then rake across
          // the strings — down = low string first, up = high string first —
          // spread by 2.2% of the strum period per string (tightens with tempo)
          const stroke = smp.beginStroke();
          const step = Math.min(0.006, Math.max(0.001, 0.022 * slotDurOf(s, pos.m)));
          const order = [...strumming].sort((x, y) => (stroke === "d" ? y.si - x.si : x.si - y.si));
          order.forEach((a, i) => dispatch(s, a, nextTime + i * step, { stroke }));
          const inStrum = new Set(strumming);
          for (const a of acts) if (!inStrum.has(a)) dispatch(s, a, nextTime);
        } else {
          for (const a of acts) dispatch(s, a, nextTime);
        }
        uiQueue.push({ t: nextTime, m: pos.m, c: pos.c });
        nextTime += slotDurOf(s, pos.m);
        pos = advancePos(s, pos, startBar, endBar, loopRef.current);
        if (pos.done) endAt = nextTime;
      }
      while (uiQueue.length && uiQueue[0].t <= ctx.currentTime + 0.03) {
        const e = uiQueue.shift()!;
        setPlayPos([e.m, e.c]);
      }
      if (pos.done && ctx.currentTime >= endAt + 0.2) stop();
    };
    timerFn();
    playTimer.current = window.setInterval(timerFn, 25);
  }, [stop, pluck, glideNote, ensureSampler]);
  playRef.current = play;

  useEffect(() => stop, [stop]);
  useEffect(() => { stop(); }, [activeId, stop]);

  // pre-warm samples + persisted amp setup as soon as a guitar song is open
  const songSound = song?.sound;
  useEffect(() => {
    if (songSound === "guitar" || songSound === "guitar-di") ensureSampler().ready();
  }, [songSound, ensureSampler]);



  // ---- measure ops ----
  const selMeasure = song?.measures[sel.m];
  const addMeasure = () =>
    updateSong((s) => {
      const last = s.measures[s.measures.length - 1];
      return {
        ...s,
        measures: [...s.measures, emptyMeasure(s.tuning.length, last?.sig ?? DEFAULT_SIG, last?.spb ?? DEFAULT_SPB)],
      };
    });
  const duplicateMeasure = () =>
    updateSong((s) => {
      const src = s.measures[sel.m];
      const copy = { ...src, label: undefined, cols: src.cols.map((col) => [...col]) };
      const measures = [...s.measures];
      measures.splice(sel.m + 1, 0, copy);
      return { ...s, measures };
    });
  const deleteMeasure = () =>
    updateSong((s) => {
      if (s.measures.length <= 1) return s;
      const measures = s.measures.filter((_, i) => i !== sel.m);
      setSel((p) => ({ m: Math.min(p.m, measures.length - 1), c: 0, s: p.s }));
      return { ...s, measures };
    });
  const setBarLabel = (text: string) =>
    updateSong((s) => ({
      ...s,
      measures: s.measures.map((m, i) =>
        i === sel.m ? { ...m, label: text || undefined } : m
      ),
    }));
  const setBarRepeat = (patch: { repeatStart?: boolean; repeatEnd?: number }) =>
    updateSong((s) => ({
      ...s,
      measures: s.measures.map((m, i) => (i === sel.m ? { ...m, ...patch } : m)),
    }));
  const setBarShape = (sig: string, spb: number) =>
    updateSong((s) => ({
      ...s,
      measures: s.measures.map((m, i) =>
        i === sel.m ? reshapeMeasure(m, s.tuning.length, sig, spb) : m
      ),
    }));

  // switch the palm-mute sample bank (shared by the rig UI and WebMCP)
  const switchPmBank = useCallback(async (v: "bassvi" | "gtx" | "gtechs" | "custom"): Promise<string> => {
    const s = ensureSampler();
    await s.ready();
    localStorage.setItem("gs.pmSource", v);
    if (v === "gtechs") {
      const n = await loadGtechsPm(s);
      if (n) { setPmSource("gtechs"); setPmBankInfo(`LP mutes ×${n}`); return `LP humbucker palm mutes, Guitar-TECHS (${n} samples)`; }
      setPmBankInfo("✕ Guitar-TECHS bank not available");
      return "Guitar-TECHS bank not available";
    }
    if (v === "bassvi") {
      s.clearCustomPm();
      setPmSource("bassvi");
      setPmBankInfo(null);
      return "bass VI (built-in)";
    }
    if (v === "gtx") {
      try {
        const man = await fetch("/samples/gtx/manifest.json").then((r) => r.json());
        const n = await s.loadPmFromUrls(
          man.files.map((f: { midi: number; vel: number; rr: number; file: string; stroke?: "d" | "u" }) => ({
            ...f, url: `/samples/gtx/${f.file}`,
          }))
        );
        setPmSource("gtx");
        setPmBankInfo(`GTX ×${n}`);
        return `Metal GTX (${n} samples)`;
      } catch {
        setPmBankInfo("✕ GTX bank not available");
        return "GTX bank not available";
      }
    }
    const recs = await loadPmSamples().catch(() => []);
    if (recs.length) {
      const n = await s.loadCustomPm(recs);
      setPmSource("custom");
      setPmBankInfo(`custom ×${n}`);
      return `custom bank (${n} samples)`;
    }
    pmFileRef.current?.click();
    return "no custom bank stored — file picker opened for the user";
  }, [ensureSampler]);

  const setNoteBank = useCallback(async (v: "gtechs" | "fsbs"): Promise<string> => {
    setNoteBankState(v);
    localStorage.setItem("gs.noteBank", v);
    if (samplerRef.current) samplerRef.current.noteBank = v;
    return v === "gtechs" ? "LP humbucker (Guitar-TECHS)" : "Fender single-coil (FreePats)";
  }, []);

  // Switch the NAM capture among the models already stored in this browser
  // (or back to the built-in amp). Adding a new file still needs the picker.
  const selectNamModel = useCallback(async (name: string | null): Promise<string> => {
    localStorage.setItem("gs.namChoice", "1");
    if (name === null) {
      samplerRef.current?.bypassNam();
      setNamStatus(null);
      kvDelete("namModel").catch(() => {});
      return "built-in amp";
    }
    const lib = (await kvGet<{ name: string; json: string }[]>("namLibrary")) ?? [];
    const lc = name.toLowerCase();
    let m = lib.find((x) => x.name === name) ?? lib.find((x) => x.name.toLowerCase() === lc);
    if (!m) {
      const b = (await fetchBundledNam()).find((x) => x.name === name || x.name.toLowerCase() === lc);
      if (b) m = { name: b.name, json: await fetch(b.url).then((r) => r.text()) };
    }
    if (!m) {
      const names = [...bundledNam.map((x) => x.name), ...lib.map((x) => x.name)];
      throw new Error(`no model named "${name}" — available: ${names.join(", ") || "none"}`);
    }
    setNamStatus("loading…");
    const res = await ensureSampler().loadNamModel(m.json, m.name);
    if (!res.ok) { setNamStatus(`✕ ${res.error ?? "load failed"}`); throw new Error(res.error ?? "load failed"); }
    setNamStatus(m.name);
    setCabOn(false); localStorage.setItem("gs.cabOn", "0");
    samplerRef.current?.setCabBypass(true);
    kvSet("namModel", { name: m.name, json: m.json }).catch(() => {});
    return m.name;
  }, [ensureSampler, bundledNam]);

  // ---- WebMCP: expose the full human capability surface as page tools ----
  const mcpRef = useRef<WebMcpActions>(null!);
  mcpRef.current = {
    songs: songs ?? [],
    activeId,
    setActiveId,
    setSongs: (fn) => setSongs((prev) => (prev ? fn(prev) : prev)),
    play,
    stop,
    setLoopMode,
    rig: {
      tight,
      volume: ampLevel,
      mute_grip: muteStr,
      picking,
      double_track: doubled,
      engine: legacyEngine ? "old" : modelOnly ? "model" : hybridEngine ? "hybrid" : "new",
      engine_status: hybridEngine ? hybridStatus : "n/a",
      cab: cabOn,
      pm_bank: pmSource,
      note_bank: noteBank,
      player_rules: playerRules,
      nam_input: namInput,
      nam_model: namStatus && !namStatus.startsWith("✕") ? namStatus : null,
      nam_models: [...bundledNam.map((b) => b.name), ...namLibrary.filter((n) => !bundledNam.some((b) => b.name === n))],
      loop: loopMode,
    },
    setRig: (patch) => {
      if (patch.tight !== undefined) {
        const v = Math.max(0, Math.min(1, patch.tight));
        setTight(v); localStorage.setItem("gs.tight", String(v));
      }
      if (patch.volume !== undefined) {
        const v = Math.max(0, Math.min(2, patch.volume));
        setAmpLevel(v); localStorage.setItem("gs.ampLevel", String(v));
      }
      if (patch.mute_grip !== undefined) {
        const v = Math.max(0, Math.min(1, patch.mute_grip));
        setMuteStr(v); localStorage.setItem("gs.mute", String(v));
      }
      if (patch.picking !== undefined) {
        setPicking(patch.picking); localStorage.setItem("gs.picking", patch.picking);
      }
      if (patch.double_track !== undefined) {
        setDoubled(patch.double_track);
        localStorage.setItem("gs.double", patch.double_track ? "1" : "0");
      }
      if (patch.engine !== undefined) {
        setLegacyEngine(patch.engine === "old");
        setHybridEngine(patch.engine === "hybrid" || patch.engine === "model");
        setModelOnly(patch.engine === "model");
      }
      if (patch.player_rules !== undefined) setPlayerRules(patch.player_rules);
      if (patch.nam_input !== undefined) setNamInput(Math.max(0.1, Math.min(2, patch.nam_input)));
      if (patch.cab !== undefined) {
        setCabOn(patch.cab);
        localStorage.setItem("gs.cabOn", patch.cab ? "1" : "0");
        samplerRef.current?.setCabBypass(!patch.cab);
      }
      if (patch.loop !== undefined) setLoopMode(patch.loop);
    },
    switchPmBank,
    setNoteBank,
    selectNamModel,
  };
  // the ref above now reflects this render's state — release any tool call
  // waiting on read-after-write consistency
  useEffect(() => { notifyWebMcpCommit(); });
  useEffect(() => {
    console.info(registerWebMcp(() => mcpRef.current));
  }, []);

  // ---- song ops ----
  const createSong = () => {
    const s = newSong();
    // inherit the artist you last used instead of hardcoding one
    const recent = songs && [...songs].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (recent?.artist) s.artist = recent.artist;
    setSongs((prev) => (prev ? [s, ...prev] : [s]));
    setActiveId(s.id);
    setSel({ m: 0, c: 0, s: 0 });
  };
  const deleteSong = (id: string) => {
    setSongs((prev) => {
      if (!prev) return prev;
      const rest = prev.filter((s) => s.id !== id);
      const next = rest.length ? rest : [newSong()];
      if (id === activeId) setActiveId(next[0].id);
      return next;
    });
  };

  const runImport = () => {
    const res = importAscii(importText);
    if ("error" in res) { setImportError(res.error); return; }
    setSongs((prev) => (prev ? [res.song, ...prev] : [res.song]));
    setActiveId(res.song.id);
    setSel({ m: 0, c: 0, s: 0 });
    setImportText("");
    setImportError(null);
    if (res.warnings.length) {
      setImportWarnings(res.warnings); // keep the modal open so they're seen
    } else {
      setShowImport(false);
    }
  };

  // ascii is only rendered on demand — recomputing it on every keystroke was
  // a large per-edit cost on big songs
  const exportAscii = useMemo(
    () => (showExport && song ? toAscii(song) : ""),
    [showExport, song]
  );
  const copyAscii = async () => {
    if (!song) return;
    await navigator.clipboard.writeText(toAscii(song));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  const downloadAscii = () => {
    if (!song) return;
    const blob = new Blob([toAscii(song)], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${song.title.replace(/\s+/g, "_").toLowerCase()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (!songs || !song) {
    return <div className="boot">warming up the tubes…</div>;
  }

  const presetName =
    Object.entries(TUNING_PRESETS).find(
      ([, t]) => t.join() === song.tuning.join()
    )?.[0] ?? "Custom";

  return (
    <div className="shell">
      <aside className="rack">
        <div className="brand">
          <span className="brand-glyph">◉</span>
          <h1>Riff<em>Smith</em></h1>
          <p className="brand-sub">tab it before you forget it</p>
        </div>
        <button className="btn btn-amber wide" onClick={createSong}>+ new song</button>
        <button className="btn wide" onClick={() => { setShowImport(true); setImportError(null); }}>
          ⇪ paste ascii tab
        </button>
        <button className="btn wide" onClick={() => setAuditionOpen((v) => !v)}>
          ⚙ audition songs {auditionOpen ? "▴" : "▾"}
        </button>
        {auditionOpen && (
          <div className="audition-group">
            <button
              className="btn audition-item"
              title="create the articulation audition song"
              onClick={() => {
                const t = makeTechniqueTestSong();
                setSongs((prev) => {
                  const rest = (prev ?? []).filter((s) => s.title !== "Technique Test");
                  return [t, ...rest];
                });
                setActiveId(t.id);
                setSel({ m: 0, c: 0, s: 0 });
                ensureSampler().ready();
              }}
            >
              technique test
            </button>
            <button
              className="btn audition-item"
              title="create the palm-mute A/B audition song"
              onClick={() => {
                const t = makeChugAuditionSong();
                setSongs((prev) => {
                  const rest = (prev ?? []).filter((s) => s.title !== "Chug Audition");
                  return [t, ...rest];
                });
                setActiveId(t.id);
                setSel({ m: 0, c: 0, s: 0 });
                ensureSampler().ready();
              }}
            >
              chug audition
            </button>
            <button
              className="btn audition-item"
              title="create the death-metal tremolo audition song"
              onClick={() => {
                const t = makeTremoloAuditionSong();
                setSongs((prev) => {
                  const rest = (prev ?? []).filter((s) => s.title !== "Tremolo Audition");
                  return [t, ...rest];
                });
                setActiveId(t.id);
                setSel({ m: 0, c: 0, s: 0 });
                ensureSampler().ready();
              }}
            >
              tremolo audition
            </button>
            <button
              className="btn audition-item"
              title="create the string-model audition song: one articulation per section, for A/B-ing the hybrid engine"
              onClick={() => {
                const t = makeStringAuditionSong();
                setSongs((prev) => {
                  const rest = (prev ?? []).filter((s) => s.title !== "String Model Audition");
                  return [t, ...rest];
                });
                setActiveId(t.id);
                setSel({ m: 0, c: 0, s: 0 });
                ensureSampler().ready();
              }}
            >
              string model audition
            </button>
          </div>
        )}
        <nav className="songlist">
          {songs.map((s) => (
            <div key={s.id} className={`songrow ${s.id === song.id ? "active" : ""}`}>
              <button className="songbtn" onClick={() => { setActiveId(s.id); setSel({ m: 0, c: 0, s: 0 }); }}>
                <span className="songtitle">{s.title}</span>
                <span className="songmeta">{s.artist} · {s.measures.length} bars · {s.tuning.length}str</span>
              </button>
              <button className="ghost del" title="delete song" onClick={() => deleteSong(s.id)}>✕</button>
            </div>
          ))}
        </nav>
        <div className="legend">
          <h3>keys</h3>
          <ul>
            <li><kbd>0–9</kbd> fret (type twice for 10+)</li>
            <li><kbd>←→↑↓</kbd> move · <kbd>space</kbd> step</li>
            <li><kbd>⌫</kbd> clear cell</li>
            {TECHNIQUES.map(([k, name]) => (
              <li key={k}><kbd>{k}</kbd> {name}</li>
            ))}
            <li><kbd>/</kbd>+fret slide up into note</li>
            <li><kbd>\</kbd>+fret slide down into note</li>
            <li><kbd>h</kbd>+fret hammer-on</li>
            <li><kbd>p</kbd>+fret pull-off</li>
            <li><kbd>t</kbd>+fret tap</li>
            <li><kbd>^</kbd>+fret pinch harmonic</li>
            <li><kbd>m</kbd>+fret palm-muted chug</li>
          </ul>
        </div>
      </aside>

      <main className="stage">
        <header className="deck">
          <div className="deck-titles">
            <input
              className="title-input"
              value={song.title}
              onChange={(e) => updateSong((s) => ({ ...s, title: e.target.value }))}
              aria-label="song title"
            />
            <input
              className="artist-input"
              placeholder="artist"
              value={song.artist}
              onChange={(e) => updateSong((s) => ({ ...s, artist: e.target.value }))}
              aria-label="artist"
            />
          </div>
          <div className="deck-controls">
            <label className="knob">
              <span>bpm</span>
              <input
                type="number" min={30} max={300} value={song.bpm}
                onChange={(e) => updateSong((s) => ({ ...s, bpm: Math.max(30, Math.min(300, +e.target.value || 120)) }))}
              />
            </label>
            <label className="knob">
              <span>tuning</span>
              <select
                value={presetName}
                onChange={(e) => {
                  const t = TUNING_PRESETS[e.target.value];
                  if (t) updateSong((s) => ({
                    ...s,
                    tuning: [...t],
                    measures: s.measures.map((m) => ({
                      ...m,
                      cols: m.cols.map((col) =>
                        Array.from({ length: t.length }, (_, si) => col[si] ?? "")
                      ),
                    })),
                  }));
                }}
              >
                {Object.keys(TUNING_PRESETS).map((n) => <option key={n}>{n}</option>)}
                {presetName === "Custom" && <option>Custom</option>}
              </select>
            </label>
            <button
              className={`btn loop-toggle ${loopMode ? "on" : ""}`}
              title="loop playback"
              onClick={() => setLoopMode((v) => !v)}
            >
              ⟳ loop
            </button>
            {playPos === null ? (
              <button className="btn btn-amber" onClick={() => play()}>▶ play</button>
            ) : (
              <button className="btn btn-hot" onClick={stop}>■ stop</button>
            )}
            {!rigOpen && (
              <button className="btn" title="show the rig column" onClick={() => { setRigOpen(true); localStorage.setItem("gs.rigOpen", "1"); }}>
                rig ›
              </button>
            )}
          </div>
        </header>

        <div className="barctl">
          <div className="btn-group">
            <button onClick={addMeasure}>+ bar</button>
            <button onClick={duplicateMeasure} title="duplicate bar (notes included)">⧉</button>
            <button onClick={deleteMeasure} disabled={song.measures.length <= 1} title="delete bar">−</button>
          </div>
          <label className="knob knob-inline">
            <span>bar {sel.m + 1} sig</span>
            <select
              value={selMeasure?.sig ?? DEFAULT_SIG}
              onChange={(e) => setBarShape(e.target.value, selMeasure?.spb ?? DEFAULT_SPB)}
            >
              {SIGS.map((sg) => <option key={sg}>{sg}</option>)}
            </select>
          </label>
          <label className="knob knob-inline">
            <span>grid</span>
            <select
              value={selMeasure?.spb ?? DEFAULT_SPB}
              onChange={(e) => setBarShape(selMeasure?.sig ?? DEFAULT_SIG, +e.target.value)}
            >
              {GRIDS.map(([n, name]) => <option key={n} value={n}>{name}</option>)}
            </select>
          </label>
          <button
            className={`btn repeat-btn ${selMeasure?.repeatStart ? "on" : ""}`}
            title="toggle repeat start on this bar"
            onClick={() => setBarRepeat({ repeatStart: !selMeasure?.repeatStart })}
          >
            ‖: start
          </button>
          <label className="knob knob-inline">
            <span>repeat end</span>
            <select
              value={selMeasure?.repeatEnd ?? 0}
              onChange={(e) => setBarRepeat({ repeatEnd: +e.target.value || undefined })}
            >
              <option value={0}>off</option>
              {[2, 3, 4, 5, 6, 8, 10, 12, 16].map((n) => (
                <option key={n} value={n}>:‖ ×{n}</option>
              ))}
            </select>
          </label>
          <label className="knob knob-inline">
            <span>section name</span>
            <input
              className="label-input"
              type="text"
              placeholder="e.g. INTRO — starts a section here"
              value={selMeasure?.label ?? ""}
              onChange={(e) => setBarLabel(e.target.value)}
            />
          </label>
          <span className="spacer" />
          <div className="ascii-wrap">
            <button className="btn" onClick={() => setAsciiOpen((v) => !v)}>ascii ▾</button>
            {asciiOpen && (
              <div className="ascii-menu">
                <button onClick={() => { setShowExport((v) => !v); setAsciiOpen(false); }}>
                  {showExport ? "hide export panel" : "show export panel"}
                </button>
                <button onClick={() => { copyAscii(); setAsciiOpen(false); }}>
                  {copied ? "copied ✓" : "copy tab"}
                </button>
                <button onClick={() => { downloadAscii(); setAsciiOpen(false); }}>download .txt</button>
              </div>
            )}
          </div>
        </div>

        <section className="sheet" aria-label="tablature grid">
          {song.measures.map((measure, m) => (
            <Fragment key={m}>
              {measure.label && (() => {
                const sec = sections.find((x) => x.start === m);
                const active = playPos !== null && sec && playPos[0] >= sec.start && playPos[0] <= sec.end;
                return (
                  <div className="section-label">
                    {sec && (
                      active ? (
                        <button className="riffplay playing" title="stop" onClick={stop}>■</button>
                      ) : (
                        <button
                          className="riffplay"
                          title={loopMode ? "loop this riff" : "play this riff"}
                          onClick={() => play(sec.start, sec.end)}
                        >
                          ▶
                        </button>
                      )
                    )}
                    <span>{measure.label}</span>
                  </div>
                );
              })()}
              <MeasureGrid
                measure={measure}
                m={m}
                nStrings={nStrings}
                tuning={song.tuning}
                selC={sel.m === m ? sel.c : -1}
                selS={sel.m === m ? sel.s : -1}
                playC={playPos !== null && playPos[0] === m ? playPos[1] : -1}
                onSelect={onSelectCell}
              />
            </Fragment>
          ))}
        </section>

        {showExport && (
          <section className="exportbox">
            <pre>{exportAscii}</pre>
          </section>
        )}
      </main>

      {rigOpen && (
        <aside className="rig">
          <div className="rig-head">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><circle cx="5" cy="8" r="1.4" /><circle cx="11" cy="8" r="1.4" /></svg>
            <span>rig</span>
            <button className="ghost rig-hide" onClick={() => { setRigOpen(false); localStorage.setItem("gs.rigOpen", "0"); }}>
              ‹ hide
            </button>
          </div>

          <section className="rig-unit">
            <header>
              <span className={`led ${(song.sound ?? "synth") !== "synth" ? "on" : ""}`} />
              amp head
            </header>
            <div className="rig-row">
              <span>sound</span>
              <select
                value={song.sound ?? "synth"}
                onChange={(e) => {
                  const sound = e.target.value as "synth" | "guitar" | "guitar-di";
                  updateSong((s) => ({ ...s, sound }));
                  if (sound !== "synth") ensureSampler().ready();
                }}
              >
                <option value="synth">tube synth</option>
                <option value="guitar">guitar + amp</option>
                <option value="guitar-di">guitar DI (clean)</option>
              </select>
            </div>
            {(song.sound ?? "synth") !== "synth" && (
              <div className="rig-row">
                <span>guitar</span>
                <select
                  value={noteBank}
                  title="which DI recordings play sustained notes: Guitar-TECHS LP humbucker (string-aware, one dynamic) or FreePats Fender single-coil (two dynamics)"
                  onChange={(e) => { void setNoteBank(e.target.value as "gtechs" | "fsbs"); }}
                >
                  <option value="gtechs">LP humbucker · Guitar-TECHS</option>
                  <option value="fsbs">Fender · FreePats</option>
                </select>
              </div>
            )}
            {(song.sound ?? "synth") === "guitar" && (
              <>
                <div className="rig-row">
                  <span>model</span>
                  <select
                    className={`rig-model ${namStatus && !namStatus.startsWith("✕") ? "loaded" : ""}`}
                    title="Neural Amp Modeler capture: load a .nam file once, then switch between loaded models (agents can too)"
                    value={namStatus && !namStatus.startsWith("✕") && (namLibrary.includes(namStatus) || bundledNam.some((b) => b.name === namStatus)) ? namStatus : ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "__load") { namFileRef.current?.click(); return; }
                      void selectNamModel(v === "" ? null : v).catch(() => {});
                    }}
                  >
                    <option value="">built-in amp</option>
                    {bundledNam.map((b) => <option key={b.name} value={b.name}>⚡ {b.name}</option>)}
                    {namLibrary.filter((n) => !bundledNam.some((b) => b.name === n)).map((n) => <option key={n} value={n}>⚡ {n}</option>)}
                    <option value="__load">load .nam file…</option>
                  </select>
                </div>
                {(() => {
                  const b = bundledNam.find((x) => x.name === namStatus);
                  return b?.credit ? (
                    <a className="nam-credit" href={b.creditUrl} target="_blank" rel="noreferrer">{b.credit}</a>
                  ) : null;
                })()}
                {namStatus?.startsWith("✕") && <span className="nam-error">{namStatus}</span>}
                {namStatus && !namStatus.startsWith("✕") && (
                  <div className="rig-row">
                    <span>cab sim</span>
                    <button
                      className={`rig-switch ${cabOn ? "on" : ""}`}
                      title="add the synthetic cabinet after the NAM model (off for full-rig captures)"
                      onClick={() => {
                        const next = !cabOn;
                        setCabOn(next);
                        localStorage.setItem("gs.cabOn", next ? "1" : "0");
                        samplerRef.current?.setCabBypass(!next);
                      }}
                    >
                      <span className="rig-switch-knob" />
                    </button>
                  </div>
                )}
                <input
                  ref={namFileRef}
                  type="file"
                  accept=".nam,application/json"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    setNamStatus("loading…");
                    try {
                      const text = await file.text();
                      const name = file.name.replace(/\.nam$/i, "");
                      const res = await ensureSampler().loadNamModel(text, name);
                      setNamStatus(res.ok ? name : `✕ ${res.error ?? "load failed"}`);
                      localStorage.setItem("gs.namChoice", "1");
                      if (res.ok) {
                        setCabOn(false);
                        localStorage.setItem("gs.cabOn", "0");
                        kvSet("namModel", { name, json: text }).catch(() => {});
                        try {
                          const lib = ((await kvGet<{ name: string; json: string }[]>("namLibrary")) ?? []).filter((x) => x.name !== name);
                          lib.push({ name, json: text });
                          await kvSet("namLibrary", lib);
                          setNamLibrary(lib.map((x) => x.name));
                        } catch {}
                      }
                    } catch (err) {
                      setNamStatus(`✕ ${String(err)}`);
                    }
                  }}
                />
              </>
            )}
            {(song.sound ?? "synth") !== "synth" && (
              <div className="rig-slider">
                <span>tight</span>
                <input
                  className="level-slider" type="range" min={0} max={1} step={0.05}
                  value={tight}
                  title="pre-distortion low cut + mid emphasis + controlled gain"
                  onChange={(e) => { const v = parseFloat(e.target.value); setTight(v); localStorage.setItem("gs.tight", String(v)); }}
                />
              </div>
            )}
            {(song.sound ?? "synth") === "guitar" && (
              <div className="rig-slider">
                <span>volume</span>
                <input
                  className="level-slider" type="range" min={0} max={2} step={0.05}
                  value={ampLevel}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setAmpLevel(v);
                    localStorage.setItem("gs.ampLevel", String(v));
                  }}
                />
              </div>
            )}
            {(song.sound ?? "synth") === "guitar" && namStatus && !namStatus.startsWith("✕") && (
              <div className="rig-slider">
                <span>input</span>
                <input
                  className="level-slider" type="range" min={0.1} max={2} step={0.05}
                  value={namInput}
                  title="DI level into the capture. Captures are trained on a guitar's own output (peaks around -10 dBFS); 0.45 puts our samples there. Push it for more gain, pull it back if it fizzes."
                  onChange={(e) => setNamInput(parseFloat(e.target.value))}
                />
              </div>
            )}
          </section>

          {(song.sound ?? "synth") !== "synth" && (
            <section className="rig-unit">
              <header>
                <span className="led on" />
                chugs
              </header>
              <div className="rig-slider">
                <span>mute grip</span>
                <input
                  className="level-slider" type="range" min={0} max={1} step={0.05}
                  value={muteStr}
                  title="palm-mute pressure: left = loose/raw DI, right = tight/choked"
                  onChange={(e) => { const v = parseFloat(e.target.value); setMuteStr(v); localStorage.setItem("gs.mute", String(v)); }}
                />
              </div>
              <div className="rig-row">
                <span>pm bank</span>
                <select
                  value={pmSource}
                  title="palm-mute sample source; 'custom import…' loads your own DI recordings (b1_v3_rr1.wav naming)"
                  onChange={(e) => { void switchPmBank(e.target.value as "bassvi" | "gtx" | "gtechs" | "custom"); }}
                >
                  <option value="gtechs">LP humbucker · standard</option>
                  <option value="gtx">Metal GTX · 7-string</option>
                  <option value="bassvi">bass VI (built-in)</option>
                  <option value="custom">custom import…</option>
                </select>
              </div>
              {pmSource === "custom" && (
                <div className="rig-row">
                  <span className="pm-status">{pmBankInfo}</span>
                  <button
                    className="ghost" title="clear stored custom bank"
                    onClick={async () => {
                      await clearPmBank();
                      setPmBankInfo(null);
                      setPmSource("bassvi");
                      samplerRef.current?.clearCustomPm();
                    }}
                  >✕</button>
                </div>
              )}
              {pmSource !== "custom" && pmBankInfo && <span className="pm-status">{pmBankInfo}</span>}
              <input
                ref={pmFileRef} type="file" multiple accept=".wav,.aif,.aiff,.flac"
                style={{ display: "none" }}
                onChange={async (e) => {
                  const files = [...(e.target.files ?? [])];
                  e.target.value = "";
                  if (!files.length) return;
                  const recs = [];
                  const skipped: string[] = [];
                  for (const f of files) {
                    const meta = parsePmFilename(f.name);
                    if (!meta) { skipped.push(f.name); continue; }
                    recs.push({ ...meta, bytes: await f.arrayBuffer() });
                  }
                  if (recs.length) {
                    await savePmSamples(recs);
                    const n = await ensureSampler().loadCustomPm(recs);
                    setPmSource("custom");
                    setPmBankInfo(`custom ×${n}`);
                  }
                  if (skipped.length) {
                    alert(`Skipped ${skipped.length} file(s) not matching <note><octave>_v<n>_rr<n>.wav:\n${skipped.slice(0, 5).join("\n")}`);
                  }
                }}
              />
            </section>
          )}

          {(song.sound ?? "synth") !== "synth" && (
            <section className="rig-unit">
              <header>
                <span className="led on" />
                performance
              </header>
              <div className="rig-seg-label">picking</div>
              <div className="rig-seg">
                {(["alternate", "down", "up"] as const).map((mode) => (
                  <button
                    key={mode}
                    className={picking === mode ? "on" : ""}
                    title={mode === "down" ? "all-downstroke: consistently forceful breakdowns" : mode === "up" ? "all upstrokes" : "alternate picking"}
                    onClick={() => { setPicking(mode); localStorage.setItem("gs.picking", mode); }}
                  >
                    {mode === "alternate" ? "alt" : mode}
                  </button>
                ))}
              </div>
              <div className="rig-row">
                <span>double track</span>
                <button
                  className={`rig-switch ${doubled ? "on" : ""}`}
                  title="double-track: an independent second take, hard-panned L/R (two extra capture instances when a .nam model is loaded)"
                  onClick={() => setDoubled((v) => {
                    localStorage.setItem("gs.double", v ? "0" : "1");
                    return !v;
                  })}
                >
                  <span className="rig-switch-knob" />
                </button>
              </div>
              <div className="rig-row">
                <span>player rules</span>
                <button
                  className={`rig-switch ${playerRules ? "on" : ""}`}
                  title="humanization: tension glide, pick-position comb, velocity tone, stroke tilt, pre-pick clamp, micro-timing, chord rakes. Off = plain sampler, for A/B listening"
                  onClick={() => setPlayerRules(!playerRules)}
                >
                  <span className="rig-switch-knob" />
                </button>
              </div>
              <div className="rig-row">
                <span>engine</span>
                <select
                  title="A/B the articulation engine: 'voices' = continuous sampled voices; 'string model' = the sampled attack excites a physical string (experimental); 'retrigger' = a sample per technique"
                  value={legacyEngine ? "old" : modelOnly ? "model" : hybridEngine ? "hybrid" : "new"}
                  onChange={(e) => {
                    const v = e.target.value;
                    setLegacyEngine(v === "old");
                    setHybridEngine(v === "hybrid" || v === "model");
                    setModelOnly(v === "model");
                  }}
                >
                  <option value="new">new · voices</option>
                  <option value="hybrid">hybrid · string model</option>
                  <option value="model">string model only (no sampled pick)</option>
                  <option value="old">old · retrigger</option>
                </select>
              </div>
              {hybridEngine && (
                <div className="rig-row">
                  <span>model</span>
                  <span className={`led ${hybridStatus === "ready" ? "on" : ""}`} />
                  <span style={{ fontSize: "0.72rem", color: hybridStatus === "unavailable" ? "var(--hot)" : "var(--bone-dim)" }}>
                    {hybridStatus === "ready" ? "string model running" : hybridStatus === "loading" ? "loading…" : hybridStatus === "unavailable" ? "unavailable — playing samples" : "press play to load"}
                  </span>
                </div>
              )}
            </section>
          )}

          <div className="rig-foot">settings persist per browser</div>
        </aside>
      )}

      {showImport && (
        <div className="modal-backdrop" onClick={() => setShowImport(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Paste ASCII tab</h2>
            <p className="modal-hint">
              String labels + pipes (<code>E |--3--|</code>), any string count.
              Section headers like <code>[1] 0:01 RIFF 3/4 ~160 BPM</code> become
              bar labels and time signatures. Note-name lines are ignored.
            </p>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={"[1] INTRO  3/4  ~159 BPM\nE |----------3--2----|\nB |----0--3--------3-|\nF#|------------------|\nB |-0----------------|"}
              spellCheck={false}
            />
            {importError && <p className="modal-error">{importError}</p>}
            {importWarnings && (
              <div className="modal-warnings">
                <strong>Imported, with warnings:</strong>
                <ul>{importWarnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </div>
            )}
            <div className="modal-actions">
              {importWarnings ? (
                <button
                  className="btn btn-amber"
                  onClick={() => { setShowImport(false); setImportWarnings(null); }}
                >
                  got it
                </button>
              ) : (
                <>
                  <button className="btn" onClick={() => setShowImport(false)}>cancel</button>
                  <button className="btn btn-amber" onClick={runImport} disabled={!importText.trim()}>
                    import as new song
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
