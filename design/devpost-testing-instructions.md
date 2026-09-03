# Testing instructions (paste into the Devpost "testing instructions" field)

**Live app:** https://riffsmith.app — no login, nothing to install.
Everything runs client-side; songs are stored in your browser. A first visit
opens on an E standard arrangement of Grieg's In the Hall of the Mountain
King (sections THEME, TREMOLO, FINALE). Press play once so the browser lets
audio start; the sample banks and the amp capture load on that first play.

## With an agent (the point of the project)

1. Open the URL in **ChatGPT's in-app browser** or **Chrome 149+ with
   `chrome://flags/#enable-webmcp-testing`**.
2. The page registers **20 tools** at module load on `document.modelContext`
   (with `navigator.modelContext` and `provideContext` fallbacks). In ChatGPT
   they appear under **Site tools**; in Chrome, DevTools has a WebMCP panel.
   If a client snapshots the page before that first script runs, reload once;
   the console shim below is always available regardless.
3. Try these prompts, in order. Each exercises a different part of the surface:
   - "List the songs here and read me the THEME section of the first one."
   - "Make a new song in Drop B at 160 BPM and tab the first phrase of
     In the Hall of the Mountain King on the low B string: 8th notes,
     palm-muted, four bars. Name the section THEME, repeat it twice, and play it."
   - "That's too loose. All downstrokes, more mute pressure, double-track it."
     (uses `get_rig` / `set_rig`; watch the rig panel sliders move)
   - "Change bar 1 to 3/4 and add a bend on the last note."
   - "Put a pinch harmonic on the last note of bar 4."
     (uses the `^fret` articulation)
   - Paste any ASCII guitar tab and say "import this and tell me what you kept."
4. Every write returns the resulting tab so the agent verifies its own work;
   edits appear live in the grid and stay human-editable. Click any cell the
   agent wrote and type a new fret while it loops.

## Without an agent (console shim, any browser)

Open DevTools and run:
```js
window.__webmcp.list()                                  // the 20 tool names
await window.__webmcp.call("get_song", {})              // read the open song
await window.__webmcp.call("write_notes", { bar: 1, string: 6, cells: "m0 m0 x 0" })
await window.__webmcp.call("set_rig", { picking: "down", tight: 0.8, double_track: true })
await window.__webmcp.call("play", { section: "THEME", loop: true })
await window.__webmcp.call("transpose", { semitones: 2, from_bar: 1, to_bar: 2 })
await window.__webmcp.call("undo", {})
await window.__webmcp.call("share_song", {})              // a link that carries the song
await window.__webmcp.call("stop", {})
```
The shim calls the exact same tool functions the native registration exposes.

## Hearing the amp

The live site plays through a real Neural Amp Modeler capture:
**RiffSmith Distorted**, trained by the author on his own rig and shipped in
the repository (`public/nam/models/`). Press play and you are hearing NAM
inference in an AudioWorklet in the browser. To try your own capture: in the
**rig** panel (right side) pick **load .nam file…** in the model dropdown and
choose any `.nam` file (tone3000.com has thousands). Every model you load is
kept in a per-browser library, and an agent can switch between them with
`set_rig { nam_model }`, or `none` for the built-in amp.

For bass, open **audition songs → bass showcase**: bass tunings switch to a
real bass through the bundled **RiffSmith Bass Clean** capture automatically
(`set_rig { bass_model: "RiffSmith Bass Distorted" }` for the driven one; `bass_rig` picks
the capture, the built-in bass amp, or the guitar rig).

## Sharing and exporting

The **ascii ▾** menu has **share link** (the whole song compressed into the URL,
no server; open it anywhere to get a copy) and **export mp3** (records one
real-time pass through the rig and saves an MP3). `get_song` returns the same
`share_url` to agents.

## Source

Repo: https://github.com/hartmamt/riffsmith — `npm install && npm run dev`,
`npm test` runs the unit suite over the scheduling and import layers (including
an ASCII export → import round-trip across mixed meters and grids). WebMCP
implementation: `lib/webmcp.ts` (tool definitions, serialized queue,
read-after-write consistency, early registration, console shim).
