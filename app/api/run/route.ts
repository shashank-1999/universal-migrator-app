// app/api/run/route.ts
import { NextRequest, NextResponse } from "next/server";

// ---- Connectors (adjust paths/names if your files differ) ----
import { csvReadRows, csvWriteRows } from "@/lib/connectors/csv";
import { excelReadRows, excelWriteRows } from "@/lib/connectors/excel";
import { pgReadRows, pgWriteRows } from "@/lib/connectors/postgres";
import { mysqlReadRows, mysqlWriteRows } from "@/lib/connectors/mysql";
import { mssqlReadRows, mssqlWriteRows } from "@/lib/connectors/mssql";
import { oracleReadRows, oracleWriteRows } from "@/lib/connectors/oracle";

// ---- Types ----
type DBType =
  | "csv"
  | "excel"
  | "postgres"
  | "mysql"
  | "mssql"
  | "oracle";

type Row = Record<string, any>;

type RunPayload = {
  version: number;
  source: { dbType: DBType; config: any };
  destination: { dbType: DBType; config: any };
  mapping?: { from: string; to: string; cast?: CastType }[];
  options?: {
    truncateDest?: boolean; // if you add truncate logic for DBs
    batchSize?: number;     // for future batching
  };
};

type CastType = "STRING" | "NUMBER" | "BOOLEAN" | "DATE";

// ---- Helpers ----

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

async function writeToDestination(dstType: DBType, dstCfg: any, rows: Row[]) {
  switch (dstType) {
    case "csv":
      // Expect dstCfg.path (e.g., ./data/output.csv)
      return csvWriteRows(dstCfg, rows);
    case "excel":
      // Expect dstCfg.path, optional dstCfg.sheet
      return excelWriteRows(dstCfg, rows);
    case "postgres":
      return pgWriteRows(dstCfg, rows);
    case "mysql":
      return mysqlWriteRows(dstCfg, rows);
    case "mssql":
      return mssqlWriteRows(dstCfg, rows);
    case "oracle":
      return oracleWriteRows(dstCfg, rows);
    default:
      throw new Error(`Unsupported destination type: ${dstType}`);
  }
}

// ---- Route ----

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as RunPayload;

    // Validate shape
    if (!body?.source?.dbType || !body?.destination?.dbType) {
      return NextResponse.json(
        { ok: false, message: "Missing source/destination" },
        { status: 400 }
      );
    }

    const srcType = body.source.dbType;
    const srcCfg = body.source.config || {};
    const dstType = body.destination.dbType;
    const dstCfg = body.destination.config || {};
    const mapping = body.mapping;

    // 1) Read
    const sourceRows = await readFromSource(srcType, srcCfg);

    // 2) If mapping missing, auto-map by identity using current row keys
    const mappedRows = mapping && mapping.length
      ? applyMapping(sourceRows, mapping)
      : sourceRows;

    // 3) Write
    const writeResult = await writeToDestination(dstType, dstCfg, mappedRows);

    // Optional: surface an output URL/path for file destinations
    let outputUrl: string | undefined;
    if ((dstType === "csv" || dstType === "excel") && dstCfg?.path) {
      // If you expose a static dir, you can convert path -> URL here.
      // For now we just echo the path back to the client.
      outputUrl = dstCfg.path;
    }

    return NextResponse.json({
      ok: true,
      message: `Run complete: ${sourceRows.length} rows moved ${srcType} → ${dstType}`,
      moved: sourceRows.length,
      outputUrl,
      writeResult, // connector-specific details (e.g., rows written)
    });
  } catch (e: any) {
    console.error("[/api/run] error:", e);
    return NextResponse.json(
      { ok: false, message: e?.message || "Run failed" },
      { status: 500 }
    );
  }
}
