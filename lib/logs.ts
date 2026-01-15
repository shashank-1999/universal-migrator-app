import * as fs from "node:fs/promises";
import * as path from "node:path";

function redact(obj: unknown): unknown {
  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj)) {
      return (obj as unknown[]).map((v) => redact(v));
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj as Record<string, unknown>)) {
      const v = (obj as Record<string, unknown>)[k];
      if (/(password|secret|key)/i.test(k)) out[k] = "****";
      else out[k] = redact(v);
    }
    return out;
  }
  return obj;
}

export async function createRunWriter(runId: string) {
  const dir = path.join(process.cwd(), ".runs", runId);
  await fs.mkdir(dir, { recursive: true });
  const logPath = path.join(dir, "run.jsonl");
  const sumPath = path.join(dir, "summary.json");
  async function write(event: Record<string, unknown>) {
    const line = JSON.stringify({ ts: new Date().toISOString(), runId, ...(redact(event) as Record<string, unknown>) }) + "\n";
    await fs.appendFile(logPath, line, "utf8");
  }
  async function summary(obj: unknown) {
    await fs.writeFile(sumPath, JSON.stringify(redact(obj), null, 2), "utf8");
  }
  return { logPath, sumPath, write, summary };
}

export async function listSummaries() {
  const base = path.join(process.cwd(), ".runs");
  try {
    const ids = await fs.readdir(base);
    type RunSummary = Record<string, unknown> & { startedAt?: string };
    const out: RunSummary[] = [];
    for (const id of ids) {
      const p = path.join(base, id, "summary.json");
      try {
        const txt = await fs.readFile(p, "utf8");
        const j = JSON.parse(txt);
        out.push(j as RunSummary);
      } catch {}
    }
    out.sort((a, b) => ((b.startedAt ?? "") as string).localeCompare((a.startedAt ?? "") as string));
    return out;
  } catch {
    return [];
  }
}