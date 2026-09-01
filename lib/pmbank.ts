// Custom palm-mute sample bank: user-recorded DI hits imported as WAV files,
// persisted in IndexedDB. Filename convention (case-insensitive):
//   <note><octave>_v<velocity>_rr<n>.wav     e.g.  b1_v3_rr1.wav
// Recommended capture: mono 24-bit/48kHz DI, no amp/effects, peaks ~-12dBFS,
// pick transient preserved, ~300-500ms per hit. Record at least v1-v3 and
// rr1-rr4 per root; a native b1 root removes all pitch shifting in Drop B.

import { noteToMidi } from "./model";

export type PmSample = { midi: number; vel: number; rr: number; bytes: ArrayBuffer };

const DB = "guitarscrobble.pmbank";
const STORE = "samples";
const KV = "kv"; // small persistent blobs (e.g. the loaded .nam amp model)

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(KV, "readwrite");
    tx.objectStore(KV).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  const out = await new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(KV, "readonly");
    const req = tx.objectStore(KV).get(key);
    req.onsuccess = () => resolve(req.result ? (req.result.value as T) : null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return out;
}

export async function kvDelete(key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(KV, "readwrite");
    tx.objectStore(KV).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export function parsePmFilename(name: string): { midi: number; vel: number; rr: number } | null {
  const m = name.toLowerCase().match(/^([a-g][#b]?\d)_v(\d)_rr(\d+)\.(wav|aif|aiff|flac)$/);
  if (!m) return null;
  const note = m[1][0].toUpperCase() + m[1].slice(1);
  const midi = noteToMidi(note);
  if (midi === null) return null;
  return { midi, vel: parseInt(m[2], 10), rr: parseInt(m[3], 10) };
}

export async function savePmSamples(samples: PmSample[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    for (const s of samples) {
      tx.objectStore(STORE).put({ key: `pm${s.midi}_v${s.vel}_rr${s.rr}`, ...s });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadPmSamples(): Promise<PmSample[]> {
  const db = await openDb();
  const out = await new Promise<PmSample[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as PmSample[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return out;
}

export async function clearPmBank(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
