// lib/connectors/mysql.ts
import mysqlPromise from "mysql2/promise";
import mysqlBase from "mysql2";
import { Row, SchemaColumn } from "../types";

export type MyCfg = {
  host: string;
  port?: number | string;
  user: string;
  password: string;
  database: string;
  table: string;
  // The UI sometimes sends extra fields (path, schema, sheet, etc.). We ignore them for the MySQL driver.
  [key: string]: unknown;
};

const normalizeCfg = (c: MyCfg) => ({
  host: c.host,
  port: c.port ? Number(c.port) : 3306,
  user: c.user,
  password: c.password,
  database: c.database,
  connectTimeout: 30_000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
});

function open(cfg: MyCfg) {
  return mysqlPromise.createConnection(normalizeCfg(cfg));
}

// Ensure database exists (best-effort)
async function ensureDatabase(cfg: MyCfg) {
  const conn = await mysqlPromise.createConnection({
    ...normalizeCfg(cfg),
  });
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${cfg.database}\``);
  } finally {
    await conn.end();
  }
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
    return (rows as Array<Record<string, unknown>>).map((r) => ({
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
      // Use custom query with optimized settings
      await conn.query(`SET SESSION net_buffer_length=1048576`); // 1MB buffer
      const [rows] = await conn.query(cfg.query);
      return rows as Row[];
    } else {
      // Fall back to selecting all from table with optimizations
      await conn.query(`SET SESSION net_buffer_length=1048576`);
      const sql = `SELECT * FROM \`${cfg.database}\`.\`${cfg.table}\``;
      const [rows] = await conn.query(sql);
      return rows as Row[];
    }
  } finally {
    await conn.end();
  }
}

type StreamOptions = { isCancelled?: () => boolean };

export async function mysqlReadStream(
  cfg: MyCfg & { query?: string },
  options?: StreamOptions
): Promise<AsyncGenerator<Row>> {
  const rawQuery = cfg.query?.trim();
  const sql = rawQuery
    ? rawQuery.replace(/;+\s*$/, "")
    : `SELECT * FROM \`${cfg.database}\`.\`${cfg.table}\``;

  const conn = mysqlBase.createConnection(normalizeCfg(cfg));
  await new Promise<void>((resolve, reject) => {
    conn.connect((err) => (err ? reject(err) : resolve()));
  });

  await new Promise<void>((resolve, reject) => {
    conn.query(`SET SESSION net_buffer_length=1048576`, (err) => (err ? reject(err) : resolve()));
  });

  const query = conn.query(sql);
  const stream = query.stream({ highWaterMark: 1000 });

  return (async function* () {
    try {
      for await (const row of stream as AsyncIterable<Row>) {
        if (options?.isCancelled?.()) {
          try {
            stream.destroy(new Error("Run cancelled by user"));
          } catch {}
          break;
        }
        yield row;
      }
    } finally {
      try {
        stream.destroy();
      } catch {}
      await new Promise<void>((resolve) => conn.end(() => resolve()));
    }
  })();
}

/** Fast-path load for CSV files using LOAD DATA LOCAL INFILE. Returns rows affected. */
export async function mysqlLoadCsvFile(
  cfg: MyCfg & { filePath: string; ignoreFirstLine?: boolean }
): Promise<number> {
  await ensureDatabase(cfg);
  // MySQL2 v2 requires streamFactory for LOCAL INFILE
  const fs = await import("fs");
  const infileStreamFactory = (path: string) => fs.createReadStream(path);
  const conn = await mysqlPromise.createConnection({
    ...(normalizeCfg(cfg) as any),
    localInfile: true,
    infileStreamFactory,
  });
  try {
    // Best-effort enable LOCAL INFILE; ignore if server restricts GLOBAL
    try {
      await conn.query("SET SESSION local_infile=1");
    } catch {
      /* ignore */
    }
    const sql = `
      LOAD DATA LOCAL INFILE ?
      INTO TABLE \`${cfg.database}\`.\`${cfg.table}\`
      FIELDS TERMINATED BY ','
      OPTIONALLY ENCLOSED BY '"'
      ESCAPED BY '\\\\'
      LINES TERMINATED BY '\n'
      ${cfg.ignoreFirstLine === false ? "" : "IGNORE 1 LINES"}
    `;
    const [result] = await conn.query({
      sql,
      values: [cfg.filePath],
      timeout: 300_000,
      infileStreamFactory,
    } as any);
    const rows = (result as any)?.affectedRows ?? 0;
    return rows;
  } finally {
    await conn.end();
  }
}

