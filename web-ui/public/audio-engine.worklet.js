"use strict";
(() => {
  // packages/render-engine/src/worklet/polyfills.ts
  if (typeof globalThis.TextDecoder === "undefined") {
    globalThis.TextDecoder = class TextDecoder {
      decode(input) {
        if (!input || input.length === 0) return "";
        let result = "";
        for (let i = 0; i < input.length; i++) {
          result += String.fromCharCode(input[i]);
        }
        try {
          return decodeURIComponent(escape(result));
        } catch {
          return result;
        }
      }
    };
  }
  if (typeof globalThis.TextEncoder === "undefined") {
    globalThis.TextEncoder = class TextEncoder {
      encode(input) {
        const utf8 = unescape(encodeURIComponent(input));
        const result = new Uint8Array(utf8.length);
        for (let i = 0; i < utf8.length; i++) {
          result[i] = utf8.charCodeAt(i);
        }
        return result;
      }
      encodeInto(source, destination) {
        const encoded = this.encode(source);
        const written = Math.min(encoded.length, destination.length);
        destination.set(encoded.subarray(0, written));
        return { read: source.length, written };
      }
    };
  }

  // packages/render-engine/wasm/audio-engine/audio_engine.js
  var AudioEngine = class {
    __destroy_into_raw() {
      const ptr = this.__wbg_ptr;
      this.__wbg_ptr = 0;
      AudioEngineFinalization.unregister(this);
      return ptr;
    }
    free() {
      const ptr = this.__destroy_into_raw();
      wasm.__wbg_audioengine_free(ptr, 0);
    }
    /**
     * Append a chunk of interleaved PCM data to a streaming source
     *
     * # Arguments
     * * `source_id` - ID of the streaming source (must have been created with `create_streaming_source`)
     * * `chunk` - Interleaved PCM data (f32)
     * @param {string} source_id
     * @param {Float32Array} chunk
     */
    append_audio_chunk(source_id, chunk) {
      const ptr0 = passStringToWasm0(source_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len0 = WASM_VECTOR_LEN;
      const ptr1 = passArrayF32ToWasm0(chunk, wasm.__wbindgen_malloc);
      const len1 = WASM_VECTOR_LEN;
      wasm.audioengine_append_audio_chunk(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    /**
     * Clear all buffered data for a windowed source (used on seek)
     * @param {string} source_id
     */
    clear_source_buffer(source_id) {
      const ptr0 = passStringToWasm0(source_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len0 = WASM_VECTOR_LEN;
      wasm.audioengine_clear_source_buffer(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Create a streaming audio source that receives PCM data incrementally
     *
     * # Arguments
     * * `source_id` - Unique identifier for this audio source (asset ID)
     * * `sample_rate` - Sample rate of the source audio
     * * `channels` - Number of channels (1 or 2)
     * * `estimated_duration` - Optional duration hint in seconds for pre-allocation (0 = no hint)
     * @param {string} source_id
     * @param {number} sample_rate
     * @param {number} channels
     * @param {number} estimated_duration
     */
    create_streaming_source(source_id, sample_rate, channels, estimated_duration) {
      const ptr0 = passStringToWasm0(source_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len0 = WASM_VECTOR_LEN;
      wasm.audioengine_create_streaming_source(this.__wbg_ptr, ptr0, len0, sample_rate, channels, estimated_duration);
    }
    /**
     * Create a windowed audio source (metadata only, fixed-size buffer)
     *
     * Unlike streaming sources, windowed sources only retain a limited amount
     * of decoded PCM in memory. The JS side manages decode-ahead and sends
     * buffer updates as the playhead moves.
     *
     * # Arguments
     * * `source_id` - Unique identifier for this audio source (asset ID)
     * * `sample_rate` - Sample rate of the source audio
     * * `channels` - Number of channels (1 or 2)
     * * `duration` - Total duration of the source media in seconds
     * * `max_buffer_seconds` - Maximum seconds of PCM to retain (e.g. 30.0)
     * @param {string} source_id
     * @param {number} sample_rate
     * @param {number} channels
     * @param {number} duration
     * @param {number} max_buffer_seconds
     */
    create_windowed_source(source_id, sample_rate, channels, duration, max_buffer_seconds) {
      const ptr0 = passStringToWasm0(source_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len0 = WASM_VECTOR_LEN;
      wasm.audioengine_create_windowed_source(this.__wbg_ptr, ptr0, len0, sample_rate, channels, duration, max_buffer_seconds);
    }
    /**
     * Mark a streaming source as complete (all data has been received)
     *
     * # Arguments
     * * `source_id` - ID of the streaming source
     * @param {string} source_id
     */
    finalize_audio(source_id) {
      const ptr0 = passStringToWasm0(source_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len0 = WASM_VECTOR_LEN;
      wasm.audioengine_finalize_audio(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Get buffer misses since last query (diagnostics)
     * @param {string} source_id
     * @returns {bigint}
     */
    get_buffer_misses(source_id) {
      const ptr0 = passStringToWasm0(source_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len0 = WASM_VECTOR_LEN;
      const ret = wasm.audioengine_get_buffer_misses(this.__wbg_ptr, ptr0, len0);
      return BigInt.asUintN(64, ret);
    }
    /**
     * Get the current playback time (for sync feedback)
     * @returns {number}
     */
    get_current_time() {
      const ret = wasm.audioengine_get_current_time(this.__wbg_ptr);
      return ret;
    }
    /**
     * Create a new AudioEngine with the given output sample rate
     * @param {number} sample_rate
     */
    constructor(sample_rate) {
      const ret = wasm.audioengine_new(sample_rate);
      this.__wbg_ptr = ret >>> 0;
      AudioEngineFinalization.register(this, this.__wbg_ptr, this);
      return this;
    }
    /**
     * Remove audio data for a source
     * @param {string} source_id
     */
    remove_audio(source_id) {
      const ptr0 = passStringToWasm0(source_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len0 = WASM_VECTOR_LEN;
      wasm.audioengine_remove_audio(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Render audio frames
     *
     * Called from the AudioWorklet processor every ~128 samples.
     * Output is interleaved stereo (L, R, L, R, ...).
     *
     * # Arguments
     * * `output` - Mutable slice to write interleaved stereo samples
     * * `num_frames` - Number of stereo frames to render
     *
     * # Returns
     * Number of frames actually rendered
     * @param {Float32Array} output
     * @param {number} num_frames
     * @returns {number}
     */
    render(output, num_frames) {
      var ptr0 = passArrayF32ToWasm0(output, wasm.__wbindgen_malloc);
      var len0 = WASM_VECTOR_LEN;
      const ret = wasm.audioengine_render(this.__wbg_ptr, ptr0, len0, output, num_frames);
      return ret >>> 0;
    }
    /**
     * Seek to a specific time
     * @param {number} time
     */
    seek(time) {
      wasm.audioengine_seek(this.__wbg_ptr, time);
    }
    /**
     * Set master volume (0.0 - 1.0)
     * @param {number} volume
     */
    set_master_volume(volume) {
      wasm.audioengine_set_master_volume(this.__wbg_ptr, volume);
    }
    /**
     * Set playback state
     * @param {boolean} playing
     */
    set_playing(playing) {
      wasm.audioengine_set_playing(this.__wbg_ptr, playing);
    }
    /**
     * Update the timeline state (clips, tracks, cross-transitions)
     *
     * # Arguments
     * * `timeline_json` - JSON string containing AudioTimelineState
     * @param {string} timeline_json
     */
    set_timeline(timeline_json) {
      const ptr0 = passStringToWasm0(timeline_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len0 = WASM_VECTOR_LEN;
      wasm.audioengine_set_timeline(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Update the buffered PCM window for a windowed source
     *
     * # Arguments
     * * `source_id` - ID of the windowed source
     * * `start_time` - Start time in source-time seconds for this chunk
     * * `pcm_data` - Interleaved PCM data (f32)
     * @param {string} source_id
     * @param {number} start_time
     * @param {Float32Array} pcm_data
     */
    update_source_buffer(source_id, start_time, pcm_data) {
      const ptr0 = passStringToWasm0(source_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len0 = WASM_VECTOR_LEN;
      const ptr1 = passArrayF32ToWasm0(pcm_data, wasm.__wbindgen_malloc);
      const len1 = WASM_VECTOR_LEN;
      wasm.audioengine_update_source_buffer(this.__wbg_ptr, ptr0, len0, start_time, ptr1, len1);
    }
    /**
     * Upload decoded PCM audio data for a clip
     *
     * # Arguments
     * * `source_id` - Unique identifier for this audio source (asset ID)
     * * `pcm_data` - Interleaved stereo PCM data (f32)
     * * `source_sample_rate` - Sample rate of the source audio
     * * `channels` - Number of channels (1 or 2)
     * @param {string} source_id
     * @param {Float32Array} pcm_data
     * @param {number} source_sample_rate
     * @param {number} channels
     */
    upload_audio(source_id, pcm_data, source_sample_rate, channels) {
      const ptr0 = passStringToWasm0(source_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len0 = WASM_VECTOR_LEN;
      const ptr1 = passArrayF32ToWasm0(pcm_data, wasm.__wbindgen_malloc);
      const len1 = WASM_VECTOR_LEN;
      wasm.audioengine_upload_audio(this.__wbg_ptr, ptr0, len0, ptr1, len1, source_sample_rate, channels);
    }
  };
  if (Symbol.dispose) AudioEngine.prototype[Symbol.dispose] = AudioEngine.prototype.free;
  var Color = class _Color {
    static __wrap(ptr) {
      ptr = ptr >>> 0;
      const obj = Object.create(_Color.prototype);
      obj.__wbg_ptr = ptr;
      ColorFinalization.register(obj, obj.__wbg_ptr, obj);
      return obj;
    }
    __destroy_into_raw() {
      const ptr = this.__wbg_ptr;
      this.__wbg_ptr = 0;
      ColorFinalization.unregister(this);
      return ptr;
    }
    free() {
      const ptr = this.__destroy_into_raw();
      wasm.__wbg_color_free(ptr, 0);
    }
    /**
     * Parse from hex string (e.g., "#ff0000" or "#ff0000ff").
     * @param {string} hex
     * @returns {Color | undefined}
     */
    static from_hex(hex) {
      const ptr0 = passStringToWasm0(hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len0 = WASM_VECTOR_LEN;
      const ret = wasm.color_from_hex(ptr0, len0);
      return ret === 0 ? void 0 : _Color.__wrap(ret);
    }
    /**
     * @param {number} r
     * @param {number} g
     * @param {number} b
     * @param {number} a
     */
    constructor(r, g, b, a) {
      const ret = wasm.color_new(r, g, b, a);
      this.__wbg_ptr = ret >>> 0;
      ColorFinalization.register(this, this.__wbg_ptr, this);
      return this;
    }
    /**
     * Create an opaque RGB color.
     * @param {number} r
     * @param {number} g
     * @param {number} b
     * @returns {Color}
     */
    static rgb(r, g, b) {
      const ret = wasm.color_rgb(r, g, b);
      return _Color.__wrap(ret);
    }
    /**
     * Convert to hex string with alpha (e.g., "#ff0000ff").
     * @returns {string}
     */
    to_hex() {
      let deferred1_0;
      let deferred1_1;
      try {
        const ret = wasm.color_to_hex(this.__wbg_ptr);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
      } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
      }
    }
    /**
     * @returns {number}
     */
    get a() {
      const ret = wasm.__wbg_get_color_a(this.__wbg_ptr);
      return ret;
    }
    /**
     * @returns {number}
     */
    get b() {
      const ret = wasm.__wbg_get_color_b(this.__wbg_ptr);
      return ret;
    }
    /**
     * @returns {number}
     */
    get g() {
      const ret = wasm.__wbg_get_color_g(this.__wbg_ptr);
      return ret;
    }
    /**
     * @returns {number}
     */
    get r() {
      const ret = wasm.__wbg_get_color_r(this.__wbg_ptr);
      return ret;
    }
    /**
     * @param {number} arg0
     */
    set a(arg0) {
      wasm.__wbg_set_color_a(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set b(arg0) {
      wasm.__wbg_set_color_b(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set g(arg0) {
      wasm.__wbg_set_color_g(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set r(arg0) {
      wasm.__wbg_set_color_r(this.__wbg_ptr, arg0);
    }
  };
  if (Symbol.dispose) Color.prototype[Symbol.dispose] = Color.prototype.free;
  var CrossTransitionType = Object.freeze({
    Dissolve: 0,
    "0": "Dissolve",
    Fade: 1,
    "1": "Fade",
    WipeLeft: 2,
    "2": "WipeLeft",
    WipeRight: 3,
    "3": "WipeRight",
    WipeUp: 4,
    "4": "WipeUp",
    WipeDown: 5,
    "5": "WipeDown"
  });
  var CubicBezier = class {
    __destroy_into_raw() {
      const ptr = this.__wbg_ptr;
      this.__wbg_ptr = 0;
      CubicBezierFinalization.unregister(this);
      return ptr;
    }
    free() {
      const ptr = this.__destroy_into_raw();
      wasm.__wbg_cubicbezier_free(ptr, 0);
    }
    /**
     * Evaluate the bezier curve at progress t (0.0-1.0).
     * Uses Newton-Raphson iteration to find the curve parameter.
     * @param {number} t
     * @returns {number}
     */
    evaluate(t) {
      const ret = wasm.cubicbezier_evaluate(this.__wbg_ptr, t);
      return ret;
    }
    /**
     * @param {number} x1
     * @param {number} y1
     * @param {number} x2
     * @param {number} y2
     */
    constructor(x1, y1, x2, y2) {
      const ret = wasm.color_new(x1, y1, x2, y2);
      this.__wbg_ptr = ret >>> 0;
      CubicBezierFinalization.register(this, this.__wbg_ptr, this);
      return this;
    }
    /**
     * @returns {number}
     */
    get x1() {
      const ret = wasm.__wbg_get_color_r(this.__wbg_ptr);
      return ret;
    }
    /**
     * @returns {number}
     */
    get x2() {
      const ret = wasm.__wbg_get_color_b(this.__wbg_ptr);
      return ret;
    }
    /**
     * @returns {number}
     */
    get y1() {
      const ret = wasm.__wbg_get_color_g(this.__wbg_ptr);
      return ret;
    }
    /**
     * @returns {number}
     */
    get y2() {
      const ret = wasm.__wbg_get_color_a(this.__wbg_ptr);
      return ret;
    }
    /**
     * @param {number} arg0
     */
    set x1(arg0) {
      wasm.__wbg_set_color_r(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set x2(arg0) {
      wasm.__wbg_set_color_b(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set y1(arg0) {
      wasm.__wbg_set_color_g(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set y2(arg0) {
      wasm.__wbg_set_color_a(this.__wbg_ptr, arg0);
    }
  };
  if (Symbol.dispose) CubicBezier.prototype[Symbol.dispose] = CubicBezier.prototype.free;
  var EasingPreset = Object.freeze({
    Linear: 0,
    "0": "Linear",
    EaseIn: 1,
    "1": "EaseIn",
    EaseOut: 2,
    "2": "EaseOut",
    EaseInOut: 3,
    "3": "EaseInOut",
    Custom: 4,
    "4": "Custom"
  });
  var EffectProperty = Object.freeze({
    Opacity: 0,
    "0": "Opacity",
    Brightness: 1,
    "1": "Brightness",
    Contrast: 2,
    "2": "Contrast",
    Saturation: 3,
    "3": "Saturation",
    HueRotate: 4,
    "4": "HueRotate",
    Blur: 5,
    "5": "Blur"
  });
  var Interpolation = Object.freeze({
    /**
     * Linear interpolation between values.
     */
    Linear: 0,
    "0": "Linear",
    /**
     * Hold previous value until next keyframe (step function).
     */
    Step: 1,
    "1": "Step",
    /**
     * Cubic bezier interpolation with custom easing.
     */
    Bezier: 2,
    "2": "Bezier"
  });
  var KeyframeEvaluator = class {
    __destroy_into_raw() {
      const ptr = this.__wbg_ptr;
      this.__wbg_ptr = 0;
      KeyframeEvaluatorFinalization.unregister(this);
      return ptr;
    }
    free() {
      const ptr = this.__destroy_into_raw();
      wasm.__wbg_keyframeevaluator_free(ptr, 0);
    }
    /**
     * Clear the temporal cache (call after seeking).
     */
    clear_cache() {
      wasm.keyframeevaluator_clear_cache(this.__wbg_ptr);
    }
    /**
     * Evaluate a property at the given time.
     *
     * Returns `None` (as NaN) if the property doesn't exist.
     * @param {string} property
     * @param {number} time
     * @returns {number}
     */
    evaluate(property, time) {
      const ptr0 = passStringToWasm0(property, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len0 = WASM_VECTOR_LEN;
      const ret = wasm.keyframeevaluator_evaluate(this.__wbg_ptr, ptr0, len0, time);
      return ret;
    }
    /**
     * Check if a property exists and has keyframes.
     * @param {string} property
     * @returns {boolean}
     */
    has_property(property) {
      const ptr0 = passStringToWasm0(property, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len0 = WASM_VECTOR_LEN;
      const ret = wasm.keyframeevaluator_has_property(this.__wbg_ptr, ptr0, len0);
      return ret !== 0;
    }
    /**
     * Create a new evaluator from a KeyframeTracks object.
     * @param {any} tracks
     */
    constructor(tracks) {
      const ret = wasm.keyframeevaluator_new(tracks);
      if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
      }
      this.__wbg_ptr = ret[0] >>> 0;
      KeyframeEvaluatorFinalization.register(this, this.__wbg_ptr, this);
      return this;
    }
    /**
     * Get all animated property names.
     * @returns {any}
     */
    properties() {
      const ret = wasm.keyframeevaluator_properties(this.__wbg_ptr);
      if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
      }
      return takeFromExternrefTable0(ret[0]);
    }
  };
  if (Symbol.dispose) KeyframeEvaluator.prototype[Symbol.dispose] = KeyframeEvaluator.prototype.free;
  var LineHeadType = Object.freeze({
    None: 0,
    "0": "None",
    Arrow: 1,
    "1": "Arrow",
    Circle: 2,
    "2": "Circle",
    Square: 3,
    "3": "Square",
    Diamond: 4,
    "4": "Diamond"
  });
  var LineStrokeStyle = Object.freeze({
    Solid: 0,
    "0": "Solid",
    Dashed: 1,
    "1": "Dashed",
    Dotted: 2,
    "2": "Dotted"
  });
  var ShapeType = Object.freeze({
    Rectangle: 0,
    "0": "Rectangle",
    Ellipse: 1,
    "1": "Ellipse",
    Polygon: 2,
    "2": "Polygon"
  });
  var TextAlign = Object.freeze({
    Left: 0,
    "0": "Left",
    Center: 1,
    "1": "Center",
    Right: 2,
    "2": "Right"
  });
  var TransitionType = Object.freeze({
    None: 0,
    "0": "None",
    Fade: 1,
    "1": "Fade",
    Dissolve: 2,
    "2": "Dissolve",
    WipeLeft: 3,
    "3": "WipeLeft",
    WipeRight: 4,
    "4": "WipeRight",
    WipeUp: 5,
    "5": "WipeUp",
    WipeDown: 6,
    "6": "WipeDown",
    SlideLeft: 7,
    "7": "SlideLeft",
    SlideRight: 8,
    "8": "SlideRight",
    SlideUp: 9,
    "9": "SlideUp",
    SlideDown: 10,
    "10": "SlideDown",
    ZoomIn: 11,
    "11": "ZoomIn",
    ZoomOut: 12,
    "12": "ZoomOut",
    RotateCw: 13,
    "13": "RotateCw",
    RotateCcw: 14,
    "14": "RotateCcw",
    FlipH: 15,
    "15": "FlipH",
    FlipV: 16,
    "16": "FlipV"
  });
  var VerticalAlign = Object.freeze({
    Top: 0,
    "0": "Top",
    Middle: 1,
    "1": "Middle",
    Bottom: 2,
    "2": "Bottom"
  });
  function __wbg_get_imports() {
    const import0 = {
      __proto__: null,
      __wbg_Error_8c4e43fe74559d73: function(arg0, arg1) {
        const ret = Error(getStringFromWasm0(arg0, arg1));
        return ret;
      },
      __wbg_String_8f0eb39a4a4c2f66: function(arg0, arg1) {
        const ret = String(arg1);
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
      },
      __wbg___wbindgen_boolean_get_bbbb1c18aa2f5e25: function(arg0) {
        const v = arg0;
        const ret = typeof v === "boolean" ? v : void 0;
        return isLikeNone(ret) ? 16777215 : ret ? 1 : 0;
      },
      __wbg___wbindgen_copy_to_typed_array_fc0809a4dec43528: function(arg0, arg1, arg2) {
        new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
      },
      __wbg___wbindgen_debug_string_0bc8482c6e3508ae: function(arg0, arg1) {
        const ret = debugString(arg1);
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
      },
      __wbg___wbindgen_in_47fa6863be6f2f25: function(arg0, arg1) {
        const ret = arg0 in arg1;
        return ret;
      },
      __wbg___wbindgen_is_function_0095a73b8b156f76: function(arg0) {
        const ret = typeof arg0 === "function";
        return ret;
      },
      __wbg___wbindgen_is_object_5ae8e5880f2c1fbd: function(arg0) {
        const val = arg0;
        const ret = typeof val === "object" && val !== null;
        return ret;
      },
      __wbg___wbindgen_is_string_cd444516edc5b180: function(arg0) {
        const ret = typeof arg0 === "string";
        return ret;
      },
      __wbg___wbindgen_is_undefined_9e4d92534c42d778: function(arg0) {
        const ret = arg0 === void 0;
        return ret;
      },
      __wbg___wbindgen_jsval_loose_eq_9dd77d8cd6671811: function(arg0, arg1) {
        const ret = arg0 == arg1;
        return ret;
      },
      __wbg___wbindgen_number_get_8ff4255516ccad3e: function(arg0, arg1) {
        const obj = arg1;
        const ret = typeof obj === "number" ? obj : void 0;
        getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
      },
      __wbg___wbindgen_string_get_72fb696202c56729: function(arg0, arg1) {
        const obj = arg1;
        const ret = typeof obj === "string" ? obj : void 0;
        var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
      },
      __wbg___wbindgen_throw_be289d5034ed271b: function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
      },
      __wbg_call_389efe28435a9388: function() {
        return handleError(function(arg0, arg1) {
          const ret = arg0.call(arg1);
          return ret;
        }, arguments);
      },
      __wbg_debug_a4099fa12db6cd61: function(arg0) {
        console.debug(arg0);
      },
      __wbg_done_57b39ecd9addfe81: function(arg0) {
        const ret = arg0.done;
        return ret;
      },
      __wbg_entries_58c7934c745daac7: function(arg0) {
        const ret = Object.entries(arg0);
        return ret;
      },
      __wbg_error_7534b8e9a36f1ab4: function(arg0, arg1) {
        let deferred0_0;
        let deferred0_1;
        try {
          deferred0_0 = arg0;
          deferred0_1 = arg1;
          console.error(getStringFromWasm0(arg0, arg1));
        } finally {
          wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
        }
      },
      __wbg_error_9a7fe3f932034cde: function(arg0) {
        console.error(arg0);
      },
      __wbg_get_9b94d73e6221f75c: function(arg0, arg1) {
        const ret = arg0[arg1 >>> 0];
        return ret;
      },
      __wbg_get_b3ed3ad4be2bc8ac: function() {
        return handleError(function(arg0, arg1) {
          const ret = Reflect.get(arg0, arg1);
          return ret;
        }, arguments);
      },
      __wbg_get_with_ref_key_1dc361bd10053bfe: function(arg0, arg1) {
        const ret = arg0[arg1];
        return ret;
      },
      __wbg_info_148d043840582012: function(arg0) {
        console.info(arg0);
      },
      __wbg_instanceof_ArrayBuffer_c367199e2fa2aa04: function(arg0) {
        let result;
        try {
          result = arg0 instanceof ArrayBuffer;
        } catch (_) {
          result = false;
        }
        const ret = result;
        return ret;
      },
      __wbg_instanceof_Uint8Array_9b9075935c74707c: function(arg0) {
        let result;
        try {
          result = arg0 instanceof Uint8Array;
        } catch (_) {
          result = false;
        }
        const ret = result;
        return ret;
      },
      __wbg_isArray_d314bb98fcf08331: function(arg0) {
        const ret = Array.isArray(arg0);
        return ret;
      },
      __wbg_iterator_6ff6560ca1568e55: function() {
        const ret = Symbol.iterator;
        return ret;
      },
      __wbg_length_32ed9a279acd054c: function(arg0) {
        const ret = arg0.length;
        return ret;
      },
      __wbg_length_35a7bace40f36eac: function(arg0) {
        const ret = arg0.length;
        return ret;
      },
      __wbg_log_6b5ca2e6124b2808: function(arg0) {
        console.log(arg0);
      },
      __wbg_new_3eb36ae241fe6f44: function() {
        const ret = new Array();
        return ret;
      },
      __wbg_new_8a6f238a6ece86ea: function() {
        const ret = new Error();
        return ret;
      },
      __wbg_new_dd2b680c8bf6ae29: function(arg0) {
        const ret = new Uint8Array(arg0);
        return ret;
      },
      __wbg_next_3482f54c49e8af19: function() {
        return handleError(function(arg0) {
          const ret = arg0.next();
          return ret;
        }, arguments);
      },
      __wbg_next_418f80d8f5303233: function(arg0) {
        const ret = arg0.next;
        return ret;
      },
      __wbg_prototypesetcall_bdcdcc5842e4d77d: function(arg0, arg1, arg2) {
        Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
      },
      __wbg_set_f43e577aea94465b: function(arg0, arg1, arg2) {
        arg0[arg1 >>> 0] = arg2;
      },
      __wbg_stack_0ed75d68575b0f3c: function(arg0, arg1) {
        const ret = arg1.stack;
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
      },
      __wbg_value_0546255b415e96c1: function(arg0) {
        const ret = arg0.value;
        return ret;
      },
      __wbg_warn_f7ae1b2e66ccb930: function(arg0) {
        console.warn(arg0);
      },
      __wbindgen_cast_0000000000000001: function(arg0, arg1) {
        const ret = getStringFromWasm0(arg0, arg1);
        return ret;
      },
      __wbindgen_init_externref_table: function() {
        const table = wasm.__wbindgen_externrefs;
        const offset = table.grow(4);
        table.set(0, void 0);
        table.set(offset + 0, void 0);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
      }
    };
    return {
      __proto__: null,
      "./audio_engine_bg.js": import0
    };
  }
  var AudioEngineFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
  }, unregister: () => {
  } } : new FinalizationRegistry((ptr) => wasm.__wbg_audioengine_free(ptr >>> 0, 1));
  var ColorFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
  }, unregister: () => {
  } } : new FinalizationRegistry((ptr) => wasm.__wbg_color_free(ptr >>> 0, 1));
  var CubicBezierFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
  }, unregister: () => {
  } } : new FinalizationRegistry((ptr) => wasm.__wbg_cubicbezier_free(ptr >>> 0, 1));
  var KeyframeEvaluatorFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
  }, unregister: () => {
  } } : new FinalizationRegistry((ptr) => wasm.__wbg_keyframeevaluator_free(ptr >>> 0, 1));
  function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
  }
  function debugString(val) {
    const type = typeof val;
    if (type == "number" || type == "boolean" || val == null) {
      return `${val}`;
    }
    if (type == "string") {
      return `"${val}"`;
    }
    if (type == "symbol") {
      const description = val.description;
      if (description == null) {
        return "Symbol";
      } else {
        return `Symbol(${description})`;
      }
    }
    if (type == "function") {
      const name = val.name;
      if (typeof name == "string" && name.length > 0) {
        return `Function(${name})`;
      } else {
        return "Function";
      }
    }
    if (Array.isArray(val)) {
      const length = val.length;
      let debug = "[";
      if (length > 0) {
        debug += debugString(val[0]);
      }
      for (let i = 1; i < length; i++) {
        debug += ", " + debugString(val[i]);
      }
      debug += "]";
      return debug;
    }
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
      className = builtInMatches[1];
    } else {
      return toString.call(val);
    }
    if (className == "Object") {
      try {
        return "Object(" + JSON.stringify(val) + ")";
      } catch (_) {
        return "Object";
      }
    }
    if (val instanceof Error) {
      return `${val.name}: ${val.message}
${val.stack}`;
    }
    return className;
  }
  function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
  }
  var cachedDataViewMemory0 = null;
  function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || cachedDataViewMemory0.buffer.detached === void 0 && cachedDataViewMemory0.buffer !== wasm.memory.buffer) {
      cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
  }
  var cachedFloat32ArrayMemory0 = null;
  function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
      cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
  }
  function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
  }
  var cachedUint8ArrayMemory0 = null;
  function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
      cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
  }
  function handleError(f, args) {
    try {
      return f.apply(this, args);
    } catch (e) {
      const idx = addToExternrefTable0(e);
      wasm.__wbindgen_exn_store(idx);
    }
  }
  function isLikeNone(x) {
    return x === void 0 || x === null;
  }
  function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
  }
  function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === void 0) {
      const buf = cachedTextEncoder.encode(arg);
      const ptr2 = malloc(buf.length, 1) >>> 0;
      getUint8ArrayMemory0().subarray(ptr2, ptr2 + buf.length).set(buf);
      WASM_VECTOR_LEN = buf.length;
      return ptr2;
    }
    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;
    const mem = getUint8ArrayMemory0();
    let offset = 0;
    for (; offset < len; offset++) {
      const code = arg.charCodeAt(offset);
      if (code > 127) break;
      mem[ptr + offset] = code;
    }
    if (offset !== len) {
      if (offset !== 0) {
        arg = arg.slice(offset);
      }
      ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
      const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
      const ret = cachedTextEncoder.encodeInto(arg, view);
      offset += ret.written;
      ptr = realloc(ptr, len, offset, 1) >>> 0;
    }
    WASM_VECTOR_LEN = offset;
    return ptr;
  }
  function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
  }
  var cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
  cachedTextDecoder.decode();
  var MAX_SAFARI_DECODE_BYTES = 2146435072;
  var numBytesDecoded = 0;
  function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
      cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
      cachedTextDecoder.decode();
      numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
  }
  var cachedTextEncoder = new TextEncoder();
  if (!("encodeInto" in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function(arg, view) {
      const buf = cachedTextEncoder.encode(arg);
      view.set(buf);
      return {
        read: arg.length,
        written: buf.length
      };
    };
  }
  var WASM_VECTOR_LEN = 0;
  var wasmModule;
  var wasm;
  function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
  }
  function initSync(module) {
    if (wasm !== void 0) return wasm;
    if (module !== void 0) {
      if (Object.getPrototypeOf(module) === Object.prototype) {
        ({ module } = module);
      } else {
        console.warn("using deprecated parameters for `initSync()`; pass a single object instead");
      }
    }
    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
      module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
  }

  // packages/render-engine/src/worklet/audio-engine.worklet.ts
  var AudioEngineProcessor = class extends AudioWorkletProcessor {
    engine = null;
    isPlaying = false;
    frameCount = 0;
    outputSampleRate;
    interleavedBuffer;
    constructor() {
      super();
      this.outputSampleRate = sampleRate;
      this.interleavedBuffer = new Float32Array(128 * 2);
      this.port.onmessage = this.handleMessage.bind(this);
      this.port.start();
      this.port.postMessage({ type: "worklet-ready" });
    }
    handleMessage(event) {
      const message = event.data;
      switch (message.type) {
        case "init":
          void this.initEngine(message.wasmBinary, message.sampleRate);
          break;
        case "upload-audio":
          this.engine?.upload_audio(
            message.sourceId,
            message.pcmData,
            message.sampleRate,
            message.channels
          );
          break;
        case "remove-audio":
          this.engine?.remove_audio(message.sourceId);
          break;
        case "set-timeline":
          this.engine?.set_timeline(message.timelineJson);
          break;
        case "set-playing":
          this.isPlaying = message.playing;
          this.engine?.set_playing(message.playing);
          break;
        case "seek":
          this.engine?.seek(message.time);
          break;
        case "set-master-volume":
          this.engine?.set_master_volume(message.volume);
          break;
        case "create-streaming-source":
          this.engine?.create_streaming_source(
            message.sourceId,
            message.sampleRate,
            message.channels,
            message.estimatedDuration
          );
          break;
        case "append-audio-chunk":
          this.engine?.append_audio_chunk(message.sourceId, message.pcmData);
          break;
        case "finalize-audio":
          this.engine?.finalize_audio(message.sourceId);
          break;
        case "create-windowed-source":
          this.engine?.create_windowed_source(
            message.sourceId,
            message.sampleRate,
            message.channels,
            message.duration,
            message.maxBufferSeconds
          );
          break;
        case "update-source-buffer":
          this.engine?.update_source_buffer(message.sourceId, message.startTime, message.pcmData);
          break;
        case "clear-source-buffer":
          this.engine?.clear_source_buffer(message.sourceId);
          break;
      }
    }
    async initEngine(wasmBinary, outputSampleRate) {
      this.outputSampleRate = outputSampleRate;
      try {
        const wasmModule2 = await WebAssembly.compile(wasmBinary);
        initSync({ module: wasmModule2 });
        this.engine = new AudioEngine(outputSampleRate);
        this.port.postMessage({ type: "ready" });
      } catch (error) {
        console.error("[AudioEngineProcessor] Failed to init WASM:", error);
        this.port.postMessage({
          type: "error",
          message: error instanceof Error ? error.message : "Unknown error"
        });
      }
    }
    process(_inputs, outputs) {
      const output = outputs[0];
      if (!output || output.length < 2) return true;
      const left = output[0];
      const right = output[1];
      const numFrames = left?.length ?? 128;
      if (!this.engine || !this.isPlaying) {
        left?.fill(0);
        right?.fill(0);
        return true;
      }
      if (this.interleavedBuffer.length < numFrames * 2) {
        this.interleavedBuffer = new Float32Array(numFrames * 2);
      }
      this.engine.render(this.interleavedBuffer, numFrames);
      for (let i = 0; i < numFrames; i++) {
        if (left) left[i] = this.interleavedBuffer[i * 2] ?? 0;
        if (right) right[i] = this.interleavedBuffer[i * 2 + 1] ?? 0;
      }
      this.frameCount += numFrames;
      if (this.frameCount >= Math.floor(this.outputSampleRate / 10)) {
        this.frameCount = 0;
        this.port.postMessage({
          type: "time-update",
          time: this.engine.get_current_time()
        });
      }
      return true;
    }
  };
  registerProcessor("audio-engine-processor", AudioEngineProcessor);
})();
