import { NextRequest, NextResponse } from "next/server";
import { deleteWorkflow } from "@/lib/storedWorkflows";
import { removeSchedulesForWorkflow } from "@/lib/schedules";

export async function DELETE(_: NextRequest, { params }: { params: { workflowId: string } }) {
  const workflowId = params?.workflowId;
  if (!workflowId) {
    return NextResponse.json({ ok: false, message: "workflowId missing" }, { status: 400 });
  }

  const deleted = deleteWorkflow(workflowId);
  if (!deleted) {
    return NextResponse.json({ ok: false, message: "Workflow not found" }, { status: 404 });
  }

  removeSchedulesForWorkflow(workflowId);
  return NextResponse.json({ ok: true, workflowId });
}
