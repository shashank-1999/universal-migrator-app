import type { ColumnMapping, TransformFilter } from "./types";

export type SavedNode = {
  id: string;
  kind: "source" | "transform" | "destination";
  label?: string;
  dbType?: string;
  config?: Record<string, any>;
  mappingPreview?: ColumnMapping[];
  filters?: TransformFilter[];
};

export type SavedEdge = {
  from: string;
  to: string;
};

export type SavedSpec = {
  nodes: SavedNode[];
  edges: SavedEdge[];
};

export type StageSpec = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  source: { dbType?: string; config?: Record<string, any> };
  destination: { dbType?: string; config?: Record<string, any> };
  mapping?: ColumnMapping[];
  filters?: TransformFilter[];
};

function describeNode(node?: SavedNode) {
  if (!node) return "unknown";
  return `${node.label || node.id} (${node.kind})`;
}

export function buildStagesFromSpec(spec: SavedSpec): { stages: StageSpec[]; errors: string[] } {
  const nodes = spec.nodes ?? [];
  const edges = spec.edges ?? [];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const incoming: Record<string, string[]> = {};
  const outgoing: Record<string, string[]> = {};
  edges.forEach((edge) => {
    incoming[edge.to] = incoming[edge.to] || [];
    incoming[edge.to].push(edge.from);
    outgoing[edge.from] = outgoing[edge.from] || [];
    outgoing[edge.from].push(edge.to);
  });

  const errors: string[] = [];

  const visited = new Set<string>();
  const stack = new Set<string>();
  const hasCycle = (id: string): boolean => {
    if (stack.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    stack.add(id);
    for (const nxt of outgoing[id] || []) {
      if (hasCycle(nxt)) return true;
    }
    stack.delete(id);
    return false;
  };
  for (const node of nodes) {
    if (hasCycle(node.id)) {
      errors.push("Graph has a cycle; please break the loop.");
      break;
    }
  }

  const indegree: Record<string, number> = {};
  nodes.forEach((n) => (indegree[n.id] = 0));
  edges.forEach((edge) => {
    indegree[edge.to] = (indegree[edge.to] ?? 0) + 1;
  });
  const queue = nodes.filter((n) => indegree[n.id] === 0).map((n) => n.id);
  const topo: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    topo.push(id);
    for (const nxt of outgoing[id] || []) {
      indegree[nxt] -= 1;
      if (indegree[nxt] === 0) queue.push(nxt);
    }
  }
  const orderIndex = new Map<string, number>();
  topo.forEach((id, idx) => orderIndex.set(id, idx));

  const transformInbound: Record<string, string> = {};
  nodes.filter((n) => n.kind === "transform").forEach((n) => {
    const inbound = (incoming[n.id] || [])
      .map((srcId) => nodeMap.get(srcId))
      .filter(Boolean) as SavedNode[];
    if (inbound.length !== 1) {
      errors.push(`${describeNode(n)}: transform needs exactly one incoming connection.`);
    } else if (!["source", "destination"].includes(inbound[0].kind)) {
      errors.push(`${describeNode(n)}: incoming node must be Source or Destination.`);
    } else {
      transformInbound[n.id] = inbound[0].id;
    }
  });

  nodes.filter((n) => n.kind === "destination").forEach((n) => {
    if ((incoming[n.id] || []).length > 1) {
      errors.push(`${describeNode(n)}: destination has multiple incoming edges.`);
    }
  });

  if (errors.length) {
    return { stages: [], errors };
  }

  const stages: StageSpec[] = [];

  edges
    .filter((edge) => {
      const src = nodeMap.get(edge.from);
      const dst = nodeMap.get(edge.to);
      return src?.kind === "transform" && dst?.kind === "destination";
    })
    .forEach((edge) => {
      const transform = nodeMap.get(edge.from)!;
      const dest = nodeMap.get(edge.to)!;
      const inboundId = transformInbound[transform.id];
      const inboundNode = inboundId ? nodeMap.get(inboundId) : null;
      if (!inboundNode) {
        errors.push(`${describeNode(transform)}: missing inbound connection.`);
        return;
      }
      stages.push({
        id: `stage-${transform.id}-${dest.id}`,
        fromNodeId: inboundNode.id,
        toNodeId: dest.id,
        source: { dbType: inboundNode.dbType, config: inboundNode.config },
        destination: { dbType: dest.dbType, config: dest.config },
        mapping: transform.mappingPreview,
        filters: transform.filters,
      });
    });

  edges
    .filter((edge) => {
      const src = nodeMap.get(edge.from);
      const dst = nodeMap.get(edge.to);
      return dst?.kind === "destination" && src?.kind !== "transform";
    })
    .forEach((edge) => {
      const src = nodeMap.get(edge.from)!;
      const dst = nodeMap.get(edge.to)!;
      stages.push({
        id: `stage-${src.id}-${dst.id}`,
        fromNodeId: src.id,
        toNodeId: dst.id,
        source: { dbType: src.dbType, config: src.config },
        destination: { dbType: dst.dbType, config: dst.config },
      });
    });

  const stageOrderIndex = (stage: StageSpec) =>
    orderIndex.get(stage.fromNodeId) ?? orderIndex.get(stage.toNodeId) ?? 0;
  stages.sort((a, b) => stageOrderIndex(a) - stageOrderIndex(b));

  return { stages, errors };
}
