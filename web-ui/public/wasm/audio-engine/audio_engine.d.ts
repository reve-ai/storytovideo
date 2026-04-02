/* tslint:disable */
/* eslint-disable */
/**
 * 2D transform for positioning layers on the canvas.
 *
 * Coordinates are in pixels relative to canvas origin (top-left).
 * Anchor point (0.0-1.0) determines the center of rotation/scale.
 */
export interface Transform {
    /**
     * X position in pixels.
     */
    x: number;
    /**
     * Y position in pixels.
     */
    y: number;
    /**
     * Horizontal scale (1.0 = 100%).
     */
    scale_x: number;
    /**
     * Vertical scale (1.0 = 100%).
     */
    scale_y: number;
    /**
     * Rotation in degrees (clockwise).
     */
    rotation: number;
    /**
     * Anchor X (0.0 = left, 0.5 = center, 1.0 = right).
     */
    anchor_x: number;
    /**
     * Anchor Y (0.0 = top, 0.5 = center, 1.0 = bottom).
     */
    anchor_y: number;
}

/**
 * A cross-transition configuration (type, duration, easing).
 *
 * The clip references (IDs) are stored separately in the editor layer.
 */
export interface CrossTransition {
    /**
     * Type of cross-transition.
     */
    type: CrossTransitionType;
    /**
     * Duration of the overlap in seconds.
     */
    duration: number;
    /**
     * Easing curve for the transition.
     */
    easing: Easing;
}

/**
 * A transition effect applied to a clip\'s in or out point.
 */
export interface Transition {
    /**
     * The type of transition effect.
     */
    type: TransitionType;
    /**
     * Duration of the transition in seconds.
     */
    duration: number;
    /**
     * Easing curve for the transition.
     */
    easing: Easing;
}

/**
 * An active cross-transition between two clips.
 */
export interface ActiveCrossTransition {
    /**
     * The cross-transition configuration.
     */
    cross_transition: CrossTransition;
    /**
     * Current progress (0.0-1.0, before easing is applied).
     */
    progress: number;
    /**
     * Whether this layer is the outgoing clip (true) or incoming (false).
     */
    is_outgoing: boolean;
}

/**
 * An active transition with its current progress.
 */
export interface ActiveTransition {
    /**
     * The transition configuration.
     */
    transition: Transition;
    /**
     * Current progress (0.0-1.0, before easing is applied).
     */
    progress: number;
}

/**
 * Combined easing configuration.
 */
export interface Easing {
    preset: EasingPreset;
    custom_bezier?: CubicBezier;
}

/**
 * Crop region in normalized coordinates (0.0-1.0).
 *
 * Each field represents how much to remove from that edge.
 */
export interface Crop {
    /**
     * Amount to crop from top (0.0-1.0).
     */
    top: number;
    /**
     * Amount to crop from right (0.0-1.0).
     */
    right: number;
    /**
     * Amount to crop from bottom (0.0-1.0).
     */
    bottom: number;
    /**
     * Amount to crop from left (0.0-1.0).
     */
    left: number;
}

/**
 * Data for rendering a video/image layer.
 *
 * All transform and effects values are pre-evaluated (keyframes resolved in JS).
 * This allows stateless, parallel rendering across web workers.
 */
export interface MediaLayerData {
    /**
     * Unique texture ID for this layer\'s content.
     */
    texture_id: string;
    /**
     * Transform (position, scale, rotation) - pre-evaluated.
     */
    transform: Transform;
    /**
     * Visual effects - pre-evaluated.
     */
    effects: Effects;
    /**
     * Stacking order (higher = on top).
     */
    z_index: number;
    /**
     * Crop region.
     */
    crop?: Crop;
    /**
     * Transition in effect.
     */
    transition_in?: ActiveTransition;
    /**
     * Transition out effect.
     */
    transition_out?: ActiveTransition;
    /**
     * Cross-transition with adjacent clip (only one can be active).
     */
    cross_transition?: ActiveCrossTransition;
}

