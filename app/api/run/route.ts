// app/api/run/route.ts
import { NextRequest, NextResponse } from "next/server";

// ---- Connectors (adjust paths/names if your files differ) ----
import { csvReadRows, csvWriteRows } from "@/lib/connectors/csv";
import { excelReadRows, excelWriteRows } from "@/lib/connectors/excel";
import { pgReadRows, pgWriteRows } from "@/lib/connectors/postgres";
import { mysqlReadRows, mysqlWriteRows } from "@/lib/connectors/mysql";
import { mssqlReadRows, mssqlWriteRows } from "@/lib/connectors/mssql";
import { oracleReadRows, oracleWriteRows } from "@/lib/connectors/oracle";
import { getWatermark, setWatermark, WatermarkValueType } from "@/lib/watermarks";
import { createRunWriter } from "@/lib/logs";
import { clearRun, isRunCancelled, registerRun } from "@/lib/runController";

// ---- Types ----
type DBType =
  | "csv"
  | "excel"
  | "postgres"
  | "mysql"
  | "mssql"
  | "oracle";

type Row = Record<string, any>;

type LoadMode = "full" | "incremental";

type RunPayload = {
  version: number;
  source: { dbType: DBType; config: any };
  destination: { dbType: DBType; config: any };
  runId?: string;
  mapping?: { from: string; to: string; cast?: CastType }[];
  options?: {
    truncateDest?: boolean; // if you add truncate logic for DBs
    batchSize?: number;     // for future batching
  };
  loadOptions?: {
    mode: LoadMode;
    incrementalColumn?: string;
    scheduleId?: string;
  };
};

type CastType = "STRING" | "NUMBER" | "BOOLEAN" | "DATE";

type RunSummary = {
  runId: string;
  status: "running" | "success" | "error";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  rowsRead?: number;
  rowsWritten?: number;
  rowsMoved?: number;
  outputUrl?: string;
  message?: string;
  error?: string;
  sourceType?: string;
  destinationType?: string;
  sourceTableName?: string;
  destinationTableName?: string;
  loadMode?: LoadMode;
  incrementalColumn?: string;
  scheduleId?: string;
};

// ---- Helpers ----

const CANCELED_ERROR_NAME = "RunCancelledError";

