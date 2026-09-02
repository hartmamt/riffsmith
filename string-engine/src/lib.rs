//! RiffSmith string engine — digital-waveguide strings in one AudioWorklet,
//! excited by short sampled DI attacks. Single-threaded, no allocation after
//! init; plain C ABI so the worklet needs no bindgen glue.
//!
//! Each string is TWO single-delay-loop waveguides (vertical + horizontal
//! polarisation), slightly detuned and cross-coupled at the bridge, so the
//! note beats and decays in two stages the way a real string does. Per loop:
//!   excitation (sampled attack × pick-position comb) → [delay line]
//!   → damping one-pole (brightness, mute) → dispersion allpass chain
//!   → loss × mute loss × pick choke → curved-bridge nonlinearity
//!   → back into the delay.  Pickup = vertical + 0.5 × horizontal, minus the
//!   loop delayed by the pickup fraction (position comb), through a resonant
//!   2-pole (coil).  Tension modulation sharpens the pitch with loop energy.

#![allow(static_mut_refs)]

const MAX_STRINGS: usize = 8;
const DELAY_LEN: usize = 4096; // ≥ 48k / 30.9 Hz (B0) with headroom
const EXC_LEN: usize = 8192;   // up to ~170 ms of excitation at 48k
const BLOCK: usize = 128;
const AP_N: usize = 4;

// parameter ids (mirror in string-processor.js and lib/sampler.ts)
pub const P_FREQ: u32 = 0;        // Hz, smoothed (ms sets the ramp)
pub const P_BRIGHT: u32 = 1;      // 0..1 loop damping cutoff
pub const P_LOSS: u32 = 2;        // 0..1 loop gain (0.985..0.9999 mapped inside)
pub const P_DISP: u32 = 3;        // 0..1 dispersion (inharmonicity)
pub const P_NONLIN: u32 = 4;      // 0..1 curved-bridge amount
pub const P_MUTE: u32 = 5;        // 0..1 palm pressure (extra loss + darkening)
pub const P_PICKPOS: u32 = 6;     // 0..0.5 fraction of string length
pub const P_PICKUP: u32 = 7;      // 0..0.5 fraction of string length
pub const P_PICKUP_HZ: u32 = 8;   // coil resonance Hz
pub const P_PICKUP_Q: u32 = 9;    // coil resonance Q
pub const P_TENSION: u32 = 10;    // cents of sharpening at full energy
pub const P_DIRECT: u32 = 11;     // dry excitation mix into the output
pub const P_VIB_DEPTH: u32 = 12;  // cents
pub const P_VIB_RATE: u32 = 13;   // Hz
pub const P_GAIN: u32 = 14;       // output gain (smoothed)
pub const P_POL_DETUNE: u32 = 15; // horizontal polarisation detune, cents
pub const P_POL_COUPLE: u32 = 16; // bridge coupling between polarisations 0..0.2
pub const P_POL_MIX: u32 = 17;    // how much the pickup senses the horizontal loop

#[derive(Clone, Copy)]
struct Smooth { cur: f32, target: f32, coef: f32 }
impl Smooth {
    const fn new(v: f32) -> Self { Smooth { cur: v, target: v, coef: 1.0 } }
    #[inline] fn tick(&mut self) -> f32 { self.cur += (self.target - self.cur) * self.coef; self.cur }
    fn set(&mut self, target: f32, ms: f32, sr: f32) {
        self.target = target;
        // reach ~99% of the target after `ms` (five time constants)
        self.coef = if ms <= 0.0 { 1.0 } else { 1.0 - (-5.0 / (ms * 0.001 * sr)).exp() };
        if ms <= 0.0 { self.cur = target; }
    }
}

/// One single-delay-loop waveguide.
struct Loop {
    buf: [f32; DELAY_LEN],
    w: usize,
    lp: f32,
    ap_x: [f32; AP_N],
    ap_y: [f32; AP_N],
}

impl Loop {
    const fn new() -> Self { Loop { buf: [0.0; DELAY_LEN], w: 0, lp: 0.0, ap_x: [0.0; AP_N], ap_y: [0.0; AP_N] } }

    fn clear(&mut self) {
        self.buf = [0.0; DELAY_LEN];
        self.lp = 0.0; self.ap_x = [0.0; AP_N]; self.ap_y = [0.0; AP_N];
    }

    #[inline]
    fn last(&self) -> f32 { self.buf[(self.w + DELAY_LEN - 1) % DELAY_LEN] }

