import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

export async function GET(
  _req: NextRequest,
  { params }: { params: { runId: string } }
) {
  const runId = params.runId;
  const cursorParam = _req.nextUrl.searchParams.get("cursor");
  const cursor = Number.isNaN(Number(cursorParam)) ? 0 : Number(cursorParam);
  const logPath = path.join(process.cwd(), ".runs", runId, "run.jsonl");

  try {
    const txt = await fs.readFile(logPath, "utf8");
    const lines = txt.split(/\r?\n/).filter(Boolean);
    const events = lines.slice(cursor).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
    return NextResponse.json({
      events,
      cursor: cursor + events.length,
    });
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ events: [], cursor }, { status: 404 });
    }
    console.error("[/api/runs/[runId]/events]", err);
    return NextResponse.json({ events: [], cursor }, { status: 500 });
  }
}