/**
 * Karaoke-style word highlight configuration.
 */
export interface HighlightStyle {
    /**
     * Override text color for highlighted words (RGBA 0-1).
     */
    color?: [number, number, number, number];
    /**
     * Override background color for highlighted words (RGBA 0-1).
     */
    background_color?: [number, number, number, number];
    /**
     * Override background padding.
     */
    background_padding?: number;
    /**
     * Override border radius.
     */
    background_border_radius?: number;
    /**
     * Override font weight.
     */
    font_weight?: number;
    /**
     * Scale factor for highlighted words.
     */
    scale?: number;
}

/**
 * Line endpoint configuration.
 */
export interface LineEndpoint {
    /**
     * Type of endpoint decoration.
     */
    type: LineHeadType;
    /**
     * Size of the decoration in pixels.
     */
    size: number;
}

/**
 * Line endpoints (as percentages 0-100 of canvas).
 */
export interface LineBox {
    /**
     * Start X position (percentage of canvas width).
     */
    x1: number;
    /**
     * Start Y position (percentage of canvas height).
     */
    y1: number;
    /**
     * End X position (percentage of canvas width).
     */
    x2: number;
    /**
     * End Y position (percentage of canvas height).
     */
    y2: number;
}

/**
 * Line layer data for rendering.
 *
 * All values are pre-evaluated (keyframes resolved before sending to compositor).
 */
export interface LineLayerData {
    /**
     * Unique identifier.
     */
    id: string;
    /**
     * Line endpoints (as percentages).
     */
    box: LineBox;
    /**
     * Line styling.
     */
    style: LineStyle;
    /**
     * Stacking order (higher = on top).
     */
    z_index: number;
    /**
     * Overall opacity (0.0-1.0).
     */
    opacity: number;
    /**
     * Transition in effect.
     */
    transition_in?: ActiveTransition;
    /**
     * Transition out effect.
     */
    transition_out?: ActiveTransition;
}

/**
 * Line style properties.
 */
export interface LineStyle {
    /**
     * Stroke color (RGBA 0-1).
     */
    stroke: [number, number, number, number];
    /**
     * Stroke width in pixels.
     */
    stroke_width: number;
    /**
     * Stroke style.
     */
    stroke_style: LineStrokeStyle;
    /**
     * Start endpoint decoration.
     */
    start_head: LineEndpoint;
    /**
     * End endpoint decoration.
     */
    end_head: LineEndpoint;
}

/**
 * Render frame request containing all layer types.
 *
 * All layer types share the same transition system (transition_in, transition_out).
 * The compositor applies transitions uniformly regardless of layer type.
 */
export interface RenderFrame {
    /**
     * Media layers (video/image clips).
     */
    media_layers: MediaLayerData[];
    /**
     * Text layers.
     */
    text_layers: TextLayerData[];
    /**
     * Shape layers (rectangle, ellipse, polygon).
     */
    shape_layers: ShapeLayerData[];
    /**
     * Line layers.
     */
    line_layers: LineLayerData[];
    /**
     * Current timeline time in seconds.
     */
    timeline_time: number;
    /**
     * Canvas width in pixels.
     */
    width: number;
    /**
     * Canvas height in pixels.
     */
    height: number;
}

/**
 * Shape bounding box (position and size as percentages 0-100 of canvas).
 */
export interface ShapeBox {
    /**
     * X position (percentage of canvas width).
     */
    x: number;
    /**
     * Y position (percentage of canvas height).
     */
    y: number;
    /**
     * Width (percentage of canvas width).
     */
    width: number;
    /**
     * Height (percentage of canvas height).
     */
    height: number;
}

/**
 * Shape layer data for rendering.
 *
 * All values are pre-evaluated (keyframes resolved before sending to compositor).
 */
