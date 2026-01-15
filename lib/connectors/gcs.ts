import { Storage } from "@google-cloud/storage";
import { Row, SchemaColumn } from "../types";
import { serializeRows, readStructuredOrBinary, StorageFormat } from "../objectStorage";
import { appendTimestampToFilename } from "../filenameHelper";

type GcsCfg = {
  projectId?: string;
  bucket: string;
  key: string;
  keyFilename?: string;
  format?: StorageFormat;
};

const bucket = (c: GcsCfg) => {
  const s = c.keyFilename ? new Storage({ projectId: c.projectId, keyFilename: c.keyFilename }) : new Storage({ projectId: c.projectId });
  return s.bucket(c.bucket);
};

async function getBuffer(cfg: GcsCfg): Promise<Buffer> {
  const [buf] = await bucket(cfg).file(cfg.key).download();
  return buf;
}

export async function gcsProbe(cfg: GcsCfg, length = 4096): Promise<Buffer> {
  const [buf] = await bucket(cfg).file(cfg.key).download({ start: 0, end: length - 1 });
  return buf;
}

export async function gcsSchema(cfg: GcsCfg): Promise<SchemaColumn[]> {
  const buf = await getBuffer(cfg);
  const { rows } = await readStructuredOrBinary(buf, cfg.format);
  const first = rows[0] || {};
  return Object.keys(first).map((k) => ({ name: k, type: "STRING" }));
}

export async function gcsReadRows(cfg: GcsCfg): Promise<Row[]> {
  const buf = await getBuffer(cfg);
  const { format, rows } = await readStructuredOrBinary(buf, cfg.format);
  if (format === "binary") {
    throw new Error(
      "Source object is not CSV/Parquet; detected binary payload (use a structured file or destination storage)."
    );
  }
  return rows;
}

type WriteOptions = { isCancelled?: () => boolean };

export async function gcsWriteRows(cfg: GcsCfg, rows: Row[], options?: WriteOptions): Promise<void> {
  if (options?.isCancelled?.()) throw new Error("Run cancelled by user");
  const format = (cfg.format as "csv" | "parquet") ?? "csv";
  const { buffer, contentType } = await serializeRows(rows, format);
  const keyWithTimestamp = appendTimestampToFilename(cfg.key);
  await bucket(cfg).file(keyWithTimestamp).save(buffer, { contentType });
}

export async function gcsQuickCheck(cfg: GcsCfg): Promise<void> {
  // Just try to check if bucket exists and is accessible
  const b = bucket(cfg);
  await b.exists();
}
