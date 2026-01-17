"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  ReactFlowProvider,
  Controls,
  Background,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  Handle,
  Position,
  Connection,
  Edge,
  Node,
  BaseEdge,
  EdgeProps,
  getBezierPath,
} from "reactflow";
import "reactflow/dist/style.css";

import { useWorkflowStore, type NodeData, type RunState, type DBType } from "@/lib/workflowStore";
import type { CastType, ColumnMapping, ComparisonOperator, TransformFilter } from "@/lib/types";

/* ───────────────────────────── Types / DB options ────────────────────────── */

type NodeKind = "source" | "destination" | "transform";

type RunStatus = RunState;

type StageSpec = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  source: { dbType?: DBType; config?: Record<string, any> };
  destination: { dbType?: DBType; config?: Record<string, any> };
  mapping?: ColumnMapping[];
  filters?: TransformFilter[];
  script?: { language: string; code: string; timeoutMs?: number };
};

const CAST_OPTIONS: { value: CastType; label: string }[] = [
  { value: "STRING", label: "String" },
  { value: "NUMBER", label: "Number" },
  { value: "BOOLEAN", label: "Boolean" },
  { value: "DATE", label: "Date/Time" },
];

const CONDITION_OPERATORS: { value: ComparisonOperator; label: string; needsValue: boolean }[] = [
  { value: "equals", label: "Equals", needsValue: true },
  { value: "notEquals", label: "Not equals", needsValue: true },
  { value: "contains", label: "Contains", needsValue: true },
  { value: "startsWith", label: "Starts with", needsValue: true },
  { value: "endsWith", label: "Ends with", needsValue: true },
  { value: "greaterThan", label: "Greater than", needsValue: true },
  { value: "lessThan", label: "Less than", needsValue: true },
  { value: "isEmpty", label: "Is empty", needsValue: false },
  { value: "isNotEmpty", label: "Is not empty", needsValue: false },
];

const FILTER_OPERATORS = CONDITION_OPERATORS;

const operatorNeedsValue = (op: ComparisonOperator) =>
  CONDITION_OPERATORS.find((item) => item.value === op)?.needsValue ?? false;

const randomId = () => Math.random().toString(36).slice(2, 9);

const RUN_STATUS_VISUALS: Record<
  Exclude<RunStatus, "idle">,
  { bg: string; color: string; dot: string; fallback: string }
> = {
  running: {
    bg: "#fff7ed",
    color: "#9a3412",
    dot: "#ea580c",
    fallback: "Workflow is running...",
  },
  cancelling: {
    bg: "#fef2f2",
    color: "#b45309",
    dot: "#f97316",
    fallback: "Requesting stop...",
  },
  cancelled: {
    bg: "#f1f5f9",
    color: "#0f172a",
    dot: "#475569",
    fallback: "Workflow run cancelled",
  },
  success: {
    bg: "#ecfccb",
    color: "#166534",
    dot: "#15803d",
    fallback: "Workflow run completed",
  },
  error: {
    bg: "#fee2e2",
    color: "#b91c1c",
    dot: "#dc2626",
    fallback: "Workflow run failed",
  },
};

const DB_OPTIONS: Record<
  DBType,
  { label: string; fields: { key: string; label: string; type?: string; placeholder?: string; options?: { value: string | number; label: string }[]; defaultValue?: string | number }[] }
> = {
  csv: {
    label: "CSV",
    fields: [{ key: "path", label: "Path", placeholder: "./data/input.csv" }],
  },
  excel: {
    label: "Excel",
    fields: [
      { key: "path", label: "Path", placeholder: "./data/input.xlsx" },
      { key: "sheet", label: "Sheet", placeholder: "Sheet1" },
    ],
  },
  json: {
    label: "JSON file",
    fields: [{ key: "path", label: "Path", placeholder: "./data/input.json" }],
  },
  parquet: {
    label: "Parquet file",
    fields: [{ key: "path", label: "Path", placeholder: "./data/input.parquet" }],
  },
  postgres: {
    label: "PostgreSQL",
    fields: [
      { key: "host", label: "Host", placeholder: "localhost" },
      { key: "port", label: "Port", placeholder: "5432" },
      { key: "user", label: "User" },
      { key: "password", label: "Password", type: "password" },
      { key: "database", label: "Database" },
      { key: "schema", label: "Schema", placeholder: "public" },
      { key: "table", label: "Table", placeholder: "people" },
      { key: "batchSize", label: "Batch size (optional)", placeholder: "50000" },
      { key: "writerPoolSize", label: "Writer pool size (optional)", placeholder: "8" },
    ],
  },
  oracle: {
    label: "Oracle",
    fields: [
      { key: "host", label: "Host", placeholder: "localhost" },
      { key: "port", label: "Port", placeholder: "1521" },
      { key: "service", label: "Service Name", placeholder: "XEPDB1" },
      { key: "user", label: "User" },
      { key: "password", label: "Password", type: "password" },
      { key: "schema", label: "Schema (optional)" },
      { key: "table", label: "Table", placeholder: "SCHEMA.TABLE or TABLE" },
    ],
  },

  mysql: {
    label: "MySQL",
    fields: [
      { key: "host", label: "Host", placeholder: "localhost" },
      { key: "port", label: "Port", placeholder: "3306" },
      { key: "user", label: "User" },
      { key: "password", label: "Password", type: "password" },
      { key: "database", label: "Database" },
      { key: "table", label: "Table", placeholder: "my_table" },
    ],
  },
  mssql: {
    label: "SQL Server",
    fields: [
      { key: "host", label: "Host", placeholder: "localhost" },
      { key: "port", label: "Port", placeholder: "1433" },
      { key: "user", label: "User" },
      { key: "password", label: "Password", type: "password" },
      { key: "database", label: "Database" },
      { key: "schema", label: "Schema", placeholder: "dbo" },
      { key: "table", label: "Table", placeholder: "MyTable" },
    ],
  },
  s3: {
    label: "Amazon S3 (CSV object)",
    fields: [
      { key: "region", label: "Region", placeholder: "us-east-1" },
      { key: "bucket", label: "Bucket" },
      { key: "key", label: "Key (object path)" },
      { key: "accessKeyId", label: "Access Key Id" },
      { key: "secretAccessKey", label: "Secret Access Key", type: "password" },
      {
        key: "format",
        label: "Format",
        type: "select",
        options: [
          { value: "csv", label: "CSV" },
          { value: "parquet", label: "Parquet" },
        ],
        defaultValue: "",
      },
    ],
  },
  minio: {
    label: "MinIO",
    fields: [
      { key: "endpoint", label: "Endpoint", placeholder: "http://localhost:9000" },
      { key: "region", label: "Region", placeholder: "us-east-1" },
      { key: "bucket", label: "Bucket" },
      { key: "key", label: "Key (object path)" },
      { key: "accessKeyId", label: "Access Key Id" },
      { key: "secretAccessKey", label: "Secret Access Key", type: "password" },
      {
        key: "format",
        label: "Format",
        type: "select",
        options: [
          { value: "csv", label: "CSV" },
          { value: "parquet", label: "Parquet" },
        ],
        defaultValue: "",
      },
    ],
  },
  gcs: {
    label: "Google Cloud Storage (CSV object)",
    fields: [
      { key: "projectId", label: "Project Id" },
      { key: "bucket", label: "Bucket" },
      { key: "key", label: "Key (object path)" },
      { key: "keyFilename", label: "Service Account JSON path (optional)" },
      {
        key: "format",
        label: "Format",
        type: "select",
        options: [
          { value: "csv", label: "CSV" },
          { value: "parquet", label: "Parquet" },
        ],
        defaultValue: "",
      },
    ],
  },
  azureBlob: {
    label: "Azure Blob Storage (CSV object)",
    fields: [
      { key: "connectionString", label: "Connection String (optional)" },
      { key: "accountName", label: "Account Name" },
      { key: "accountKey", label: "Account Key", type: "password" },
      { key: "container", label: "Container" },
      { key: "blob", label: "Blob path (object path)" },
      {
        key: "format",
        label: "Format",
        type: "select",
        options: [
          { value: "csv", label: "CSV" },
          { value: "parquet", label: "Parquet" },
        ],
        defaultValue: "",
      },
    ],
  },
};

const defaultConfigFor = (dbType?: DBType): Record<string, any> =>
  !dbType
    ? {}
    : Object.fromEntries(
        DB_OPTIONS[dbType].fields.map((f) => [
          f.key,
          f.defaultValue !== undefined ? f.defaultValue : "",
        ])
      );

const STORAGE_FLOW_TYPES: DBType[] = ["s3", "minio", "gcs", "azureBlob"];

const CHUNK_UPLOAD_SIZE = 10 * 1024 * 1024;

const generateUploadId = () => globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10);

type ChunkProgress = { chunkIndex: number; totalChunks: number };

async function uploadFileInChunks(
  file: File,
  onProgress?: (progress: ChunkProgress) => void
): Promise<{ path: string; name: string }> {
  const chunkSize = CHUNK_UPLOAD_SIZE;
  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
  const uploadId = generateUploadId();
  let finalPath = "";
  let finalName = file.name;

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const chunk = file.slice(start, end);
    const fd = new FormData();
    fd.append("chunk", chunk);
    fd.append("fileId", uploadId);
    fd.append("chunkIndex", String(chunkIndex));
    fd.append("totalChunks", String(totalChunks));
    fd.append("fileName", file.name);

    const res = await fetch("/api/upload/chunk", { method: "POST", body: fd });
    const json = await res.json();
    if (!res.ok || !json?.ok) {
      throw new Error(json?.message || "Chunk upload failed");
    }

    onProgress?.({ chunkIndex, totalChunks });
    if (json.path) finalPath = json.path;
    if (json.name) finalName = json.name;
  }

  if (!finalPath) {
    throw new Error("Upload did not return a file path");
  }

  return { path: finalPath, name: finalName };
}

const ensureDestinationFormat = (
  destType: DBType,
  destConfig: Record<string, any>,
  sourceConfig?: Record<string, any>
) => {
  if (!STORAGE_FLOW_TYPES.includes(destType)) return destConfig;
  if (!sourceConfig) return destConfig;
  const normalized = { ...destConfig };
  if (!normalized.format && sourceConfig.format) {
    normalized.format = sourceConfig.format;
  }
  return normalized;
};

/* ───────────────────────────── Small UI bits ─────────────────────────────── */

