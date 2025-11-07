import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ ok: false, message: "No file" }, { status: 400 });

    const arrayBuffer = await file.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);

    // ensure uploads dir exists
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });

    const safeName = file.name.replace(/[^\w.\-]+/g, "_");
    const id = crypto.randomBytes(6).toString("hex");
    const storedName = `${Date.now()}_${id}_${safeName}`;
    const storedPath = path.join(UPLOAD_DIR, storedName);

    fs.writeFileSync(storedPath, buf);

    // return a path the connectors can use
    return NextResponse.json({
      ok: true,
      path: storedPath, // absolute path used by csv/excel connectors
      name: file.name,
      size: file.size,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, message: e?.message || "Upload failed" }, { status: 500 });
  }
}
