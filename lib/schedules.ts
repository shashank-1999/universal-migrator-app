import crypto from "crypto";
import { readJsonFile, writeJsonFile } from "./jsonStore";

export type ScheduleFrequency = "daily" | "weekly" | "monthly";

export type LoadType = "full" | "incremental";

export type SavedSchedule = {
  id: string;
  workflowId: string;
  frequency: ScheduleFrequency;
  time: string; // HH:mm
  daysOfWeek?: string[]; // weekly
  dayOfMonth?: number; // monthly
  loadType: LoadType;
  incrementalColumn?: string;
  createdAt: string;
  lastRunAt?: string;
  lastStatus?: "running" | "success" | "error";
  lastMessage?: string;
};

const FILE = "schedules.json";

export function listSchedules(): SavedSchedule[] {
  const data = readJsonFile<SavedSchedule[]>(FILE, []);
  return data.map((s) => ({
    ...s,
    loadType: s.loadType ?? "full",
  }));
}

export function addSchedule(
  data: Omit<SavedSchedule, "id" | "createdAt" | "lastRunAt" | "lastStatus" | "lastMessage">
): SavedSchedule {
  const schedules = listSchedules();
  const sched: SavedSchedule = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  schedules.push(sched);
  writeJsonFile(FILE, schedules);
  return sched;
}

export function updateScheduleMeta(
  id: string,
  patch: Partial<Pick<SavedSchedule, "lastRunAt" | "lastStatus" | "lastMessage">>
): SavedSchedule | null {
  const schedules = listSchedules();
  const idx = schedules.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const updated = { ...schedules[idx], ...patch };
  schedules[idx] = updated;
  writeJsonFile(FILE, schedules);
  return updated;
}

export function removeSchedulesForWorkflow(workflowId: string) {
  const schedules = listSchedules();
  const next = schedules.filter((s) => s.workflowId !== workflowId);
  if (next.length === schedules.length) return;
  writeJsonFile(FILE, next);
}
