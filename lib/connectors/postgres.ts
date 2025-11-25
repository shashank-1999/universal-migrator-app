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
  table: string;
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
  // Validate required fields
  if (!cfg.host || !cfg.user || !cfg.password || !cfg.database) {
    throw new Error("PostgreSQL requires: host, user, password, database");
  }
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
    const sch = cfg.schema || "public";
    const q = `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `;
    const r = await client.query(q, [sch, cfg.table]);
    return r.rows.map((x) => ({
      name: x.column_name,
      type: String(x.data_type).toUpperCase(),
    }));
  } finally {
    await client.end();
  }
}

/** Read all rows from schema.table */
export async function pgReadRows(cfg: PgCfg & { query?: string }): Promise<Row[]> {
  const client = pgClient(cfg);
  await client.connect();
  try {
    if (cfg.query?.trim()) {
      // Use custom query if provided
      const r = await client.query(cfg.query);
      return r.rows as Row[];
    } else {
      // Fall back to selecting all from table
      const sch = cfg.schema || "public";
      const r = await client.query(`SELECT * FROM "${sch}"."${cfg.table}"`);
      return r.rows as Row[];
    }
  } finally {
    await client.end();
  }
}

/** Create table if it doesn't exist */
export async function pgCreateTable(cfg: PgCfg, createTableSQL: string): Promise<void> {
  const client = pgClient(cfg);
  await client.connect();
  try {
    await client.query(createTableSQL);
  } finally {
    await client.end();
  }
}

export async function pgTruncateTable(cfg: PgCfg): Promise<void> {
  const client = pgClient(cfg);
  await client.connect();
  try {
    const sch = cfg.schema || "public";
    await client.query(`TRUNCATE TABLE "${sch}"."${cfg.table}" RESTART IDENTITY`);
  } finally {
    await client.end();
  }
}

/** Insert rows into schema.table (naive row-by-row insert) */
type WriteOptions = { isCancelled?: () => boolean };

export async function pgWriteRows(cfg: PgCfg & { createTable?: boolean }, rows: Row[], options?: WriteOptions): Promise<void> {
  if (!rows.length) return;
  const client = pgClient(cfg);
  await client.connect();
  try {
    if (options?.isCancelled?.()) throw new Error("Run cancelled by user");
    const sch = cfg.schema || "public";
    const cols = Object.keys(rows[0]);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const sql = `INSERT INTO "${sch}"."${cfg.table}" (${cols
      .map((c) => `"${c}"`)
      .join(",")}) VALUES (${placeholders})`;
    for (const row of rows) {
      if (options?.isCancelled?.()) throw new Error("Run cancelled by user");
      await client.query(sql, cols.map((c) => (row as any)[c]));
    }
  } finally {
    await client.end();
  }
}
