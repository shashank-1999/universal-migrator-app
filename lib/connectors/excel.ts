import path from "path";
import fs from "fs";
import * as XLSX from "xlsx";
import { Row, SchemaColumn } from "../types";

const asAbs = (p: string) => path.resolve(process.cwd(), p);

export async function excelSchema(cfg: { path: string; sheet?: string; headerRow?: number }): Promise<SchemaColumn[]> {
  const wb = XLSX.readFile(asAbs(cfg.path));
  const ws = wb.Sheets[cfg.sheet || wb.SheetNames[0]];
  const rows: Row[] = XLSX.utils.sheet_to_json(ws, { defval: null });
  const first = rows[0] || {};
  return Object.keys(first).map((k) => ({ name: k, type: "STRING" }));
}

export async function excelReadRows(cfg: { path: string; sheet?: string }): Promise<Row[]> {
  const wb = XLSX.readFile(asAbs(cfg.path));
  const ws = wb.Sheets[cfg.sheet || wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: null });
}

export async function excelWriteRows(cfg: { path: string; sheet?: string }, rows: Row[]): Promise<void> {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const ws = XLSX.utils.json_to_sheet(rows, { header: cols });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, cfg.sheet || "Sheet1");
  fs.mkdirSync(path.dirname(asAbs(cfg.path)), { recursive: true });
  XLSX.writeFile(wb, asAbs(cfg.path));
}
