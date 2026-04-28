import type { ReactNode } from "react";

export interface ContextInspectorSection {
  id: string;
  title: string;
  defaultOpen?: boolean;
  render: () => ReactNode;
}

interface Props {
  sections: ContextInspectorSection[];
}

export default function ContextInspector({ sections }: Props) {
  return (
    <div className="context-inspector">
      {sections.map((s) => (
        <details
          key={s.id}
          className="context-inspector-section"
          open={s.defaultOpen ?? false}
        >
          <summary>{s.title}</summary>
          {s.render()}
        </details>
      ))}
    </div>
  );
}
