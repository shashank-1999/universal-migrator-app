import oracledb from "oracledb";

export type OracleCfg = {
  host: string;
  port?: string | number;
  service: string;        // service name (e.g., XEPDB1)
  user: string;
  password: string;
  schema?: string;        // optional, used for schema discovery and unqualified table names
  table?: string;         // when used as source/destination table
};

function toConnectString(cfg: OracleCfg) {
  const port = cfg.port ? String(cfg.port) : "1521";
  // EZCONNECT style: host:port/service
  return `${cfg.host}:${port}/${cfg.service}`;
}

export async function oracleTestConnection(cfg: OracleCfg) {
  const conn = await oracledb.getConnection({
    user: cfg.user,
    password: cfg.password,
    connectString: toConnectString(cfg),
  });
  try {
    await conn.execute(`select 1 from dual`);
  } finally {
    await conn.close();
  }
}

export async function oracleGetColumns(cfg: OracleCfg, table?: string) {
  // Determine owner + table name
  let owner: string | undefined = cfg.schema?.toUpperCase();
  let tname = (table || cfg.table || "").trim();

  if (tname.includes(".")) {
    const [o, t] = tname.split(".");
    owner = o.toUpperCase();
    tname = t.toUpperCase();
  } else {
    tname = tname.toUpperCase();
    if (!owner) {
      // Try to infer owner from current user
      owner = cfg.user.toUpperCase();
    }
  }

  const conn = await oracledb.getConnection({
    user: cfg.user,
    password: cfg.password,
    connectString: toConnectString(cfg),
  });

  try {
    // USER_TAB_COLUMNS sees only current user’s tables; ALL_TAB_COLUMNS sees accessible tables
    const sql = `
      SELECT COLUMN_NAME, DATA_TYPE
        FROM ALL_TAB_COLUMNS
       WHERE OWNER = :owner
         AND TABLE_NAME = :tname
       ORDER BY COLUMN_ID
    `;
    const res = await conn.execute(sql, { owner, tname }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    const cols = (res.rows || []).map((r: any) => ({
      name: r.COLUMN_NAME,
      type: r.DATA_TYPE,
    }));
    return cols;
  } finally {
    await conn.close();
  }
}

export type Row = Record<string, any>;

/** Reads rows from a table as source (simple SELECT *). */
export async function oracleReadRows(cfg: OracleCfg): Promise<Row[]> {
  if (!cfg.table) throw new Error("Oracle source requires 'table'");
  const conn = await oracledb.getConnection({
    user: cfg.user,
    password: cfg.password,
    connectString: toConnectString(cfg),
  });
  try {
    const sql = `SELECT * FROM ${cfg.table}`;
    const res = await conn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (res.rows || []) as Row[];
  } finally {
    await conn.close();
  }
}

/** Writes rows to a table as destination (INSERT). */
export async function oracleWriteRows(cfg: OracleCfg, rows: Row[]) {
  if (!cfg.table) throw new Error("Oracle destination requires 'table'");
  if (!rows.length) return;

  const cols = Object.keys(rows[0]);
  const colList = cols.map((c) => `"${c}"`).join(", ");
  const bindList = cols.map((_, i) => `:${i + 1}`).join(", ");
  const sql = `INSERT INTO ${cfg.table} (${colList}) VALUES (${bindList})`;

  const conn = await oracledb.getConnection({
    user: cfg.user,
    password: cfg.password,
    connectString: toConnectString(cfg),
    // For better bulk throughput you can tune statementCacheSize, etc.
  });

  try {
    const binds = rows.map((r) => cols.map((c) => r[c]));
    await conn.executeMany(sql, binds);
    await conn.commit();
  } finally {
    await conn.close();
  }
}
