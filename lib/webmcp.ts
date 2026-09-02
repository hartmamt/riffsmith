// WebMCP bridge: registers the editor's full capability surface as page tools
// (document.modelContext / navigator.modelContext). Agent-native parity —
// every tool runs through the same state operations the UI uses, so agent
// edits appear live, autosave, and stay human-editable.
//
// Without a modelContext provider (Chrome flag off), a dev shim is installed
// at window.__webmcp so tools can be exercised from the console:
//   __webmcp.list()  /  __webmcp.call("get_song", {})

import {
  DEFAULT_SIG, DEFAULT_SPB, GRID_VALUES, Measure, Song, TUNING_PRESETS,
  emptyMeasure, reshapeMeasure, sigBeats, toAscii,
} from "./model";
import { importAscii } from "./importAscii";

// The live surface the tools operate through — reassigned every render so
// executes always see current state. Mirrors what the UI itself can do.
export type RigState = {
  tight: number;
  volume: number;
  mute_grip: number;
  picking: "alternate" | "down" | "up";
  double_track: boolean;
  engine: "new" | "old" | "hybrid" | "model";
  engine_status: string;
  cab: boolean;
  pm_bank: "bassvi" | "gtx" | "gtechs" | "custom";
  note_bank: "gtechs" | "fsbs";
  player_rules: boolean;
  legato_landings: boolean;
  feedback: boolean;
  bass_rig: "bass" | "guitar";
  nam_input: number;
  room: number;
  nam_model: string | null;
  nam_models: string[];
  loop: boolean;
};

export type WebMcpActions = {
  songs: Song[];
  activeId: string;
  setActiveId: (id: string) => void;
  setSongs: (fn: (prev: Song[]) => Song[]) => void;
  play: (start?: number, end?: number) => void;
  stop: () => void;
  setLoopMode: (on: boolean) => void;
  rig: RigState;
  setRig: (patch: Partial<Omit<RigState, "nam_model" | "nam_models" | "pm_bank" | "note_bank">>) => void;
  switchPmBank: (v: "bassvi" | "gtx" | "gtechs" | "custom") => Promise<string>;
  setNoteBank: (v: "gtechs" | "fsbs") => Promise<string>;
  selectNamModel: (name: string | null) => Promise<string>;
};

