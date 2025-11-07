// lib/connectors/csv.ts
import { promises as fs } from "fs";
import path from "path";
import { Row, SchemaColumn } from "../types";

/* -------------------- small CSV helpers -------------------- */

function escapeCsvCell(v: any): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** VERY small CSV parser for comma+quotes. Good enough for demos. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur = "";
  let row: string[] = [];
  let inQ = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") {
        row.push(cur);
        cur = "";
      } else if (ch === "\r") {
        // ignore
      } else if (ch === "\n") {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = "";
      } else {
        cur += ch;
      }
    }
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

function stringifyCsv(rows: string[][]): string {
  return rows.map((r) => r.map(escapeCsvCell).join(",")).join("\n") + "\n";
}

/* ----------- path utilities (Windows friendly) ------------- */

async function ensureDirAndResolve(userPath: string): Promise<string> {
  const normalized = userPath.replace(/\\/g, "/");
  const outPath = path.isAbsolute(normalized)
    ? normalized
    : path.join(process.cwd(), normalized.replace(/^[.\\/]+/, ""));
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  return outPath;
}

async function resolveOnly(userPath: string): Promise<string> {
  const normalized = userPath.replace(/\\/g, "/");
  return path.isAbsolute(normalized)
    ? normalized
    : path.join(process.cwd(), normalized.replace(/^[.\\/]+/, ""));
}

/* ---------------------- public API ------------------------- */

/** Infer schema from header row (names) and first data row (very light typing). */
export async function csvSchema(cfg: { path: string }): Promise<SchemaColumn[]> {
  const p = await resolveOnly(cfg.path);
  const txt = await fs.readFile(p, "utf8").catch(() => "");
  if (!txt) {
    // If file doesn't exist yet, return empty schema; UI can map later.
    return [];
  }
  const rows = parseCsv(txt);
  if (!rows.length) return [];
  const header = rows[0];

  // naive typing from the first data row (if any)
  const sample = rows[1] || [];
  const cols: SchemaColumn[] = header.map((name, idx) => {
    const v = sample[idx];
    let type = "STRING";
    if (v !== undefined && v !== null && v !== "") {
      if (/^-?\d+$/.test(v)) type = "INT";
      else if (/^-?\d+(\.\d+)?$/.test(v)) type = "FLOAT";
      else if (/^\d{4}-\d{2}-\d{2}/.test(v)) type = "DATE";
    }
    return { name, type };
  });
  return cols;
}

export async function csvReadRows(cfg: { path: string }): Promise<Row[]> {
  const p = await resolveOnly(cfg.path);
  const txt = await fs.readFile(p, "utf8");
  const rows = parseCsv(txt);
  if (!rows.length) return [];
  const header = rows[0];
  const data = rows.slice(1);
  return data.map((r) => {
    const obj: Row = {};
    header.forEach((h, i) => (obj[h] = r[i]));
    return obj;
  });
}

export async function csvWriteRows(cfg: { path: string }, rows: Row[]): Promise<void> {
  const outPath = await ensureDirAndResolve(cfg.path);

  if (!rows?.length) {
    // create/clear file so users see something
    await fs.writeFile(outPath, "", "utf8");
    return;
  }

  const header = Object.keys(rows[0]);
  const data: string[][] = [header, ...rows.map((r) => header.map((h) => r[h]))];
  await fs.writeFile(outPath, stringifyCsv(data), "utf8");
}
