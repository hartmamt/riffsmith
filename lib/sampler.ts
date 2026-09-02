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
// FreePats "Electric Guitar FSBS (direct)" (CC0): Fender bridge pickup, standard
// tuning, 2 dynamics (hard ×4 RR, soft ×2 RR). Roots include a low C2 on the
// dropped 6th string, so Drop-C/B notes are within a semitone or two.
const FSBS_ROOTS = [36, 40, 41, 45, 48, 50, 52, 55, 59, 61, 64, 67, 71, 72, 74, 77, 80, 82, 85];
const PM_ROOTS = [37, 40, 43, 46, 49, 52, 55, 58, 61, 64, 67];
const MUTE_IDS = [1, 2, 3, 4, 5]; // unpitched dead hits, high → low register
const BASE = "/samples";

type Articulation = "open" | "palm" | "dead" | "pinch";

// parameter ids of the wasm string engine (mirror of string-engine/src/lib.rs)
const SP = {
  FREQ: 0, BRIGHT: 1, LOSS: 2, DISP: 3, NONLIN: 4, MUTE: 5, PICKPOS: 6, PICKUP: 7,
  PICKUP_HZ: 8, PICKUP_Q: 9, TENSION: 10, DIRECT: 11, VIB_DEPTH: 12, VIB_RATE: 13, GAIN: 14,
  POL_DETUNE: 15, POL_COUPLE: 16, POL_MIX: 17,
} as const;
const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

