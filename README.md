# RiffSmith

RiffSmith is a browser-based guitar and bass tab editor built for writing metal riffs: palm-muted chugs, tremolo picking, odd meters, repeats, and section-by-section looping. It plays what you write through a sampled guitar engine with a built-in amp, or through a real Neural Amp Modeler capture running in an AudioWorklet. Everything the editor can do is also exposed to AI agents through WebMCP, so an agent in the browser can write, edit, and audition riffs alongside you.

Live: https://riffsmith.app

## WebMCP

RiffSmith registers its full capability surface as page tools on `document.modelContext` (falling back to `navigator.modelContext`). The tools run through the same state operations the UI uses, so an agent edit shows up in the grid immediately, autosaves with everything else, and stays editable by the human. There is no separate "agent mode" or shadow document; anything a human can do in the editor, an agent can do through a tool, and vice versa.

That parity is the point. A tab editor that only lets an agent read the page, or only lets it fill in a form, forces the agent to work through the UI like a screen scraper. Giving it the same verbs the editor itself is built on means it can compose a riff, reshape a bar, set the amp, hit play, and check the result, all without touching a pixel.

### Tools

| Tool | Purpose |
| --- | --- |
| `list_songs` | List every song with tuning, BPM, bar count, and section starts. |
| `get_song` | Read one song in full: metadata, per-bar signature/grid/repeats, and the complete ASCII tab. Includes the notation guide. |
| `create_song` | Create and open a new song with a tuning preset, BPM, bar count, and starting time signature. |
| `update_song` | Change title, artist, BPM, tuning preset (notes are kept), or playback sound (synth / guitar / guitar-di). |
| `delete_song` | Delete a song. Requires `confirm_title` to match exactly; refuses to delete the last song. |
| `import_ascii_tab` | Import a pasted ASCII tab as a new song, including section headers, signatures, repeats, and inline slides. |
| `add_bars` | Append or insert empty bars, inheriting or overriding signature and grid. |
| `update_bar` | Set one bar's time signature, grid, section name, or repeat marks. |
| `duplicate_bar` | Copy a bar (with notes) in place after itself. |
| `delete_bar` | Remove a bar and its notes. |
| `write_notes` | Write cells on a string in a bar, or a `writes` batch of many lines applied atomically. Returns the affected bars as ASCII. |
| `get_rig` | Read the amp and performance settings, including which NAM model is active and every model loaded in this browser. |
| `set_rig` | Set any subset of tight, volume, mute grip, picking direction, double tracking, engine, cab, palm-mute bank, NAM model (from the loaded library, or `none`), and loop. |
| `play` | Play the whole song, a bar range, or a named section, optionally on loop. Switches the view to that song. |
| `stop` | Stop playback. |

The read tools (`list_songs`, `get_song`, `get_rig`) carry `readOnlyHint: true`.

### Design choices

**Returns you can verify.** `write_notes` echoes the affected bars back as ASCII tab so the agent can see what landed without a second call. For batches touching more than four bars the echo is skipped to keep the response small, and the message says to spot-check with `get_song`. `get_song` returns the full ASCII rendering alongside the structured per-bar data, so an agent can read the tab the same way a guitarist would.

**Validation with a guide.** Every `write_notes` token is checked against the cell grammar before anything is applied. A bad token, an out-of-range fret, a wrong string number, or too many tokens for the bar's slot count fails with a message that names the problem and, for notation errors, includes the full notation guide so the agent can correct itself.

**Atomic batches.** `write_notes` accepts a `writes` array. The whole batch is validated first and then applied in a single state update; a single invalid line rejects the whole batch and nothing changes.

**Serialized queue with read-after-write consistency.** All tool calls run through one promise queue, so concurrent invocations apply strictly in order. After a successful mutation the tool waits for React to commit (the app pings the bridge on every render) before the next call runs, capped at 150 ms so a tool can never hang. A `create_song` followed immediately by `get_song` sees the new song.

**Early registration.** Tools register at module-evaluation time, before React mounts, and via `provideContext` when available so the whole tool set lands in one snapshot. The first page snapshot an agent takes already contains all fifteen tools. Tool execution waits (up to 5 s) for the app to connect its state, and returns a retry message rather than an error if the page is still loading.

**Console shim for testing.** `window.__webmcp` is always installed, even when a native `modelContext` exists, because native snapshot pipelines can lag page load by a few hundred milliseconds. From the devtools console:

```js
__webmcp.list()
// ["list_songs", "get_song", "create_song", ...]

await __webmcp.call("get_song", {})
await __webmcp.call("write_notes", {
  writes: [
    { bar: 1, string: 6, cells: "m0 m0 m0 3 m0 m0 5 =" },
    { bar: 1, string: 5, cells: ". . . 5 . . 7 =" },
  ],
})
await __webmcp.call("play", { from_bar: 1, to_bar: 1, loop: true })
```

