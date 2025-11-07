import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function GET(_: Request, { params }: { params: { runId: string }}) {
  const fp = path.join(process.cwd(), ".runs", params.runId, "run.jsonl");
  try {
    const txt = await fs.readFile(fp, "utf8");
    return new Response(txt, { headers: { "Content-Type": "text/plain" }});
  } catch {
    return new Response("Not found", { status: 404 });
  }
}