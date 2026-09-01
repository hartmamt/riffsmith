// Neural Amp Modeler AudioWorklet processor.
// The worklet scope has no fetch, so the main thread sends the WASM binary
// and the .nam model JSON over the message port.
import createNamModule from "./nam.js";
import { NamWasmModule } from "./NamWasmModule.js";

// AudioWorkletGlobalScope has no URL; the Emscripten glue expects one.
// Only resolution against a base string is needed (wasm bytes arrive via
// the message port anyway).
if (typeof globalThis.URL === "undefined") {
  globalThis.URL = class URLShim {
    constructor(path, base = "") {
      const b = String(base);
      const dir = b.slice(0, b.lastIndexOf("/") + 1);
      this.href =
        /^[a-z]+:/i.test(path) || String(path).startsWith("/")
          ? String(path)
          : dir + String(path);
    }
    toString() {
      return this.href;
    }
  };
}

class NamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.nam = null;
    this.instanceId = -1;
    this.active = false;
    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  async handleMessage(data) {
    try {
      if (data.type === "init") {
        const module = await createNamModule({ wasmBinary: data.wasmBinary });
        this.nam = NamWasmModule.fromModule(module);
        this.nam.setSampleRate(sampleRate);
        this.instanceId = this.nam.createInstance();
        this.port.postMessage({ type: "ready" });
      } else if (data.type === "loadModel" && this.nam) {
        let success = false;
        try {
          success = this.nam.loadModel(this.instanceId, data.modelJson);
        } catch (err) {
          this.port.postMessage({ type: "modelLoaded", success: false, error: String(err) });
          return;
        }
        this.active = success;
        // loudness metadata lets the main thread apply makeup gain
        const loudness =
          success && this.nam.hasModelLoudness(this.instanceId)
            ? this.nam.getModelLoudness(this.instanceId)
            : null;
        this.port.postMessage({ type: "modelLoaded", success, loudness });
      } else if (data.type === "bypass") {
        this.active = false;
        this.port.postMessage({ type: "bypassed" });
      }
    } catch (err) {
      this.port.postMessage({ type: "error", error: String(err) });
    }
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!input || !output) return true;
    if (this.active && this.nam && this.nam.hasModel(this.instanceId)) {
      this.nam.process(this.instanceId, input, output);
    } else {
      output.set(input); // passthrough until a model is active
    }
    return true;
  }
}

registerProcessor("nam-processor", NamProcessor);
