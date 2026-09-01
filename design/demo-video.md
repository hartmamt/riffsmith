# Demo video — script, shot list, captions

Target length: **2:15** (judges skim; every second earns its place). Record at
1920×1080, browser at 1440 wide with the rig column open. Dark room lighting
if you're on camera at all — you don't need to be. Screen + voice is enough.

Two recordings, then a cut:
1. **Screen A** — the app in a normal browser (rig, playback, import).
2. **Screen B** — the app inside a WebMCP-capable browser with an agent
   driving it (ChatGPT's browser / the tools panel). This is the money shot.

Have the amp model already loaded and the rig set (Metal GTX bank, grip ~0.7,
tight ~0.5, all-down picking) before recording. Keep loop ON.

---

## Cold open (0:00–0:12) — no narration yet

Shot: In the Hall of the Mountain King (the built-in song) already looping in the app, rig column visible, amber
playhead sweeping. Two bars, then cut hard on a downbeat to black.

Caption (large, on black): **"Every control on this page is a tool."**

## 1 · The problem (0:12–0:30)

Shot: sidebar → paste a messy hand-written ASCII tab (use the band's own
tab or any riff with `0000` chug runs and `[Riff A]` headers — not a
copyrighted song). Hit import.
Sections appear, signatures resolve, tuning is derived from the string
letters. Press ▶ on a section.

VO: *"Every guitarist has a folder of half-finished riffs in text files.
RiffSmith makes them playable — paste any tab, it figures out the tuning,
the sections, the time signatures, and plays it back through a real amp
model. But the part we built for this challenge is what happens when an
agent sits down at the same desk."*

## 2 · Agent writes a riff (0:30–1:05)  ← Screen B

Shot: the agent's chat on one side, the app on the other. Type a prompt and
let the tools fire. Keep the app visible so bars appear as the agent works.

Prompt to type (say it out loud too):
> "Make a new song in Drop B at 160 BPM and tab the first phrase of
> In the Hall of the Mountain King on the low B string: 8th notes,
> palm-muted, four bars. Name the section THEME, repeat it twice, and play it."

What judges should see happen, in order:
- `create_song` → a new song appears in the sidebar
- `update_bar` → THEME label appears on bar 1
- one `write_notes` batch → notes land in every bar at once
- `update_bar` sets `‖:` / `:‖ ×2` repeat marks around the four bars
- `play` → playhead runs through the repeat, audio plays

VO (while it works): *"Fifteen tools. Not a chat window next to the app —
the app itself: songs, bars, time signatures, notation, repeats, playback.
Every write comes back with the tab it produced so the agent can check its
own work, and every edit lands live — I can grab any note it wrote and
change it."*

Do that: click a cell the agent wrote, type a different fret while it loops.
The change is audible on the next pass.

## 3 · Agent dials the amp (1:05–1:30)  ← Screen B

Prompt:
> "That's too loose. Make it tighter and heavier — all downstrokes, more
> mute pressure, and double-track it."

Shot: rig column visible. `get_rig` / `set_rig` fire; the sliders and the
picking control MOVE on screen. Sound audibly changes on the next loop.

VO: *"The rig is a tool too. Tightness, mute pressure, picking direction,
double-tracking — an agent can read the whole amp and set it, and the panel
follows. The amp is real: Neural Amp Modeler inference running in an
AudioWorklet, on a capture of a 5150."*

## 4 · Import + verify loop (1:30–1:50)  ← Screen B

Prompt:
> "Import this tab and tell me what's in it."  (paste a tab)

Shot: `import_ascii_tab` returns sections + warnings; agent reads them back.
Then: *"Change the intro to 3/4 and add a natural harmonic fill at the end."*
→ `update_bar` + `write_notes`, then `get_song` to verify.

VO: *"Imports report exactly what they kept and what they had to adapt, so
the agent never guesses. Reads are cheap, writes are atomic, and they're
serialized — an agent can fire ten edits and the tab is always consistent."*

## 5 · Close (1:50–2:15)

Shot: pull back to the full app, riff looping, then the title card.

VO: *"It's a tab editor a band can actually write with — and the first one
where the AI in the room can pick up the guitar. Built on WebMCP; everything
you can click, an agent can call."*

Title card: **RiffSmith** · guitarscrobble.vercel.app · "Anything a human can do."
Small print: WebMCP · Next.js · Web Audio · Neural Amp Modeler

---

## Recording checklist

- [ ] Browser zoom 100%, window 1440×900, rig open, sidebar visible
- [ ] Amp model loaded, cab OFF (full-rig capture), volume ~1.1
- [ ] Mountain King (built-in) or your own riff ready and looping for the cold open
- [ ] A messy ASCII tab in your clipboard for scene 1 and 4
- [ ] WebMCP browser signed in; tools visible under "Site tools" BEFORE you hit record
- [ ] Mic check — narration can be recorded separately and laid over
- [ ] Export 1080p, upload unlisted to YouTube, paste link in Devpost

## Screenshots for the Devpost gallery (I'll capture these)

1. Full app with rig column, riff mid-playback (hero)
2. Agent tools list — the 15 tools with descriptions
3. ASCII import modal with a real tab + warnings panel
4. The rig column close-up (amp head / chugs / performance)
5. Exported ASCII tab next to the grid
