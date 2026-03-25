import { WorkItem } from "../stores/pipeline-store";
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
        {sortedShots.map((shotNum) => (
          <ShotCard
            key={shotNum}
            shotNum={shotNum}
            frameItem={sceneData.frames.get(shotNum)}
            videoItem={sceneData.videos.get(shotNum)}
            aspectRatio={aspectRatio}
          />
        ))}
      </div>
    </div>
  );
}

