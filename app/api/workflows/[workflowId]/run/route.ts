import { NextRequest, NextResponse } from "next/server";
import { listWorkflows } from "@/lib/storedWorkflows";

export async function POST(
  req: NextRequest,
  { params }: { params: { workflowId: string } }
) {
  const workflowId = params.workflowId;
  const workflow = listWorkflows().find((wf) => wf.id === workflowId);
  if (!workflow) {
    return NextResponse.json(
      { ok: false, message: "Workflow not found" },
      { status: 404 }
    );
  }

  const runUrl = new URL("/api/run", req.url);
  const headers = new Headers({
    "Content-Type": "application/json",
  });
  const authorization = req.headers.get("authorization");
  if (authorization) {
    headers.set("authorization", authorization);
  }
  const cookie = req.headers.get("cookie");
  if (cookie) {
    headers.set("cookie", cookie);
  }

  try {
    const runResponse = await fetch(runUrl.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        spec: workflow.spec,
        audit: {
          workflowOwner: workflow.createdBy?.trim() || workflow.name,
          workflowName: workflow.name,
        },
      }),
    });
    const payload = await runResponse.json();
    return NextResponse.json(payload, { status: runResponse.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to run workflow";
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