export interface ShapeLayerData {
    /**
     * Unique identifier.
     */
    id: string;
    /**
     * Shape type.
     */
    shape: ShapeType;
    /**
     * Bounding box (position and size as percentages).
     */
    box: ShapeBox;
    /**
     * Shape styling.
     */
    style: ShapeStyle;
    /**
     * Stacking order (higher = on top).
     */
    z_index: number;
    /**
     * Overall opacity (0.0-1.0).
     */
    opacity: number;
    /**
     * Transition in effect.
     */
    transition_in?: ActiveTransition;
    /**
     * Transition out effect.
     */
    transition_out?: ActiveTransition;
}

/**
 * Shape style properties.
 */
export interface ShapeStyle {
    /**
     * Fill color (RGBA 0-1).
     */
    fill: [number, number, number, number];
    /**
     * Stroke (outline) color (RGBA 0-1).
     */
    stroke?: [number, number, number, number];
    /**
     * Stroke width in pixels.
     */
    stroke_width: number;
    /**
     * Corner radius for rectangles.
     */
    corner_radius: number;
    /**
     * Number of sides for polygons (3 = triangle, 5 = pentagon, etc.).
     */
    sides?: number;
}

/**
 * Text bounding box (position and size as percentages 0-100 of canvas).
 */
export interface TextBox {
    /**
     * X position (percentage of canvas width).
     */
    x: number;
    /**
     * Y position (percentage of canvas height).
     */
    y: number;
    /**
     * Width (percentage of canvas width).
     */
    width: number;
    /**
     * Height (percentage of canvas height).
     */
    height: number;
}

/**
 * Text layer data for rendering.
 *
 * All values are pre-evaluated (keyframes resolved before sending to compositor).
 * This allows stateless, parallel rendering across web workers.
 */
export interface TextLayerData {
    /**
     * Unique identifier.
     */
    id: string;
    /**
     * The text content to render.
     */
    text: string;
    /**
     * Bounding box (position and size as percentages).
     */
    box: TextBox;
    /**
     * Text styling.
     */
    style: TextStyle;
    /**
     * Stacking order (higher = on top).
     */
    z_index: number;
    /**
     * Overall opacity (0.0-1.0).
     */
    opacity: number;
    /**
     * Highlight style for karaoke effect.
     */
    highlight_style?: HighlightStyle;
    /**
     * Word indices that are currently highlighted (0-based).
     */
    highlighted_word_indices?: number[];
    /**
     * Transition in effect.
     */
    transition_in?: ActiveTransition;
    /**
     * Transition out effect.
     */
    transition_out?: ActiveTransition;
}

/**
 * Text style configuration.
 */
export interface TextStyle {
    /**
     * Font family name (must be loaded).
     */
    font_family: string;
    /**
     * Font size in pixels.
     */
    font_size: number;
    /**
     * Font weight (100-900, where 400=normal, 700=bold).
     */
    font_weight: number;
    /**
     * Whether text is italic.
     */
    italic: boolean;
    /**
     * Text color (RGBA 0-1).
     */
    color: [number, number, number, number];
    /**
     * Horizontal alignment.
     */
    text_align: TextAlign;
    /**
     * Vertical alignment within the box.
     */
    vertical_align: VerticalAlign;
    /**
     * Line height multiplier (1.0 = normal).
     */
    line_height: number;
    /**
     * Letter spacing in pixels.
     */
    letter_spacing: number;
    /**
     * Background color (RGBA 0-1).
     */
    background_color?: [number, number, number, number];
    /**
     * Background padding in pixels.
     */
    background_padding?: number;
    /**
     * Background border radius in pixels.
     */
    background_border_radius?: number;
}

/**
 * Visual effects that can be applied to any layer.
 *
 * All values use intuitive ranges where 1.0 is the default/neutral.
 */
