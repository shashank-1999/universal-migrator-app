import { NextRequest, NextResponse } from "next/server";
import { pgReadRows } from "@/lib/connectors/postgres";
import { mysqlReadRows } from "@/lib/connectors/mysql";
import { mssqlReadRows } from "@/lib/connectors/mssql";
import { oracleReadRows } from "@/lib/connectors/oracle";

const MAX_RESULT_ROWS = 5000;

function buildResponse(rows: Record<string, any>[]) {
  const totalRows = rows.length;
  const truncated = totalRows > MAX_RESULT_ROWS;
  return NextResponse.json({
    rows: truncated ? rows.slice(0, MAX_RESULT_ROWS) : rows,
    totalRows,
    truncated,
    maxRows: MAX_RESULT_ROWS,
  });
}

export async function POST(request: NextRequest) {
  try {
    const { type, config, query } = await request.json();

    if (!type || !config || !query) {
      return new NextResponse("Missing required fields", { status: 400 });
    }

    switch ((type as string).toLowerCase()) {
      case "postgres":
        return buildResponse(await pgReadRows({ ...(config || {}), query }));
      case "mysql":
        return buildResponse(await mysqlReadRows({ ...(config || {}), query }));
      case "mssql":
        return buildResponse(await mssqlReadRows({ ...(config || {}), query }));
      case "oracle":
        return buildResponse(await oracleReadRows({ ...(config || {}), query }));
      default:
        return new NextResponse("Unsupported database type", { status: 400 });
    }
  } catch (err) {
    console.error("execute-query error:", err);
    return new NextResponse(err instanceof Error ? err.message : String(err), { status: 500 });
  }
}
