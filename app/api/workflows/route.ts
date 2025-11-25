import { NextRequest, NextResponse } from "next/server";
import { listWorkflows, saveWorkflow } from "@/lib/storedWorkflows";

export async function GET() {
  return NextResponse.json({ ok: true, workflows: listWorkflows() });
}

export async function POST(req: NextRequest) {
  try {
    const { name, spec } = await req.json();
    if (!name || typeof name !== "string") {
      return NextResponse.json({ ok: false, message: "Name is required" }, { status: 400 });
    }
    if (!spec) {
      return NextResponse.json({ ok: false, message: "Spec is required" }, { status: 400 });
    }
    const saved = saveWorkflow(name.trim(), spec);
    return NextResponse.json({ ok: true, workflow: saved });
  } catch (err: any) {
    console.error("[POST /api/workflows]", err);
    return NextResponse.json(
      { ok: false, message: err?.message || "Failed to save workflow" },
      { status: 500 }
    );
  }
}