type ToolDef = {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: { readOnlyHint?: boolean };
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

const NOTATION = `Cell tokens: fret numbers 0-24; "m0"/"m3" palm-muted chug on that fret; "x" unpitched dead chug; "*" one repick of the preceding note on this slot — repeat "*" cells on a 16th grid for 16th-note tremolo picking (works after m-notes and x too); "=" hold the previous note out (a picked note rings about 1 s on its own, then fades — write "=" in every slot it should keep sounding beyond that); "~" vibrato on the preceding note (also holds); "/7" slide up into fret 7; "\\7" slide down into fret 7; "h7" hammer-on to 7, "p5" pull-off to 5, "t12" tap 12 (legato, no pick attack); "^7" pinch harmonic on fret 7 (picked squeal: the overtone over a quiet fundamental); "b" bends the preceding note up a step, "r" releases it back; "-" empty. Chug riff example: "m0 m0 m0 3 m0 m0 5 =". Tremolo example: "0 * * *".`;

function ok(message: string, extra: Record<string, unknown> = {}) {
  return { ok: true, message, ...extra };
}
function fail(message: string) {
  return { ok: false, error: message };
}

function barAscii(song: Song, mi: number): string {
  const solo: Song = { ...song, measures: [{ ...song.measures[mi], label: undefined }] };
  return toAscii(solo).split("\n").slice(3).join("\n").trim();
}

function findSong(a: WebMcpActions, ref: unknown): Song | null {
  if (ref === undefined || ref === null || ref === "") {
    return a.songs.find((s) => s.id === a.activeId) ?? a.songs[0] ?? null;
  }
  const q = String(ref).toLowerCase();
  return (
    a.songs.find((s) => s.id === q) ??
    a.songs.find((s) => s.title.toLowerCase() === q) ??
    a.songs.find((s) => s.title.toLowerCase().includes(q)) ??
    null
  );
}

function mutateSong(a: WebMcpActions, id: string, fn: (s: Song) => Song) {
  a.setSongs((prev) =>
    prev.map((s) => (s.id === id ? { ...fn(s), updatedAt: Date.now() } : s))
  );
}

function barIndex(song: Song, bar: unknown): number | null {
  const n = Number(bar);
  if (!Number.isInteger(n) || n < 1 || n > song.measures.length) return null;
  return n - 1;
}

function sectionRange(song: Song, name: string): [number, number] | null {
  const starts = song.measures
    .map((m, i) => ({ label: m.label?.toLowerCase(), i }))
    .filter((x) => x.label);
  const hit = starts.find((x) => x.label === name.toLowerCase()) ??
    starts.find((x) => x.label!.includes(name.toLowerCase()));
  if (!hit) return null;
  const next = starts.find((x) => x.i > hit.i);
  return [hit.i, next ? next.i - 1 : song.measures.length - 1];
}

function songSummary(s: Song) {
  return {
    id: s.id,
    title: s.title,
    artist: s.artist,
    bpm: s.bpm,
    tuning: s.tuning,
    strings: s.tuning.length,
    bars: s.measures.length,
    sections: s.measures
      .map((m, i) => (m.label ? { name: m.label, starts_at_bar: i + 1 } : null))
      .filter(Boolean),
  };
}

export function buildTools(get: () => WebMcpActions): ToolDef[] {
  const songParam = {
    song: {
      type: "string",
      description: "Song title or id. Omit for the currently open song.",
    },
  };

  return [
    {
      name: "list_songs",
      description: "List all songs in RiffSmith with their metadata (tuning, BPM, bar count, sections).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => ok(`${get().songs.length} song(s)`, {
        songs: get().songs.map(songSummary),
        active_song_id: get().activeId,
      }),
    },
    {
      name: "get_song",
      description:
        "Read a song in full: metadata, section list, per-bar structure (time signature, grid resolution, repeats), and the complete ASCII tab. Strings are numbered 1 (top, highest pitch) to N (bottom, lowest). " + NOTATION,
      inputSchema: { type: "object", properties: { ...songParam }, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async (args) => {
        const a = get();
        const s = findSong(a, args.song);
        if (!s) return fail("Song not found.");
        return ok(`"${s.title}"`, {
          ...songSummary(s),
          bars_detail: s.measures.map((m, i) => ({
            bar: i + 1,
            sig: m.sig ?? DEFAULT_SIG,
            grid: m.spb ?? DEFAULT_SPB,
            slots: m.cols.length,
            section: m.label,
            repeat_start: m.repeatStart || undefined,
            repeat_end: m.repeatEnd,
          })),
          ascii: toAscii(s),
        });
      },
    },
    {
      name: "create_song",
      description: `Create a new song and open it. Tuning presets: ${Object.keys(TUNING_PRESETS).join(", ")}.`,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          artist: { type: "string" },
          bpm: { type: "number" },
          tuning_preset: { type: "string" },
          bars: { type: "number", description: "Initial bar count (default 4)" },
          sig: { type: "string", description: "Time signature for the initial bars, e.g. 3/4 (default 4/4)" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const a = get();
        const tuning = TUNING_PRESETS[String(args.tuning_preset ?? "")] ?? TUNING_PRESETS["E Standard"];
        const sig = typeof args.sig === "string" && /^\d+\/\d+$/.test(args.sig) ? args.sig : DEFAULT_SIG;
        const barsRequested = Math.max(1, Number(args.bars) || 4);
        const nBars = Math.min(256, barsRequested);
        const song: Song = {
          id: Math.random().toString(36).slice(2, 10),
          title: String(args.title),
          artist: String(
            args.artist ??
            [...a.songs].sort((x, y) => y.updatedAt - x.updatedAt)[0]?.artist ?? ""
          ),
          bpm: Math.min(300, Math.max(30, Number(args.bpm) || 120)),
          tuning: [...tuning],
          sound: "guitar",
          measures: Array.from({ length: nBars }, () => emptyMeasure(tuning.length, sig)),
          updatedAt: Date.now(),
        };
        a.setSongs((prev) => [song, ...prev]);
        a.setActiveId(song.id);
        return ok(
          nBars < barsRequested
            ? `Created "${song.title}" with ${nBars} bars (requested ${barsRequested}; capped at 256).`
            : `Created "${song.title}"`,
          songSummary(song)
        );
      },
    },
    {
      name: "update_song",
      description: `Update song metadata: title, artist, BPM, or tuning preset (${Object.keys(TUNING_PRESETS).join(", ")}). Changing tuning keeps all notes.`,
      inputSchema: {
        type: "object",
        properties: {
          ...songParam,
          title: { type: "string" },
          artist: { type: "string" },
          bpm: { type: "number" },
          tuning_preset: { type: "string" },
          sound: { type: "string", enum: ["synth", "guitar", "guitar-di"], description: "Playback instrument: synth, sampled guitar through an amp, or clean DI guitar." },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const a = get();
        const s = findSong(a, args.song);
        if (!s) return fail("Song not found.");
        const tuning = args.tuning_preset !== undefined ? TUNING_PRESETS[String(args.tuning_preset)] : undefined;
        if (args.tuning_preset !== undefined && !tuning) {
          return fail(`Unknown tuning preset. Options: ${Object.keys(TUNING_PRESETS).join(", ")}`);
        }
        mutateSong(a, s.id, (cur) => ({
          ...cur,
          title: args.title !== undefined ? String(args.title) : cur.title,
          artist: args.artist !== undefined ? String(args.artist) : cur.artist,
          sound: args.sound === "guitar" || args.sound === "synth" || args.sound === "guitar-di" ? args.sound : cur.sound,
          bpm: args.bpm !== undefined ? Math.min(300, Math.max(30, Number(args.bpm) || cur.bpm)) : cur.bpm,
          ...(tuning
            ? {
                tuning: [...tuning],
                measures: cur.measures.map((m) => ({
                  ...m,
                  cols: m.cols.map((col) =>
                    Array.from({ length: tuning.length }, (_, si) => col[si] ?? "")
                  ),
                })),
              }
            : {}),
        }));
        return ok(`Updated "${s.title}".`);
      },
    },
    {
      name: "delete_song",
      description: "Permanently delete a song. Destructive — confirm_title must exactly match the song's title.",
      inputSchema: {
        type: "object",
        properties: {
          ...songParam,
          confirm_title: { type: "string", description: "Exact title of the song being deleted." },
        },
        required: ["confirm_title"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const a = get();
        const s = findSong(a, args.song);
        if (!s) return fail("Song not found.");
        if (String(args.confirm_title) !== s.title) {
          return fail(`confirm_title does not match "${s.title}" — nothing deleted.`);
        }
        if (a.songs.length <= 1) {
          return fail("Cannot delete the only song — create another first.");
        }
        const next = a.songs.find((x) => x.id !== s.id)!;
        a.setSongs((prev) => prev.filter((x) => x.id !== s.id));
        if (a.activeId === s.id) a.setActiveId(next.id);
        return ok(`Deleted "${s.title}". Now viewing "${next.title}".`, { active_song_id: next.id });
      },
    },
    {
      name: "import_ascii_tab",
      description:
        "Import an ASCII tab as a new song. Accepts standard tab: string-letter labels with | bar lines, any string count, section headers like \"[1] 0:01 RIFF 3/4 ~160 BPM -- 2 bars, x8\" (become section names, signatures, and repeats), inline 5/7 slides, |: :| repeat marks.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The full ASCII tab." },
          title: { type: "string" },
        },
        required: ["text"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const a = get();
        const res = importAscii(String(args.text), args.title !== undefined ? String(args.title) : undefined);
        if ("error" in res) return fail(res.error);
        a.setSongs((prev) => [res.song, ...prev]);
        a.setActiveId(res.song.id);
        return ok(`Imported ${res.bars} bars (${res.strings} strings).`, {
          ...songSummary(res.song),
          warnings: res.warnings,
        });
      },
    },
    {
      name: "add_bars",
      description: "Append or insert empty bars. New bars inherit the last bar's signature/grid unless overridden.",
      inputSchema: {
        type: "object",
        properties: {
          ...songParam,
          count: { type: "number", description: "How many bars (default 1)" },
          after_bar: { type: "number", description: "1-based bar to insert after; omit to append at the end." },
          sig: { type: "string", description: "Time signature, e.g. 5/4" },
          grid: { type: "number", description: "Slots per beat: 1 quarters, 2 8ths, 3 triplets, 4 16ths, 6 16th-triplets" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const a = get();
        const s = findSong(a, args.song);
        if (!s) return fail("Song not found.");
        const requested = Math.max(1, Number(args.count) || 1);
        const count = Math.min(512, requested);
        mutateSong(a, s.id, (cur) => {
          const at = args.after_bar !== undefined
            ? Math.min(cur.measures.length, Math.max(0, Number(args.after_bar) || 0))
            : cur.measures.length;
          const model = cur.measures[at - 1] ?? cur.measures[cur.measures.length - 1];
          const sig = typeof args.sig === "string" && /^\d+\/\d+$/.test(args.sig) ? args.sig : model?.sig ?? DEFAULT_SIG;
          const spb = GRID_VALUES.includes(Number(args.grid)) ? Number(args.grid) : model?.spb ?? DEFAULT_SPB;
          const fresh = Array.from({ length: count }, () => emptyMeasure(cur.tuning.length, sig, spb));
          const measures = [...cur.measures];
          measures.splice(at, 0, ...fresh);
          return { ...cur, measures };
        });
        return ok(
          count < requested
            ? `Added ${count} bar(s) to "${s.title}" (requested ${requested}; capped at 512 per call).`
            : `Added ${count} bar(s) to "${s.title}".`,
          { bars_now: s.measures.length + count }
        );
      },
    },
    {
      name: "update_bar",
      description:
        "Update one bar's structure: time signature, grid resolution, section name (a named bar starts a section; empty string clears it), and repeat marks (repeat_start opens a ‖: passage, repeat_end N closes it as :‖×N; 0 clears).",
      inputSchema: {
        type: "object",
        properties: {
          ...songParam,
          bar: { type: "number", description: "1-based bar number" },
          sig: { type: "string" },
          grid: { type: "number", description: "1 quarters, 2 8ths, 3 triplets, 4 16ths, 6 16th-triplets" },
          section_name: { type: "string" },
          repeat_start: { type: "boolean" },
          repeat_end: { type: "number", description: "Total times the passage plays (2-16), 0 to clear" },
        },
        required: ["bar"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const a = get();
        const s = findSong(a, args.song);
        if (!s) return fail("Song not found.");
        const mi = barIndex(s, args.bar);
        if (mi === null) return fail(`Bar must be 1-${s.measures.length}.`);
        mutateSong(a, s.id, (cur) => ({
          ...cur,
          measures: cur.measures.map((m, i) => {
            if (i !== mi) return m;
            let next: Measure = { ...m };
            if (typeof args.sig === "string" && /^\d+\/\d+$/.test(args.sig)) {
              next = reshapeMeasure(next, cur.tuning.length, args.sig, next.spb ?? DEFAULT_SPB);
            }
            if (GRID_VALUES.includes(Number(args.grid))) {
              next = reshapeMeasure(next, cur.tuning.length, next.sig ?? DEFAULT_SIG, Number(args.grid));
            }
            if (args.section_name !== undefined) next.label = String(args.section_name) || undefined;
            if (args.repeat_start !== undefined) next.repeatStart = Boolean(args.repeat_start) || undefined;
            if (args.repeat_end !== undefined) {
              const n = Number(args.repeat_end);
              next.repeatEnd = n >= 2 ? Math.min(16, n) : undefined;
            }
            return next;
          }),
        }));
        return ok(`Updated bar ${mi + 1} of "${s.title}".`);
      },
    },
    {
      name: "duplicate_bar",
      description: "Duplicate a bar (notes included) immediately after itself.",
      inputSchema: {
        type: "object",
        properties: { ...songParam, bar: { type: "number" } },
        required: ["bar"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const a = get();
        const s = findSong(a, args.song);
        if (!s) return fail("Song not found.");
        const mi = barIndex(s, args.bar);
        if (mi === null) return fail(`Bar must be 1-${s.measures.length}.`);
        mutateSong(a, s.id, (cur) => {
          const src = cur.measures[mi];
          const copy = { ...src, label: undefined, cols: src.cols.map((c) => [...c]) };
          const measures = [...cur.measures];
          measures.splice(mi + 1, 0, copy);
          return { ...cur, measures };
        });
        return ok(`Duplicated bar ${mi + 1}; it is now bars ${mi + 1}-${mi + 2}.`);
      },
    },
    {
      name: "delete_bar",
      description: "Delete a bar and its notes.",
      inputSchema: {
        type: "object",
        properties: { ...songParam, bar: { type: "number" } },
        required: ["bar"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const a = get();
        const s = findSong(a, args.song);
        if (!s) return fail("Song not found.");
        if (s.measures.length <= 1) return fail("A song needs at least one bar.");
        const mi = barIndex(s, args.bar);
        if (mi === null) return fail(`Bar must be 1-${s.measures.length}.`);
        mutateSong(a, s.id, (cur) => ({
          ...cur,
          measures: cur.measures.filter((_, i) => i !== mi),
        }));
        return ok(`Deleted bar ${mi + 1} of "${s.title}".`);
      },
    },
    {
      name: "write_notes",
      description:
        "Write notes into the tab. Either one line (bar + string + cells) or, PREFERRED for anything larger, a `writes` array of many lines applied atomically in one operation — much faster than sequential calls. cells is a space-separated token per slot, left to right. " +
        NOTATION +
        ` Use "." to leave a slot unchanged; fewer tokens than slots leaves the rest unchanged. Strings are 1-based from the top (1 = highest pitch). Returns the affected bars as ASCII for verification. Example: cells "0 0 3 /5 = = x -"`,
      inputSchema: {
        type: "object",
        properties: {
          ...songParam,
          bar: { type: "number", description: "1-based bar number (single-line form)" },
          string: { type: "number", description: "1-based string from the top (single-line form)" },
          cells: { type: "string", description: "Space-separated tokens (single-line form)" },
          writes: {
            type: "array",
            description: "Batch form: many lines written in one atomic operation.",
            items: {
              type: "object",
              properties: {
                bar: { type: "number" },
                string: { type: "number" },
                cells: { type: "string" },
              },
              required: ["bar", "string", "cells"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const a = get();
        const s = findSong(a, args.song);
        if (!s) return fail("Song not found.");
        const rawWrites = Array.isArray(args.writes)
          ? (args.writes as { bar: unknown; string: unknown; cells: unknown }[])
          : [{ bar: args.bar, string: args.string, cells: args.cells }];
        if (!rawWrites.length) return fail("No writes given.");

        // validate everything first — the batch applies atomically or not at all
        const valid = /^(\.|-|\d{1,2}|[/\\hptm^]\d{1,2}|[hpbrtx~=*/\\])$/;
        const parsed: { mi: number; si: number; tokens: string[] }[] = [];
        for (const w of rawWrites) {
          const mi = barIndex(s, w.bar);
          if (mi === null) return fail(`Bar must be 1-${s.measures.length} (got ${w.bar}).`);
          const si = Number(w.string) - 1;
          if (!Number.isInteger(si) || si < 0 || si >= s.tuning.length) {
            return fail(`String must be 1-${s.tuning.length} (1 = top/${s.tuning[0]}, ${s.tuning.length} = bottom/${s.tuning[s.tuning.length - 1]}).`);
          }
          const tokens = String(w.cells).trim().split(/\s+/);
          const nSlots = s.measures[mi].cols.length;
          if (tokens.length > nSlots) {
            return fail(`Bar ${mi + 1} has ${nSlots} slots (${s.measures[mi].sig ?? DEFAULT_SIG}, grid ${s.measures[mi].spb ?? DEFAULT_SPB}/beat) but got ${tokens.length} tokens.`);
          }
          const bad = tokens.find((t) => !valid.test(t));
          if (bad) return fail(`Invalid token "${bad}" in bar ${mi + 1}. ${NOTATION}`);
          const highFret = tokens.find((t) => {
            const fm = t.match(/(\d{1,2})/);
            return fm && parseInt(fm[1], 10) > 24;
          });
          if (highFret) return fail(`Fret out of range in "${highFret}" (bar ${mi + 1}) — valid frets are 0-24. ${NOTATION}`);
          parsed.push({ mi, si, tokens });
        }

        const apply = (cur: Song): Song => {
          const measures = [...cur.measures];
          for (const { mi, si, tokens } of parsed) {
            measures[mi] = {
              ...measures[mi],
              cols: measures[mi].cols.map((col, ci) => {
                const t = tokens[ci];
                if (t === undefined || t === ".") return col;
                return col.map((v, k) => (k === si ? (t === "-" ? "" : t) : v));
              }),
            };
          }
          return { ...cur, measures };
        };
        mutateSong(a, s.id, apply);

        const after = apply(s);
        const bars = [...new Set(parsed.map((p) => p.mi))].sort((x, y) => x - y);
        const msg = `Wrote ${parsed.length} line(s) across bar(s) ${bars.map((b) => b + 1).join(", ")}.`;
        if (bars.length > 4) {
          // large batches: skip the per-bar ascii echo — it bloats the
          // response and slows agent round trips; spot-check via get_song
          return ok(`${msg} (ascii echo omitted for ${bars.length}-bar batch — use get_song to verify)`);
        }
        return ok(msg, {
          bars_ascii: Object.fromEntries(bars.map((b) => [`bar_${b + 1}`, barAscii(after, b)])),
        });
      },
    },
    {
      name: "get_rig",
      description:
        "Read the amp/performance rig: tight (0-1 pre-distortion low-cut/mid emphasis), volume (0-2), mute_grip (0-1 palm-mute pressure), picking (alternate/down/up), double_track, engine (new = continuous voices, old = retrigger A/B), cab (synthetic cabinet after a NAM model), pm_bank (palm-mute sample source), note_bank (sustained-note guitar), player_rules (humanization on/off), feedback (amp feedback swell on long held notes), nam_input (DI level into the capture), room (0-1 amount of the small room around the cab), nam_model (active Neural Amp Modeler capture name, or null = built-in amp), nam_models (every capture the human has loaded in this browser — switch between them with set_rig.nam_model; adding a new .nam file still requires the human's file picker), loop.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => ok("Current rig", { ...get().rig }),
    },
    {
      name: "set_rig",
      description:
        "Set amp/performance rig settings (any subset). tight 0-1: the boost pedal in front of the amp (low cut, mid hump, soft clip) — raise for surgically tight modern-metal chugs. volume 0-2. mute_grip 0-1: palm-mute pressure, higher = shorter/choked. picking: 'down' keeps breakdowns uniformly forceful. double_track: independent second take hard-panned L/R (through two extra capture instances when a NAM model is loaded). engine: 'new' = sampled voices, 'hybrid' = sampled attack exciting a physical string model (experimental), 'model' = the string model alone with no sampled pick, 'old' only for A/B comparison. engine_status in get_rig says whether the model is actually running. cab: add the synthetic cabinet after a NAM model — keep false for full-rig captures. pm_bank: bassvi | gtx | custom. loop: loop playback. nam_model: switch the amp to one of get_rig.nam_models (name, case-insensitive) or 'none' for the built-in amp — adding a brand-new .nam file still requires the human's file picker.",
      inputSchema: {
        type: "object",
        properties: {
          tight: { type: "number", minimum: 0, maximum: 1 },
          volume: { type: "number", minimum: 0, maximum: 2 },
          mute_grip: { type: "number", minimum: 0, maximum: 1 },
          picking: { type: "string", enum: ["alternate", "down", "up"] },
          double_track: { type: "boolean" },
          engine: { type: "string", enum: ["new", "old", "hybrid", "model"] },
          player_rules: { type: "boolean", description: "performance humanization (tension glide, pick comb, velocity tone, micro-timing, chord rakes); false = plain sampler" },
          legato_landings: { type: "boolean", description: "hand legato/bend/slide landings over to a real recording of the target pitch (true) or keep the resampled voice (false)" },
          feedback: { type: "boolean", description: "notes held over ~1.3 s (with = or ~) swell into amp feedback on their overtone; off by default" },
          bass_rig: { type: "string", enum: ["bass", "guitar"], description: "for bass tunings: 'bass' = its own clean-to-gritty amp (tight = drive), 'guitar' = through the guitar rig/capture for distorted bass" },
          cab: { type: "boolean" },
          pm_bank: { type: "string", enum: ["gtechs", "gtx", "bassvi", "custom"], description: "palm-mute source: gtechs = LP humbucker (standard tuning), gtx = 7-string (drop tunings), bassvi, custom" },
          note_bank: { type: "string", enum: ["gtechs", "fsbs"], description: "sustained-note guitar: gtechs = LP humbucker, fsbs = Fender single-coil" },
          nam_model: { type: "string", description: "a name from get_rig.nam_models, or 'none' for the built-in amp" },
          nam_input: { type: "number", minimum: 0.1, maximum: 2, description: "DI level into the NAM capture (1 = raw sample level; default 0.45 ≈ -7 dB, where captures are trained)" },
          room: { type: "number", minimum: 0, maximum: 1, description: "the small room around the cab: 0 = bone dry, 0.1 default (a mic'd cab in a live room), 1 = very roomy" },
          loop: { type: "boolean" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const a = get();
        const patch: Record<string, unknown> = {};
        for (const k of ["tight", "volume", "mute_grip", "nam_input", "room"] as const) {
          if (args[k] !== undefined) {
            const v = Number(args[k]);
            if (!isFinite(v)) return fail(`${k} must be a number.`);
            patch[k] = v;
          }
        }
        if (args.picking !== undefined) {
          if (!["alternate", "down", "up"].includes(String(args.picking))) return fail("picking must be alternate, down, or up.");
          patch.picking = args.picking;
        }
        for (const k of ["double_track", "cab", "loop", "player_rules", "legato_landings", "feedback"] as const) {
          if (args[k] !== undefined) patch[k] = Boolean(args[k]);
        }
        if (args.bass_rig !== undefined) {
          if (!["bass", "guitar"].includes(String(args.bass_rig))) return fail("bass_rig must be bass or guitar.");
          patch.bass_rig = args.bass_rig;
        }
        if (args.engine !== undefined) {
          if (!["new", "old", "hybrid", "model"].includes(String(args.engine))) return fail("engine must be new, old, hybrid, or model.");
          patch.engine = args.engine;
        }
        a.setRig(patch as Parameters<WebMcpActions["setRig"]>[0]);
        let bankNote: string | undefined;
        if (args.pm_bank !== undefined) {
          if (!["bassvi", "gtx", "gtechs", "custom"].includes(String(args.pm_bank))) return fail("pm_bank must be gtechs, gtx, bassvi, or custom.");
          bankNote = await a.switchPmBank(args.pm_bank as "bassvi" | "gtx" | "gtechs" | "custom");
        }
        let noteNote: string | undefined;
        if (args.note_bank !== undefined) {
          if (!["gtechs", "fsbs"].includes(String(args.note_bank))) return fail("note_bank must be gtechs or fsbs.");
          noteNote = await a.setNoteBank(args.note_bank as "gtechs" | "fsbs");
        }
        let namNote: string | undefined;
        if (args.nam_model !== undefined) {
          const v = String(args.nam_model).trim();
          try {
            namNote = await a.selectNamModel(v === "" || v.toLowerCase() === "none" ? null : v);
          } catch (e) {
            return fail(`nam_model: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        return ok("Rig updated.", { applied: { ...patch, ...(bankNote ? { pm_bank: bankNote } : {}), ...(noteNote ? { note_bank: noteNote } : {}), ...(namNote ? { nam_model: namNote } : {}) } });
      },
    },
    {
      name: "play",
      description:
        "Play the song aloud for the human through the page's synth. Optionally a bar range or a named section; loop repeats it until stop. Also switches the view to that song.",
      inputSchema: {
        type: "object",
        properties: {
          ...songParam,
          from_bar: { type: "number" },
          to_bar: { type: "number" },
          section: { type: "string", description: "Section name to play (overrides from/to)" },
          loop: { type: "boolean", description: "Loop until stopped (default false)" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const a = get();
        const s = findSong(a, args.song);
        if (!s) return fail("Song not found.");
        if (s.id !== a.activeId) a.setActiveId(s.id);
        let from = 0, to = s.measures.length - 1;
        if (typeof args.section === "string" && args.section) {
          const r = sectionRange(s, args.section);
          if (!r) return fail(`No section matching "${args.section}".`);
          [from, to] = r;
        } else {
          if (args.from_bar !== undefined) from = (barIndex(s, args.from_bar) ?? 0);
          if (args.to_bar !== undefined) to = (barIndex(s, args.to_bar) ?? s.measures.length - 1);
        }
        a.setLoopMode(Boolean(args.loop));
        // let the song switch commit before starting
        setTimeout(() => get().play(from, to), 50);
        return ok(`Playing "${s.title}" bars ${from + 1}-${to + 1}${args.loop ? " on loop" : ""} at ${s.bpm} BPM.`);
      },
    },
    {
      name: "stop",
      description: "Stop playback.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        get().stop();
        return ok("Stopped.");
      },
    },
  ];
}

// ---- registration ----------------------------------------------------------
// Tools register at module-evaluation time (before React mounts) so the very
// first page snapshot an agent takes already contains the complete tool set.
// Executes gate on the app connecting its state, and all calls run through a
// serial queue — concurrent tool invocations apply strictly in order.

let actionsHolder: (() => WebMcpActions) | null = null;
let resolveConnected: () => void = () => {};
const connected = new Promise<void>((r) => (resolveConnected = r));
let queue: Promise<unknown> = Promise.resolve();

// read-after-write consistency: the app pings this on every render, and
// mutating tools wait for the ping so a chained read sees committed state
let commitWaiters: (() => void)[] = [];
export function notifyWebMcpCommit() {
  if (!commitWaiters.length) return;
  const w = commitWaiters;
  commitWaiters = [];
  for (const f of w) f();
}
function nextCommit(): Promise<void> {
  return Promise.race([
    new Promise<void>((r) => commitWaiters.push(r)),
    new Promise<void>((r) => setTimeout(r, 150)), // safety: never hang a tool
  ]);
}

async function appActions(): Promise<() => WebMcpActions> {
  if (!actionsHolder) {
    await Promise.race([connected, new Promise((r) => setTimeout(r, 5000))]);
  }
  if (!actionsHolder) throw new Error("RiffSmith is still loading — retry in a moment.");
  return actionsHolder;
}

function serialized(t: ToolDef): ToolDef {
  const mutates = !t.annotations?.readOnlyHint;
  return {
    ...t,
    execute: (args) => {
      const run = queue.then(async () => {
        try {
          await appActions();
          const result = await t.execute(args);
          // successful mutations wait for React to commit before the next
          // tool runs, so create → read chains see the new state
          if (mutates && (result as { ok?: boolean } | null)?.ok) {
            await nextCommit();
          }
          return result;
        } catch (err) {
          return fail(String(err instanceof Error ? err.message : err));
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

function registerTools(): string {
  const tools = buildTools(() => actionsHolder!()).map(serialized);
  const w = window as unknown as Record<string, any>;
  if (w.__webmcpRegistered) return "webmcp: already registered";
  w.__webmcpRegistered = true;

  // The console shim is ALWAYS installed — it is the immediately-available
  // testing surface even when a native modelContext exists (native snapshot
  // pipelines can lag several hundred ms behind page load).
  w.__webmcp = {
    tools,
    list: () => tools.map((t) => t.name),
    call: (name: string, args: Record<string, unknown> = {}) => {
      const t = tools.find((x) => x.name === name);
      if (!t) return Promise.resolve(fail(`No such tool: ${name}`));
      return t.execute(args);
    },
  };

  const mc = (document as unknown as Record<string, any>).modelContext ?? w.navigator?.modelContext;
  if (mc?.provideContext) {
    // atomic: the whole tool set lands in one snapshot
    mc.provideContext({ tools });
    return `webmcp: registered ${tools.length} tools via provideContext (+ shim)`;
  }
  if (mc?.registerTool) {
    for (const t of tools) mc.registerTool(t);
    return `webmcp: registered ${tools.length} tools via registerTool (+ shim)`;
  }
  return `webmcp: no modelContext in this browser — dev shim at window.__webmcp (${tools.length} tools)`;
}

// register as soon as the client bundle evaluates
if (typeof window !== "undefined") {
  console.info(registerTools());
}

// Called by the app once its state is available; idempotent.
export function registerWebMcp(get: () => WebMcpActions): string {
  actionsHolder = get;
  resolveConnected();
  return "webmcp: app state connected";
}