    #[inline]
    fn read(&self, delay: f32) -> f32 {
        // 4-point Hermite interpolation at (w - delay)
        let d = delay.max(2.0).min((DELAY_LEN - 4) as f32);
        let di = d as usize;
        let fr = d - di as f32;
        let i0 = (self.w + DELAY_LEN - di) % DELAY_LEN;
        let xm1 = self.buf[(i0 + 1) % DELAY_LEN];
        let x0 = self.buf[i0];
        let x1 = self.buf[(i0 + DELAY_LEN - 1) % DELAY_LEN];
        let x2 = self.buf[(i0 + DELAY_LEN - 2) % DELAY_LEN];
        let c = (x1 - xm1) * 0.5;
        let v = x0 - x1;
        let w = c + v;
        let a = w + v + (x2 - x0) * 0.5;
        let b = w + a;
        (((a * fr) - b) * fr + c) * fr + x0
    }

    /// Read at `delay`, filter (damping one-pole + dispersion allpasses) and
    /// scale by the loop gain `g`. Does not write: the caller mixes the two
    /// polarisations at the bridge first.
    #[inline]
    fn filt(&mut self, delay: f32, a: f32, c: f32, g: f32) -> f32 {
        let y = self.read(delay);
        self.lp += a * (y - self.lp);
        let mut s = self.lp;
        for k in 0..AP_N {
            let yk = -c * s + self.ap_x[k] + c * self.ap_y[k];
            self.ap_x[k] = s;
            self.ap_y[k] = yk;
            s = yk;
        }
        s * g
    }

    #[inline]
    fn write(&mut self, v: f32) {
        self.buf[self.w] = v;
        self.w = (self.w + 1) % DELAY_LEN;
    }
}

struct Str {
    v: Loop,   // vertical polarisation (what the pickup mostly senses)
    h: Loop,   // horizontal polarisation (slower decay, slightly detuned)
    freq: Smooth,
    bright: Smooth,
    loss: Smooth,
    disp: Smooth,
    nonlin: Smooth,
    mute: Smooth,
    gain: Smooth,
    pickpos: f32,
    pickup: f32,
    pickup_hz: f32,
    pickup_q: f32,
    tension: f32,
    direct: f32,
    vib_depth: f32,
    vib_rate: f32,
    vib_phase: f32,
    pol_detune: f32,
    pol_couple: f32,
    pol_mix: f32,
    // pickup filter state
    svf_lp: f32,
    svf_bp: f32,
    energy: f32,
    // excitation
    exc: [f32; EXC_LEN],
    exc_len: usize,
    exc_pos: usize,
    exc_gain: f32,
    exc_comb_delay: usize,
    choke: f32,          // extra per-sample loop loss while the pick rests on the string
    choke_left: u32,     // samples of choke remaining
    active: bool,
}

impl Str {
    const fn new() -> Self {
        Str {
            v: Loop::new(), h: Loop::new(),
            freq: Smooth::new(61.74), bright: Smooth::new(0.12), loss: Smooth::new(0.95),
            disp: Smooth::new(0.1), nonlin: Smooth::new(0.05), mute: Smooth::new(0.0), gain: Smooth::new(1.0),
            pickpos: 0.12, pickup: 0.07, pickup_hz: 3200.0, pickup_q: 0.7, tension: 8.0,
            direct: 0.3, vib_depth: 0.0, vib_rate: 5.5, vib_phase: 0.0,
            pol_detune: 2.5, pol_couple: 0.03, pol_mix: 0.5,
            svf_lp: 0.0, svf_bp: 0.0, energy: 0.0,
            exc: [0.0; EXC_LEN], exc_len: 0, exc_pos: 0, exc_gain: 1.0, exc_comb_delay: 0,
            choke: 1.0, choke_left: 0,
            active: false,
        }
    }

