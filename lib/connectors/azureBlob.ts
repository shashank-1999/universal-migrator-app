import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { Row, SchemaColumn } from "../types";

type AzCfg = {
  connectionString?: string;
  accountName?: string;
  accountKey?: string;
  container: string;
  blob: string; // path inside container
};

function svc(cfg: AzCfg) {
  if (cfg.connectionString) return BlobServiceClient.fromConnectionString(cfg.connectionString);
  return new BlobServiceClient(
    `https://${cfg.accountName}.blob.core.windows.net`,
    new StorageSharedKeyCredential(cfg.accountName!, cfg.accountKey!)
  );
}

async function getCsv(cfg: AzCfg): Promise<string> {
  const client = svc(cfg);
  const cc = client.getContainerClient(cfg.container);
  const bc = cc.getBlockBlobClient(cfg.blob);
  const dl = await bc.download();
  const buf = await streamToBuffer(dl.readableStreamBody!);
  return buf.toString("utf8");
}

function streamToBuffer(stream: NodeJS.ReadableStream) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (d) => chunks.push(Buffer.from(d)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export async function azSchema(cfg: AzCfg): Promise<SchemaColumn[]> {
  const csv = await getCsv(cfg);
  const rows = parse(csv, { columns: true, skip_empty_lines: true });
  const first = rows[0] || {};
  return Object.keys(first).map((k) => ({ name: k, type: "STRING" }));
}

export async function azReadRows(cfg: AzCfg): Promise<Row[]> {
  const csv = await getCsv(cfg);
  return parse(csv, { columns: true, skip_empty_lines: true });
}

export async function azWriteRows(cfg: AzCfg, rows: Row[]): Promise<void> {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const csv = stringify(rows, { header: true, columns: cols });
  const client = svc(cfg);
  const cc = client.getContainerClient(cfg.container);
  const bc = cc.getBlockBlobClient(cfg.blob);
  await bc.upload(csv, Buffer.byteLength(csv), { blobHTTPHeaders: { blobContentType: "text/csv" } });
}