export async function mysqlCreateTable(cfg: MyCfg, createTableSQL: string): Promise<void> {
  await ensureDatabase(cfg);
  const conn = await open(cfg);
  try {
    await conn.query(createTableSQL);
  } finally {
    await conn.end();
  }
}

export async function mysqlTruncateTable(cfg: MyCfg): Promise<void> {
  await ensureDatabase(cfg);
  const conn = await open(cfg);
  try {
    const sql = `TRUNCATE TABLE \`${cfg.database}\`.\`${cfg.table}\``;
    await conn.query(sql);
  } finally {
    await conn.end();
  }
}

type WriteOptions = { 
  isCancelled?: () => boolean; 
  onProgress?: (written: number) => void;
  mysqlPool?: mysqlPromise.Pool; // Persistent connection pool (reuse across batches)
  skipIndexManagement?: boolean; // Skip index drop/recreate for batch operations
};

type IndexDef = { name: string; columns: string[] };

async function setChecks(conn: mysqlPromise.Connection, enabled: boolean) {
  try {
    await conn.query(`SET SESSION foreign_key_checks=${enabled ? 1 : 0}, SESSION unique_checks=${enabled ? 1 : 0}`);
  } catch {
    /* ignore */
  }
}

async function fetchSecondaryIndexes(conn: mysqlPromise.Connection, cfg: MyCfg): Promise<IndexDef[]> {
  try {
    const sql = `SHOW INDEX FROM \`${cfg.database}\`.\`${cfg.table}\``;
    const [rows] = await conn.query(sql);
    const defs: Record<string, IndexDef> = {};
    for (const r of rows as any[]) {
      const key = String(r.Key_name);
      const nonUnique = Number(r.Non_unique);
      if (key === "PRIMARY" || nonUnique !== 1) continue; // keep uniques/PK in place
      const col = String(r.Column_name);
      if (!defs[key]) defs[key] = { name: key, columns: [] };
      defs[key].columns[r.Seq_in_index - 1] = col;
    }
    return Object.values(defs);
  } catch {
    return [];
  }
}

async function dropSecondaryIndexes(conn: mysqlPromise.Connection, cfg: MyCfg, indexes: IndexDef[]) {
  for (const idx of indexes) {
    try {
      const sql = `ALTER TABLE \`${cfg.database}\`.\`${cfg.table}\` DROP INDEX \`${idx.name}\``;
      await conn.query(sql);
    } catch {
      /* ignore */
    }
  }
}

async function recreateSecondaryIndexes(conn: mysqlPromise.Connection, cfg: MyCfg, indexes: IndexDef[]) {
  for (const idx of indexes) {
    try {
      const cols = idx.columns.map((c) => `\`${c}\``).join(",");
      const sql = `ALTER TABLE \`${cfg.database}\`.\`${cfg.table}\` ADD INDEX \`${idx.name}\` (${cols})`;
      await conn.query(sql);
    } catch {
      /* ignore */
    }
  }
}

