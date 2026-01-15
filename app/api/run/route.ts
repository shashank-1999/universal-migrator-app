// app/api/run/route.ts
import { NextRequest, NextResponse } from "next/server";
import { Client as PgClient } from "pg";
import { Connection as MysqlConnection } from "mysql2/promise";

// ---- Connectors (adjust paths/names if your files differ) ----
import { csvReadRows, csvReadStream, csvWriteRows } from "@/lib/connectors/csv";
import { excelReadRows, excelWriteRows } from "@/lib/connectors/excel";
import { pgReadRows, pgReadStream, pgWriteRows } from "@/lib/connectors/postgres";
import { mysqlReadRows, mysqlReadStream, mysqlWriteRows, mysqlLoadCsvFile } from "@/lib/connectors/mysql";
import { mssqlReadRows, mssqlReadStream, mssqlWriteRows } from "@/lib/connectors/mssql";
import { oracleReadRows, oracleReadStream, oracleWriteRows } from "@/lib/connectors/oracle";
import { s3ReadRows, s3WriteRows, minioReadRows, minioWriteRows } from "@/lib/connectors/s3";
import { gcsReadRows, gcsWriteRows } from "@/lib/connectors/gcs";
import { azureBlobReadRows, azureBlobWriteRows } from "@/lib/connectors/azureBlob";
import { jsonReadRows, jsonWriteRows } from "@/lib/connectors/json";
import { parquetReadRows, parquetWriteRows } from "@/lib/connectors/parquet";
import { buildStagesFromSpec, SavedSpec } from "@/lib/specPlanner";
import { getWatermark, setWatermark, WatermarkValueType } from "@/lib/watermarks";
import { createRunWriter } from "@/lib/logs";
import { runPythonTransform } from "@/lib/scriptRunner";
import { clearRun, isRunCancelled, registerRun } from "@/lib/runController";
import type { DbTypeForSchema } from "@/lib/schema";
import type {
  ColumnMapping,
  TransformFilter,
  CastType,
  ComparisonOperator,
} from "@/lib/types";

// ---- Types ----
type DBType =
  | "csv"
  | "excel"
  | "json"
  | "parquet"
  | "postgres"
  | "mysql"
  | "mssql"
  | "oracle"
  | "s3"
  | "minio"
  | "gcs"
  | "azureBlob";

type Row = Record<string, unknown>;

type LoadMode = "full" | "incremental" | "merge";

type RunPayload = {
  version: number;
  source: { dbType: DBType; config: Record<string, unknown> };
  destination: { dbType: DBType; config: Record<string, unknown> };
  runId?: string;
  mapping?: ColumnMapping[];
  filters?: TransformFilter[];
  options?: {
    truncateDest?: boolean;
    batchSize?: number;
  };
  loadOptions?: {
    mode: LoadMode;
    incrementalColumn?: string;
    scheduleId?: string;
  };
  audit?: AuditContext;
};

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

type DdlFriendlyDb = "postgres" | "mysql" | "mssql" | "oracle";

type AuditContext = {
  workflowOwner?: string;
  workflowName?: string;
  addAuditColumns?: boolean;
};

type StageSpec = {
  id: string;
  fromNodeId?: string;
  toNodeId?: string;
  source: { dbType: DBType; config: Record<string, unknown> };
  destination: { dbType: DBType; config: Record<string, unknown> };
  mapping?: ColumnMapping[];
  filters?: TransformFilter[];
  script?: { language?: string; code?: string; timeoutMs?: number };
  auditContext?: AuditContext;
  isIdentity?: boolean;
};

type MultiStagePayload = {
  version?: number;
  stages: StageSpec[];
  runId?: string;
  audit?: AuditContext;
};

// ---- Helpers ----

const CANCELED_ERROR_NAME = "RunCancelledError";

const describeConfig = (cfg: Record<string, unknown> | undefined) => {
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

function evaluateComparison(value: unknown, operator: ComparisonOperator, target?: string) {
  const strValue = value == null ? "" : String(value);
  const targetValue = target ?? "";
  switch (operator) {
    case "equals":
      return strValue === targetValue;
    case "notEquals":
      return strValue !== targetValue;
    case "contains":
      return strValue.includes(targetValue);
    case "startsWith":
      return strValue.startsWith(targetValue);
    case "endsWith":
      return strValue.endsWith(targetValue);
    case "greaterThan": {
      const a = Number(value);
      const b = Number(targetValue);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return a > b;
    }
    case "lessThan": {
      const a = Number(value);
      const b = Number(targetValue);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return a < b;
    }
    case "isEmpty":
      return strValue.trim().length === 0;
    case "isNotEmpty":
      return strValue.trim().length > 0;
    default:
      return false;
  }
}

function castValue(v: unknown, cast?: CastType) {
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
      const d = new Date(String(v));
      return Number.isNaN(d.getTime()) ? null : d;
    }
    default:
      return v;
  }
}

function rowMatchesFilters(row: Row, filters?: TransformFilter[]): boolean {
  if (!filters || !filters.length) return true;
  for (const rule of filters) {
    const comparisonValue = row[rule.field];
    const match = evaluateComparison(comparisonValue, rule.operator, rule.value);
    if (rule.action === "keep" && !match) return false;
    if (rule.action === "discard" && match) return false;
  }
  return true;
}

function applyFilters(rows: Row[], filters?: TransformFilter[]): Row[] {
  if (!filters || !filters.length) return rows;
  return rows.filter((row) => rowMatchesFilters(row, filters));
}

function mapRow(row: Row, mapping?: ColumnMapping[]): Row {
  if (!mapping || !mapping.length) {
    return row;
  }
  const out: Row = {};
  for (const m of mapping) {
    let raw: unknown;
    if (m.concat && Array.isArray(m.concat.sources) && m.concat.sources.length) {
      const separator = m.concat.separator ?? "";
      raw = m.concat.sources.map((source) => row[source] ?? "").join(separator);
    } else {
      raw = row[m.from];
    }

    if (m.split && raw != null) {
      const delimiter = m.split.delimiter ?? "";
      const parts = String(raw).split(delimiter);
      raw = parts[m.split.partIndex] ?? "";
    }

    if (m.condition) {
      const comparisonField =
        m.condition.field && m.condition.field in row ? m.condition.field : m.from;
      const comparisonValue = row[comparisonField];
      const matches = evaluateComparison(comparisonValue, m.condition.operator, m.condition.value);
      if (matches && m.condition.thenValue !== undefined) {
        raw = m.condition.thenValue;
      } else if (!matches && m.condition.elseValue !== undefined) {
        raw = m.condition.elseValue;
      }
    }

    if (m.trim && typeof raw === "string") {
      raw = raw.trim();
    }
    out[m.to] = castValue(raw, m.cast);
  }
  return out;
}