    #[inline]
    fn process(&mut self, sr: f32, out: &mut [f32]) {
        if !self.active { return; }
        let mut peak = 0.0f32;
        for o in out.iter_mut() {
            let f = self.freq.tick();
            let bright = self.bright.tick();
            let loss = self.loss.tick();
            let disp = self.disp.tick();
            let nonlin = self.nonlin.tick();
            let mute = self.mute.tick();
            let gain = self.gain.tick();

            // vibrato + tension modulation on the delay length
            self.vib_phase += self.vib_rate / sr;
            if self.vib_phase >= 1.0 { self.vib_phase -= 1.0; }
            let vib = if self.vib_depth > 0.0 { (self.vib_phase * core::f32::consts::TAU).sin() * self.vib_depth } else { 0.0 };
            let energy_norm = (self.energy * 8.0).min(1.0);
            let cents = vib + self.tension * energy_norm;
            let f_v = f * (2.0f32).powf(cents / 1200.0);
            let f_h = f_v * (2.0f32).powf(self.pol_detune / 1200.0);

            // loop filters: damping one-pole (brightness, mute) + dispersion
            let cutoff = (1200.0 + 14000.0 * bright * bright) * (1.0 - 0.9 * mute);
            let a = 1.0 - (-core::f32::consts::TAU * cutoff / sr).exp();
            let c = disp * 0.7;
            // loop length minus the low-frequency group delay of those filters
            let gd = (1.0 - a) / a + AP_N as f32 * (1.0 + c) / (1.0 - c);
            // curved bridge: the rectified signal shortens the delay a little
            let bridge = nonlin * 6.0 * self.v.last().abs().min(1.0);
            let delay_v = sr / f_v - gd - bridge;
            let delay_h = sr / f_h - gd;

            // loss: 0..1 → per-loop gain. loss=1 ≈ T60 of 5 s on the low B,
            // loss=0.5 ≈ 1 s. Mute adds loss (palm as a lossy contact: full
            // pressure takes ~20 dB per 6 loops). The horizontal polarisation
            // loses less, so it carries the aftersound.
            let base = 0.985 + 0.0128 * loss;
            let mut g_v = base * (1.0 - 0.35 * mute);
            let mut g_h = (1.0 - 0.7 * (1.0 - base)) * (1.0 - 0.35 * mute);
            if self.choke_left > 0 { g_v *= self.choke; g_h *= self.choke; self.choke_left -= 1; }

            // excitation in (with pick-position comb); the pick moves the
            // string mostly vertically
            let mut x = 0.0;
            if self.exc_pos < self.exc_len {
                let e = self.exc[self.exc_pos] * self.exc_gain;
                let d = self.exc_comb_delay;
                let e_d = if self.exc_pos >= d && d > 0 { self.exc[self.exc_pos - d] * self.exc_gain } else { 0.0 };
                x = e - 0.5 * e_d;
                self.exc_pos += 1;
            }

            // bridge coupling as a passive exchange (eigenvalues 1 and 1-2k):
            // energy moves between polarisations, never appears from nowhere
            let k = self.pol_couple;
            let sv = self.v.filt(delay_v, a, c, g_v);
            let sh = self.h.filt(delay_h, a, c, g_h);
            let yv = (1.0 - k) * sv + k * sh + x;
            let yh = (1.0 - k) * sh + k * sv + 0.35 * x;
            self.v.write(yv);
            self.h.write(yh);

            // energy tracker for tension modulation (loop amplitude ~0.1-0.3
            // after a hard pick, so ×8 puts a hard pick near full sharpening)
            self.energy += (yv * yv - self.energy) * 0.002;

            // pickup: position comb + coil resonance (SVF, 2-pole)
            let sensed = yv + self.pol_mix * yh;
            let tapped = sensed - (self.v.read(self.pickup * delay_v) + self.pol_mix * self.h.read(self.pickup * delay_h));
            let fc = self.pickup_hz.min(sr * 0.45);
            let f1 = 2.0 * (core::f32::consts::PI * fc / sr).sin();
            let q1 = 1.0 / self.pickup_q.max(0.3);
            let hp = tapped - self.svf_lp - q1 * self.svf_bp;
            self.svf_bp += f1 * hp;
            self.svf_lp += f1 * self.svf_bp;
            let pick = self.svf_lp + 0.35 * self.svf_bp;

            let out_s = (pick + x * self.direct) * gain;
            *o += out_s;
            let m = out_s.abs();
            if m > peak { peak = m; }
        }
        // sleep when silent and no excitation pending
        if peak < 1e-6 && self.exc_pos >= self.exc_len && self.energy < 1e-10 { self.active = false; }
    }
}

struct Engine {
    sr: f32,
    n: usize,
    strings: [Str; MAX_STRINGS],
    out: [f32; BLOCK],
    exc_in: [f32; EXC_LEN],
}

// Uninitialised static: keeps the string buffers out of the wasm data
// segment. se_init must run before anything else (the worklet does).
static mut ENGINE_MEM: core::mem::MaybeUninit<Engine> = core::mem::MaybeUninit::uninit();
#[inline(always)]
fn engine() -> &'static mut Engine { unsafe { &mut *ENGINE_MEM.as_mut_ptr() } }

#[no_mangle]
pub extern "C" fn se_init(sr: f32, n: u32) {
    unsafe {
        let p = ENGINE_MEM.as_mut_ptr();
        core::ptr::write(p, Engine {
            sr,
            n: (n as usize).min(MAX_STRINGS).max(1),
            strings: [Str::new(), Str::new(), Str::new(), Str::new(), Str::new(), Str::new(), Str::new(), Str::new()],
            out: [0.0; BLOCK],
            exc_in: [0.0; EXC_LEN],
        });
    }
}

#[no_mangle]
pub extern "C" fn se_out_ptr() -> *mut f32 { engine().out.as_mut_ptr() }

