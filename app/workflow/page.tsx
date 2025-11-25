"use client";

import React, { useCallback, useMemo, useState } from "react";
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

import { useWorkflowStore, type NodeData, type RunState } from "@/lib/workflowStore";

/* ───────────────────────────── Types / DB options ────────────────────────── */

type NodeKind = "source" | "destination";
type DBType =
  | "csv"
  | "excel"
  | "postgres"
  | "mysql"
  | "mssql"
  | "oracle"
  | "s3"
  | "gcs"
  | "azureBlob";

type RunStatus = RunState;

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
  { label: string; fields: { key: string; label: string; type?: string; placeholder?: string }[] }
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
    ],
  },
    oracle: {
    label: "Oracle",
    fields: [
      { key: "host",     label: "Host",        placeholder: "localhost" },
      { key: "port",     label: "Port",        placeholder: "1521" },
      { key: "service",  label: "Service Name",placeholder: "XEPDB1" },
      { key: "user",     label: "User" },
      { key: "password", label: "Password", type: "password" },
      { key: "schema",   label: "Schema (optional)" },
      { key: "table",    label: "Table", placeholder: "SCHEMA.TABLE or TABLE" },
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
    ],
  },
  gcs: {
    label: "Google Cloud Storage (CSV object)",
    fields: [
      { key: "projectId", label: "Project Id" },
      { key: "bucket", label: "Bucket" },
      { key: "key", label: "Key (object path)" },
      { key: "keyFilename", label: "Service Account JSON path (optional)" },
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
    ],
  },
};

const defaultConfigFor = (dbType?: DBType): Record<string, any> =>
  !dbType ? {} : Object.fromEntries(DB_OPTIONS[dbType].fields.map((f) => [f.key, ""]));

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
              .filter(([k]) =>
                ["path", "host", "database", "table", "bucket", "key"].includes(k)
              )
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
          <div style={{ color: "#9ca3af" }}>Select a DB on the right →</div>
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
              .filter(([k]) =>
                ["path", "host", "database", "table", "bucket", "key"].includes(k)
              )
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
          <div style={{ color: "#9ca3af" }}>Pick destination DB on the right →</div>
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
  </div>
);

const nodeTypes = { SourceNode, DestinationNode } as const;