export async function mysqlWriteRows(
  cfg: MyCfg & { createTable?: boolean; writerPoolSize?: number; batchSize?: number },
  rows: Row[],
  options?: WriteOptions
): Promise<void> {
  if (!rows?.length) return;
  await ensureDatabase(cfg);

  // Skip index management if using persistent pool (indexes handled once at start/end of migration)
  const skipIndexMgmt = options?.skipIndexManagement ?? false;
  const usePersistentPool = !!options?.mysqlPool;

  let secondaryIndexes: IndexDef[] = [];
  let adminConn: mysqlPromise.Connection | undefined;
  let conn: mysqlPromise.Connection | undefined;

  if (!skipIndexMgmt) {
    // Best-effort: disable FK/unique checks and drop non-unique secondary indexes during load
    adminConn = await open(cfg);
    secondaryIndexes = await fetchSecondaryIndexes(adminConn, cfg);
    await setChecks(adminConn, false);
    await dropSecondaryIndexes(adminConn, cfg, secondaryIndexes);
    await adminConn.end();
  }

  if (!usePersistentPool) {
    conn = await open(cfg);
  }

  try {
    const cols = Object.keys(rows[0]);
    
    // Stream-based INSERT approach: split into chunks and use parallel writers
    const chunkSize = 15000; // Increased from 10000 for better throughput
    const batches: Row[][] = [];
    for (let i = 0; i < rows.length; i += chunkSize) {
      batches.push(rows.slice(i, i + chunkSize));
    }

    const poolSize = 8; // more parallel writer connections for maximum throughput

    // Use persistent pool if provided, otherwise create new one
    const pool = options?.mysqlPool || mysqlPromise.createPool({
      ...normalizeCfg(cfg),
      waitForConnections: true,
      connectionLimit: poolSize,
    });
    
    // Check max_allowed_packet to prevent statement too large errors
    let maxPacket = 67108864; // Default 64MB
    try {
      const [rows] = await pool.query("SELECT @@max_allowed_packet as max_packet");
      maxPacket = (rows as any)[0].max_packet;
    } catch (err) {
      console.warn("[mysql] Failed to query max_allowed_packet, using default 64MB");
    }
    
    const batchesPerWorker = Math.ceil(batches.length / poolSize);
    
    const worker = async (workerIdx: number) => {
      const startIdx = workerIdx * batchesPerWorker;
      const endIdx = Math.min(startIdx + batchesPerWorker, batches.length);
      const myBatches = batches.slice(startIdx, endIdx);
      
      for (const chunk of myBatches) {
        if (options?.isCancelled?.()) throw new Error("Run cancelled by user");
        const placeholders = chunk.map(() => `(${cols.map(() => "?").join(",")})`).join(",");
        const sql = `INSERT INTO \`${cfg.database}\`.\`${cfg.table}\` (${cols
          .map((c) => `\`${c}\``)
          .join(",")}) VALUES ${placeholders}`;
        
        // Estimate SQL statement size (rough approximation)
        const avgValueSize = 50; // Average bytes per value
        const estimatedSize = sql.length + (chunk.length * cols.length * avgValueSize);
        
        if (estimatedSize > maxPacket * 0.9) {
          // Statement too large, split into smaller chunks
          console.warn(`[mysql] Statement size (${Math.round(estimatedSize / 1024 / 1024)}MB) exceeds max_allowed_packet (${Math.round(maxPacket / 1024 / 1024)}MB), splitting batch`);
          const smallerChunkSize = Math.floor(chunk.length / 2);
          for (let i = 0; i < chunk.length; i += smallerChunkSize) {
            const smallChunk = chunk.slice(i, i + smallerChunkSize);
            const smallPlaceholders = smallChunk.map(() => `(${cols.map(() => "?").join(",")})`).join(",");
            const smallSql = `INSERT INTO \`${cfg.database}\`.\`${cfg.table}\` (${cols
              .map((c) => `\`${c}\``)
              .join(",")}) VALUES ${smallPlaceholders}`;
            const smallArgs = smallChunk.flatMap((r) => cols.map((c) => (r as Record<string, unknown>)[c]));
            await pool.query({ sql: smallSql, values: smallArgs, timeout: 120_000 });
          }
        } else {
          const args = chunk.flatMap((r) => cols.map((c) => (r as Record<string, unknown>)[c]));
          await pool.query({ sql, values: args, timeout: 120_000 });
        }
      }
    };
    
    await Promise.all(Array.from({ length: poolSize }, (_, idx) => worker(idx)));
    
    // Only close pool if we created it (not using persistent pool)
    if (!usePersistentPool) {
      await pool.end();
    }
  } finally {
    if (conn) {
      await conn.end();
    }
    
    if (!skipIndexMgmt) {
      // Re-enable checks and rebuild indexes
      const admin = await open(cfg);
      await recreateSecondaryIndexes(admin, cfg, secondaryIndexes);
      await setChecks(admin, true);
      await admin.end();
    }
  }
}
