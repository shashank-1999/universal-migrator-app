import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Row, SchemaColumn } from "../types";
import { serializeRows, readStructuredOrBinary, StorageFormat } from "../objectStorage";
import { appendTimestampToFilename } from "../filenameHelper";

type S3Cfg = {
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  bucket: string;
  key: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  format?: StorageFormat;
};

const DEFAULT_REGION = "us-east-1";

const createClient = (cfg: S3Cfg) =>
  new S3Client({
    region: cfg.region || DEFAULT_REGION,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle ?? false,
    credentials:
      cfg.accessKeyId && cfg.secretAccessKey
        ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
        : undefined,
  });

const getObjectBuffer = async (cfg: S3Cfg): Promise<Buffer> => {
  const r = await createClient(cfg).send(new GetObjectCommand({ Bucket: cfg.bucket, Key: cfg.key }));
  // @ts-ignore
  const arr = await r.Body.transformToByteArray();
  return Buffer.from(arr);
};

export async function s3Schema(cfg: S3Cfg): Promise<SchemaColumn[]> {
  const buf = await getObjectBuffer(cfg);
  const { format, rows } = await readStructuredOrBinary(buf, cfg.format);
  const first = rows[0] || {};
  return Object.keys(first).map((k) => ({ name: k, type: "STRING" }));
}

export async function s3ReadRows(cfg: S3Cfg): Promise<Row[]> {
  const buf = await getObjectBuffer(cfg);
  const { format, rows } = await readStructuredOrBinary(buf, cfg.format);
  if (format === "binary") {
    throw new Error(
      "Source object is not CSV/Parquet; detected binary payload (use a structured file or destination storage)."
    );
  }
  return rows;
}

type WriteOptions = { isCancelled?: () => boolean };

export async function s3WriteRows(cfg: S3Cfg, rows: Row[], options?: WriteOptions): Promise<void> {
  if (options?.isCancelled?.()) throw new Error("Run cancelled by user");
  const format = (cfg.format as "csv" | "parquet") ?? "csv";
  const { buffer, contentType } = await serializeRows(rows, format);
  const keyWithTimestamp = appendTimestampToFilename(cfg.key);
  await createClient(cfg).send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: keyWithTimestamp,
      Body: buffer,
      ContentType: contentType,
    })
  );
}

export async function s3QuickCheck(cfg: S3Cfg): Promise<void> {
  await createClient(cfg).send(new ListObjectsV2Command({ Bucket: cfg.bucket, MaxKeys: 1 }));
}

export async function s3Probe(cfg: S3Cfg, length = 4096): Promise<Buffer> {
  const result = await createClient(cfg).send(
    new GetObjectCommand({ Bucket: cfg.bucket, Key: cfg.key, Range: `bytes=0-${length - 1}` })
  );
  // @ts-ignore
  const arr = await result.Body.transformToByteArray();
  return Buffer.from(arr);
}

const minioConfig = (cfg: S3Cfg): S3Cfg => ({
  ...cfg,
  region: cfg.region || DEFAULT_REGION,
  forcePathStyle: true,
});

export async function minioSchema(cfg: S3Cfg): Promise<SchemaColumn[]> {
  return s3Schema(minioConfig(cfg));
}

export async function minioReadRows(cfg: S3Cfg): Promise<Row[]> {
  return s3ReadRows(minioConfig(cfg));
}

export async function minioWriteRows(cfg: S3Cfg, rows: Row[], options?: WriteOptions): Promise<void> {
  return s3WriteRows(minioConfig(cfg), rows, options);
}

export async function minioQuickCheck(cfg: S3Cfg): Promise<void> {
  return s3QuickCheck(minioConfig(cfg));
}

export async function minioProbe(cfg: S3Cfg, length = 4096): Promise<Buffer> {
  return s3Probe(minioConfig(cfg), length);
}
