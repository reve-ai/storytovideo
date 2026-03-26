import type { GraphNode, GraphEdge } from "../stores/pipeline-store";

export const NODE_W = 140;
export const NODE_H = 40;
export const PAD_X = 40;
export const PAD_Y = 60;

const PIPELINE_TYPE_ORDER: GraphNode["type"][] = [
  "story_to_script",
  "analyze_story",
  "artifact",
  "name_run",
  "plan_shots",
  "generate_asset",
  "generate_frame",
  "generate_video",
  "analyze_video",
  "assemble",
];

export const STATUS_COLORS: Record<string, string> = {
  pending: "#6b7280",
  in_progress: "#4f8ff7",
  completed: "#34d399",
  failed: "#f87171",
  cancelled: "#6b7280",
  superseded: "#fb923c",
};

function splitLayerByType(layer: string[], nodesById: Map<string, GraphNode>): string[][] {
  const grouped = new Map<string, string[]>();

  for (const id of layer) {
    const type = nodesById.get(id)?.type ?? "unknown";
    const bucket = grouped.get(type);
    if (bucket) {
      bucket.push(id);
    } else {
      grouped.set(type, [id]);
    }
  }

  const orderedLayers = PIPELINE_TYPE_ORDER
    .map((type) => grouped.get(type))
    .filter((group): group is string[] => Boolean(group));

  const unknownLayers = [...grouped.entries()]
    .filter(([type]) => !PIPELINE_TYPE_ORDER.includes(type as GraphNode["type"]))
    .map(([, group]) => group);

  return [...orderedLayers, ...unknownLayers];
}

/**
 * Topological layering: assigns nodes to layers so that all predecessors
 * of a node appear in earlier layers.
 */
export function computeLayers(
  nodes: GraphNode[],
  edges: GraphEdge[],
): string[][] {
  const assigned = new Set<string>();
  const layers: string[][] = [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  let remaining = nodes.map((n) => n.id);

  while (remaining.length > 0) {
    const layer = remaining.filter((id) => {
      if (assigned.has(id)) return false;
      const preds = edges.filter((e) => e.to === id).map((e) => e.from);
      return preds.every((p) => assigned.has(p) || !remaining.includes(p));
    });
    if (layer.length === 0) {
      // cycle breaker
      layers.push([remaining[0]]);
      assigned.add(remaining[0]);
      remaining = remaining.slice(1);
      continue;
    }
    layers.push(...splitLayerByType(layer, nodesById));
    for (const id of layer) assigned.add(id);
    remaining = remaining.filter((id) => !assigned.has(id));
  }
  return layers;
}

/**
 * Assign (x, y) positions to each node based on its layer.
 */
export function layoutNodes(
  layers: string[][],
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    for (let ni = 0; ni < layer.length; ni++) {
      positions[layer[ni]] = {
        x: PAD_X + ni * (NODE_W + PAD_X),
        y: PAD_Y + li * (NODE_H + PAD_Y),
      };
    }
  }
  return positions;
}

/**
 * Filter out superseded nodes and any edges referencing them.
 */
export function filterSuperseded(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const hidden = new Set(
    nodes.filter((n) => n.status === "superseded").map((n) => n.id),
  );
  return {
    nodes: nodes.filter((n) => !hidden.has(n.id)),
    edges: edges.filter((e) => !hidden.has(e.from) && !hidden.has(e.to)),
  };
}

/**
 * Compute the SVG viewBox dimensions from node positions.
 */
export function computeSvgSize(
  positions: Record<string, { x: number; y: number }>,
): { width: number; height: number } {
  const xs = Object.values(positions).map((p) => p.x);
  const ys = Object.values(positions).map((p) => p.y);
  return {
    width: Math.max(600, (xs.length ? Math.max(...xs) : 0) + NODE_W + PAD_X * 2),
    height: Math.max(400, (ys.length ? Math.max(...ys) : 0) + NODE_H + PAD_Y * 2),
  };
}

