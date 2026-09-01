//! RiffSmith string engine — six (or more) digital-waveguide strings in one
//! AudioWorklet, excited by short sampled DI attacks. Single-threaded, no
//! allocation after init; plain C ABI so the worklet needs no bindgen glue.
//!
//! Topology per string (single delay loop, Mutable-Instruments-style):
//!   excitation (sampled attack × pick-position comb) → [delay line]
//!   → damping one-pole (brightness, mute) → dispersion allpass chain
//!   → loss × mute loss → curved-bridge nonlinearity (|y| shortens the delay)
//!   → back into the delay.  Pickup = loop − loop delayed by the pickup
//!   fraction (position comb) → resonant 2-pole (coil).  Tension modulation
//!   sharpens the pitch with loop energy.

#![allow(static_mut_refs)]

const MAX_STRINGS: usize = 8;
const DELAY_LEN: usize = 4096; // ≥ 48k / 30.9 Hz (B0) with headroom
const EXC_LEN: usize = 8192;   // up to ~170 ms of excitation at 48k
const BLOCK: usize = 128;

// parameter ids (mirror in string-processor.js)
pub const P_FREQ: u32 = 0;        // Hz, smoothed (glide_ms sets the ramp)
pub const P_BRIGHT: u32 = 1;      // 0..1 loop damping cutoff
pub const P_LOSS: u32 = 2;        // 0..1 loop gain (0.99..0.9999 mapped inside)
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
pub const P_GAIN: u32 = 14;       // output gain

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

struct Str {
    buf: [f32; DELAY_LEN],
    w: usize,
    freq: Smooth,
    bright: Smooth,
    loss: Smooth,
    disp: Smooth,
    nonlin: Smooth,
    mute: Smooth,
    pickpos: f32,
    pickup: f32,
    pickup_hz: f32,
    pickup_q: f32,
    tension: f32,
    direct: f32,
    vib_depth: f32,
    vib_rate: f32,
    vib_phase: f32,
    gain: f32,
    // filter states
    lp: f32,
    ap_x: [f32; 4],
    ap_y: [f32; 4],
    svf_lp: f32,
    svf_bp: f32,
    energy: f32,
    // excitation
    exc: [f32; EXC_LEN],
    exc_len: usize,
    exc_pos: usize,
    exc_gain: f32,
    exc_comb_delay: usize,
    active: bool,
}

impl Str {
    const fn new() -> Self {
        Str {
            buf: [0.0; DELAY_LEN], w: 0,
            freq: Smooth::new(61.74), bright: Smooth::new(0.6), loss: Smooth::new(0.6),
            disp: Smooth::new(0.15), nonlin: Smooth::new(0.15), mute: Smooth::new(0.0),
            pickpos: 0.13, pickup: 0.08, pickup_hz: 3200.0, pickup_q: 1.6, tension: 12.0,
            direct: 0.35, vib_depth: 0.0, vib_rate: 5.5, vib_phase: 0.0, gain: 1.0,
            lp: 0.0, ap_x: [0.0; 4], ap_y: [0.0; 4], svf_lp: 0.0, svf_bp: 0.0, energy: 0.0,
            exc: [0.0; EXC_LEN], exc_len: 0, exc_pos: 0, exc_gain: 1.0, exc_comb_delay: 0,
            active: false,
        }
    }

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

            // vibrato + tension modulation on the delay length
            self.vib_phase += self.vib_rate / sr;
            if self.vib_phase >= 1.0 { self.vib_phase -= 1.0; }
            let vib = if self.vib_depth > 0.0 { (self.vib_phase * core::f32::consts::TAU).sin() * self.vib_depth } else { 0.0 };
            let energy_norm = (self.energy * 40.0).min(1.0);
            let cents = vib + self.tension * energy_norm;
            let f_eff = f * (2.0f32).powf(cents / 1200.0);
            // loop length minus the low-frequency group delay of the loop filters:
            // one-pole lowpass ≈ (1-a)/a samples, each first-order allpass (1+c)/(1-c)
            let cutoff = (1200.0 + 14000.0 * bright * bright) * (1.0 - 0.9 * mute);
            let a = 1.0 - (-core::f32::consts::TAU * cutoff / sr).exp();
            let c = disp * 0.7;
            let gd = (1.0 - a) / a + 4.0 * (1.0 + c) / (1.0 - c);
            let mut delay = sr / f_eff - gd;

            // curved bridge: the rectified signal shortens the delay a little
            let last = self.buf[(self.w + DELAY_LEN - 1) % DELAY_LEN];
            delay -= nonlin * 6.0 * last.abs().min(1.0);

            let y = self.read(delay);

            // damping one-pole: brightness → cutoff; mute darkens further
            self.lp += a * (y - self.lp);
            let mut s = self.lp;

