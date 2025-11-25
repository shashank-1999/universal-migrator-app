"use client";
import { useEffect, useState, useCallback } from "react";
import styles from "./logs.module.css";

type WorkflowRun = {
  runId: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  rowsMoved?: number;
  rowsRead?: number;
  rowsWritten?: number;
  durationMs?: number;
  outputUrl?: string;
  error?: string;
  sourceType?: string;
  destinationType?: string;
  sourceTableName?: string;
  destinationTableName?: string;
};

export default function LogsPage() {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "success" | "failed" | "running">("all");
  const [searchQuery, setSearchQuery] = useState("");

  const loadRuns = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/runs");
      const json = await res.json();
      setRuns(json.runs || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  const filteredRuns = runs.filter((run) => {
    const statusMatch =
      filter === "all" ||
      (filter === "success" && (run.status === "completed" || run.status === "success")) ||
      (filter === "failed" && (run.status === "failed" || run.status === "error")) ||
      (filter === "running" && (run.status === "running" || run.status === "pending"));

    const text = searchQuery.trim().toLowerCase();
    const queryMatch =
      text.length === 0 ||
      run.runId.toLowerCase().includes(text) ||
      run.sourceType?.toLowerCase().includes(text) ||
      run.destinationType?.toLowerCase().includes(text) ||
      run.sourceTableName?.toLowerCase().includes(text) ||
      run.destinationTableName?.toLowerCase().includes(text) ||
      run.status.toLowerCase().includes(text);

    return statusMatch && queryMatch;
  });

  const statusStyle = (status: string) => {
    if (status === "completed" || status === "success") return styles.success;
    if (status === "failed" || status === "error") return styles.failed;
    if (status === "running" || status === "pending") return styles.running;
    return styles.neutral;
  };

  return (
    <div className="page">
      <div className={styles.container}>
        <div className={styles.hero}>
          <div>
            <h1 className={styles.heroTitle}>Workflow Activity</h1>
            <p className={styles.heroSubtitle}>
              Monitor every migration run, inspect outputs, and download artifacts.
            </p>
          </div>
          <button className="btn-secondary" onClick={loadRuns} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        <div className={styles.controlsSection}>
          <div className={styles.filterButtons}>
            {(["all", "success", "failed", "running"] as const).map((item) => (
              <button
                key={item}
                className={`${styles.filterButton} ${filter === item ? styles.active : ""}`}
                onClick={() => setFilter(item)}
              >
                {item.charAt(0).toUpperCase() + item.slice(1)}
              </button>
            ))}
          </div>
          <div className={styles.searchBox}>
            <input
              type="text"
              placeholder="Search run id, source or destination"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={styles.searchInput}
            />
          </div>
        </div>

        <div className={styles.tableContainer}>
          {filteredRuns.length === 0 ? (
            <div className={styles.emptyState}>No runs matched your criteria.</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Run ID</th>
                  <th>Status</th>
                  <th>Source</th>
                  <th>Destination</th>
                  <th>Rows moved</th>
                  <th>Started</th>
                  <th>Ended</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredRuns.map((run) => (
                  <tr key={run.runId}>
                    <td className={styles.runId}>{run.runId}</td>
                    <td>
                      <span className={`${styles.status} ${statusStyle(run.status)}`}>
                        {run.status}
                      </span>
                    </td>
                    <td>{run.sourceType || "-"}</td>
                    <td>{run.destinationType || "-"}</td>
                    <td>{run.rowsMoved ?? "-"}</td>
                    <td>{run.startedAt ? new Date(run.startedAt).toLocaleString() : "-"}</td>
                    <td>{run.endedAt ? new Date(run.endedAt).toLocaleString() : "-"}</td>
                    <td className={styles.actions}>
                      {run.outputUrl && (
                        <a className={styles.actionButton} href={run.outputUrl} target="_blank" rel="noreferrer">
                          Output
                        </a>
                      )}
                      <a
                        className={styles.actionButton}
                        href={`/api/runs/${run.runId}/log`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Log
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
