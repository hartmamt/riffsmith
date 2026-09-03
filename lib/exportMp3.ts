// Export what you hear: record the rig's output while the song plays once
// (real time, exactly the audio path the listener gets, NAM included), then
// encode the recording to MP3 in the browser with lamejs (@breezystack fork).
import type { GuitarSampler } from "./sampler";

export type Mp3Progress = { phase: "recording" | "encoding" | "done"; seconds?: number };


/** Start recording the sampler's output. Returns a stop() that resolves to the decoded audio. */
export function startRecording(sampler: GuitarSampler): { stop: () => Promise<AudioBuffer> } {
  const ctx = sampler.ctx;
  const tap = sampler.tapOutput();
  const rec = new MediaRecorder(tap.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 256000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.start(250);
  return {
    stop: () =>
      new Promise<AudioBuffer>((resolve, reject) => {
        rec.onstop = async () => {
          try {
            tap.stream.getTracks().forEach((t) => t.stop());
            const blob = new Blob(chunks, { type: "audio/webm" });
            const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
            resolve(decoded);
          } catch (e) { reject(e); }
        };
        rec.stop();
      }),
  };
}

/** Trim leading/trailing near-silence and encode to MP3 (stereo, 192 kbps). */
export async function encodeMp3(buffer: AudioBuffer, onProgress?: (p: Mp3Progress) => void): Promise<Blob> {
  const { Mp3Encoder } = await import("@breezystack/lamejs"); // ESM-friendly lamejs fork (the original throws "MPEGMode is not defined" under bundlers)
  const sr = buffer.sampleRate;
  const l = buffer.getChannelData(0);
  const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l;
  // trim: first/last sample above -60 dBFS, with a little air either side
  const thr = 0.001;
  let a = 0; while (a < l.length && Math.abs(l[a]) < thr && Math.abs(r[a]) < thr) a++;
  let b = l.length - 1; while (b > a && Math.abs(l[b]) < thr && Math.abs(r[b]) < thr) b--;
  a = Math.max(0, a - Math.floor(sr * 0.05)); b = Math.min(l.length, b + Math.floor(sr * 0.8));
  // peak-normalise to -1 dBFS so exports sit at a sane level
  let pk = 0; for (let i = a; i < b; i++) pk = Math.max(pk, Math.abs(l[i]), Math.abs(r[i]));
  const g = pk > 0 ? Math.min(4, 0.891 / pk) : 1;
  const enc = new Mp3Encoder(2, sr, 192);
  const parts: Uint8Array[] = [];
  const block = 1152;
  const li = new Int16Array(block), ri = new Int16Array(block);
  for (let i = a; i < b; i += block) {
    const n = Math.min(block, b - i);
    for (let k = 0; k < n; k++) {
      li[k] = Math.max(-32768, Math.min(32767, Math.round(l[i + k] * g * 32767)));
      ri[k] = Math.max(-32768, Math.min(32767, Math.round(r[i + k] * g * 32767)));
    }
    const out = enc.encodeBuffer(n === block ? li : li.subarray(0, n), n === block ? ri : ri.subarray(0, n));
    if (out.length) parts.push(out);
    if (onProgress && (i - a) % (block * 200) === 0) onProgress({ phase: "encoding", seconds: (i - a) / sr });
  }
  const tail = enc.flush();
  if (tail.length) parts.push(tail);
  onProgress?.({ phase: "done" });
  return new Blob(parts as BlobPart[], { type: "audio/mpeg" });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
