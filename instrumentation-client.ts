// Client-side PostHog initialisation (Next.js 15.3+ runs this once per page
// load, before hydration). Analytics is optional: with no key the app runs
// exactly as before, and in development we say so loudly instead of
// dropping events on the floor.
import posthog from "posthog-js";

const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

if (key) {
  posthog.init(key, {
    api_host: "/ingest", // reverse-proxied in next.config.ts
    ui_host: host.includes("eu.") ? "https://eu.posthog.com" : "https://us.posthog.com",
    defaults: "2026-01-30",
    capture_exceptions: true, // error tracking
    debug: process.env.NODE_ENV === "development",
  });
} else if (process.env.NODE_ENV === "development") {
  console.error(
    "NEXT_PUBLIC_POSTHOG_KEY variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once NEXT_PUBLIC_POSTHOG_KEY is configured"
  );
}