type FlowParticle =
  | { label: string; color: string; duration: number; icon?: never }
  | { icon: "stack"; color: string; duration: number; label?: never };

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

  const updateNode = useCallback(
    (patch: Partial<NodeData>) => {
      if (!node) return;
      setNodes((nds) =>
        nds.map((n) =>
          n.id === node.id
            ? {
                ...n,
                data: {
                  ...n.data,
                  ...patch,
                  config: patch.config ? patch.config : n.data.config,
                },
              }
            : n
        )
      );
    },
    [node, setNodes]
  );

  if (!node)
    return (
      <div style={{ padding: 12, fontSize: 14, color: "#6b7280" }}>
        Select a node to edit its configuration.
      </div>
    );

  const d = node.data;
  const fields = d.dbType ? DB_OPTIONS[d.dbType].fields : [];

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
    } catch (e: any) {
      console.error("Test connection error:", e);
      setTestMsg("❌ " + (e?.message || "Request failed - check console"));
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
          onChange={(e) =>
            updateNode({
              dbType: e.target.value as DBType,
              config: defaultConfigFor(e.target.value as DBType),
            })
          }
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
          <option value="postgres">PostgreSQL</option>
          <option value="mysql">MySQL</option>
          <option value="mssql">SQL Server</option>
          <option value="oracle">Oracle</option>
          <option value="s3">Amazon S3</option>
          <option value="gcs">Google Cloud Storage</option>
          <option value="azureBlob">Azure Blob Storage</option>
        </select>
      </div>

      {d.dbType && (
        <div style={{ display: "grid", gap: 8 }}>
          {/* Upload picker ONLY for Source + CSV/Excel */}
          {d.kind === "source" && (d.dbType === "csv" || d.dbType === "excel") && (
            <div>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>
                Upload {d.dbType.toUpperCase()} file
              </div>
              <input
                type="file"
                accept={
                  d.dbType === "csv"
                    ? ".csv,text/csv"
                    : ".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                }
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try {
                    setTestMsg(null);
                    const fd = new FormData();
                    fd.append("file", f);
                    const res = await fetch("/api/upload", { method: "POST", body: fd });
                    const json = await res.json();
                    if (!json.ok) throw new Error(json.message || "Upload failed");
                    updateNode({ config: { ...d.config, path: json.path } });
                    setTestMsg(`📦 Uploaded: ${json.name} → ${json.path}`);
                  } catch (err: any) {
                    setTestMsg("❌ " + (err?.message || "Upload failed"));
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
            const val = (d.config ?? {})[f.key] ?? "";
            return (
              <div key={f.key}>
                <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>
                  {f.label}
                </div>
                {input({
                  type: f.type === "password" ? "password" : "text",
                  placeholder: f.placeholder,
                  value: val,
                  onChange: (e) =>
                    updateNode({ config: { ...d.config, [f.key]: e.target.value } }),
                })}
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
              value={d.config?.customQuery ?? ""}
              onChange={(e) =>
                updateNode({
                  config: { ...d.config, customQuery: e.target.value },
                })
              }
              placeholder="SELECT * FROM your_table WHERE ..."
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
        {btn(() => onAdd("source"), "＋ Add Source")}
        {btn(() => onAdd("destination"), "＋ Add Destination")}
      </div>
      <div style={{ fontSize: 12, color: "#6b7280", marginTop: 8 }}>
        Drag, connect <b>Source → Destination</b>, select to configure on the right.
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
    const base: Node<NodeData> = {
      id,
      position: pos,
      type: kind === "source" ? "SourceNode" : "DestinationNode",
      data: {
        kind,
        label: kind === "source" ? "Source" : "Destination",
        dbType: undefined,
        config: {},
      },
    };
    setNodes((nds) => nds.concat(base));
    setSelectedId(id);
  };

  const isValidConnection = (connection: Connection) => {
    if (!connection.source || !connection.target) return false;
    const s = nodes.find((n) => n.id === connection.source);
    const t = nodes.find((n) => n.id === connection.target);
    return !!s && !!t && s!.data.kind === "source" && t!.data.kind === "destination";
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
  };

  const specText = useMemo(
    () => JSON.stringify(buildSpec(nodes, edges), null, 2),
    [nodes, edges]
  );

  const decoratedEdges = useMemo(
    () =>
      edges.map((edge) => ({
        ...edge,
        type: "flowEdge",
        data: { ...(edge.data ?? {}), animate: isFlowAnimating },
        style: {
          stroke: "#6366f1",
          strokeWidth: 2,
          ...(edge.style ?? {}),
        },
      })),
    [edges, isFlowAnimating]
  );

  const run = async () => {
    if (runState === "running" || runState === "cancelling") return;

    const src = nodes.find((n) => n.data.kind === "source");
    const dst = nodes.find((n) => n.data.kind === "destination");
    if (!src || !dst) return alert("Add and connect a Source to a Destination first.");

    const controller = new AbortController();
    setSchemaAbortController(controller);
    setRunStatus({ state: "running", message: "Fetching schema information..." });

    try {
      const [srcSchemaRes, dstSchemaRes] = await Promise.all([
        fetch("/api/schema", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: src.data.dbType, config: src.data.config }),
          signal: controller.signal,
        }),
        fetch("/api/schema", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: dst.data.dbType, config: dst.data.config }),
          signal: controller.signal,
        }),
      ]);

      if (controller.signal.aborted) {
        throw new DOMException("Run aborted", "AbortError");
      }

      const srcPayload = await srcSchemaRes.json();
      const dstPayload = await dstSchemaRes.json();
      if (!srcSchemaRes.ok) throw new Error(srcPayload?.error || "Source schema error");
      if (!dstSchemaRes.ok) throw new Error(dstPayload?.error || "Destination schema error");

      const srcCols = (srcPayload.columns || []) as { name: string }[];
      const dstCols = (dstPayload.columns || []) as { name: string }[];

      setRunStatus({ state: "running", message: "Aligning columns..." });

      // auto-map by name (case-insensitive)
      const mapping = srcCols.map((c) => {
        const match = dstCols.find((d) => d.name.toLowerCase() === c.name.toLowerCase());
        return { from: c.name, to: match ? match.name : c.name, cast: "STRING" as const };
      });

      if (controller.signal.aborted) {
        throw new DOMException("Run aborted", "AbortError");
      }

      setSchemaAbortController(null);

      const generatedRunId = `run_${Math.random().toString(36).slice(2, 8)}_${Date.now()}`;
      setCurrentRunId(generatedRunId);
      setRunStatus({ state: "running", message: "Submitting workflow run..." });

      const runRes = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          runId: generatedRunId,
          source: { dbType: src.data.dbType, config: src.data.config },
          destination: { dbType: dst.data.dbType, config: dst.data.config },
          mapping,
        }),
      });

      const json = await runRes.json();
      if (json.cancelled) {
        setRunStatus({ state: "cancelled", message: json.message || "Workflow run cancelled" });
      } else if (runRes.ok) {
        setRunStatus({ state: "success", message: json.message || "Workflow run accepted" });
      } else {
        setRunStatus({ state: "error", message: json.error || json.message || "Workflow run failed" });
      }

      if (!json.cancelled) {
        alert(json.message || (runRes.ok ? "Run accepted" : "Run failed"));
      }
      if (json.outputUrl) window.open(json.outputUrl, "_blank");
    } catch (e: any) {
      if (e?.name === "AbortError") {
        setRunStatus({ state: "cancelled", message: "Workflow run cancelled" });
        return;
      }
      console.error(e);
      setRunStatus({ state: "error", message: e?.message || "Run failed" });
      alert(e?.message || "Run failed");
    } finally {
      setSchemaAbortController(null);
      setCurrentRunId(null);
    }
  };

  const stopRun = useCallback(async () => {
    if (runState !== "running" && runState !== "cancelling") return;

    // If we have not begun the server run yet, abort the schema fetches.
    if (!currentRunId) {
      if (schemaAbortController) {
        schemaAbortController.abort();
        setSchemaAbortController(null);
      }
      setRunStatus({ state: "cancelled", message: "Workflow run cancelled" });
      return;
    }

    setRunStatus({ state: "cancelling", message: "Requesting stop..." });
    try {
      const res = await fetch(`/api/run/${currentRunId}/cancel`, { method: "POST" });
      const payload = await res.json().catch(() => ({ message: "Stop requested" }));

      if (res.status === 404) {
        setRunStatus({ state: "cancelled", message: "Run already finished" });
        return;
      }

      if (!res.ok) {
        throw new Error(payload?.message || "Unable to stop workflow run");
      }

      setRunStatus({
        state: "cancelling",
        message: payload?.message || "Stop requested...",
      });
    } catch (err: any) {
      console.error(err);
      setRunStatus({
        state: "error",
        message: err?.message || "Unable to cancel run",
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

    try {
      setSaving(true);
      const payload = {
        name: name.trim(),
        spec: buildSpec(nodes, edges),
      };
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to save workflow");
      alert(`Workflow saved as "${json?.workflow?.name || name.trim()}"`);
    } catch (err: any) {
      console.error(err);
      alert(err?.message || "Failed to save workflow");
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
            nodes={nodes}
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
            connectionMode="loose"
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
