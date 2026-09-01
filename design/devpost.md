# GuitarScrobble — Devpost submission copy

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

GuitarScrobble is a browser tab editor for guitar and bass, tuned for metal writing. It imports and exports ASCII tab (including messy hand-written tabs with dense chug runs, section headers, and repeat marks), supports per-bar time signatures from 2/4 to 12/8 and grids from quarters to 16th triplets, and loops any section while you keep editing. Playback runs through a lookahead AudioContext scheduler into a sampled guitar engine with persistent per-string voices: legato hammer-ons, pull-offs and taps as detune automation on one voice, real bends and releases, vibrato, slides, velocity-layered palm-mute chugs with round robins, tremolo picking that overlaps strokes over the ringing body, alternate/down/up picking, and optional double tracking. The signal then goes through a built-in amp chain with a synthetic cabinet IR, or through a real Neural Amp Modeler capture running as WASM inside an AudioWorklet, loudness-normalized from the model's metadata. A rig panel holds the amp and performance settings, and users can import their own palm-mute sample banks. The pure scheduling and import layers have 25 unit tests.

### How WebMCP is used

The whole editor is exposed to agents as 15 tools on `document.modelContext` (with `navigator.modelContext` as a fallback): `list_songs`, `get_song`, `create_song`, `update_song`, `delete_song`, `import_ascii_tab`, `add_bars`, `update_bar`, `duplicate_bar`, `delete_bar`, `write_notes`, `get_rig`, `set_rig`, `play`, and `stop`. The design principle is parity: every tool runs through the same state operations the UI uses, so an agent's edits appear in the grid live, autosave, and remain human-editable. There is no agent-only document or hidden mode; anything a human can do, an agent can do, and the human can pick up where the agent left off. Several choices make the tools usable rather than merely present. Tool returns enable verification: `write_notes` echoes the affected bars back as ASCII tab, and `get_song` returns the full ASCII rendering alongside structured per-bar data. Notation is validated before any write, and a rejected token comes back with the complete notation guide so the agent can self-correct. `write_notes` takes a `writes` array that is validated in full and then applied atomically in one state update, so a whole riff lands in one round trip or not at all. All calls go through a serialized queue, and mutations wait for React to commit before the next call runs, giving read-after-write consistency for chains like create-then-read. Tools register at module-evaluation time, before React mounts, so an agent's first page snapshot already contains the complete set. And because native snapshot pipelines can lag page load, a console shim at `window.__webmcp` is always installed for testing, with `__webmcp.list()` and `__webmcp.call(name, args)`. The one thing an agent cannot do is load a `.nam` file, because that requires a local file pick; `get_rig` reports which model is loaded and `set_rig` explains the limit.

## What's next

The next step is closing the last parity gap: letting an agent choose a NAM model from a set the user has already approved, instead of requiring a file pick. After that, chord and multi-string helpers in `write_notes` so agents can write power chords and octaves in fewer lines, drum and bass companion tracks on the same scheduler, MIDI and Guitar Pro export, and a wider sustained-note sample bank for 7- and 8-string tunings. We also want to publish the WebMCP bridge pattern (serialized queue, commit waiting, early registration, console shim) as a small standalone package so other editors can adopt it.

## Built with

next.js, typescript, webmcp, web-audio, audioworklet, wasm, neural-amp-modeler, vercel

Additional tags if the form allows: react, vitest, indexeddb
