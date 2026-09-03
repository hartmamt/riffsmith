# LinkedIn post (for sharing https://devpost.com/software/riff-smith)

I play guitar in a metal band (Subsist, Drop B tuning). When I started thinking about AI-assisted tab writing, every demo I saw was a chat window sitting next to the editor, describing what the agent *wanted* to do.

RiffSmith is different: every feature in the editor is a WebMCP tool. An agent can open the page and actually use it. Create a song, write a four-bar riff in one call, change the time signature, dial in the amp, hit play, and read the tab back to check its own work. Fifteen tools. No screenshots of a grid.

Every write returns the resulting tab so the agent can verify what it produced. I tested with Codex running in its own browser; we were both editing the same song at the same time.

Playback runs through a sampled guitar engine (real DI recordings, open licenses) into a Neural Amp Modeler capture running as WebAssembly in an AudioWorklet. The amp captures are ones I trained on my own rig. Palm mutes, pinch harmonics, bends, tremolo picking, all in the notation. Built in a few days, mostly pair-programming with Claude Code. No backend, no accounts.

Open source (MIT) at github.com/hartmamt/riffsmith. Live at riffsmith.app. Press play when you get there; it opens on In the Hall of the Mountain King.

Devpost submission: https://devpost.com/software/riff-smith

#WebMCP #WebAudio #OpenAI
