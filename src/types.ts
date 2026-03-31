export interface Character {
  name: string;
  physicalDescription: string;  // detailed: face, body, clothing, features
  personality: string;
  ageRange: string;
}

export interface Location {
  name: string;
  visualDescription: string;  // architecture, lighting, colors, atmosphere
}

export interface StoryObject {
  name: string;
  visualDescription: string;  // shape, color, size, distinguishing features
}

export interface Shot {
  shotNumber: number;          // global shot number across entire video
  sceneNumber: number;         // which scene this belongs to
  shotInScene: number;         // shot index within the scene (1, 2, 3...)
  durationSeconds: number;         // seconds (0.5-10). Veo always uses 8; ComfyUI supports arbitrary.
  shotType: "first_last_frame";
  composition: string;         // "wide_establishing" | "over_the_shoulder" | "two_shot" | "close_up" | "medium_shot" | "tracking" | "pov" | "insert_cutaway" | "low_angle" | "high_angle"
  startFramePrompt: string;
  endFramePrompt?: string;      // deprecated — kept optional for backward compat with saved data
  actionPrompt?: string;        // deprecated — replaced by videoPrompt; kept optional for backward compat with saved data
  dialogue: string;            // quoted speech (empty if none)
  speaker: string;             // who is speaking (character name, "narrator", "voiceover", etc; empty if no dialogue)
  soundEffects: string;
  cameraDirection: string;
  videoPrompt: string;          // complete video direction as natural prose from the planner
  charactersPresent: string[];
  objectsPresent: string[];
  location: string;
  continuousFromPrevious?: boolean;
  skipped?: boolean;           // if true, excluded from final assembly and generation
}

export interface Scene {
  sceneNumber: number;
  title: string;
  narrativeSummary: string;
  charactersPresent: string[];
  location: string;
  estimatedDurationSeconds: number;
  shots: Shot[];               // filled by Claude orchestrator
  transition: "cut" | "fade_black";  // transition INTO this scene (scene 1 is always "cut")
}

export interface StoryAnalysis {
  title: string;
  artStyle: string;
  characters: Character[];
  locations: Location[];
  objects: StoryObject[];
  scenes: Scene[];
}

export interface AssetLibrary {
  characterImages: Record<string, { front: string; angle: string }>;  // paths
  locationImages: Record<string, string>;                              // paths
  objectImages: Record<string, string>;                                // paths
}

export interface ArtifactVersion {
  version: number;
  path: string;
  timestamp: string;
  duration?: number;        // for videos
  promptSent?: string;      // for videos
  pacingAdjusted?: boolean; // if this was a pacing regen
  references?: FrameReference[]; // for frames
  reason?: string;          // why this version was created (e.g. "redo", "directive")
}

export interface FrameReference {
  type: "character" | "location" | "object" | "continuity" | "collage";
  name: string;
  path: string;
}

export type ImageBackend = "grok" | "reve" | "nano-banana";
export type VideoBackend = "veo" | "grok" | "ltx-full" | "ltx-distilled";

export interface GeneratedFrameSet {
  start?: string;
  startReferences?: FrameReference[];
  end?: string;                    // deprecated — kept optional for backward compat with saved data
  endReferences?: FrameReference[]; // deprecated — kept optional for backward compat with saved data
}

export interface PipelineOptions {
  outputDir: string;
  dryRun: boolean;
  verify: boolean;
  maxRetries: number;
  skipTo?: string;
  redo?: string;
  resume: boolean;
  verbose: boolean;
  imageBackend?: ImageBackend;
  assetImageBackend?: ImageBackend;
  videoBackend?: VideoBackend;
  aspectRatio?: "16:9" | "9:16" | "1:1";
  onToolError?: (stageName: string, toolName: string, error: string) => void;
  onProgress?: (message: string) => void;
  onNameRun?: (name: string) => void;
  abortSignal?: AbortSignal;
}

export interface PipelineState {
  storyFile: string;
  outputDir: string;
  currentStage: string;
  completedStages: string[];
  storyAnalysis: StoryAnalysis | null;
  assetLibrary: AssetLibrary | null;
  generatedAssets: Record<string, string>;        // { "character:Bolt:front": "path", ... } — item-level tracking
  generatedFrames: Record<number, GeneratedFrameSet>;
  generatedVideos: Record<number, string>;
	videoPromptsSent?: Record<number, string>;
  errors: Array<{ stage: string; shot?: number; error: string; timestamp: string }>;
  interrupted: boolean;                            // true if last run was interrupted
  pendingJobs: Record<string, { jobId: string; outputPath: string }>;
  importedAudio?: Record<number, string>;              // shotNumber → audio file path (from import pipeline)
  videoVersions?: Record<number, ArtifactVersion[]>;    // shotNumber -> versions
  frameVersions?: Record<number, Record<string, ArtifactVersion[]>>; // shotNumber -> { start: versions }
  selectedVersions?: {
    videos?: Record<number, number>;  // shotNumber -> version number
    frames?: Record<number, Record<string, number>>; // shotNumber -> { start: version }
  };
  assetVersions?: Record<string, ArtifactVersion[]>;  // asset key -> versions
  selectedAssetVersions?: Record<string, number>;      // asset key -> selected version number
  convertedScript?: string;                        // visual script generated from raw story by storyToScript
  manualDurations?: Record<string, boolean>;       // scene-scoped shot key -> true if user manually set duration
  lastSavedAt: string;                             // ISO timestamp of last state save
}
