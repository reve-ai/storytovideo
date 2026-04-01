import { useMemo } from "react";
import { usePipelineStore, WorkItem } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";
import SceneSection from "../components/SceneSection";

/** Collect all items across all queues (non-null). */
function getAllItems(
  queues: ReturnType<typeof usePipelineStore.getState>["queues"],
): WorkItem[] {
  const items: WorkItem[] = [];
  for (const qName of ["llm", "image", "video"] as const) {
    const q = queues[qName];
    if (!q) continue;
    for (const group of [
      q.inProgress,
      q.pending,
      q.completed,
      q.failed,
      q.superseded,
      q.cancelled,
    ]) {
      if (group) items.push(...group);
    }
  }
  return items;
}

interface SceneData {
  frames: Map<number, WorkItem>;
  videos: Map<number, WorkItem>;
  location: string | null;
}

export default function StoryView() {
  const queues = usePipelineStore((s) => s.queues);
  const runs = useRunStore((s) => s.runs);
  const activeRunId = useRunStore((s) => s.activeRunId);

  const { sortedScenes, planByScene, aspectRatio } = useMemo(() => {
    const allItems = getAllItems(queues);
    const frameItems = allItems.filter(
      (i) => i.type === "generate_frame" && i.status !== "superseded" && i.status !== "cancelled",
    );
    const videoItems = allItems.filter(
      (i) => i.type === "generate_video" && i.status !== "superseded" && i.status !== "cancelled",
    );
    const planItems = allItems.filter(
      (i) => i.type === "plan_shots" && i.status === "completed",
    );

    const sceneMap = new Map<number, SceneData>();

    for (const item of frameItems) {
      const shot = item.inputs?.shot as Record<string, unknown> | undefined;
      const sceneNum = shot?.sceneNumber as number | undefined;
      if (sceneNum == null) continue;
      if (!sceneMap.has(sceneNum))
        sceneMap.set(sceneNum, {
          frames: new Map(),
          videos: new Map(),
          location: null,
        });
      const scene = sceneMap.get(sceneNum)!;
      const shotNum = shot?.shotInScene as number | undefined;
      if (shotNum != null) {
        const existing = scene.frames.get(shotNum);
        if (!existing || item.version > existing.version)
          scene.frames.set(shotNum, item);
      }
      if (!scene.location && shot?.location)
        scene.location = shot.location as string;
    }

    for (const item of videoItems) {
      const shot = item.inputs?.shot as Record<string, unknown> | undefined;
      const sceneNum = shot?.sceneNumber as number | undefined;
      if (sceneNum == null) continue;
      if (!sceneMap.has(sceneNum))
        sceneMap.set(sceneNum, {
          frames: new Map(),
          videos: new Map(),
          location: null,
        });
      const scene = sceneMap.get(sceneNum)!;
      const shotNum = shot?.shotInScene as number | undefined;
      if (shotNum != null) {
        const existing = scene.videos.get(shotNum);
        if (!existing || item.version > existing.version)
          scene.videos.set(shotNum, item);
      }
      if (!scene.location && shot?.location)
        scene.location = shot.location as string;
    }

    const pbs = new Map<number, WorkItem>();
    for (const item of planItems) {
      const sceneNum =
        (item.outputs?.sceneNumber as number) ??
        (item.inputs?.sceneNumber as number);
      if (sceneNum != null) pbs.set(sceneNum, item);
    }

    const run = runs.find((r) => r.id === activeRunId);
    const ar = (run?.options?.aspectRatio ?? "16:9").replace(":", "/");

    return {
      sortedScenes: [...sceneMap.entries()].sort((a, b) => a[0] - b[0]),
      planByScene: pbs,
      aspectRatio: ar,
    };
  }, [queues, runs, activeRunId]);

  if (sortedScenes.length === 0) {
    return (
      <div className="story-empty">
        No shots found yet. Waiting for frame/video generation to begin.
      </div>
    );
  }

  return (
    <div className="p-3">
      {sortedScenes.map(([sceneNum, sceneData]) => {
        const plan = planByScene.get(sceneNum);
        const sceneTitle =
          (plan?.outputs?.title as string) ?? `Scene ${sceneNum}`;
        const location =
          sceneData.location ??
          (plan?.outputs?.location as string) ??
          "";
        return (
          <SceneSection
            key={sceneNum}
            sceneNum={sceneNum}
            sceneData={sceneData}
            sceneTitle={sceneTitle}
            location={location}
            aspectRatio={aspectRatio}
          />
        );
      })}
    </div>
  );
}

