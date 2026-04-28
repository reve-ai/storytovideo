import type { WorkItem } from './types.js';
import type { QueueManager } from './queue-manager.js';
import type { Shot, StoryAnalysis } from '../types.js';

/** Seed downstream work items after `item` completes with `outputs`.
 *  Extracted from `QueueProcessor` so it can also be invoked from
 *  promotion paths (apply.ts → RunManager.promoteCompletedItem).
 *  Behavior must match the in-worker seeding step exactly. */
export function seedDownstream(
  qm: QueueManager,
  item: WorkItem,
  outputs: Record<string, unknown>,
): void {
  switch (item.type) {
    case 'analyze_story':
      seedAfterAnalysis(qm, item);
      break;
    case 'artifact':
      seedAfterArtifact(qm, item);
      break;
    case 'plan_shots':
      seedAfterPlanShots(qm, item, outputs);
      break;
    case 'generate_frame':
      seedAfterGenerateFrame(qm, item, outputs);
      break;
    case 'generate_video':
      seedAfterGenerateVideo(qm, item, outputs);
      break;
  }
}

export function seedAfterAnalysis(qm: QueueManager, analyzeItem: WorkItem): void {
  const state = qm.getState();
  const analysis = state.storyAnalysis;
  if (!analysis) return;

  for (const char of analysis.characters) {
    qm.addItem({
      type: 'artifact',
      queue: 'llm',
      itemKey: `artifact:character:${char.name}`,
      dependencies: [analyzeItem.id],
      inputs: {
        artifactType: 'character',
        name: char.name,
        physicalDescription: char.physicalDescription,
        personality: char.personality,
        ageRange: char.ageRange,
      },
      priority: analyzeItem.priority,
    });
  }

  for (const loc of analysis.locations) {
    qm.addItem({
      type: 'artifact',
      queue: 'llm',
      itemKey: `artifact:location:${loc.name}`,
      dependencies: [analyzeItem.id],
      inputs: {
        artifactType: 'location',
        name: loc.name,
        visualDescription: loc.visualDescription,
      },
      priority: analyzeItem.priority,
    });
  }

  for (const obj of (analysis.objects ?? [])) {
    qm.addItem({
      type: 'artifact',
      queue: 'llm',
      itemKey: `artifact:object:${obj.name}`,
      dependencies: [analyzeItem.id],
      inputs: {
        artifactType: 'object',
        name: obj.name,
        visualDescription: obj.visualDescription,
      },
      priority: analyzeItem.priority,
    });
  }

  for (const scene of analysis.scenes) {
    qm.addItem({
      type: 'artifact',
      queue: 'llm',
      itemKey: `artifact:scene:${scene.sceneNumber}`,
      dependencies: [analyzeItem.id],
      inputs: {
        artifactType: 'scene',
        sceneNumber: scene.sceneNumber,
        title: scene.title,
        narrativeSummary: scene.narrativeSummary,
        charactersPresent: scene.charactersPresent,
        location: scene.location,
        estimatedDurationSeconds: scene.estimatedDurationSeconds,
      },
      priority: analyzeItem.priority,
    });
  }

  qm.addItem({
    type: 'artifact',
    queue: 'llm',
    itemKey: 'artifact:pacing',
    dependencies: [analyzeItem.id],
    inputs: {
      artifactType: 'pacing',
      title: analysis.title,
      artStyle: analysis.artStyle,
    },
    priority: analyzeItem.priority,
  });
}