function applyMapping(rows: Row[], mapping?: ColumnMapping[]): Row[] {
  if (!rows.length) return rows;
  return rows.map((row) => mapRow(row, mapping));
}

type Comparable =
  | { kind: "number"; value: number }
  | { kind: "date"; value: number }
  | { kind: "string"; value: string };

function classifyValue(raw: unknown): Comparable | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return { kind: "date", value: raw.getTime() };

  const asNumber = Number(raw);
  if (typeof raw === "number" || (!Number.isNaN(asNumber) && String(raw).trim() !== "")) {
    return { kind: "number", value: asNumber };
  }

  const asDate = Date.parse(String(raw));
  if (!Number.isNaN(asDate)) {
    return { kind: "date", value: asDate };
  }

  return { kind: "string", value: String(raw) };
}

function compareValues(a: Comparable, b: Comparable): number {
  if (a.kind === b.kind) {
    if (a.kind === "string") {
      return a.value.localeCompare((b as Extract<Comparable, { kind: "string" }>).value);
    }
    return a.value - (b as Extract<Comparable, { kind: "number" | "date" }>).value;
  }
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

type SourceReadResult = { rows?: Row[]; stream?: AsyncGenerator<Row> };
// Optional total rows hint (e.g., from COUNT(*)) to improve progress reporting
type SourceReadResultWithTotal = SourceReadResult & { total?: number };

async function countPgRows(cfg: any): Promise<number | undefined> {
  if (cfg.query || cfg.customQuery) return undefined;
  if (!cfg.table) return undefined;
  try {
    const { Client } = await import("pg");
    const client = new Client({
      host: cfg.host,
      port: cfg.port ? Number(cfg.port) : 5432,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();
    try {
      const sch = cfg.schema || "public";
      const r = await client.query(`SELECT COUNT(*) as cnt FROM "${sch}"."${cfg.table}"`);
      return Number(r.rows?.[0]?.cnt ?? 0);
    } finally {
      await client.end().catch(() => {});
    }
  } catch {
    return undefined;
  }
}

async function countMysqlRows(cfg: any): Promise<number | undefined> {
  if (cfg.query) return undefined;
  if (!cfg.table) return undefined;
  try {
    const mysql = await import("mysql2/promise");
    const conn = await mysql.createConnection({
      host: cfg.host,
      port: cfg.port ? Number(cfg.port) : 3306,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      connectTimeout: 30_000,
    });
    try {
      const sql = `SELECT COUNT(*) as cnt FROM \`${cfg.database}\`.\`${cfg.table}\``;
      const [rows] = await conn.query(sql);
      return Number((rows as any)?.[0]?.cnt ?? 0);
    } finally {
      await conn.end().catch(() => {});
    }
  } catch {
    return undefined;
  }
}

async function countOracleRows(cfg: any): Promise<number | undefined> {
  if (!cfg.table) return undefined;
  try {
    const oracledb = (await import("oracledb")).default;
    const port = cfg.port ? String(cfg.port) : "1521";
    const connectString = `${cfg.host}:${port}/${cfg.service}`;
    const conn = await oracledb.getConnection({
      user: cfg.user,
      password: cfg.password,
      connectString,
    });
    try {
      const res = await conn.execute(`SELECT COUNT(*) AS cnt FROM ${cfg.table}`);
      const count = (res.rows?.[0] as any)?.[0];
      return typeof count === "number" ? count : Number(count ?? 0);
    } finally {
      await conn.close().catch(() => {});
    }
  } catch {
    return undefined;
  }
}

// Best-effort CSV row counter (header excluded). Returns undefined on failure.
async function countCsvRows(filePath: string): Promise<number | undefined> {
  try {
    const fs = await import("fs");
    const path = await import("path");
    const cleaned = filePath.replace(/\\/g, "/");
    const resolved = path.isAbsolute(cleaned)
      ? cleaned
      : path.join(process.cwd(), cleaned.replace(/^[.\\/]+/, ""));
    const stream = fs.createReadStream(resolved, { encoding: "utf8" });
    let lines = 0;
    for await (const chunk of stream) {
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] === "\n") lines += 1;
      }
    }
    return lines > 0 ? lines - 1 : 0;
  } catch {
    return undefined;
  }
}

async function collectRows(result: SourceReadResult): Promise<Row[]> {
  if (result.rows) return result.rows;
  if (!result.stream) return [];
  const out: Row[] = [];
  for await (const row of result.stream) {
    out.push(row);
  }
  return out;
}

