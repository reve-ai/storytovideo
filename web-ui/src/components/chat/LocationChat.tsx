import { useRunStore } from "../../stores/run-store";
import ScopedChatPanel from "./ScopedChatPanel";
import LocationForm from "./LocationForm";
import LocationInspector from "./LocationInspector";

interface Props {
  locationName: string;
}

export default function LocationChat({ locationName }: Props) {
  const activeRunId = useRunStore((s) => s.activeRunId);
  if (!activeRunId) return null;
  // chatBaseUrl URL-encodes the scopeKey for transport; the backend stores
  // the encoded form on disk and decodes it for canonical lookups.
  const scopeKey = locationName;
  return (
    <ScopedChatPanel
      runId={activeRunId}
      scope="location"
      scopeKey={scopeKey}
      title={`Edit location: ${locationName}`}
      renderForm={() => (
        <LocationForm
          runId={activeRunId}
          scope="location"
          scopeKey={scopeKey}
        />
      )}
      renderInspector={({ messages }) => (
        <LocationInspector
          runId={activeRunId}
          scope="location"
          scopeKey={scopeKey}
          messages={messages}
        />
      )}
    />
  );
}
