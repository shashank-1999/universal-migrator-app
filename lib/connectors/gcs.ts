import { Storage } from "@google-cloud/storage";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { Row, SchemaColumn } from "../types";

type GcsCfg = { projectId?: string; bucket: string; key: string; keyFilename?: string };

const bucket = (c: GcsCfg) => {
  const s = c.keyFilename ? new Storage({ projectId: c.projectId, keyFilename: c.keyFilename }) : new Storage({ projectId: c.projectId });
  return s.bucket(c.bucket);
};

async function getCsv(cfg: GcsCfg): Promise<string> {
  const [buf] = await bucket(cfg).file(cfg.key).download();
  return buf.toString("utf8");
}

export async function gcsSchema(cfg: GcsCfg): Promise<SchemaColumn[]> {
  const csv = await getCsv(cfg);
  const rows = parse(csv, { columns: true, skip_empty_lines: true });
  const first = rows[0] || {};
  return Object.keys(first).map((k) => ({ name: k, type: "STRING" }));
}

export async function gcsReadRows(cfg: GcsCfg): Promise<Row[]> {
  const csv = await getCsv(cfg);
  return parse(csv, { columns: true, skip_empty_lines: true });
}

export async function gcsWriteRows(cfg: GcsCfg, rows: Row[]): Promise<void> {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const csv = stringify(rows, { header: true, columns: cols });
  await bucket(cfg).file(cfg.key).save(csv, { contentType: "text/csv" });
}