export function seedAfterArtifact(qm: QueueManager, item: WorkItem): void {
  const state = qm.getState();
  const artifactType = item.inputs.artifactType as string;

  switch (artifactType) {
    case 'character': {
      qm.addItem({
        type: 'generate_asset',
        queue: 'image',
        itemKey: `asset:character:${item.inputs.name}:front`,
        dependencies: [item.id],
        inputs: {
          characterName: item.inputs.name,
          description: item.inputs.physicalDescription,
          artStyle: state.storyAnalysis?.artStyle ?? '',
        },
        priority: item.priority,
      });
      break;
    }
    case 'location': {
      qm.addItem({
        type: 'generate_asset',
        queue: 'image',
        itemKey: `asset:location:${item.inputs.name}`,
        dependencies: [item.id],
        inputs: {
          locationName: item.inputs.name,
          description: item.inputs.visualDescription,
          artStyle: state.storyAnalysis?.artStyle ?? '',
        },
        priority: item.priority,
      });
      break;
    }
    case 'object': {
      qm.addItem({
        type: 'generate_asset',
        queue: 'image',
        itemKey: `asset:object:${item.inputs.name}`,
        dependencies: [item.id],
        inputs: {
          objectName: item.inputs.name,
          description: item.inputs.visualDescription,
          artStyle: state.storyAnalysis?.artStyle ?? '',
        },
        priority: item.priority,
      });
      break;
    }
    case 'scene': {
      qm.addItem({
        type: 'plan_shots',
        queue: 'llm',
        itemKey: `plan_shots:scene:${item.inputs.sceneNumber}`,
        dependencies: [item.id],
        inputs: { sceneNumber: item.inputs.sceneNumber },
        priority: item.priority,
      });
      break;
    }
    case 'pacing':
      break;
  }
}

export function seedAfterPlanShots(
  qm: QueueManager,
  planItem: WorkItem,
  outputs: Record<string, unknown>,
): void {
  const state = qm.getState();
  const analysis = state.storyAnalysis;
  if (!analysis) return;

  const shots = outputs.shots as Shot[] | undefined;
  if (!shots || shots.length === 0) return;

  for (const shot of shots) {
    const shotAssetIds = getAssetItemIdsForShot(qm, shot);
    const frameDeps = [planItem.id, ...shotAssetIds];

    if (shot.continuousFromPrevious && shot.shotInScene > 1) {
      frameDeps.push(`video:scene:${shot.sceneNumber}:shot:${shot.shotInScene - 1}`);
    }

    qm.addItem({
      type: 'generate_frame',
      queue: 'image',
      itemKey: `frame:scene:${shot.sceneNumber}:shot:${shot.shotInScene}`,
      dependencies: frameDeps,
      inputs: { shot },
      priority: planItem.priority,
    });
  }
}

export function seedAfterGenerateFrame(
  qm: QueueManager,
  frameItem: WorkItem,
  outputs: Record<string, unknown>,
): void {
  const startPath = outputs.startPath as string | undefined;
  const shot = frameItem.inputs.shot as Shot;

  if (!startPath) return;

  const existingVideo = qm.getItemsByKey(`video:scene:${shot.sceneNumber}:shot:${shot.shotInScene}`);
  if (existingVideo.some(i => i.status !== 'superseded' && i.status !== 'cancelled' && i.dependencies.includes(frameItem.id))) {
    return;
  }

  qm.addItem({
    type: 'generate_video',
    queue: 'video',
    itemKey: `video:scene:${shot.sceneNumber}:shot:${shot.shotInScene}`,
    dependencies: [frameItem.id],
    inputs: {
      shot,
      startFramePath: startPath,
      endFramePath: outputs.endPath as string | undefined,
    },
    priority: frameItem.priority,
  });
}

function seedContinuityFrameAfterGenerateVideo(
  qm: QueueManager,
  videoItem: WorkItem,
  analysis: StoryAnalysis,
  shot: Shot,
): void {
  const scene = analysis.scenes.find(candidate => candidate.sceneNumber === shot.sceneNumber);
  const nextShot = scene?.shots.find(candidate => candidate.shotInScene === shot.shotInScene + 1);

  if (!nextShot || nextShot.skipped || !nextShot.continuousFromPrevious) {
    return;
  }

  const frameKey = `frame:scene:${nextShot.sceneNumber}:shot:${nextShot.shotInScene}`;
  const existingFrame = qm.getItemsByKey(frameKey);
  const hasActiveFrame = existingFrame.some(
    item => item.status !== 'superseded' && item.status !== 'cancelled'
  );

  if (hasActiveFrame) {
    return;
  }

  qm.addItem({
    type: 'generate_frame',
    queue: 'image',
    itemKey: frameKey,
    dependencies: [videoItem.id],
    inputs: { shot: nextShot },
    priority: videoItem.priority,
  });
}

