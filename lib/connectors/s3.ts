import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { Row, SchemaColumn } from "../types";

type S3Cfg = { region: string; bucket: string; key: string; accessKeyId?: string; secretAccessKey?: string };

const client = (c: S3Cfg) =>
  new S3Client({
    region: c.region,
    credentials: c.accessKeyId && c.secretAccessKey ? { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey } : undefined,
  });

async function getCsv(cfg: S3Cfg): Promise<string> {
  const r = await client(cfg).send(new GetObjectCommand({ Bucket: cfg.bucket, Key: cfg.key }));
  // @ts-ignore
  return await r.Body.transformToString();
}

export async function s3Schema(cfg: S3Cfg): Promise<SchemaColumn[]> {
  const csv = await getCsv(cfg);
  const rows = parse(csv, { columns: true, skip_empty_lines: true });
  const first = rows[0] || {};
  return Object.keys(first).map((k) => ({ name: k, type: "STRING" }));
}

export async function s3ReadRows(cfg: S3Cfg): Promise<Row[]> {
  const csv = await getCsv(cfg);
  return parse(csv, { columns: true, skip_empty_lines: true });
}

export async function s3WriteRows(cfg: S3Cfg, rows: Row[]): Promise<void> {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const csv = stringify(rows, { header: true, columns: cols });
  await client(cfg).send(new PutObjectCommand({ Bucket: cfg.bucket, Key: cfg.key, Body: csv, ContentType: "text/csv" }));
}