async function readFromSource(
  srcType: DBType,
  srcCfg: Record<string, unknown>,
  cancelCheck?: () => boolean
): Promise<SourceReadResultWithTotal> {
  switch (srcType) {
    case "csv":
      return {
        stream: csvReadStream(srcCfg as Parameters<typeof csvReadStream>[0]),
        total: await countCsvRows(String((srcCfg as any).path || "")),
      };
    case "excel":
      return { rows: await excelReadRows(srcCfg as Parameters<typeof excelReadRows>[0]) };
    case "json":
      return { rows: await jsonReadRows(srcCfg as Parameters<typeof jsonReadRows>[0]) };
    case "parquet":
      return { rows: await parquetReadRows(srcCfg as Parameters<typeof parquetReadRows>[0]) };
    case "postgres": {
      const cfg = srcCfg as Parameters<typeof pgReadRows>[0];
      const total = await (async () => {
        try {
          return await Promise.race<number | undefined>([
            countPgRows(cfg),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
          ]);
        } catch {
          return undefined;
        }
      })();
      try {
        const stream = await pgReadStream(cfg, { isCancelled: cancelCheck });
        console.log("[run] Postgres using streaming mode for optimal performance");
        return { stream, total };
      } catch (err) {
        console.warn("[run] Postgres stream failed, falling back to buffered read:", err);
        const rows = await pgReadRows(cfg);
        return { rows, total };
      }
    }
    case "mysql": {
      const cfg = srcCfg as Parameters<typeof mysqlReadRows>[0];
      const total = await (async () => {
        try {
          return await Promise.race<number | undefined>([
            countMysqlRows(cfg),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
          ]);
        } catch {
          return undefined;
        }
      })();
      try {
        const stream = await mysqlReadStream(cfg, { isCancelled: cancelCheck });
        console.log("[run] MySQL using streaming mode for optimal performance");
        return { stream, total };
      } catch (err) {
        console.warn("[run] MySQL stream failed, falling back to buffered read:", err);
        const rows = await mysqlReadRows(cfg);
        return { rows, total };
      }
    }
    case "mssql": {
      const cfg = srcCfg as Parameters<typeof mssqlReadRows>[0];

      // Best-effort total count (non-blocking)
      const total = await (async () => {
        try {
          const { mssqlCountRows } = await import("@/lib/connectors/mssql");
          return await Promise.race<number | undefined>([
            mssqlCountRows(cfg),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
          ]);
        } catch {
          return undefined;
        }
      })();

      // Prefer streaming to avoid buffering tens of millions of rows in memory.
      try {
        const stream = await mssqlReadStream(cfg, { isCancelled: cancelCheck });
        console.log("[run] MSSQL using streaming mode for optimal performance");
        return { stream, total };
      } catch (err) {
        console.warn("[run] MSSQL stream failed, falling back to buffered read:", err);
        const rows = await mssqlReadRows(cfg);
        return { rows, total };
      }
    }
    case "oracle": {
      const cfg = srcCfg as Parameters<typeof oracleReadRows>[0];
      const total = await (async () => {
        try {
          return await Promise.race<number | undefined>([
            countOracleRows(cfg),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
          ]);
        } catch {
          return undefined;
        }
      })();
      try {
        const stream = await oracleReadStream(cfg, { isCancelled: cancelCheck });
        console.log("[run] Oracle using streaming mode for optimal performance");
        return { stream, total };
      } catch (err) {
        console.warn("[run] Oracle stream failed, falling back to buffered read:", err);
        const rows = await oracleReadRows(cfg);
        return { rows, total };
      }
    }
    case "s3":
      return { rows: await s3ReadRows(srcCfg as Parameters<typeof s3ReadRows>[0]) };
    case "minio":
      return { rows: await minioReadRows(srcCfg as Parameters<typeof minioReadRows>[0]) };
    case "gcs":
      return { rows: await gcsReadRows(srcCfg as Parameters<typeof gcsReadRows>[0]) };
    case "azureBlob":
      return { rows: await azureBlobReadRows(srcCfg as Parameters<typeof azureBlobReadRows>[0]) };
    default:
      throw new Error(`Unsupported source type: ${srcType}`);
  }
}

type WriteOptions = { 
  isCancelled?: () => boolean; 
  onProgress?: (written: number) => void;
  client?: any; // Persistent database connection (single)
  pgClients?: any[]; // Persistent Postgres connection pool
  mysqlPool?: any; // Persistent MySQL connection pool
  mssqlPool?: any; // Persistent MSSQL connection pool
  oracleConnections?: any[]; // Persistent Oracle connection pool
  skipIndexManagement?: boolean; // Skip index management for batch operations
  poolSize?: number; // Number of parallel writer connections
};

async function writeToDestination(dstType: DBType, dstCfg: Record<string, unknown>, rows: Row[], options?: WriteOptions) {
  switch (dstType) {
    case "csv":
      return csvWriteRows(dstCfg as Parameters<typeof csvWriteRows>[0], rows, options);
    case "excel":
      return excelWriteRows(dstCfg as Parameters<typeof excelWriteRows>[0], rows, options);
    case "json":
      return jsonWriteRows(dstCfg as Parameters<typeof jsonWriteRows>[0], rows, options);
    case "parquet":
      return parquetWriteRows(dstCfg as Parameters<typeof parquetWriteRows>[0], rows, options);
    case "postgres":
      return pgWriteRows(dstCfg as Parameters<typeof pgWriteRows>[0], rows, options);
    case "mysql":
      return mysqlWriteRows(dstCfg as Parameters<typeof mysqlWriteRows>[0], rows, options);
    case "mssql":
      return mssqlWriteRows(dstCfg as Parameters<typeof mssqlWriteRows>[0], rows, options);
    case "oracle":
      return oracleWriteRows(dstCfg as Parameters<typeof oracleWriteRows>[0], rows, options);
    case "s3":
      return s3WriteRows(dstCfg as Parameters<typeof s3WriteRows>[0], rows, options);
    case "minio":
      return minioWriteRows(dstCfg as Parameters<typeof minioWriteRows>[0], rows, options);
    case "gcs":
      return gcsWriteRows(dstCfg as Parameters<typeof gcsWriteRows>[0], rows, options);
    case "azureBlob":
      return azureBlobWriteRows(dstCfg as Parameters<typeof azureBlobWriteRows>[0], rows, options);
    default:
      throw new Error(`Unsupported destination type: ${dstType}`);
  }
}

async function readDestinationRows(
  dstType: DBType,
  dstCfg: Record<string, unknown>,
  cancelCheck?: () => boolean
): Promise<Row[]> {
  try {
    const result = await readFromSource(dstType, dstCfg, cancelCheck);
    return await collectRows(result);
  } catch (err) {
    console.warn("[run] Failed to read destination for incremental merge:", err);
    return [];
  }
}

type StreamWriteParams = {
  generator: AsyncGenerator<Row>;
  filters?: TransformFilter[];
  mapping?: ColumnMapping[];
  destType: DBType;
  destConfig: Record<string, unknown>;
  logger: Awaited<ReturnType<typeof createRunWriter>> | null;
  runId: string;
  stageId?: string | null;
  auditContext?: AuditContext;
  batchSize?: number;
  totalRows?: number;
};