const describeConfig = (cfg: Record<string, any> | undefined) => {
  if (!cfg || typeof cfg !== "object") return undefined;
  const preferredKeys = ["table", "path", "sheet", "key", "blob", "container", "bucket", "file"];
  for (const key of preferredKeys) {
    const value = cfg[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
};

function castValue(v: any, cast?: CastType) {
  if (v == null || cast == null) return v;

  switch (cast) {
    case "STRING":
      return v == null ? null : String(v);
    case "NUMBER": {
      if (typeof v === "number") return v;
      const n = Number(v);
      return Number.isNaN(n) ? null : n;
    }
    case "BOOLEAN": {
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v !== 0;
      if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        if (["true", "t", "1", "yes", "y"].includes(s)) return true;
        if (["false", "f", "0", "no", "n"].includes(s)) return false;
      }
      return null;
    }
    case "DATE": {
      if (v instanceof Date) return v;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    default:
      return v;
  }
}

function applyMapping(rows: Row[], mapping?: RunPayload["mapping"]): Row[] {
  if (!rows.length) return rows;
  if (!mapping || !mapping.length) {
    // Auto-map (identity) if mapping is missing:
    // Keep row as-is; downstream destination will use the same column names.
    return rows;
  }

  // Build a function that maps one row to the destination schema
  return rows.map((r) => {
    const out: Row = {};
    for (const m of mapping) {
      const raw = r[m.from];
      out[m.to] = castValue(raw, m.cast);
    }
    return out;
  });
}

type Comparable =
  | { kind: "number"; value: number }
  | { kind: "date"; value: number }
  | { kind: "string"; value: string };

function classifyValue(raw: any): Comparable | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return { kind: "date", value: raw.getTime() };

  const asNumber = Number(raw);
  if (typeof raw === "number" || (!Number.isNaN(asNumber) && String(raw).trim() !== "")) {
    return { kind: "number", value: asNumber };
  }

  const asDate = Date.parse(raw);
  if (!Number.isNaN(asDate)) {
    return { kind: "date", value: asDate };
  }

  return { kind: "string", value: String(raw) };
}

function compareValues(a: Comparable, b: Comparable): number {
  if (a.kind === b.kind) {
    if (a.kind === "string") return a.value.localeCompare(b.value);
    return a.value - (b as any).value;
  }
  // fallback: compare as strings
  const av = a.kind === "string" ? a.value : String(a.value);
  const bv = b.kind === "string" ? b.value : String(b.value);
  return av.localeCompare(bv);
}

function stringifyComparable(c: Comparable): { type: WatermarkValueType; value: string } {
  switch (c.kind) {
    case "number":
      return { type: "number", value: String(c.value) };
    case "date":
      return { type: "date", value: new Date(c.value).toISOString() };
    default:
      return { type: "string", value: c.value };
  }
}

function parseStoredWatermark(type: WatermarkValueType, value: string): Comparable | null {
  switch (type) {
    case "number": {
      const n = Number(value);
      return Number.isNaN(n) ? null : { kind: "number", value: n };
    }
    case "date": {
      const ts = Date.parse(value);
      return Number.isNaN(ts) ? null : { kind: "date", value: ts };
    }
    default:
      return { kind: "string", value };
  }
}

type CancelCheck = { isCancelled?: () => boolean };

function mergeRowsOnColumn(base: Row[], updates: Row[], column: string, options?: CancelCheck): Row[] {
  const map = new Map<string, Row>();
  for (const row of base) {
    if (options?.isCancelled?.()) throw Object.assign(new Error("Run cancelled by user"), { name: CANCELED_ERROR_NAME });
    const key = row?.[column];
    if (key === null || key === undefined) continue;
    map.set(String(key), row);
  }
  for (const row of updates) {
    if (options?.isCancelled?.()) throw Object.assign(new Error("Run cancelled by user"), { name: CANCELED_ERROR_NAME });
    const key = row?.[column];
    if (key === null || key === undefined) continue;
    map.set(String(key), row);
  }
  return Array.from(map.values());
}

function filterRowsByWatermark(
  rows: Row[],
  column: string,
  watermark?: { type: WatermarkValueType; value: string },
  options?: CancelCheck
): { filtered: Row[]; highest?: Comparable } {
  const result: Row[] = [];
  let max: Comparable | undefined;
  const watermarkValue = watermark
    ? parseStoredWatermark(watermark.type, watermark.value)
    : undefined;

  for (const row of rows) {
    if (options?.isCancelled?.()) throw Object.assign(new Error("Run cancelled by user"), { name: CANCELED_ERROR_NAME });
    const classified = classifyValue(row?.[column]);
    if (!classified) continue;
    if (watermarkValue && compareValues(classified, watermarkValue) <= 0) {
      continue;
    }
    result.push(row);
    if (!max || compareValues(classified, max) > 0) {
      max = classified;
    }
  }
  return { filtered: result, highest: max };
}

// ---- Read/Write dispatchers ----

async function readFromSource(srcType: DBType, srcCfg: any): Promise<Row[]> {
  switch (srcType) {
    case "csv":
      return csvReadRows(srcCfg);
    case "excel":
      return excelReadRows(srcCfg);
    case "postgres":
      return pgReadRows(srcCfg);
    case "mysql":
      return mysqlReadRows(srcCfg);
    case "mssql":
      return mssqlReadRows(srcCfg);
    case "oracle":
      return oracleReadRows(srcCfg);
    default:
      throw new Error(`Unsupported source type: ${srcType}`);
  }
}

type WriteOptions = { isCancelled?: () => boolean };

async function writeToDestination(dstType: DBType, dstCfg: any, rows: Row[], options?: WriteOptions) {
  switch (dstType) {
    case "csv":
      // Expect dstCfg.path (e.g., ./data/output.csv)
      return csvWriteRows(dstCfg, rows, options);
    case "excel":
      // Expect dstCfg.path, optional dstCfg.sheet
      return excelWriteRows(dstCfg, rows, options);
    case "postgres":
      return pgWriteRows(dstCfg, rows, options);
    case "mysql":
      return mysqlWriteRows(dstCfg, rows, options);
    case "mssql":
      return mssqlWriteRows(dstCfg, rows, options);
    case "oracle":
      return oracleWriteRows(dstCfg, rows, options);
    default:
      throw new Error(`Unsupported destination type: ${dstType}`);
  }
}

async function readDestinationRows(dstType: DBType, dstCfg: any): Promise<Row[]> {
  try {
    return await readFromSource(dstType, dstCfg);
  } catch (err) {
    console.warn("[run] Failed to read destination for incremental merge:", err);
    return [];
  }
}

const DB_DEST_TYPES: DBType[] = ["postgres", "mysql", "mssql", "oracle"];

function needsExplicitTruncate(dstType: DBType) {
  return DB_DEST_TYPES.includes(dstType);
}

async function truncateDestination(dstType: DBType, dstCfg: any) {
  switch (dstType) {
    case "postgres": {
      const { pgTruncateTable } = await import("@/lib/connectors/postgres");
      return pgTruncateTable(dstCfg);
    }
    case "mysql": {
      const { mysqlTruncateTable } = await import("@/lib/connectors/mysql");
      return mysqlTruncateTable(dstCfg);
    }
    case "mssql": {
      const { mssqlTruncateTable } = await import("@/lib/connectors/mssql");
      return mssqlTruncateTable(dstCfg);
    }
    case "oracle": {
      const { oracleTruncateTable } = await import("@/lib/connectors/oracle");
      return oracleTruncateTable(dstCfg);
    }
    default:
      return;
  }
}

// ---- Route ----

export async function POST(req: NextRequest) {
  const body = (await req.json()) as RunPayload;
  const providedRunId = typeof body?.runId === "string" ? body.runId : undefined;
  const runId = providedRunId || `r_${Math.random().toString(36).slice(2, 10)}`;
  registerRun(runId);
  const startedAtMs = Date.now();
  let logger: Awaited<ReturnType<typeof createRunWriter>> | null = null;
  let summary: RunSummary = {
    runId,
    status: "running",
    startedAt: new Date(startedAtMs).toISOString(),
  };

  try {
    logger = await createRunWriter(runId);
    await logger.write({ ev: "RUN_START", runId });
    await logger.summary(summary);
  } catch (err) {
    console.warn("[/api/run] Unable to initialize run logger:", err);
  }

  const finalize = async (
    status: RunSummary["status"],
    extra?: Partial<Omit<RunSummary, "runId">>
  ) => {
    const endedAt = new Date();
    summary = {
      ...summary,
      status,
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAtMs,
      ...extra,
    };
    try {
      await logger?.summary(summary);
    } catch (err) {
      console.warn("[/api/run] Failed to persist run summary:", err);
    }
    clearRun(runId);
    return summary;
  };

  try {
    await logger?.write({ ev: "SPEC", spec: body });

    // Validate shape
    if (!body?.source?.dbType || !body?.destination?.dbType) {
      await finalize("error", { error: "Missing source/destination" });
      return NextResponse.json(
        { ok: false, message: "Missing source/destination", runId },
        { status: 400 }
      );
    }

    const srcType = body.source.dbType;
    const srcCfg = body.source.config || {};
    const dstType = body.destination.dbType;
    const dstCfg = body.destination.config || {};
    const mapping = body.mapping;
    const throwIfCancelled = () => {
      if (isRunCancelled(runId)) {
        const err = new Error("Run cancelled by user");
        err.name = CANCELED_ERROR_NAME;
        throw err;
      }
    };

    summary = {
      ...summary,
      sourceType: srcType,
      destinationType: dstType,
      sourceTableName: describeConfig(srcCfg),
      destinationTableName: describeConfig(dstCfg),
      loadMode: body.loadOptions?.mode,
      incrementalColumn: body.loadOptions?.incrementalColumn,
      scheduleId: body.loadOptions?.scheduleId,
    };
    await logger?.summary(summary);

    // 1) Read
    throwIfCancelled();
    const sourceRows = await readFromSource(srcType, srcCfg);
    throwIfCancelled();
    await logger?.write({ ev: "READ_COMPLETE", rows: sourceRows.length });

    // 2) If mapping missing, auto-map by identity using current row keys
    const mappedRows =
      mapping && mapping.length ? applyMapping(sourceRows, mapping) : sourceRows;

    const loadMode: LoadMode = body.loadOptions?.mode === "incremental" ? "incremental" : "full";
    const incrementalColumn = body.loadOptions?.incrementalColumn?.trim();
    let rowsForDestination = mappedRows;
    let reportedMoved = mappedRows.length;

    if (loadMode === "incremental") {
      if (!incrementalColumn) {
        throw new Error("Incremental column is required when loadOptions.mode is 'incremental'");
      }
      const watermarkRecord = body.loadOptions?.scheduleId
        ? getWatermark(body.loadOptions.scheduleId)
        : undefined;
      const { filtered, highest } = filterRowsByWatermark(
        mappedRows,
        incrementalColumn,
        watermarkRecord
          ? { type: watermarkRecord.type, value: watermarkRecord.value }
          : undefined,
        { isCancelled: () => isRunCancelled(runId) }
      );
      if (!filtered.length) {
        const message = `No new rows for incremental column '${incrementalColumn}'`;
        await logger?.write({ ev: "INCREMENTAL_NO_ROWS", incrementalColumn });
        await finalize("success", {
          rowsRead: sourceRows.length,
          rowsWritten: 0,
          rowsMoved: 0,
          message,
          outputUrl: undefined,
        });
        return NextResponse.json({
          ok: true,
          message,
          moved: 0,
          runId,
        });
      }
      reportedMoved = filtered.length;
      const existingRows = await readDestinationRows(dstType, dstCfg);
      rowsForDestination = mergeRowsOnColumn(existingRows, filtered, incrementalColumn, {
        isCancelled: () => isRunCancelled(runId),
      });

      if (body.loadOptions?.scheduleId && highest) {
        const payload = stringifyComparable(highest);
        setWatermark({
          scheduleId: body.loadOptions.scheduleId,
          incrementalColumn,
          type: payload.type,
          value: payload.value,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    // 3) Create table if requested
    if (dstCfg.createTable && ["postgres", "mysql", "mssql", "oracle"].includes(dstType)) {
      await logger?.write({ ev: "CREATE_TABLE", destination: dstType });
      // Infer schema from mapped rows
      const { inferSchema, generateCreateTableSQL } = await import("@/lib/schema");
      const schema = inferSchema(mappedRows);
      const createTableSQL = generateCreateTableSQL(
        dstCfg.table,
        schema,
        dstType as "postgres" | "mysql" | "mssql" | "oracle"
      );

      // Create table based on database type
      switch (dstType) {
        case "postgres":
          const { pgCreateTable } = await import("@/lib/connectors/postgres");
          await pgCreateTable(dstCfg, createTableSQL);
          break;
        case "mysql":
          const { mysqlCreateTable } = await import("@/lib/connectors/mysql");
          await mysqlCreateTable(dstCfg, createTableSQL);
          break;
        case "mssql":
          const { mssqlCreateTable } = await import("@/lib/connectors/mssql");
          await mssqlCreateTable(dstCfg, createTableSQL);
          break;
        case "oracle":
          const { oracleCreateTable } = await import("@/lib/connectors/oracle");
          await oracleCreateTable(dstCfg, createTableSQL);
          break;
      }
    }

    const shouldTruncateBeforeWrite =
      needsExplicitTruncate(dstType) && rowsForDestination.length && (loadMode === "full" || loadMode === "incremental");
    if (shouldTruncateBeforeWrite) {
      await logger?.write({ ev: "TRUNCATE_DESTINATION", destination: dstType });
      await truncateDestination(dstType, dstCfg);
    }

    // 4) Write data
    throwIfCancelled();
    const writeResult = await writeToDestination(dstType, dstCfg, rowsForDestination, {
      isCancelled: () => isRunCancelled(runId),
    });
    await logger?.write({ ev: "WRITE_COMPLETE", rows: rowsForDestination.length });

    // Optional: surface an output URL/path for file destinations
    let outputUrl: string | undefined;
    if ((dstType === "csv" || dstType === "excel") && dstCfg?.path) {
      // If you expose a static dir, you can convert path -> URL here.
      // For now we just echo the path back to the client.
      outputUrl = dstCfg.path;
    }

    const message = `Run complete: ${reportedMoved} rows moved ${srcType} → ${dstType}`;
    await finalize("success", {
      rowsRead: sourceRows.length,
      rowsWritten: rowsForDestination.length,
      rowsMoved: reportedMoved,
      outputUrl,
      message,
    });

    return NextResponse.json({
      ok: true,
      message,
      moved: reportedMoved,
      outputUrl,
      writeResult, // connector-specific details (e.g., rows written)
      runId,
    });
  } catch (e: any) {
    const message = e?.message || "Run failed";
    await logger?.write({
      ev: e?.name === CANCELED_ERROR_NAME ? "CANCELLED" : "ERROR",
      message,
      stack: e?.stack,
    });
    if (e?.name === CANCELED_ERROR_NAME) {
      await finalize("error", { error: message });
      return NextResponse.json(
        { ok: false, message, runId, cancelled: true },
        { status: 499 }
      );
    }
    await finalize("error", { error: message });
    console.error("[/api/run] error:", e);
    return NextResponse.json(
      { ok: false, message, runId },
      { status: 500 }
    );
  }
}
