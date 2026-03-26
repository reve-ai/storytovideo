import type { StoryAnalysis, AssetLibrary } from '../types.js';

// Work item types matching each pipeline step
export type WorkItemType =
  | 'story_to_script'
  | 'analyze_story'
  | 'artifact'
  | 'name_run'
  | 'plan_shots'
  | 'generate_asset'
  | 'generate_frame'
  | 'generate_video'
  | 'analyze_video'
  | 'assemble';

// Which queue processes a given work item
export type QueueName = 'llm' | 'image' | 'video';

// Priority lanes
export type Priority = 'normal' | 'high';

// Work item lifecycle
export type WorkItemStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'superseded';

export interface WorkItem {
  id: string;
  type: WorkItemType;
  queue: QueueName;
  status: WorkItemStatus;
  priority: Priority;
  version: number;                      // starts at 1, increments on redo
  itemKey: string;                      // stable identifier, e.g. "frame:scene:1:shot:3", shared across versions
  dependencies: string[];               // IDs of work items that must complete first
  inputs: Record<string, unknown>;      // data needed to execute
  outputs: Record<string, unknown>;     // results after completion
  retryCount: number;                   // number of times this item has been retried (0 = first attempt)
  error: string | null;                 // error message if failed
  reviewStatus?: string;                // review status for analyze_video items (e.g. "pending", "approved", "rejected")
  supersededBy: string | null;          // ID of the newer version that replaced this item
  createdAt: string;                    // ISO timestamp
  startedAt: string | null;            // ISO timestamp
  completedAt: string | null;          // ISO timestamp
}

// Full state of a queue-based run, persisted to disk
export interface RunState {
  runId: string;
  storyFile: string;
  outputDir: string;
  createdAt: string;
  updatedAt: string;

  // All work items in this run
  workItems: WorkItem[];

  // Pipeline data (populated as items complete)
  storyAnalysis: StoryAnalysis | null;
  assetLibrary: AssetLibrary | null;
  convertedScript: string | null;
  runName: string | null;

  // Generated output paths, keyed by item key
  generatedOutputs: Record<string, string>;

  // Shots whose duration was manually set by the user (skip pacing analysis)
  manualDurations?: Record<string, boolean>;

  // Run options (aspect ratio, etc.)
  options?: { aspectRatio?: string; needsConversion?: boolean; dryRun?: boolean };
}

// Snapshot of a single queue for the UI list view
export interface QueueSnapshot {
  queue: QueueName;
  pending: WorkItem[];
  inProgress: WorkItem[];
  completed: WorkItem[];
  failed: WorkItem[];
  cancelled: WorkItem[];
  superseded: WorkItem[];
}

// Node in the dependency graph visualization
export interface DependencyGraphNode {
  id: string;
  itemKey: string;
  type: WorkItemType;
  status: WorkItemStatus;
  version: number;
  queue: QueueName;
  priority: Priority;
}

// Edge in the dependency graph visualization
export interface DependencyGraphEdge {
  from: string;  // dependency item ID
  to: string;    // dependent item ID
}

export interface DependencyGraph {
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
}

