// Thin wrapper over posthog-js so the rest of the app never has to check
// whether analytics is configured. Events are the product's analytics
// contract; reuse these names rather than inventing variants.
//
//   webmcp_tool_called   { tool, ok, ms, source: "native" | "shim" }
//   song_played          { sound, engine, nam_model, bass_rig, bars, tuning, loop }
//   ascii_imported       { bars, systems, strings, warnings }
//   nam_model_selected   { model }  (null = built-in amp)
//   audition_song_opened { title }
import posthog from "posthog-js";

export function track(event: string, properties: Record<string, unknown> = {}) {
  try {
    if (typeof window === "undefined" || !posthog.__loaded) return;
    posthog.capture(event, properties);
  } catch {
    // analytics must never take the app down
  }
}
