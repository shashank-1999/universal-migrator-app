import sql from "mssql";
import { Row, SchemaColumn } from "../types";

type MsCfg = {
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  schema?: string;   // default "dbo"
  table: string;
};

function toPoolConfig(c: MsCfg): sql.config {
  return {
    server: c.host,
    port: c.port ? Number(c.port) : 1433,
    user: c.user,
    password: c.password,
    database: c.database,
    options: {
      encrypt: false,
      trustServerCertificate: true,
    },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  };
}

export async function mssqlTestConnection(cfg: MsCfg): Promise<void> {
  const pool = new sql.ConnectionPool(toPoolConfig(cfg));
  await pool.connect();
  try {
    await pool.request().query("SELECT 1");
  } finally {
    await pool.close();
  }
}

export async function mssqlSchema(cfg: MsCfg): Promise<SchemaColumn[]> {
  const sch = cfg.schema || "dbo";
  const pool = new sql.ConnectionPool(toPoolConfig(cfg));
  await pool.connect();
  try {
    const r = await pool.request()
      .input("schema", sql.NVarChar, sch)
      .input("table", sql.NVarChar, cfg.table)
      .query(`
        SELECT c.name       AS column_name,
               t.name       AS data_type
        FROM sys.columns c
        JOIN sys.types   t ON c.user_type_id = t.user_type_id
        WHERE c.object_id = OBJECT_ID(CONCAT(@schema, '.', @table))
        ORDER BY c.column_id
      `);
    return r.recordset.map((x: any) => ({
      name: x.column_name,
      type: String(x.data_type).toUpperCase(),
    }));
  } finally {
    await pool.close();
  }
}

export async function mssqlReadRows(cfg: MsCfg): Promise<Row[]> {
  const sch = cfg.schema || "dbo";
  const pool = new sql.ConnectionPool(toPoolConfig(cfg));
  await pool.connect();
  try {
    const r = await pool.request().query(`SELECT * FROM [${sch}].[${cfg.table}]`);
    return r.recordset as Row[];
  } finally {
    await pool.close();
  }
}

/** Return identity column name if table has one, else null */
async function getIdentityColumn(pool: sql.ConnectionPool, schema: string, table: string): Promise<string | null> {
  const q = await pool.request()
    .input("schema", sql.NVarChar, schema)
    .input("table", sql.NVarChar, table)
    .query(`
      SELECT c.name AS identity_col
      FROM sys.columns c
      WHERE c.object_id = OBJECT_ID(CONCAT(@schema, '.', @table))
        AND c.is_identity = 1
    `);
  return q.recordset.length ? (q.recordset[0].identity_col as string) : null;
}

export async function mssqlWriteRows(cfg: MsCfg, rows: Row[]): Promise<void> {
  if (!rows.length) return;

  const sch = cfg.schema || "dbo";
  const pool = new sql.ConnectionPool(toPoolConfig(cfg));
  await pool.connect();
  try {
    const cols = Object.keys(rows[0]);
    const tbl = `[${sch}].[${cfg.table}]`;

    // If table has an IDENTITY col and we're providing it, enable IDENTITY_INSERT
    const identityCol = await getIdentityColumn(pool, sch, cfg.table);
    const willSupplyIdentity =
      identityCol ? cols.map((c) => c.toLowerCase()).includes(identityCol.toLowerCase()) : false;

    if (willSupplyIdentity) {
      await pool.request().query(`SET IDENTITY_INSERT ${tbl} ON;`);
    }

    try {
      // param placeholders like (@p_0_0, @p_0_1, ...)
      const valuesExpr = rows
        .map((_, i) => "(" + cols.map((_, j) => `@p_${i}_${j}`).join(", ") + ")")
        .join(", ");

      const req = pool.request();
      rows.forEach((row, i) => cols.forEach((c, j) => req.input(`p_${i}_${j}`, (row as any)[c])));

      const sqlText = `INSERT INTO ${tbl} (${cols.map((c) => `[${c}]`).join(", ")}) VALUES ${valuesExpr}`;
      await req.query(sqlText);
    } finally {
      if (willSupplyIdentity) {
        await pool.request().query(`SET IDENTITY_INSERT ${tbl} OFF;`);
      }
    }
  } finally {
    await pool.close();
  }
}
