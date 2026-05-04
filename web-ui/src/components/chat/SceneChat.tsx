import { useRunStore } from "../../stores/run-store";
import ScopedChatPanel from "./ScopedChatPanel";
import SceneForm from "./SceneForm";
import SceneInspector from "./SceneInspector";

interface Props {
  sceneNumber: number;
}

export default function SceneChat({ sceneNumber }: Props) {
  const activeRunId = useRunStore((s) => s.activeRunId);
  if (!activeRunId) return null;
  const scopeKey = String(sceneNumber);
  return (
    <ScopedChatPanel
      runId={activeRunId}
      scope="scene"
      scopeKey={scopeKey}
      title={`Edit scene ${sceneNumber}`}
      renderForm={() => (
        <SceneForm
          runId={activeRunId}
          scope="scene"
          scopeKey={scopeKey}
        />
      )}
      renderInspector={({ messages }) => (
        <SceneInspector
          runId={activeRunId}
          scope="scene"
          scopeKey={scopeKey}
          messages={messages}
        />
      )}
    />
  );
}