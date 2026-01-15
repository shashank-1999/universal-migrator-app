import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { promises as fs, constants as fsConstants } from "fs";
import { normalizeUserPath } from "@/lib/pathUtils";

// DB test helpers you already have:
import { pgTestConnection } from "@/lib/connectors/postgres";
import { mysqlTestConnection } from "@/lib/connectors/mysql";
import { mssqlTestConnection } from "@/lib/connectors/mssql";
import { oracleTestConnection } from "@/lib/connectors/oracle";

// Optional: file/object store quick checks (safe to keep or remove)
import { s3QuickCheck, minioQuickCheck } from "@/lib/connectors/s3";
export const runtime = "nodejs";
import { gcsQuickCheck } from "@/lib/connectors/gcs";
import { azureBlobQuickCheck } from "@/lib/connectors/azureBlob";

type NodeRole = "source" | "destination";

function validateRequired(config: Record<string, unknown>, fields: string[], typeName: string): string | null {
  for (const field of fields) {
    if (!config?.[field] || String(config[field]).trim() === "") {
      return `${typeName}: Missing or empty required field "${field}"`;
    }
  }
  return null;
}

function resolveUserPath(userPath: string): string {
  const cleaned = normalizeUserPath(userPath);
  const normalized = cleaned.replace(/\\/g, "/");
  return path.isAbsolute(normalized)
    ? normalized
    : path.join(process.cwd(), normalized.replace(/^[.\\/]+/, ""));
}

async function ensureReadablePath(userPath: string) {
  const resolved = resolveUserPath(userPath);
  await fs.access(resolved, fsConstants.R_OK);
  return resolved;
}

function sanitizePort(raw: unknown, fallback: number, typeName: string): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`${typeName}: Invalid port "${raw}". Enter a number between 1 and 65535.`);
  }
  return value;
}

export async function POST(req: NextRequest) {
  try {
    const { type, config, role } = await req.json();
    const nodeRole: NodeRole = role === "destination" ? "destination" : "source";

    switch (type) {
      case "postgres": {
        const err = validateRequired(config, ["host", "user", "password", "database"], "PostgreSQL");
        if (err) return NextResponse.json({ ok: false, message: err }, { status: 400 });
        const sanitized = {
          ...config,
          port: sanitizePort(config?.port, 5432, "PostgreSQL"),
        };
        await pgTestConnection(sanitized);
        return NextResponse.json({ ok: true, message: "PostgreSQL: connection OK" });
      }

      case "mysql": {
        const err = validateRequired(config, ["host", "user", "password", "database"], "MySQL");
        if (err) return NextResponse.json({ ok: false, message: err }, { status: 400 });
        const sanitized = {
          ...config,
          port: sanitizePort(config?.port, 3306, "MySQL"),
        };
        await mysqlTestConnection(sanitized);
        return NextResponse.json({ ok: true, message: "MySQL: connection OK" });
      }

      case "mssql": {
        const err = validateRequired(config, ["host", "user", "password", "database"], "SQL Server");
        if (err) return NextResponse.json({ ok: false, message: err }, { status: 400 });
        const sanitized = {
          ...config,
          port: sanitizePort(config?.port, 1433, "SQL Server"),
        };
        await mssqlTestConnection(sanitized);
        return NextResponse.json({ ok: true, message: "SQL Server: connection OK" });
      }

      case "oracle": {
        const err = validateRequired(config, ["host", "service", "user", "password"], "Oracle");
        if (err) return NextResponse.json({ ok: false, message: err }, { status: 400 });
        const sanitized = {
          ...config,
          port: sanitizePort(config?.port, 1521, "Oracle"),
        };
        await oracleTestConnection(sanitized);
        return NextResponse.json({ ok: true, message: "Oracle: connection OK" });
      }

      case "csv":
      case "excel": {
        const friendlyType = type === "csv" ? "CSV" : "Excel";
        const err = validateRequired(config, ["path"], friendlyType);
        if (err) return NextResponse.json({ ok: false, message: err }, { status: 400 });

        if (nodeRole === "destination") {
          const resolved = resolveUserPath(config.path);
          return NextResponse.json({
            ok: true,
            message: `${friendlyType}: path looks OK (will write to ${resolved})`,
          });
        }

        try {
          const resolved = await ensureReadablePath(config.path);
          return NextResponse.json({
            ok: true,
            message: `${friendlyType}: file found at ${resolved}`,
          });
        } catch (e) {
          const code = e instanceof Error && (e as NodeJS.ErrnoException).code;
          const details =
            code === "ENOENT"
              ? `${friendlyType}: file not found at ${config.path}`
              : `${friendlyType}: cannot read file (${e instanceof Error ? e.message : "unknown error"})`;
          return NextResponse.json({ ok: false, message: details }, { status: 400 });
        }
      }
      case "json":
      case "parquet": {
        const friendlyType = type === "json" ? "JSON file" : "Parquet file";
        const err = validateRequired(config, ["path"], friendlyType);
        if (err) return NextResponse.json({ ok: false, message: err }, { status: 400 });

        if (nodeRole === "destination") {
          const resolved = resolveUserPath(config.path);
          return NextResponse.json({
            ok: true,
            message: `${friendlyType}: path looks OK (will write to ${resolved})`,
          });
        }

        try {
          const resolved = await ensureReadablePath(config.path);
          return NextResponse.json({
            ok: true,
            message: `${friendlyType}: file found at ${resolved}`,
          });
        } catch (e) {
          const code = e instanceof Error && (e as NodeJS.ErrnoException).code;
          const details =
            code === "ENOENT"
              ? `${friendlyType}: file not found at ${config.path}`
              : `${friendlyType}: cannot read file (${e instanceof Error ? e.message : "unknown error"})`;
          return NextResponse.json({ ok: false, message: details }, { status: 400 });
        }
      }

      case "s3": {
        const err = validateRequired(config, ["region", "bucket", "key"], "S3");
        if (err) return NextResponse.json({ ok: false, message: err }, { status: 400 });
        await s3QuickCheck(config);
        return NextResponse.json({ ok: true, message: "S3: params OK" });
      }

      case "minio": {
        const err = validateRequired(
          config,
          ["endpoint", "bucket", "key", "accessKeyId", "secretAccessKey"],
          "MinIO"
        );
        if (err) return NextResponse.json({ ok: false, message: err }, { status: 400 });
        await minioQuickCheck(config);
        return NextResponse.json({ ok: true, message: "MinIO: params OK" });
      }

      case "gcs": {
        const err = validateRequired(config, ["projectId", "bucket", "key"], "GCS");
        if (err) return NextResponse.json({ ok: false, message: err }, { status: 400 });
        await gcsQuickCheck(config);
        return NextResponse.json({ ok: true, message: "GCS: params OK" });
      }

      case "azureBlob": {
        const err = validateRequired(config, ["container", "blob"], "Azure Blob");
        if (err) return NextResponse.json({ ok: false, message: err }, { status: 400 });
        if (!config.connectionString && (!config.accountName || !config.accountKey)) {
          return NextResponse.json({ 
            ok: false, 
            message: "Azure Blob: Must provide either connectionString or (accountName + accountKey)" 
          }, { status: 400 });
        }
        await azureBlobQuickCheck(config);
        return NextResponse.json({ ok: true, message: "Azure Blob: params OK" });
      }

      default:
        return NextResponse.json({ ok: false, message: `Unsupported type: ${type}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "Test failed" }, { status: 500 });
  }
}
