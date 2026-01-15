import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

const sanitizeFileName = (name: string) => name.replace(/[^\w.\-]+/g, "_");

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const chunk = form.get("chunk") as File | null;
    const fileId = form.get("fileId")?.toString();
    const chunkIndexRaw = form.get("chunkIndex");
    const totalChunksRaw = form.get("totalChunks");
    const fileName = form.get("fileName")?.toString() || "upload.bin";

    if (!chunk || !fileId || chunkIndexRaw === null || totalChunksRaw === null) {
      return NextResponse.json(
        { ok: false, message: "Missing upload chunk metadata" },
        { status: 400 }
      );
    }

    const chunkIndex = Number(chunkIndexRaw);
    const totalChunks = Number(totalChunksRaw);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || !Number.isInteger(totalChunks) || totalChunks <= 0) {
      return NextResponse.json({ ok: false, message: "Invalid chunk indices" }, { status: 400 });
    }

    const safeName = sanitizeFileName(fileName);
    const storedName = `${fileId}_${safeName}`;
    const targetPath = path.join(UPLOAD_DIR, storedName);

    fs.mkdirSync(UPLOAD_DIR, { recursive: true });

    const buffer = Buffer.from(await chunk.arrayBuffer());
    if (chunkIndex === 0) {
      await fs.promises.writeFile(targetPath, buffer);
    } else {
      await fs.promises.appendFile(targetPath, buffer);
    }

    const responsePayload: Record<string, unknown> = {
      ok: true,
      chunkIndex,
      totalChunks,
    };
    if (chunkIndex + 1 === totalChunks) {
      responsePayload.path = targetPath;
      responsePayload.name = fileName;
    }

    return NextResponse.json(responsePayload);
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : "Chunk upload failed" },
      { status: 500 }
    );
  }
}
