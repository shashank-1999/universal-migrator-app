// lib/connectors/postgres.ts
import { Client } from "pg";
import { Row, SchemaColumn } from "../types";

export type PgCfg = {
  host: string;
  port?: number | string;
  user: string;
  password: string;
  database: string;
  schema?: string; // default 'public'
  table?: string;
  query?: string;
  ssl?: boolean;   // optional; off by default for local docker
};

const pgClient = (c: PgCfg) =>
  new Client({
    host: c.host,
    port: c.port ? Number(c.port) : 5432,
    user: c.user,
    password: c.password,
    database: c.database,
    ssl: c.ssl ? { rejectUnauthorized: false } : undefined,
  });

/** Connection test used by /api/test-connection */
export async function pgTestConnection(cfg: PgCfg) {
  const client = pgClient(cfg);
  try {
    await client.connect();
    await client.query("SELECT 1");
    return { ok: true as const, message: "Postgres connection OK" };
  } catch (err: any) {
    return { ok: false as const, message: err?.message || String(err) };
  } finally {
    try {
      await client.end();
    } catch {}
  }
}

/** Fetch table schema (column name + PG data type) */
export async function pgSchema(cfg: PgCfg): Promise<SchemaColumn[]> {
  const client = pgClient(cfg);
  await client.connect();
  try {
    if (!cfg.table) {
      throw new Error("Postgres schema discovery requires 'table'");
    }
    const sch = cfg.schema || "public";
    const q = `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `;
    const r = await client.query(q, [sch, cfg.table]);
    return r.rows.map((x: any) => ({
      name: x.column_name,
      type: String(x.data_type).toUpperCase(),
    }));
  } finally {
    await client.end();
  }
}

/** Read all rows from schema.table */
export async function pgReadRows(cfg: PgCfg): Promise<Row[]> {
  const client = pgClient(cfg);
  await client.connect();
  try {
    const rawQuery = (cfg.query || "").trim();
    if (rawQuery) {
      const lowered = rawQuery.toLowerCase();
      if (!lowered.startsWith("select") && !lowered.startsWith("with")) {
        throw new Error("Postgres query must start with SELECT or WITH");
      }
      const r = await client.query(rawQuery);
      return r.rows as Row[];
    }

    if (!cfg.table) {
      throw new Error("Postgres source requires a table or query");
    }

    const sch = cfg.schema || "public";
    const r = await client.query(`SELECT * FROM "${sch}"."${cfg.table}"`);
    return r.rows as Row[];
  } finally {
    await client.end();
  }
}

/** Insert rows into schema.table (naive row-by-row insert) */
export async function pgWriteRows(cfg: PgCfg, rows: Row[]): Promise<void> {
  if (!rows.length) return;
  if (!cfg.table) {
    throw new Error("Postgres destination requires 'table'");
  }
  const client = pgClient(cfg);
  await client.connect();
  try {
    const sch = cfg.schema || "public";
    const cols = Object.keys(rows[0]);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const sql = `INSERT INTO "${sch}"."${cfg.table}" (${cols
      .map((c) => `"${c}"`)
      .join(",")}) VALUES (${placeholders})`;
    for (const row of rows) {
      await client.query(sql, cols.map((c) => (row as any)[c]));
    }
  } finally {
    await client.end();
  }
}
