import { useRunStore } from "../../stores/run-store";
import ScopedChatPanel from "./ScopedChatPanel";
import StoryForm from "./StoryForm";
import StoryInspector from "./StoryInspector";

const STORY_SCOPE_KEY = "main";

export default function StoryChat() {
  const activeRunId = useRunStore((s) => s.activeRunId);
  if (!activeRunId) return null;
  return (
    <ScopedChatPanel
      runId={activeRunId}
      scope="story"
      scopeKey={STORY_SCOPE_KEY}
      title="Edit Story"
      renderForm={() => (
        <StoryForm
          runId={activeRunId}
          scope="story"
          scopeKey={STORY_SCOPE_KEY}
        />
      )}
      renderInspector={({ messages }) => (
        <StoryInspector
          runId={activeRunId}
          scope="story"
          scopeKey={STORY_SCOPE_KEY}
          messages={messages}
        />
      )}
    />
  );
}
