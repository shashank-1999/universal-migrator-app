// lib/connectors/mysql.ts
import mysql from "mysql2/promise";
import { Row, SchemaColumn } from "../types";

export type MyCfg = {
  host: string;
  port?: number | string;
  user: string;
  password: string;
  database: string;
  table: string;
};

function open(cfg: MyCfg) {
  return mysql.createConnection({
    host: cfg.host,
    port: cfg.port ? Number(cfg.port) : 3306,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
  });
}

export async function mysqlTestConnection(cfg: MyCfg): Promise<void> {
  // Validate required fields
  if (!cfg.host || !cfg.user || !cfg.password || !cfg.database) {
    throw new Error("MySQL requires: host, user, password, database");
  }
  const conn = await open(cfg);
  try {
    await conn.query("SELECT 1");
  } finally {
    await conn.end();
  }
}

export async function mysqlSchema(cfg: MyCfg): Promise<SchemaColumn[]> {
  const conn = await open(cfg);
  try {
    const sql = `
      SELECT COLUMN_NAME AS name, DATA_TYPE AS type
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `;
    const [rows] = await conn.query(sql, [cfg.database, cfg.table]);
    return (rows as any[]).map((r) => ({
      name: String(r.name),
      type: String(r.type).toUpperCase(),
    }));
  } finally {
    await conn.end();
  }
}

export async function mysqlReadRows(cfg: MyCfg & { query?: string }): Promise<Row[]> {
  const conn = await open(cfg);
  try {
    if (cfg.query?.trim()) {
      // Use custom query if provided
      const [rows] = await conn.query(cfg.query);
      return rows as Row[];
    } else {
      // Fall back to selecting all from table
      const sql = `SELECT * FROM \`${cfg.database}\`.\`${cfg.table}\``;
      const [rows] = await conn.query(sql);
      return rows as Row[];
    }
  } finally {
    await conn.end();
  }
}

export async function mysqlCreateTable(cfg: MyCfg, createTableSQL: string): Promise<void> {
  const conn = await open(cfg);
  try {
    await conn.query(createTableSQL);
  } finally {
    await conn.end();
  }
}

export async function mysqlTruncateTable(cfg: MyCfg): Promise<void> {
  const conn = await open(cfg);
  try {
    const sql = `TRUNCATE TABLE \`${cfg.database}\`.\`${cfg.table}\``;
    await conn.query(sql);
  } finally {
    await conn.end();
  }
}

type WriteOptions = { isCancelled?: () => boolean };

export async function mysqlWriteRows(cfg: MyCfg & { createTable?: boolean }, rows: Row[], options?: WriteOptions): Promise<void> {
  if (!rows?.length) return;
  const conn = await open(cfg);
  try {
    const cols = Object.keys(rows[0]);
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      if (options?.isCancelled?.()) throw new Error("Run cancelled by user");
      const chunk = rows.slice(i, i + chunkSize);
      const placeholders = chunk
        .map(() => `(${cols.map(() => "?").join(",")})`)
        .join(",");
      const sql = `INSERT INTO \`${cfg.database}\`.\`${cfg.table}\` (${cols
        .map((c) => `\`${c}\``)
        .join(",")}) VALUES ${placeholders}`;
      const args = chunk.flatMap((r) => cols.map((c) => (r as any)[c]));
      await conn.query(sql, args);
    }
  } finally {
    await conn.end();
  }
}
