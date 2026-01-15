import { readJsonFile, writeJsonFile } from "./jsonStore";
import crypto from "crypto";

export type SavedWorkflow = {
  id: string;
  name: string;
  spec: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
};

const FILE = "workflows.json";

export function listWorkflows(): SavedWorkflow[] {
  return readJsonFile<SavedWorkflow[]>(FILE, []);
}

export function saveWorkflow(name: string, spec: Record<string, unknown>, createdBy?: string): SavedWorkflow {
  const all = listWorkflows();
  const now = new Date().toISOString();
  const wf: SavedWorkflow = {
    id: crypto.randomUUID(),
    name,
    spec,
    createdAt: now,
    updatedAt: now,
    createdBy,
  };
  all.push(wf);
  writeJsonFile(FILE, all);
  return wf;
}

export function deleteWorkflow(id: string): boolean {
  const all = listWorkflows();
  const next = all.filter((wf) => wf.id !== id);
  if (next.length === all.length) return false;
  writeJsonFile(FILE, next);
  return true;
}
