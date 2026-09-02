## Inspiration

I play guitar in a metal band, and like every guitarist I have a folder of half-finished riffs living in text files. Tab editors make those playable, but writing metal in one is slow, mechanical work: sixteenth-note chug runs, odd meters, repeats, and sections you have to loop a dozen times to know if they're any good. That's exactly the kind of structured, iterative writing an AI agent is good at, and yet an agent looking at a tab editor sees a grid of identical cells it can only click one at a time, with no idea what a cell means, whether a write landed, or what any of it sounds like.

WebMCP was the missing piece. Instead of teaching an agent to screen-read a grid, give it the editor's own verbs. RiffSmith is the tab editor where every feature is a tool, and the human and the agent write in the same document at the same time.

## What it does

RiffSmith is a browser tab editor for guitar and bass, tuned for metal. It imports and exports ASCII tab, including messy hand-written tabs with dense chug runs, section headers, and repeat marks. It handles per-bar time signatures from 2/4 to 12/8, grids from quarters to 16th triplets, and loops any section while you keep editing.

Playback runs through a sampled guitar engine with persistent per-string voices: palm-muted chugs, hammer-ons, pull-offs, taps, slides, bends, vibrato, tremolo picking, pinch harmonics, dead notes, and chord strums, built from real direct-input recordings with open licenses. The signal goes through a real Neural Amp Modeler capture running as WebAssembly inside an AudioWorklet (the bundled one is a capture I trained on my own rig), or a built-in amp chain. A performance layer adds what a hand does: tension glide on every pick, pick position, one-sided fretting-hand vibrato, finger-shaped bends, pick scrape, wound-string slide squeak, fret clank, and micro-timing. Bass tunings get a real bass and their own amp.

Every one of those capabilities is exposed to agents as one of 15 WebMCP tools on `document.modelContext`: songs, bars, notation, imports, the rig, and playback. An agent can create a song, write a four-bar riff in one atomic call, set the amp tighter with all downstrokes and double tracking, play it, and read back the tab to verify its own work, while the human watches it land in the grid and edits any note it wrote.

## How we built it

Next.js App Router, TypeScript, and the Web Audio API, deployed as a static site on Vercel. There is no backend; songs live in localStorage and sample banks and amp captures in IndexedDB.

The WebMCP layer follows one rule, parity: every tool runs through the same state operations the UI uses, so there's no agent-only document or hidden mode. Tool returns are built for verification, with `write_notes` echoing the affected bars back as ASCII tab and `get_song` returning the full rendering. Notation is validated before any write, and a rejected token comes back with the complete notation guide so the agent can self-correct. Writes take a batch that is validated in full and applied atomically. Calls go through a serialized queue and mutations wait for React to commit before the next call runs, which gives read-after-write consistency for chains like create-then-read. Tools register at module evaluation, before React mounts, so an agent's first page snapshot already has the complete set, and a console shim at `window.__webmcp` is always available for testing.

The audio engine is a lookahead scheduler placing events on the audio clock, driving a sampler with continuous per-string voices, plus an experimental physical string model written in Rust and compiled to WebAssembly (no bindgen, about 21 KB) that runs in its own AudioWorklet. Sound comes from the Guitar-TECHS dataset (CC BY 4.0), FreePats (CC0), and Karoryfer's bass (CC0), chosen string-aware so a note plays from the string it's tabbed on. Every sound decision was measured before it shipped: offline renders through the real engine, pitch tracking, banded spectra, transient detectors, and level profiles around transitions. The pure scheduling and import layers have 29 unit tests.

## Challenges we ran into

**Pitch shifting is time stretching.** Web Audio's `detune` folds into playback rate, so every pitched sample also stretches its pick transient. That was the source of a lot of "synthy". The fix was a set of real-recording handovers: held bends, slides, hammer-ons and pull-offs crossfade into a recording of the target pitch, energy-matched and decay-matched.

**The "pick" in every hammer-on.** Legato kept sounding picked no matter what we did to the crossfade. The real bug was that the envelope was being re-read about 130 ms early and reset upward on every legato event. Tracking the envelope analytically from our own schedule fixed it in one afternoon after days of chasing filters.

**A dead string in the dataset.** The low E string of the Guitar-TECHS guitar had almost no upper partials, about 28 dB below the same pitches on the A string, and that's the string every metal riff lives on. We regenerated its partials from the recorded fundamentals, fitted to the A string's spectrum. The first pass came out 145 cents flat because the files are 48 kHz and the script assumed 44.1. A pitch check caught it.

**Licensing.** The best-sounding amp capture we found is not redistributable, and the rules require the submission to be fully open. The answer was to train a capture of my own rig and ship it with the repo under MIT, so the hosted demo and the repository are identical.

**Bare tools aren't usable tools.** The first version of the tools worked and agents still failed with them: silent write errors, snapshot pipelines that missed late-registered tools, create-then-read races. Most of the WebMCP work was making the tools honest and verifiable, not making them exist.

## Accomplishments that we're proud of

A human and an agent editing the same riff at the same time, audibly, with no export step and no agent mode. The agent writes a riff, I click a cell it wrote and change one note while the loop keeps running, and it builds a variation on *my* edit. That was the whole point and it works.

The engine went from a sampler to something a guitarist listens to and says "that's pretty great": real-recording legato landings, one-sided vibrato, finger-shaped bends, a fully synthesized pinch harmonic that screams through the amp, a bass with its own amp, a slide squeak that follows the speed of the slide, and a physical string model in Rust running in the browser.

Every tool is verifiable by the agent that called it, and the whole thing runs as a static page with no server.

## What we learned

Agents need feedback loops more than they need features. The tools that mattered most were the ones that echo the result of a write back as tab, return the notation guide with a rejection, and guarantee that a read after a write sees the write. Registering tools before the framework mounts matters because snapshot pipelines are unforgiving about timing.

On the audio side, measure before you listen. Almost every "it sounds synthy" turned out to have a specific, measurable cause (input level into the capture, a compressor that shouldn't have been there, a stretched transient, an envelope step) rather than a vibe, and an offline render harness found each of them faster than ears could.

And a real guitarist's ear is the final test. Several things that measured fine still got sent back.

## What's next for RiffSmith

Chord and multi-string helpers in `write_notes` so agents can write power chords and octaves in fewer lines. Drum and bass companion tracks on the same scheduler. Render-to-WAV. MIDI and Guitar Pro export. A clean-channel capture and a bass capture to sit next to the distorted one. A wider low-tuned sample bank recorded on my own guitar, since no open dataset covers Drop B. And publishing the WebMCP bridge pattern (serialized queue, commit waiting, early registration, console shim) as a small standalone package so other editors can adopt it.
