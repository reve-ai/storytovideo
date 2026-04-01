import { usePipelineStore, WorkItem } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";
import ShotCard from "./ShotCard";

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
  const shotNums = new Set([
    ...sceneData.frames.keys(),
    ...sceneData.videos.keys(),
  ]);
  const sortedShots = [...shotNums].sort((a, b) => a - b);

  return (
    <div className="story-scene">
      <div className="story-scene-header">
        <h2 className="story-scene-title">
          Scene {sceneNum}: {sceneTitle}
        </h2>
        {location && (
          <span className="story-scene-location">📍 {location}</span>
        )}
      </div>
      <div className="story-shots-grid">
        {sortedShots.map((shotNum) => {
          const frameItem = sceneData.frames.get(shotNum);
          const videoItem = sceneData.videos.get(shotNum);
          const shot = (frameItem?.inputs?.shot ?? videoItem?.inputs?.shot) as Record<string, unknown> | undefined;
          const isSkipped = Boolean(shot?.skipped);
          const activeRunId = useRunStore.getState().activeRunId;

          return (
            <div key={shotNum} className={`shot-wrapper${isSkipped ? " shot-skipped" : ""}`}>
              <ShotCard
                shotNum={shotNum}
                frameItem={frameItem}
                videoItem={videoItem}
                aspectRatio={aspectRatio}
              />
              {activeRunId && shot && (
                <button
                  className={`skip-shot-btn${isSkipped ? " active" : ""}`}
                  onClick={async (e) => {
                    e.stopPropagation();
                    await fetch(`/api/runs/${activeRunId}/shots/${shot.sceneNumber}/${shot.shotInScene}/skip`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ skipped: !isSkipped }),
                    });
                    const { fetchQueues } = usePipelineStore.getState();
                    await fetchQueues(activeRunId);
                  }}
                >
                  {isSkipped ? "Unskip" : "Skip"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

