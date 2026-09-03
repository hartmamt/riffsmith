import type { NextConfig } from "next";

// PostHog ingestion goes through this origin (/ingest) so ad blockers don't
// drop it. The upstream follows NEXT_PUBLIC_POSTHOG_HOST (US or EU cloud).
const phHost = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";
const phAssets = phHost.includes("eu.") ? "https://eu-assets.i.posthog.com" : "https://us-assets.i.posthog.com";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/ingest/static/:path*", destination: `${phAssets}/static/:path*` },
      { source: "/ingest/array/:path*", destination: `${phAssets}/array/:path*` },
      { source: "/ingest/:path*", destination: `${phHost}/:path*` },
    ];
  },
  // required for PostHog's trailing-slash API requests
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