async function streamAndWriteRows(params: StreamWriteParams): Promise<{ rowsRead: number; rowsWritten: number }> {
  const {
    generator,
    filters,
    mapping,
    destType,
    destConfig,
    logger,
    runId,
    stageId,
    auditContext,
    totalRows,
  } = params;

  // Use a consistent batch size across DB destinations (align with MySQL settings)
  const defaultBatchSize = 50000;
  const batchSize = params.batchSize && params.batchSize > 1 ? Math.floor(params.batchSize) : defaultBatchSize;
  const sampleLimit = 10;

  let rowsRead = 0;
  let rowsWritten = 0;

  // ✅ FIX: keep rowsTotal constant (or null) during PROGRESS.
  const rowsTotalForProgress: number | null = typeof totalRows === "number" ? totalRows : null;

  let batch: Row[] = [];
  const sampleRows: Row[] = [];
  let tableEnsured = false;

  // Create persistent connection pools to avoid connection overhead
  let pgClients: PgClient[] | undefined;
  let mysqlPool: any | undefined;
  let mssqlPool: any | undefined;
  let oracleConnections: any[] | undefined;
  
  if (destType === "postgres") {
    const cfg = destConfig as any;
    const poolSize = 8;
    pgClients = [];
    for (let i = 0; i < poolSize; i++) {
      const client = new PgClient({
        host: cfg.host,
        port: cfg.port ? Number(cfg.port) : 5432,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
      });
      await client.connect();
      pgClients.push(client);
    }
  } else if (destType === "mysql") {
    const mysql = await import("mysql2/promise");
    const cfg = destConfig as any;
    mysqlPool = mysql.createPool({
      host: cfg.host,
      port: cfg.port ? Number(cfg.port) : 3306,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      waitForConnections: true,
      connectionLimit: 8,
      connectTimeout: 30_000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
    });
    
    // Handle index management once at start
    const conn = await mysql.createConnection({
      host: cfg.host,
      port: cfg.port ? Number(cfg.port) : 3306,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      connectTimeout: 30_000,
    });
    try {
      // Disable checks and drop indexes once at start
      await conn.query(`SET SESSION foreign_key_checks=0, SESSION unique_checks=0`);
    } catch (err) {
      console.warn("[run] Failed to disable MySQL checks:", err);
    } finally {
      await conn.end();
    }
  } else if (destType === "mssql") {
    const sql = await import("mssql");
    const cfg = destConfig as any;
    mssqlPool = new sql.ConnectionPool({
      server: cfg.server || cfg.host,
      port: cfg.port ? Number(cfg.port) : 1433,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      options: {
        encrypt: cfg.encrypt ?? false,
        trustServerCertificate: cfg.trustServerCertificate ?? true,
      },
      pool: {
        max: 8,
        min: 0,
        idleTimeoutMillis: 30000,
      },
    });
    await mssqlPool.connect();
  } else if (destType === "oracle") {
    const oracledb = (await import("oracledb")).default;
    const cfg = destConfig as any;
    const poolSize = 8;
    oracleConnections = [];
    
    const toConnectString = (cfg: any) => {
      const port = cfg.port ? String(cfg.port) : "1521";
      return `${cfg.host}:${port}/${cfg.service}`;
    };
    
    for (let i = 0; i < poolSize; i++) {
      const conn = await oracledb.getConnection({
        user: cfg.user,
        password: cfg.password,
        connectString: toConnectString(cfg),
      });
      oracleConnections.push(conn);
    }
  }

  const ensureTable = async (rowsForSchema: Row[]) => {
    if (isRunCancelled(runId)) {
      throw Object.assign(new Error("Run cancelled by user"), { name: CANCELED_ERROR_NAME });
    }
    if (tableEnsured) return;
    if (!destConfig.createTable) return;
    if (!rowsForSchema.length) return;
    await ensureDestinationTable(destType, destConfig, rowsForSchema, logger, auditContext);
    tableEnsured = true;
  };

  const flushBatch = async () => {
    if (isRunCancelled(runId)) {
      throw Object.assign(new Error("Run cancelled by user"), { name: CANCELED_ERROR_NAME });
    }
    if (!batch.length) return;

    await ensureTable(sampleRows.length ? sampleRows : batch);

    await writeToDestination(destType, destConfig, batch, {
      isCancelled: () => isRunCancelled(runId),
      pgClients: pgClients, // Pass the persistent connection pool
      mysqlPool: mysqlPool, // Pass MySQL persistent pool
      mssqlPool: mssqlPool, // Pass MSSQL persistent pool
      oracleConnections: oracleConnections, // Pass Oracle persistent pool
      skipIndexManagement: true, // Skip index management for batch operations (handled at start/end)
    });

    rowsWritten += batch.length;

    // Report progress every 50K rows for optimal performance
    if (rowsWritten % 50000 === 0) {
      await logger?.write({
        ev: "PROGRESS",
        stageId,
        rowsWritten,
        rowsRead,
        rowsTotal: rowsTotalForProgress,
      });
    }

    batch = [];
  };

  for await (const rawRow of generator) {
    if (isRunCancelled(runId)) {
      throw Object.assign(new Error("Run cancelled by user"), { name: CANCELED_ERROR_NAME });
    }
    rowsRead++;
    if (!rowMatchesFilters(rawRow, filters)) continue;

    const mapped = mapRow(rawRow, mapping);

    if (sampleRows.length < sampleLimit) {
      sampleRows.push(mapped);
    }

    batch.push(mapped);

    if (batch.length >= batchSize) {
      await flushBatch();
    }
  }

  await flushBatch();

  // Close persistent connection pools
  if (pgClients) {
    try {
      await Promise.all(pgClients.map(client => client.end()));
    } catch (err) {
      console.warn("[run] Failed to close persistent Postgres connection pool:", err);
    }
  }
  
  if (mysqlPool) {
    try {
      // Re-enable checks and rebuild indexes at end
      const mysql = await import("mysql2/promise");
      const cfg = destConfig as any;
      const conn = await mysql.createConnection({
        host: cfg.host,
        port: cfg.port ? Number(cfg.port) : 3306,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        connectTimeout: 30_000,
      });
      try {
        await conn.query(`SET SESSION foreign_key_checks=1, SESSION unique_checks=1`);
      } catch (err) {
        console.warn("[run] Failed to re-enable MySQL checks:", err);
      } finally {
        await conn.end();
      }
      
      await mysqlPool.end();
    } catch (err) {
      console.warn("[run] Failed to close MySQL connection pool:", err);
    }
  }
  
  if (mssqlPool) {
    try {
      await mssqlPool.close();
    } catch (err) {
      console.warn("[run] Failed to close MSSQL connection pool:", err);
    }
  }
  
  if (oracleConnections) {
    try {
      await Promise.all(oracleConnections.map(conn => conn.close()));
    } catch (err) {
      console.warn("[run] Failed to close Oracle connection pool:", err);
    }
  }

  if (rowsWritten) {
    await logger?.write({
      ev: "WRITE_COMPLETE",
      stageId,
      rows: rowsWritten,
      // At completion, if total was unknown, rowsRead is a safe final total.
      rowsTotal: rowsTotalForProgress ?? rowsRead,
    });
  }

  return { rowsRead, rowsWritten };
}

const DB_DEST_TYPES: DBType[] = ["postgres", "mysql", "mssql", "oracle"];

function needsExplicitTruncate(dstType: DBType) {
  return DB_DEST_TYPES.includes(dstType);
}