export interface Effects {
    /**
     * Opacity (0.0 = transparent, 1.0 = opaque).
     */
    opacity: number;
    /**
     * Brightness multiplier (1.0 = normal).
     */
    brightness: number;
    /**
     * Contrast multiplier (1.0 = normal).
     */
    contrast: number;
    /**
     * Saturation multiplier (0.0 = grayscale, 1.0 = normal, 2.0 = oversaturated).
     */
    saturation: number;
    /**
     * Hue rotation in degrees (0-360).
     */
    hue_rotate: number;
    /**
     * Gaussian blur radius in pixels.
     */
    blur: number;
}


/**
 * Audio Engine - main WASM export
 *
 * This struct wraps the AudioMixer and provides the public API for the AudioWorklet.
 */
export class AudioEngine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Append a chunk of interleaved PCM data to a streaming source
     *
     * # Arguments
     * * `source_id` - ID of the streaming source (must have been created with `create_streaming_source`)
     * * `chunk` - Interleaved PCM data (f32)
     */
    append_audio_chunk(source_id: string, chunk: Float32Array): void;
    /**
     * Clear all buffered data for a windowed source (used on seek)
     */
    clear_source_buffer(source_id: string): void;
    /**
     * Create a streaming audio source that receives PCM data incrementally
     *
     * # Arguments
     * * `source_id` - Unique identifier for this audio source (asset ID)
     * * `sample_rate` - Sample rate of the source audio
     * * `channels` - Number of channels (1 or 2)
     * * `estimated_duration` - Optional duration hint in seconds for pre-allocation (0 = no hint)
     */
    create_streaming_source(source_id: string, sample_rate: number, channels: number, estimated_duration: number): void;
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
     */
    create_windowed_source(source_id: string, sample_rate: number, channels: number, duration: number, max_buffer_seconds: number): void;
    /**
     * Mark a streaming source as complete (all data has been received)
     *
     * # Arguments
     * * `source_id` - ID of the streaming source
     */
    finalize_audio(source_id: string): void;
    /**
     * Get buffer misses since last query (diagnostics)
     */
    get_buffer_misses(source_id: string): bigint;
    /**
     * Get the current playback time (for sync feedback)
     */
    get_current_time(): number;
    /**
     * Create a new AudioEngine with the given output sample rate
     */
    constructor(sample_rate: number);
    /**
     * Remove audio data for a source
     */
    remove_audio(source_id: string): void;
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
     */
    render(output: Float32Array, num_frames: number): number;
    /**
     * Seek to a specific time
     */
    seek(time: number): void;
    /**
     * Set master volume (0.0 - 1.0)
     */
    set_master_volume(volume: number): void;
    /**
     * Set playback state
     */
    set_playing(playing: boolean): void;
    /**
     * Update the timeline state (clips, tracks, cross-transitions)
     *
     * # Arguments
     * * `timeline_json` - JSON string containing AudioTimelineState
     */
    set_timeline(timeline_json: string): void;
    /**
     * Update the buffered PCM window for a windowed source
     *
     * # Arguments
     * * `source_id` - ID of the windowed source
     * * `start_time` - Start time in source-time seconds for this chunk
     * * `pcm_data` - Interleaved PCM data (f32)
     */
    update_source_buffer(source_id: string, start_time: number, pcm_data: Float32Array): void;
    /**
     * Upload decoded PCM audio data for a clip
     *
     * # Arguments
     * * `source_id` - Unique identifier for this audio source (asset ID)
     * * `pcm_data` - Interleaved stereo PCM data (f32)
     * * `source_sample_rate` - Sample rate of the source audio
     * * `channels` - Number of channels (1 or 2)
     */
    upload_audio(source_id: string, pcm_data: Float32Array, source_sample_rate: number, channels: number): void;
}

/**
 * RGBA color with components in 0.0-1.0 range.
 */
export class Color {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Parse from hex string (e.g., "#ff0000" or "#ff0000ff").
     */
    static from_hex(hex: string): Color | undefined;
    constructor(r: number, g: number, b: number, a: number);
    /**
     * Create an opaque RGB color.
     */
    static rgb(r: number, g: number, b: number): Color;
    /**
     * Convert to hex string with alpha (e.g., "#ff0000ff").
     */
    to_hex(): string;
    a: number;
    b: number;
    g: number;
    r: number;
}

