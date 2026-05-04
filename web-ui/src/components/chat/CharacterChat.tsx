import { useRunStore } from "../../stores/run-store";
import ScopedChatPanel from "./ScopedChatPanel";
import CharacterForm from "./CharacterForm";
import CharacterInspector from "./CharacterInspector";

interface Props {
  characterName: string;
}

export default function CharacterChat({ characterName }: Props) {
  const activeRunId = useRunStore((s) => s.activeRunId);
  if (!activeRunId) return null;
  // chatBaseUrl URL-encodes the scopeKey for transport; the backend stores
  // the encoded form on disk and decodes it for canonical lookups.
  const scopeKey = characterName;
  return (
    <ScopedChatPanel
      runId={activeRunId}
      scope="character"
      scopeKey={scopeKey}
      title={`Edit character: ${characterName}`}
      renderForm={() => (
        <CharacterForm
          runId={activeRunId}
          scope="character"
          scopeKey={scopeKey}
        />
      )}
      renderInspector={({ messages }) => (
        <CharacterInspector
          runId={activeRunId}
          scope="character"
          scopeKey={scopeKey}
          messages={messages}
        />
      )}
    />
  );
}