async function truncateDestination(dstType: DBType, dstCfg: Record<string, unknown>) {
  switch (dstType) {
    case "postgres": {
      const { pgTruncateTable } = await import("@/lib/connectors/postgres");
      return pgTruncateTable(dstCfg as Parameters<typeof pgTruncateTable>[0]);
    }
    case "mysql": {
      const { mysqlTruncateTable } = await import("@/lib/connectors/mysql");
      return mysqlTruncateTable(dstCfg as Parameters<typeof mysqlTruncateTable>[0]);
    }
    case "mssql": {
      const { mssqlTruncateTable } = await import("@/lib/connectors/mssql");
      return mssqlTruncateTable(dstCfg as Parameters<typeof mssqlTruncateTable>[0]);
    }
    case "oracle": {
      const { oracleTruncateTable } = await import("@/lib/connectors/oracle");
      return oracleTruncateTable(dstCfg as Parameters<typeof oracleTruncateTable>[0]);
    }
    default:
      return;
  }
}

async function ensureDestinationTable(
  dstType: DBType,
  dstCfg: Record<string, unknown>,
  rows: Row[],
  logger: Awaited<ReturnType<typeof createRunWriter>> | null,
  auditContext?: AuditContext
) {
  if (!rows.length) return;
  const createTable = dstCfg["createTable"];
  if (!createTable) return;

  const enabledTypes: DdlFriendlyDb[] = ["postgres", "mysql", "mssql", "oracle"];
  if (!enabledTypes.includes(dstType as DdlFriendlyDb)) return;

  const shouldAddAuditColumns =
    Boolean(auditContext?.addAuditColumns) ||
    Boolean(createTable && enabledTypes.includes(dstType as DdlFriendlyDb));

  const table = String(dstCfg["table"] ?? "");
  const schema = dstCfg["schema"] ? String(dstCfg["schema"]) : undefined;

  await logger?.write({ ev: "CREATE_TABLE", destination: dstType, table });

  const { inferSchema, generateCreateTableSQL } = await import("@/lib/schema");
  const schemaInfo = inferSchema(rows);

  const createTableSQL = generateCreateTableSQL(
    table,
    schemaInfo,
    dstType as DbTypeForSchema,
    schema,
    {
      allowNullValues: true,
      addAuditColumns: shouldAddAuditColumns,
      workflowOwner: auditContext?.workflowOwner,
      workflowName: auditContext?.workflowName,
    }
  );

  switch (dstType) {
    case "postgres": {
      const { pgCreateTable } = await import("@/lib/connectors/postgres");
      await pgCreateTable(dstCfg as Parameters<typeof pgCreateTable>[0], createTableSQL);
      break;
    }
    case "mysql": {
      const { mysqlCreateTable } = await import("@/lib/connectors/mysql");
      await mysqlCreateTable(dstCfg as Parameters<typeof mysqlCreateTable>[0], createTableSQL);
      break;
    }
    case "mssql": {
      const { mssqlCreateTable } = await import("@/lib/connectors/mssql");
      await mssqlCreateTable(dstCfg as Parameters<typeof mssqlCreateTable>[0], createTableSQL);
      break;
    }
    case "oracle": {
      const { oracleCreateTable } = await import("@/lib/connectors/oracle");
      await oracleCreateTable(dstCfg as Parameters<typeof oracleCreateTable>[0], createTableSQL);
      break;
    }
  }
}

// ---- Multi-stage runner ----

