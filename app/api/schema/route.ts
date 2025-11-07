import { NextRequest, NextResponse } from "next/server";
import { pgSchema } from "@/lib/connectors/postgres";
import { mysqlSchema } from "@/lib/connectors/mysql";
import { mssqlSchema } from "@/lib/connectors/mssql";
import { csvSchema } from "@/lib/connectors/csv";
import { excelSchema } from "@/lib/connectors/excel";
// add others if you use them...

export async function POST(req: NextRequest) {
  try {
    const { type, config } = await req.json();

    switch ((type || "").toLowerCase()) {
      case "postgres":
      case "postgresql":
        return NextResponse.json(await pgSchema(config));
      case "mysql":
        return NextResponse.json(await mysqlSchema(config));
      case "mssql":
      case "sqlserver":
        return NextResponse.json(await mssqlSchema(config));
      case "csv":
        return NextResponse.json(await csvSchema(config));
      case "excel":
        return NextResponse.json(await excelSchema(config));
      default:
        return NextResponse.json(
          { message: `Unsupported type: ${type}` },
          { status: 400 }
        );
    }
  } catch (e: any) {
    return NextResponse.json(
      { message: e?.message || "Schema fetch failed" },
      { status: 500 }
    );
  }
}
