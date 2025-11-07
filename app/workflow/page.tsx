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
} from "reactflow";
import "reactflow/dist/style.css";

import { useWorkflowStore, type NodeData } from "@/lib/workflowStore";

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

  // Local UI state for collapsible panes
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const selectedNode = useMemo(
    () => (selectedId ? nodes.find((n) => n.id === selectedId) ?? null : null),
    [nodes, selectedId]
  );

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
          { ...connection, animated: true, style: { stroke: "#6366f1", strokeWidth: 2 } },
          eds
        )
      );
    },
    [nodes, setEdges]
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
  };

  const specText = useMemo(
    () => JSON.stringify(buildSpec(nodes, edges), null, 2),
    [nodes, edges]
  );

  const run = async () => {
    try {
      const src = nodes.find((n) => n.data.kind === "source");
      const dst = nodes.find((n) => n.data.kind === "destination");
      if (!src || !dst) return alert("Add and connect a Source to a Destination first.");

      const [srcSchemaRes, dstSchemaRes] = await Promise.all([
        fetch("/api/schema", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: src.data.dbType, config: src.data.config }),
        }),
        fetch("/api/schema", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: dst.data.dbType, config: dst.data.config }),
        }),
      ]);

      const srcPayload = await srcSchemaRes.json();
      const dstPayload = await dstSchemaRes.json();
      if (!srcSchemaRes.ok) throw new Error(srcPayload?.error || "Source schema error");
      if (!dstSchemaRes.ok) throw new Error(dstPayload?.error || "Destination schema error");

      const srcCols = (srcPayload.columns || []) as { name: string }[];
      const dstCols = (dstPayload.columns || []) as { name: string }[];

      // auto-map by name (case-insensitive)
      const mapping = srcCols.map((c) => {
        const match = dstCols.find((d) => d.name.toLowerCase() === c.name.toLowerCase());
        return { from: c.name, to: match ? match.name : c.name, cast: "STRING" as const };
      });

      const runRes = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          source: { dbType: src.data.dbType, config: src.data.config },
          destination: { dbType: dst.data.dbType, config: dst.data.config },
          mapping,
        }),
      });

      const json = await runRes.json();
      alert(json.message || (runRes.ok ? "Run accepted" : "Run failed"));
      if (json.outputUrl) window.open(json.outputUrl, "_blank");
    } catch (e: any) {
      console.error(e);
      alert(e?.message || "Run failed");
    }
  };

  const leftWidth = leftCollapsed ? 42 : 340;
  const rightWidth = rightCollapsed ? 42 : 360;

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
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button onClick={validate}>Validate</button>
            <button onClick={exportSpec}>Export JSON</button>
            <button
              onClick={run}
              style={{
                background: "#059669",
                color: "#fff",
                border: "1px solid #059669",
              }}
            >
              Run
            </button>
            <button onClick={clearAll} style={{ color: "#dc2626" }}>
              Clear
            </button>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectionChange={onSelectionChange}
            nodeTypes={{ SourceNode, DestinationNode }}
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