/**
 * Types of cross-transitions between clips.
 */
export enum CrossTransitionType {
    Dissolve = 0,
    Fade = 1,
    WipeLeft = 2,
    WipeRight = 3,
    WipeUp = 4,
    WipeDown = 5,
}

/**
 * Cubic bezier control points [x1, y1, x2, y2].
 * Controls the acceleration curve of animations and transitions.
 */
export class CubicBezier {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Evaluate the bezier curve at progress t (0.0-1.0).
     * Uses Newton-Raphson iteration to find the curve parameter.
     */
    evaluate(t: number): number;
    constructor(x1: number, y1: number, x2: number, y2: number);
    x1: number;
    x2: number;
    y1: number;
    y2: number;
}

/**
 * Common easing presets.
 */
export enum EasingPreset {
    Linear = 0,
    EaseIn = 1,
    EaseOut = 2,
    EaseInOut = 3,
    Custom = 4,
}

/**
 * Animatable effect property names.
 *
 * Used for keyframe animation targeting.
 */
export enum EffectProperty {
    Opacity = 0,
    Brightness = 1,
    Contrast = 2,
    Saturation = 3,
    HueRotate = 4,
    Blur = 5,
}

/**
 * Interpolation mode between keyframes.
 */
export enum Interpolation {
    /**
     * Linear interpolation between values.
     */
    Linear = 0,
    /**
     * Hold previous value until next keyframe (step function).
     */
    Step = 1,
    /**
     * Cubic bezier interpolation with custom easing.
     */
    Bezier = 2,
}

/**
 * Keyframe evaluator with temporal coherence caching.
 *
 * During sequential playback (frame-by-frame), the current time typically
 * advances by a small delta. This evaluator caches the last keyframe index
 * for each property, allowing O(1) lookups when time moves forward slightly.
 *
 * When seeking (large time jumps), it falls back to binary search O(log n).
 */
export class KeyframeEvaluator {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Clear the temporal cache (call after seeking).
     */
    clear_cache(): void;
    /**
     * Evaluate a property at the given time.
     *
     * Returns `None` (as NaN) if the property doesn't exist.
     */
    evaluate(property: string, time: number): number;
    /**
     * Check if a property exists and has keyframes.
     */
    has_property(property: string): boolean;
    /**
     * Create a new evaluator from a KeyframeTracks object.
     */
    constructor(tracks: any);
    /**
     * Get all animated property names.
     */
    properties(): any;
}

/**
 * Line endpoint head types.
 */
export enum LineHeadType {
    None = 0,
    Arrow = 1,
    Circle = 2,
    Square = 3,
    Diamond = 4,
}

/**
 * Line stroke style.
 */
export enum LineStrokeStyle {
    Solid = 0,
    Dashed = 1,
    Dotted = 2,
}

/**
 * Primitive shape types.
 *
 * - Rectangle: 4-sided shape with optional corner radius (square is equal width/height)
 * - Ellipse: Oval shape (circle is equal width/height)
 * - Polygon: N-sided regular polygon defined by number of sides
 */
export enum ShapeType {
    Rectangle = 0,
    Ellipse = 1,
    Polygon = 2,
}

/**
 * Text alignment.
 */
export enum TextAlign {
    Left = 0,
    Center = 1,
    Right = 2,
}

/**
 * Types of transitions available.
 */
export enum TransitionType {
    None = 0,
    Fade = 1,
    Dissolve = 2,
    WipeLeft = 3,
    WipeRight = 4,
    WipeUp = 5,
    WipeDown = 6,
    SlideLeft = 7,
    SlideRight = 8,
    SlideUp = 9,
    SlideDown = 10,
    ZoomIn = 11,
    ZoomOut = 12,
    RotateCw = 13,
    RotateCcw = 14,
    FlipH = 15,
    FlipV = 16,
}

