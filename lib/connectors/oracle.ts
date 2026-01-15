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
  // Validate required fields
  if (!cfg.host || !cfg.service || !cfg.user || !cfg.password) {
    throw new Error("Oracle requires: host, service, user, password");
  }
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
    const cols = (res.rows || []).map((r: Record<string, unknown>) => ({
      name: String(r.COLUMN_NAME),
      type: String(r.DATA_TYPE),
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
    // Optimize with prefetch for better throughput
    const res = await conn.execute(sql, [], { 
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      prefetchRows: 10000, // Fetch 10K rows at a time
      fetchArraySize: 10000 // Increase fetch buffer
    });
    return (res.rows || []) as Row[];
  } finally {
    await conn.close();
  }
}

type StreamOptions = { isCancelled?: () => boolean };

export async function oracleReadStream(
  cfg: OracleCfg,
  options?: StreamOptions
): Promise<AsyncGenerator<Row>> {
  if (!cfg.table) throw new Error("Oracle source requires 'table'");
  const conn = await oracledb.getConnection({
    user: cfg.user,
    password: cfg.password,
    connectString: toConnectString(cfg),
  });

  return (async function* () {
    let resultSet: any | undefined;
    try {
      const sql = `SELECT * FROM ${cfg.table}`;
      const res = await conn.execute(sql, [], {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        resultSet: true,
        prefetchRows: 10000,
        fetchArraySize: 10000,
      });
      resultSet = res.resultSet as any;
      const batchSize = 1000;
      while (resultSet) {
        if (options?.isCancelled?.()) {
          break;
        }
        const rows = await resultSet.getRows(batchSize);
        if (!rows.length) break;
        for (const row of rows) {
          if (options?.isCancelled?.()) {
            break;
          }
          yield row as Row;
        }
      }
    } finally {
      try {
        await resultSet?.close();
      } catch {}
      await conn.close().catch(() => {});
    }
  })();
}

/** Writes rows to a table as destination (INSERT). */
type WriteOptions = { 
  isCancelled?: () => boolean;
  oracleConnections?: any[]; // Persistent connection pool (reuse across batches)
};

export async function oracleWriteRows(cfg: OracleCfg, rows: Row[], options?: WriteOptions) {
  if (!cfg.table) throw new Error("Oracle destination requires 'table'");
  if (!rows.length) return;

  const cols = Object.keys(rows[0]);
  const colList = cols.map((c) => `"${c}"`).join(", ");
  const bindList = cols.map((_, i) => `:${i + 1}`).join(", ");
  const sql = `INSERT INTO ${cfg.table} (${colList}) VALUES (${bindList})`;

  const chunkSize = 5000; // Optimal for Oracle executeMany (memory-efficient)
  const poolSize = 8;
  
  // Use persistent connections if provided, otherwise create temporary ones
  const usePersistentPool = !!options?.oracleConnections;
  const connections = options?.oracleConnections || [];
  
  if (!usePersistentPool) {
    // Create temporary connections
    for (let i = 0; i < poolSize; i++) {
      const conn = await oracledb.getConnection({
        user: cfg.user,
        password: cfg.password,
        connectString: toConnectString(cfg),
      });
      connections.push(conn);
    }
  }
  
  const rowsPerWorker = Math.ceil(rows.length / poolSize);

  const worker = async (conn: any, workerIdx: number) => {
    const startIdx = workerIdx * rowsPerWorker;
    const endIdx = Math.min(startIdx + rowsPerWorker, rows.length);
    const myRows = rows.slice(startIdx, endIdx);
    if (!myRows.length) return;

    try {
      for (let i = 0; i < myRows.length; i += chunkSize) {
        if (options?.isCancelled?.()) throw new Error("Run cancelled by user");
        const chunk = myRows.slice(i, i + chunkSize);
        const binds = chunk.map((r) => cols.map((c) => r[c]));
        await conn.executeMany(sql, binds, { autoCommit: true, batchErrors: false });
      }
    } catch (err) {
      // Only close connection on error if we created it
      if (!usePersistentPool) {
        await conn.close().catch(() => {});
      }
      throw err;
    }
  };

  try {
    await Promise.all(connections.map((conn, idx) => worker(conn, idx)));
  } finally {
    // Only close connections if we created them (not using persistent pool)
    if (!usePersistentPool) {
      await Promise.all(connections.map(conn => conn.close().catch(() => {})));
    }
  }
}

export async function oracleCreateTable(cfg: OracleCfg, createTableSQL: string): Promise<void> {
  if (!cfg.table) throw new Error("Oracle destination requires 'table'");
  const conn = await oracledb.getConnection({
    user: cfg.user,
    password: cfg.password,
    connectString: toConnectString(cfg),
  });
  try {
    await conn.execute(createTableSQL);
    await conn.commit();
  } finally {
    await conn.close();
  }
}

export async function oracleTruncateTable(cfg: OracleCfg) {
  if (!cfg.table) throw new Error("Oracle destination requires 'table'");
  const conn = await oracledb.getConnection({
    user: cfg.user,
    password: cfg.password,
    connectString: toConnectString(cfg),
  });
  try {
    await conn.execute(`TRUNCATE TABLE ${cfg.table}`);
    await conn.commit();
  } finally {
    await conn.close();
  }
}