export function seedAfterGenerateVideo(
  qm: QueueManager,
  item: WorkItem,
  outputs: Record<string, unknown>,
): void {
  const state = qm.getState();
  const analysis = state.storyAnalysis;
  if (!analysis) return;

  const shotNumber = outputs.shotNumber as number;
  const videoPath = outputs.path as string;
  const startFramePath = item.inputs.startFramePath as string;
  const shot = item.inputs.shot as Shot;

  let analyzeShot = shot;
  if (shot.continuousFromPrevious && shot.shotInScene > 1) {
    analyzeShot = { ...shot, startFramePrompt: 'Start frame is the previous clip end frame.' };
  }

  seedContinuityFrameAfterGenerateVideo(qm, item, analysis, shot);

  const referenceImagePaths: string[] = [];
  for (const [key, value] of Object.entries(state.generatedOutputs)) {
    if (key.startsWith('character:') || key.startsWith('location:') || key.startsWith('object:')) {
      const name = key.split(':')[1];
      if (
        shot.charactersPresent.includes(name) ||
        shot.objectsPresent?.includes(name) ||
        shot.location === name
      ) {
        referenceImagePaths.push(value);
      }
    }
  }

  const existingAnalyze = qm.getItemsByKey(`analyze_video:scene:${shot.sceneNumber}:shot:${shot.shotInScene}`);
  const hasCurrentAnalysis = existingAnalyze.some(
    i => i.status !== 'superseded' && i.status !== 'cancelled' && i.dependencies.includes(item.id)
  );
  if (!hasCurrentAnalysis) {
    qm.addItem({
      type: 'analyze_video',
      queue: 'llm',
      itemKey: `analyze_video:scene:${shot.sceneNumber}:shot:${shot.shotInScene}`,
      dependencies: [item.id],
      inputs: {
        shotNumber,
        videoPath,
        startFramePath,
        referenceImagePaths,
        shot: analyzeShot,
      },
      priority: item.priority,
    });
  }

  const allShots = analysis.scenes.flatMap(s => s.shots || []).filter(s => !s.skipped);
  const allVideosDone = allShots.every(s => {
    const items = qm.getItemsByKey(`video:scene:${s.sceneNumber}:shot:${s.shotInScene}`);
    return items.some(i => i.status === 'completed' && !i.supersededBy);
  });

  if (!allVideosDone) return;

  const existingAssemble = qm.getItemsByKey('assemble');
  if (existingAssemble.some(i => i.status !== 'superseded' && i.status !== 'cancelled')) return;

  const videoKeys = allShots.map(
    s => `video:scene:${s.sceneNumber}:shot:${s.shotInScene}`
  );

  qm.addItem({
    type: 'assemble',
    queue: 'llm',
    itemKey: 'assemble',
    dependencies: videoKeys,
  });
}

function getAssetItemIdsForShot(qm: QueueManager, shot: Shot): string[] {
  const ids: string[] = [];

  for (const charName of shot.charactersPresent) {
    const items = qm.getItemsByKey(`asset:character:${charName}:front`);
    const active = items.find(i => i.status !== 'superseded' && i.status !== 'cancelled');
    if (active) ids.push(active.id);
  }

  if (shot.location) {
    const items = qm.getItemsByKey(`asset:location:${shot.location}`);
    const active = items.find(i => i.status !== 'superseded' && i.status !== 'cancelled');
    if (active) ids.push(active.id);
  }

  for (const objName of (shot.objectsPresent ?? [])) {
    const items = qm.getItemsByKey(`asset:object:${objName}`);
    const active = items.find(i => i.status !== 'superseded' && i.status !== 'cancelled');
    if (active) ids.push(active.id);
  }

  return ids;
}

