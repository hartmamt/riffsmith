// RiffSmith hybrid string engine — AudioWorklet host for string-engine.wasm.
//
// One node holds every string. The main thread sends timestamped events
// (AudioContext time); events are applied sample-accurately by splitting the
// 128-frame render quantum at each event's frame. Excitation samples travel
// with the pluck event and are copied into wasm memory just before the call.

const P = {
  FREQ: 0, BRIGHT: 1, LOSS: 2, DISP: 3, NONLIN: 4, MUTE: 5, PICKPOS: 6, PICKUP: 7,
  PICKUP_HZ: 8, PICKUP_Q: 9, TENSION: 10, DIRECT: 11, VIB_DEPTH: 12, VIB_RATE: 13, GAIN: 14,
};

class StringProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.queue = []; // { frame, apply() }
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  async onMessage(m) {
    if (m.type === "init") {
      try {
        const { instance } = await WebAssembly.instantiate(m.wasmBinary, {});
        this.wasm = instance.exports;
        this.mem = this.wasm.memory;
        this.nStrings = m.strings || 6;
        this.wasm.se_init(sampleRate, this.nStrings);
        this.outPtr = this.wasm.se_out_ptr();
        this.excPtr = this.wasm.se_exc_ptr();
        this.excMax = this.wasm.se_exc_max();
        this.refreshViews();
        this.ready = true;
        this.port.postMessage({ type: "ready" });
      } catch (err) {
        this.port.postMessage({ type: "error", error: String(err && err.message ? err.message : err) });
      }
      return;
    }
    if (!this.ready) return;
    const frame = m.when === undefined ? 0 : Math.max(0, Math.round((m.when - currentTime) * sampleRate));
    if (m.type === "cancel") {
      // drop queued events carrying this tag for this string (e.g. a note-end
      // damping that a later legato/bend has made obsolete)
      this.queue = this.queue.filter((q) => !(q.tag === m.tag && q.string === m.string));
      return;
    }
    if (m.type === "set") {
      this.queue.push({ frame, tag: m.tag, string: m.string, run: () => this.wasm.se_set(m.string, m.param, m.value, m.ms || 0) });
    } else if (m.type === "pluck") {
      const exc = m.exc; // Float32Array (transferred)
      this.queue.push({
        frame,
        run: () => {
          if (m.params) for (const [param, value, ms] of m.params) this.wasm.se_set(m.string, param, value, ms || 0);
          if (exc && exc.length) {
            const n = Math.min(exc.length, this.excMax);
            this.refreshViews();
            this.excView.set(exc.subarray(0, n));
            this.wasm.se_pluck(m.string, n, m.gain === undefined ? 1 : m.gain, m.damp === undefined ? 1 : m.damp);
          }
        },
      });
    } else if (m.type === "clear") {
      this.queue.push({ frame, run: () => this.wasm.se_clear(m.string) });
    } else if (m.type === "clearAll") {
      this.queue.push({ frame, run: () => { for (let s = 0; s < this.nStrings; s++) this.wasm.se_clear(s); } });
    }
    this.queue.sort((a, b) => a.frame - b.frame);
  }

  refreshViews() {
    // wasm memory may grow; re-create views lazily
    if (!this.excView || this.excView.buffer !== this.mem.buffer) {
      this.excView = new Float32Array(this.mem.buffer, this.excPtr, this.excMax);
    }
    if (!this.outView || this.outView.buffer !== this.mem.buffer) {
      this.outView = new Float32Array(this.mem.buffer, this.outPtr, 128);
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    if (!this.ready) { out.fill(0); return true; }
    const frames = out.length;
    let done = 0;
    while (done < frames) {
      // apply every event due at this frame
      while (this.queue.length && this.queue[0].frame <= done) this.queue.shift().run();
      const next = this.queue.length ? Math.min(frames, this.queue[0].frame) : frames;
      const n = next - done;
      if (n > 0) {
        this.wasm.se_process(n);
        this.refreshViews();
        out.set(this.outView.subarray(0, n), done);
        done = next;
      } else {
        done = next;
      }
    }
    // shift remaining event frames into the next quantum
    for (const q of this.queue) q.frame -= frames;
    return true;
  }
}

registerProcessor("string-processor", StringProcessor);
