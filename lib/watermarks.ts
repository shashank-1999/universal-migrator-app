import { readJsonFile, writeJsonFile } from "./jsonStore";

export type WatermarkValueType = "number" | "date" | "string";

export type WatermarkRecord = {
  scheduleId: string;
  incrementalColumn: string;
  type: WatermarkValueType;
  value: string;
  updatedAt: string;
};

const FILE = "watermarks.json";

function loadAll(): WatermarkRecord[] {
  return readJsonFile<WatermarkRecord[]>(FILE, []);
}

function saveAll(records: WatermarkRecord[]) {
  writeJsonFile(FILE, records);
}

export function getWatermark(scheduleId: string): WatermarkRecord | undefined {
  return loadAll().find((r) => r.scheduleId === scheduleId);
}

export function setWatermark(record: WatermarkRecord) {
  const all = loadAll();
  const idx = all.findIndex((r) => r.scheduleId === record.scheduleId);
  if (idx >= 0) {
    all[idx] = record;
  } else {
    all.push(record);
  }
  saveAll(all);
}

export function clearWatermark(scheduleId: string) {
  const all = loadAll().filter((r) => r.scheduleId !== scheduleId);
  saveAll(all);
}
