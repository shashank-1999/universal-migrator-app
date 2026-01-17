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

  console.log(`[mysql] Starting read stream query: ${sql.substring(0, 100)}...`);

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
    let rowCount = 0;
    try {
      for await (const row of stream as AsyncIterable<Row>) {
        if (options?.isCancelled?.()) {
          try {
            stream.destroy(new Error("Run cancelled by user"));
          } catch {}
          break;
        }
        rowCount++;
        
        // Log progress every 100k rows
        if (rowCount % 100000 === 0) {
          console.log(`[mysql] Stream read ${rowCount} rows`);
        }
        
        yield row;
      }
      console.log(`[mysql] Stream complete: total ${rowCount} rows read`);
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
  if (indexes.length > 0) {
    console.log(`[mysql] Rebuilding ${indexes.length} secondary indexes in parallel (MySQL 8.0+)...`);
  }
  
  // Rebuild indexes in parallel using ALGORITHM=INPLACE, LOCK=NONE for MySQL 8.0+
  const rebuildPromises = indexes.map(async (idx) => {
    try {
      console.log(`[mysql] Creating index ${idx.name}...`);
      const cols = idx.columns.map((c) => `\`${c}\``).join(",");
      const sql = `ALTER TABLE \`${cfg.database}\`.\`${cfg.table}\` ADD INDEX \`${idx.name}\` (${cols}), ALGORITHM=INPLACE, LOCK=NONE`;
      const startTime = Date.now();
      await conn.query(sql);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[mysql] Index ${idx.name} created in ${elapsed}s`);
    } catch (err) {
      console.warn(`[mysql] Failed to create index ${idx.name}:`, err);
    }
  });
  
  await Promise.all(rebuildPromises);
  console.log(`[mysql] All ${indexes.length} indexes rebuilt in parallel`);
}

export async function mysqlWriteRows(
  cfg: MyCfg & { createTable?: boolean; writerPoolSize?: number; batchSize?: number; useBulkInsert?: boolean },
  rows: Row[],
  options?: WriteOptions
): Promise<void> {
  if (!rows?.length) return;
  await ensureDatabase(cfg);

  // Check if bulk insert is enabled (default: true for better performance)
  const useBulkInsert = cfg.useBulkInsert !== false;

  // Skip index management if using persistent pool (indexes handled once at start/end of migration)
  const skipIndexMgmt = options?.skipIndexManagement ?? false;
  const usePersistentPool = !!options?.mysqlPool;

  let secondaryIndexes: IndexDef[] = [];
  let adminConn: mysqlPromise.Connection | undefined;
  let conn: mysqlPromise.Connection | undefined;

  if (!skipIndexMgmt) {
    // Best-effort: disable FK/unique checks and drop non-unique secondary indexes during load
    adminConn = await open(cfg);
    
    // Session-level optimizations (innodb_flush_log_at_trx_commit is GLOBAL-only, set in route.ts)
    try {
      await adminConn.query(`SET SESSION autocommit=0`); // Manual commit for better batching
      await adminConn.query(`SET SESSION sql_log_bin=0`); // Disable binary logging
      console.log('[mysql] Session optimizations: autocommit=0, sql_log_bin=0');
    } catch (err) {
      console.warn('[mysql] Could not set session optimizations:', err);
    }
    
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
    
    // Size-based batching: AGGRESSIVE mode for maximum speed
    const targetBatchSizeMB = 50; // 50MB per batch for maximum throughput
    const targetBatchSizeBytes = targetBatchSizeMB * 1024 * 1024;
    
    // Fast estimation: sample only 10 rows for speed
    const sampleSize = Math.min(10, rows.length);
    let totalSampleBytes = 0;
    for (let i = 0; i < sampleSize; i++) {
      for (const col of cols) {
        const val = (rows[i] as Record<string, unknown>)[col];
        if (val === null || val === undefined) {
          totalSampleBytes += 2;
        } else if (typeof val === 'string') {
          totalSampleBytes += val.length;
        } else if (typeof val === 'number') {
          totalSampleBytes += 8;
        } else if (val instanceof Date) {
          totalSampleBytes += 24;
        } else if (typeof val === 'boolean') {
          totalSampleBytes += 1;
        } else {
          totalSampleBytes += JSON.stringify(val).length;
        }
      }
    }
    const avgRowSizeBytes = Math.ceil(totalSampleBytes / sampleSize);
    const estimatedRowsPerBatch = Math.floor(targetBatchSizeBytes / avgRowSizeBytes);
    // Smaller chunks to ensure many batches for full parallel distribution across 12 workers
    // Each chunk should be ~5MB for better worker distribution (50K rows → ~10 batches → all 12 workers utilized)
    const targetChunkMB = 5;
    const targetChunkBytes = targetChunkMB * 1024 * 1024;
    const chunkSize = Math.max(3000, Math.min(Math.floor(targetChunkBytes / avgRowSizeBytes), 15000));
    
    console.log(`[mysql] MAXIMUM SPEED MODE: ${avgRowSizeBytes} bytes/row, ${chunkSize} rows/batch (~${Math.round(chunkSize * avgRowSizeBytes / 1024 / 1024)}MB)`);
    
    const batches: Row[][] = [];
    for (let i = 0; i < rows.length; i += chunkSize) {
      batches.push(rows.slice(i, i + chunkSize));
    }

    const poolSize = useBulkInsert ? 12 : 8; // 12 parallel connections for maximum throughput

    // Use persistent pool if provided, otherwise create new one
    const pool = options?.mysqlPool || mysqlPromise.createPool({
      ...normalizeCfg(cfg),
      waitForConnections: true,
      connectionLimit: poolSize,
    });
    
    // Check max_allowed_packet to prevent statement too large errors
    let maxPacket = 268435456; // 256MB (user configured)
    try {
      const [rows] = await pool.query("SELECT @@max_allowed_packet as max_packet");
      maxPacket = (rows as any)[0].max_packet;
    } catch (err) {
      console.warn("[mysql] Failed to query max_allowed_packet, using default 64MB");
    }

    console.log(`[mysql] Using ${useBulkInsert ? 'BULK INSERT' : 'standard INSERT'} mode with ${poolSize} connections, chunk size: ${chunkSize}`);
    console.log(`[mysql] Total batches: ${batches.length}, distributing across ${poolSize} workers`);
    
    let totalWritten = 0;
    
    const worker = async (workerIdx: number) => {
      // Round-robin assignment: worker 0 gets batches 0,12,24..., worker 1 gets 1,13,25..., etc.
      const myBatches = batches.filter((_, batchIdx) => batchIdx % poolSize === workerIdx);
      console.log(`[mysql] Worker ${workerIdx}: assigned ${myBatches.length} batches`);
      let workerWritten = 0;
      
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
        
        workerWritten += chunk.length;
        
        // Log progress every 50k rows per worker
        if (workerWritten % 50000 < chunk.length) {
          console.log(`[mysql] Worker ${workerIdx}: wrote ${workerWritten} rows`);
        }
      }
      
      return workerWritten;
    };
    
    const workerResults = await Promise.all(Array.from({ length: poolSize }, (_, idx) => worker(idx)));
    totalWritten = workerResults.reduce((sum, count) => sum + count, 0);
    console.log(`[mysql] Bulk insert completed: ${totalWritten} rows written using ${poolSize} parallel connections`);
    
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
      console.log("[mysql] Re-enabling foreign key and unique checks...");
      const admin = await open(cfg);
      await recreateSecondaryIndexes(admin, cfg, secondaryIndexes);
      await setChecks(admin, true);
      await admin.end();
      console.log("[mysql] Index rebuild complete");
    }
  }
}
