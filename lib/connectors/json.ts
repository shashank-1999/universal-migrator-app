import { promises as fs } from "fs";
import path from "path";
import { Row, SchemaColumn } from "../types";
import { normalizeUserPath } from "../pathUtils";

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

async function readJsonFile(cfg: { path: string }): Promise<Row[]> {
  const resolved = await resolveOnly(cfg.path);
  let raw: string;
  try {
    raw = await fs.readFile(resolved, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException | undefined;
    if (e && e.code === "ENOENT") {
      throw new Error(`JSON read failed: file not found at ${cfg.path}`);
    }
    throw err;
  }
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => (typeof item === "object" && item !== null ? item : { value: item }));
    }
    if (typeof parsed === "object" && parsed !== null) {
      return [parsed];
    }
    return [{ value: parsed }];
  } catch (jsonErr) {
    // Try NDJSON (one JSON object per line)
    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length);
    const rows: Row[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        rows.push(typeof parsed === "object" && parsed !== null ? parsed : { value: parsed });
      } catch {
        // ignore invalid line
      }
    }
    return rows;
  }
}

function inferJsonType(value: unknown): string {
  if (value === null || value === undefined) return "STRING";
  switch (typeof value) {
    case "number":
      return Number.isInteger(value) ? "INTEGER" : "FLOAT";
    case "boolean":
      return "BOOLEAN";
    case "string":
      if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "DATE";
      return "STRING";
    default:
      return "STRING";
  }
}

export async function jsonSchema(cfg: { path: string }): Promise<SchemaColumn[]> {
  try {
    const rows = await readJsonFile(cfg);
    if (!rows.length) return [];
    const first = rows[0];
    return Object.keys(first).map((key) => ({
      name: key,
      type: inferJsonType(first[key]),
    }));
  } catch (err) {
    return [];
  }
}

export async function jsonReadRows(cfg: { path: string }): Promise<Row[]> {
  return readJsonFile(cfg);
}

/** Stream JSON file (supports NDJSON format for large files) */
type StreamOptions = { isCancelled?: () => boolean };

export async function jsonReadStream(
  cfg: { path: string },
  options?: StreamOptions
): Promise<AsyncGenerator<Row>> {
  const resolved = await resolveOnly(cfg.path);
  const fsSync = await import("fs");
  const readline = await import("readline");
  
  return (async function* () {
    const fileStream = fsSync.createReadStream(resolved, { encoding: "utf8" });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let isNDJSON = false;
    let firstLine = true;
    let buffer = "";
    
    try {
      for await (const line of rl) {
        if (options?.isCancelled?.()) {
          fileStream.destroy();
          break;
        }
        
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        if (firstLine) {
          // Detect format: if first line starts with '[' or '{' alone, it's JSON array/object
          // Otherwise assume NDJSON
          firstLine = false;
          if (trimmed === '[' || trimmed === '{') {
            isNDJSON = false;
            buffer = trimmed + "\n";
            continue;
          } else {
            isNDJSON = true;
          }
        }
        
        if (isNDJSON) {
          // NDJSON: one JSON object per line
          try {
            const parsed = JSON.parse(trimmed);
            yield typeof parsed === "object" && parsed !== null ? parsed : { value: parsed };
          } catch {
            // Skip invalid lines
          }
        } else {
          // Regular JSON: accumulate entire file (falls back to non-streaming)
          buffer += line + "\n";
        }
      }
      
      // If it was regular JSON, parse the accumulated buffer
      if (!isNDJSON && buffer) {
        try {
          const parsed = JSON.parse(buffer);
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          for (const row of rows) {
            if (options?.isCancelled?.()) break;
            yield typeof row === "object" && row !== null ? row : { value: row };
          }
        } catch {
          // Ignore parse errors
        }
      }
    } finally {
      fileStream.destroy();
    }
  })();
}

type WriteOptions = { isCancelled?: () => boolean };

export async function jsonWriteRows(
  cfg: { path: string },
  rows: Row[],
  options?: WriteOptions
): Promise<void> {
  const outPath = await ensureDirAndResolve(cfg.path);
  if (options?.isCancelled?.()) throw new Error("Run cancelled by user");
  const payload = rows.map((row) => {
    if (options?.isCancelled?.()) throw new Error("Run cancelled by user");
    return row;
  });
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
}
