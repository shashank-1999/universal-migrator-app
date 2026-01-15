import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { Row, SchemaColumn } from "../types";
import { serializeRows, readStructuredOrBinary, StorageFormat } from "../objectStorage";
import { appendTimestampToFilename } from "../filenameHelper";

type AzCfg = {
  connectionString?: string;
  accountName?: string;
  accountKey?: string;
  container: string;
  blob: string; // path inside container
  format?: StorageFormat;
};

function svc(cfg: AzCfg) {
  if (cfg.connectionString) return BlobServiceClient.fromConnectionString(cfg.connectionString);
  return new BlobServiceClient(
    `https://${cfg.accountName}.blob.core.windows.net`,
    new StorageSharedKeyCredential(cfg.accountName!, cfg.accountKey!)
  );
}

async function getBuffer(cfg: AzCfg): Promise<Buffer> {
  const client = svc(cfg);
  const cc = client.getContainerClient(cfg.container);
  const bc = cc.getBlockBlobClient(cfg.blob);
  const dl = await bc.download();
  const buf = await streamToBuffer(dl.readableStreamBody!);
  return buf;
}

export async function azureBlobProbe(cfg: AzCfg, length = 4096): Promise<Buffer> {
  const client = svc(cfg);
  const cc = client.getContainerClient(cfg.container);
  const bc = cc.getBlockBlobClient(cfg.blob);
  const dl = await bc.download(0, length);
  return streamToBuffer(dl.readableStreamBody!);
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
  const buf = await getBuffer(cfg);
  const { rows } = await readStructuredOrBinary(buf, cfg.format);
  const first = rows[0] || {};
  return Object.keys(first).map((k) => ({ name: k, type: "STRING" }));
}

export async function azReadRows(cfg: AzCfg): Promise<Row[]> {
  const buf = await getBuffer(cfg);
  const { format, rows } = await readStructuredOrBinary(buf, cfg.format);
  if (format === "binary") {
    throw new Error(
      "Source object is not CSV/Parquet; detected binary payload (use a structured file or destination storage)."
    );
  }
  return rows;
}

// Aliases for consistency with other connectors
export const azureBlobReadRows = azReadRows;

type WriteOptions = { isCancelled?: () => boolean };

export async function azWriteRows(cfg: AzCfg, rows: Row[], options?: WriteOptions): Promise<void> {
  if (options?.isCancelled?.()) throw new Error("Run cancelled by user");
  const format = (cfg.format as "csv" | "parquet") ?? "csv";
  const { buffer, contentType } = await serializeRows(rows, format);
  const blobWithTimestamp = appendTimestampToFilename(cfg.blob);
  const client = svc(cfg);
  const cc = client.getContainerClient(cfg.container);
  const bc = cc.getBlockBlobClient(blobWithTimestamp);
  await bc.upload(buffer, buffer.length, { blobHTTPHeaders: { blobContentType: contentType } });
}

// Alias for consistency with other connectors
export const azureBlobWriteRows = azWriteRows;

export async function azureBlobQuickCheck(cfg: AzCfg): Promise<void> {
  // Check if container exists and is accessible
  const client = svc(cfg);
  const cc = client.getContainerClient(cfg.container);
  await cc.exists();
}
