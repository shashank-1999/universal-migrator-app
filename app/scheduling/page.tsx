"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./scheduling.module.css";

type SavedWorkflow = {
  id: string;
  name: string;
  spec: Record<string, unknown>;
  createdAt: string;
};

type Schedule = {
  id: string;
  workflowId: string;
  frequency: "daily" | "weekly" | "monthly";
  time: string;
  startAt?: string;
  daysOfWeek?: string[];
  dayOfMonth?: number;
  loadType: "full" | "incremental" | "merge";
  incrementalColumn?: string;
  createdAt: string;
  lastRunAt?: string;
  lastStatus?: "success" | "error";
  lastMessage?: string;
};

type RunFeedback = { type: "success" | "error"; message: string };

const DAY_OPTIONS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function SchedulingPage() {
  const [loading, setLoading] = useState(true);
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const defaultStartAt = useMemo(() => {
    const now = new Date();
    now.setSeconds(0, 0);
    return now.toISOString().slice(0, 16);
  }, []);

  const [form, setForm] = useState({
    workflowId: "",
    frequency: "daily",
    time: defaultStartAt.slice(11, 16),
    startAt: defaultStartAt,
    daysOfWeek: [] as string[],
    dayOfMonth: 1,
    loadType: "full" as "full" | "incremental" | "merge",
    incrementalColumn: "",
  });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workflowDeleting, setWorkflowDeleting] = useState(false);
  const [runningWorkflowId, setRunningWorkflowId] = useState<string | null>(null);
  const [runFeedback, setRunFeedback] = useState<RunFeedback | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const [wfRes, schedRes] = await Promise.all([fetch("/api/workflows"), fetch("/api/schedules")]);
      const wfJson = await wfRes.json();
      const schedJson = await schedRes.json();
      const fetchedWorkflows: SavedWorkflow[] = wfJson.workflows || [];
      setWorkflows(fetchedWorkflows);
      setSchedules(schedJson.schedules || []);
      setForm((prev) => {
        if (!fetchedWorkflows.length) {
          return { ...prev, workflowId: "" };
        }
        const stillExists = fetchedWorkflows.some((w) => w.id === prev.workflowId);
        if (stillExists && prev.workflowId) {
          return prev;
        }
        return { ...prev, workflowId: fetchedWorkflows[0].id };
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const selectedWorkflow = useMemo(
    () => workflows.find((w) => w.id === form.workflowId),
    [form.workflowId, workflows]
  );

  const submitSchedule = async () => {
    setMessage(null);
    setError(null);
    if (!form.workflowId) {
      setError("Select a workflow first.");
      return;
    }
    if (form.loadType === "incremental" && !form.incrementalColumn.trim()) {
      setError("Incremental column is required for incremental load.");
      return;
    }
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId: form.workflowId,
          frequency: form.frequency,
          time: form.time,
          startAt: form.startAt,
          daysOfWeek: form.frequency === "weekly" ? form.daysOfWeek : undefined,
          dayOfMonth: form.frequency === "monthly" ? form.dayOfMonth : undefined,
          loadType: form.loadType,
          incrementalColumn:
            form.loadType === "incremental" ? form.incrementalColumn.trim() : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message || "Failed to save schedule.");
        return;
      }
      setMessage("Schedule saved.");
      setForm((prev) => ({
        ...prev,
        daysOfWeek: [],
        dayOfMonth: 1,
        incrementalColumn: prev.loadType === "incremental" ? "" : prev.incrementalColumn,
        startAt: prev.startAt,
      }));
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    }
  };

  const runWorkflowNow = async (workflowId: string) => {
    setRunFeedback(null);
    setRunningWorkflowId(workflowId);
    try {
      const res = await fetch(`/api/workflows/${workflowId}/run`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.message || "Failed to run workflow.");
      }
      const msg = data?.runId ? `Run triggered (ID: ${data.runId}).` : "Run triggered.";
      setRunFeedback({ type: "success", message: msg });
      loadData();
    } catch (err) {
      setRunFeedback({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to run workflow.",
      });
    } finally {
      setRunningWorkflowId(null);
    }
  };

  const renderFrequencyFields = () => {
    if (form.frequency === "weekly") {
      return (
        <div className={styles.fieldBlock}>
          <label>Days of week</label>
          <div className={styles.chipRow}>
            {DAY_OPTIONS.map((day) => {
              const checked = form.daysOfWeek.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  className={`${styles.chip} ${checked ? styles.chipActive : ""}`}
                  onClick={() =>
                    setForm((prev) => ({
                      ...prev,
                      daysOfWeek: checked
                        ? prev.daysOfWeek.filter((x) => x !== day)
                        : [...prev.daysOfWeek, day],
                    }))
                  }
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      );
    }
    if (form.frequency === "monthly") {
      return (
        <div className={styles.fieldBlock}>
          <label htmlFor="dayOfMonth">Day of month</label>
          <input
            id="dayOfMonth"
            type="number"
            min={1}
            max={31}
            value={form.dayOfMonth}
            onChange={(e) =>
              setForm((prev) => ({
                ...prev,
                dayOfMonth: Math.max(1, Math.min(31, Number(e.target.value) || 1)),
              }))
            }
          />
        </div>
      );
    }
    return null;
  };

  const describeSchedule = (s: Schedule) => {
    switch (s.frequency) {
      case "daily":
        return `Daily at ${s.time}`;
      case "weekly":
        return `Weekly on ${(s.daysOfWeek || []).join(", ")} at ${s.time}`;
      case "monthly":
        return `Monthly on day ${s.dayOfMonth} at ${s.time}`;
      default:
        return "";
    }
  };

  const renderStatusBadge = (s: Schedule) => {
    if (!s.lastStatus) {
      return <span className={styles.statusBadge}>Never run</span>;
    }
    const cls =
      s.lastStatus === "success"
        ? `${styles.statusBadge} ${styles.statusSuccess}`
        : `${styles.statusBadge} ${styles.statusError}`;
    const label =
      s.lastStatus === "success" ? "Last run succeeded" : "Last run failed";
    return <span className={cls}>{label}</span>;
  };

  const deleteCurrentWorkflow = async () => {
    if (!form.workflowId) {
      alert("Select a workflow first.");
      return;
    }
    const wf = workflows.find((w) => w.id === form.workflowId);
    if (!window.confirm(`Delete workflow "${wf?.name || form.workflowId}"? This cannot be undone.`)) {
      return;
    }
    try {
      setWorkflowDeleting(true);
      setMessage(null);
      setError(null);
      const res = await fetch(`/api/workflows/${form.workflowId}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.message || "Failed to delete workflow.");
        return;
      }
      setMessage("Workflow deleted.");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete workflow.");
    } finally {
      setWorkflowDeleting(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div>
          <h1>Scheduling</h1>
          <p>Attach workflows to recurring schedules.</p>
        </div>
        <button className="btn-secondary" onClick={loadData} disabled={loading}>
          {loading ? "Refreshing�" : "Refresh"}
        </button>
      </div>

      <div className={styles.metrics}>
        <div className={styles.metricCard}>
          <span>Total workflows</span>
          <strong>{workflows.length}</strong>
        </div>
        <div className={styles.metricCard}>
          <span>Active schedules</span>
          <strong>{schedules.length}</strong>
        </div>
      </div>

      <div className={styles.contentGrid}>
        <section className={styles.formCard}>
          <div className={styles.formHeader}>
            <h2>Create / update schedule</h2>
            {selectedWorkflow && (
              <span className="chip">
                Workflow created {new Date(selectedWorkflow.createdAt).toLocaleDateString()}
              </span>
            )}
          </div>

          <div className={styles.fieldGrid}>
            <div className={styles.fieldBlock}>
              <label htmlFor="workflow">Workflow</label>
              <div className={styles.workflowRow}>
                <select
                  id="workflow"
                  value={form.workflowId}
                  onChange={(e) => setForm((prev) => ({ ...prev, workflowId: e.target.value }))}
                >
                  {workflows.map((wf) => (
                    <option key={wf.id} value={wf.id}>
                      {wf.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={styles.deleteWorkflowBtn}
                  onClick={deleteCurrentWorkflow}
                  disabled={!form.workflowId || workflowDeleting}
                >
                  {workflowDeleting ? "Deleting..." : "Delete"}
                </button>
              </div>
            </div>

            <div className={styles.fieldBlock}>
              <label htmlFor="frequency">Frequency</label>
              <select
                id="frequency"
                value={form.frequency}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    frequency: e.target.value as "daily" | "weekly" | "monthly",
                    daysOfWeek: [],
                    dayOfMonth: 1,
                  }))
                }
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>

            <div className={styles.fieldBlock}>
              <label htmlFor="startAt">Start date &amp; time</label>
              <input
                id="startAt"
                type="datetime-local"
                value={form.startAt}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    startAt: e.target.value,
                    time: e.target.value ? e.target.value.slice(11, 16) : prev.time,
                  }))
                }
              />
            </div>

            <div className={styles.fieldBlock}>
              <label htmlFor="load">Load mode</label>
              <select
                id="load"
                value={form.loadType}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
            loadType: e.target.value as "full" | "incremental" | "merge",
            incrementalColumn: "",
          }))
        }
      >
                <option value="full">Full load (truncate + load)</option>
                <option value="incremental">Incremental (merge on column)</option>
                <option value="merge">Merge (append without truncate)</option>
              </select>
            </div>

            {form.loadType === "incremental" && (
              <div className={styles.fieldBlock}>
                <label htmlFor="incremental">Incremental column</label>
                <input
                  id="incremental"
                  type="text"
                  placeholder="e.g. updated_at or id"
                  value={form.incrementalColumn}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, incrementalColumn: e.target.value }))
                  }
                />
              </div>
            )}
          </div>

          {renderFrequencyFields()}

          <div className={styles.formFooter}>
            <button className="btn-primary" onClick={submitSchedule} disabled={loading}>
              Save schedule
            </button>
            {message && <span className={styles.successText}>{message}</span>}
            {error && <span className={styles.errorText}>{error}</span>}
          </div>
        </section>

        <section className={styles.listCard}>
          <div className={styles.formHeader}>
            <h2>Saved schedules</h2>
          </div>
          {schedules.length === 0 ? (
            <div className={styles.empty}>No schedules yet.</div>
          ) : (
            <div className={styles.scheduleList}>
              {schedules.map((s) => {
                const wf = workflows.find((w) => w.id === s.workflowId);
                return (
                  <article key={s.id} className={styles.scheduleItem}>
                    <div className={styles.scheduleTitle}>{wf ? wf.name : "Unknown workflow"}</div>
                    <div className={styles.scheduleMeta}>
                      {renderStatusBadge(s)}
                      <span style={{ marginLeft: 8 }}>
                        Last run: {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : "Never"}
                      </span>
                    </div>
                    <div className={styles.scheduleMeta}>{describeSchedule(s)}</div>
                    <div className={styles.scheduleMeta}>
                      Load: {s.loadType === "incremental"
                        ? `Incremental (${s.incrementalColumn || "n/a"})`
                        : "Full load"}
                    </div>
                    {s.startAt && (
                      <div className={styles.scheduleMeta}>
                        Starts {new Date(s.startAt).toLocaleString()}
                      </div>
                    )}
                    <div className={styles.scheduleMeta}>
                      Created {new Date(s.createdAt).toLocaleString()}
                    </div>
                    {s.lastMessage && (
                      <div className={styles.scheduleMeta}>Status: {s.lastMessage}</div>
                    )}
                    {wf && (
                      <div className={styles.workflowActions}>
                        <button
                          type="button"
                          className="btn-primary"
                          onClick={() => runWorkflowNow(wf.id)}
                          disabled={runningWorkflowId === wf.id}
                        >
                          {runningWorkflowId === wf.id ? "Running…" : "Run now"}
                        </button>
                        <span className={styles.workflowMetaText}>ID: {wf.id}</span>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
          {runFeedback && (
            <div className={runFeedback.type === "success" ? styles.successText : styles.errorText}>
              {runFeedback.message}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
