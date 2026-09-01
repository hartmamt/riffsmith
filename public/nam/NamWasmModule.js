/**
 * Neural Amp Modeler WASM Module TypeScript Wrapper
 *
 * Provides a clean TypeScript API for the multi-instance NAM WASM module.
 * Designed for use in Web Audio AudioWorklets.
 */
var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
};
var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _NamWasmModule_module, _NamWasmModule_inputPtr, _NamWasmModule_outputPtr, _NamWasmModule_bufferSize;
/**
 * High-level wrapper around the NAM WASM module.
 * Handles memory management and provides a clean TypeScript API.
 */
export class NamWasmModule {
    constructor(module, bufferSize = 128) {
        _NamWasmModule_module.set(this, void 0);
        // Pre-allocated buffers for audio processing (128 samples = Web Audio render quantum)
        _NamWasmModule_inputPtr.set(this, void 0);
        _NamWasmModule_outputPtr.set(this, void 0);
        _NamWasmModule_bufferSize.set(this, void 0);
        __classPrivateFieldSet(this, _NamWasmModule_module, module, "f");
        __classPrivateFieldSet(this, _NamWasmModule_bufferSize, bufferSize, "f");
        // Pre-allocate audio buffers (4 bytes per float32)
        __classPrivateFieldSet(this, _NamWasmModule_inputPtr, module._malloc(bufferSize * 4), "f");
        __classPrivateFieldSet(this, _NamWasmModule_outputPtr, module._malloc(bufferSize * 4), "f");
        if (__classPrivateFieldGet(this, _NamWasmModule_inputPtr, "f") === 0 || __classPrivateFieldGet(this, _NamWasmModule_outputPtr, "f") === 0) {
            throw new Error("Failed to allocate audio buffers");
        }
    }
    /**
     * Creates a NamWasmModule from an Emscripten module factory function.
     * Use this when loading the module dynamically.
     *
     * @param createModule The factory function exported by the Emscripten JS wrapper
     * @param bufferSize Size of pre-allocated audio buffers (default: 128)
     */
    static async create(createModule, bufferSize = 128) {
        const module = await createModule();
        return new NamWasmModule(module, bufferSize);
    }
    /**
     * Creates a NamWasmModule from an already-instantiated Emscripten module.
     * Use this when the module has already been created elsewhere.
     *
     * @param module Pre-instantiated Emscripten module
     * @param bufferSize Size of pre-allocated audio buffers (default: 128)
     */
    static fromModule(module, bufferSize = 128) {
        return new NamWasmModule(module, bufferSize);
    }
    /**
     * Disposes of the module and frees allocated memory.
     * Call this when done using the module.
     */
    dispose() {
        __classPrivateFieldGet(this, _NamWasmModule_module, "f")._free(__classPrivateFieldGet(this, _NamWasmModule_inputPtr, "f"));
        __classPrivateFieldGet(this, _NamWasmModule_module, "f")._free(__classPrivateFieldGet(this, _NamWasmModule_outputPtr, "f"));
    }
    /**
     * Creates a new NAM instance.
     * @returns Instance ID for use with other methods
     */
    createInstance() {
        return __classPrivateFieldGet(this, _NamWasmModule_module, "f")._nam_createInstance();
    }
    /**
     * Destroys a NAM instance and frees its resources.
     * @param id Instance ID
     */
    destroyInstance(id) {
        __classPrivateFieldGet(this, _NamWasmModule_module, "f")._nam_destroyInstance(id);
    }
    /**
     * Returns the number of active instances.
     */
    getInstanceCount() {
        return __classPrivateFieldGet(this, _NamWasmModule_module, "f")._nam_getInstanceCount();
    }
    /**
     * Loads a NAM model from JSON string.
     * @param id Instance ID
     * @param modelJson JSON string containing the model
     * @returns true if successful
     */
    loadModel(id, modelJson) {
        // Calculate required buffer size
        const byteLength = __classPrivateFieldGet(this, _NamWasmModule_module, "f").lengthBytesUTF8(modelJson) + 1;
        // Allocate temporary buffer for the JSON string
        const jsonPtr = __classPrivateFieldGet(this, _NamWasmModule_module, "f")._malloc(byteLength);
        if (jsonPtr === 0) {
            return false;
        }
        try {
            // Copy string to WASM memory
            __classPrivateFieldGet(this, _NamWasmModule_module, "f").stringToUTF8(modelJson, jsonPtr, byteLength);
            // Load the model
            return __classPrivateFieldGet(this, _NamWasmModule_module, "f")._nam_loadModel(id, jsonPtr);
        }
        finally {
            // Free the temporary buffer
            __classPrivateFieldGet(this, _NamWasmModule_module, "f")._free(jsonPtr);
        }
    }
    /**
     * Unloads the model from an instance.
     * @param id Instance ID
     */
    unloadModel(id) {
        __classPrivateFieldGet(this, _NamWasmModule_module, "f")._nam_unloadModel(id);
    }
    /**
     * Checks if an instance has a model loaded.
     * @param id Instance ID
     */
    hasModel(id) {
        return __classPrivateFieldGet(this, _NamWasmModule_module, "f")._nam_hasModel(id);
    }
    /**
     * Processes audio through a NAM instance.
     *
     * IMPORTANT: This method is optimized for real-time audio processing.
     * It uses pre-allocated buffers to avoid allocations during the audio callback.
     *
     * @param id Instance ID
     * @param input Input samples (mono)
     * @param output Output samples (mono) - will be filled with processed audio
     */
    process(id, input, output) {
        const numFrames = Math.min(input.length, output.length, __classPrivateFieldGet(this, _NamWasmModule_bufferSize, "f"));
        // Copy input to WASM memory
        // HEAPF32 is indexed by float32 (4 bytes), so divide pointer by 4
        const inputOffset = __classPrivateFieldGet(this, _NamWasmModule_inputPtr, "f") >> 2;
        const outputOffset = __classPrivateFieldGet(this, _NamWasmModule_outputPtr, "f") >> 2;
        // Set input data
        __classPrivateFieldGet(this, _NamWasmModule_module, "f").HEAPF32.set(input.subarray(0, numFrames), inputOffset);
        // Process
        __classPrivateFieldGet(this, _NamWasmModule_module, "f")._nam_process(id, __classPrivateFieldGet(this, _NamWasmModule_inputPtr, "f"), __classPrivateFieldGet(this, _NamWasmModule_outputPtr, "f"), numFrames);
        // Copy output from WASM memory
        output.set(__classPrivateFieldGet(this, _NamWasmModule_module, "f").HEAPF32.subarray(outputOffset, outputOffset + numFrames));
    }
    /**
     * Processes audio in-place (input and output are the same buffer).
     * Slightly more efficient when you don't need to preserve the input.
     *
     * @param id Instance ID
     * @param buffer Audio buffer to process in-place
     */
    processInPlace(id, buffer) {
        this.process(id, buffer, buffer);
    }
    /**
     * Sets the sample rate for all instances.
     * @param rate Sample rate in Hz
     */
    setSampleRate(rate) {
        __classPrivateFieldGet(this, _NamWasmModule_module, "f")._nam_setSampleRate(rate);
    }
    /**
     * Gets the current sample rate.
     */
    getSampleRate() {
        return __classPrivateFieldGet(this, _NamWasmModule_module, "f")._nam_getSampleRate();
    }
    /**
     * Sets the maximum buffer size for processing.
     * Call this if using buffer sizes larger than 128 samples.
     * @param size Maximum buffer size in samples
     */
    setMaxBufferSize(size) {
        __classPrivateFieldGet(this, _NamWasmModule_module, "f")._nam_setMaxBufferSize(size);
    }
    /**
     * Gets the current maximum buffer size.
     */
    getMaxBufferSize() {
        return __classPrivateFieldGet(this, _NamWasmModule_module, "f")._nam_getMaxBufferSize();
    }
    /**
     * Gets the loudness value of a loaded model.
     * @param id Instance ID
     * @returns Loudness in dB, or 0 if not available
     */
    getModelLoudness(id) {
        return __classPrivateFieldGet(this, _NamWasmModule_module, "f")._nam_getModelLoudness(id);
    }
    /**
     * Checks if a model has loudness metadata.
     * @param id Instance ID
     */
    hasModelLoudness(id) {
        return __classPrivateFieldGet(this, _NamWasmModule_module, "f")._nam_hasModelLoudness(id);
    }
    /**
     * Resets the internal state of a model instance.
     * Call this on transport stop or when starting a new audio region.
     * @param id Instance ID
     */
    reset(id) {
        __classPrivateFieldGet(this, _NamWasmModule_module, "f")._nam_reset(id);
    }
    /**
     * Returns the pre-allocated buffer size.
     */
    get bufferSize() {
        return __classPrivateFieldGet(this, _NamWasmModule_bufferSize, "f");
    }
}
_NamWasmModule_module = new WeakMap(), _NamWasmModule_inputPtr = new WeakMap(), _NamWasmModule_outputPtr = new WeakMap(), _NamWasmModule_bufferSize = new WeakMap();
//# sourceMappingURL=NamWasmModule.js.map