async function runMultiStage(
  payload: MultiStagePayload,
  runId: string,
  logger: Awaited<ReturnType<typeof createRunWriter>> | null,
  finalize: (
    status: RunSummary["status"],
    extra?: Partial<Omit<RunSummary, "runId">>
  ) => Promise<RunSummary>
) {
  const stages = Array.isArray(payload?.stages) ? payload.stages : [];
  const globalAudit = payload.audit;

  if (globalAudit) {
    stages.forEach((stage) => {
      stage.auditContext = {
        ...globalAudit,
        ...stage.auditContext,
      };
    });
  }

  if (!stages.length) {
    await finalize("error", { error: "No stages provided" });
    throw new Error("No stages provided");
  }

  for (const stage of stages) {
    if (!stage?.source?.dbType || !stage?.destination?.dbType) {
      await finalize("error", { error: `Stage ${stage?.id || "(unknown)"} missing source/destination` });
      throw new Error(`Stage ${stage?.id || "(unknown)"} missing source/destination`);
    }
  }

  try {
    let totalRead = 0;
    let totalWritten = 0;

    for (const stage of stages) {
      if (isRunCancelled(runId)) {
        throw Object.assign(new Error("Run cancelled by user"), { name: CANCELED_ERROR_NAME });
      }

      const stageNoTransform =
        (!stage.mapping || !stage.mapping.length) &&
        (!stage.filters || !stage.filters.length) &&
        (!stage.script || !stage.script.code);

      const fastPathEnabled = process.env.ENABLE_MYSQL_FAST_PATH === "true";
      const canStageFastPath =
        fastPathEnabled &&
        stage.source.dbType === "csv" &&
        stage.destination.dbType === "mysql" &&
        stageNoTransform &&
        typeof (stage.source.config as any)?.path === "string" &&
        (stage.source.config as any).path;

      if (canStageFastPath) {
        try {
          const filePath = String((stage.source.config as any).path);
          const rows = await mysqlLoadCsvFile({
            ...(stage.destination.config as any),
            filePath,
          });

          totalRead += rows;
          totalWritten += rows;

          await logger?.write({
            ev: "PROGRESS",
            stageId: stage.id,
            rowsRead: rows,
            rowsWritten: rows,
            rowsTotal: rows,
          });

          await logger?.write({
            ev: "WRITE_COMPLETE",
            stageId: stage.id,
            rows,
          });

          await logger?.write({
            ev: "STAGE_DONE",
            stageId: stage.id,
            rowsRead: rows,
            rowsWritten: rows,
            src: stage.source.dbType,
            dst: stage.destination.dbType,
          });

          continue;
        } catch (err) {
          await logger?.write({
            ev: "ERROR",
            stageId: stage.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      await logger?.write({ ev: "STAGE_START", stageId: stage.id });

      const destConfig = stage.destination.config ?? {};
      const autoCreate = Boolean(destConfig.createTable);
      const auditDbTypes = ["postgres", "mysql", "mssql", "oracle"];

      if (autoCreate && auditDbTypes.includes(stage.destination.dbType || "")) {
        stage.auditContext = {
          ...stage.auditContext,
          addAuditColumns: true,
        };
      }

      const sourceResult = await readFromSource(stage.source.dbType, stage.source.config, () =>
        isRunCancelled(runId)
      );

      const hasStageScript = Boolean(stage.script?.code && String(stage.script.code).trim());
      const canStream = Boolean(sourceResult.stream) && !hasStageScript;

      let stageRowsRead = 0;
      let stageRowsWritten = 0;

      // Send initial PROGRESS with total if known (so UI shows "0 / total" immediately)
      if (sourceResult.total !== undefined) {
        await logger?.write({
          ev: "PROGRESS",
          stageId: stage.id,
          rowsRead: 0,
          rowsWritten: 0,
          rowsTotal: sourceResult.total,
        });
      }

      if (canStream) {
        const batchSize =
          typeof destConfig.batchSize === "number"
            ? destConfig.batchSize
            : typeof destConfig.batchSize === "string"
            ? Number(destConfig.batchSize)
            : undefined;

        const streamResult = await streamAndWriteRows({
          generator: sourceResult.stream!,
          filters: stage.filters,
          mapping: stage.mapping,
          destType: stage.destination.dbType,
          destConfig,
          logger,
          runId,
          stageId: stage.id,
          auditContext: stage.auditContext,
          batchSize,
          // ✅ IMPORTANT: pass the total forward (previously missing)
          totalRows: sourceResult.total,
        });

        stageRowsRead = streamResult.rowsRead;
        stageRowsWritten = streamResult.rowsWritten;

        await logger?.write({ ev: "READ_COMPLETE", rows: stageRowsRead });
      } else {
        const rows = await collectRows(sourceResult);
        stageRowsRead = rows.length;

        await logger?.write({ ev: "READ_COMPLETE", rows: stageRowsRead });

        const filtered = applyFilters(rows, stage.filters);
        const mapped = applyMapping(filtered, stage.mapping);

        let transformed = mapped;

        if (stage.script && stage.script.code && stage.script.language !== "") {
          try {
            await logger?.write({ ev: "SCRIPT_START", stageId: stage.id });
            if ((stage.script.language || "").toLowerCase() === "python") {
              transformed = await runPythonTransform({
                code: stage.script.code,
                rows: mapped,
                timeoutMs: stage.script.timeoutMs ?? 30000,
                logger,
                runId,
              });
            } else {
              await logger?.write({
                ev: "SCRIPT_SKIPPED",
                stageId: stage.id,
                reason: "Unsupported script language",
              });
            }
            await logger?.write({
              ev: "SCRIPT_DONE",
              stageId: stage.id,
              rows: Array.isArray(transformed) ? transformed.length : 0,
            });
          } catch (err) {
            await logger?.write({ ev: "SCRIPT_ERROR", stageId: stage.id, err: String(err) });
            throw err;
          }
        }

        await ensureDestinationTable(
          stage.destination.dbType,
          stage.destination.config,
          transformed,
          logger,
          stage.auditContext
        );

        const totalRowsForStage = Array.isArray(transformed) ? transformed.length : 0;

        await logger?.write({
          ev: "PROGRESS",
          stageId: stage.id,
          rowsRead: stageRowsRead,
          rowsWritten: 0,
          rowsTotal: stageRowsRead,
        });

        let writtenCount = 0;

        await writeToDestination(stage.destination.dbType, stage.destination.config, transformed, {
          isCancelled: () => isRunCancelled(runId),
          onProgress: async (written) => {
            writtenCount += typeof written === "number" ? written : 0;
            await logger?.write({
              ev: "PROGRESS",
              stageId: stage.id,
              rowsRead: stageRowsRead,
              rowsWritten: writtenCount,
              rowsTotal: stageRowsRead,
            });
          },
        });

        if (writtenCount < totalRowsForStage) {
          writtenCount = totalRowsForStage;
          await logger?.write({
            ev: "PROGRESS",
            stageId: stage.id,
            rowsRead: stageRowsRead,
            rowsWritten: writtenCount,
            rowsTotal: stageRowsRead,
          });
        }

        await logger?.write({
          ev: "WRITE_COMPLETE",
          stageId: stage.id,
          rows: writtenCount,
        });

        stageRowsWritten = writtenCount;
      }

      totalRead += stageRowsRead;
      totalWritten += stageRowsWritten;

      await logger?.write({
        ev: "STAGE_DONE",
        stageId: stage.id,
        rowsRead: stageRowsRead,
        rowsWritten: stageRowsWritten,
        src: stage.source.dbType,
        dst: stage.destination.dbType,
      });
    }

    const descSrc = describeConfig(stages[0]?.source?.config);
    const descDst = describeConfig(stages[stages.length - 1]?.destination?.config);

    await logger?.write({
      ev: "RUN_FINISH",
      message: `Completed ${stages.length} stage(s)`,
      moved: totalWritten,
      runId,
    });

    await finalize("success", {
      rowsRead: totalRead,
      rowsWritten: totalWritten,
      rowsMoved: totalWritten,
      sourceType: stages[0]?.source?.dbType,
      destinationType: stages[stages.length - 1]?.destination?.dbType,
      sourceTableName: descSrc,
      destinationTableName: descDst,
      message: `Completed ${stages.length} stage(s)`,
    });

    return;
  } catch (err) {
    const message =
      err instanceof Error && err.name === CANCELED_ERROR_NAME
        ? "Run cancelled"
        : err instanceof Error
        ? err.message
        : "Run failed";
    await logger?.write({ ev: "ERROR", message, err: String(err) });
    await finalize("error", { error: message });
    return;
  }
}

// ---- Route ----

export async function POST(req: NextRequest) {
  let body = (await req.json()) as
    | RunPayload
    | MultiStagePayload
    | { spec?: SavedSpec; [key: string]: unknown };

  const specCandidate = body as { spec?: SavedSpec };

  if (!Array.isArray((body as MultiStagePayload).stages) && specCandidate.spec) {
    const { stages, errors } = buildStagesFromSpec(specCandidate.spec);
    if (errors.length) {
      return NextResponse.json({ ok: false, message: errors.join(" ") }, { status: 400 });
    }
    body = { ...body, stages } as MultiStagePayload;

    const multiBody = body as MultiStagePayload;
    const auditInfo = (body as { audit?: AuditContext }).audit;
    if (auditInfo) {
      multiBody.stages = multiBody.stages.map((stage) => ({
        ...stage,
        auditContext: { ...auditInfo, ...stage.auditContext },
      }));
    }
    body = multiBody;
  }

  const maybe = body as { runId?: unknown; stages?: unknown };
  const providedRunId = typeof maybe.runId === "string" ? (maybe.runId as string) : undefined;
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

  const runTask = async () => {
    let heartbeat: NodeJS.Timeout | null = null;
    const stopHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    };

    try {
      heartbeat = setInterval(() => {
        logger?.write({ ev: "HEARTBEAT", ts: new Date().toISOString() }).catch(() => {});
      }, 15000);

      await logger?.write({ ev: "SPEC", spec: body });

      const maybeStages = maybe.stages;
      if (Array.isArray(maybeStages) && (maybeStages as unknown[]).length) {
        await runMultiStage(body as MultiStagePayload, runId, logger, finalize);
        await logger?.write({
          ev: "RUN_FINISH",
          message: `Run complete (${maybeStages.length} stage${maybeStages.length > 1 ? "s" : ""})`,
          runId,
        });
        stopHeartbeat();
        return;
      }

      // Single-stage path
      const singleStage = body as RunPayload;

      if (!singleStage?.source?.dbType || !singleStage?.destination?.dbType) {
        await finalize("error", { error: "Missing source/destination" });
        throw new Error("Missing source/destination");
      }

      const srcType = singleStage.source.dbType;
      const srcCfg = singleStage.source.config || {};
      const dstType = singleStage.destination.dbType;
      const dstCfg = singleStage.destination.config || {};
      const mapping = singleStage.mapping;

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
        loadMode: singleStage.loadOptions?.mode,
        incrementalColumn: singleStage.loadOptions?.incrementalColumn,
        scheduleId: singleStage.loadOptions?.scheduleId,
      };
      await logger?.summary(summary);

      const modeOption = singleStage.loadOptions?.mode;
      const loadMode: LoadMode =
        modeOption === "incremental" ? "incremental" : modeOption === "merge" ? "merge" : "full";

      const incrementalColumn = singleStage.loadOptions?.incrementalColumn?.trim();

      type StageScript = StageSpec["script"];
      const topScript = (singleStage as RunPayload & { script?: StageScript }).script;
      const hasTopScript = Boolean(topScript?.code && String(topScript.code).trim());

      const destinationOutputUrl =
        (dstType === "csv" || dstType === "excel") && (dstCfg as any)?.path
          ? String((dstCfg as any).path)
          : undefined;

      throwIfCancelled();

      const noTransform =
        (!mapping || mapping.length === 0) &&
        (!singleStage.filters || singleStage.filters.length === 0) &&
        !(singleStage as RunPayload & { script?: StageSpec["script"] }).script;

      const fastPathEnabled = process.env.ENABLE_MYSQL_FAST_PATH === "true";
      const canFastPath =
        fastPathEnabled &&
        srcType === "csv" &&
        dstType === "mysql" &&
        noTransform &&
        typeof (srcCfg as any)?.path === "string" &&
        (srcCfg as any).path;

      if (canFastPath) {
        try {
          await logger?.write({ ev: "PROGRESS", rowsRead: 0, rowsWritten: 0, rowsTotal: null });
          const rows = await mysqlLoadCsvFile({
            ...(dstCfg as any),
            filePath: String((srcCfg as any).path),
          });
          await logger?.write({ ev: "PROGRESS", rowsRead: rows, rowsWritten: rows, rowsTotal: rows });
          await logger?.write({ ev: "WRITE_COMPLETE", rows });

          const message = `Run complete: ${rows} rows moved ${srcType} -> ${dstType} (fast path)`;
          await finalize("success", {
            rowsRead: rows,
            rowsWritten: rows,
            rowsMoved: rows,
            outputUrl: destinationOutputUrl,
            message,
          });
          stopHeartbeat();
          return;
        } catch (err) {
          await logger?.write({ ev: "ERROR", message: err instanceof Error ? err.message : String(err) });
        }
      }

      const sourceResult = await readFromSource(srcType, srcCfg, () => isRunCancelled(runId));
      throwIfCancelled();

      // Send initial PROGRESS with total if known (so UI shows "0 / total" immediately)
      if (sourceResult.total !== undefined) {
        await logger?.write({
          ev: "PROGRESS",
          rowsRead: 0,
          rowsWritten: 0,
          rowsTotal: sourceResult.total,
        });
      }

      const streamModeEnabled = Boolean(sourceResult.stream) && loadMode === "full" && !hasTopScript;

      if (streamModeEnabled) {
        const batchSize =
          typeof (dstCfg as any).batchSize === "number"
            ? (dstCfg as any).batchSize
            : typeof (dstCfg as any).batchSize === "string"
            ? Number((dstCfg as any).batchSize)
            : undefined;

        const streamResult = await streamAndWriteRows({
          generator: sourceResult.stream!,
          filters: singleStage.filters,
          mapping,
          destType: dstType,
          destConfig: dstCfg,
          logger,
          runId,
          stageId: null,
          auditContext: singleStage.audit,
          batchSize,
          totalRows: sourceResult.total,
        });

        await logger?.write({ ev: "READ_COMPLETE", rows: streamResult.rowsRead });

        const message = `Run complete: ${streamResult.rowsWritten} rows moved ${srcType} -> ${dstType}`;
        await finalize("success", {
          rowsRead: streamResult.rowsRead,
          rowsWritten: streamResult.rowsWritten,
          rowsMoved: streamResult.rowsWritten,
          outputUrl: destinationOutputUrl,
          message,
        });
        stopHeartbeat();
        return;
      }

      const sourceRows = await collectRows(sourceResult);
      await logger?.write({ ev: "READ_COMPLETE", rows: sourceRows.length });

      await logger?.write({
        ev: "PROGRESS",
        rowsRead: sourceRows.length,
        rowsWritten: 0,
        rowsTotal: sourceRows.length,
      });

      const filteredRows =
        singleStage.filters && singleStage.filters.length ? applyFilters(sourceRows, singleStage.filters) : sourceRows;

      let mappedRows = mapping && mapping.length ? applyMapping(filteredRows, mapping) : filteredRows;

      if (topScript && topScript.code) {
        const s: StageScript = topScript;
        const lang = (s.language ?? "").toString().toLowerCase();
        if (lang === "python") {
          await logger?.write({ ev: "SCRIPT_START", stageId: null });
          try {
            mappedRows = await runPythonTransform({
              code: String(s.code),
              rows: mappedRows,
              timeoutMs: typeof s.timeoutMs === "number" ? s.timeoutMs : 30000,
              logger,
              runId,
            });
            await logger?.write({
              ev: "SCRIPT_DONE",
              stageId: null,
              rows: Array.isArray(mappedRows) ? mappedRows.length : 0,
            });
          } catch (err) {
            await logger?.write({
              ev: "SCRIPT_ERROR",
              stageId: null,
              err: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
        } else {
          await logger?.write({ ev: "SCRIPT_SKIPPED", reason: "unsupported language" });
        }
      }

      let rowsForDestination = mappedRows;
      let reportedMoved = mappedRows.length;

      if (loadMode === "incremental") {
        if (!incrementalColumn) {
          throw new Error("Incremental column is required when loadOptions.mode is 'incremental'");
        }
        const watermarkRecord = singleStage.loadOptions?.scheduleId
          ? getWatermark(singleStage.loadOptions.scheduleId)
          : undefined;

        const { filtered, highest } = filterRowsByWatermark(
          mappedRows,
          incrementalColumn,
          watermarkRecord ? { type: watermarkRecord.type, value: watermarkRecord.value } : undefined,
          { isCancelled: () => isRunCancelled(runId) }
        );

        if (!filtered.length) {
          const safeColumn = incrementalColumn ?? "";
          const message = `No new rows for incremental column '${safeColumn}'`;
          await logger?.write({ ev: "INCREMENTAL_NO_ROWS", incrementalColumn });

          await finalize("success", {
            rowsRead: sourceRows.length,
            rowsWritten: 0,
            rowsMoved: 0,
            message,
            outputUrl: undefined,
          });

          stopHeartbeat();
          return;
        }

        reportedMoved = filtered.length;

        // Load destination rows into memory for fast lookup (no way to stream this part)
        // NOTE: This is the bottleneck for large incremental updates - destination must be buffered
        // Optimization: Only load the incremental column + PK into a Set/Map for O(1) lookup
        const existingRows = await readDestinationRows(dstType, dstCfg, () => isRunCancelled(runId));
        rowsForDestination = mergeRowsOnColumn(existingRows, filtered, incrementalColumn, {
          isCancelled: () => isRunCancelled(runId),
        });

        if (singleStage.loadOptions?.scheduleId && highest) {
          const payload = stringifyComparable(highest);
          setWatermark({
            scheduleId: singleStage.loadOptions.scheduleId,
            incrementalColumn,
            type: payload.type,
            value: payload.value,
            updatedAt: new Date().toISOString(),
          });
        }
      }

      if ((dstCfg as any).createTable && ["postgres", "mysql", "mssql", "oracle"].includes(dstType)) {
        await logger?.write({ ev: "CREATE_TABLE", destination: dstType });
        const { inferSchema, generateCreateTableSQL } = await import("@/lib/schema");

        const schema = inferSchema(mappedRows);
        const table = String((dstCfg as any)["table"] ?? "");
        const tableSchema = (dstCfg as any)["schema"] ? String((dstCfg as any)["schema"]) : undefined;

        const auditContext = singleStage.audit;

        const createTableSQL = generateCreateTableSQL(
          table,
          schema,
          dstType as "postgres" | "mysql" | "mssql" | "oracle",
          tableSchema,
          {
            allowNullValues: true,
            addAuditColumns: true,
            workflowOwner: auditContext?.workflowOwner,
            workflowName: auditContext?.workflowName,
          }
        );

        switch (dstType) {
          case "postgres": {
            const { pgCreateTable } = await import("@/lib/connectors/postgres");
            await pgCreateTable(dstCfg as Parameters<typeof pgCreateTable>[0], createTableSQL);
            break;
          }
          case "mysql": {
            const { mysqlCreateTable } = await import("@/lib/connectors/mysql");
            await mysqlCreateTable(dstCfg as Parameters<typeof mysqlCreateTable>[0], createTableSQL);
            break;
          }
          case "mssql": {
            const { mssqlCreateTable } = await import("@/lib/connectors/mssql");
            await mssqlCreateTable(dstCfg as Parameters<typeof mssqlCreateTable>[0], createTableSQL);
            break;
          }
          case "oracle": {
            const { oracleCreateTable } = await import("@/lib/connectors/oracle");
            await oracleCreateTable(dstCfg as Parameters<typeof oracleCreateTable>[0], createTableSQL);
            break;
          }
        }
      }

      const shouldTruncateBeforeWrite =
        needsExplicitTruncate(dstType) && rowsForDestination.length && loadMode === "full";

      if (shouldTruncateBeforeWrite) {
        await logger?.write({ ev: "TRUNCATE_DESTINATION", destination: dstType });
        await truncateDestination(dstType, dstCfg);
      }

      throwIfCancelled();

      let writtenCount = 0;
      const totalRows = sourceRows.length;

      await writeToDestination(dstType, dstCfg, rowsForDestination, {
        isCancelled: () => isRunCancelled(runId),
        onProgress: async (written) => {
          writtenCount += typeof written === "number" ? written : 0;
          await logger?.write({
            ev: "PROGRESS",
            rowsRead: totalRows,
            rowsWritten: writtenCount,
            rowsTotal: totalRows,
          });
        },
      });

      if (writtenCount < rowsForDestination.length) {
        writtenCount = rowsForDestination.length;
        await logger?.write({
          ev: "PROGRESS",
          rowsRead: totalRows,
          rowsWritten: writtenCount,
          rowsTotal: totalRows,
        });
      }

      await logger?.write({ ev: "WRITE_COMPLETE", rows: writtenCount });

      const message = `Run complete: ${reportedMoved} rows moved ${srcType} -> ${dstType}`;
      await finalize("success", {
        rowsRead: sourceRows.length,
        rowsWritten: writtenCount,
        rowsMoved: reportedMoved ?? writtenCount,
        outputUrl: destinationOutputUrl,
        message,
      });

      await logger?.write({
        ev: "RUN_FINISH",
        message,
        moved: reportedMoved,
        outputUrl: destinationOutputUrl,
        runId,
      });
    } catch (e) {
      const isError = e instanceof Error;
      const message = isError ? e.message : "Run failed";
      const isCancelled = isError && e.name === CANCELED_ERROR_NAME;

      await logger?.write({
        ev: isCancelled ? "CANCELLED" : "ERROR",
        message,
        stack: isError ? e.stack : undefined,
      });

      await finalize("error", { error: message });
      console.error("[/api/run] error:", e);
    } finally {
      stopHeartbeat();
    }
  };

  setImmediate(() => {
    runTask().catch((err) => console.error("[/api/run] background run failed:", err));
  });

  return NextResponse.json({ ok: true, message: "Run started", runId }, { status: 202 });
}
