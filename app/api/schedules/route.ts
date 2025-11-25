import { NextRequest, NextResponse } from "next/server";
import { addSchedule, listSchedules, ScheduleFrequency, LoadType } from "@/lib/schedules";
import { listWorkflows } from "@/lib/storedWorkflows";

export async function GET() {
  return NextResponse.json({ ok: true, schedules: listSchedules() });
}

export async function POST(req: NextRequest) {
  try {
    const { workflowId, frequency, time, daysOfWeek, dayOfMonth, loadType, incrementalColumn } =
      await req.json();
    if (!workflowId) {
      return NextResponse.json({ ok: false, message: "workflowId is required" }, { status: 400 });
    }
    const wf = listWorkflows().find((w) => w.id === workflowId);
    if (!wf) {
      return NextResponse.json({ ok: false, message: "Workflow not found" }, { status: 404 });
    }

    const freq: ScheduleFrequency = frequency;
    if (!["daily", "weekly", "monthly"].includes(freq)) {
      return NextResponse.json({ ok: false, message: "Invalid frequency" }, { status: 400 });
    }
    if (!time || !/^\d{2}:\d{2}$/.test(time)) {
      return NextResponse.json({ ok: false, message: "Time must be HH:MM" }, { status: 400 });
    }

    if (freq === "weekly" && (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0)) {
      return NextResponse.json(
        { ok: false, message: "Weekly schedules require at least one dayOfWeek" },
        { status: 400 }
      );
    }

    if (freq === "monthly") {
      const dom = Number(dayOfMonth);
      if (!Number.isInteger(dom) || dom < 1 || dom > 31) {
        return NextResponse.json(
          { ok: false, message: "Monthly schedules require dayOfMonth between 1-31" },
          { status: 400 }
        );
      }
    }

    const mode: LoadType = loadType === "incremental" ? "incremental" : "full";
    if (mode === "incremental") {
      if (!incrementalColumn || !String(incrementalColumn).trim()) {
        return NextResponse.json(
          { ok: false, message: "Incremental column is required for incremental schedules" },
          { status: 400 }
        );
      }
    }

    const payload = {
      workflowId,
      frequency: freq,
      time,
      daysOfWeek: freq === "weekly" ? daysOfWeek : undefined,
      dayOfMonth: freq === "monthly" ? Number(dayOfMonth) : undefined,
      loadType: mode,
      incrementalColumn: mode === "incremental" ? String(incrementalColumn).trim() : undefined,
    };
    const saved = addSchedule(payload);
    return NextResponse.json({ ok: true, schedule: saved });
  } catch (err: any) {
    console.error("[POST /api/schedules]", err);
    return NextResponse.json(
      { ok: false, message: err?.message || "Failed to save schedule" },
      { status: 500 }
    );
  }
}
