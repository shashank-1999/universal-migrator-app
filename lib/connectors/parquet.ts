import { promises as fs } from "fs";
import path from "path";
import { Row, SchemaColumn } from "../types";
import { normalizeUserPath } from "../pathUtils";
import { ParquetReader, ParquetSchema, ParquetWriter } from "parquetjs-lite";

const resolveOnly = async (userPath: string): Promise<string> => {
  const cleaned = normalizeUserPath(userPath);
  const normalized = cleaned.replace(/\\/g, "/");
  return path.isAbsolute(normalized)
    ? normalized
    : path.join(process.cwd(), normalized.replace(/^[.\\/]+/, ""));
};

const ensureDirAndResolve = async (userPath: string): Promise<string> => {
  const resolved = await resolveOnly(userPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  return resolved;
};

async function readParquetFile(cfg: { path: string }): Promise<Row[]> {
  const resolved = await resolveOnly(cfg.path);
  const reader = await ParquetReader.openFile(resolved);
  try {
    const cursor = reader.getCursor();
    const rows: Row[] = [];
    let record = await cursor.next();
    while (record) {
      rows.push(record);
      record = await cursor.next();
    }
    return rows;
  } finally {
    await reader.close();
  }
}

export async function parquetSchema(cfg: { path: string }): Promise<SchemaColumn[]> {
  try {
    const resolved = await resolveOnly(cfg.path);
    const reader = await ParquetReader.openFile(resolved);
    try {
      return Object.keys(reader.schema.fields).map((name) => ({
        name,
        type: reader.schema.fields[name]?.primitiveType || "UNKNOWN",
      }));
    } finally {
      await reader.close();
    }
  } catch {
    return [];
  }
}

export async function parquetReadRows(cfg: { path: string }): Promise<Row[]> {
  return readParquetFile(cfg);
}

type WriteOptions = { isCancelled?: () => boolean };

export async function parquetWriteRows(
  cfg: { path: string },
  rows: Row[],
  options?: WriteOptions
): Promise<void> {
  const outPath = await ensureDirAndResolve(cfg.path);
  if (options?.isCancelled?.()) throw new Error("Run cancelled by user");
  if (!rows.length) {
    await fs.writeFile(outPath, "", "utf8");
    return;
  }
  const schemaDesc: Record<string, { type: "UTF8" }> = {};
  Object.keys(rows[0]).forEach((col) => {
    schemaDesc[col] = { type: "UTF8" };
  });
  const schema = new ParquetSchema(schemaDesc);
  const writer = await ParquetWriter.openFile(schema, outPath);
  try {
    for (const row of rows) {
      if (options?.isCancelled?.()) throw new Error("Run cancelled by user");
      const normalized: Record<string, string> = {};
      Object.keys(schemaDesc).forEach((col) => {
        const value = row[col];
        normalized[col] = value == null ? "" : String(value);
      });
      await writer.appendRow(normalized);
    }
  } finally {
    await writer.close();
  }
}