            // dispersion: chain of first-order allpasses
            for k in 0..4 {
                let yk = -c * s + self.ap_x[k] + c * self.ap_y[k];
                self.ap_x[k] = s;
                self.ap_y[k] = yk;
                s = yk;
            }

            // loss: 0..1 → per-loop gain; mute adds loss (palm as a lossy contact:
            // full pressure takes ~20 dB per 6 loops, i.e. a 100 ms chug on low B)
            let base = 0.985 + 0.0149 * loss;
            let g = base * (1.0 - 0.35 * mute);
            s *= g;

            // excitation in (with pick-position comb)
            let mut x = 0.0;
            if self.exc_pos < self.exc_len {
                let e = self.exc[self.exc_pos] * self.exc_gain;
                let d = self.exc_comb_delay;
                let e_d = if self.exc_pos >= d && d > 0 { self.exc[self.exc_pos - d] * self.exc_gain } else { 0.0 };
                x = e - 0.5 * e_d;
                self.exc_pos += 1;
            }

            let v = s + x;
            self.buf[self.w] = v;
            self.w = (self.w + 1) % DELAY_LEN;

            // energy tracker for tension modulation
            self.energy += (v * v - self.energy) * 0.002;

            // pickup: position comb + coil resonance (SVF, 2-pole)
            let tapped = v - self.read(self.pickup * delay);
            let fc = self.pickup_hz.min(sr * 0.45);
            let f1 = 2.0 * (core::f32::consts::PI * fc / sr).sin();
            let q1 = 1.0 / self.pickup_q.max(0.3);
            let hp = tapped - self.svf_lp - q1 * self.svf_bp;
            self.svf_bp += f1 * hp;
            self.svf_lp += f1 * self.svf_bp;
            let pick = self.svf_lp + 0.35 * self.svf_bp;

            let out_s = (pick + x * self.direct) * self.gain;
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

// Uninitialised static: keeps the ~450 KB of string buffers out of the wasm
// data segment. se_init must run before anything else (the worklet does).
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
        P_PICKPOS => s.pickpos = value.clamp(0.02, 0.5),
        P_PICKUP => s.pickup = value.clamp(0.02, 0.5),
        P_PICKUP_HZ => s.pickup_hz = value.clamp(500.0, 12000.0),
        P_PICKUP_Q => s.pickup_q = value.clamp(0.3, 8.0),
        P_TENSION => s.tension = value.clamp(0.0, 60.0),
        P_DIRECT => s.direct = value.clamp(0.0, 2.0),
        P_VIB_DEPTH => s.vib_depth = value.clamp(0.0, 200.0),
        P_VIB_RATE => s.vib_rate = value.clamp(0.1, 12.0),
        P_GAIN => s.gain = value.clamp(0.0, 4.0),
        _ => {}
    }
}

/// Excite string `string` with the `len` samples the host copied into the
/// excitation buffer, scaled by `gain`. Re-exciting a ringing string keeps its
/// state (tremolo, chugs on a ringing note).
#[no_mangle]
pub extern "C" fn se_pluck(string: u32, len: u32, gain: f32, damp: f32) {
    let e = engine();
    let si = string as usize;
    if si >= e.n { return; }
    let n = (len as usize).min(EXC_LEN);
    let s = &mut e.strings[si];
    // the pick touches the string before it releases it: scale whatever is
    // still ringing (1 = untouched, 0 = fully stopped)
    let d = damp.clamp(0.0, 1.0);
    if d < 1.0 {
        for v in s.buf.iter_mut() { *v *= d; }
        s.lp *= d; s.svf_lp *= d; s.svf_bp *= d;
        for k in 0..4 { s.ap_x[k] *= d; s.ap_y[k] *= d; }
        s.energy *= d * d;
    }
    s.exc[..n].copy_from_slice(&e.exc_in[..n]);
    s.exc_len = n;
    s.exc_pos = 0;
    s.exc_gain = gain;
    // pick-position comb delay in samples: 2 × pickpos × period
    let period = e.sr / s.freq.target.max(20.0);
    s.exc_comb_delay = ((2.0 * s.pickpos * period) as usize).min(EXC_LEN / 2);
    s.active = true;
}

/// Hard stop: clear the loop (used for panic / all-notes-off).
#[no_mangle]
pub extern "C" fn se_clear(string: u32) {
    let e = engine();
    let si = string as usize;
    if si >= e.n { return; }
    let s = &mut e.strings[si];
    s.buf = [0.0; DELAY_LEN];
    s.lp = 0.0; s.ap_x = [0.0; 4]; s.ap_y = [0.0; 4]; s.svf_lp = 0.0; s.svf_bp = 0.0;
    s.energy = 0.0; s.exc_len = 0; s.exc_pos = 0; s.active = false;
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
