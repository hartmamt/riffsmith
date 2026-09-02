# Testing instructions (paste into the Devpost "testing instructions" field)

**Live app:** https://riffsmith.app — no login, nothing to install.
Everything runs client-side; songs are stored in your browser.

## With an agent (the point of the project)

1. Open the URL in **ChatGPT's in-app browser** (desktop app → "Open in ChatGPT"
   from the composer) or **Chrome 149+ with `chrome://flags/#enable-webmcp-testing`**.
2. The page registers **15 tools** at load (`document.modelContext.registerTool`,
   with `navigator.modelContext` and `provideContext` fallbacks). In ChatGPT they
   appear under **Site tools**; in Chrome, DevTools has a WebMCP panel.
3. Try these prompts, in order — each exercises a different part of the surface:
   - "List the songs here and read me the THEME section of the first one."
   - "Make a new song in Drop B at 160 BPM and tab the first phrase of
     In the Hall of the Mountain King on the low B string: 8th notes,
     palm-muted, four bars. Name the section THEME, repeat it twice, and play it."
   - "That's too loose — all downstrokes, more mute pressure, double-track it."
     (uses `get_rig` / `set_rig`; watch the rig panel sliders move)
   - "Change bar 1 to 3/4 and add a bend on the last note."
   - "Put a pinch harmonic on the last note of bar 4 and switch the amp to the Fender bank."
     (uses the `^fret` articulation and `set_rig note_bank`)
   - Paste any ASCII guitar tab and say "import this and tell me what you kept."
4. Every write returns the resulting tab so the agent verifies its own work;
   edits appear live in the grid and stay human-editable — click any cell the
   agent wrote and type a new fret while it loops.

## Without an agent (console shim, any browser)

Open DevTools and run:
```js
window.__webmcp.list()                                  // the 15 tool names
await window.__webmcp.call("get_song", {})              // read the open song
await window.__webmcp.call("write_notes", { bar: 1, string: 6, cells: "m0 m0 x 0" })
await window.__webmcp.call("set_rig", { picking: "down", tight: 0.8 })
await window.__webmcp.call("set_rig", { engine: "hybrid" })         // physical string model (experimental)
await window.__webmcp.call("play", { section: "INTRO", loop: true })
```
The shim calls the exact same tool functions the native registration exposes.

## Hearing the amp

The live site opens with a real Neural Amp Modeler capture already loaded
(a 5150 full-rig capture by jpisoutoftune on TONE3000, credited in the rig panel;
demo use only, so it is not in the repo). Press play and you are hearing NAM
inference in an AudioWorklet in the browser. To try your own: in the **rig**
panel (right side) pick **load .nam file…** in the model dropdown and choose any
`.nam` capture (tone3000.com has thousands). Every model you load is kept in a
library (persists across reloads), and an agent can switch between them:
"switch the amp to the 5150 Red capture" → `set_rig { nam_model }`, or `none` for the built-in amp.

## Source

Repo: https://github.com/hartmamt/riffsmith — `npm install && npm run dev`, `npm test` runs the 29-test
suite over the scheduling/import layer. WebMCP implementation:
`lib/webmcp.ts` (tool definitions, serialized queue, read-after-write
consistency, early registration).
