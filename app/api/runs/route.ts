import { listSummaries } from "@/lib/logs";
export async function GET() {
  const runs = await listSummaries();
  return Response.json({ runs });
}