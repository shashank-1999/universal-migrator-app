"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Edge, Node } from "reactflow";

export type NodeKind = "source" | "destination";
export type DBType =
  | "csv" | "excel"
  | "postgres" | "mysql" | "mssql" | "oracle"
  | "s3" | "gcs" | "azureBlob";

export type NodeData = {
  kind: NodeKind;
  label: string;
  dbType?: DBType;
  config: Record<string, any>;
};

type WFState = {
  nodes: Node<NodeData>[];
  edges: Edge[];
  selectedId: string | null;
  setNodes: (fn: (prev: Node<NodeData>[]) => Node<NodeData>[]) => void;
  setEdges: (fn: (prev: Edge[]) => Edge[]) => void;
  setSelectedId: (id: string | null) => void;
  reset: () => void;
};

export const useWorkflowStore = create<WFState>()(
  persist(
    (set, get) => ({
      nodes: [],
      edges: [],
      selectedId: null,
      setNodes: (fn) => set({ nodes: fn(get().nodes) }),
      setEdges: (fn) => set({ edges: fn(get().edges) }),
      setSelectedId: (id) => set({ selectedId: id }),
      reset: () => set({ nodes: [], edges: [], selectedId: null }),
    }),
    { name: "um.workflow.v1" } // localStorage key
  )
);
