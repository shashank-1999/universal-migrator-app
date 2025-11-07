import { NextRequest, NextResponse } from "next/server";

// DB test helpers you already have:
import { pgTestConnection } from "@/lib/connectors/postgres";
import { mysqlTestConnection } from "@/lib/connectors/mysql";
import { mssqlTestConnection } from "@/lib/connectors/mssql";
import { oracleTestConnection } from "@/lib/connectors/oracle";

// Optional: file/object store quick checks (safe to keep or remove)
import { s3QuickCheck } from "@/lib/connectors/s3";
import { gcsQuickCheck } from "@/lib/connectors/gcs";
import { azureBlobQuickCheck } from "@/lib/connectors/azureBlob";

export async function POST(req: NextRequest) {
  try {
    const { type, config } = await req.json();

    switch (type) {
      case "postgres":
        await pgTestConnection(config);
        return NextResponse.json({ ok: true, message: "PostgreSQL: connection OK" });

      case "mysql":
        await mysqlTestConnection(config);
        return NextResponse.json({ ok: true, message: "MySQL: connection OK" });

      case "mssql":
        await mssqlTestConnection(config);
        return NextResponse.json({ ok: true, message: "SQL Server: connection OK" });

      case "oracle":
        await oracleTestConnection(config);
        return NextResponse.json({ ok: true, message: "Oracle: connection OK" });

      case "csv":
      case "excel":
        if (!config?.path) {
          return NextResponse.json({ ok: false, message: "Path is empty" }, { status: 400 });
        }
        return NextResponse.json({ ok: true, message: "File path looks OK" });

      case "s3":
        await s3QuickCheck(config);
        return NextResponse.json({ ok: true, message: "S3: params OK" });

      case "gcs":
        await gcsQuickCheck(config);
        return NextResponse.json({ ok: true, message: "GCS: params OK" });

      case "azureBlob":
        await azureBlobQuickCheck(config);
        return NextResponse.json({ ok: true, message: "Azure Blob: params OK" });

      default:
        return NextResponse.json({ ok: false, message: `Unsupported type: ${type}` }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ ok: false, message: e?.message || "Test failed" }, { status: 500 });
  }
}
