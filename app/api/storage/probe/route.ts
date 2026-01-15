import { NextRequest, NextResponse } from "next/server";
import { detectFormatFromBuffer } from "@/lib/objectStorage";
import { s3Probe, minioProbe } from "@/lib/connectors/s3";
import { gcsProbe } from "@/lib/connectors/gcs";
import { azureBlobProbe } from "@/lib/connectors/azureBlob";

type ProbeBody = {
  type: "s3" | "minio" | "gcs" | "azureBlob";
  config: Record<string, unknown>;
};

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { type, config } = (await req.json()) as ProbeBody;
    let buffer: Buffer;
    if (type === "s3") {
      buffer = await s3Probe(config as Parameters<typeof s3Probe>[0]);
    } else if (type === "minio") {
      buffer = await minioProbe(config as Parameters<typeof minioProbe>[0]);
    } else if (type === "gcs") {
      buffer = await gcsProbe(config as Parameters<typeof gcsProbe>[0]);
    } else if (type === "azureBlob") {
      buffer = await azureBlobProbe(config as Parameters<typeof azureBlobProbe>[0]);
    } else {
      return NextResponse.json({ ok: false, message: "Unsupported type" }, { status: 400 });
    }

    const format = detectFormatFromBuffer(buffer);
    return NextResponse.json({ ok: true, format });
  } catch (err) {
    return NextResponse.json({ ok: false, message: err instanceof Error ? err.message : "Probe failed" }, { status: 500 });
  }
}
