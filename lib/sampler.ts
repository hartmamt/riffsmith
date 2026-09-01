// Sampled guitar engine with persistent per-string voices.
//
// Sources (all explicitly licensed, see public/samples/*):
// - Sustained notes: Emilyguitar (Karoryfer, CC0) — DI electric, f dynamic,
//   3 round robins, roots every 3 semitones Db2..D6.
// - Pitched palm mutes: Pastabass "tagliatelle" (Karoryfer, royalty-free incl.
//   redistribution) — Squier Bass VI, flatwound, picked+muted. 2 velocity
//   layers × 3 round robins, known roots MIDI 37..67 every 3 semitones.
// - Dead chugs ("x"): Emilyguitar "muted1–5" noises. AUDIT NOTE: the source
//   library maps these as unpitched string-muting noises at fixed keys
//   (91–95), NOT palm mutes — so they are used here only for unpitched dead
//   hits, never for pitched mutes.
//
// Pitch is done exclusively with AudioBufferSourceNode.detune (rate stays 1),
// so hammer-ons, pulls, slides, bends, releases and vibrato are continuous
// automation on the SAME voice — no retrigger, one pick transient per phrase.
// FALLBACK: a legato/bend/slide action with no ringing voice on that string
// starts a new pickless note (sample started past its pick transient).

const NOTE_ROOTS = [37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84, 86];
const PM_ROOTS = [37, 40, 43, 46, 49, 52, 55, 58, 61, 64, 67];
const MUTE_IDS = [1, 2, 3, 4, 5]; // unpitched dead hits, high → low register
const BASE = "/samples";

type Articulation = "open" | "palm" | "dead";

type StringVoice = {
  src: AudioBufferSourceNode;
  env: GainNode;               // per-voice envelope
  sampleMidi: number;          // root of the playing sample
  currentMidi: number;         // pitch the voice is at (before bend offset)
  bendCents: number;           // current bend offset in cents
  articulation: Articulation;
  vibrato: { lfo: OscillatorNode; depth: GainNode } | null;
  releaseAt: number;           // when the envelope reaches silence
  level: number;               // body level, for tremolo re-excitation
  startedAt: number;           // source start time — body freshness tracking
};

export class GuitarSampler {
  private ctx: AudioContext;
  private buffers = new Map<string, AudioBuffer>();
  private loading: Promise<void> | null = null;
  private ampIn: GainNode | null = null;
  private diBus: GainNode | null = null;
  private drive: GainNode | null = null;
  private cab: ConvolverNode | null = null;
  private post: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private namNode: AudioWorkletNode | null = null;
  private namMakeup: GainNode | null = null;
  private cabBypass = true; // most shared captures are full rigs (amp + cab)
  private level = 1;
  private noiseBuf: AudioBuffer | null = null; // fret-impact transients
  private voices = new Map<number, StringVoice>();
  private rr = new Map<string, number>();      // round-robin counters
  private pickStroke: "d" | "u" | null = null; // stroke of the pick in flight
  diMode = false; // clean DI monitoring (skips amp + NAM)
  namModelName: string | null = null;

  // ---- palm-mute character & performance controls ----
  muteStrength = 0.5;                 // 0 loose … 1 tight; 0.5 = raw DI, no damping
  pickingMode: "alternate" | "down" | "up" = "alternate";
  private pickDirDown = true;         // GLOBAL per performance, not per string
  doubleTrack = false;                // twin take panned L/R (built-in amp only)
  private tightAmt = 0.35;            // pre-distortion low-cut / mid emphasis
  private tighten: BiquadFilterNode | null = null;
  private midEmph: BiquadFilterNode | null = null;
  private driveNode: GainNode | null = null;
  private busL: GainNode | null = null; // double-track chains
  private busR: GainNode | null = null;
  private twinFlip = false;
  // custom user-recorded PM bank (IndexedDB-imported); overrides Pastabass
  private pmCustomRoots: number[] = [];
  private pmCustomVels = new Map<number, number[]>(); // root → sorted vels
  private pmCustomRrs = new Map<string, number>();    // root_vel_stroke → rr count
  private repickTails = new Map<number, StringVoice[]>(); // overlapping tremolo strokes

  // one picking hand: direction alternates across the whole performance
  resetPickDirection() {
    this.pickDirDown = true;
  }

  private nextStroke(advance: boolean): "d" | "u" {
    if (this.pickingMode === "down") return "d";
    if (this.pickingMode === "up") return "u";
    const s: "d" | "u" = this.pickDirDown ? "d" : "u";
    if (advance) this.pickDirDown = !this.pickDirDown;
    return s;
  }