Without a `modelContext` provider in the browser the shim is the only surface, and the console logs which path was taken.

### Try it with an agent

Open the live site in a WebMCP-capable browser with an agent attached, and ask it things like:

1. "Create a song called 'Split Skull' in Drop B at 190 BPM with 8 bars of 4/4, then write a 16th-note chug riff on the low string with a power chord on beat 3 of every other bar."
2. "Import this tab I pasted from a forum, name the sections Intro / Verse / Breakdown, and loop the Breakdown so I can hear it."
3. "Bar 5 should be 7/8. Change it, fix the notes so nothing hangs past the bar, and play bars 4 through 6."
4. "Turn the mute grip up to 0.8, switch to all downstrokes, enable double tracking, and play the whole thing on loop."
5. "Read the song and tell me which bars have tremolo picking, then double the length of the intro by duplicating its bars."

Every one of those maps onto the tools above without any UI interaction.

## Features

- ASCII tab import and export. The importer reads hand-written tabs with any string count, 2- or 3-character slot widths detected per system, dense same-digit chug runs (`00000000`), multi-digit frets, section headers like `[1] 0:01 RIFF 3/4 ~160 BPM -- 2 bars, x8` (which become section names, signatures, and repeats), inline `5/7` and `5h7` techniques, and `|: :|` repeat marks. Nothing is dropped silently; anything skipped comes back as a warning. Export is round-trip safe.
- Per-bar time signatures (2/4, 3/4, 4/4, 5/4, 6/4, 7/4, 6/8, 9/8, 12/8) and grids (quarters, 8ths, triplets, 16ths, 16th triplets). Bar duration respects the denominator, so 6/8 beats are eighth notes.
- Sections and repeat signs, with loop-per-riff playback by bar range or section name.
- Live editing while looping. The scheduler re-reads song state as it advances, so edits land on the next pass.
- Lookahead AudioContext scheduler: events are placed about 130 ms ahead on the audio clock and refreshed every 25 ms. JS timers decide when to schedule, never when a note sounds.
- Sampled guitar engine with persistent per-string voices. Hammer-ons, pull-offs, taps, slides, bends, releases, and vibrato are continuous `detune` automation on the same voice, so a phrase gets one pick transient. Palm-mute chugs use velocity layers and round robins with gap-aware decay. Tremolo strokes are real re-picked notes with a 12 ms handover, cycling round robins; held bends, slides and hammer-ons crossfade into a recording of the target pitch instead of holding a resampled one. Alternate, down, and up picking with per-stroke tone coloring. Optional double tracking with independent hard-panned L/R takes.
- Performance layer ("player rules"): tension glide on every pick, pick-position comb filtering, velocity-dependent tone, stroke tilt, pre-pick clamp, metric accents with a little pick-force scatter, string-aware micro-timing, one-stroke chord rakes; pick scrape before the transient, fret clank on hard low hits, wound-string slide squeak that follows slide speed, pick-hand stop thump, a gated amp noise floor. Vibrato is one-sided like a fretting hand (up from the note, down from a bend), bends ease into pitch with a touch of overshoot, slides move like a finger. Drop tunings stay on one guitar: notes and chugs below the bank's low E pitch the low-E recordings down with the pick transient kept unshifted. Optional amp feedback: a note held over a second in front of the rig swells into its overtone.
- Built-in amp chain: tightening high-pass and mid emphasis, waveshaper drive, post EQ, a synthetic cabinet impulse response rendered offline, and a compressor. Every amp (built-in, NAM, bass) feeds a small synthetic stereo room on a send (`room` in the rig, 0 = dry).
- Neural Amp Modeler inference in an AudioWorklet. Load a `.nam` capture from disk (every capture you load is kept in a per-browser library, and an agent can switch between them). A deployment can also ship captures: drop `.nam` files in `public/nam/models/` with a `manifest.json` (`{ "models": [{ "name", "url", "credit", "creditUrl" }] }`) and the first one becomes the default amp until the user picks something else. RiffSmith ships one such capture, trained by the author on his own rig; the model runs through `@opendaw/nam-wasm` at 48 kHz, output is loudness-normalized from the model's metadata, and the synthetic cab can be added after it for amp-only captures. A1 and A2 WaveNet models are supported. The loaded model persists in IndexedDB across reloads.
- Rig side panel with persisted settings (tight, volume, mute grip, picking, double tracking, engine, cab, palm-mute bank, note bank, player rules, legato landings, ring time, feedback, NAM input, room, bass rig (clean or distorted capture / built-in amp / guitar rig), loop).
- Custom palm-mute sample bank: drop in your own DI `.wav` hits named `<note><octave>_v<velocity>_rr<n>.wav`; they persist in IndexedDB and replace the built-in bank where they cover the pitch.
- `scripts/mine_chugs.py`: mine palm-mute hits out of full DI stems into bank-convention files, reporting every candidate and why rejects were rejected.
- Share a song as a link: the whole song is compressed into the URL fragment (`#s=…`), so a link carries the tab with no server or account; opening it adds the song locally. `get_song` returns the same `share_url` for agents.
- Export to MP3: records one real-time pass through the rig you're hearing (captures included) and encodes it in the browser (192 kbps stereo), trimmed and peak-normalised.
- A bass track: a bass lane under every bar (same slots, its own tuning), played on a second sampler through the bass channel into the same master. `+ bass` adds it, `bass ← guitar` writes a first pass that follows the guitar's lowest notes (palm mutes stay muted, holds stay held), and agents get the same through `update_song { bass }`, `write_notes { track: "bass" }` and `bass_follow_guitar`. ASCII export carries the lane as a `[ bass ]` system and import reattaches it.
- Editing basics a tool needs: undo/redo (⌘Z / ⇧⌘Z, or the `undo` tool), whole-bar selection by clicking bar numbers (shift-click to extend) with copy, cut, paste and delete (⌘C/⌘X/⌘V/⌫), riff shifting by a slot (⌥←/⌥→), and transpose by semitones (♭/♯, ⌘↑/⌘↓, alt for the whole song, or the `transpose` tool), which refuses to push a note off the fretboard.
- Count-in (one bar of clicks) and a click track under playback, both on the transport and in `set_rig`.
- 7- and 8-string presets (B standard, Drop A, F# standard, Drop E) plus custom tunings typed as note names, also via `update_song { tuning }`.
- Audition songs (technique test, chug A/B, tremolo) for comparing DI, built-in amp, NAM, and palm-mute banks while looping.
- New and imported songs play through the sampled guitar and the rig by default; a plain synth voice is still available per song for sketching before samples load.

## Notation

Each cell holds one token. Strings are numbered 1 (top, highest pitch) to N (bottom, lowest).

| Token | Meaning |
| --- | --- |
| `0`–`24` | Fret number, picked. |
| `m0`, `m3` | Palm-muted chug on that fret. |
| `x` | Unpitched dead chug. |
| `*` | One repick of the preceding note on this slot. Repeat `*` cells on a 16th grid for tremolo picking. Works after `m` notes and `x` too. |
| `=` | Hold the previous note out. A picked note rings about a second on its own, then fades; `=` in every slot keeps it sounding past that (a keyboard-sequencer default, on purpose). |
| `~` | Vibrato on the preceding note (also holds). |
| `/7` | Slide up into fret 7. |
| `\7` | Slide down into fret 7. |
| `h7` | Hammer-on to 7 (legato, no pick attack). |
| `p5` | Pull-off to 5. |
| `t12` | Tap 12. |
| `^7` | Pinch harmonic on fret 7: the overtone (3rd harmonic low, 4th high) from the clean bank over a little of the fundamental. |
| `b` | Bend the preceding note up a whole step. |
| `r` | Release the bend back down. |
| `-` | Empty. |
| `.` | (`write_notes` only) Leave this slot unchanged. |

Chug riff: `m0 m0 m0 3 m0 m0 5 =`. Tremolo: `0 * * *`.

## Running locally

```sh
npm install
npm run dev     # http://localhost:3000
npm test        # vitest: 31 tests over the pure scheduling/import layer
```

Songs and rig settings persist in `localStorage`; custom palm-mute samples and the loaded NAM model persist in IndexedDB.

## Architecture

| Path | Responsibility |
| --- | --- |
| `lib/model.ts` | Song and measure types, tuning presets, signature/grid helpers, `toAscii` export. |
| `lib/importAscii.ts` | ASCII tab parser: systems, stride detection, dense runs, headers, repeats, warnings. |
| `lib/schedule.ts` | Pure playback logic: cell grammar to articulation actions, slot timing, accents, repeat/loop position advance. No Web Audio; fully unit-testable in Node. |
| `lib/sampler.ts` | Sampled guitar engine: per-string voices, articulations, amp chains, double tracking, custom PM banks, NAM routing. |
| `lib/pmbank.ts` | IndexedDB persistence for custom palm-mute samples and small blobs (the `.nam` model). |
| `lib/webmcp.ts` | WebMCP bridge: the 21 tool definitions, validation, serialized queue, commit waiting, registration, console shim. |
| `lib/demo.ts` | Audition songs. |
| `components/TabEditor.tsx` | The editor UI, lookahead scheduler, synth voice, rig panel, import/export dialogs, and the `WebMcpActions` surface handed to the bridge. |
| `public/nam/` | NAM AudioWorklet processor plus the `@opendaw/nam-wasm` glue and binary. |
| `public/samples/` | Bundled sample banks. |
| `scripts/mine_chugs.py` | Stem-mining tool for building palm-mute banks. |

## Credits and licenses

The MIT license in `LICENSE` covers RiffSmith's own code and the bundled RiffSmith Distorted, RiffSmith Clean, RiffSmith Bass Clean and RiffSmith Bass Distorted captures. Bundled third-party audio and engine assets carry their own licenses, listed here.

Sample sources, as documented in `lib/sampler.ts`:

- Sustained notes and palm mutes (LP humbucker, standard tuning): **Guitar-TECHS** (Pedroza et al., ICASSP 2025), player 1 direct-input channel, CC BY 4.0. One DI note per string and fret plus palm mutes on every position, cut from the long recordings and level-matched for RiffSmith (`public/samples/gtechs/NOTICE.txt`). The recording's low E string was dead (its upper partials sat at the noise floor), so those files had partials 4–12 regenerated from the recorded fundamentals and fitted to the A string's spectrum; the NOTICE documents the change. Notes are chosen string-aware, so a fret-5 A on the low E plays the low-E recording.
- Bass (any tuning with five or fewer strings whose lowest note is below C2): **Black And Blue Basses "babyblue"** by Karoryfer Samples, CC0. Picked 5-string, bridge pickup, chromatic B0–D4, two dynamics with round robins, loaded on demand (`public/samples/bass/NOTICE.txt`).
- Alternative sustained notes (Fender single-coil, two dynamics): **Electric Guitar FSBS (direct)** by the FreePats project, CC0. DI Fender electric, bridge pickup, standard tuning with a dropped low C, two pick dynamics (hard ×4 round robins, soft ×2), 48 kHz. Trimmed to 3.5 s and level-matched for RiffSmith (`public/samples/fsbs/NOTICE.txt`).
- Unpitched dead hits (and fallback sustains): **Emilyguitar** by Karoryfer Samples, CC0. The "muted" noises in that library are unpitched string-muting sounds and are used here only for dead hits, never for pitched mutes.
- Pitched palm mutes: **Pastabass "tagliatelle"** by Karoryfer Samples, royalty-free including redistribution. Squier Bass VI, flatwound, picked and muted; 2 velocity layers, 3 round robins.
- **@opendaw/nam-wasm** (MIT), a WASM build of Steven Atkinson's NeuralAmpModelerCore v0.5.3 (MIT) with the A2 fast path. The NAM core license is included at `public/nam/LICENSE`.

Four NAM captures are bundled, all trained by Matt Hartman on his own rigs with the TONE3000 trainer and released with the repo under the MIT license: **RiffSmith Distorted** (`public/nam/models/riffsmith-distorted.nam`, the default guitar amp), **RiffSmith Clean** (`riffsmith-clean.nam`, a clean channel; set `tight` to 0 to keep the boost pedal out of it), **RiffSmith Bass Clean** (`riffsmith-bass-clean.nam`, the default bass channel, running in its own NAM instance) and **RiffSmith Bass Distorted** (`riffsmith-bass-distorted.nam`, the driven bass; `set_rig { bass_model }`). Users can load any other `.nam` file.

## Submission notes (OpenAI WebMCP Challenge)

- **Timeline.** The repository was scaffolded with Create Next App on 2026-08-23 and contained nothing but the scaffold. Everything else, including the entire WebMCP layer (`lib/webmcp.ts`, the 21 tools, the console shim, the bridge pattern) and the tab editor itself, was written between 2026-09-01 and the submission date, after the 2026-08-25 eligibility date. `git log` is the record.
- **What is bundled.** Every sample bank in `public/samples/` is redistributable under the license in its `NOTICE.txt` (CC BY 4.0, CC0, or the vendor's royalty-free terms) and the modifications made for RiffSmith are documented there. The NAM inference engine is MIT.
- **Amp captures.** All four Neural Amp Modeler captures the app ships with (RiffSmith Distorted, RiffSmith Clean, RiffSmith Bass Clean, RiffSmith Bass Distorted) were trained by the author on his own rig and are part of the repository under the same MIT license, so the hosted demo and the repository are identical. Anyone can load a different `.nam` file; the built-in amp works with none.
- **Secrets and services.** None. There is no backend, no API key, and no environment variable; the app is a static Next.js export that runs entirely in the browser.

## Roadmap

- Let an agent load a NAM model by name from a user-approved set (today loading a `.nam` requires the human to pick a file).
- Chord and multi-string helpers in `write_notes` (power chords, octaves) so agents write fewer lines per riff.
- Drum and bass companion tracks synced to the same scheduler.
- Export to MIDI and to Guitar Pro-compatible formats.
- Wider sample coverage for the sustained-note bank, especially below B1 for 7- and 8-string tunings.
