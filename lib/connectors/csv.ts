// lib/connectors/csv.ts
import { promises as fs, createReadStream } from "fs";
import path from "path";
import { Row, SchemaColumn } from "../types";
import { normalizeUserPath } from "../pathUtils";

/* -------------------- small CSV helpers -------------------- */

function escapeCsvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
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
  const cleaned = normalizeUserPath(userPath);
  const normalized = cleaned.replace(/\\/g, "/");
  const outPath = path.isAbsolute(normalized)
    ? normalized
    : path.join(process.cwd(), normalized.replace(/^[.\\/]+/, ""));
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  return outPath;
}

async function resolveOnly(userPath: string): Promise<string> {
  const cleaned = normalizeUserPath(userPath);
  const normalized = cleaned.replace(/\\/g, "/");
  return path.isAbsolute(normalized)
    ? normalized
    : path.join(process.cwd(), normalized.replace(/^[.\\/]+/, ""));
}

/* ---------------------- public API ------------------------- */

/** Infer schema from header row (names) and first data row (very light typing). */
export async function csvSchema(cfg: { path: string }): Promise<SchemaColumn[]> {
  const rows = [];
  for await (const row of csvReadStream(cfg)) {
    rows.push(row);
    if (rows.length >= 2) break;
  }
  if (!rows.length) return [];
  const header = Object.keys(rows[0]);
  const sample = rows[1] ? rows[1] : rows[0];
  return header.map((name) => {
    const v = sample[name];
    let type = "STRING";
    if (v !== undefined && v !== null && v !== "") {
      const str = String(v);
      if (/^-?\d+$/.test(str)) type = "INT";
      else if (/^-?\d+(\.\d+)?$/.test(str)) type = "FLOAT";
      else if (/^\d{4}-\d{2}-\d{2}/.test(str)) type = "DATE";
    }
    return { name, type };
  });
}

/** Async CSV row stream */
class CsvStreamParser {
  private header: string[] | null = null;
  private row: string[] = [];
  private cell = "";
  private inQuotes = false;

  push(chunk: string): string[][] {
    const rows: string[][] = [];
    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i];
      if (this.inQuotes) {
        if (ch === '"') {
          if (chunk[i + 1] === '"') {
            this.cell += '"';
            i += 1;
          } else {
            this.inQuotes = false;
          }
        } else {
          this.cell += ch;
        }
      } else {
        if (ch === '"') {
          this.inQuotes = true;
        } else if (ch === ",") {
          this.row.push(this.cell);
          this.cell = "";
        } else if (ch === "\r") {
          // ignore CR
        } else if (ch === "\n") {
          this.row.push(this.cell);
          rows.push(this.row);
          this.row = [];
          this.cell = "";
        } else {
          this.cell += ch;
        }
      }
    }
    return rows;
  }

  flush(): string[] | null {
    if (this.cell.length || this.row.length) {
      this.row.push(this.cell);
      this.cell = "";
      const result = this.row;
      this.row = [];
      return result;
    }
    return null;
  }

  getHeader(): string[] | null {
    return this.header;
  }

  setHeader(header: string[]) {
    this.header = header;
  }
}

export async function csvReadRows(cfg: { path: string }): Promise<Row[]> {
  const rows: Row[] = [];
  for await (const row of csvReadStream(cfg)) {
    rows.push(row);
  }
  return rows;
}

export async function* csvReadStream(cfg: { path: string }): AsyncGenerator<Row> {
  const p = await resolveOnly(cfg.path);
  let stream;
  try {
    // Increase buffer size for better throughput
    stream = createReadStream(p, { encoding: "utf8", highWaterMark: 1024 * 1024 }); // 1MB buffer (default 64KB)
  } catch (err) {
    const e = err as NodeJS.ErrnoException | undefined;
    if (e && e.code === "ENOENT") {
      return;
    }
    throw err;
  }
  const parser = new CsvStreamParser();
  let header: string[] | null = null;
  for await (const chunk of stream) {
    const rows = parser.push(chunk);
    for (const row of rows) {
      if (!header) {
        header = row;
        parser.setHeader(header);
        continue;
      }
      const obj: Row = {};
      header.forEach((h, i) => (obj[h] = row[i]));
      yield obj;
    }
  }
  const tailRow = parser.flush();
  if (tailRow && header) {
    const obj: Row = {};
    header.forEach((h, i) => (obj[h] = tailRow[i]));
    yield obj;
  }
}

type WriteOptions = { isCancelled?: () => boolean };

export async function csvWriteRows(cfg: { path: string }, rows: Row[], options?: WriteOptions): Promise<void> {
  const outPath = await ensureDirAndResolve(cfg.path);
  if (options?.isCancelled?.()) throw new Error("Run cancelled by user");

  if (!rows?.length) {
    // create/clear file so users see something
    await fs.writeFile(outPath, "", "utf8");
    return;
  }

  const header = Object.keys(rows[0]);
  const data: string[][] = [header];
  for (const row of rows) {
    if (options?.isCancelled?.()) throw new Error("Run cancelled by user");
    data.push(header.map((h) => row[h]));
  }
  await fs.writeFile(outPath, stringifyCsv(data), "utf8");
}
