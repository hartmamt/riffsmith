# RiffSmith — Devpost submission copy

## Tagline

A metal tab editor where every feature is a WebMCP tool. If a human can do it, an agent can.

(92 characters)

Alternates:

- Write riffs with an agent: the whole editor is 15 WebMCP tools. (63)
- A guitar tab editor that agents can play, not just read. (56)

## Description

### The problem

Writing metal on a tab editor is slow, mechanical work: sixteenth-note chug runs, odd meters, repeats, and sections that have to be auditioned in a loop to know if they are any good. AI agents are good at exactly this kind of structured, iterative writing, but web apps give them almost nothing to work with. An agent looking at a tab editor sees a grid of cells it can click one at a time, with no way to know what a cell means, whether a write succeeded, or what the result sounds like. Reading the page is not the same as being able to use it.

### What we built

RiffSmith is a browser tab editor for guitar and bass, tuned for metal writing. It imports and exports ASCII tab (including messy hand-written tabs with dense chug runs, section headers, and repeat marks), supports per-bar time signatures from 2/4 to 12/8 and grids from quarters to 16th triplets, and loops any section while you keep editing. Playback runs through a lookahead AudioContext scheduler into a sampled guitar engine with persistent per-string voices: legato hammer-ons, pull-offs and taps as detune automation on one voice, real bends and releases, vibrato, slides, velocity-layered palm-mute chugs with round robins, tremolo picking as real re-picked notes with a 12 ms handover, alternate/down/up picking, and optional double tracking. The signal then goes through a built-in amp chain with a synthetic cabinet IR, or through a real Neural Amp Modeler capture running as WASM inside an AudioWorklet, loudness-normalized from the model's metadata (the bundled default is a capture we trained on our own rig, shipped with the repo). The sound comes from real DI recordings with open licenses (Guitar-TECHS, CC BY 4.0, an LP humbucker with palm mutes on every position; FreePats, CC0; Karoryfer's 5-string bass, CC0, for bass tunings), chosen string-aware so a note plays from the string it is tabbed on, with held bends and slides crossfading into real recordings of the target pitch. An experimental physical string model (Rust compiled to WebAssembly, running in an AudioWorklet) can take over the ring-out. A performance layer adds what a hand does (tension glide, pick position, one-sided vibrato, finger-shaped bends, pick scrape, slide squeak, fret clank, micro-timing) and a small room sits after every amp. A rig panel holds the amp and performance settings, and users can import their own palm-mute sample banks. It opens on an E standard arrangement of Grieg's In the Hall of the Mountain King (public domain) as a full band: palm-muted theme, the answer on the A string, a tremolo-picked reprise and a chord finale on guitar, with a bass lane and a drum lane that follow the riff. The pure scheduling and import layers have 31 unit tests.

### Why this use case fits WebMCP

A tab editor is the worst case for an agent working through the DOM: hundreds of identical cells whose meaning depends on tuning, time signature, grid, and position, plus audio state that has no visible representation at all. Screen-reading gives the agent pixels; a REST API would give it a document nobody is looking at. WebMCP fits because the value is in the *shared* surface: the agent needs the editor's own verbs (write these cells, set this bar to 6/8, loop the THEME, tighten the amp) and the human needs the result to appear in the exact grid they are editing, playable, with nothing to sync.

### How it improves the user experience

Writing metal tab by hand means hundreds of keystrokes for a sixteenth-note chug run, then hearing it, then doing it again. With the tools, a guitarist describes a riff in one sentence and gets the first phrase of In the Hall of the Mountain King in the grid in a single round trip, already looping through the amp. Structure edits that were tedious (retime a bar, add a repeat, rename a section, duplicate a variation) become one-line requests. The rig is a tool too, so "make it tighter, all downstrokes, double-tracked" moves the actual sliders, and the human can nudge them afterwards. Imports report exactly what they kept and what they adapted, so the agent never has to guess about a messy pasted tab.

### What people and agents can do together that was hard before

The human and the agent are editing the same object at the same time. An agent writes a riff, the guitarist clicks a cell it wrote and changes one note while the loop keeps running, then asks the agent for a variation of *that*, and the agent reads the human's edit through `get_song` and builds on it. Neither side owns the document; there is no export/import step and no "agent mode". That kind of tight, audible, back-and-forth composition between a person and a model was not possible when the agent's only view of the app was a screenshot.

### How WebMCP is implemented

The whole editor is exposed to agents as 15 tools on `document.modelContext` (with `navigator.modelContext` as a fallback): `list_songs`, `get_song`, `create_song`, `update_song`, `delete_song`, `import_ascii_tab`, `add_bars`, `update_bar`, `duplicate_bar`, `delete_bar`, `write_notes`, `get_rig`, `set_rig`, `play`, and `stop`. The design principle is parity: every tool runs through the same state operations the UI uses, so an agent's edits appear in the grid live, autosave, and remain human-editable. There is no agent-only document or hidden mode; anything a human can do, an agent can do, and the human can pick up where the agent left off. Several choices make the tools usable rather than merely present. Tool returns enable verification: `write_notes` echoes the affected bars back as ASCII tab, and `get_song` returns the full ASCII rendering alongside structured per-bar data. Notation is validated before any write, and a rejected token comes back with the complete notation guide so the agent can self-correct. `write_notes` takes a `writes` array that is validated in full and then applied atomically in one state update, so a whole riff lands in one round trip or not at all. All calls go through a serialized queue, and mutations wait for React to commit before the next call runs, giving read-after-write consistency for chains like create-then-read. Tools register at module-evaluation time, before React mounts, so an agent's first page snapshot already contains the complete set. And because native snapshot pipelines can lag page load, a console shim at `window.__webmcp` is always installed for testing, with `__webmcp.list()` and `__webmcp.call(name, args)`. Even the amp model is under agent control: every `.nam` capture the human has loaded is kept in a library, `get_rig` lists it, and `set_rig` switches between captures or back to the built-in amp. The one residual gap is adding a brand-new `.nam` file, which needs the browser's file picker.

## What's next

Next: chord and multi-string helpers in `write_notes` so agents can write power chords and octaves in fewer lines, drum and bass companion tracks on the same scheduler, MIDI and Guitar Pro export, and a wider sustained-note sample bank for 7- and 8-string tunings. We also want to publish the WebMCP bridge pattern (serialized queue, commit waiting, early registration, console shim) as a small standalone package so other editors can adopt it.

## Built with

next.js, typescript, webmcp, web-audio, audioworklet, wasm, neural-amp-modeler, vercel

Additional tags if the form allows: react, vitest, indexeddb