type StringVoice = {
  src: AudioBufferSourceNode;
  env: GainNode;               // per-voice envelope
  sampleMidi: number;          // root of the playing sample
  currentMidi: number;         // pitch the voice is at (before bend offset)
  bendCents: number;           // current bend offset in cents
  articulation: Articulation;
  vibrato: { lfo: OscillatorNode; depth: GainNode } | null;
  releaseAt: number;           // when the envelope reaches silence
  holdUntil: number;           // end of the envelope plateau (release ramp starts here)
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
  // NAM path: input trim (captures are trained on DI peaking around -10 dBFS;
  // our samples peak near -2), then model → makeup → optional cab → level →
  // out. No compressor: a full-rig capture already carries the amp's own.
  private namIn: GainNode | null = null;
  private namCab: ConvolverNode | null = null;
  private namPost: GainNode | null = null;
  private namInputTrim = 0.45;
  private namJson: string | null = null;
  private namMakeupDb = 6;
  // boost pedal in front of the capture (tube-screamer style: low cut, mid
  // hump, soft clip, top-end roll-off) — what a metal rig always has and
  // what turns a dark humbucker DI into a tight, defined 5150 tone
  private boosts: { hp: BiquadFilterNode; mid: BiquadFilterNode; clip: WaveShaperNode; lp: BiquadFilterNode }[] = [];
  // double tracking through the capture: two more instances, hard-panned
  private namBusL: GainNode | null = null;
  private namBusR: GainNode | null = null;
  private namStereoReady: Promise<void> | null = null;
  private namBoost: { input: AudioNode; output: AudioNode } | null = null;
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
  // Phase 0 "player rules" (tension glide, pick-position comb, velocity tone,
  // stroke tilt, pre-pick clamp, anti-repetition). Off = the plain sampler,
  // for A/B listening.
  playerRules = true;
  // hand legato/bend/slide landings over to a real recording of the target
  // pitch (true) or keep the resampled voice (false) — A/B switch
  legatoLandings = true;
  // noise layer (part of the player rules): a powered-on floor under the
  // amp, a pick scrape a few ms before each stroke, and the pick-hand thunk
  // when a ringing note is stopped
  private squeakBuf: AudioBuffer | null = null; // 1 s white noise for slide squeaks
  private floorSrc: AudioBufferSourceNode | null = null;
  private floorGain: GainNode | null = null;
  private floorOn = false;
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
  private fsbsRr = new Map<string, number>(); // `${root}${layer}` → round-robin count present
  // Guitar-TECHS (CC BY 4.0): one LP-humbucker DI note per string×fret, plus
  // pinch harmonics on frets 1-12. Keyed by pitch, each entry remembers its
  // string (1 = high E … 6 = low E) so a note prefers the string it's tabbed on.
  noteBank: "gtechs" | "fsbs" = "gtechs";
  // bass tunings play a real bass (Karoryfer babyblue, CC0), loaded on demand
  instrument: "guitar" | "bass" = "guitar";
  private bassNotes = new Map<number, { ff: string[]; f: string[] }>();
  private bassLoading: Promise<void> | null = null;
  // a bass has its own amp: a guitar capture turns bass DI into fuzz
  private bassAmp: { input: GainNode; drive: GainNode; post: GainNode } | null = null;
  // where bass goes: its own amp (clean to gritty) or the guitar rig (dirty)
  bassRig: "bass" | "guitar" = "bass";
  stringCount = 6; // of the song being played (string-aware picks need 6)
  private gtNotes = new Map<number, { key: string; string: number; midi: number }[]>();
  private gtPinch = new Map<number, { key: string; string: number; midi: number }[]>();
  // performance state (Phase 0 "player rules"): the pick's position drifts a
  // little from stroke to stroke, and the double-tracked take drifts in pitch
  // like a second tape machine (ADT) instead of sitting at a fixed offset
  private posWalk = 0;      // pick-position random walk, fraction of string length
  // ---- hybrid string engine (Rust/WASM waveguides in one AudioWorklet) ----
  // "hybrid": the sampled pick attack EXCITES a physical string model that
  // then owns sustain, legato, bends, vibrato, palm damping and re-picking.
  engineMode: "samples" | "hybrid" = "samples";
  // hybrid: play the sampled pick under the model (true) or let the model
  // alone carry the attack (false) — the latter is for hearing what the
  // model itself contributes
  hybridSampleAttack = true;
  private stringNode: AudioWorkletNode | null = null;
  private stringOut: GainNode | null = null;
  private stringRouted: AudioNode | null = null;
  private stringReady: Promise<boolean> | null = null;
  private hybrid = new Map<number, { midi: number; art: Articulation; until: number; bendCents: number }>();
  private twinDrift = 0;    // cents, slow random walk for the L/R twin take

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

  /** One stroke for a whole chord: the scheduler calls this once per column
   *  and passes the result to every string's pickNote, so a three-string
   *  power chord advances the picking hand once, not three times. */
  beginStroke(): "d" | "u" {
    const s = this.nextStroke(true);
    this.pickStroke = s;
    return s;
  }

  // stroke character beyond gain: downstrokes fuller low mids, upstrokes
  // thinner/brighter attack (used when the bank has no real stroke samples).
  // `tiltDb` is a per-stroke random tilt so repeated strokes never share a
  // spectrum exactly (anti-repetition)
  private strokeColor(stroke: "d" | "u", tiltDb = 0): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    if (stroke === "d") {
      f.type = "lowshelf";
      f.frequency.value = 280;
      f.gain.value = 2.5 + tiltDb;
    } else {
      f.type = "highshelf";
      f.frequency.value = 1600;
      f.gain.value = 3.5 + tiltDb;
    }
    return f;
  }

  // pick-position comb: the attack of a real pick carries notches at multiples
  // of 1/(beta*T). Our DI samples were picked at ONE position, so this applies
  // the *difference* between that position and where this stroke lands
  // (chugs sit closer to the bridge; every stroke wanders a little). Attack
  // only: the comb fades out over ~70ms so the sustain stays the sample's.
  private pickPositionComb(input: AudioNode, midi: number, art: Articulation, when: number): AudioNode {
    const ctx = this.ctx;
    this.posWalk = Math.max(-0.04, Math.min(0.04, this.posWalk + (Math.random() - 0.5) * 0.02));
    const period = 1 / (440 * Math.pow(2, (midi - 69) / 12));
    const beta = (art === "palm" ? 0.05 : 0.02) + Math.abs(this.posWalk);
    const d = Math.min(0.009, Math.max(0.0002, beta * period));
    const g0 = art === "palm" ? 0.45 : 0.35;
    const delay = ctx.createDelay(0.01);
    delay.delayTime.value = d;
    const fb = ctx.createGain();
    fb.gain.setValueAtTime(-g0, when);
    fb.gain.linearRampToValueAtTime(0, when + 0.07);
    const sum = ctx.createGain();
    input.connect(sum);
    input.connect(delay).connect(fb).connect(sum);
    return sum;
  }

  // tension modulation: a hard pick stretches the string, so the note starts
  // sharp and settles as the energy decays. Largest on loose low strings —
  // Drop B is exactly that case. Returns the onset offset in cents.
  private tensionGlideCents(midi: number, velocity: number, art: Articulation): number {
    if (art === "dead") return 0;
    const lowness = Math.max(0, Math.min(1, (64 - midi) / 24)); // B1..E4 → 1..0
    // open DI samples already carry some natural onset sharpness, so the
    // synthetic glide is smaller there than on the (flatwound, darker) chugs
    return (art === "open" ? 0.6 : 1) * (4 + 20 * lowness) * Math.max(0, Math.min(1, velocity));
  }

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  ready(): Promise<void> {
    if (!this.loading) {
      const urls: [string, string][] = [];
      // Emilyguitar notes stay as the fallback sustain set (loaded lazily if
      // the FreePats bank is missing); its mute noises are always loaded
      const emilyNotes: [string, string][] = [];
      for (const m of NOTE_ROOTS) {
        emilyNotes.push([`n${m}_rr1`, `${BASE}/emily/n${m}.wav`]);
        emilyNotes.push([`n${m}_rr2`, `${BASE}/emily/n${m}_rr2.wav`]);
        emilyNotes.push([`n${m}_rr3`, `${BASE}/emily/n${m}_rr3.wav`]);
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
      const load = async ([key, url]: [string, string]) => {
        try {
          const res = await fetch(url);
          if (!res.ok) return; // tolerate missing files
          const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
          this.buffers.set(key, buf);
        } catch {}
      };
      // the FreePats bank ships a manifest (not every root has a soft layer
      // or four round robins), so only files that exist are requested
      const fsbs: [string, string][] = [];
      const loadFsbs = async () => {
        try {
          const man = await fetch(`${BASE}/fsbs/manifest.json`).then((r) => (r.ok ? r.json() : null));
          for (const f of (man?.files ?? []) as string[]) {
            const m = /^n(\d+)_([hs])_rr(\d+)\.mp3$/.exec(f);
            if (!m) continue;
            fsbs.push([`f${m[1]}_${m[2]}_rr${m[3]}`, `${BASE}/fsbs/${f}`]);
            const k = `${m[1]}${m[2]}`;
            this.fsbsRr.set(k, Math.max(this.fsbsRr.get(k) ?? 0, Number(m[3])));
          }
        } catch {}
        await Promise.all(fsbs.map(load));
      };
      const loadGt = async () => {
        try {
          const man = await fetch(`${BASE}/gtechs/manifest.json`).then((r) => (r.ok ? r.json() : null));
          const jobs: [string, string][] = [];
          for (const f of (man?.files ?? []) as { file: string; kind: string; string: number; midi: number }[]) {
            if (f.kind !== "note" && f.kind !== "pinch") continue; // palm mutes load as a pm bank
            const key = `${f.kind === "note" ? "g" : "gh"}${f.midi}_s${f.string}`;
            const map = f.kind === "note" ? this.gtNotes : this.gtPinch;
            if (!map.has(f.midi)) map.set(f.midi, []);
            map.get(f.midi)!.push({ key, string: f.string, midi: f.midi });
            jobs.push([key, `${BASE}/gtechs/${f.file}`]);
          }
          await Promise.all(jobs.map(load));
        } catch {}
      };
      this.loading = Promise.all([...urls.map(load), loadFsbs(), loadGt()])
        .then(async () => {
          if (!this.buffers.has("f40_h_rr1")) await Promise.all(emilyNotes.map(load));
        })
        .then(() => this.buildAmp());
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

    const pre = ctx.createBiquadFilter(); // pickup/cable roll-off: DI has nothing useful above ~7 kHz
    pre.type = "lowpass";
    pre.frequency.value = 7500;
    pre.Q.value = 0.5;

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

    input.connect(pre).connect(tighten).connect(midEmph).connect(drive).connect(shaper).connect(hp).connect(scoop)
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
    const sq = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const sd = sq.getChannelData(0);
    for (let i = 0; i < sd.length; i++) sd[i] = Math.random() * 2 - 1;
    this.squeakBuf = sq;

    // powered-on noise floor: pink-tilted noise, gated by playing, into the
    // amp path only (never the DI monitor). -92 dBFS is a quiet humbucker rig;
    // under a high-gain capture it's what makes the gaps between chugs breathe
    const fl = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const fd = fl.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < fd.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
      fd[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
    const floorSrc = ctx.createBufferSource();
    floorSrc.buffer = fl; floorSrc.loop = true;
    const floorGain = ctx.createGain();
    floorGain.gain.value = 0;
    floorSrc.connect(floorGain).connect(chain.input);
    floorSrc.start();
    this.floorSrc = floorSrc; this.floorGain = floorGain;

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
    if (on) { void this.ensureDoubleBuses(); if (this.namModelName) void this.ensureNamStereo(); }
  }

  // the L/R take destinations for the active amp: capture instances when a
  // NAM model is loaded, else the built-in chains
  private twinBuses(): { l: AudioNode; r: AudioNode } | null {
    if (this.instrument === "bass" && this.bassRig === "bass") return null;
    if (this.namModelName) return this.namBusL && this.namBusR ? { l: this.namBusL, r: this.namBusR } : null;
    return this.busL && this.busR ? { l: this.busL, r: this.busR } : null;
  }

  private dest(): AudioNode {
    if (this.diMode) return this.diBus!;
    if (this.instrument === "bass" && this.bassRig === "bass") return this.ensureBassAmp().input;
    return this.ampIn!;
  }

  // Bass amp: HPF → mild tube-style saturation (drive from the tight slider,
  // 0 = nearly clean, 1 = gritty) → bass tone stack → compressor → out.
  private ensureBassAmp(): { input: GainNode; drive: GainNode; post: GainNode } {
    if (this.bassAmp) return this.bassAmp;
    const ctx = this.ctx;
    const input = ctx.createGain();
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 35; hp.Q.value = 0.7;
    const drive = ctx.createGain(); drive.gain.value = 1 + 3 * this.tightAmt;
    const shaper = ctx.createWaveShaper();
    const N = 2048; const curve = new Float32Array(N); const k = 2.2;
    for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * 2 - 1; curve[i] = Math.tanh(k * x) / Math.tanh(k); }
    shaper.curve = curve; shaper.oversample = "2x";
    const low = ctx.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 90; low.gain.value = 3;
    const mid = ctx.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 500; mid.Q.value = 1; mid.gain.value = -2;
    const pres = ctx.createBiquadFilter(); pres.type = "peaking"; pres.frequency.value = 1500; pres.Q.value = 0.8; pres.gain.value = 2;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 6000; lp.Q.value = 0.6;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.15; comp.knee.value = 6;
    const post = ctx.createGain(); post.gain.value = 0.8 * this.level;
    input.connect(hp).connect(drive).connect(shaper).connect(low).connect(mid).connect(pres).connect(lp).connect(comp).connect(post);
    post.connect(ctx.destination);
    if (this.analyser) post.connect(this.analyser);
    this.bassAmp = { input, drive, post };
    return this.bassAmp;
  }

  setLevel(x: number) {
    this.level = Math.max(0, Math.min(2, x));
    if (this.post) this.post.gain.value = 0.65 * this.level;
    if (this.namPost) this.namPost.gain.value = 0.65 * this.level;
    if (this.bassAmp) this.bassAmp.post.gain.value = 0.8 * this.level;
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
    for (const b of this.boosts) this.applyBoost(b, t);
    if (this.bassAmp) this.bassAmp.drive.gain.value = 1 + 3 * t;
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

  /** Load the bass bank (idempotent); called when a bass-tuned song plays. */
  loadBass(): Promise<void> {
    if (!this.bassLoading) {
      this.bassLoading = (async () => {
        try {
          const man = await fetch(`${BASE}/bass/manifest.json`).then((r) => (r.ok ? r.json() : null));
          const files = (man?.files ?? []) as { file: string; layer: "ff" | "f"; rr: number; midi: number }[];
          await Promise.all(files.map(async (f) => {
            try {
              const res = await fetch(`${BASE}/bass/${f.file}`);
              if (!res.ok) return;
              const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
              const key = `bass_${f.file}`;
              this.buffers.set(key, buf);
              if (!this.bassNotes.has(f.midi)) this.bassNotes.set(f.midi, { ff: [], f: [] });
              this.bassNotes.get(f.midi)![f.layer].push(key);
            } catch {}
          }));
        } catch {}
      })();
    }
    return this.bassLoading;
  }

  get bassLoaded(): boolean { return this.bassNotes.size > 0; }

  // Guitar-TECHS candidates for a pitch: exact pitch on the tabbed string
  // first, then that string's neighbouring frets (±1 semitone, pitched — same
  // timbre, real round robins), then any string. `tol` widens the search.
  private gtCandidates(
    map: Map<number, { key: string; string: number; midi: number }[]>, midi: number, tol: number, si?: number
  ): { key: string; string: number; midi: number }[] {
    const gtString = si !== undefined && this.stringCount === 6 ? si + 1 : undefined;
    const near: { key: string; string: number; midi: number }[] = [];
    for (let d = -tol; d <= tol; d++) for (const e of map.get(midi + d) ?? []) if (this.buffers.has(e.key)) near.push(e);
    if (!near.length) return near;
    const exact = near.filter((e) => e.midi === midi);
    if (gtString !== undefined) {
      const same = near.filter((e) => e.string === gtString);
      if (same.some((e) => e.midi === midi)) return same.sort((a, b) => Math.abs(a.midi - midi) - Math.abs(b.midi - midi));
    }
    return exact.length ? exact : near.sort((a, b) => Math.abs(a.midi - midi) - Math.abs(b.midi - midi));
  }

  // sustained-note sample for a pitch and pick strength. Guitar-TECHS (one
  // dynamic, string-aware) by default; FreePats picks its layer by velocity
  // (accents 0.72-1.0 → soft below ~0.86, hard above); Emily as the fallback
  private openBuffer(midi: number, velocity: number, si?: number, tol = 1): { buffer: AudioBuffer | undefined; root: number } {
    if (this.instrument === "bass" && this.bassNotes.size) {
      const roots = [...this.bassNotes.keys()];
      const root = this.nearest(roots, midi);
      const e = this.bassNotes.get(root)!;
      const layer = velocity >= 0.86 && e.ff.length ? e.ff : e.f.length ? e.f : e.ff;
      const key = layer[this.nextRr(`bass${root}${layer === e.ff ? "ff" : "f"}`, layer.length) - 1];
      const buffer = this.buffers.get(key);
      if (buffer) return { buffer, root };
    }
    if (this.noteBank === "gtechs" && this.gtNotes.size) {
      const cands = this.gtCandidates(this.gtNotes, midi, tol, si);
      if (cands.length) {
        const c = cands[this.nextRr(`g${midi}_${si ?? "x"}`, cands.length) - 1];
        const buffer = this.buffers.get(c.key);
        if (buffer) return { buffer, root: c.midi };
      }
    }
    if (this.buffers.has("f40_h_rr1")) {
      const root = this.nearest(FSBS_ROOTS, midi);
      let layer: "h" | "s" = velocity >= 0.865 ? "h" : "s";
      if (!this.fsbsRr.has(`${root}${layer}`)) layer = "h"; // high roots have no soft layer
      const rr = this.nextRr(`f${root}${layer}`, this.fsbsRr.get(`${root}${layer}`) ?? 1);
      const buffer = this.buffers.get(`f${root}_${layer}_rr${rr}`) ?? this.buffers.get(`f${root}_h_rr1`);
      if (buffer) return { buffer, root };
    }
    const root = this.nearest(NOTE_ROOTS, midi);
    return { buffer: this.buffers.get(`n${root}_rr${this.nextRr(`n${root}`, 3)}`), root };
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

  private stopVoice(si: number, when: number, fast = true, fadeS?: number) {
    // a new articulation on the string chokes the sustaining voice AND the
    // tremolo tail pool
    const tails = this.repickTails.get(si);
    if (tails) {
      for (const t of tails) this.fadeVoice(t, when, Math.min(0.02, fadeS ?? 0.02));
      this.repickTails.delete(si);
    }
    const v = this.voices.get(si);
    if (!v) return;
    if (v.articulation === "open" || v.articulation === "pinch") this.stopThunk(v, when);
    this.fadeVoice(v, when, fadeS ?? (fast ? 0.025 : 0.08));
    this.voices.delete(si);
  }

  allNotesOff() {
    const now = this.ctx.currentTime;
    for (const k of [...this.voices.keys()]) this.stopVoice(k, now);
    this.stringNode?.port.postMessage({ type: "clearAll" });
    this.hybrid.clear();
    this.floorSet(false, now);
  }

  private floorSet(on: boolean, when: number) {
    if (!this.floorGain || !this.playerRules && on) return;
    if (this.floorOn === on) return;
    this.floorOn = on;
    const g = this.floorGain.gain;
    g.cancelScheduledValues(when);
    g.setValueAtTime(g.value, when);
    // a high-gain capture adds ~40 dB, so "off" must reach true zero
    if (on) g.linearRampToValueAtTime(Math.pow(10, -92 / 20), when + 0.05);
    else g.linearRampToValueAtTime(0, when + 0.4);
  }

  // pick scrape: the plectrum drags over the winding a few ms before the
  // string releases. Broadband, tilted to 2-6 kHz, louder on wound strings
  // and hard picks; it leads the transient the way real pre-noise does.
  private pickScrape(when: number, midi: number, velocity: number, art: Articulation) {
    if (!this.noiseBuf || !this.playerRules || this.diMode) return;
    const ctx = this.ctx;
    const wound = this.instrument === "bass" ? 0.45 : midi < 55 ? 1 : 0.5;
    const level = (art === "palm" ? 0.04 : art === "pinch" ? 0.07 : 0.025) * wound * (0.6 + 0.4 * velocity);
    const lead = 0.004 + (1 - velocity) * 0.006;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 3800; bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, when - lead);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.006);
    src.connect(bp).connect(g).connect(this.dest());
    src.start(Math.max(ctx.currentTime, when - lead));
    src.stop(when + 0.02);
  }

  // pick-hand stop: the low thump of the hand landing on a ringing string,
  // quieter the longer the note has already decayed (rt_decay-style)
  private stopThunk(v: StringVoice, when: number) {
    if (!this.noiseBuf || !this.playerRules || this.diMode) return;
    const age = Math.max(0, when - v.startedAt);
    if (age < 0.06 || when > v.releaseAt) return; // nothing left to stop
    const ctx = this.ctx;
    const level = 0.09 * v.level * Math.pow(10, (-6 * age) / 20);
    if (level < 0.002) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 350; lp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.03);
    src.connect(lp).connect(g).connect(this.dest());
    src.start(when);
    src.stop(when + 0.05);
  }

  // fret clank: a hard pick on a low string throws the string against the
  // frets for its first few cycles — a bright burst locked to the period
  // (Rank & Kubin's amplitude limiting, done phenomenologically). Only on
  // hard hits on the two lowest strings, so it can't be overdone by accident.
  private fretClank(when: number, midi: number, art: Articulation, velocity: number) {
    if (!this.noiseBuf || !this.playerRules || this.diMode) return;
    if (this.instrument === "bass" || velocity < 0.95 || midi > 47 || art === "dead" || art === "pinch") return;
    const ctx = this.ctx;
    const T = 1 / midiToHz(midi);
    const base = (art === "palm" ? 0.09 : 0.12) * (midi <= 42 ? 1 : 0.7);
    for (let k = 0; k < 3; k++) {
      const t = when + 0.003 + k * T;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = 3200; bp.Q.value = 1.4;
      const g = ctx.createGain();
      const lvl = base * Math.pow(0.55, k);
      g.gain.setValueAtTime(lvl, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.0015);
      src.connect(bp).connect(g).connect(this.dest());
      src.start(t);
      src.stop(t + 0.006);
    }
  }

  // slide squeak: the finger dragging over a wound string's winding makes a
  // pitched scrape whose frequency follows the slide speed (windings per
  // metre × m/s, Pakarinen 2008). Plain strings just hiss faintly.
  private slideSqueak(when: number, fromMidi: number, toMidi: number, dur: number) {
    if (!this.squeakBuf || !this.playerRules || this.diMode || dur <= 0.02) return;
    const ctx = this.ctx;
    const frets = Math.abs(toMidi - fromMidi);
    if (frets < 1) return;
    const wound = Math.min(fromMidi, toMidi) < 55;
    const speed = (frets * 0.03) / dur;                     // ~3 cm per fret
    const fc = Math.max(500, Math.min(6000, 3000 * speed)); // ~3000 windings/m
    const level = (wound ? 0.028 : 0.008) * Math.min(1, speed * 1.2);
    const src = ctx.createBufferSource();
    src.buffer = this.squeakBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.Q.value = wound ? 5 : 1;
    bp.frequency.setValueAtTime(fc * 0.7, when);
    bp.frequency.linearRampToValueAtTime(fc, when + dur * 0.4);
    bp.frequency.linearRampToValueAtTime(fc * 0.6, when + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(level, when + dur * 0.3);
    g.gain.setValueAtTime(level, when + dur * 0.75);
    g.gain.linearRampToValueAtTime(0, when + dur + 0.01);
    src.connect(bp).connect(g).connect(this.dest());
    src.start(when, Math.random() * 0.5);
    src.stop(when + dur + 0.03);
  }

  // short filtered noise blip — the fret/finger impact of legato techniques
  private fretImpact(when: number, level: number) {
    if (!this.noiseBuf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    // the finger landing on the fret: a short low thud, not a click (a 2.6 kHz
    // burst reads as a pick through a high-gain amp)
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 700;
    lp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level * 0.6, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.02);
    src.connect(lp).connect(g).connect(this.dest());
    src.start(when);
    src.stop(when + 0.03);
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

  private scheduleEnvelope(v: StringVoice, when: number, ringSeconds: number, level: number, attack: number, softStart = 1) {
    v.level = level;
    const g = v.env.gain;
    g.cancelScheduledValues(when);
    g.setValueAtTime(Math.max(0.0001, attack === 0 ? level * softStart : 0.0001), when);
    if (attack > 0) g.exponentialRampToValueAtTime(level, when + attack);
    else if (softStart < 1) g.linearRampToValueAtTime(level, when + 0.02); // a softer pick: transient trimmed, body intact
    g.setValueAtTime(level, when + ringSeconds * 0.7);
    g.exponentialRampToValueAtTime(0.0001, when + ringSeconds);
    v.holdUntil = when + ringSeconds * 0.7;
    v.releaseAt = when + ringSeconds;
  }

  // the envelope's value at a future time, from our own schedule. Reading
  // `gain.value` instead gives the value NOW, which is ~130 ms behind the
  // event being scheduled, and re-setting that on a legato steps the level
  // back UP — the "pick" in every hammer-on and pull-off.
  private envAt(v: StringVoice, t: number): number {
    const lvl = Math.max(0.0001, v.level);
    if (t <= v.holdUntil) return lvl;
    if (t >= v.releaseAt) return 0.0001;
    const k = (t - v.holdUntil) / Math.max(0.001, v.releaseAt - v.holdUntil);
    return lvl * Math.pow(0.0001 / lvl, k);
  }

  // continue a ringing voice's envelope from exactly where it is at `when`,
  // with a fresh plateau and release (legato, bends, slides)
  private extendRing(v: StringVoice, when: number, ring: number, scale = 1) {
    const cur = Math.max(0.0001, this.envAt(v, when) * scale);
    const g = v.env.gain;
    g.cancelScheduledValues(when);
    g.setValueAtTime(cur, when);
    g.setValueAtTime(cur, when + ring * 0.7);
    g.exponentialRampToValueAtTime(0.0001, when + ring);
    v.level = cur;
    v.holdUntil = when + ring * 0.7;
    v.releaseAt = when + ring;
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
      stroke?: "d" | "u";     // chord: stroke already chosen by beginStroke()
      repick?: boolean;       // tremolo stroke: the pick stops and restarts the string
    } = {}
  ) {
    if (!this.ampIn) return;
    const ctx = this.ctx;
    const art = opts.articulation ?? "open";
    const velocity = opts.velocity ?? 1;
    if (!opts.isTwin) {
      // the hand lands before the pick: a palm clamps the ringing tail ~4ms
      // early and hard (measured palm pressure peaks just before the pick);
      // a plain re-pick rests the pick on the string ~2ms early
      const early = opts.repick || !this.playerRules ? 0 : art === "palm" ? 0.004 : 0.002;
      this.stopVoice(si, Math.max(ctx.currentTime, when - early), true, opts.repick ? 0.012 : !this.playerRules ? 0.025 : art === "palm" ? 0.005 : 0.015);
    }

    // determine stroke BEFORE buffer selection so stroke-tagged banks apply
    const stroke = opts.stroke ?? (opts.isTwin ? (this.pickStroke ?? "d") : this.nextStroke(true));
    this.pickStroke = stroke;
    if (!opts.isTwin && !opts.pickless) {
      if (!(this.instrument === "bass" && this.bassRig === "bass")) this.floorSet(true, when - 0.02);
      if (art !== "dead") this.pickScrape(when, midi, velocity, art);
    }

    let buffer: AudioBuffer | undefined;
    let sampleMidi = midi;
    if (art === "dead") {
      // a dead note is a choked pluck: the real note, dark and over in ~80 ms,
      // with a whisper of string-muting noise on guitar (the old unpitched
      // noise samples alone were a percussive click through an amp)
      const o = this.openBuffer(midi, velocity, si);
      buffer = o.buffer; sampleMidi = o.root;
      if (this.instrument !== "bass" && !opts.isTwin) {
        const id = midi < 45 ? 5 : midi < 52 ? 4 : midi < 60 ? 3 : midi < 68 ? 2 : 1;
        const nb = this.buffers.get(`m${id}_rr${this.nextRr(`m${id}`, 3)}`);
        if (nb) {
          const ns = ctx.createBufferSource(); ns.buffer = nb;
          const nl = ctx.createBiquadFilter(); nl.type = "lowpass"; nl.frequency.value = 3500;
          const ng = ctx.createGain(); ng.gain.setValueAtTime(0.22 * (0.55 + 0.45 * velocity), when);
          ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
          ns.connect(nl).connect(ng).connect(this.dest()); ns.start(when); ns.stop(when + 0.08);
        }
      }
    } else if (art === "palm" && this.instrument === "bass" && this.bassNotes.size) {
      // no recorded bass mutes: the bass note itself under the palm envelope
      const o = this.openBuffer(midi, velocity, si);
      buffer = o.buffer; sampleMidi = o.root;
    } else if (art === "palm") {
      const picked = this.pickPmBuffer(midi, velocity);
      buffer = picked.buffer;
      sampleMidi = picked.root;
    } else if (art === "pinch") {
      // pinch harmonic: the thumb kills the fundamental and the string sings
      // an overtone — the 3rd harmonic (+19) on the low strings, the 4th (+24)
      // higher up. Built from clean recordings of THAT pitch (any string) with
      // a little of the fundamental underneath and a hard pick scrape; the
      // amp does the screaming. (Recorded DI pinches were too faint and
      // inconsistent to use.)
      const harm = si !== undefined && si >= this.stringCount - 2 ? 19 : 24;
      const o = this.openBuffer(Math.min(midi + harm, 86), 1, undefined);
      buffer = o.buffer; sampleMidi = o.root;
      if (buffer) {
        // the fundamental, quietly, so the note still reads
        const f = this.openBuffer(midi, velocity, si);
        if (f.buffer && !opts.isTwin) {
          const fs = ctx.createBufferSource();
          fs.buffer = f.buffer;
          fs.detune.value = (midi - f.root) * 100;
          const fg = ctx.createGain();
          const fl = (0.55 + 0.45 * velocity) * 0.18;
          fg.gain.setValueAtTime(fl, when);
          fg.gain.setValueAtTime(fl, when + 0.4);
          fg.gain.exponentialRampToValueAtTime(0.0001, when + 1.4 + (opts.sustain ?? 0));
          fs.connect(fg).connect(this.dest());
          fs.start(when);
          fs.stop(when + 1.6 + (opts.sustain ?? 0));
        }
      }
    } else {
      const o = this.openBuffer(opts.glideFromMidi ?? midi, velocity, si);
      buffer = o.buffer;
      sampleMidi = o.root;
    }
    if (!buffer) return;

    // hybrid: the string model takes the note, but the REAL sampled attack
    // still plays for its first ~100 ms and crossfades into the model, so the
    // pick is the recording and only the ring-out is synthesized
    let attackOnly = false;
    if (this.engineMode === "hybrid" && this.stringNode && !opts.isTwin && art !== "dead" && art !== "pinch") {
      this.hybridPick(si, midi, when, art, velocity, stroke, buffer, sampleMidi, opts);
      attackOnly = true;
    }

    if (opts.isTwin) {
      // ADT-style slow drift: the second take wanders a few cents over a phrase
      this.twinDrift = Math.max(-4, Math.min(4, this.twinDrift + (Math.random() - 0.5) * 1.2));
    }
    const played = art === "pinch" ? Math.min(midi + (si !== undefined && si >= this.stringCount - 2 ? 19 : 24), 86) : midi;
    const shiftCents = (played - sampleMidi) * 100
      + (opts.isTwin ? this.twinDrift + (Math.random() - 0.5) * 2 : 0)
      // palm chugs: ±4 cents of humanization decorrelates near-identical
      // round-robin takes without audible pitch drift
      + (art === "palm" ? (Math.random() - 0.5) * 8 : 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (art !== "dead" && opts.glideFromMidi !== undefined && opts.glideDur) {
      src.detune.setValueAtTime((opts.glideFromMidi - sampleMidi) * 100, when);
      src.detune.linearRampToValueAtTime(shiftCents, when + opts.glideDur);
      if (!opts.isTwin && art === "open") this.slideSqueak(when, opts.glideFromMidi, midi, opts.glideDur);
    } else {
      // tension glide: start sharp, settle onto the pitch as the string's
      // energy decays (≈180ms open, ≈120ms palm). Later legato/bend automation
      // overrides this with an explicit value, so nothing accumulates.
      const glide = opts.pickless || !this.playerRules ? 0 : this.tensionGlideCents(midi, velocity, art);
      src.detune.setValueAtTime(shiftCents + glide, when);
      if (glide > 0) src.detune.setTargetAtTime(shiftCents, when, art === "palm" ? 0.04 : 0.06);
    }

    const strokeGain = stroke === "d" ? 1 : 0.93;

    // route: double-tracked palm/open notes split to hard-panned L/R chains
    const twinBuses = this.twinBuses();
    const doubled = this.doubleTrack && !this.diMode && (art === "palm" || art === "open") && !!twinBuses;
    const destNode: AudioNode = doubled
      ? (opts.isTwin ? twinBuses!.r : twinBuses!.l)
      : this.dest();

    const env = ctx.createGain();
    let out: AudioNode = env;
    if (!this.playerRules) {
      // plain sampler: the pre-Phase-0 static shelf on tight mutes, nothing else
      if (art === "palm" && this.muteStrength > 0.5) {
        const shelf = ctx.createBiquadFilter();
        shelf.type = "highshelf";
        shelf.frequency.value = 3000;
        shelf.gain.value = -14 * (this.muteStrength - 0.5) * 2;
        env.connect(shelf);
        out = shelf;
      }
    } else if (art === "palm") {
      // palm-mute pressure TRAJECTORY (Biral et al. 2014): the palm eases off
      // at the pick so the transient is bright, then re-clamps over 50–140ms.
      // Grip sets how far and how fast it closes; a harder pick keeps a
      // little more top. This replaces the old static high shelf.
      const m = this.muteStrength;
      const tone = ctx.createBiquadFilter();
      tone.type = "lowpass";
      tone.Q.value = 0.6;
      // the built-in chug source is dark (flatwound Bass VI: almost nothing
      // above 1 kHz), so a tight grip has to close well into the 400–1k band
      // to be audible; roundwound banks (GTX / custom) show the full sweep
      const endHz = 6000 * Math.pow(0.12, m) + 300 * velocity; // 0 → 6 kHz · 0.5 → 2.1 kHz · 1 → 0.7 kHz
      const closeS = 0.14 - 0.09 * m;
      tone.frequency.setValueAtTime(12000, when);
      tone.frequency.setValueAtTime(12000, when + 0.008);
      tone.frequency.exponentialRampToValueAtTime(endHz, when + 0.008 + closeS);
      env.connect(tone);
      out = tone;
    } else if (art === "dead") {
      const tone = ctx.createBiquadFilter();
      tone.type = "lowpass"; tone.frequency.value = 650; tone.Q.value = 0.7;
      env.connect(tone);
      out = tone;
    } else if (art === "open") {
      // dynamic-level lowpass (Jaffe & Smith): softer picks are darker
      const tone = ctx.createBiquadFilter();
      tone.type = "lowpass";
      tone.Q.value = 0.5;
      // accents live in 0.72–1.0, so map that band: 0.72 → ~3.5 kHz, 1.0 → ~10.8 kHz
      const v = Math.max(0, Math.min(1, (velocity - 0.5) / 0.5));
      tone.frequency.value = 1800 + 9000 * v * v;
      env.connect(tone);
      out = tone;
    }
    if (this.playerRules && art !== "dead" && !opts.pickless && !opts.glideDur) {
      out = this.pickPositionComb(out, midi, art, when);
    }
    if (art !== "dead") {
      // spectral stroke character (real stroke samples add to this)
      const color = this.strokeColor(stroke, this.playerRules ? (Math.random() - 0.5) * 1.2 : 0);
      out.connect(color);
      out = color;
    }
    src.connect(env);
    out.connect(destNode);

    // no per-hit normalization: velocity layers + accent scaling only
    const level = (0.55 + 0.45 * velocity) * strokeGain * (art === "dead" ? (this.instrument === "bass" ? 2.2 : 1.25) : 1);

    // PM decay: mute pressure sets the base, the gap to the next hit caps it
    let ring: number;
    if (art === "dead") ring = 0.16;
    else if (art === "pinch") ring = 1.6 + (opts.sustain ?? 0);
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
      articulation: art, vibrato: null, releaseAt: 0, holdUntil: 0, level: 0, startedAt: when,
    };
    // preserve the first 5-20ms pick transient: instant attack for picked hits
    if (attackOnly) {
      // sampled attack only: hold ~30 ms, then hand over to the string model
      const hold = art === "palm" ? 0.035 : 0.03;
      const end = art === "palm" ? 0.11 : 0.12;
      const g = v.env.gain;
      const lvlA = this.hybridSampleAttack ? level : 0.0001; // model-only: sampled pick muted
      g.setValueAtTime(Math.max(0.0001, opts.pickless ? 0.0001 : lvlA), when);
      if (opts.pickless) g.exponentialRampToValueAtTime(lvlA, when + 0.015);
      g.setValueAtTime(lvlA, when + hold);
      g.exponentialRampToValueAtTime(0.0001, when + end);
      v.holdUntil = when + hold;
      v.releaseAt = when + end;
    } else {
      // one-dynamic banks (Guitar-TECHS): a soft pick is the same recording
      // with its first 20 ms trimmed — less transient, same body — on top of
      // the darker tone filter and lower level it already gets
      const soft = this.playerRules && art === "open" && velocity < 0.86 ? 0.5 + 0.5 * ((velocity - 0.5) / 0.36) : 1;
      if (art === "dead") {
        // choked: instant attack, a 25 ms body, gone by ~110 ms
        v.level = level;
        v.env.gain.setValueAtTime(level, when);
        v.env.gain.setValueAtTime(level, when + 0.025);
        v.env.gain.exponentialRampToValueAtTime(0.0001, when + 0.11);
        v.holdUntil = when + 0.025; v.releaseAt = when + 0.11;
      } else {
        this.scheduleEnvelope(v, when, ring, level, opts.pickless ? 0.015 : 0, Math.max(0.45, Math.min(1, soft)));
      }
      if (!opts.isTwin && !opts.pickless) this.fretClank(when, midi, art, velocity);
    }
    src.start(when, opts.pickless && art === "open" ? 0.028 : 0);
    if (attackOnly) src.stop(v.releaseAt + 0.05);
    if (!opts.isTwin) this.floorSet(false, when + ring + 0.3);
    // no early src.stop: the envelope gates it, so legato can extend the voice
    if (!opts.isTwin && !attackOnly) {
      this.voices.set(si, v);
      let landed: StringVoice | null = null;
      if (art === "open" && opts.glideFromMidi !== undefined && opts.glideDur) landed = this.swapVoice(si, midi, 0, when + opts.glideDur, 0.06);
      if (opts.vibrato && (art === "open" || art === "pinch")) this.attachVibrato(landed ?? v, when + (opts.glideDur ?? 0.1));
      if (doubled) {
        // independent second take: own RR, own pick position, 2-6ms late,
        // its own velocity and a slow pitch drift (in shiftCents)
        this.pickNote(si, midi, when + 0.002 + Math.random() * 0.004, {
          ...opts, isTwin: true,
          velocity: Math.max(0.5, Math.min(1, velocity + (Math.random() - 0.5) * 0.08)),
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

    if (!(this.engineMode === "hybrid" && this.stringNode)) {
      // sampled engine: a tremolo stroke is a whole new note (round robin,
      // own pick) with a 12 ms handover from the one it stops — no stacked
      // snippets, no comb filtering, no machine-gun transient
      this.pickNote(si, midi, when, { articulation: art, velocity: velocity * 0.96, repick: true });
      return;
    }

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
      const o = this.openBuffer(midi, velocity, si);
      buffer = o.buffer;
      sampleMidi = o.root;
    }
    if (!buffer) return;

    let hybridStroke = false;
    if (this.engineMode === "hybrid" && this.stringNode && art !== "dead") {
      this.hybridRepick(si, midi, when, art, velocity, stroke, buffer, sampleMidi);
      hybridStroke = true; // the sampled stroke still supplies the transient
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (art !== "dead") {
      // anti-repetition: ±3 cents at the onset only, settling within ~40ms
      const base = (midi - sampleMidi) * 100;
      src.detune.setValueAtTime(base + (this.playerRules ? (Math.random() - 0.5) * 6 : 0), when);
      if (this.playerRules) src.detune.setTargetAtTime(base, when, 0.015);
    }

    const env = ctx.createGain();
    const strokeGain = stroke === "d" ? 1 : 0.93;
    // 0.82 headroom: strokes sum with the ringing body without buildup;
    // ±0.3dB per stroke so no two strokes are identical
    const level = (0.55 + 0.45 * velocity) * strokeGain * 0.82 * (this.playerRules ? Math.pow(10, (Math.random() - 0.5) * 0.06) : 1) * (hybridStroke ? 0.7 : 1);
    const bodyEnd = when + 0.055;
    const relEnd = bodyEnd + 0.08;
    env.gain.setValueAtTime(level, when); // instant attack, transient intact
    env.gain.setValueAtTime(level, bodyEnd);
    env.gain.exponentialRampToValueAtTime(0.0001, relEnd);

    let out: AudioNode = env;
    if (art !== "dead") {
      const color = this.strokeColor(stroke, this.playerRules ? (Math.random() - 0.5) * 1.6 : 0);
      out.connect(color);
      out = color;
    }
    const twinBuses = this.twinBuses();
    const doubled = this.doubleTrack && !this.diMode && art !== "dead" && !!twinBuses;
    src.connect(env);
    out.connect(doubled ? twinBuses!.l : this.dest());
    src.start(when);
    src.stop(relEnd + 0.05);

    // tail pool: keep at most 3 overlapping strokes per string
    const v: StringVoice = {
      src, env, sampleMidi, currentMidi: midi, bendCents: 0,
      articulation: art, vibrato: null, releaseAt: relEnd, holdUntil: bodyEnd, level, startedAt: when,
    };
    const pool = this.repickTails.get(si) ?? [];
    pool.push(v);
    while (pool.length > 3) this.fadeVoice(pool.shift()!, when, 0.012);
    this.repickTails.set(si, pool);

    // re-excite the sustaining body: each stroke keeps the string's resonance
    // alive instead of letting the original note's envelope die mid-tremolo.
    const body = hybridStroke ? undefined : this.voices.get(si);
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
        const { buffer: buf2, root } = this.openBuffer(midi, 0.9, si);
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
            articulation: "open", vibrato: null, releaseAt: when + 0.9, holdUntil: when + 0.25,
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
      const rr2 = art === "open" ? (this.openBuffer(midi, velocity).buffer ?? buffer) : buffer;
      if (rr2) {
        const s2 = ctx.createBufferSource();
        s2.buffer = rr2;
        s2.detune.value = (midi - sampleMidi) * 100 + (Math.random() * 3 + 1) * (Math.random() < 0.5 ? -1 : 1);
        const e2 = ctx.createGain();
        e2.gain.setValueAtTime(level, t2);
        e2.gain.setValueAtTime(level, t2 + 0.055);
        e2.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.135);
        s2.connect(e2).connect(twinBuses!.r);
        s2.start(t2);
        s2.stop(t2 + 0.19);
      }
    }
  }

  /**
   * Land on a REAL recording of the new pitch. A resampled voice is fine for
   * the 20-200 ms of a transition, but held shifted samples buzz (linear
   * interpolation imaging, then the amp), so once a bend, release, slide or
   * hammer-on settles we crossfade into a fresh sample of the target pitch
   * started past its pick. `heldMidi`/`heldCents` describe what the new voice
   * represents (a bent note keeps its original pitch + bendCents so a later
   * release still knows where home is).
   */
  // RMS of a buffer over `win` seconds starting at `offset` (for matching a
  // handover to what the outgoing recording is doing at that moment)
  private bufRms(buffer: AudioBuffer, offset: number, win = 0.04): number {
    const ch = buffer.getChannelData(0);
    const a = Math.max(0, Math.min(ch.length - 1, Math.round(offset * buffer.sampleRate)));
    const b = Math.min(ch.length, a + Math.round(win * buffer.sampleRate));
    if (b <= a) return 0;
    let e = 0;
    for (let i = a; i < b; i++) e += ch[i] * ch[i];
    return Math.sqrt(e / (b - a));
  }

  private swapVoice(si: number, heldMidi: number, heldCents: number, when: number, fadeS = 0.06, levelScale = 1): StringVoice | null {
    if (this.engineMode === "hybrid" || !this.legatoLandings) return null;
    const v = this.voices.get(si);
    if (!v || v.articulation !== "open") return null;
    const target = heldMidi + Math.round(heldCents / 100);
    const { buffer, root } = this.openBuffer(target, 0.9, si, 6);
    if (!buffer) return null;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.detune.value = (target - root) * 100;
    const env = ctx.createGain();
    const lvl = Math.max(0.0001, this.envAt(v, when) * levelScale);
    const ringLeft = Math.max(0.35, v.releaseAt - when);
    let usedLvl = lvl;
    // equal-power crossfade: two different recordings aren't phase-locked, so
    // a linear fade dips ~3 dB mid-way and the recovery reads as a soft attack
    const N = 33;
    const fadeIn = new Float32Array(N), fadeOut = new Float32Array(N);
    const applyIn = (g: AudioParam, target: number) => {
      for (let i = 0; i < N; i++) fadeIn[i] = target * Math.sin((i / (N - 1)) * Math.PI / 2);
      g.setValueCurveAtTime(fadeIn, when, fadeS);
      g.setValueAtTime(target, when + Math.max(fadeS, ringLeft * 0.7));
      g.exponentialRampToValueAtTime(0.0001, when + ringLeft);
    };
    applyIn(env.gain, lvl);
    const color = this.strokeColor(this.pickStroke ?? "d", 0);
    src.connect(env);
    env.connect(color);
    color.connect(this.dest());
    // start the fresh recording at the same point in ITS decay as the note it
    // replaces, so level and timbre match without guessing an envelope
    const elapsed = Math.max(0, when - v.startedAt);
    const offset = Math.min(0.03 + elapsed, Math.max(0.03, buffer.duration - 0.6));
    // different notes decay differently (an open string outlives a fretted
    // one), so match the incoming recording's energy to the outgoing one's
    // at their respective positions instead of trusting the offset alone
    const oldBuf = v.src.buffer;
    if (oldBuf) {
      const rOld = this.bufRms(oldBuf, elapsed + 0.03);
      const rNew = this.bufRms(buffer, offset);
      if (rOld > 1e-5 && rNew > 1e-5) {
        const ratio = Math.max(0.2, Math.min(3, rOld / rNew));
        env.gain.cancelScheduledValues(when);
        usedLvl = lvl * ratio;
        applyIn(env.gain, usedLvl);
      }
    }
    src.start(when, offset);
    src.stop(when + ringLeft + 0.1);
    // the shifted voice hands over
    try {
      const g = v.env.gain;
      g.cancelScheduledValues(when);
      for (let i = 0; i < N; i++) fadeOut[i] = lvl * Math.cos((i / (N - 1)) * Math.PI / 2);
      g.setValueCurveAtTime(fadeOut, when, fadeS);
      v.src.stop(when + fadeS + 0.05);
      if (v.vibrato) v.vibrato.lfo.stop(when + fadeS + 0.05);
    } catch {}
    const nv: StringVoice = {
      src, env, sampleMidi: root, currentMidi: heldMidi, bendCents: heldCents,
      articulation: "open", vibrato: null, releaseAt: when + ringLeft, level: usedLvl,
      holdUntil: when + Math.max(fadeS, ringLeft * 0.7),
      // startedAt is back-dated by the offset so a later swap keeps decaying from here
      startedAt: when - (offset - 0.03),
    };
    this.voices.set(si, nv);
    return nv;
  }

  /** Continue the ringing voice at a new pitch — one pick per phrase. */
  legatoTo(
    si: number, midi: number, when: number,
    style: "hammer" | "pull" | "tap",
    opts: { sustain?: number; vibrato?: boolean; velocity?: number } = {}
  ) {
    if (this.engineMode === "hybrid" && this.stringNode) { this.hybridLegato(si, midi, when, style, opts); return; }
    const v = this.voices.get(si);
    if (!v || v.articulation !== "open" || when > v.releaseAt - 0.03) {
      // documented fallback: no ringing source note → pickless new note
      this.pickNote(si, midi, when, { ...opts, pickless: true });
      if (this.voices.get(si)) this.fretImpact(when, style === "tap" ? 0.09 : 0.05);
      return;
    }
    // a pull-off releases the string onto the lower fret at once: no glide,
    // no level dip, no impact — those all read as a re-pick under gain
    const ramp = style === "hammer" ? 0.022 : style === "pull" ? 0.008 : 0.015;
    const target = (midi - v.sampleMidi) * 100;
    v.src.detune.cancelScheduledValues(when);
    v.src.detune.setValueAtTime((v.currentMidi - v.sampleMidi) * 100 + v.bendCents, when);
    v.src.detune.linearRampToValueAtTime(target, when + ramp);
    v.currentMidi = midi;
    v.bendCents = 0;
    // hammers/taps get a small fret-impact click; pulls get nothing
    if (style !== "pull") this.fretImpact(when, style === "tap" ? 0.08 : 0.04);
    // refresh the ring so the new note doesn't die on the old envelope
    const ring = 0.9 + (opts.sustain ?? 0);
    this.extendRing(v, when, ring, style === "pull" ? 0.92 : 0.97);
    const nv = this.swapVoice(si, midi, 0, when + ramp + 0.01, style === "pull" ? 0.09 : 0.05, style === "pull" ? 0.85 : 1);
    if (opts.vibrato) this.attachVibrato(nv ?? v, when + 0.08);
  }

  /** Bend the ringing note by `cents` (default +200); release with cents=0. */
  bendTo(
    si: number, when: number, cents: number, dur: number,
    opts: { sustain?: number; vibrato?: boolean; fallbackMidi?: number; velocity?: number } = {}
  ) {
    if (this.engineMode === "hybrid" && this.stringNode) { this.hybridBend(si, when, cents, dur, opts); return; }
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
    this.extendRing(v, when, ring, 1);
    const nv = this.swapVoice(si, v.currentMidi, cents, when + dur, 0.06);
    if (opts.vibrato) this.attachVibrato(nv ?? v, when + dur + 0.02);
  }

  /** Slide the ringing voice to a new pitch (same continuous machinery). */
  slideTo(
    si: number, midi: number, when: number, dur: number,
    opts: { sustain?: number; vibrato?: boolean; fromMidi?: number; velocity?: number } = {}
  ) {
    this.slideSqueak(when, opts.fromMidi ?? this.voices.get(si)?.currentMidi ?? midi - 2, midi, dur);
    if (this.engineMode === "hybrid" && this.stringNode) { this.hybridSlide(si, midi, when, dur, opts); return; }
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
    this.extendRing(v, when, ring, 0.95);
    const nv = this.swapVoice(si, midi, 0, when + dur, 0.06);
    if (opts.vibrato) this.attachVibrato(nv ?? v, when + dur + 0.02);
  }

  /** Vibrato on whatever is ringing (used when "~" follows legato/bends). */
  vibratoOn(si: number, when: number) {
    if (this.engineMode === "hybrid" && this.stringNode) { this.sset(si, SP.VIB_DEPTH, 30, 150, when); return; }
    const v = this.voices.get(si);
    if (v) this.attachVibrato(v, when);
  }

  // ---- hybrid string engine ---------------------------------------------------

  /** Load the wasm string model into an AudioWorklet (idempotent). */
  async enableHybrid(): Promise<boolean> {
    if (this.stringReady) return this.stringReady;
    this.stringReady = (async () => {
      try {
        await this.ready();
        const ctx = this.ctx;
        await ctx.audioWorklet.addModule("/string/string-processor.js");
        const wasmBinary = await fetch("/string/string-engine.wasm").then((r) => r.arrayBuffer());
        const node = new AudioWorkletNode(ctx, "string-processor", {
          numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
        });
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("string engine init timed out")), 8000);
          node.port.onmessage = (e) => {
            if (e.data.type === "ready") { clearTimeout(t); resolve(); }
            else if (e.data.type === "error") { clearTimeout(t); reject(new Error(e.data.error)); }
          };
          node.port.postMessage({ type: "init", wasmBinary, strings: 8 }, [wasmBinary]);
        });
        const out = ctx.createGain();
        out.gain.value = 0.5; // level-matched to the Guitar-TECHS voices (fit 2026-09-01)
        node.connect(out);
        this.stringNode = node;
        this.stringOut = out;
        this.routeString();
        for (let si = 0; si < 8; si++) this.stringDefaults(si);
        return true;
      } catch (e) {
        console.warn("hybrid string engine unavailable", e);
        return false;
      }
    })();
    return this.stringReady;
  }

  get hybridReady(): boolean { return !!this.stringNode; }

  setHybridSampleAttack(on: boolean) {
    this.hybridSampleAttack = on;
    for (let si = 0; si < 8; si++) this.sset(si, SP.DIRECT, on ? 0 : 0.45);
  }

  private routeString() {
    if (!this.stringOut) return;
    const d = this.dest();
    if (this.stringRouted === d) return;
    try { this.stringOut.disconnect(); } catch {}
    this.stringOut.connect(d);
    this.stringRouted = d;
  }

  private sset(si: number, param: number, value: number, ms = 0, when?: number, tag?: string) {
    this.stringNode?.port.postMessage({ type: "set", string: si, param, value, ms, when, tag });
  }

  // tab notes have a length: after `ring` seconds the fretting hand eases off
  // (a damping ramp, not a gate). Any later event on the string cancels it.
  private hybridNoteEnd(si: number, when: number, ring: number) {
    this.stringNode?.port.postMessage({ type: "cancel", string: si, tag: "end" });
    this.sset(si, SP.MUTE, 0.6, 150, when + ring, "end");
  }

  // per-string physics: lower strings are darker, stiffer (more dispersion),
  // looser (more tension glide) — Drop B on a 6-string, or a bass
  // values from a banded-spectrum fit of the model against the Guitar-TECHS
  // LP-humbucker DI low E (2026-09-01): dark loop, moderate loss, pickup 10%
  // from the bridge with a 5 kHz coil resonance, two polarisations
  private stringDefaults(si: number) {
    const low = Math.min(1, si / 5);
    this.sset(si, SP.BRIGHT, 0.22 - 0.07 * low);
    this.sset(si, SP.LOSS, 0.65);
    this.sset(si, SP.DISP, 0.06 + 0.08 * low);
    this.sset(si, SP.NONLIN, 0.04 + 0.03 * low);
    this.sset(si, SP.PICKPOS, 0.12);
    this.sset(si, SP.PICKUP, 0.1);
    this.sset(si, SP.PICKUP_HZ, 5000);
    this.sset(si, SP.PICKUP_Q, 1.2);
    this.sset(si, SP.TENSION, 4 + 6 * low);
    this.sset(si, SP.DIRECT, this.hybridSampleAttack ? 0 : 0.45);
    this.sset(si, SP.VIB_RATE, 5.5);
    this.sset(si, SP.POL_DETUNE, 2.5);
    this.sset(si, SP.POL_COUPLE, 0.03);
    this.sset(si, SP.POL_MIX, 0.5);
    this.sset(si, SP.GAIN, 1);
  }

  // the first `ms` of a DI sample, resampled to the target pitch, with a short
  // fade so the string loop takes over without a click
  private excitation(buffer: AudioBuffer, ms: number, ratio: number, offsetS = 0): Float32Array {
    const ch = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const n = Math.max(32, Math.min(Math.round((sr * ms) / 1000), 8192));
    const out = new Float32Array(n);
    const start = Math.round(offsetS * sr);
    for (let i = 0; i < n; i++) {
      const p = start + i * ratio;
      const i0 = Math.floor(p);
      const fr = p - i0;
      const a = ch[i0] ?? 0, b = ch[i0 + 1] ?? 0;
      out[i] = a + (b - a) * fr;
    }
    const fade = Math.min(n, Math.round(sr * 0.006));
    for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
    return out;
  }

  private hybridPick(
    si: number, midi: number, when: number, art: Articulation, velocity: number, stroke: "d" | "u",
    buffer: AudioBuffer, sampleMidi: number,
    opts: { pickless?: boolean; glideFromMidi?: number; glideDur?: number; vibrato?: boolean; sustain?: number }
  ) {
    this.routeString();
    const ratio = art === "dead" ? 1 : Math.pow(2, (midi - sampleMidi) / 12);
    const excMs = art === "palm" ? 35 : art === "dead" ? 40 : 24;
    const exc = this.excitation(buffer, excMs, ratio, opts.pickless && art === "open" ? 0.028 : 0);
    const f = midiToHz(midi);
    const m = this.muteStrength;
    const params: [number, number, number][] = [];
    if (opts.glideFromMidi !== undefined && opts.glideDur) {
      this.sset(si, SP.FREQ, midiToHz(opts.glideFromMidi), 0, when);
      params.push([SP.FREQ, f, opts.glideDur * 1000]);
    } else {
      params.push([SP.FREQ, f, 0]);
    }
    params.push([SP.VIB_DEPTH, 0, 0]);
    if (this.hybridSampleAttack) {
      // the sampled attack carries the first ~30 ms; the model fades in under it
      params.push([SP.GAIN, 0, 0]);
      this.sset(si, SP.GAIN, 1, 80, when + 0.02);
    } else {
      params.push([SP.GAIN, 1, 0]);
    }
    if (art === "palm") {
      // palm-pressure trajectory: lands early and hard, eases at the pick,
      // re-clamps to the grip over 50–140 ms
      this.sset(si, SP.MUTE, 0.9, 2, when - 0.004);
      params.push([SP.MUTE, 0.15 + 0.3 * m, 1]);
      this.sset(si, SP.MUTE, 0.35 + 0.6 * m, (0.14 - 0.09 * m) * 1000, when + 0.008);
    } else if (art === "dead") {
      params.push([SP.MUTE, 1, 0]);
    } else {
      params.push([SP.MUTE, 0, 8]);
    }
    const gain = (0.55 + 0.45 * velocity) * (stroke === "d" ? 1 : 0.93) * (art === "dead" ? 0.7 : 1) * (opts.pickless ? 0.6 : 1);
    // a fresh pick rests on the string first: most of the old ring is stopped
    const damp = opts.pickless ? 1 : 0.25;
    this.stringNode!.port.postMessage({ type: "pluck", string: si, when, exc, gain, damp, params }, [exc.buffer]);
    if (opts.vibrato && art === "open") this.sset(si, SP.VIB_DEPTH, 30, 150, when + (opts.glideDur ?? 0.1));
    const ring = art === "open" ? 1.1 + (opts.sustain ?? 0) + (opts.glideDur ?? 0) : 0.5;
    if (art === "open") this.hybridNoteEnd(si, when, ring);
    this.hybrid.set(si, { midi, art, until: when + ring, bendCents: 0 });
  }

  private hybridRepick(
    si: number, midi: number, when: number, art: Articulation, velocity: number, stroke: "d" | "u",
    buffer: AudioBuffer, sampleMidi: number
  ) {
    this.routeString();
    const h = this.hybrid.get(si);
    const ratio = art === "dead" ? 1 : Math.pow(2, (midi - sampleMidi) / 12);
    const exc = this.excitation(buffer, art === "open" ? 18 : 30, ratio);
    const params: [number, number, number][] = [];
    if (!h || h.midi !== midi) params.push([SP.FREQ, midiToHz(midi), 0]);
    if (art === "palm") params.push([SP.MUTE, 0.35 + 0.6 * this.muteStrength, 20]);
    const gain = (0.55 + 0.45 * velocity) * (stroke === "d" ? 1 : 0.93) * 0.8 * Math.pow(10, (Math.random() - 0.5) * 0.06);
    // tremolo: each stroke re-excites the SAME vibrating string, the pick
    // contact knocking down some of the energy so it never builds up
    this.stringNode!.port.postMessage({ type: "pluck", string: si, when, exc, gain, damp: 0.3, params }, [exc.buffer]);
    const ring = art === "open" ? 0.9 : 0.5;
    if (art === "open") this.hybridNoteEnd(si, when, ring);
    this.hybrid.set(si, { midi, art, until: when + ring, bendCents: 0 });
  }

  private hybridLegato(
    si: number, midi: number, when: number, style: "hammer" | "pull" | "tap",
    opts: { sustain?: number; vibrato?: boolean; velocity?: number }
  ) {
    const h = this.hybrid.get(si);
    if (!h || h.art !== "open" || when > h.until) {
      this.pickNote(si, midi, when, { ...opts, pickless: true });
      this.fretImpact(when, style === "tap" ? 0.09 : 0.05);
      return;
    }
    // the fret termination moves: pitch glides over 12–25 ms, plus the impact
    this.sset(si, SP.FREQ, midiToHz(midi), style === "hammer" ? 18 : style === "pull" ? 25 : 12, when);
    this.fretImpact(when, style === "tap" ? 0.08 : style === "hammer" ? 0.04 : 0.012);
    if (style === "pull") {
      // the finger leaving the string damps it briefly
      this.sset(si, SP.MUTE, 0.35, 0, when);
      this.sset(si, SP.MUTE, 0, 40, when + 0.005);
    }
    if (opts.vibrato) this.sset(si, SP.VIB_DEPTH, 30, 150, when + 0.08);
    const ring = 0.9 + (opts.sustain ?? 0);
    this.hybridNoteEnd(si, when, ring);
    h.midi = midi; h.bendCents = 0; h.until = when + ring;
  }

  private hybridBend(
    si: number, when: number, cents: number, dur: number,
    opts: { sustain?: number; vibrato?: boolean; fallbackMidi?: number; velocity?: number }
  ) {
    const h = this.hybrid.get(si);
    if (!h || h.art !== "open" || when > h.until) {
      if (opts.fallbackMidi !== undefined) {
        this.pickNote(si, opts.fallbackMidi, when, {
          ...opts, pickless: true, glideFromMidi: opts.fallbackMidi - cents / 100, glideDur: dur,
        });
      }
      return;
    }
    this.sset(si, SP.FREQ, midiToHz(h.midi) * Math.pow(2, cents / 1200), dur * 1000, when);
    const ring = Math.max(0.9, dur + 0.5) + (opts.sustain ?? 0);
    this.hybridNoteEnd(si, when, ring);
    h.bendCents = cents; h.until = when + ring;
    if (opts.vibrato) this.sset(si, SP.VIB_DEPTH, 30, 150, when + dur);
  }

  private hybridSlide(
    si: number, midi: number, when: number, dur: number,
    opts: { sustain?: number; vibrato?: boolean; fromMidi?: number; velocity?: number }
  ) {
    const h = this.hybrid.get(si);
    if (!h || h.art !== "open" || when > h.until) {
      this.pickNote(si, midi, when, { ...opts, pickless: true, glideFromMidi: opts.fromMidi ?? midi - 2, glideDur: dur });
      return;
    }
    this.sset(si, SP.FREQ, midiToHz(midi), dur * 1000, when);
    const ring = dur + 0.8 + (opts.sustain ?? 0);
    this.hybridNoteEnd(si, when, ring);
    h.midi = midi; h.bendCents = 0; h.until = when + ring;
    if (opts.vibrato) this.sset(si, SP.VIB_DEPTH, 30, 150, when + dur);
  }

  // ---- NAM ------------------------------------------------------------------

  private makeBoost(): { input: AudioNode; output: AudioNode } {
    const ctx = this.ctx;
    const pre = ctx.createBiquadFilter(); pre.type = "lowpass"; pre.frequency.value = 7500; pre.Q.value = 0.5; // pickup/cable roll-off
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.Q.value = 0.5;
    const mid = ctx.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 800; mid.Q.value = 0.7;
    const clip = ctx.createWaveShaper(); clip.oversample = "2x";
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 5500; lp.Q.value = 0.6;
    pre.connect(hp).connect(mid).connect(clip).connect(lp);
    const b = { hp, mid, clip, lp };
    this.boosts.push(b);
    this.applyBoost(b, this.tightAmt);
    return { input: pre, output: lp };
  }

  private applyBoost(b: { hp: BiquadFilterNode; mid: BiquadFilterNode; clip: WaveShaperNode; lp: BiquadFilterNode }, t: number) {
    b.hp.frequency.value = 90 + 260 * t;      // 90 Hz loose → 350 Hz surgically tight
    b.mid.gain.value = 2 + 5 * t;             // +2 … +7 dB at 800 Hz
    const k = 1.5 + 3 * t;                    // soft-clip drive: unity for small signals
    const N = 1024; const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * 2 - 1; curve[i] = Math.tanh(k * x) / k; }
    b.clip.curve = curve;
    b.lp.frequency.value = 5500 - 1500 * t;
  }

  /** DI level into the NAM model, 0.1–2 (1 = raw sample level). */
  setNamInput(x: number) {
    this.namInputTrim = Math.max(0.1, Math.min(2, x));
    if (this.namIn) this.namIn.gain.value = this.namInputTrim;
    for (const g of this.namTwinTrims) g.gain.value = this.namInputTrim;
  }

  get namInput(): number { return this.namInputTrim; }

  private routeNam(on: boolean) {
    if (!this.ampIn || !this.drive || !this.cab) return;
    try { this.ampIn.disconnect(); } catch {}
    if (on && this.namNode) {
      const ctx = this.ctx;
      if (!this.namMakeup) this.namMakeup = ctx.createGain();
      if (!this.namIn) { this.namIn = ctx.createGain(); this.namIn.gain.value = this.namInputTrim; }
      if (!this.namPost) {
        this.namPost = ctx.createGain();
        this.namPost.gain.value = 0.65 * this.level;
        this.namPost.connect(ctx.destination);
        if (this.analyser) this.namPost.connect(this.analyser);
      }
      if (!this.namCab) { this.namCab = ctx.createConvolver(); this.namCab.buffer = this.cab.buffer; }
      try { this.namIn.disconnect(); } catch {}
      try { this.namNode.disconnect(); } catch {}
      try { this.namMakeup.disconnect(); } catch {}
      try { this.namCab.disconnect(); } catch {}
      if (!this.namBoost) this.namBoost = this.makeBoost();
      try { this.namBoost.output.disconnect(); } catch {}
      this.ampIn.connect(this.namBoost.input);
      this.namBoost.output.connect(this.namIn);
      this.namIn.connect(this.namNode);
      this.namNode.connect(this.namMakeup);
      if (this.cabBypass) this.namMakeup.connect(this.namPost);
      else { this.namMakeup.connect(this.namCab); this.namCab.connect(this.namPost); }
    } else {
      if (this.namNode) { try { this.namNode.disconnect(); } catch {} }
      this.ampIn.connect(this.drive);
    }
  }

  private namModuleAdded: Promise<void> | null = null;

  // one capture instance: worklet node with the wasm engine initialised
  private async newNamNode(): Promise<AudioWorkletNode> {
    const ctx = this.ctx;
    if (!this.namModuleAdded) this.namModuleAdded = ctx.audioWorklet.addModule("/nam/nam-processor.js");
    await this.namModuleAdded;
    const wasmBinary = await fetch("/nam/nam.wasm").then((r) => r.arrayBuffer());
    const node = new AudioWorkletNode(ctx, "nam-processor", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("NAM engine init timed out")), 10000);
      node.port.onmessage = (e) => {
        if (e.data.type === "ready") { clearTimeout(t); resolve(); }
        else if (e.data.type === "error") { clearTimeout(t); reject(new Error(e.data.error)); }
      };
      node.port.postMessage({ type: "init", wasmBinary }, [wasmBinary]);
    });
    return node;
  }

  private loadModelInto(node: AudioWorkletNode, modelJson: string): Promise<{ ok: boolean; error?: string; loudness?: number | null }> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: "Model load timed out" }), 10000);
      node.port.onmessage = (e) => {
        if (e.data.type === "modelLoaded") {
          clearTimeout(t);
          resolve({ ok: e.data.success, error: e.data.error, loudness: e.data.loudness });
        } else if (e.data.type === "error") { clearTimeout(t); resolve({ ok: false, error: e.data.error }); }
      };
      node.port.postMessage({ type: "loadModel", modelJson });
    });
  }

  async loadNamModel(modelJson: string, name = "model"): Promise<{ ok: boolean; error?: string; loudness?: number | null }> {
    try {
      JSON.parse(modelJson);
    } catch {
      return { ok: false, error: "Not a valid .nam file (expected JSON)." };
    }
    await this.ready();
    if (!this.namNode) this.namNode = await this.newNamNode();
    const result = await this.loadModelInto(this.namNode, modelJson);
    if (result.ok) {
      this.namModelName = name;
      this.namJson = modelJson;
      this.routeNam(true);
      const TARGET_DB = -18;
      this.namMakeupDb =
        result.loudness !== null && result.loudness !== undefined && isFinite(result.loudness)
          ? Math.max(-12, Math.min(24, TARGET_DB - result.loudness))
          : 6;
      this.namMakeup!.gain.value = Math.pow(10, this.namMakeupDb / 20);
      // a new model invalidates the stereo instances; rebuild them if in use
      this.namStereoReady = null;
      if (this.doubleTrack) void this.ensureNamStereo();
    }
    return result;
  }

  // two more capture instances, hard-panned, each with its own boost and
  // fed by its own take (the twin voices), for double tracking through NAM
  private ensureNamStereo(): Promise<void> {
    if (this.namStereoReady) return this.namStereoReady;
    this.namStereoReady = (async () => {
      const json = this.namJson;
      if (!json || !this.cab) return;
      const ctx = this.ctx;
      const build = async (pan: number): Promise<GainNode> => {
        const bus = ctx.createGain();
        const boost = this.makeBoost();
        const trim = ctx.createGain(); trim.gain.value = this.namInputTrim;
        const node = await this.newNamNode();
        const r = await this.loadModelInto(node, json);
        if (!r.ok) throw new Error(r.error ?? "stereo model load failed");
        const makeup = ctx.createGain(); makeup.gain.value = Math.pow(10, this.namMakeupDb / 20);
        const cab = ctx.createConvolver(); cab.buffer = this.cab!.buffer;
        const panner = ctx.createStereoPanner(); panner.pan.value = pan;
        bus.connect(boost.input); boost.output.connect(trim); trim.connect(node); node.connect(makeup);
        if (this.cabBypass) makeup.connect(panner); else { makeup.connect(cab); cab.connect(panner); }
        panner.connect(this.namPost ?? ctx.destination);
        this.namTwinTrims.push(trim);
        return bus;
      };
      const [l, r] = await Promise.all([build(-0.8), build(0.8)]);
      this.namBusL = l; this.namBusR = r;
    })().catch((e) => { console.warn("NAM double tracking unavailable", e); this.namBusL = this.namBusR = null; });
    return this.namStereoReady;
  }
  private namTwinTrims: GainNode[] = [];

  bypassNam() {
    this.namModelName = null;
    this.namNode?.port.postMessage({ type: "bypass" });
    this.routeNam(false);
  }

}