  // stroke character beyond gain: downstrokes fuller low mids, upstrokes
  // thinner/brighter attack (used when the bank has no real stroke samples)
  private strokeColor(stroke: "d" | "u"): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    if (stroke === "d") {
      f.type = "lowshelf";
      f.frequency.value = 280;
      f.gain.value = 2.5;
    } else {
      f.type = "highshelf";
      f.frequency.value = 1600;
      f.gain.value = 3.5;
    }
    return f;
  }

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  ready(): Promise<void> {
    if (!this.loading) {
      const urls: [string, string][] = [];
      for (const m of NOTE_ROOTS) {
        urls.push([`n${m}_rr1`, `${BASE}/emily/n${m}.wav`]);
        urls.push([`n${m}_rr2`, `${BASE}/emily/n${m}_rr2.wav`]);
        urls.push([`n${m}_rr3`, `${BASE}/emily/n${m}_rr3.wav`]);
      }
      for (const i of MUTE_IDS) {
        urls.push([`m${i}_rr1`, `${BASE}/emily/m${i}.wav`]);
        urls.push([`m${i}_rr2`, `${BASE}/emily/m${i}_rr2.wav`]);
        urls.push([`m${i}_rr3`, `${BASE}/emily/m${i}_rr3.wav`]);
      }
      for (const m of PM_ROOTS) {
        for (const v of [2, 3]) {
          for (const r of [1, 2, 3]) {
            urls.push([`pm${m}_v${v}_rr${r}`, `${BASE}/pm/pm${m}_v${v}_rr${r}.wav`]);
          }
        }
      }
      this.loading = Promise.all(
        urls.map(async ([key, url]) => {
          const res = await fetch(url);
          if (!res.ok) return; // tolerate missing files
          const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
          this.buffers.set(key, buf);
        })
      ).then(() => this.buildAmp());
    }
    return this.loading;
  }

  get loaded(): boolean {
    return this.ampIn !== null;
  }

  // ---- output chains --------------------------------------------------------

  // One full distortion chain. `pan` builds a hard-panned satellite chain for
  // double tracking (its own drive/cab/comp so takes stay truly separate).
  private async makeChain(pan?: number): Promise<{
    input: GainNode; tighten: BiquadFilterNode; midEmph: BiquadFilterNode;
    drive: GainNode; cab: ConvolverNode; post: GainNode; comp: DynamicsCompressorNode;
  }> {
    const ctx = this.ctx;
    const input = ctx.createGain();
    input.gain.value = 1;

    const tighten = ctx.createBiquadFilter();
    tighten.type = "highpass";
    tighten.Q.value = 0.7;

    const midEmph = ctx.createBiquadFilter();
    midEmph.type = "peaking";
    midEmph.frequency.value = 900;
    midEmph.Q.value = 0.8;

    const drive = ctx.createGain();

    const shaper = ctx.createWaveShaper();
    const N = 2048;
    const curve = new Float32Array(N);
    const k = 5;
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * (x + 0.04)) / Math.tanh(k);
    }
    shaper.curve = curve;
    shaper.oversample = "4x";

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 75;

    const scoop = ctx.createBiquadFilter();
    scoop.type = "peaking";
    scoop.frequency.value = 550;
    scoop.Q.value = 0.9;
    scoop.gain.value = -6;

    const presence = ctx.createBiquadFilter();
    presence.type = "peaking";
    presence.frequency.value = 3000;
    presence.Q.value = 0.8;
    presence.gain.value = 2.5;

    const cab = ctx.createConvolver();
    cab.buffer = await this.makeCabIR();

    const post = ctx.createGain();
    post.gain.value = 0.65 * this.level;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;

    input.connect(tighten).connect(midEmph).connect(drive).connect(shaper).connect(hp).connect(scoop)
      .connect(presence).connect(cab).connect(post).connect(comp);
    if (pan !== undefined) {
      const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (panner) {
        panner.pan.value = pan;
        comp.connect(panner).connect(ctx.destination);
      } else {
        comp.connect(ctx.destination);
      }
    } else {
      comp.connect(ctx.destination);
    }
    return { input, tighten, midEmph, drive, cab, post, comp };
  }

  private async buildAmp(): Promise<void> {
    const ctx = this.ctx;
    const chain = await this.makeChain();
    this.tighten = chain.tighten;
    this.midEmph = chain.midEmph;
    this.driveNode = chain.drive;
    this.applyTight();

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    chain.comp.connect(analyser); // metering tap
    this.analyser = analyser;

    // raw sample audition: NOTHING in the path — no drive, cab, EQ, or
    // compression. The unprocessed DI must already sound right on its own.
    const diBus = ctx.createGain();
    diBus.gain.value = 0.5;
    diBus.connect(ctx.destination);
    diBus.connect(analyser);

    // shared fret-impact noise (30ms)
    const nb = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.03), ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) {
      nd[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.005));
    }
    this.noiseBuf = nb;

    this.ampIn = chain.input;
    this.diBus = diBus;
    this.drive = chain.tighten;
    this.cab = chain.cab;
    this.post = chain.post;
  }

  // hard-panned L/R chains for double tracking, built on first use
  private async ensureDoubleBuses(): Promise<void> {
    if (this.busL && this.busR) return;
    const l = await this.makeChain(-0.8);
    const r = await this.makeChain(0.8);
    const t = this.tightAmt;
    for (const c of [l, r]) {
      c.tighten.frequency.value = 55 + 85 * t;
      c.midEmph.gain.value = 4 * t;
      c.drive.gain.value = 7 - 2.5 * t;
    }
    this.busL = l.input;
    this.busR = r.input;
  }

  setDoubleTrack(on: boolean) {
    this.doubleTrack = on;
    if (on) void this.ensureDoubleBuses();
  }

  private dest(): AudioNode {
    return (this.diMode ? this.diBus : this.ampIn)!;
  }

  setLevel(x: number) {
    this.level = Math.max(0, Math.min(2, x));
    if (this.post) this.post.gain.value = 0.65 * this.level;
  }

  // 0 = loose/vintage, 1 = surgically tight: HPF 55→140Hz, +0→4dB @900Hz,
  // input gain 7→4.5 (moderate distortion, not max saturation)
  setTight(x: number) {
    this.tightAmt = Math.max(0, Math.min(1, x));
    this.applyTight();
  }

  get tight(): number {
    return this.tightAmt;
  }

  private applyTight() {
    const t = this.tightAmt;
    if (this.tighten) this.tighten.frequency.value = 55 + 85 * t;
    if (this.midEmph) this.midEmph.gain.value = 4 * t;
    if (this.driveNode) this.driveNode.gain.value = 7 - 2.5 * t;
  }

  // decoded custom PM bank (user DI recordings or local-eval sets); entries
  // may carry a stroke tag ("d"/"u") when the bank has real stroke samples
  async loadCustomPm(samples: { midi: number; vel: number; rr: number; bytes: ArrayBuffer; stroke?: "d" | "u" }[]): Promise<number> {
    let loaded = 0;
    this.clearCustomPm();
    for (const s of samples) {
      try {
        const buf = await this.ctx.decodeAudioData(s.bytes.slice(0));
        const stroke = s.stroke ?? "d";
        // stroke-local rr index: count entries already registered for this slot
        const key = `${s.midi}_${s.vel}_${stroke}`;
        const rrIdx = (this.pmCustomRrs.get(key) ?? 0) + 1;
        this.buffers.set(`pmC${s.midi}_v${s.vel}_rr${rrIdx}${stroke}`, buf);
        this.pmCustomRrs.set(key, rrIdx);
        if (!this.pmCustomRoots.includes(s.midi)) this.pmCustomRoots.push(s.midi);
        const vels = this.pmCustomVels.get(s.midi) ?? [];
        if (!vels.includes(s.vel)) this.pmCustomVels.set(s.midi, [...vels, s.vel].sort((a, b) => a - b));
        loaded++;
      } catch {}
    }
    this.pmCustomRoots.sort((a, b) => a - b);
    return loaded;
  }

  get customPmInfo(): { roots: number[]; count: number } {
    let count = 0;
    for (const [, n] of this.pmCustomRrs) count += n;
    return { roots: this.pmCustomRoots, count };
  }

  clearCustomPm() {
    for (const key of [...this.buffers.keys()]) {
      if (key.startsWith("pmC")) this.buffers.delete(key);
    }
    this.pmCustomRoots = [];
    this.pmCustomVels.clear();
    this.pmCustomRrs.clear();
  }

  // load a PM bank from served URLs (e.g. the local-eval Metal GTX set)
  async loadPmFromUrls(files: { midi: number; vel: number; rr: number; url: string; stroke?: "d" | "u" }[]): Promise<number> {
    const withBytes = await Promise.all(
      files.map(async (f) => {
        const res = await fetch(f.url);
        if (!res.ok) return null;
        return { midi: f.midi, vel: f.vel, rr: f.rr, stroke: f.stroke, bytes: await res.arrayBuffer() };
      })
    );
    return this.loadCustomPm(withBytes.filter((x): x is NonNullable<typeof x> => x !== null));
  }

  setCabBypass(bypass: boolean) {
    this.cabBypass = bypass;
    if (this.namModelName) this.routeNam(true);
  }

  get cabBypassed(): boolean {
    return this.cabBypass;
  }

  meterRms(): number {
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  private async makeCabIR(): Promise<AudioBuffer> {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * 0.09);
    const off = new OfflineAudioContext(1, len, sr);
    const noise = off.createBuffer(1, len, sr);
    const data = noise.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      data[i] = (Math.random() * 2 - 1) * Math.exp(-t / 0.014) * (i < 8 ? i / 8 : 1);
    }
    const src = off.createBufferSource();
    src.buffer = noise;
    const lp = off.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 5200;
    lp.Q.value = 0.6;
    const hp = off.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 95;
    const thump = off.createBiquadFilter();
    thump.type = "peaking";
    thump.frequency.value = 130;
    thump.gain.value = 4;
    src.connect(lp).connect(hp).connect(thump).connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    const ch = rendered.getChannelData(0);
    let energy = 0;
    for (let i = 0; i < ch.length; i++) energy += ch[i] * ch[i];
    const norm = 1 / Math.sqrt(energy || 1);
    for (let i = 0; i < ch.length; i++) ch[i] *= norm;
    return rendered;
  }

  // ---- voice helpers --------------------------------------------------------

  private nextRr(key: string, count: number): number {
    const n = (this.rr.get(key) ?? -1) + 1;
    this.rr.set(key, n);
    return (n % count) + 1;
  }

  private nearest(list: number[], midi: number): number {
    let best = list[0];
    for (const m of list) if (Math.abs(m - midi) < Math.abs(best - midi)) best = m;
    return best;
  }

  private fadeVoice(v: StringVoice, when: number, fadeS: number) {
    try {
      v.env.gain.cancelScheduledValues(when);
      v.env.gain.setValueAtTime(Math.max(0.0001, v.env.gain.value), when);
      v.env.gain.exponentialRampToValueAtTime(0.0001, when + fadeS);
      v.src.stop(when + fadeS * 2);
      if (v.vibrato) { v.vibrato.lfo.stop(when + fadeS * 2); }
    } catch {}
  }

  private stopVoice(si: number, when: number, fast = true) {
    // a new articulation on the string chokes the sustaining voice AND the
    // tremolo tail pool
    const tails = this.repickTails.get(si);
    if (tails) {
      for (const t of tails) this.fadeVoice(t, when, 0.02);
      this.repickTails.delete(si);
    }
    const v = this.voices.get(si);
    if (!v) return;
    this.fadeVoice(v, when, fast ? 0.025 : 0.08);
    this.voices.delete(si);
  }

  allNotesOff() {
    const now = this.ctx.currentTime;
    for (const k of [...this.voices.keys()]) this.stopVoice(k, now);
  }

  // short filtered noise blip — the fret/finger impact of legato techniques
  private fretImpact(when: number, level: number) {
    if (!this.noiseBuf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2600;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.value = level;
    src.connect(bp).connect(g).connect(this.dest());
    src.start(when);
  }

  private attachVibrato(v: StringVoice, when: number) {
    if (v.vibrato) return;
    const ctx = this.ctx;
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 5.5;
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(0, when);
    depth.gain.linearRampToValueAtTime(35, when + 0.15); // cents, fast onset
    lfo.connect(depth).connect(v.src.detune);
    lfo.start(when);
    lfo.stop(v.releaseAt + 0.2);
    v.vibrato = { lfo, depth };
  }

  private scheduleEnvelope(v: StringVoice, when: number, ringSeconds: number, level: number, attack: number) {
    v.level = level;
    const g = v.env.gain;
    g.cancelScheduledValues(when);
    g.setValueAtTime(Math.max(0.0001, attack === 0 ? level : 0.0001), when);
    if (attack > 0) g.exponentialRampToValueAtTime(level, when + attack);
    g.setValueAtTime(level, when + ringSeconds * 0.7);
    g.exponentialRampToValueAtTime(0.0001, when + ringSeconds);
    v.releaseAt = when + ringSeconds;
  }

  // ---- articulations --------------------------------------------------------

  // pick a palm-mute buffer: custom user bank first, else Pastabass, with
  // velocity layers and round robins. Returns the buffer and its SOUNDING root.
  // NOTE: the Pastabass Bass VI is notated an octave up (bass convention) —
  // its "MIDI 37" file sounds Db1 (measured 34.6Hz), so the sounding root is
  // label − 12. Chugs therefore shift UP into guitar register, which also
  // shortens and sharpens the transient. Custom banks are named by sounding
  // pitch and need no correction.
  private pickPmBuffer(midi: number, velocity: number): { buffer: AudioBuffer | undefined; root: number } {
    // never pitch-shift a chug more than one semitone: if the custom bank's
    // nearest root is farther than that, fall back to the built-in bank
    // (whose 3-semitone spacing keeps every note within ±1)
    if (this.pmCustomRoots.length && Math.abs(this.nearest(this.pmCustomRoots, midi) - midi) <= 1) {
      const root = this.nearest(this.pmCustomRoots, midi);
      const vels = this.pmCustomVels.get(root) ?? [1];
      // accents live in 0.72–1.0, so map that band across the recorded
      // layers — a flat floor(velocity*len) would never pick the soft layer
      const t = Math.max(0, Math.min(0.999, (velocity - 0.55) / 0.45));
      const vel = vels[Math.floor(t * vels.length)] ?? vels[vels.length - 1];
      // real stroke samples first; fall back to the other stroke's takes
      const wanted = this.pickStroke ?? "d";
      const other: "d" | "u" = wanted === "d" ? "u" : "d";
      const stroke = (this.pmCustomRrs.get(`${root}_${vel}_${wanted}`) ?? 0) > 0 ? wanted : other;
      const rrCount = this.pmCustomRrs.get(`${root}_${vel}_${stroke}`) ?? 1;
      const rr = this.nextRr(`pmC${root}_${vel}_${stroke}`, rrCount);
      return { buffer: this.buffers.get(`pmC${root}_v${vel}_rr${rr}${stroke}`), root };
    }
    const SOUNDING_OFFSET = -12;
    const soundingRoots = PM_ROOTS.map((r) => r + SOUNDING_OFFSET);
    const sounding = this.nearest(soundingRoots, midi);
    const label = sounding - SOUNDING_OFFSET;
    const vl = velocity >= 0.88 ? 3 : 2;
    return { buffer: this.buffers.get(`pm${label}_v${vl}_rr${this.nextRr(`pm${label}`, 3)}`), root: sounding };
  }

  /** A genuinely picked note (open, palm-muted, or dead). */
  pickNote(
    si: number, midi: number, when: number,
    opts: {
      articulation?: Articulation;
      velocity?: number;      // 0..1 accent
      sustain?: number;
      vibrato?: boolean;
      pickless?: boolean;     // legato fallback: skip the pick transient
      glideFromMidi?: number; // slide-into: start pitch
      glideDur?: number;
      gap?: number;           // time to the next hit on this string (PM decay)
      isTwin?: boolean;       // internal: double-track satellite voice
    } = {}
  ) {
    if (!this.ampIn) return;
    const ctx = this.ctx;
    const art = opts.articulation ?? "open";
    const velocity = opts.velocity ?? 1;
    if (!opts.isTwin) this.stopVoice(si, when);

    // determine stroke BEFORE buffer selection so stroke-tagged banks apply
    const stroke = opts.isTwin ? (this.pickStroke ?? "d") : this.nextStroke(true);
    this.pickStroke = stroke;

    let buffer: AudioBuffer | undefined;
    let sampleMidi = midi;
    if (art === "dead") {
      const id = midi < 45 ? 5 : midi < 52 ? 4 : midi < 60 ? 3 : midi < 68 ? 2 : 1;
      buffer = this.buffers.get(`m${id}_rr${this.nextRr(`m${id}`, 3)}`);
    } else if (art === "palm") {
      const picked = this.pickPmBuffer(midi, velocity);
      buffer = picked.buffer;
      sampleMidi = picked.root;
    } else {
      sampleMidi = this.nearest(NOTE_ROOTS, opts.glideFromMidi ?? midi);
      buffer = this.buffers.get(`n${sampleMidi}_rr${this.nextRr(`n${sampleMidi}`, 3)}`);
    }
    if (!buffer) return;

    const shiftCents = (midi - sampleMidi) * 100
      + (opts.isTwin ? (Math.random() * 3 + 1) * (Math.random() < 0.5 ? -1 : 1) : 0)
      // palm chugs: ±4 cents of humanization decorrelates near-identical
      // round-robin takes without audible pitch drift
      + (art === "palm" ? (Math.random() - 0.5) * 8 : 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (art !== "dead" && opts.glideFromMidi !== undefined && opts.glideDur) {
      src.detune.setValueAtTime((opts.glideFromMidi - sampleMidi) * 100, when);
      src.detune.linearRampToValueAtTime(shiftCents, when + opts.glideDur);
    } else if (art !== "dead") {
      src.detune.value = shiftCents;
    }

    const strokeGain = stroke === "d" ? 1 : 0.93;

    // route: double-tracked palm/open notes split to hard-panned L/R chains
    const doubled = this.doubleTrack && !this.diMode && !this.namModelName &&
      (art === "palm" || art === "open") && this.busL && this.busR;
    const destNode: AudioNode = doubled
      ? (opts.isTwin ? this.busR! : this.busL!)
      : this.dest();

    const env = ctx.createGain();
    let out: AudioNode = env;
    if (art === "palm" && this.muteStrength > 0.5) {
      // optional consistency damping only when the user tightens the mute —
      // a gentle high shelf, NOT a hard low-pass; at ≤0.5 the DI is raw
      const shelf = ctx.createBiquadFilter();
      shelf.type = "highshelf";
      shelf.frequency.value = 3000;
      shelf.gain.value = -14 * (this.muteStrength - 0.5) * 2;
      env.connect(shelf);
      out = shelf;
    }
    if (art !== "dead") {
      // spectral stroke character (real stroke samples add to this)
      const color = this.strokeColor(stroke);
      out.connect(color);
      out = color;
    }
    src.connect(env);
    out.connect(destNode);

    // no per-hit normalization: velocity layers + accent scaling only
    const level = (0.55 + 0.45 * velocity) * strokeGain * (art === "dead" ? 0.9 : 1);

    // PM decay: mute pressure sets the base, the gap to the next hit caps it
    let ring: number;
    if (art === "dead") ring = 0.16;
    else if (art === "palm") {
      const base = 0.16 + 0.3 * (1 - this.muteStrength);
      ring = opts.gap !== undefined ? Math.min(base, Math.max(0.09, opts.gap * 0.9)) : base;
    } else {
      ring = 1.1 + (opts.sustain ?? 0) + (opts.glideDur ?? 0);
    }

    // down-shifted PM hits get the sample's UNSHIFTED first 16ms layered on
    // top, so pitching down doesn't lengthen/soften the pick transient
    if (art === "palm" && shiftCents < -50 && !opts.glideDur) {
      const tr = ctx.createBufferSource();
      tr.buffer = buffer;
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(level * 0.8, when);
      tg.gain.exponentialRampToValueAtTime(0.0001, when + 0.016);
      tr.connect(tg).connect(destNode);
      tr.start(when);
      tr.stop(when + 0.03);
    }

    const v: StringVoice = {
      src, env, sampleMidi, currentMidi: midi, bendCents: 0,
      articulation: art, vibrato: null, releaseAt: 0, level: 0, startedAt: when,
    };
    // preserve the first 5-20ms pick transient: instant attack for picked hits
    this.scheduleEnvelope(v, when, ring, level, opts.pickless ? 0.015 : 0);
    src.start(when, opts.pickless && art === "open" ? 0.028 : 0);
    // no early src.stop: the envelope gates it, so legato can extend the voice
    if (!opts.isTwin) {
      this.voices.set(si, v);
      if (opts.vibrato && art === "open") this.attachVibrato(v, when + (opts.glideDur ?? 0.1));
      if (doubled) {
        // independent second take: own RR, 2-6ms late, ±1-4 cents (in shiftCents)
        this.pickNote(si, midi, when + 0.002 + Math.random() * 0.004, {
          ...opts, isTwin: true,
        });
      }
    }
  }

  /**
   * Tremolo repick: a new short stroke voice OVERLAPS what is already
   * ringing instead of choking it. Each stroke: instant attack, ~55ms body,
   * ~80ms release — adjacent 16th/16th-triplet strokes overlap 20-60ms while
   * the original note's voice keeps sounding underneath. The tail pool is
   * capped to prevent buildup and choked by any new articulation, mute, or
   * stop on the string.
   */
  repickNote(
    si: number, midi: number, when: number,
    opts: { articulation?: Articulation; velocity?: number } = {}
  ) {
    if (!this.ampIn) return;
    const ctx = this.ctx;
    const art = opts.articulation ?? "open";
    const velocity = opts.velocity ?? 1;

    const stroke = this.nextStroke(true);
    this.pickStroke = stroke;

    let buffer: AudioBuffer | undefined;
    let sampleMidi = midi;
    if (art === "dead") {
      const id = midi < 45 ? 5 : midi < 52 ? 4 : midi < 60 ? 3 : midi < 68 ? 2 : 1;
      buffer = this.buffers.get(`m${id}_rr${this.nextRr(`m${id}`, 3)}`);
    } else if (art === "palm") {
      const picked = this.pickPmBuffer(midi, velocity);
      buffer = picked.buffer;
      sampleMidi = picked.root;
    } else {
      sampleMidi = this.nearest(NOTE_ROOTS, midi);
      buffer = this.buffers.get(`n${sampleMidi}_rr${this.nextRr(`n${sampleMidi}`, 3)}`);
    }
    if (!buffer) return;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (art !== "dead") src.detune.value = (midi - sampleMidi) * 100;

    const env = ctx.createGain();
    const strokeGain = stroke === "d" ? 1 : 0.93;
    // 0.82 headroom: strokes sum with the ringing body without buildup
    const level = (0.55 + 0.45 * velocity) * strokeGain * 0.82;
    const bodyEnd = when + 0.055;
    const relEnd = bodyEnd + 0.08;
    env.gain.setValueAtTime(level, when); // instant attack, transient intact
    env.gain.setValueAtTime(level, bodyEnd);
    env.gain.exponentialRampToValueAtTime(0.0001, relEnd);

    let out: AudioNode = env;
    if (art !== "dead") {
      const color = this.strokeColor(stroke);
      out.connect(color);
      out = color;
    }
    const doubled = this.doubleTrack && !this.diMode && !this.namModelName &&
      art !== "dead" && this.busL && this.busR;
    src.connect(env);
    out.connect(doubled ? this.busL! : this.dest());
    src.start(when);
    src.stop(relEnd + 0.05);

    // tail pool: keep at most 3 overlapping strokes per string
    const v: StringVoice = {
      src, env, sampleMidi, currentMidi: midi, bendCents: 0,
      articulation: art, vibrato: null, releaseAt: relEnd, level, startedAt: when,
    };
    const pool = this.repickTails.get(si) ?? [];
    pool.push(v);
    while (pool.length > 3) this.fadeVoice(pool.shift()!, when, 0.012);
    this.repickTails.set(si, pool);

    // re-excite the sustaining body: each stroke keeps the string's resonance
    // alive instead of letting the original note's envelope die mid-tremolo.
    const body = this.voices.get(si);
    if (body && art === "open" && body.articulation === "open" && body.currentMidi === midi) {
      if (when - body.startedAt > 0.7) {
        // the body sample has decayed into its dull zone — crossfade to a
        // fresh source just past the pick transient, so long tremolo runs
        // keep the brightness that pitch changes get for free
        try {
          const gOld = body.env.gain;
          gOld.cancelScheduledValues(when);
          gOld.setValueAtTime(Math.max(0.0001, body.level * 0.88), when);
          gOld.exponentialRampToValueAtTime(0.0001, when + 0.06);
          body.src.stop(when + 0.1);
          if (body.vibrato) body.vibrato.lfo.stop(when + 0.1);
        } catch {}
        const fresh = ctx.createBufferSource();
        const root = this.nearest(NOTE_ROOTS, midi);
        const buf2 = this.buffers.get(`n${root}_rr${this.nextRr(`n${root}`, 3)}`);
        if (buf2) {
          fresh.buffer = buf2;
          fresh.detune.value = (midi - root) * 100;
          const env2 = ctx.createGain();
          const hold = body.level * 0.88;
          env2.gain.setValueAtTime(0.0001, when);
          env2.gain.exponentialRampToValueAtTime(hold, when + 0.045); // hidden under the stroke
          env2.gain.setValueAtTime(hold, when + 0.25);
          env2.gain.exponentialRampToValueAtTime(0.0001, when + 0.9);
          fresh.connect(env2).connect(this.dest());
          fresh.start(when, 0.1); // past the pick transient — no double attack
          this.voices.set(si, {
            src: fresh, env: env2, sampleMidi: root, currentMidi: midi, bendCents: 0,
            articulation: "open", vibrato: null, releaseAt: when + 0.9,
            level: body.level, startedAt: when,
          });
        }
      } else {
        try {
          const g = body.env.gain;
          const hold = body.level * 0.88;
          g.cancelScheduledValues(when);
          g.setValueAtTime(hold, when);
          g.setValueAtTime(hold, when + 0.25);
          g.exponentialRampToValueAtTime(0.0001, when + 0.9);
          body.releaseAt = when + 0.9;
        } catch {}
      }
    }

    if (doubled) {
      // independent second take, small offset, own RR
      const t2 = when + 0.002 + Math.random() * 0.003;
      const rr2 = art === "open"
        ? this.buffers.get(`n${sampleMidi}_rr${this.nextRr(`n${sampleMidi}`, 3)}`)
        : buffer;
      if (rr2) {
        const s2 = ctx.createBufferSource();
        s2.buffer = rr2;
        s2.detune.value = (midi - sampleMidi) * 100 + (Math.random() * 3 + 1) * (Math.random() < 0.5 ? -1 : 1);
        const e2 = ctx.createGain();
        e2.gain.setValueAtTime(level, t2);
        e2.gain.setValueAtTime(level, t2 + 0.055);
        e2.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.135);
        s2.connect(e2).connect(this.busR!);
        s2.start(t2);
        s2.stop(t2 + 0.19);
      }
    }
  }

  /** Continue the ringing voice at a new pitch — one pick per phrase. */
  legatoTo(
    si: number, midi: number, when: number,
    style: "hammer" | "pull" | "tap",
    opts: { sustain?: number; vibrato?: boolean; velocity?: number } = {}
  ) {
    const v = this.voices.get(si);
    if (!v || v.articulation !== "open" || when > v.releaseAt - 0.03) {
      // documented fallback: no ringing source note → pickless new note
      this.pickNote(si, midi, when, { ...opts, pickless: true });
      if (this.voices.get(si)) this.fretImpact(when, style === "tap" ? 0.09 : 0.05);
      return;
    }
    const ramp = style === "hammer" ? 0.022 : style === "pull" ? 0.03 : 0.015;
    const target = (midi - v.sampleMidi) * 100;
    v.src.detune.cancelScheduledValues(when);
    v.src.detune.setValueAtTime((v.currentMidi - v.sampleMidi) * 100 + v.bendCents, when);
    v.src.detune.linearRampToValueAtTime(target, when + ramp);
    v.currentMidi = midi;
    v.bendCents = 0;
    // pulls dip the level briefly; hammers/taps get a fret-impact click
    if (style === "pull") {
      const g = v.env.gain;
      const cur = Math.max(0.0001, g.value);
      g.cancelScheduledValues(when);
      g.setValueAtTime(cur, when);
      g.linearRampToValueAtTime(cur * 0.8, when + 0.015);
      g.linearRampToValueAtTime(cur * 0.92, when + 0.05);
    }
    this.fretImpact(when, style === "tap" ? 0.09 : style === "hammer" ? 0.055 : 0.03);
    // refresh the ring so the new note doesn't die on the old envelope
    const ring = 0.9 + (opts.sustain ?? 0);
    const lvl = Math.max(0.0001, v.env.gain.value) * (style === "pull" ? 0.92 : 0.97);
    const g = v.env.gain;
    g.setValueAtTime(lvl, when + 0.06);
    g.exponentialRampToValueAtTime(0.0001, when + ring);
    v.releaseAt = when + ring;
    if (opts.vibrato) this.attachVibrato(v, when + 0.08);
  }

  /** Bend the ringing note by `cents` (default +200); release with cents=0. */
  bendTo(
    si: number, when: number, cents: number, dur: number,
    opts: { sustain?: number; vibrato?: boolean; fallbackMidi?: number; velocity?: number } = {}
  ) {
    const v = this.voices.get(si);
    if (!v || v.articulation !== "open" || when > v.releaseAt - 0.03) {
      // fallback: nothing ringing — sound the bend as a pickless glide
      if (opts.fallbackMidi !== undefined) {
        this.pickNote(si, opts.fallbackMidi, when, {
          ...opts, pickless: true,
          glideFromMidi: opts.fallbackMidi - cents / 100, glideDur: dur,
        });
      }
      return;
    }
    const from = (v.currentMidi - v.sampleMidi) * 100 + v.bendCents;
    const to = (v.currentMidi - v.sampleMidi) * 100 + cents;
    v.src.detune.cancelScheduledValues(when);
    v.src.detune.setValueAtTime(from, when);
    v.src.detune.linearRampToValueAtTime(to, when + dur);
    v.bendCents = cents;
    const ring = Math.max(0.9, dur + 0.5) + (opts.sustain ?? 0);
    const g = v.env.gain;
    const cur = Math.max(0.0001, g.value);
    g.cancelScheduledValues(when);
    g.setValueAtTime(cur, when);
    g.setValueAtTime(cur, when + ring * 0.6);
    g.exponentialRampToValueAtTime(0.0001, when + ring);
    v.releaseAt = when + ring;
    if (opts.vibrato) this.attachVibrato(v, when + dur);
  }

  /** Slide the ringing voice to a new pitch (same continuous machinery). */
  slideTo(
    si: number, midi: number, when: number, dur: number,
    opts: { sustain?: number; vibrato?: boolean; fromMidi?: number; velocity?: number } = {}
  ) {
    const v = this.voices.get(si);
    if (!v || v.articulation !== "open" || when > v.releaseAt - 0.03) {
      this.pickNote(si, midi, when, {
        ...opts, pickless: true,
        glideFromMidi: opts.fromMidi ?? midi - 2, glideDur: dur,
      });
      return;
    }
    const target = (midi - v.sampleMidi) * 100;
    v.src.detune.cancelScheduledValues(when);
    v.src.detune.setValueAtTime((v.currentMidi - v.sampleMidi) * 100 + v.bendCents, when);
    v.src.detune.linearRampToValueAtTime(target, when + dur);
    v.currentMidi = midi;
    v.bendCents = 0;
    const ring = dur + 0.8 + (opts.sustain ?? 0);
    const g = v.env.gain;
    const cur = Math.max(0.0001, g.value);
    g.cancelScheduledValues(when);
    g.setValueAtTime(cur, when);
    g.setValueAtTime(cur * 0.95, when + ring * 0.6);
    g.exponentialRampToValueAtTime(0.0001, when + ring);
    v.releaseAt = when + ring;
    if (opts.vibrato) this.attachVibrato(v, when + dur);
  }

  /** Vibrato on whatever is ringing (used when "~" follows legato/bends). */
  vibratoOn(si: number, when: number) {
    const v = this.voices.get(si);
    if (v) this.attachVibrato(v, when);
  }

  // ---- NAM ------------------------------------------------------------------

  private routeNam(on: boolean) {
    if (!this.ampIn || !this.drive || !this.cab) return;
    try { this.ampIn.disconnect(); } catch {}
    if (on && this.namNode) {
      if (!this.namMakeup) this.namMakeup = this.ctx.createGain();
      this.ampIn.connect(this.namNode);
      try { this.namNode.disconnect(); } catch {}
      try { this.namMakeup.disconnect(); } catch {}
      this.namNode.connect(this.namMakeup);
      this.namMakeup.connect(this.cabBypass && this.post ? this.post : this.cab);
    } else {
      if (this.namNode) { try { this.namNode.disconnect(); } catch {} }
      this.ampIn.connect(this.drive);
    }
  }

  async loadNamModel(modelJson: string, name = "model"): Promise<{ ok: boolean; error?: string; loudness?: number | null }> {
    try {
      JSON.parse(modelJson);
    } catch {
      return { ok: false, error: "Not a valid .nam file (expected JSON)." };
    }
    await this.ready();
    const ctx = this.ctx;
    if (!this.namNode) {
      await ctx.audioWorklet.addModule("/nam/nam-processor.js");
      const wasmBinary = await fetch("/nam/nam.wasm").then((r) => r.arrayBuffer());
      const node = new AudioWorkletNode(ctx, "nam-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      await new Promise<void>((resolve, reject) => {
        const t = window.setTimeout(() => reject(new Error("NAM engine init timed out")), 10000);
        node.port.onmessage = (e) => {
          if (e.data.type === "ready") { clearTimeout(t); resolve(); }
          else if (e.data.type === "error") { clearTimeout(t); reject(new Error(e.data.error)); }
        };
        node.port.postMessage({ type: "init", wasmBinary }, [wasmBinary]);
      });
      this.namNode = node;
    }
    const node = this.namNode;
    const result = await new Promise<{ ok: boolean; error?: string; loudness?: number | null }>((resolve) => {
      const t = window.setTimeout(() => resolve({ ok: false, error: "Model load timed out" }), 10000);
      node.port.onmessage = (e) => {
        if (e.data.type === "modelLoaded") {
          clearTimeout(t);
          resolve({ ok: e.data.success, error: e.data.error, loudness: e.data.loudness });
        } else if (e.data.type === "error") { clearTimeout(t); resolve({ ok: false, error: e.data.error }); }
      };
      node.port.postMessage({ type: "loadModel", modelJson });
    });
    if (result.ok) {
      this.namModelName = name;
      this.routeNam(true);
      const TARGET_DB = -18;
      const makeupDb =
        result.loudness !== null && result.loudness !== undefined && isFinite(result.loudness)
          ? Math.max(-12, Math.min(24, TARGET_DB - result.loudness))
          : 6;
      this.namMakeup!.gain.value = Math.pow(10, makeupDb / 20);
    }
    return result;
  }

  bypassNam() {
    this.namModelName = null;
    this.namNode?.port.postMessage({ type: "bypass" });
    this.routeNam(false);
  }
}
