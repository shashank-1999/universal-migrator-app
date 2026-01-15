import fs from "fs";
import os from "os";
import path from "path";

function safeTempPath(prefix = "um_tmp_") {
  const dir = os.tmpdir();
  const name = `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}.csv`;
  return path.join(dir, name);
}

function escapeCsvField(v: unknown) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // Escape double quotes by doubling them, always wrap in quotes
  return `"${s.replace(/"/g, '""')}"`;
}

export async function writeRowsToTempCsv(rows: Array<Record<string, unknown>>): Promise<string> {
  if (!rows || !rows.length) {
    // Create empty file with no header
    const p = safeTempPath();
    await fs.promises.writeFile(p, "\n", "utf8");
    return p;
  }

  const cols = Object.keys(rows[0]);
  const p = safeTempPath();
  const ws = fs.createWriteStream(p, { encoding: "utf8" });

  // header
  ws.write(cols.map((c) => escapeCsvField(c)).join(",") + "\n");

  for (const r of rows) {
    const line = cols.map((c) => escapeCsvField((r as Record<string, unknown>)[c])).join(",");
    ws.write(line + "\n");
  }

  await new Promise<void>((res, rej) => {
    ws.end(() => res());
    ws.on("error", (e) => rej(e));
  });

  return p;
}

export async function removeTempFile(p: string) {
  try {
    await fs.promises.unlink(p);
  } catch (e) {
    // ignore
  }
}
