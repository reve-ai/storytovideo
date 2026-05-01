import { useRunStore } from "../../stores/run-store";
import ScopedChatPanel from "./ScopedChatPanel";
import ObjectForm from "./ObjectForm";
import ObjectInspector from "./ObjectInspector";

interface Props {
  objectName: string;
}

export default function ObjectChat({ objectName }: Props) {
  const activeRunId = useRunStore((s) => s.activeRunId);
  if (!activeRunId) return null;
  // chatBaseUrl URL-encodes the scopeKey for transport; the backend stores
  // the encoded form on disk and decodes it for canonical lookups.
  const scopeKey = objectName;
  return (
    <ScopedChatPanel
      runId={activeRunId}
      scope="object"
      scopeKey={scopeKey}
      title={`Edit object: ${objectName}`}
      renderForm={() => (
        <ObjectForm
          runId={activeRunId}
          scope="object"
          scopeKey={scopeKey}
        />
      )}
      renderInspector={({ messages }) => (
        <ObjectInspector
          runId={activeRunId}
          scope="object"
          scopeKey={scopeKey}
          messages={messages}
        />
      )}
    />
  );
}
