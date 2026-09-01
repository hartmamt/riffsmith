# Testing instructions (paste into the Devpost "testing instructions" field)

**Live app:** https://guitarscrobble.vercel.app — no login, nothing to install.
Everything runs client-side; songs are stored in your browser.

## With an agent (the point of the project)

1. Open the URL in **ChatGPT's in-app browser** (desktop app → "Open in ChatGPT"
   from the composer) or **Chrome 149+ with `chrome://flags/#enable-webmcp-testing`**.
2. The page registers **15 tools** at load (`document.modelContext.registerTool`,
   with `navigator.modelContext` and `provideContext` fallbacks). In ChatGPT they
   appear under **Site tools**; in Chrome, DevTools has a WebMCP panel.
3. Try these prompts, in order — each exercises a different part of the surface:
   - "List the songs here and read me the intro of the first one."
   - "Make a new song in Drop B at 160 BPM with an 8-bar metalcore breakdown:
     two bars of palm-muted open-B triplet chugs, a two-bar variation with a
     hammer-on lick on the 3rd fret, repeat the whole thing twice, name the
     section BREAKDOWN, and play it."
   - "That's too loose — all downstrokes, more mute pressure, double-track it."
     (uses `get_rig` / `set_rig`; watch the rig panel sliders move)
   - "Change bar 1 to 3/4 and add a bend on the last note."
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
await window.__webmcp.call("play", { section: "INTRO", loop: true })
```
The shim calls the exact same tool functions the native registration exposes.

## Hearing the amp

The app ships with a sampled guitar and a built-in amp. For the real
Neural Amp Modeler path: in the **rig** panel (right side), set sound to
"guitar + amp", click **load .nam model**, and pick any `.nam` capture
(e.g. from tone3000.com — we can't bundle one for licensing reasons). It runs
NAM inference in an AudioWorklet in the browser; the model persists across reloads.

## Source

Repo: [REPO URL] — `npm install && npm run dev`, `npm test` runs the 25-test
suite over the scheduling/import layer. WebMCP implementation:
`lib/webmcp.ts` (tool definitions, serialized queue, read-after-write
consistency, early registration).
