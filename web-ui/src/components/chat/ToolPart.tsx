import { useRunStore } from "../../stores/run-store";
import { mediaUrl } from "../../utils/media-url";

export interface ToolPartLike {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean; reason?: string };
}

export type ApprovalResponseHandler = (id: string, approved: boolean) => void | PromiseLike<void>;

function getToolName(part: ToolPartLike): string {
  if (part.type.startsWith("tool-")) return part.type.slice("tool-".length);
  if (part.type.startsWith("dynamic-tool-")) return part.type.slice("dynamic-tool-".length);
  return part.type;
}

export default function ToolPart({
  part,
  onApprovalResponse,
}: {
  part: ToolPartLike;
  onApprovalResponse?: ApprovalResponseHandler;
}) {
  const name = getToolName(part);
  const state = part.state ?? "input-available";
  const activeRunId = useRunStore((s) => s.activeRunId);

  const renderInline: React.ReactNode = (() => {
    if (state === "output-available") {
      const out = part.output as Record<string, unknown> | undefined;
      if (out && typeof out === "object" && typeof out.path === "string") {
        const path = out.path as string;
        if (activeRunId) {
          const url = mediaUrl(activeRunId, path);
          if (name === "previewFrame") {
            return (
              <img
                src={url}
                alt="Frame preview"
                style={{ maxWidth: "100%", borderRadius: 6, marginTop: 4 }}
              />
            );
          }
          if (name === "previewVideo") {
            return (
              <video controls style={{ maxWidth: "100%", borderRadius: 6, marginTop: 4 }}>
                <source src={url} />
              </video>
            );
          }
        }
      }
    }
    return null;
  })();

  return (
    <div className="chat-tool-part">
      <div className="chat-tool-head">
        <span className="chat-tool-name">{name}</span>
        <span className={`chat-tool-state state-${state}`}>{state}</span>
      </div>
      {part.input != null && (
        <details className="chat-tool-detail">
          <summary>Input</summary>
          <pre>{JSON.stringify(part.input, null, 2)}</pre>
        </details>
      )}
      {state === "output-available" && part.output != null && (
        <details className="chat-tool-detail">
          <summary>Output</summary>
          <pre>{JSON.stringify(part.output, null, 2)}</pre>
        </details>
      )}
      {state === "output-error" && part.errorText && (
        <pre className="chat-tool-error">{part.errorText}</pre>
      )}
      {state === "approval-requested" && part.approval?.id && (
        <div className="chat-tool-approval">
          <div className="chat-tool-approval-msg">
            The agent wants to run <strong>{name}</strong>. Approve?
          </div>
          <div className="chat-tool-approval-actions">
            <button
              type="button"
              className="primary"
              onClick={() => onApprovalResponse?.(part.approval!.id, true)}
              disabled={!onApprovalResponse}
            >
              Approve
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => onApprovalResponse?.(part.approval!.id, false)}
              disabled={!onApprovalResponse}
            >
              Deny
            </button>
          </div>
        </div>
      )}
      {state === "approval-responded" && part.approval && (
        <div className="chat-tool-approval-result">
          {part.approval.approved ? "Approved" : "Denied"}
          {part.approval.reason ? ` — ${part.approval.reason}` : ""}
        </div>
      )}
      {state === "output-denied" && (
        <div className="chat-tool-approval-result">Denied</div>
      )}
      {renderInline}
    </div>
  );
}
