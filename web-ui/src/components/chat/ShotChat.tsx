import { useRunStore } from "../../stores/run-store";
import ScopedChatPanel from "./ScopedChatPanel";
import ShotForm from "./ShotForm";
import ShotInspector from "./ShotInspector";

interface Props {
  sceneNumber: number;
  shotInScene: number;
}

export default function ShotChat({ sceneNumber, shotInScene }: Props) {
  const activeRunId = useRunStore((s) => s.activeRunId);
  if (!activeRunId) return null;
  const scopeKey = `${sceneNumber}-${shotInScene}`;
  return (
    <ScopedChatPanel
      runId={activeRunId}
      scope="shot"
      scopeKey={scopeKey}
      sceneNumber={sceneNumber}
      shotInScene={shotInScene}
      title={`Edit shot ${sceneNumber}.${shotInScene}`}
      renderForm={() => (
        <ShotForm
          runId={activeRunId}
          scope="shot"
          scopeKey={scopeKey}
          sceneNumber={sceneNumber}
          shotInScene={shotInScene}
        />
      )}
      renderInspector={({ messages }) => (
        <ShotInspector
          runId={activeRunId}
          scope="shot"
          scopeKey={scopeKey}
          sceneNumber={sceneNumber}
          shotInScene={shotInScene}
          messages={messages}
        />
      )}
    />
  );
}
