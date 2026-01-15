import { NextRequest, NextResponse } from "next/server";
import { pgSchema } from "@/lib/connectors/postgres";
import { mysqlSchema } from "@/lib/connectors/mysql";
import { mssqlSchema } from "@/lib/connectors/mssql";
import { csvSchema } from "@/lib/connectors/csv";
import { excelSchema } from "@/lib/connectors/excel";
import { jsonSchema } from "@/lib/connectors/json";
import { parquetSchema } from "@/lib/connectors/parquet";
// add others if you use them...

export async function POST(req: NextRequest) {
  try {
    const { type, config } = await req.json();

    const normalized = (type || "").toLowerCase();

    switch (normalized) {
      case "postgres":
      case "postgresql":
        return NextResponse.json({ columns: await pgSchema(config) });
      case "mysql":
        return NextResponse.json({ columns: await mysqlSchema(config) });
      case "mssql":
      case "sqlserver":
        return NextResponse.json({ columns: await mssqlSchema(config) });
      case "csv":
        return NextResponse.json({ columns: await csvSchema(config) });
      case "excel":
        return NextResponse.json({ columns: await excelSchema(config) });
      case "json":
        return NextResponse.json({ columns: await jsonSchema(config) });
      case "parquet":
        return NextResponse.json({ columns: await parquetSchema(config) });
      default:
        return NextResponse.json(
          { error: `Unsupported type: ${type}` },
          { status: 400 }
        );
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Schema fetch failed" },
      { status: 500 }
    );
  }
}
