import { useMemo } from "react";
import { usePipelineStore } from "../stores/pipeline-store";
import { useUIStore } from "../stores/ui-store";
import {
  NODE_W,
  NODE_H,
  STATUS_COLORS,
  computeLayers,
  layoutNodes,
  filterSuperseded,
  computeSvgSize,
} from "../utils/graph-layout";

export default function GraphView() {
  const graph = usePipelineStore((s) => s.graph);
  const hideSuperseded = useUIStore((s) => s.hideSuperseded);
  const setHideSuperseded = useUIStore((s) => s.setHideSuperseded);
  const openDetail = useUIStore((s) => s.openDetail);

  const { nodes, edges, positions, svgW, svgH } = useMemo(() => {
    if (!graph) return { nodes: [], edges: [], positions: {}, svgW: 600, svgH: 400 };

    let n = graph.nodes;
    let e = graph.edges;
    if (hideSuperseded) {
      const filtered = filterSuperseded(n, e);
      n = filtered.nodes;
      e = filtered.edges;
    }

    const layers = computeLayers(n, e);
    const pos = layoutNodes(layers);
    const size = computeSvgSize(pos);
    return { nodes: n, edges: e, positions: pos, svgW: size.width, svgH: size.height };
  }, [graph, hideSuperseded]);

  if (!graph) {
    return <div className="p-4 text-[--muted]">No graph data. Select a run to view the dependency graph.</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[--border] bg-[--surface]">
        <label className="flex items-center gap-1.5 text-sm text-[--muted] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={hideSuperseded}
            onChange={(e) => setHideSuperseded(e.target.checked)}
            className="accent-[--accent]"
          />
          Hide superseded
        </label>
      </div>

      {/* SVG Graph */}
      <div className="flex-1 overflow-auto p-4">
        <svg
          viewBox={`0 0 ${svgW} ${svgH}`}
          style={{ width: svgW, height: svgH }}
          className="block"
        >
          {/* Arrowhead marker */}
          <defs>
            <marker
              id="arrowhead"
              markerWidth={8}
              markerHeight={6}
              refX={8}
              refY={3}
              orient="auto"
            >
              <polygon points="0 0, 8 3, 0 6" fill={STATUS_COLORS.pending} />
            </marker>
          </defs>

          {/* Edges */}
          {edges.map((edge) => {
            const from = positions[edge.from];
            const to = positions[edge.to];
            if (!from || !to) return null;
            const x1 = from.x + NODE_W / 2;
            const y1 = from.y + NODE_H;
            const x2 = to.x + NODE_W / 2;
            const y2 = to.y;
            const cy1 = y1 + (y2 - y1) * 0.4;
            const cy2 = y1 + (y2 - y1) * 0.6;
            return (
              <path
                key={`${edge.from}-${edge.to}`}
                d={`M${x1},${y1} C${x1},${cy1} ${x2},${cy2} ${x2},${y2}`}
                fill="none"
                stroke="var(--border)"
                strokeWidth={1.5}
                markerEnd="url(#arrowhead)"
              />
            );
          })}

          {/* Nodes */}
          {nodes.map((node) => {
            const pos = positions[node.id];
            if (!pos) return null;
            const color = STATUS_COLORS[node.status] || STATUS_COLORS.pending;
            const label = node.type.replace(/_/g, " ").slice(0, 18);
            const vLabel = node.version > 1 ? ` v${node.version}` : "";
            return (
              <g
                key={node.id}
                transform={`translate(${pos.x},${pos.y})`}
                className="cursor-pointer"
                data-opens-detail
                style={{ opacity: node.status === "superseded" ? 0.5 : 1 }}
                onClick={() => openDetail(node.id)}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={4}
                  fill={`${color}22`}
                  stroke={color}
                  strokeWidth={1.5}
                />
                <text
                  x={NODE_W / 2}
                  y={16}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--text)"
                >
                  {label}{vLabel}
                </text>
                <text
                  x={NODE_W / 2}
                  y={30}
                  textAnchor="middle"
                  fontSize={9}
                  fill={STATUS_COLORS.pending}
                >
                  {node.itemKey.slice(0, 22)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

