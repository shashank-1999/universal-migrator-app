"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Edge, Node } from "reactflow";

export type NodeKind = "source" | "destination" | "transform";
export type DBType =
  | "csv"
  | "excel"
  | "postgres"
  | "mysql"
  | "mssql"
  | "s3"
  | "gcs"
  | "azureBlob";

export type NodeData = {
  kind: NodeKind;
  label: string;
  dbType?: DBType;
  config: Record<string, any>;
};

export type RunState =
  | "idle"
  | "running"
  | "cancelling"
  | "cancelled"
  | "success"
  | "error";

type WFState = {
  nodes: Node<NodeData>[];
  edges: Edge[];
  selectedId: string | null;
  selectedEdgeId: string | null;
  setNodes: (fn: (prev: Node<NodeData>[]) => Node<NodeData>[]) => void;
  setEdges: (fn: (prev: Edge[]) => Edge[]) => void;
  setSelectedId: (id: string | null) => void;
  setSelectedEdgeId: (id: string | null) => void;
  runStatus: { state: RunState; message?: string };
  setRunStatus: (status: { state: RunState; message?: string }) => void;
  currentRunId: string | null;
  setCurrentRunId: (id: string | null) => void;
  reset: () => void;
};

export const useWorkflowStore = create<WFState>()(
  persist(
    (set, get) => ({
      nodes: [],
      edges: [],
      selectedId: null,
      selectedEdgeId: null,
      runStatus: { state: "idle" },
      currentRunId: null,
      setNodes: (fn) => set({ nodes: fn(get().nodes) }),
      setEdges: (fn) => set({ edges: fn(get().edges) }),
      setSelectedId: (id) => set({ selectedId: id }),
      setSelectedEdgeId: (id) => set({ selectedEdgeId: id }),
      setRunStatus: (status) => set({ runStatus: status }),
      setCurrentRunId: (id) => set({ currentRunId: id }),
      reset: () =>
        set({
          nodes: [],
          edges: [],
          selectedId: null,
          selectedEdgeId: null,
          runStatus: { state: "idle" },
          currentRunId: null,
        }),
    }),
    { name: "um.workflow.v1" } // localStorage key
  )
);
