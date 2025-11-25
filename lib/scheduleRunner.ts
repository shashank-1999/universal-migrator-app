import { NextRequest } from "next/server";
import { POST as runRoute } from "@/app/api/run/route";
import { listSchedules, SavedSchedule, updateScheduleMeta } from "./schedules";
import { listWorkflows } from "./storedWorkflows";
import { pgSchema } from "./connectors/postgres";
import { mysqlSchema } from "./connectors/mysql";
import { mssqlSchema } from "./connectors/mssql";
import { csvSchema } from "./connectors/csv";
import { excelSchema } from "./connectors/excel";

type NodeSpec = {
  id: string;
  kind: "source" | "destination";
  dbType?: string;
  config?: Record<string, any>;
};

type WorkflowSpec = {
  version: number;
  nodes: NodeSpec[];
  edges: { from: string; to: string }[];
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const POLL_MS = Number(process.env.SCHEDULE_POLL_INTERVAL_MS ?? 60_000);

class ScheduleRunner {
  private timer?: NodeJS.Timeout;
  private runningIds = new Set<string>();

  constructor() {
    this.start();
  }

  private start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) =>
        console.error("[scheduleRunner] tick error", err)
      );
    }, POLL_MS);
    // Run immediately on bootstrap
    this.tick().catch((err) => console.error("[scheduleRunner] init error", err));
    console.info(
      `[scheduleRunner] Background scheduler started (interval ${POLL_MS}ms)`
    );
  }

  private async tick() {
    const schedules = listSchedules();
    const now = new Date();

    for (const schedule of schedules) {
      if (this.runningIds.has(schedule.id)) continue;
      if (!this.shouldRun(schedule, now)) continue;
      this.runningIds.add(schedule.id);
      this.executeSchedule(schedule)
        .catch((err) =>
          console.error(
            `[scheduleRunner] Failed schedule ${schedule.id}`,
            err
          )
        )
        .finally(() => this.runningIds.delete(schedule.id));
    }
  }

  private parseTimeToMinutes(value: string): number {
    const [h, m] = value.split(":").map((part) => Number(part));
    if (Number.isNaN(h) || Number.isNaN(m)) return -1;
    return h * 60 + m;
  }

  private isSameDay(a: Date, b: Date) {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  private shouldRun(schedule: SavedSchedule, now: Date) {
    const targetMinutes = this.parseTimeToMinutes(schedule.time);
    if (targetMinutes === -1) return false;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (nowMinutes < targetMinutes) return false;

    const lastRun = schedule.lastRunAt ? new Date(schedule.lastRunAt) : null;
    const todayLabel = DAY_LABELS[now.getDay()];

    switch (schedule.frequency) {
      case "daily":
        return !lastRun || !this.isSameDay(lastRun, now);
      case "weekly":
        if (
          !schedule.daysOfWeek ||
          !schedule.daysOfWeek.includes(todayLabel as string)
        ) {
          return false;
        }
        return !lastRun || !this.isSameDay(lastRun, now);
      case "monthly": {
        if (schedule.dayOfMonth && now.getDate() !== schedule.dayOfMonth) {
          return false;
        }
        if (!schedule.dayOfMonth && now.getDate() !== 1) return false;
        if (!lastRun) return true;
        return !(
          lastRun.getFullYear() === now.getFullYear() &&
          lastRun.getMonth() === now.getMonth()
        );
      }
      default:
        return false;
    }
  }

  private findNodes(spec: WorkflowSpec | undefined) {
    if (!spec?.nodes?.length) return { source: null, destination: null };
    const source = spec.nodes.find((n) => n.kind === "source") ?? null;
    const destination =
      spec.nodes.find((n) => n.kind === "destination") ?? null;
    return { source, destination };
  }

  private async loadColumns(dbType?: string, config?: Record<string, any>) {
    if (!dbType) return [];
    const normalized = dbType.toLowerCase();
    try {
      switch (normalized) {
        case "postgres":
        case "postgresql":
          return (await pgSchema(config)).columns ?? [];
        case "mysql":
          return (await mysqlSchema(config)).columns ?? [];
        case "mssql":
        case "sqlserver":
          return (await mssqlSchema(config)).columns ?? [];
        case "csv":
          return (await csvSchema(config)).columns ?? [];
        case "excel":
          return (await excelSchema(config)).columns ?? [];
        default:
          return [];
      }
    } catch (err) {
      console.warn("[scheduleRunner] schema load failed", normalized, err);
      return [];
    }
  }

  private async buildMapping(source?: NodeSpec | null, destination?: NodeSpec | null) {
    if (!source || !destination) return undefined;
    const [srcCols, dstCols] = await Promise.all([
      this.loadColumns(source.dbType, source.config),
      this.loadColumns(destination.dbType, destination.config),
    ]);

    if (!srcCols.length || !dstCols.length) return undefined;

    return srcCols.map((col: any) => {
      const match = dstCols.find(
        (d: any) =>
          typeof d.name === "string" &&
          typeof col.name === "string" &&
          d.name.toLowerCase() === col.name.toLowerCase()
      );
      if (match) {
        return { from: col.name, to: match.name, cast: "STRING" as const };
      }
      return { from: col.name, to: col.name, cast: "STRING" as const };
    });
  }

  private async executeSchedule(schedule: SavedSchedule) {
    const workflows = listWorkflows();
    const workflow = workflows.find((w) => w.id === schedule.workflowId);
    const nowIso = new Date().toISOString();

    if (!workflow) {
      updateScheduleMeta(schedule.id, {
        lastRunAt: nowIso,
        lastStatus: "error",
        lastMessage: "Workflow not found",
      });
      return;
    }

    const spec: WorkflowSpec | undefined = workflow.spec;
    const { source, destination } = this.findNodes(spec);
    if (!source || !destination || !source.dbType || !destination.dbType) {
      updateScheduleMeta(schedule.id, {
        lastRunAt: nowIso,
        lastStatus: "error",
        lastMessage: "Workflow is missing configured source/destination",
      });
      return;
    }

    const mapping = await this.buildMapping(source, destination);

    const payload = {
      version: spec?.version ?? 1,
      source: { dbType: source.dbType, config: source.config },
      destination: { dbType: destination.dbType, config: destination.config },
      mapping,
      loadOptions: {
        mode: schedule.loadType === "incremental" ? "incremental" : "full",
        incrementalColumn:
          schedule.loadType === "incremental"
            ? schedule.incrementalColumn
            : undefined,
        scheduleId: schedule.id,
      },
    };

    const startedIso = new Date().toISOString();
    updateScheduleMeta(schedule.id, {
      lastRunAt: startedIso,
      lastStatus: "running",
      lastMessage: "Workflow run in progress...",
    });

    try {
      const request = new NextRequest("http://local/schedule", {
        method: "POST",
        headers: new Headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });
      const response = await runRoute(request);
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(json?.message || "Run failed");
      }

      updateScheduleMeta(schedule.id, {
        lastRunAt: new Date().toISOString(),
        lastStatus: "success",
        lastMessage:
          json?.message ||
          `Run queued${json?.moved != null ? ` (${json.moved} rows)` : ""}`,
      });
      console.info(
        `[scheduleRunner] Schedule ${schedule.id} run started (${workflow.name})`
      );
    } catch (err: any) {
      updateScheduleMeta(schedule.id, {
        lastRunAt: new Date().toISOString(),
        lastStatus: "error",
        lastMessage: err?.message || "Run failed",
      });
      console.error(
        `[scheduleRunner] Schedule ${schedule.id} run failed`,
        err
      );
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __scheduleRunner: ScheduleRunner | undefined;
}

if (!globalThis.__scheduleRunner) {
  globalThis.__scheduleRunner = new ScheduleRunner();
}

export {};
