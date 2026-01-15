import { PassThrough } from "stream";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { Row } from "./types";
import { ParquetSchema, ParquetReader, ParquetWriter } from "parquetjs-lite";

export type StorageFormat = "csv" | "parquet" | "binary";

export async function serializeRows(rows: Row[], format: StorageFormat = "csv") {
  if (format === "parquet") {
    if (!rows.length) {
      return { buffer: Buffer.alloc(0), contentType: "application/octet-stream" };
    }
    const schemaDesc: Record<string, { type: "UTF8" }> = {};
    Object.keys(rows[0]).forEach((col) => {
      schemaDesc[col] = { type: "UTF8" };
    });
    const schema = new ParquetSchema(schemaDesc);
    const chunks: Buffer[] = [];
    const writerStream = new PassThrough();
    writerStream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    const writer = await ParquetWriter.openStream(schema, writerStream);
    for (const row of rows) {
      const normalized: Record<string, string> = {};
      Object.keys(schemaDesc).forEach((col) => {
        const value = row[col];
        normalized[col] = value == null ? "" : String(value);
      });
      await writer.appendRow(normalized);
    }
    await writer.close();
    writerStream.end();
    return { buffer: Buffer.concat(chunks), contentType: "application/octet-stream" };
  }

  const cols = rows.length ? Object.keys(rows[0]) : [];
  const csv = stringify(rows, { header: true, columns: cols });
  return { buffer: Buffer.from(csv, "utf8"), contentType: "text/csv" };
}

async function parseParquet(buffer: Buffer) {
  if (!buffer.length) return [];
const reader = await ParquetReader.openBuffer(buffer);
  const cursor = reader.getCursor();
  const rows: Row[] = [];
  let record = await cursor.next();
  while (record) {
    rows.push(record);
    record = await cursor.next();
  }
  await reader.close();
  return rows;
}

export async function parseRows(
  buffer: Buffer,
  format: StorageFormat = "csv"
): Promise<Row[]> {
  if (format === "parquet") {
    try {
      return await parseParquet(buffer);
    } catch (err) {
      // fallback to csv if the parquet read fails
      console.warn("[objectStorage] parquet parse failed, falling back to CSV", err);
      format = "csv";
    }
  }

  const text = buffer.toString("utf8");
  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });
}

export function detectFormatFromBuffer(buffer: Buffer): StorageFormat {
  if (buffer.length >= 4 && buffer.slice(0, 4).toString() === "PAR1") {
    return "parquet";
  }

  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    // ZIP-based files (XLSX, ODS, DOCX, etc.) are binary.
    return "binary";
  }

  const preview = buffer.toString("utf8", 0, Math.min(buffer.length, 2048));
  const hasControlChars = /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(preview);
  const isPrintableAscii = /^[\t\n\r\x20-\x7e]+$/.test(preview);

  if (hasControlChars && !isPrintableAscii) {
    return "binary";
  }

  if (isPrintableAscii) {
    return "csv";
  }

  return "binary";
}

export async function readStructuredOrBinary(
  buffer: Buffer,
  hint?: StorageFormat
): Promise<{ format: StorageFormat; rows: Row[] }> {
  const format = hint && hint !== "binary" ? hint : detectFormatFromBuffer(buffer);
  if (format === "binary") {
    return { format, rows: [] };
  }
  try {
    const rows = await parseRows(buffer, format);
    return { format, rows };
  } catch {
    return { format: "binary", rows: [] };
  }
}
