// Standard MIDI file (format 1) from a song: guitar, bass lane and drum lane
// as separate tracks, repeats expanded, bends and slides as pitch bend, palm
// mutes shorter, tremolo as repeated hits. Good enough to drop into a DAW.
import { Song, noteToMidi } from "./model";
import { NoteAction, advancePos, columnActions, slotDurOf, PlayPos } from "./schedule";
import { bassView } from "./model";
import { DRUM_ROWS } from "./drums";

const PPQ = 480;

function vlq(n: number): number[] {
  const out = [n & 0x7f]; n >>= 7;
  while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return out;
}
function str(s: string): number[] { return [...new TextEncoder().encode(s)]; }
function u32(n: number): number[] { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function u16(n: number): number[] { return [(n >>> 8) & 255, n & 255]; }

type Ev = { tick: number; bytes: number[]; order: number };

class TrackWriter {
  events: Ev[] = [];
  private n = 0;
  add(tick: number, bytes: number[]) { this.events.push({ tick: Math.max(0, Math.round(tick)), bytes, order: this.n++ }); }
  meta(tick: number, type: number, data: number[]) { this.add(tick, [0xff, type, ...vlq(data.length), ...data]); }
  bytes(): number[] {
    const evs = [...this.events].sort((a, b) => a.tick - b.tick || a.order - b.order);
    const out: number[] = []; let last = 0;
    for (const e of evs) { out.push(...vlq(e.tick - last), ...e.bytes); last = e.tick; }
    out.push(0, 0xff, 0x2f, 0); // end of track
    return [...str("MTrk"), ...u32(out.length), ...out];
  }
}

const PB_RANGE = 2; // semitones, the GM default
function pitchBend(cents: number): number[] {
  const v = Math.max(0, Math.min(16383, Math.round(8192 + (cents / (PB_RANGE * 100)) * 8191)));
  return [v & 0x7f, (v >> 7) & 0x7f];
}

/** Walk a song's playback order (repeats expanded) and emit note events for one lane. */
function writeLane(tw: TrackWriter, song: Song, channel: number, program: number, name: string) {
  tw.meta(0, 0x03, str(name));
  tw.add(0, [0xc0 | channel, program]);
  tw.add(0, [0xb0 | channel, 101, 0], ); tw.add(0, [0xb0 | channel, 100, 0]); tw.add(0, [0xb0 | channel, 6, PB_RANGE]); // pitch bend range
  const tuning = song.tuning.map((n) => noteToMidi(n) ?? 40);
  let pos: PlayPos = { m: 0, c: 0, taken: {}, done: false };
  let tick = 0;
  const ringing = new Map<number, { midi: number; offTick: number }>(); // per string
  const stopString = (si: number, at: number) => {
    const r = ringing.get(si); if (!r) return;
    tw.add(Math.min(r.offTick, at), [0x80 | channel, r.midi, 64]); ringing.delete(si);
  };
  const flush = (at: number) => { for (const [si, r] of ringing) if (r.offTick <= at) { tw.add(r.offTick, [0x80 | channel, r.midi, 64]); ringing.delete(si); } };
  for (let guard = 0; guard < 200000 && !pos.done; guard++) {
    const slotTicks = Math.round((slotDurOf(song, pos.m) / (60 / song.bpm)) * PPQ);
    flush(tick);
    const acts: NoteAction[] = columnActions(song, pos.m, pos.c);
    for (const a of acts) {
      const vel = Math.round(60 + 67 * a.velocity);
      const on = (midi: number, len: number, v = vel) => { stopString(a.si, tick); tw.add(tick, [0x90 | channel, midi, v]); ringing.set(a.si, { midi, offTick: tick + len }); };
      switch (a.kind) {
        case "pick": on(a.midi, Math.max(slotTicks, PPQ * 2 + Math.round(a.sustain * (song.bpm / 60) * PPQ))); break;
        case "pinch": on(a.midi + 24, PPQ * 2, 100); break;
        case "palm": on(a.midi, Math.round(slotTicks * 0.8), Math.min(127, vel)); break;
        case "dead": on(tuning[a.si], Math.round(slotTicks * 0.5), 70); break;
        case "repick": on(a.midi, slotTicks, Math.round(vel * 0.9)); break;
        case "hammer": case "pull": case "tap": on(a.midi, PPQ * 2, Math.round(vel * 0.75)); break;
        case "slide": {
          // glide with pitch bend from the origin over the slide, then land on a fresh note
          const from = a.fromMidi ?? a.midi; const cents = (a.midi - from) * 100;
          const r = ringing.get(a.si);
          if (r && Math.abs(cents) <= PB_RANGE * 100) {
            const steps = 8; const dur = Math.round(slotTicks * 0.9);
            for (let k = 1; k <= steps; k++) tw.add(tick + (dur * k) / steps, [0xe0 | channel, ...pitchBend((cents * k) / steps)]);
            tw.add(tick + dur + 1, [0xe0 | channel, ...pitchBend(0)]);
          }
          on(a.midi, PPQ * 2);
          break;
        }
        case "bend": case "release": {
          const target = a.kind === "bend" ? 200 : 0; const steps = 8; const dur = Math.round(slotTicks * 0.9);
          for (let k = 1; k <= steps; k++) tw.add(tick + (dur * k) / steps, [0xe0 | channel, ...pitchBend(target === 0 ? 200 - (200 * k) / steps : (200 * k) / steps)]);
          const r = ringing.get(a.si); if (r) r.offTick = Math.max(r.offTick, tick + PPQ * 2);
          break;
        }
      }
    }
    tick += slotTicks;
    pos = advancePos(song, pos, 0, Infinity, false);
  }
  for (const [, r] of ringing) tw.add(r.offTick, [0x80 | channel, r.midi, 64]);
  return tick;
}

const DRUM_MIDI: Record<(typeof DRUM_ROWS)[number], number> = { crash: 49, hat: 42, snare: 38, kick: 36 };

export function songToMidi(song: Song): Uint8Array {
  const tracks: TrackWriter[] = [];
  // tempo / meta track
  const meta = new TrackWriter();
  meta.meta(0, 0x03, str(song.title));
  meta.meta(0, 0x51, [(Math.round(60000000 / song.bpm) >> 16) & 255, (Math.round(60000000 / song.bpm) >> 8) & 255, Math.round(60000000 / song.bpm) & 255]);
  tracks.push(meta);
  const g = new TrackWriter(); writeLane(g, song, 0, 30, "Guitar"); tracks.push(g); // 30 = Distortion Guitar
  const bv = bassView(song);
  if (bv) { const b = new TrackWriter(); writeLane(b, bv, 1, 33, "Bass"); tracks.push(b); } // 33 = Electric Bass (finger)
  if (song.drums) {
    const d = new TrackWriter(); d.meta(0, 0x03, str("Drums"));
    let pos: PlayPos = { m: 0, c: 0, taken: {}, done: false }; let tick = 0;
    for (let guard = 0; guard < 200000 && !pos.done; guard++) {
      const slotTicks = Math.round((slotDurOf(song, pos.m) / (60 / song.bpm)) * PPQ);
      const col = song.measures[pos.m].drums?.[pos.c];
      if (col) DRUM_ROWS.forEach((row, r) => {
        const tok = col[r]; if (!tok) return;
        const midi = row === "hat" && tok === "o" ? 46 : DRUM_MIDI[row];
        const vel = tok === "X" ? 120 : 96;
        d.add(tick, [0x99, midi, vel]); d.add(tick + Math.round(slotTicks * 0.5), [0x89, midi, 64]);
      });
      tick += slotTicks;
      pos = advancePos(song, pos, 0, Infinity, false);
    }
    tracks.push(d);
  }
  const header = [...str("MThd"), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(PPQ)];
  const body = tracks.flatMap((t) => t.bytes());
  return new Uint8Array([...header, ...body]);
}