function CardShell({
  title,
  subtitle,
  badge,
  children,
}: {
  title: string;
  subtitle?: string;
  badge?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      style={{
        width: 280,
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        background: "#fff",
        boxShadow: "0 1px 3px rgba(0,0,0,.06)",
      }}
    >
      <div
        style={{
          padding: 12,
          borderBottom: "1px solid #eee",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {badge && (
          <span
            style={{
              padding: "2px 6px",
              fontSize: 12,
              borderRadius: 999,
              background: badge === "SOURCE" ? "#059669" : "#4f46e5",
              color: "#fff",
            }}
          >
            {badge}
          </span>
        )}
        <span style={{ fontWeight: 600 }}>{title}</span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#6b7280" }}>
          {subtitle}
        </span>
      </div>
      <div style={{ padding: 12, fontSize: 12 }}>{children}</div>
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 40,
        padding: 16,
      }}
    >
      <div
        style={{
          width: "min(960px, 100%)",
          maxHeight: "90vh",
          background: "#fff",
          borderRadius: 12,
          border: "1px solid #e2e8f0",
          boxShadow: "0 20px 40px rgba(0,0,0,0.12)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            padding: "14px 16px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderBottom: "1px solid #e2e8f0",
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>
          <button
            onClick={onClose}
            style={{
              marginLeft: "auto",
              border: "1px solid #e2e8f0",
              background: "#fff",
              borderRadius: 8,
              padding: "6px 10px",
            }}
          >
            Close
          </button>
        </div>
        <div style={{ padding: 16, overflowY: "auto", flex: 1 }}>{children}</div>
      </div>
    </div>
  );
}

const SourceNode = ({ data }: { data: NodeData }) => (
  <div>
    <CardShell
      badge="SOURCE"
      title={data.label || "Source"}
      subtitle={data.dbType ? DB_OPTIONS[data.dbType].label : "Unconfigured"}
    >
      <div style={{ color: "#475569" }}>
        {data.dbType ? (
          <>
            <div style={{ marginBottom: 4 }}>{data.dbType}</div>
            {Object.entries(data.config || {})
              .filter(([k]) => ["path", "host", "database", "table", "bucket", "key"].includes(k))
              .slice(0, 2)
              .map(([k, v]) => (
                <div
                  key={k}
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <span style={{ color: "#94a3b8", marginRight: 6 }}>{k}:</span>
                  {String(v)}
                </div>
              ))}
          </>
        ) : (
          <div style={{ color: "#9ca3af" }}>Select a DB on the right ?</div>
        )}
      </div>
    </CardShell>

    <Handle
      type="source"
      position={Position.Right}
      style={{
        width: 14,
        height: 14,
        right: -7,
        background: "#059669",
        border: "2px solid white",
        boxShadow: "0 0 0 2px rgba(5,150,105,0.35)",
        cursor: "crosshair",
      }}
    />
  </div>
);

const DestinationNode = ({ data }: { data: NodeData }) => (
  <div>
    <CardShell
      badge="DESTINATION"
      title={data.label || "Destination"}
      subtitle={data.dbType ? DB_OPTIONS[data.dbType].label : "Unconfigured"}
    >
      <div style={{ color: "#475569" }}>
        {data.dbType ? (
          <>
            <div style={{ marginBottom: 4 }}>{data.dbType}</div>
            {Object.entries(data.config || {})
              .filter(([k]) => ["path", "host", "database", "table", "bucket", "key"].includes(k))
              .slice(0, 2)
              .map(([k, v]) => (
                <div
                  key={k}
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <span style={{ color: "#94a3b8", marginRight: 6 }}>{k}:</span>
                  {String(v)}
                </div>
              ))}
          </>
        ) : (
          <div style={{ color: "#9ca3af" }}>Pick destination DB on the right ?</div>
        )}

        {/* Elapsed time above counts */}
        {(data as any).elapsedText && (
          <div style={{ marginTop: 8, fontWeight: 600, color: "#475569" }}>
            {(data as any).elapsedText}
          </div>
        )}

        {data.progressText && (
          <div style={{ marginTop: 6, fontWeight: 700, color: "#0f172a" }}>{data.progressText}</div>
        )}
      </div>
    </CardShell>

    <Handle
      type="target"
      position={Position.Left}
      style={{
        width: 14,
        height: 14,
        left: -7,
        background: "#4f46e5",
        border: "2px solid white",
        boxShadow: "0 0 0 2px rgba(79,70,229,0.35)",
        cursor: "crosshair",
      }}
    />
    <Handle
      type="source"
      position={Position.Right}
      style={{
        width: 14,
        height: 14,
        right: -7,
        background: "#4f46e5",
        border: "2px solid white",
        boxShadow: "0 0 0 2px rgba(79,70,229,0.35)",
        cursor: "crosshair",
      }}
    />
  </div>
);

const TransformNode = ({ data }: { data: NodeData }) => {
  const preview = data.mappingPreview ?? [];
  const subtitle = preview.length ? `${preview.length} mapped` : "Load preview";
  return (
    <div>
      <CardShell badge="TRANSFORM" title={data.label || "Transform"} subtitle={subtitle}>
        {preview.length ? (
          <div style={{ display: "grid", gap: 4, fontSize: 12 }}>
            {preview.slice(0, 3).map((row, idx) => (
              <div key={`${row.from}-${idx}`} style={{ display: "flex", gap: 6 }}>
                <span style={{ flex: 1, color: "#0369a1" }}>{row.from}</span>
                <span style={{ color: "#94a3b8" }}>{"->"}</span>
                <span style={{ flex: 1, color: "#7c3aed" }}>{row.to || "(not set)"}</span>
              </div>
            ))}
            {preview.length > 3 && <div style={{ color: "#94a3b8" }}>+{preview.length - 3} more</div>}
          </div>
        ) : (
          <div style={{ color: "#9ca3af" }}>Load mapping preview in the inspector.</div>
        )}
      </CardShell>
      <Handle
        type="target"
        position={Position.Left}
        style={{
          width: 14,
          height: 14,
          left: -7,
          background: "#0ea5e9",
          border: "2px solid white",
          boxShadow: "0 0 0 2px rgba(14,165,233,0.35)",
          cursor: "crosshair",
        }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{
          width: 14,
          height: 14,
          right: -7,
          background: "#a855f7",
          border: "2px solid white",
          boxShadow: "0 0 0 2px rgba(168,85,247,0.35)",
          cursor: "crosshair",
        }}
      />
    </div>
  );
};

const nodeTypes = { SourceNode, DestinationNode, TransformNode } as const;

type FlowParticle =
  | { label: string; color: string; duration: number; icon?: never }
  | { icon: "stack"; color: string; duration: number; label?: never };

type TransformModal = "mapping" | "cast" | "condition" | "concat" | "split" | "filters" | "script" | null;
const FLOW_PARTICLES: FlowParticle[] = [
  { label: "TX", color: "#0ea5e9", duration: 2.6 },
  { label: "NM", color: "#f97316", duration: 3.1 },
  { icon: "stack", color: "#1e40af", duration: 3.6 },
  { label: "DT", color: "#10b981", duration: 4.1 },
];

const FlowEdge = ({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  style = {},
  markerEnd,
  data,
}: EdgeProps) => {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const showFlow = Boolean(data?.animate);
  const stroke = (style as React.CSSProperties)?.stroke || "#4f46e5";

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke,
          strokeWidth: 2.5,
          opacity: 0.95,
        }}
      />
      {showFlow &&
        FLOW_PARTICLES.map((particle, idx) => {
          const motionProps = {
            dur: `${particle.duration + idx * 0.25}s`,
            repeatCount: "indefinite" as const,
            path: edgePath,
            begin: `${idx * 0.35}s`,
          };

          return (
            <g key={`${id}-particle-${idx}`} style={{ pointerEvents: "none" }}>
              {particle.icon === "stack" ? (
                <>
                  <g transform="scale(0.85)">
                    <rect
                      x={-6}
                      y={-5}
                      width={12}
                      height={10}
                      rx={2}
                      fill="#fff"
                      stroke={particle.color}
                      strokeWidth={1.5}
                    />
                    <rect x={-4.5} y={-2.5} width={9} height={2} fill={particle.color} rx={1} />
                    <rect x={-4.5} y={0.5} width={9} height={2} fill={particle.color} rx={1} opacity={0.85} />
                    <rect x={-4.5} y={-5.5} width={9} height={2} fill={particle.color} rx={1} opacity={0.65} />
                  </g>
                  <animateMotion {...motionProps} />
                </>
              ) : (
                <>
                  <circle r={8} fill={particle.color} opacity={0.95} />
                  <text
                    fill="#fff"
                    fontSize={6}
                    fontWeight={600}
                    textAnchor="middle"
                    dominantBaseline="middle"
                  >
                    {particle.label}
                  </text>
                  <animateMotion {...motionProps} />
                </>
              )}
            </g>
          );
        })}
    </>
  );
};

const edgeTypes = { flowEdge: FlowEdge } as const;

/* ───────────────────────────── Inspector (upload only on Source CSV/Excel) ───────────────────────── */

