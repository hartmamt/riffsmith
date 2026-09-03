// Share a song as a link with no server: the song JSON is deflated and
// base64url-encoded into the URL fragment (#s=…), so nothing leaves the
// browser until someone opens the link, and the fragment never reaches a
// server log. A typical 16-bar riff is ~1 KB encoded.
import { Song } from "./model";

const VERSION = "1";

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The shareable payload for a song (without its local id/timestamps). */
export async function encodeSongForShare(song: Song): Promise<string> {
  const { id: _id, updatedAt: _u, ...rest } = song; // eslint-disable-line @typescript-eslint/no-unused-vars
  const json = new TextEncoder().encode(JSON.stringify(rest));
  const packed = await deflate(json);
  return packed ? `${VERSION}d${toBase64Url(packed)}` : `${VERSION}p${toBase64Url(json)}`;
}

/** Full URL for the current origin. */
export async function shareUrlFor(song: Song, origin = typeof location !== "undefined" ? location.origin : "https://riffsmith.app"): Promise<string> {
  return `${origin}/#s=${await encodeSongForShare(song)}`;
}

/** Decode a shared payload back into a Song (fresh id). Throws on garbage. */
export async function decodeSharedSong(payload: string): Promise<Song> {
  if (payload[0] !== VERSION) throw new Error("unknown share version");
  const mode = payload[1];
  const bytes = fromBase64Url(payload.slice(2));
  const json = mode === "d" ? await inflate(bytes) : bytes;
  const parsed = JSON.parse(new TextDecoder().decode(json)) as Partial<Song>;
  if (!parsed || !Array.isArray(parsed.measures) || !Array.isArray(parsed.tuning) || typeof parsed.title !== "string") {
    throw new Error("not a RiffSmith song");
  }
  return {
    ...(parsed as Song),
    id: Math.random().toString(36).slice(2, 10),
    updatedAt: Date.now(),
  };
}

/** The share payload in the current URL fragment, if any. */
export function sharedPayloadFromLocation(): string | null {
  if (typeof location === "undefined") return null;
  const m = /(?:^#|&)s=([^&]+)/.exec(location.hash);
  return m ? m[1] : null;
}
