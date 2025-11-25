import { NextRequest, NextResponse } from "next/server";
import { requestRunCancel } from "@/lib/runController";

export async function POST(_: NextRequest, { params }: { params: { runId: string } }) {
  const runId = params?.runId;
  if (!runId) {
    return NextResponse.json({ ok: false, message: "runId missing" }, { status: 400 });
  }
  const ok = requestRunCancel(runId);
  if (!ok) {
    return NextResponse.json({ ok: false, message: "Run not found or already finished" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, message: "Cancellation requested" });
}