function Inspector({
  selected,
  setNodes,
}: {
  selected: Node<NodeData> | null;
  setNodes: (fn: (prev: Node<NodeData>[]) => Node<NodeData>[]) => void;
}) {
  const node = selected;
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [probeMsg, setProbeMsg] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [transformSectionIndex, setTransformSectionIndex] = useState({
    cast: 0,
    condition: 0,
    concat: 0,
    split: 0,
  });
  const [openModal, setOpenModal] = useState<TransformModal>(null);
  const allNodes = useWorkflowStore((s) => s.nodes);
  const allEdges = useWorkflowStore((s) => s.edges);
  const closeModal = useCallback(() => setOpenModal(null), []);
  const probeKeyRef = useRef<string | null>(null);

  const updateNode = useCallback(
    (patch: Partial<NodeData>) => {
      if (!node?.id) return;
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== node.id) return n;
          const configPatch = patch.config;
          return {
            ...n,
            data: {
              ...n.data,
              ...patch,
              config: configPatch ? { ...(n.data.config ?? {}), ...configPatch } : n.data.config,
            },
          };
        })
      );
    },
    [node?.id, setNodes]
  );

  useEffect(() => {
    if (!node || node.data.kind !== "transform") {
      setTransformSectionIndex({ cast: 0, condition: 0, concat: 0, split: 0 });
      setOpenModal(null);
      return;
    }
    const count = node.data.mappingPreview?.length ?? 0;
    if (!count) {
      setTransformSectionIndex({ cast: 0, condition: 0, concat: 0, split: 0 });
      setOpenModal(null);
      return;
    }
    const clamp = (val: number) => Math.min(Math.max(val, 0), Math.max(count - 1, 0));
    setTransformSectionIndex((prev) => ({
      cast: clamp(prev.cast),
      condition: clamp(prev.condition),
      concat: clamp(prev.concat),
      split: clamp(prev.split),
    }));
  }, [node]);

  useEffect(() => {
    if (!node || node.data.kind !== "source") return;
    const storageTypes = ["s3", "minio", "gcs", "azureBlob"];
    const type = node.data.dbType;
    if (!type || !storageTypes.includes(type)) return;
    const cfg = node.data.config || {};
    const bucket = cfg.bucket || cfg.container;
    const key = cfg.key || cfg.blob;
    if (!bucket || !key) return;
    const probeKey = `${type}|${bucket}|${key}`;
    if (probeKeyRef.current === probeKey) return;
    probeKeyRef.current = probeKey;

    setProbeMsg("Detecting object format…");
    const controller = new AbortController();
    const payload = { type, config: cfg };
    fetch("/api/storage/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(json?.message || "Probe failed");
        }
        if (json.format && json.format !== cfg.format) {
          updateNode({ config: { ...cfg, format: json.format } });
        }
        setProbeMsg(`Detected format: ${json.format || cfg.format || "csv"}`);
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        console.warn("Auto-detect failed", err);
        setProbeMsg(`Probe failed: ${err?.message || "unknown"}`);
      })
      .finally(() => {
        setTimeout(() => setProbeMsg(null), 3000);
      });

    return () => controller.abort();
  }, [node, updateNode]);

  if (!node)
    return (
      <div style={{ padding: 12, fontSize: 14, color: "#6b7280" }}>
        Select a node to edit its configuration.
      </div>
    );

  const d = node.data;
  const fields = d.dbType
    ? DB_OPTIONS[d.dbType].fields.filter((f) => !(d.kind === "source" && f.key === "format"))
    : [];

  if (d.kind === "transform") {
    const incoming = allEdges.find((e) => e.target === node.id);
    const outgoing = allEdges.find((e) => e.source === node.id);
    const connectedSource = incoming ? allNodes.find((n) => n.id === incoming.source) ?? null : null;
    const connectedDestination = outgoing ? allNodes.find((n) => n.id === outgoing.target) ?? null : null;
    const mappingRows = d.mappingPreview ?? [];
    const filters = d.filters ?? [];
    const destOptions = d.availableDestinationColumns ?? [];
    const sourceColumnOptions =
      d.sourceColumns && d.sourceColumns.length > 0 ? d.sourceColumns : mappingRows.map((row) => row.from);
    const mappingOptions = mappingRows.map((row, idx) => ({
      idx,
      label: row.to ? `${row.from} -> ${row.to}` : row.from,
    }));
    const castRow = mappingRows[transformSectionIndex.cast] ?? null;
    const conditionRow = mappingRows[transformSectionIndex.condition] ?? null;
    const concatRow = mappingRows[transformSectionIndex.concat] ?? null;
    const splitRow = mappingRows[transformSectionIndex.split] ?? null;
    const hasMapping = mappingRows.length > 0;

    const setMappingRows = (rows: ColumnMapping[]) => {
      updateNode({ mappingPreview: rows });
    };

    const updateMappingRow = (index: number, updater: (row: ColumnMapping) => ColumnMapping) => {
      setMappingRows(mappingRows.map((row, idx) => (idx === index ? updater({ ...row }) : row)));
    };

    const handleDestinationChange = (index: number, value: string) => {
      updateMappingRow(index, (row) => ({ ...row, to: value }));
    };

    const handleTrimToggle = (index: number, checked: boolean) => {
      updateMappingRow(index, (row) => ({ ...row, trim: checked }));
    };

    const handleRemoveMappingRow = (index: number) => {
      setMappingRows(mappingRows.filter((_, idx) => idx !== index));
    };

    const handleCastChange = (index: number, value: CastType | "") => {
      updateMappingRow(index, (row) => ({ ...row, cast: value || undefined }));
    };

    const handleConditionToggle = (index: number, enabled: boolean) => {
      updateMappingRow(index, (row) => ({
        ...row,
        condition: enabled
          ? row.condition ?? {
              field: row.from,
              operator: "equals",
              value: "",
              thenValue: "",
              elseValue: "",
            }
          : undefined,
      }));
    };

    const handleConditionField = (index: number, value: string) => {
      updateMappingRow(index, (row) =>
        row.condition ? { ...row, condition: { ...row.condition, field: value } } : row
      );
    };

    const handleConditionOperator = (index: number, operator: ComparisonOperator) => {
      updateMappingRow(index, (row) =>
        row.condition ? { ...row, condition: { ...row.condition, operator } } : row
      );
    };

    const handleConditionValue = (index: number, value: string) => {
      updateMappingRow(index, (row) =>
        row.condition ? { ...row, condition: { ...row.condition, value } } : row
      );
    };

    const handleConditionThen = (index: number, value: string) => {
      updateMappingRow(index, (row) =>
        row.condition ? { ...row, condition: { ...row.condition, thenValue: value } } : row
      );
    };

    const handleConditionElse = (index: number, value: string) => {
      updateMappingRow(index, (row) =>
        row.condition ? { ...row, condition: { ...row.condition, elseValue: value } } : row
      );
    };

    const handleConcatToggle = (index: number, enabled: boolean) => {
      updateMappingRow(index, (row) => ({
        ...row,
        concat: enabled
          ? row.concat ?? {
              sources: [row.from],
              separator: " ",
            }
          : undefined,
      }));
    };

    const handleConcatSources = (index: number, sources: string[]) => {
      updateMappingRow(index, (row) => ({
        ...row,
        concat: sources.length ? { sources, separator: row.concat?.separator ?? " " } : undefined,
      }));
    };

    const handleConcatSeparator = (index: number, separator: string) => {
      updateMappingRow(index, (row) => (row.concat ? { ...row, concat: { ...row.concat, separator } } : row));
    };

    const handleSplitToggle = (index: number, enabled: boolean) => {
      updateMappingRow(index, (row) => ({
        ...row,
        split: enabled ? row.split ?? { delimiter: ",", partIndex: 0 } : undefined,
      }));
    };

    const handleSplitDelimiter = (index: number, delimiter: string) => {
      updateMappingRow(index, (row) => (row.split ? { ...row, split: { ...row.split, delimiter } } : row));
    };

    const handleSplitIndex = (index: number, partIndex: number) => {
      updateMappingRow(index, (row) => (row.split ? { ...row, split: { ...row.split, partIndex } } : row));
    };

    const updateFilters = (next: TransformFilter[]) => updateNode({ filters: next });

    const handleLoadPreview = async () => {
      if (!connectedSource || !connectedDestination) {
        alert("Connect this transform between a Source and a Destination first.");
        return;
      }
      if (!connectedSource.data.dbType || !connectedDestination.data.dbType) {
        alert("Configure both the source and destination connections first.");
        return;
      }
      setPreviewLoading(true);
      try {
        const [srcRes, dstRes] = await Promise.all([
          fetch("/api/schema", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: connectedSource.data.dbType, config: connectedSource.data.config }),
          }),
          fetch("/api/schema", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: connectedDestination.data.dbType,
              config: connectedDestination.data.config,
            }),
          }),
        ]);
        const srcPayload = await srcRes.json();
        const dstPayload = await dstRes.json();
        if (!srcRes.ok) throw new Error(srcPayload?.error || "Source schema error");
        if (!dstRes.ok) throw new Error(dstPayload?.error || "Destination schema error");
        const srcCols = (srcPayload.columns || []) as { name: string; type?: string }[];
        const dstCols = (dstPayload.columns || []) as { name: string; type?: string }[];
        if (!srcCols.length || !dstCols.length) {
          alert("Unable to infer columns from source/destination.");
          return;
        }
        const dstNames = dstCols.map((col) => col.name);
        const mapping = srcCols.map((col) => {
          const match = dstCols.find((dest) => dest.name?.toLowerCase() === col.name?.toLowerCase());
          return {
            from: col.name,
            to: match ? match.name : "",
            trim: false,
            sourceType: col.type,
            destType: match?.type,
          };
        });
        updateNode({
          mappingPreview: mapping,
          availableDestinationColumns: dstNames,
          sourceColumns: srcCols.map((col) => col.name),
        });
      } catch (err) {
        console.error(err);
        alert(err instanceof Error ? err.message : "Failed to load mapping preview");
      } finally {
        setPreviewLoading(false);
      }
    };

    const handleAddFilter = () => {
      const defaultField = sourceColumnOptions[0] || "";
      const newFilter: TransformFilter = {
        id: randomId(),
        field: defaultField,
        operator: "equals",
        value: "",
        action: "keep",
      };
      updateFilters([...filters, newFilter]);
    };

    const handleFilterField = (id: string, value: string) => {
      updateFilters(filters.map((f) => (f.id === id ? { ...f, field: value } : f)));
    };

    const handleFilterOperator = (id: string, operator: ComparisonOperator) => {
      updateFilters(
        filters.map((f) =>
          f.id === id
            ? {
                ...f,
                operator,
                value: operatorNeedsValue(operator) ? f.value : "",
              }
            : f
        )
      );
    };

    const handleFilterValue = (id: string, value: string) => {
      updateFilters(filters.map((f) => (f.id === id ? { ...f, value } : f)));
    };

    const handleFilterAction = (id: string, action: "keep" | "discard") => {
      updateFilters(filters.map((f) => (f.id === id ? { ...f, action } : f)));
    };

    const handleFilterRemove = (id: string) => {
      updateFilters(filters.filter((f) => f.id !== id));
    };

    return (
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 13, color: "#475569" }}>
          Connect this transform between a configured source and destination to reuse their settings and preview how
          columns line up.
        </div>

        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 10,
            padding: 12,
            display: "grid",
            gap: 10,
            fontSize: 13,
          }}
        >
          <div>
            <div style={{ fontWeight: 600 }}>Source</div>
            <div>
              {connectedSource
                ? connectedSource.data.label || connectedSource.data.dbType || connectedSource.id
                : "Not connected"}
            </div>
            <div style={{ color: connectedSource?.data.dbType ? "#059669" : "#dc2626" }}>
              {connectedSource?.data.dbType ? "Connection configured" : "Configure source first"}
            </div>
          </div>
          <div>
            <div style={{ fontWeight: 600 }}>Destination</div>
            <div>
              {connectedDestination
                ? connectedDestination.data.label || connectedDestination.data.dbType || connectedDestination.id
                : "Not connected"}
            </div>
            <div style={{ color: connectedDestination?.data.dbType ? "#059669" : "#dc2626" }}>
              {connectedDestination?.data.dbType ? "Connection configured" : "Configure destination first"}
            </div>
          </div>
        </div>

        <button
          onClick={handleLoadPreview}
          disabled={previewLoading}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #e5e7eb",
            background: previewLoading ? "#f8fafc" : "#eef2ff",
            color: previewLoading ? "#94a3b8" : "#4338ca",
            fontWeight: 600,
            cursor: previewLoading ? "not-allowed" : "pointer",
          }}
        >
          {previewLoading ? "Loading preview..." : hasMapping ? "Refresh mapping" : "Load mapping preview"}
        </button>

        {hasMapping && (
          <>
            <div
              style={{
                border: "1px dashed #dbeafe",
                borderRadius: 10,
                padding: 12,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                background: "#f8fafc",
              }}
            >
              <div style={{ fontWeight: 600 }}>Preview ({mappingRows.length} columns)</div>
              {mappingRows.slice(0, 4).map((row, idx) => (
                <div key={`${row.from}-${idx}`} style={{ display: "flex", gap: 6, fontSize: 12 }}>
                  <span style={{ flex: 1, color: "#0369a1" }}>{row.from}</span>
                  <span style={{ color: "#94a3b8" }}>{"->"}</span>
                  <span style={{ flex: 1, color: "#7c3aed" }}>{row.to || "(not mapped)"}</span>
                </div>
              ))}
              {mappingRows.length > 4 && (
                <div style={{ fontSize: 12, color: "#94a3b8" }}>+{mappingRows.length - 4} more mapped fields</div>
              )}
            </div>

            <div
              style={{
                display: "grid",
                gap: 10,
                gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))",
                borderTop: "1px solid #e5e7eb",
                paddingTop: 12,
              }}
            >
              {[
                {
                  title: "Mapping",
                  description: "Adjust column-to-column mapping and trimming",
                  countLabel: `${mappingRows.length} columns`,
                  key: "mapping" as const,
                },
                {
                  title: "Data type casting",
                  description: "Cast source values into destination types",
                  countLabel: `${mappingRows.filter((row) => row.cast).length} casts set`,
                  key: "cast" as const,
                },
                {
                  title: "Conditional expressions",
                  description: "If/else rules per column",
                  countLabel: `${mappingRows.filter((row) => row.condition).length} conditions set`,
                  key: "condition" as const,
                },
                {
                  title: "Concatenate columns",
                  description: "Merge multiple columns into one",
                  countLabel: `${mappingRows.filter((row) => row.concat).length} targets`,
                  key: "concat" as const,
                },
                {
                  title: "Split column",
                  description: "Split one column on a delimiter",
                  countLabel: `${mappingRows.filter((row) => row.split).length} splits`,
                  key: "split" as const,
                },
                {
                  title: "Row-level filters",
                  description: "Keep or discard rows by conditions",
                  countLabel: `${filters.length} filters`,
                  key: "filters" as const,
                },
                {
                  title: "Script",
                  description: "Write Python/PySpark transform script",
                  countLabel: d.config?.script ? "script present" : "no script",
                  key: "script" as const,
                },
              ].map((card) => (
                <div
                  key={card.key}
                  style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: 10,
                    padding: 12,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    background: "#fff",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
                  }}
                >
                  <div style={{ fontWeight: 700 }}>{card.title}</div>
                  <div style={{ color: "#475569", fontSize: 13 }}>{card.description}</div>
                  <div style={{ color: "#94a3b8", fontSize: 12 }}>{card.countLabel}</div>
                  <button
                    onClick={() => setOpenModal(card.key)}
                    style={{
                      alignSelf: "flex-start",
                      padding: "6px 10px",
                      borderRadius: 8,
                      border: "1px solid #cbd5f5",
                      background: "#eef2ff",
                      color: "#4338ca",
                      fontWeight: 600,
                    }}
                  >
                    Open
                  </button>
                </div>
              ))}
            </div>

            {/* The rest of the Inspector modals and logic remain unchanged */}

            {openModal === "mapping" && (
              <Modal title="Mapping" onClose={closeModal}>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      onClick={handleLoadPreview}
                      disabled={previewLoading}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 8,
                        border: "1px solid #e2e8f0",
                        background: previewLoading ? "#f8fafc" : "#fff",
                        color: previewLoading ? "#94a3b8" : "#0f172a",
                        fontWeight: 600,
                      }}
                    >
                      {previewLoading ? "Refreshing..." : "Refresh from schema"}
                    </button>
                    <div style={{ alignSelf: "center", color: "#475569", fontSize: 12 }}>
                      Loaded {mappingRows.length} columns
                    </div>
                  </div>
                  <div
                    style={{
                      border: "1px solid #e2e8f0",
                      borderRadius: 10,
                      padding: 12,
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                      maxHeight: "60vh",
                      overflowY: "auto",
                    }}
                  >
                    {mappingRows.map((row, idx) => {
                      const fallbackOptions = mappingRows
                        .map((r) => r.to)
                        .filter((val): val is string => Boolean(val));
                      const selectOptions =
                        destOptions.length > 0
                          ? Array.from(new Set([...destOptions, ...fallbackOptions]))
                          : Array.from(new Set(fallbackOptions));
                      return (
                        <div
                          key={`${row.from}-${idx}`}
                          style={{
                            border: "1px solid #f3f4f6",
                            borderRadius: 8,
                            padding: 10,
                            display: "grid",
                            gap: 10,
                            gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
                            alignItems: "flex-start",
                          }}
                        >
                          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            <div style={{ fontWeight: 600 }}>{row.from}</div>
                            <label style={{ fontSize: 12, color: "#475569", display: "flex", gap: 6, alignItems: "center" }}>
                              <input
                                type="checkbox"
                                checked={!!row.trim}
                                onChange={(e) => handleTrimToggle(idx, e.target.checked)}
                              />
                              Trim whitespace
                            </label>
                          </div>
                          <div>
                            <div style={{ fontSize: 12, color: "#475569", marginBottom: 4 }}>Destination column</div>
                            <select
                              value={row.to || ""}
                              onChange={(e) => handleDestinationChange(idx, e.target.value)}
                              style={{
                                width: "100%",
                                padding: "6px 8px",
                                borderRadius: 6,
                                border: "1px solid #cbd5f5",
                              }}
                            >
                              <option value="">(not mapped)</option>
                              {selectOptions.map((opt) => (
                                <option key={opt} value={opt}>
                                  {opt}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
                            <button
                              onClick={() => handleRemoveMappingRow(idx)}
                              style={{
                                border: "1px solid #fee2e2",
                                color: "#b91c1c",
                                background: "#fff",
                                padding: "4px 8px",
                                borderRadius: 6,
                              }}
                            >
                              Remove column
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </Modal>
            )}

            {/* Remaining modals (cast/condition/concat/split/filters/script) are unchanged from your original file */}
            {openModal === "cast" && (
              <Modal title="Data type casting" onClose={closeModal}>
                {mappingOptions.length === 0 ? (
                  <div style={{ color: "#475569" }}>Load mapping preview first.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ color: "#475569", fontSize: 13 }}>
                      Set casts per column (defaults to automatic if left empty).
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                        border: "1px solid #e2e8f0",
                        borderRadius: 10,
                        padding: 10,
                        maxHeight: "60vh",
                        overflowY: "auto",
                      }}
                    >
                      {mappingRows.map((row, idx) => (
                        <div
                          key={`${row.from}-${idx}`}
                          style={{
                            display: "grid",
                            gap: 8,
                            gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))",
                            alignItems: "center",
                            border: "1px solid #f3f4f6",
                            borderRadius: 8,
                            padding: 10,
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: 600, color: "#0f172a" }}>
                              {row.from} {row.to ? <span style={{ color: "#94a3b8" }}>→ {row.to}</span> : null}
                            </div>
                            {row.sourceType && (
                              <div style={{ fontSize: 12, color: "#475569" }}>{row.sourceType}</div>
                            )}
                          </div>
                          <label style={{ fontSize: 12, color: "#475569" }}>
                            Cast to
                            <select
                              value={row.cast || ""}
                              onChange={(e) => handleCastChange(idx, e.target.value as CastType | "")}
                              style={{
                                width: "100%",
                                marginTop: 4,
                                padding: "8px 10px",
                                borderRadius: 8,
                                border: "1px solid #cbd5f5",
                              }}
                            >
                              <option value="">No cast (auto)</option>
                              {CAST_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Modal>
            )}

            {openModal === "condition" && (
              <Modal title="Conditional expressions" onClose={closeModal}>
                {mappingOptions.length === 0 ? (
                  <div style={{ color: "#475569" }}>Load mapping preview first.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ color: "#475569", fontSize: 13 }}>
                      Define per-column if/else rules. Leave unchecked to skip conditions.
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                        border: "1px solid #e2e8f0",
                        borderRadius: 10,
                        padding: 10,
                        maxHeight: "60vh",
                        overflowY: "auto",
                      }}
                    >
                      {mappingRows.map((row, idx) => (
                        <div
                          key={`${row.from}-${idx}`}
                          style={{
                            border: "1px solid #f3f4f6",
                            borderRadius: 8,
                            padding: 10,
                            display: "grid",
                            gap: 10,
                            gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
                            alignItems: "flex-start",
                          }}
                        >
                          <div style={{ fontWeight: 600, color: "#0f172a" }}>
                            {row.from} {row.to ? <span style={{ color: "#94a3b8" }}>→ {row.to}</span> : null}
                          </div>
                          <label style={{ display: "flex", gap: 6, fontSize: 12, color: "#475569", alignItems: "center" }}>
                            <input
                              type="checkbox"
                              checked={!!row.condition}
                              onChange={(e) => handleConditionToggle(idx, e.target.checked)}
                            />
                            Enable conditional output
                          </label>
                          {row.condition && (
                            <>
                              <label style={{ fontSize: 12, color: "#475569" }}>
                                When column
                                <select
                                  value={row.condition.field || row.from}
                                  onChange={(e) => handleConditionField(idx, e.target.value)}
                                  style={{
                                    width: "100%",
                                    marginTop: 4,
                                    padding: "8px 10px",
                                    borderRadius: 8,
                                    border: "1px solid #e2e8f0",
                                  }}
                                >
                                  {sourceColumnOptions.map((opt) => (
                                    <option key={opt} value={opt}>
                                      {opt}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label style={{ fontSize: 12, color: "#475569" }}>
                                Operator
                                <select
                                  value={row.condition.operator}
                                  onChange={(e) => handleConditionOperator(idx, e.target.value as ComparisonOperator)}
                                  style={{
                                    width: "100%",
                                    marginTop: 4,
                                    padding: "8px 10px",
                                    borderRadius: 8,
                                    border: "1px solid #e2e8f0",
                                  }}
                                >
                                  {CONDITION_OPERATORS.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                      {opt.label}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              {operatorNeedsValue(row.condition.operator) && (
                                <label style={{ fontSize: 12, color: "#475569" }}>
                                  Compare value
                                  <input
                                    type="text"
                                    value={row.condition.value || ""}
                                    onChange={(e) => handleConditionValue(idx, e.target.value)}
                                    style={{
                                      width: "100%",
                                      marginTop: 4,
                                      padding: "8px 10px",
                                      borderRadius: 8,
                                      border: "1px solid #e2e8f0",
                                    }}
                                  />
                                </label>
                              )}
                              <label style={{ fontSize: 12, color: "#475569" }}>
                                Value when true
                                <input
                                  type="text"
                                  value={row.condition.thenValue || ""}
                                  onChange={(e) => handleConditionThen(idx, e.target.value)}
                                  style={{
                                    width: "100%",
                                    marginTop: 4,
                                    padding: "8px 10px",
                                    borderRadius: 8,
                                    border: "1px solid #e2e8f0",
                                  }}
                                />
                              </label>
                              <label style={{ fontSize: 12, color: "#475569" }}>
                                Value when false
                                <input
                                  type="text"
                                  value={row.condition.elseValue || ""}
                                  onChange={(e) => handleConditionElse(idx, e.target.value)}
                                  style={{
                                    width: "100%",
                                    marginTop: 4,
                                    padding: "8px 10px",
                                    borderRadius: 8,
                                    border: "1px solid #e2e8f0",
                                  }}
                                />
                              </label>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Modal>
            )}

            {openModal === "concat" && (
              <Modal title="Concatenate columns" onClose={closeModal}>
                {mappingOptions.length === 0 ? (
                  <div style={{ color: "#475569" }}>Load mapping preview first.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ color: "#475569", fontSize: 13 }}>Choose which columns to merge into each target.</div>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                        border: "1px solid #e2e8f0",
                        borderRadius: 10,
                        padding: 10,
                        maxHeight: "60vh",
                        overflowY: "auto",
                      }}
                    >
                      {mappingRows.map((row, idx) => (
                        <div
                          key={`${row.from}-${idx}`}
                          style={{
                            border: "1px solid #f3f4f6",
                            borderRadius: 8,
                            padding: 10,
                            display: "grid",
                            gap: 10,
                            gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
                            alignItems: "flex-start",
                          }}
                        >
                          <div style={{ fontWeight: 600, color: "#0f172a" }}>
                            Target: {row.to || row.from}
                          </div>
                          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "#475569" }}>
                            <input
                              type="checkbox"
                              checked={!!row.concat}
                              onChange={(e) => handleConcatToggle(idx, e.target.checked)}
                            />
                            Enable concatenation
                          </label>
                          {row.concat && (
                            <>
                              <div style={{ fontSize: 12, color: "#475569" }}>Include columns</div>
                              <div
                                style={{
                                  display: "grid",
                                  gap: 6,
                                  gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))",
                                }}
                              >
                                {sourceColumnOptions.map((col) => {
                                  const selected = row.concat?.sources.includes(col);
                                  return (
                                    <label key={col} style={{ fontSize: 12, color: "#1f2937", display: "flex", gap: 6 }}>
                                      <input
                                        type="checkbox"
                                        checked={selected}
                                        onChange={(e) => {
                                          const current = new Set(row.concat?.sources ?? []);
                                          if (e.target.checked) current.add(col);
                                          else current.delete(col);
                                          handleConcatSources(idx, Array.from(current));
                                        }}
                                      />
                                      {col}
                                    </label>
                                  );
                                })}
                              </div>
                              <label style={{ fontSize: 12, color: "#475569" }}>
                                Separator
                                <input
                                  type="text"
                                  value={row.concat?.separator ?? " "}
                                  onChange={(e) => handleConcatSeparator(idx, e.target.value)}
                                  style={{
                                    width: "100%",
                                    marginTop: 4,
                                    padding: "8px 10px",
                                    borderRadius: 8,
                                    border: "1px solid #e2e8f0",
                                  }}
                                />
                              </label>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Modal>
            )}

            {openModal === "split" && (
              <Modal title="Split column" onClose={closeModal}>
                {mappingOptions.length === 0 ? (
                  <div style={{ color: "#475569" }}>Load mapping preview first.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ color: "#475569", fontSize: 13 }}>Split any column into a specific part.</div>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                        border: "1px solid #e2e8f0",
                        borderRadius: 10,
                        padding: 10,
                        maxHeight: "60vh",
                        overflowY: "auto",
                      }}
                    >
                      {mappingRows.map((row, idx) => (
                        <div
                          key={`${row.from}-${idx}`}
                          style={{
                            border: "1px solid #f3f4f6",
                            borderRadius: 8,
                            padding: 10,
                            display: "grid",
                            gap: 10,
                            gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
                            alignItems: "flex-start",
                          }}
                        >
                          <div style={{ fontWeight: 600, color: "#0f172a" }}>
                            {row.from} {row.to ? <span style={{ color: "#94a3b8" }}>→ {row.to}</span> : null}
                          </div>
                          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "#475569" }}>
                            <input
                              type="checkbox"
                              checked={!!row.split}
                              onChange={(e) => handleSplitToggle(idx, e.target.checked)}
                            />
                            Enable split
                          </label>
                          {row.split && (
                            <>
                              <label style={{ fontSize: 12, color: "#475569" }}>
                                Delimiter
                                <input
                                  type="text"
                                  value={row.split.delimiter}
                                  onChange={(e) => handleSplitDelimiter(idx, e.target.value)}
                                  style={{
                                    width: "100%",
                                    marginTop: 4,
                                    padding: "8px 10px",
                                    borderRadius: 8,
                                    border: "1px solid #e2e8f0",
                                  }}
                                />
                              </label>
                              <label style={{ fontSize: 12, color: "#475569" }}>
                                Part index (0-based)
                                <input
                                  type="number"
                                  min={0}
                                  value={row.split.partIndex}
                                  onChange={(e) => handleSplitIndex(idx, Number(e.target.value) || 0)}
                                  style={{
                                    width: "100%",
                                    marginTop: 4,
                                    padding: "8px 10px",
                                    borderRadius: 8,
                                    border: "1px solid #e2e8f0",
                                  }}
                                />
                              </label>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Modal>
            )}

            {openModal === "filters" && (
              <Modal title="Row-level filters" onClose={closeModal}>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ color: "#475569" }}>Keep or discard rows. Filters are evaluated in order.</div>
                    <button
                      onClick={handleAddFilter}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 8,
                        border: "1px solid #e2e8f0",
                        background: "#fff",
                        fontWeight: 600,
                      }}
                    >
                      + Add filter
                    </button>
                  </div>
                  {filters.length === 0 ? (
                    <div style={{ fontSize: 13, color: "#94a3b8" }}>No filters applied.</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {filters.map((filter) => (
                        <div
                          key={filter.id}
                          style={{
                            border: "1px solid #e2e8f0",
                            borderRadius: 10,
                            padding: 10,
                            display: "grid",
                            gap: 8,
                            gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
                            alignItems: "center",
                          }}
                        >
                          <label style={{ fontSize: 12, color: "#475569" }}>
                            Column
                            <select
                              value={filter.field}
                              onChange={(e) => handleFilterField(filter.id, e.target.value)}
                              style={{
                                width: "100%",
                                marginTop: 4,
                                padding: "8px 10px",
                                borderRadius: 8,
                                border: "1px solid #e2e8f0",
                              }}
                            >
                              {sourceColumnOptions.map((opt) => (
                                <option key={opt} value={opt}>
                                  {opt}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label style={{ fontSize: 12, color: "#475569" }}>
                            Operator
                            <select
                              value={filter.operator}
                              onChange={(e) => handleFilterOperator(filter.id, e.target.value as ComparisonOperator)}
                              style={{
                                width: "100%",
                                marginTop: 4,
                                padding: "8px 10px",
                                borderRadius: 8,
                                border: "1px solid #e2e8f0",
                              }}
                            >
                              {FILTER_OPERATORS.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          {operatorNeedsValue(filter.operator) && (
                            <label style={{ fontSize: 12, color: "#475569" }}>
                              Value
                              <input
                                type="text"
                                value={filter.value || ""}
                                onChange={(e) => handleFilterValue(filter.id, e.target.value)}
                                style={{
                                  width: "100%",
                                  marginTop: 4,
                                  padding: "8px 10px",
                                  borderRadius: 8,
                                  border: "1px solid #e2e8f0",
                                }}
                              />
                            </label>
                          )}
                          <label style={{ fontSize: 12, color: "#475569" }}>
                            Action
                            <select
                              value={filter.action}
                              onChange={(e) => handleFilterAction(filter.id, e.target.value as "keep" | "discard")}
                              style={{
                                width: "100%",
                                marginTop: 4,
                                padding: "8px 10px",
                                borderRadius: 8,
                                border: "1px solid #e2e8f0",
                              }}
                            >
                              <option value="keep">Keep rows</option>
                              <option value="discard">Discard rows</option>
                            </select>
                          </label>
                          <div style={{ display: "flex", justifyContent: "flex-end" }}>
                            <button
                              onClick={() => handleFilterRemove(filter.id)}
                              style={{
                                border: "1px solid #fee2e2",
                                color: "#b91c1c",
                                background: "#fff",
                                padding: "4px 8px",
                                borderRadius: 6,
                              }}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Modal>
            )}

            {openModal === "script" && (
              <Modal title="Transform script (Python)" onClose={closeModal}>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ color: "#475569" }}>
                    Provide a Python transform. Your code will be wrapped into a function
                    and receive a variable `rows` (a list of objects). At the end the function
                    should return a list of rows (JSON-serializable).
                  </div>
                  <textarea
                    value={String(d.config?.script || "")}
                    onChange={(e) => updateNode({ config: { ...d.config, script: e.target.value } })}
                    placeholder="# Example: build output list and return it\nout = []\nfor r in rows:\n    out.append({ 'id': r.get('id'), 'double': (r.get('value') or 0) * 2 })\nreturn out"
                    rows={12}
                    style={{
                      width: "100%",
                      padding: "8px",
                      border: "1px solid #e2e8f0",
                      borderRadius: 6,
                      fontFamily: "monospace",
                      resize: "vertical",
                    }}
                  />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => {
                        const sample = "out = [r for r in rows]\nreturn out";
                        updateNode({ config: { ...d.config, script: sample } });
                      }}
                      style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff" }}
                    >
                      Insert simple passthrough
                    </button>
                    <div style={{ alignSelf: "center", color: "#94a3b8", fontSize: 12 }}>
                      Scripts run on the server using the host Python. Install packages (pandas, numpy) on the host if needed.
                    </div>
                  </div>
                </div>
              </Modal>
            )}
          </>
        )}
      </div>
    );
  }

  const input = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input
      {...props}
      style={{
        width: "100%",
        padding: "6px 8px",
        border: "1px solid #e5e7eb",
        borderRadius: 6,
      }}
    />
  );

  const testConnection = async () => {
    if (!d.dbType) return;
    try {
      setTesting(true);
      setTestMsg(null);
      console.log("Testing connection:", { type: d.dbType, config: d.config });

      const res = await fetch("/api/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: d.dbType, config: d.config }),
      });

      const text = await res.text();
      console.log("Raw response:", text);

      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        console.error("Failed to parse response as JSON:", text);
        setTestMsg(`❌ Invalid response (${res.status}): ${text.slice(0, 100)}`);
        return;
      }

      if (!res.ok) {
        console.error("Test failed:", json);
        setTestMsg("❌ " + (json.message || `Error ${res.status}`));
        return;
      }

      console.log("Test succeeded:", json);
      setTestMsg("✅ " + (json.message || "Connected successfully"));
    } catch (e) {
      console.error("Test connection error:", e);
      setTestMsg("❌ " + (e instanceof Error ? e.message : "Request failed - check console"));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div style={{ padding: 12 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>Label</div>
        {input({ value: d.label, onChange: (e) => updateNode({ label: e.target.value }) })}
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>Type</div>
        <select
          value={d.dbType || ""}
          onChange={(e) => {
            const value = e.target.value;
            if (!value) return;
            updateNode({
              dbType: value as DBType,
              config: defaultConfigFor(value as DBType),
            });
          }}
          style={{
            width: "100%",
            padding: "6px 8px",
            border: "1px solid #e5e7eb",
            borderRadius: 6,
          }}
        >
          <option value="">(choose)</option>
          <option value="csv">CSV</option>
          <option value="excel">Excel (XLSX)</option>
          <option value="json">JSON file</option>
          <option value="parquet">Parquet file</option>
          <option value="postgres">PostgreSQL</option>
          <option value="mysql">MySQL</option>
          <option value="mssql">SQL Server</option>
          <option value="oracle">Oracle</option>
          <option value="s3">Amazon S3</option>
          <option value="minio">MinIO</option>
          <option value="gcs">Google Cloud Storage</option>
          <option value="azureBlob">Azure Blob Storage</option>
        </select>
      </div>

      {d.dbType && (
        <div style={{ display: "grid", gap: 8 }}>
          {/* Upload picker for Source + CSV/Excel/JSON/Parquet */}
          {d.kind === "source" &&
            ["csv", "excel", "json", "parquet"].includes(d.dbType || "") && (
              <div>
                <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>
                  Upload {d.dbType?.toUpperCase()} file
                </div>
                <input
                  type="file"
                  accept={
                    d.dbType === "csv"
                      ? ".csv,text/csv"
                      : d.dbType === "excel"
                      ? ".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                      : d.dbType === "json"
                      ? ".json,application/json"
                      : ".parquet"
                  }
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    try {
                      setTestMsg(null);
                      const uploaded = await uploadFileInChunks(f, (progress) => {
                        setTestMsg(
                          `Uploading chunk ${progress.chunkIndex + 1}/${progress.totalChunks}...`
                        );
                      });
                      updateNode({ config: { ...d.config, path: uploaded.path } });
                      setTestMsg(`Uploaded: ${uploaded.name}`);
                      // reset input so selecting the same file again still triggers onChange
                      (e.target as HTMLInputElement).value = "";
                    } catch (err) {
                      setTestMsg("⚠️ " + (err instanceof Error ? err.message : "Upload failed"));
                    }
                  }}
                />
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>
                  {d.config?.path ? (
                    <>
                      Current file path: <code>{String(d.config.path)}</code>
                    </>
                  ) : (
                    "No file selected yet."
                  )}
                </div>
              </div>
            )}

          {/* Dynamic fields */}
          {fields.map((f) => {
            const val = (d.config ?? {})[f.key];
            const strVal = typeof val === "string" || typeof val === "number" ? String(val) : "";
            return (
              <div key={f.key}>
                <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>
                  {f.label}
                </div>
                {f.options && f.options.length ? (
                  <select
                    value={strVal}
                    onChange={(e) =>
                      updateNode({ config: { ...d.config, [f.key]: e.target.value } })
                    }
                    style={{
                      width: "100%",
                      padding: "6px 8px",
                      borderRadius: 6,
                      border: "1px solid #e5e7eb",
                    }}
                  >
                    <option value="">(choose)</option>
                    {f.options.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  input({
                    type: f.type === "password" ? "password" : "text",
                    placeholder: f.placeholder,
                    value: strVal,
                    onChange: (e) =>
                      updateNode({ config: { ...d.config, [f.key]: e.target.value } }),
                  })
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Optional custom SQL query for relational sources */}
      {d.kind === "source" &&
        d.dbType &&
        ["postgres", "mysql", "mssql", "oracle"].includes(d.dbType) && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>Custom query (optional)</div>
            <textarea
              value={typeof d.config?.customQuery === "string" ? d.config.customQuery : ""}
              onChange={(e) =>
                updateNode({
                  config: { ...d.config, customQuery: e.target.value },
                })
              }
              placeholder="Input a custom query"
              rows={4}
              style={{
                width: "100%",
                padding: "8px",
                border: "1px solid #e5e7eb",
                borderRadius: 6,
                fontFamily: "monospace",
                resize: "vertical",
              }}
            />
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>
              When provided, this query overrides the table selection for this source.
            </div>
          </div>
        )}

      <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
        <button
          onClick={testConnection}
          disabled={!d.dbType || testing}
          style={{
            padding: "6px 10px",
            border: "1px solid #e5e7eb",
            borderRadius: 6,
            background: "#fff",
          }}
        >
          {testing ? "Testing…" : "Test connection"}
        </button>
        {testMsg && (
          <span style={{ fontSize: 12, color: "#111827" }}>{testMsg}</span>
        )}
        {probeMsg && (
          <span style={{ fontSize: 12, color: "#6b7280" }}>{probeMsg}</span>
        )}
      </div>

      {/* Auto-create table toggle for DB destinations */}
      {d.kind === "destination" &&
        d.dbType &&
        ["postgres", "mysql", "mssql", "oracle"].includes(d.dbType) && (
          <label
            style={{
              marginTop: 12,
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              checked={!!d.config?.createTable}
              onChange={(e) =>
                updateNode({
                  config: { ...d.config, createTable: e.target.checked },
                })
              }
            />
            Automatically create table if it does not exist
          </label>
        )}
    </div>
  );
}

/* ───────────────────────────── Palette ───────────────────────────────────── */

function Palette({ onAdd }: { onAdd: (kind: NodeKind) => void }) {
  const btn = (onClick: () => void, text: string) => (
    <button
      onClick={onClick}
      style={{
        padding: "10px 12px",
        border: "1px solid #e5e7eb",
        borderRadius: 10,
        background: "#fff",
        textAlign: "left",
      }}
    >
      {text}
    </button>
  );
  return (
    <div style={{ padding: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Palette</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {btn(() => onAdd("source"), "Add Source")}
        {btn(() => onAdd("transform"), "Add Transform")}
        {btn(() => onAdd("destination"), "Add Destination")}
      </div>
      <div style={{ fontSize: 12, color: "#6b7280", marginTop: 8 }}>
        Connect <b>Source → Transform → Destination</b> (or Source → Destination) and configure nodes on the right.
      </div>
    </div>
  );
}

/* ───────────────────────────── Main editor (Zustand persistence) ─────────── */

function EditorInner() {
  // Pull state from the persisted store
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const selectedId = useWorkflowStore((s) => s.selectedId);
  const setNodes = useWorkflowStore((s) => s.setNodes);
  const setEdges = useWorkflowStore((s) => s.setEdges);
  const setSelectedId = useWorkflowStore((s) => s.setSelectedId);
  const reset = useWorkflowStore((s) => s.reset);
  const runStatus = useWorkflowStore((s) => s.runStatus);
  const setRunStatus = useWorkflowStore((s) => s.setRunStatus);
  const currentRunId = useWorkflowStore((s) => s.currentRunId);
  const setCurrentRunId = useWorkflowStore((s) => s.setCurrentRunId);

  // Local UI state for collapsible panes
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [schemaAbortController, setSchemaAbortController] = useState<AbortController | null>(null);
  const [saving, setSaving] = useState(false);
  const [stagePlanState, setStagePlanState] = useState<StageSpec[]>([]);
  const stageCursorRef = useRef(0);
  const [activeStageId, setActiveStageId] = useState<string | null>(null);
  const [runProgress, setRunProgress] = useState<{ written: number; total?: number }>({
    written: 0,
    total: undefined,
  });

  // NEW: timing (elapsed time)
  const [runTiming, setRunTiming] = useState<{ startedAt: number | null; endedAt: number | null }>({
    startedAt: null,
    endedAt: null,
  });
  const [tick, setTick] = useState(Date.now());

  const formatDuration = (ms: number) => {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  useEffect(() => {
    if (runStatus.state === "running" || runStatus.state === "cancelling") {
      const t = setInterval(() => setTick(Date.now()), 1000);
      return () => clearInterval(t);
    }
  }, [runStatus.state]);

  const elapsedMs =
    runTiming.startedAt ? (runTiming.endedAt ?? tick) - runTiming.startedAt : 0;
  const elapsedText =
    runTiming.startedAt ? `Time Elapsed: ${formatDuration(elapsedMs)}` : undefined;

  const selectedNode = useMemo(
    () => (selectedId ? nodes.find((n) => n.id === selectedId) ?? null : null),
    [nodes, selectedId]
  );

  const runState = runStatus.state;
  const runMessage = runStatus.message ?? "";
  const isFlowAnimating = runState === "running" || runState === "cancelling";

  const addNode = (kind: NodeKind) => {
    const id = Math.random().toString(36).slice(2, 9);
    const pos = { x: 260 + Math.random() * 220, y: 120 + Math.random() * 180 };
    const type =
      kind === "source"
        ? "SourceNode"
        : kind === "destination"
        ? "DestinationNode"
        : "TransformNode";
    const base: Node<NodeData> = {
      id,
      position: pos,
      type,
      data: {
        kind,
        label: kind === "source" ? "Source" : kind === "destination" ? "Destination" : "Transform",
        dbType: undefined,
        config: {},
      },
    };
    setNodes((nds) => nds.concat(base));
    setSelectedId(id);
  };

  const isValidConnection = (connection: Connection) => {
    if (!connection.source || !connection.target) return false;
    const sourceNode = nodes.find((n) => n.id === connection.source);
    const targetNode = nodes.find((n) => n.id === connection.target);
    if (!sourceNode || !targetNode) return false;
    const allowed: Record<NodeKind, NodeKind[]> = {
      source: ["transform", "destination"],
      transform: ["destination"],
      destination: ["transform", "destination"], // allow fan-out from persisted stage
    };
    return allowed[sourceNode.data.kind]?.includes(targetNode.data.kind) ?? false;
  };

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!isValidConnection(connection)) return;
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            type: "flowEdge",
            data: { animate: isFlowAnimating },
            style: { stroke: "#6366f1", strokeWidth: 2 },
          },
          eds
        )
      );
    },
    [isFlowAnimating, nodes, setEdges]
  );

  const onNodesChange = (changes: Parameters<typeof applyNodeChanges>[0]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  };

  const onEdgesChange = (changes: Parameters<typeof applyEdgeChanges>[0]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
  };

  const onSelectionChange = useCallback(
    ({ nodes: ns }: { nodes: Node[] }) => {
      setSelectedId(ns && ns[0] ? ns[0].id : null);
    },
    [setSelectedId]
  );

  const exportSpec = () => {
    const spec = buildSpec(nodes, edges);
    const blob = new Blob([JSON.stringify(spec, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "workflow.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const validate = () => {
    const issues: string[] = [];
    nodes.forEach((n) => {
      if (!n.data.dbType) issues.push(`${n.data.label} (${n.data.kind}): pick a database`);
      const fields = n.data.dbType ? DB_OPTIONS[n.data.dbType].fields : [];
      fields.forEach((f) => {
        const val = (n.data.config ?? {})[f.key];
        if (val === undefined || val === "")
          issues.push(`${n.data.label}: '${f.key}' is empty`);
      });
    });
    const inbound: Record<string, number> = {};
    edges.forEach((e) => (inbound[e.target] = (inbound[e.target] || 0) + 1));
    nodes
      .filter((n) => n.data.kind === "destination")
      .forEach((n) => {
        if (!inbound[n.id]) issues.push(`${n.data.label}: no incoming connection`);
      });
    alert(issues.length ? "Validation issues:\n- " + issues.join("\n- ") : "Validation passed ✅");
  };

  const clearAll = () => {
    reset(); // clears nodes/edges/selectedId + persisted copy
    setRunStatus({ state: "idle" });
    setCurrentRunId(null);
    setRunProgress({ written: 0, total: undefined });
    setRunTiming({ startedAt: null, endedAt: null });
  };

  const specText = useMemo(
    () => JSON.stringify(buildSpec(nodes, edges), null, 2),
    [nodes, edges]
  );

  const buildStagePlan = useCallback(() => {
    const errors: string[] = [];
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const incoming: Record<string, string[]> = {};
    const outgoing: Record<string, string[]> = {};
    edges.forEach((e) => {
      incoming[e.target] = incoming[e.target] || [];
      incoming[e.target].push(e.source);
      outgoing[e.source] = outgoing[e.source] || [];
      outgoing[e.source].push(e.target);
    });

    // Detect cycles (DFS)
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
    for (const n of nodes) {
      if (hasCycle(n.id)) {
        errors.push("Graph has a cycle; please break the loop.");
        break;
      }
    }

    // Topological order for stage sorting
    const indegree: Record<string, number> = {};
    nodes.forEach((n) => (indegree[n.id] = 0));
    edges.forEach((e) => (indegree[e.target] = (indegree[e.target] || 0) + 1));
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
    nodes
      .filter((n) => n.data.kind === "transform")
      .forEach((n) => {
        const inbound = (incoming[n.id] || []).map((srcId) => nodeMap.get(srcId)).filter(Boolean);
        if (inbound.length !== 1) {
          errors.push(`${n.data.label || n.id}: transform needs exactly one incoming connection.`);
        } else if (!["source", "destination"].includes(inbound[0]!.data.kind)) {
          errors.push(`${n.data.label || n.id}: incoming node must be Source or Destination.`);
        } else {
          transformInbound[n.id] = inbound[0]!.id;
        }
      });

    // Destination with multiple inbound edges is ambiguous
    nodes
      .filter((n) => n.data.kind === "destination")
      .forEach((n) => {
        if ((incoming[n.id] || []).length > 1) {
          errors.push(`${n.data.label || n.id}: destination has multiple incoming edges.`);
        }
      });

    if (errors.length) {
      return { stages: [] as StageSpec[], errors };
    }

    const stages: StageSpec[] = [];

    // Transform -> Destination stages (use transform mapping/filters)
    edges
      .filter((e) => {
        const src = nodeMap.get(e.source);
        const dst = nodeMap.get(e.target);
        return src?.data.kind === "transform" && dst?.data.kind === "destination";
      })
      .forEach((e) => {
        const transformNode = nodeMap.get(e.source)!;
        const destNode = nodeMap.get(e.target)!;
        const inboundId = transformInbound[transformNode.id];
        const inboundNode = inboundId ? nodeMap.get(inboundId) : null;
        if (!inboundNode) {
          errors.push(`${transformNode.data.label || transformNode.id}: missing inbound connection.`);
          return;
        }
        stages.push({
          id: `stage-${transformNode.id}-${destNode.id}`,
          fromNodeId: inboundNode.id,
          toNodeId: destNode.id,
          source: { dbType: inboundNode.data.dbType as DBType, config: inboundNode.data.config },
          destination: {
            dbType: destNode.data.dbType as DBType,
            config: ensureDestinationFormat(
              destNode.data.dbType as DBType,
              destNode.data.config,
              inboundNode.data.config
            ),
          },
          mapping: transformNode.data.mappingPreview,
          filters: transformNode.data.filters,
          script: transformNode.data.config?.script
            ? {
                language: "python" as const,
                code: String(transformNode.data.config.script),
                timeoutMs:
                  typeof transformNode.data.config.scriptTimeoutMs === "number"
                    ? transformNode.data.config.scriptTimeoutMs
                    : undefined,
              }
            : undefined,
        });
      });

    // Direct Source/Destination -> Destination stages (auto map)
    edges
      .filter((e) => {
        const src = nodeMap.get(e.source);
        const dst = nodeMap.get(e.target);
        return (
          dst?.data.kind === "destination" &&
          (src?.data.kind === "source" || src?.data.kind === "destination")
        );
      })
      .forEach((e) => {
        const src = nodeMap.get(e.source)!;
        const dst = nodeMap.get(e.target)!;
        stages.push({
          id: `stage-${src.id}-${dst.id}`,
          fromNodeId: src.id,
          toNodeId: dst.id,
          source: { dbType: src.data.dbType as DBType, config: src.data.config },
          destination: {
            dbType: dst.data.dbType as DBType,
            config: ensureDestinationFormat(dst.data.dbType as DBType, dst.data.config, src.data.config),
          },
        });
      });

    const stageOrderIndex = (stage: StageSpec) =>
      orderIndex.get(stage.fromNodeId) ?? orderIndex.get(stage.toNodeId) ?? 0;

    stages.sort((a, b) => stageOrderIndex(a) - stageOrderIndex(b));

    const missingConfig = stages
      .map((s) => {
        if (!s.source.dbType) return `Stage ${s.id}: missing source db type`;
        if (!s.destination.dbType) return `Stage ${s.id}: missing destination db type`;
        return null;
      })
      .filter(Boolean) as string[];
    if (missingConfig.length) {
      errors.push(...missingConfig);
    }

    return { stages, errors };
  }, [edges, nodes]);

  const edgeStageIdMap = useMemo(() => {
    const map = new Map<string, string>();
    stagePlanState.forEach((stage) => {
      edges.forEach((edge) => {
        if (edge.source === stage.fromNodeId && edge.target === stage.toNodeId) {
          map.set(edge.id, stage.id);
        }
      });
    });
    return map;
  }, [edges, stagePlanState]);

  const decoratedEdges = useMemo(
    () =>
      edges.map((edge) => {
        const stageId = edgeStageIdMap.get(edge.id);
        const stageMatches = stageId !== undefined && stageId === activeStageId;
        const animate = isFlowAnimating && (stageMatches || activeStageId === null);
        return {
          ...edge,
          type: "flowEdge",
          data: { ...(edge.data ?? {}), animate, stageId },
          style: {
            stroke: animate ? "#0ea5e9" : "#6366f1",
            strokeWidth: animate ? 3.5 : 2,
            ...(edge.style ?? {}),
          },
        };
      }),
    [edges, edgeStageIdMap, isFlowAnimating, activeStageId]
  );

  const decoratedNodes = useMemo(
    () =>
      nodes.map((n) => {
        if (n.data.kind !== "destination") return n;

        const total = runProgress.total;
        const written = runProgress.written;

        const isActiveRun = runState === "running" || runState === "cancelling";

        const progressText =
          total && total > 0
            ? `${written.toLocaleString()} / ${total.toLocaleString()} rows`
            : written > 0
            ? isActiveRun
              ? `${written.toLocaleString()} / … rows`
              : `${written.toLocaleString()} rows`
            : undefined;

        return {
          ...n,
          data: { ...n.data, progressText, elapsedText } as any,
        };
      }),
    [nodes, runProgress, elapsedText, runState]
  );

  const run = async () => {
    if (runState === "running" || runState === "cancelling") return;
    const { stages, errors } = buildStagePlan();
    if (errors.length) {
      alert("Fix these issues before running:\n- " + errors.join("\n- "));
      return;
    }
    if (!stages.length) {
      alert("No executable stages found. Connect nodes so data flows into destinations.");
      return;
    }

    setStagePlanState(stages);
    stageCursorRef.current = 0;
    setActiveStageId(null);
    setRunProgress({ written: 0, total: undefined });
    setRunTiming({ startedAt: Date.now(), endedAt: null }); // NEW

    const generatedRunId = `run_${Math.random().toString(36).slice(2, 8)}_${Date.now()}`;
    setCurrentRunId(generatedRunId);
    setRunStatus({ state: "running", message: `Submitting ${stages.length} stage(s)...` });

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 2,
          runId: generatedRunId,
          stages,
        }),
      });

      const json = await res.json();
      if (json.cancelled) {
        setRunStatus({ state: "cancelled", message: json.message || "Workflow run cancelled" });
        setCurrentRunId(null);
        setStagePlanState([]);
        stageCursorRef.current = 0;
        setRunTiming((t) => (t.startedAt ? { ...t, endedAt: Date.now() } : t));
      } else if (res.ok) {
        if (stages.length) {
          setActiveStageId(stages[0].id);
        }
        setRunStatus({
          state: "running",
          message: json.message || `Run started (${stages.length} stage${stages.length > 1 ? "s" : ""})`,
        });
      } else {
        setRunStatus({ state: "error", message: json.error || json.message || "Workflow run failed" });
        setCurrentRunId(null);
        setStagePlanState([]);
        stageCursorRef.current = 0;
        setRunTiming((t) => (t.startedAt ? { ...t, endedAt: Date.now() } : t));
      }

      if (json.outputUrl) window.open(json.outputUrl, "_blank");
    } catch (e) {
      console.error(e);
      setRunStatus({ state: "error", message: e instanceof Error ? e.message : "Run failed" });
      alert(e instanceof Error ? e.message : "Run failed");
      setCurrentRunId(null);
      setStagePlanState([]);
      stageCursorRef.current = 0;
      setRunTiming((t) => (t.startedAt ? { ...t, endedAt: Date.now() } : t));
    } finally {
      setSchemaAbortController(null);
    }
  };

  useEffect(() => {
    if (!currentRunId) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/runs/${currentRunId}/events?cursor=${stageCursorRef.current}`);
        if (!res.ok) return;
        const data: { events?: Array<Record<string, unknown>>; cursor?: number } = await res.json();
        const toNumber = (v: any): number | undefined => {
          if (typeof v === "number" && Number.isFinite(v)) return v;
          if (typeof v === "string") {
            const n = Number(v);
            return Number.isFinite(n) ? n : undefined;
          }
          return undefined;
        };

        if (data.events?.length) {
          data.events.forEach((ev) => {
            const evName = ev.ev as string | undefined;
            if (evName === "STAGE_START" && (ev as any).stageId) {
              setActiveStageId((ev as any).stageId as string);
              setRunStatus({ state: "running", message: "Running..." });
            }
            if (evName === "RUN_START") {
              setRunStatus({ state: "running", message: "Running..." });

              const total =
                toNumber((ev as any).rows) ??
                toNumber((ev as any).rowsTotal) ??
                toNumber((ev as any).totalRows) ??
                toNumber((ev as any).rowsReadTotal) ??
                toNumber((ev as any).readTotal) ??
                toNumber((ev as any).total);

              if (typeof total === "number" && total > 0) {
                setRunProgress((p) => ({ ...p, total: p.total ?? total }));
              }
            }
            if (evName === "READ_COMPLETE") {
              const total =
                toNumber((ev as any).rows) ??
                toNumber((ev as any).rowsTotal) ??
                toNumber((ev as any).totalRows) ??
                toNumber((ev as any).rowsReadTotal) ??
                toNumber((ev as any).readTotal) ??
                toNumber((ev as any).total);

              if (typeof total === "number" && total > 0) {
                setRunProgress((p) => ({ ...p, total: p.total ?? total }));
              }
            }
            if (evName === "PROGRESS") {
              const incomingTotal =
                toNumber((ev as any).rowsTotal) ??
                toNumber((ev as any).totalRows) ??
                toNumber((ev as any).rowsReadTotal) ??
                toNumber((ev as any).readTotal) ??
                toNumber((ev as any).total);

              const incomingWritten =
                toNumber((ev as any).rowsMoved) ??
                toNumber((ev as any).rowsWritten) ??
                toNumber((ev as any).rows);

              setRunProgress((p) => {
                const nextWritten = typeof incomingWritten === "number" ? incomingWritten : p.written;
                let nextTotal = p.total;

                // Treat "rowsTotal" as a real total only if it stays ahead of rows written.
                // If it equals rows written (some backends mean "moved so far"), we keep total undefined
                // and the UI will display an ellipsis until a true total arrives (or until RUN_FINISH).
                if (typeof incomingTotal === "number" && incomingTotal > 0) {
                  const looksLikeTotal = incomingTotal > nextWritten;
                  if (nextTotal === undefined) {
                    if (looksLikeTotal) nextTotal = incomingTotal;
                  } else {
                    if (looksLikeTotal && incomingTotal > nextTotal) nextTotal = incomingTotal;
                  }
                }

                return {
                  ...p,
                  written: nextWritten,
                  total: nextTotal,
                };
              });
            }
            if (evName === "WRITE_COMPLETE" && typeof (ev as any).rows === "number") {
              setRunProgress((p) => ({
                ...p,
                written: (ev as any).rows as number,
              }));
            }
            if (evName === "RUN_FINISH") {
              // Don't override an error/cancel state if we've already seen it
              if (runState === "error" || runState === "cancelled") {
                return;
              }
              const message = ((ev as any).message as string) || "Workflow run completed";
              setRunProgress((p) => {
                const finalWritten =
                  (typeof (ev as any).rowsMoved === "number" && (ev as any).rowsMoved > 0
                    ? ((ev as any).rowsMoved as number)
                    : typeof (ev as any).rowsWritten === "number"
                    ? ((ev as any).rowsWritten as number)
                    : p.written) ?? 0;

                // Keep total stable if we already know it from READ_COMPLETE.
                // Only infer it at the end if it was never provided.
                let finalTotal = p.total;
                if (finalTotal === undefined) {
                  const candidateTotal =
                    typeof (ev as any).rowsTotal === "number"
                      ? ((ev as any).rowsTotal as number)
                      : typeof (ev as any).rowsRead === "number"
                      ? ((ev as any).rowsRead as number)
                      : undefined;

                  if (typeof candidateTotal === "number" && candidateTotal >= finalWritten) {
                    finalTotal = candidateTotal;
                  } else {
                    // fallback: if we truly don't know total, show moved as total at the end
                    finalTotal = finalWritten;
                  }
                }

                return { written: finalWritten, total: finalTotal };
              });
              setRunTiming((t) => (t.startedAt ? { ...t, endedAt: Date.now() } : t)); // NEW
              setRunStatus({ state: "success", message });
              setActiveStageId(null);
              setStagePlanState([]);
              setCurrentRunId(null);
              // leave progress visible until next run starts
              stageCursorRef.current = 0;
            } else if (evName === "CANCELLING") {
              // FIX: don't mark cancelling as error
              const message = ((ev as any).message as string) || "Requesting stop...";
              setRunStatus({ state: "cancelling", message });
            } else if (evName === "ERROR" || evName === "CANCELLED") {
              const message =
                ((ev as any).message as string) ||
                (evName === "CANCELLED" ? "Workflow cancelled" : "Workflow run failed");
              setRunTiming((t) => (t.startedAt ? { ...t, endedAt: Date.now() } : t)); // NEW
              setRunStatus({ state: evName === "CANCELLED" ? "cancelled" : "error", message });
              setActiveStageId(null);
              setStagePlanState([]);
              setCurrentRunId(null);
              stageCursorRef.current = 0;
            } else if (evName === "STAGE_DONE" && runProgress.total && (ev as any).rowsWritten >= runProgress.total) {
              // safety: if RUN_FINISH is missed but we know we've written all rows, mark success
              setRunTiming((t) => (t.startedAt ? { ...t, endedAt: Date.now() } : t)); // NEW
              setRunStatus({ state: "success", message: "Workflow run completed" });
              setActiveStageId(null);
              setStagePlanState([]);
              setCurrentRunId(null);
              setRunProgress({ written: 0, total: undefined });
              stageCursorRef.current = 0;
            }
          });
        }
        if (typeof data.cursor === "number") {
          stageCursorRef.current = data.cursor;
        }
      } catch (err) {
        console.warn("Stage poll error", err);
      }
    };
    poll();
    const timer = setInterval(poll, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runState, currentRunId, runProgress.total]);

  const stopRun = useCallback(async () => {
    if (runState !== "running" && runState !== "cancelling") return;

    // If we have not begun the server run yet, abort the schema fetches.
    if (!currentRunId) {
      if (schemaAbortController) {
        schemaAbortController.abort();
        setSchemaAbortController(null);
      }
      setRunTiming((t) => (t.startedAt ? { ...t, endedAt: Date.now() } : t));
      setRunStatus({ state: "cancelled", message: "Workflow run cancelled" });
      return;
    }

    setRunStatus({ state: "cancelling", message: "Requesting stop..." });
    try {
      const res = await fetch(`/api/run/${currentRunId}/cancel`, { method: "POST" });
      const payload = await res.json().catch(() => ({ message: "Stop requested" }));

      if (res.status === 404) {
        setRunTiming((t) => (t.startedAt ? { ...t, endedAt: Date.now() } : t));
        setRunStatus({ state: "cancelled", message: "Run already finished" });
        return;
      }

      if (!res.ok) {
        throw new Error((payload as any)?.message || "Unable to stop workflow run");
      }

      setRunStatus({
        state: "cancelling",
        message: (payload as any)?.message || "Stop requested...",
      });
    } catch (err) {
      console.error(err);
      setRunTiming((t) => (t.startedAt ? { ...t, endedAt: Date.now() } : t));
      setRunStatus({
        state: "error",
        message: err instanceof Error ? err.message : "Unable to cancel run",
      });
    }
  }, [currentRunId, runState, schemaAbortController, setRunStatus]);

  const saveWorkflow = async () => {
    if (!nodes.length || !edges.length) {
      alert("Build a workflow before saving.");
      return;
    }
    const name = window.prompt("Enter a name for this workflow", "My workflow");
    if (!name || !name.trim()) return;
    const owner = window.prompt("Enter your name for this workflow (optional)", "");

    try {
      setSaving(true);
      const payload = {
        name: name.trim(),
        spec: buildSpec(nodes, edges),
        createdBy: owner?.trim() ? owner.trim() : undefined,
      };
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to save workflow");
      alert(`Workflow saved as "${json?.workflow?.name || name.trim()}"`);
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : "Failed to save workflow");
    } finally {
      setSaving(false);
    }
  };

  const leftWidth = leftCollapsed ? 42 : 340;
  const rightWidth = rightCollapsed ? 42 : 360;

  let statusBadge: React.ReactNode = null;
  if (runState !== "idle") {
    const visuals = RUN_STATUS_VISUALS[runState];
    const text = runMessage || visuals.fallback;
    statusBadge = (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 12px",
          borderRadius: 999,
          background: visuals.bg,
          color: visuals.color,
          fontSize: 12,
          fontWeight: 500,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: visuals.dot,
            display: "inline-block",
          }}
        />
        <span>{text}</span>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "calc(100vh - 80px)" }}>
      {/* LEFT: Palette + live JSON */}
      <div
        style={{
          width: leftWidth,
          borderRight: "1px solid #e5e7eb",
          background: "#fff",
          padding: 8,
          overflow: "auto",
          position: "relative",
        }}
      >
        {!leftCollapsed && (
          <>
            <Palette onAdd={addNode} />
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, marginTop: 8 }}>
              <div style={{ padding: 12, fontWeight: 600 }}>Pipeline JSON (live)</div>
              <pre style={{ padding: 12, fontSize: 12, whiteSpace: "pre-wrap" }}>{specText}</pre>
            </div>
          </>
        )}
        <button
          title={leftCollapsed ? "Expand" : "Collapse"}
          onClick={() => setLeftCollapsed((v) => !v)}
          style={{
            position: "absolute",
            top: 8,
            right: -12,
            width: 24,
            height: 24,
            borderRadius: 12,
            border: "1px solid #e5e7eb",
            background: "#fff",
          }}
        >
          {leftCollapsed ? "›" : "‹"}
        </button>
      </div>

      {/* CENTER: Canvas + top bar */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", position: "relative" }}>
        <div
          style={{
            display: "flex",
            gap: 8,
            padding: 8,
            borderBottom: "1px solid #e5e7eb",
            background: "#fff",
          }}
        >
          <div style={{ fontWeight: 600 }}>Workflow</div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
            {statusBadge}
            {isFlowAnimating && (
              <button
                onClick={stopRun}
                disabled={!currentRunId || runState === "cancelling"}
                style={{
                  background: "#fee2e2",
                  color: "#b91c1c",
                  border: "1px solid #fecaca",
                  fontWeight: 600,
                  padding: "6px 12px",
                  borderRadius: 8,
                  cursor: !currentRunId || runState === "cancelling" ? "not-allowed" : "pointer",
                }}
              >
                {runState === "cancelling" ? "Stopping..." : "Stop"}
              </button>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={validate}>Validate</button>
              <button onClick={exportSpec}>Export JSON</button>
              <button onClick={saveWorkflow} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                onClick={run}
                disabled={runState === "running" || runState === "cancelling"}
                style={{
                  background: "#059669",
                  color: "#fff",
                  border: "1px solid #059669",
                  opacity: runState === "running" || runState === "cancelling" ? 0.65 : 1,
                  cursor:
                    runState === "running" || runState === "cancelling" ? "not-allowed" : "pointer",
                }}
              >
                {runState === "running" || runState === "cancelling" ? "Running..." : "Run"}
              </button>
              <button onClick={clearAll} style={{ color: "#dc2626" }}>
                Clear
              </button>
            </div>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0 }}>
          <ReactFlow
            nodes={decoratedNodes}
            edges={decoratedEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectionChange={onSelectionChange}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            isValidConnection={isValidConnection}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            defaultViewport={{ x: 0, y: 0, zoom: 1.1 }}
            minZoom={0.4}
            maxZoom={2}
            style={{ width: "100%", height: "100%" }}
            connectOnClick
            panOnDrag={[2]}
            selectionOnDrag={false}
          >
            <Controls position="bottom-left" />
            <Background gap={16} size={1} />
          </ReactFlow>
        </div>
      </div>

      {/* RIGHT: Inspector */}
      <div
        style={{
          width: rightWidth,
          borderLeft: "1px solid #e5e7eb",
          background: "#fff",
          padding: 8,
          overflow: "auto",
          position: "relative",
        }}
      >
        {!rightCollapsed && (
          <>
            <div
              style={{
                fontWeight: 600,
                padding: 8,
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              Node Properties
            </div>
            <Inspector selected={selectedNode} setNodes={setNodes} />
          </>
        )}
        <button
          title={rightCollapsed ? "Expand" : "Collapse"}
          onClick={() => setRightCollapsed((v) => !v)}
          style={{
            position: "absolute",
            top: 8,
            left: -12,
            width: 24,
            height: 24,
            borderRadius: 12,
            border: "1px solid #e5e7eb",
            background: "#fff",
          }}
        >
          {rightCollapsed ? "‹" : "›"}
        </button>
      </div>
    </div>
  );
}

/* build a serializable pipeline spec (for Export JSON) */
function buildSpec(nodes: Node<NodeData>[], edges: Edge[]) {
  return {
    version: 1,
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: n.data.kind,
      label: n.data.label,
      dbType: n.data.dbType,
      config: n.data.config,
    })),
    edges: edges.map((e) => ({ from: e.source, to: e.target })),
  } as const;
}

export default function WorkflowPage() {
  return (
    <ReactFlowProvider>
      <EditorInner />
    </ReactFlowProvider>
  );
}