/**
 * Vertical alignment for text within its box.
 */
export enum VerticalAlign {
    Top = 0,
    Middle = 1,
    Bottom = 2,
}

/**
 * Evaluate a single keyframe track at the given time.
 *
 * This is a convenience function for one-off evaluations.
 * For repeated evaluations, use `KeyframeEvaluator` which caches
 * the last index for better performance.
 */
export function evaluate_track(track: any, time: number): number;

/**
 * Initialize panic hook and logging for better WASM debugging
 */
export function init(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_audioengine_free: (a: number, b: number) => void;
    readonly audioengine_append_audio_chunk: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly audioengine_clear_source_buffer: (a: number, b: number, c: number) => void;
    readonly audioengine_create_streaming_source: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly audioengine_create_windowed_source: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly audioengine_finalize_audio: (a: number, b: number, c: number) => void;
    readonly audioengine_get_buffer_misses: (a: number, b: number, c: number) => bigint;
    readonly audioengine_get_current_time: (a: number) => number;
    readonly audioengine_new: (a: number) => number;
    readonly audioengine_remove_audio: (a: number, b: number, c: number) => void;
    readonly audioengine_render: (a: number, b: number, c: number, d: any, e: number) => number;
    readonly audioengine_seek: (a: number, b: number) => void;
    readonly audioengine_set_master_volume: (a: number, b: number) => void;
    readonly audioengine_set_playing: (a: number, b: number) => void;
    readonly audioengine_set_timeline: (a: number, b: number, c: number) => void;
    readonly audioengine_update_source_buffer: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly audioengine_upload_audio: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly init: () => void;
    readonly __wbg_keyframeevaluator_free: (a: number, b: number) => void;
    readonly evaluate_track: (a: any, b: number) => [number, number, number];
    readonly keyframeevaluator_clear_cache: (a: number) => void;
    readonly keyframeevaluator_evaluate: (a: number, b: number, c: number, d: number) => number;
    readonly keyframeevaluator_has_property: (a: number, b: number, c: number) => number;
    readonly keyframeevaluator_new: (a: any) => [number, number, number];
    readonly keyframeevaluator_properties: (a: number) => [number, number, number];
    readonly __wbg_color_free: (a: number, b: number) => void;
    readonly __wbg_get_color_a: (a: number) => number;
    readonly __wbg_get_color_b: (a: number) => number;
    readonly __wbg_get_color_g: (a: number) => number;
    readonly __wbg_get_color_r: (a: number) => number;
    readonly __wbg_set_color_a: (a: number, b: number) => void;
    readonly __wbg_set_color_b: (a: number, b: number) => void;
    readonly __wbg_set_color_g: (a: number, b: number) => void;
    readonly __wbg_set_color_r: (a: number, b: number) => void;
    readonly color_from_hex: (a: number, b: number) => number;
    readonly color_new: (a: number, b: number, c: number, d: number) => number;
    readonly color_rgb: (a: number, b: number, c: number) => number;
    readonly color_to_hex: (a: number) => [number, number];
    readonly cubicbezier_evaluate: (a: number, b: number) => number;
    readonly __wbg_set_cubicbezier_x1: (a: number, b: number) => void;
    readonly __wbg_set_cubicbezier_x2: (a: number, b: number) => void;
    readonly __wbg_set_cubicbezier_y1: (a: number, b: number) => void;
    readonly __wbg_set_cubicbezier_y2: (a: number, b: number) => void;
    readonly __wbg_get_cubicbezier_x1: (a: number) => number;
    readonly __wbg_get_cubicbezier_x2: (a: number) => number;
    readonly __wbg_get_cubicbezier_y1: (a: number) => number;
    readonly __wbg_get_cubicbezier_y2: (a: number) => number;
    readonly cubicbezier_new: (a: number, b: number, c: number, d: number) => number;
    readonly __wbg_cubicbezier_free: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