#[no_mangle]
pub extern "C" fn se_exc_ptr() -> *mut f32 { engine().exc_in.as_mut_ptr() }

#[no_mangle]
pub extern "C" fn se_exc_max() -> u32 { EXC_LEN as u32 }

/// Set a parameter; `ms` is the smoothing time (0 = jump).
#[no_mangle]
pub extern "C" fn se_set(string: u32, param: u32, value: f32, ms: f32) {
    let e = engine();
    let sr = e.sr;
    let si = string as usize;
    if si >= e.n { return; }
    let s = &mut e.strings[si];
    match param {
        P_FREQ => s.freq.set(value.max(20.0), ms, sr),
        P_BRIGHT => s.bright.set(value.clamp(0.0, 1.0), ms, sr),
        P_LOSS => s.loss.set(value.clamp(0.0, 1.0), ms, sr),
        P_DISP => s.disp.set(value.clamp(0.0, 1.0), ms, sr),
        P_NONLIN => s.nonlin.set(value.clamp(0.0, 1.0), ms, sr),
        P_MUTE => s.mute.set(value.clamp(0.0, 1.0), ms, sr),
        P_GAIN => s.gain.set(value.clamp(0.0, 4.0), ms, sr),
        P_PICKPOS => s.pickpos = value.clamp(0.02, 0.5),
        P_PICKUP => s.pickup = value.clamp(0.02, 0.5),
        P_PICKUP_HZ => s.pickup_hz = value.clamp(500.0, 12000.0),
        P_PICKUP_Q => s.pickup_q = value.clamp(0.3, 8.0),
        P_TENSION => s.tension = value.clamp(0.0, 60.0),
        P_DIRECT => s.direct = value.clamp(0.0, 2.0),
        P_VIB_DEPTH => s.vib_depth = value.clamp(0.0, 200.0),
        P_VIB_RATE => s.vib_rate = value.clamp(0.1, 12.0),
        P_POL_DETUNE => s.pol_detune = value.clamp(0.0, 20.0),
        P_POL_COUPLE => s.pol_couple = value.clamp(0.0, 0.2),
        P_POL_MIX => s.pol_mix = value.clamp(0.0, 1.0),
        _ => {}
    }
}

/// Excite string `string` with the `len` samples the host copied into the
/// excitation buffer, scaled by `gain`. `damp` (0..1) is how much of the
/// old vibration survives the pick landing on the string (applied as a
/// short extra loss, never as a discontinuity). Re-exciting a ringing
/// string keeps its state (tremolo, chugs on a ringing note).
#[no_mangle]
pub extern "C" fn se_pluck(string: u32, len: u32, gain: f32, damp: f32) {
    let e = engine();
    let si = string as usize;
    if si >= e.n { return; }
    let n = (len as usize).min(EXC_LEN);
    let s = &mut e.strings[si];
    let d = damp.clamp(0.0, 1.0);
    if d < 1.0 {
        let period = e.sr / s.freq.target.max(20.0);
        let nn = (period * 1.5) as u32;
        s.choke = d.max(1e-3).powf(1.0 / nn.max(1) as f32);
        s.choke_left = nn;
        s.energy *= d * d;
    }
    s.exc[..n].copy_from_slice(&e.exc_in[..n]);
    s.exc_len = n;
    s.exc_pos = 0;
    s.exc_gain = gain;
    let period = e.sr / s.freq.target.max(20.0);
    s.exc_comb_delay = ((2.0 * s.pickpos * period) as usize).min(EXC_LEN / 2);
    s.active = true;
}

/// Hard stop: clear the loops (used for panic / all-notes-off).
#[no_mangle]
pub extern "C" fn se_clear(string: u32) {
    let e = engine();
    let si = string as usize;
    if si >= e.n { return; }
    let s = &mut e.strings[si];
    s.v.clear(); s.h.clear();
    s.svf_lp = 0.0; s.svf_bp = 0.0;
    s.energy = 0.0; s.exc_len = 0; s.exc_pos = 0; s.choke_left = 0; s.active = false;
}

/// Render `frames` (≤ 128) into the output buffer (mono, summed strings).
#[no_mangle]
pub extern "C" fn se_process(frames: u32) {
    let e = engine();
    let n = (frames as usize).min(BLOCK);
    for v in e.out[..n].iter_mut() { *v = 0.0; }
    let sr = e.sr;
    for si in 0..e.n {
        e.strings[si].process(sr, &mut e.out[..n]);
    }
}

#[no_mangle]
pub extern "C" fn se_active(string: u32) -> u32 {
    let e = engine();
    let si = string as usize;
    if si >= e.n { return 0; }
    e.strings[si].active as u32
}
