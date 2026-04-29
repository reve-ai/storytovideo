import { usePipelineStore, WorkItem } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";
import { useUIStore } from "../stores/ui-store";
import { useHasDraft } from "../stores/chat-drafts-store";
import ShotCard from "./ShotCard";
import DraftBadge from "./DraftBadge";

interface SceneData {
  frames: Map<number, WorkItem>;
  videos: Map<number, WorkItem>;
  location: string | null;
}

interface SceneSectionProps {
  sceneNum: number;
  sceneData: SceneData;
  sceneTitle: string;
  location: string;
  aspectRatio: string;
}

export default function SceneSection({
  sceneNum,
  sceneData,
  sceneTitle,
  location,
  aspectRatio,
}: SceneSectionProps) {
  const skippedShots = usePipelineStore(s => s.skippedShots);
  const existingShots = usePipelineStore(s => s.existingShots);
  const openLocationChat = useUIStore(s => s.openLocationChat);
  const locationHasDraft = useHasDraft("location", location || null);
  const hasExistingShots = Object.keys(existingShots).length > 0;
  const shotNums = new Set([
    ...sceneData.frames.keys(),
    ...sceneData.videos.keys(),
  ]);
  // Filter out orphaned shots that no longer exist in the current storyAnalysis
  const sortedShots = [...shotNums]
    .filter(shotNum => !hasExistingShots || existingShots[`${sceneNum}:${shotNum}`])
    .sort((a, b) => a - b);

  return (
    <div className="story-scene">
      <div className="story-scene-header">
        <h2 className="story-scene-title">
          Scene {sceneNum}: {sceneTitle}
        </h2>
        {location && (
          <button
            type="button"
            className="story-scene-location"
            onClick={() => openLocationChat(location)}
            title="Edit location"
          >
            📍 {location}
            {locationHasDraft && <DraftBadge />}
          </button>
        )}
      </div>
      <div className="story-shots-grid">
        {sortedShots.map((shotNum) => {
          const frameItem = sceneData.frames.get(shotNum);
          const videoItem = sceneData.videos.get(shotNum);
          const shot = (frameItem?.inputs?.shot ?? videoItem?.inputs?.shot) as Record<string, unknown> | undefined;
          const isSkipped = Boolean(skippedShots[`${sceneNum}:${shotNum}`]);
          const activeRunId = useRunStore.getState().activeRunId;

          return (
            <div key={shotNum} className={`shot-wrapper${isSkipped ? " shot-skipped" : ""}`}>
              <ShotCard
                shotNum={shotNum}
                frameItem={frameItem}
                videoItem={videoItem}
                aspectRatio={aspectRatio}
                showSkip={Boolean(activeRunId && shot)}
                isSkipped={isSkipped}
                onSkipToggle={activeRunId && shot ? async () => {
                  if (!shot?.sceneNumber || !shot?.shotInScene) return;
                  try {
                    await fetch(`/api/runs/${activeRunId}/shots/${shot.sceneNumber}/${shot.shotInScene}/skip`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ skipped: !isSkipped }),
                    });
                    const { fetchQueues } = usePipelineStore.getState();
                    await fetchQueues(activeRunId);
                  } catch (err) {
                    console.error('[skip] error', err);
                  }
                } : undefined}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

