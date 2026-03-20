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

export interface Shot {
  shotNumber: number;          // global shot number across entire video
  sceneNumber: number;         // which scene this belongs to
  shotInScene: number;         // shot index within the scene (1, 2, 3...)
  durationSeconds: number;         // seconds (0.5-10). Veo always uses 8; ComfyUI supports arbitrary.
  shotType: "first_last_frame";
  composition: string;         // "wide_establishing" | "over_the_shoulder" | "two_shot" | "close_up" | "medium_shot" | "tracking" | "pov" | "insert_cutaway" | "low_angle" | "high_angle"
  startFramePrompt: string;
  endFramePrompt: string;      // only for first_last_frame
  actionPrompt: string;
  dialogue: string;            // quoted speech (empty if none)
  soundEffects: string;
  cameraDirection: string;
  charactersPresent: string[];
  location: string;
  continuousFromPrevious: boolean;
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
  scenes: Scene[];
}

export interface AssetLibrary {
  characterImages: Record<string, { front: string; angle: string }>;  // paths
  locationImages: Record<string, string>;                              // paths
}

export interface VerificationResult {
  passed: boolean;
  score: number;               // 0.0-1.0
  issues: string[];
  suggestions: string[];       // prompt improvements
}

export interface ItemDirective {
  target: string;        // item key, e.g. "shot:16:start_frame", "shot:16:video", "asset:character:Lupov:front", "shot:8:action_prompt"
  directive: string;     // user's instruction, e.g. "make the lighting darker, more ominous"
  createdAt: string;
  updatedAt: string;
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
  reviewMode?: boolean;
  videoBackend?: "veo" | "comfy";
  onToolError?: (stageName: string, toolName: string, error: string) => void;
  onProgress?: (message: string) => void;
  abortSignal?: AbortSignal;
}

export interface StageInstructionRecord {
  stage: string;
  instruction: string;
  submittedAt: string;
}

export interface StageDecisionRecord {
  stage: string;
  decision: "continue" | "instruction";
  decidedAt: string;
  instructionCount: number;
}

export interface PipelineState {
  storyFile: string;
  outputDir: string;
  currentStage: string;
  completedStages: string[];
  storyAnalysis: StoryAnalysis | null;
  assetLibrary: AssetLibrary | null;
  generatedAssets: Record<string, string>;        // { "character:Bolt:front": "path", ... } — item-level tracking
  generatedFrames: Record<number, { start?: string; end?: string }>;
  generatedVideos: Record<number, string>;
  errors: Array<{ stage: string; shot?: number; error: string; timestamp: string }>;
  verifications: Array<{ stage: string; shot?: number; passed: boolean; score: number; issues: string[]; timestamp: string }>;
  interrupted: boolean;                            // true if last run was interrupted
  awaitingUserReview: boolean;                     // true when next stage needs explicit user continue
  continueRequested: boolean;                      // true when user requested continue while awaiting review
  pendingStageInstructions: Record<string, string[]>;
  instructionHistory: StageInstructionRecord[];
  decisionHistory: StageDecisionRecord[];
  pendingJobs: Record<string, { jobId: string; outputPath: string }>;
  importedAudio?: Record<number, string>;              // shotNumber → audio file path (from import pipeline)
  itemDirectives: Record<string, ItemDirective>;     // keyed by target
  rollbackTarget?: string;                          // stage to roll back to (set by RAI handler)
  lastSavedAt: string;                             // ISO timestamp of last state save
}
