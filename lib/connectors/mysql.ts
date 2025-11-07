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

export async function mysqlReadRows(cfg: MyCfg): Promise<Row[]> {
  const conn = await open(cfg);
  try {
    const sql = `SELECT * FROM \`${cfg.database}\`.\`${cfg.table}\``;
    const [rows] = await conn.query(sql);
    return rows as Row[];
  } finally {
    await conn.end();
  }
}

export async function mysqlWriteRows(cfg: MyCfg, rows: Row[]): Promise<void> {
  if (!rows?.length) return;
  const conn = await open(cfg);
  try {
    const cols = Object.keys(rows[0]);
    const placeholders = `(${cols.map(() => "?").join(",")})`;
    const sql = `INSERT INTO \`${cfg.database}\`.\`${cfg.table}\` (${cols
      .map((c) => `\`${c}\``)
      .join(",")}) VALUES ${rows.map(() => placeholders).join(",")}`;
    const args = rows.flatMap((r) => cols.map((c) => (r as any)[c]));
    await conn.query(sql, args);
  } finally {
    await conn.end();
  }
}
