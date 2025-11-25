import path from "path";
import fs from "fs";
import * as XLSX from "xlsx";
import { Row, SchemaColumn } from "../types";
import { normalizeUserPath } from "../pathUtils";

// In ESM builds, xlsx does not auto-load fs; wire it explicitly.
if (typeof XLSX.set_fs === "function") {
  XLSX.set_fs(fs);
}

const asAbs = (p: string) => path.resolve(process.cwd(), normalizeUserPath(p));

function pickSheetName(wb: XLSX.WorkBook, desired?: string): string {
  if (!desired) return wb.SheetNames[0];
  const trimmed = desired.trim();
  if (!trimmed) return wb.SheetNames[0];

  const exact = wb.SheetNames.find((name) => name === trimmed);
  if (exact) return exact;

  const ci = wb.SheetNames.find((name) => name.toLowerCase() === trimmed.toLowerCase());
  if (ci) return ci;

  return trimmed; // return original so caller can report the missing name
}

function ensureSheet(wb: XLSX.WorkBook, desired?: string) {
  const sheetName = pickSheetName(wb, desired);
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    const available = wb.SheetNames.join(", ") || "(no sheets)";
    throw new Error(`Excel: sheet '${sheetName}' not found. Available sheets: ${available}`);
  }
  return { sheetName, ws };
}

export async function excelSchema(cfg: { path: string; sheet?: string; headerRow?: number }): Promise<SchemaColumn[]> {
  const filePath = asAbs(cfg.path);
  if (!fs.existsSync(filePath)) {
    // Destination Excel may not exist yet; returning empty schema lets UI auto-map later.
    return [];
  }

  const wb = XLSX.readFile(filePath);
  const { ws } = ensureSheet(wb, cfg.sheet);
  const rows: Row[] = XLSX.utils.sheet_to_json(ws, { defval: null });
  const first = rows[0] || {};
  return Object.keys(first).map((k) => ({ name: k, type: "STRING" }));
}

export async function excelReadRows(cfg: { path: string; sheet?: string }): Promise<Row[]> {
  const wb = XLSX.readFile(asAbs(cfg.path));
  const { ws } = ensureSheet(wb, cfg.sheet);
  return XLSX.utils.sheet_to_json(ws, { defval: null });
}

type WriteOptions = { isCancelled?: () => boolean };

export async function excelWriteRows(cfg: { path: string; sheet?: string }, rows: Row[], options?: WriteOptions): Promise<void> {
  if (options?.isCancelled?.()) throw new Error("Run cancelled by user");
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const safeRows = options?.isCancelled
    ? rows.reduce<Row[]>((acc, row) => {
        if (options.isCancelled?.()) throw new Error("Run cancelled by user");
        acc.push(row);
        return acc;
      }, [])
    : rows;
  const ws = XLSX.utils.json_to_sheet(safeRows, { header: cols });
  const wb = XLSX.utils.book_new();
  const sheetName = cfg.sheet && cfg.sheet.trim() ? cfg.sheet : "Sheet1";
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  fs.mkdirSync(path.dirname(asAbs(cfg.path)), { recursive: true });
  XLSX.writeFile(wb, asAbs(cfg.path));
}
