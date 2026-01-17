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
  batchSize?: number; // optional batch size override (ignored, now fixed)
  writerPoolSize?: number; // optional parallel writers (ignored, now fixed)
};

// 0 = no timeout; large loads (multi-million rows) can exceed default 15s/10m timeouts
const MSSQL_REQUEST_TIMEOUT = 0;

function toPoolConfig(c: MsCfg): sql.config {
  return {
    server: c.host,
    port: c.port ? Number(c.port) : 1433,
    user: c.user,
    password: c.password,
    database: c.database,
    requestTimeout: MSSQL_REQUEST_TIMEOUT,
    options: {
      encrypt: false,
      trustServerCertificate: true,
      enableArithAbort: true, // Performance optimization
      appName: "universal-migrator", // Connection tracking
    },
    pool: { 
      max: 10,  // Increased from 5 for better concurrency
      min: 2,   // Keep some connections warm
      idleTimeoutMillis: 30000 
    },
    stream: true, // Enable streaming by default for better memory usage
    parseJSON: false, // Faster for bulk data (skip JSON parsing)
  };
}

export async function mssqlTestConnection(cfg: MsCfg): Promise<void> {
  // Validate required fields
  if (!cfg.host || !cfg.user || !cfg.password || !cfg.database) {
    throw new Error("SQL Server requires: host, user, password, database");
  }
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
        WHERE c.object_id = OBJECT_ID(QUOTENAME(@schema) + '.' + QUOTENAME(@table))
        ORDER BY c.column_id
      `);
    return r.recordset.map((x: Record<string, unknown>) => ({
      name: String(x.column_name),
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
      WHERE c.object_id = OBJECT_ID(QUOTENAME(@schema) + '.' + QUOTENAME(@table))
        AND c.is_identity = 1
    `);
  return q.recordset.length ? (q.recordset[0].identity_col as string) : null;
}

/** Fetch column types from SQL Server metadata */
async function getColumnTypes(pool: sql.ConnectionPool, schema: string, table: string): Promise<Map<string, any>> {
  const q = await pool.request()
    .input("schema", sql.NVarChar, schema)
    .input("table", sql.NVarChar, table)
    .query(`
      SELECT 
        c.name AS column_name,
        t.name AS data_type,
        c.max_length,
        c.precision,
        c.scale
      FROM sys.columns c
      JOIN sys.types t ON c.user_type_id = t.user_type_id
      WHERE c.object_id = OBJECT_ID(QUOTENAME(@schema) + '.' + QUOTENAME(@table))
    `);
  
  const typeMap = new Map<string, any>();
  for (const row of q.recordset) {
    const colName = row.column_name as string;
    const dataType = (row.data_type as string).toLowerCase();
    const maxLength = row.max_length as number;
    const precision = row.precision as number;
    const scale = row.scale as number;
    
    // Map SQL Server types to mssql package types
    let sqlType: any;
    switch (dataType) {
      case 'bit':
        sqlType = sql.Bit;
        break;
      case 'tinyint':
        sqlType = sql.TinyInt;
        break;
      case 'smallint':
        sqlType = sql.SmallInt;
        break;
      case 'int':
        sqlType = sql.Int;
        break;
      case 'bigint':
        sqlType = sql.BigInt;
        break;
      case 'float':
        sqlType = sql.Float;
        break;
      case 'real':
        sqlType = sql.Real;
        break;
      case 'decimal':
      case 'numeric':
        sqlType = sql.Decimal(precision, scale);
        break;
      case 'money':
        sqlType = sql.Money;
        break;
      case 'smallmoney':
        sqlType = sql.SmallMoney;
        break;
      case 'date':
        sqlType = sql.Date;
        break;
      case 'datetime':
        sqlType = sql.DateTime;
        break;
      case 'datetime2':
        sqlType = sql.DateTime2(scale);
        break;
      case 'datetimeoffset':
        sqlType = sql.DateTimeOffset(scale);
        break;
      case 'smalldatetime':
        sqlType = sql.SmallDateTime;
        break;
      case 'time':
        sqlType = sql.Time(scale);
        break;
      case 'char':
        sqlType = maxLength > 0 ? sql.Char(maxLength) : sql.Char;
        break;
      case 'varchar':
        sqlType = maxLength === -1 ? sql.VarChar(sql.MAX) : maxLength > 0 ? sql.VarChar(maxLength) : sql.VarChar;
        break;
      case 'text':
        sqlType = sql.Text;
        break;
      case 'nchar':
        sqlType = maxLength > 0 ? sql.NChar(maxLength / 2) : sql.NChar; // nchar uses 2 bytes per char
        break;
      case 'nvarchar':
        sqlType = maxLength === -1 ? sql.NVarChar(sql.MAX) : maxLength > 0 ? sql.NVarChar(maxLength / 2) : sql.NVarChar;
        break;
      case 'ntext':
        sqlType = sql.NText;
        break;
      case 'binary':
        sqlType = maxLength > 0 ? sql.Binary : sql.Binary;
        break;
      case 'varbinary':
        sqlType = maxLength === -1 ? sql.VarBinary(sql.MAX) : maxLength > 0 ? sql.VarBinary(maxLength) : sql.VarBinary;
        break;
      case 'image':
        sqlType = sql.Image;
        break;
      case 'uniqueidentifier':
        sqlType = sql.UniqueIdentifier;
        break;
      case 'xml':
        sqlType = sql.Xml;
        break;
      default:
        // Fallback to NVARCHAR(MAX) for unknown types
        sqlType = sql.NVarChar(sql.MAX);
    }
    
    typeMap.set(colName.toLowerCase(), sqlType);
  }
  
  return typeMap;
}

export async function mssqlCreateTable(cfg: MsCfg, createTableSQL: string): Promise<void> {
  const pool = new sql.ConnectionPool(toPoolConfig(cfg));
  await pool.connect();
  try {
    await pool.request().query(createTableSQL);
  } finally {
    await pool.close();
  }
}

type WriteOptions = { 
  isCancelled?: () => boolean;
  mssqlPool?: sql.ConnectionPool; // Persistent connection pool (reuse across batches)
};

export async function mssqlWriteRows(cfg: MsCfg, rows: Row[], options?: WriteOptions): Promise<void> {
  if (!rows.length) return;

  const sch = cfg.schema || "dbo";
  
  // Use persistent pool if provided, otherwise create new one
  const usePersistentPool = !!options?.mssqlPool;
  const pool = options?.mssqlPool || new sql.ConnectionPool(toPoolConfig(cfg));
  
  if (!usePersistentPool) {
    await pool.connect();
  }
  
  try {
    const cols = Object.keys(rows[0]);
    const tbl = `[${sch}].[${cfg.table}]`;

    // Fetch actual column types for better performance (avoids NVARCHAR(MAX) conversion overhead)
    const columnTypes = await getColumnTypes(pool, sch, cfg.table);

    // If table has an IDENTITY col and we're providing it, enable IDENTITY_INSERT
    const identityCol = await getIdentityColumn(pool, sch, cfg.table);
    const willSupplyIdentity =
      identityCol ? cols.map((c) => c.toLowerCase()).includes(identityCol.toLowerCase()) : false;

    if (willSupplyIdentity) {
      const identityReq = pool.request();
      (identityReq as any).requestTimeout = MSSQL_REQUEST_TIMEOUT;
      await identityReq.query(`SET IDENTITY_INSERT ${tbl} ON;`);
    }

    try {
      // Optimized bulk batch size for better performance
      const chunkSize = 15000; // Increased from 10000 for fewer round trips
      const batches: Row[][] = [];
      for (let i = 0; i < rows.length; i += chunkSize) {
        batches.push(rows.slice(i, i + chunkSize));
      }

      // Fixed writer pool size
      const poolSize = 8;

      const runBatch = async (batch: Row[]) => {
        const bulkTable = new sql.Table(tbl);
        bulkTable.create = false;
        
        // Use actual column types instead of NVARCHAR(MAX) for all columns
        cols.forEach((col) => {
          const sqlType = columnTypes.get(col.toLowerCase()) || sql.NVarChar(sql.MAX);
          bulkTable.columns.add(col, sqlType, { nullable: true });
        });
        
        batch.forEach((row) => {
          const rowValues = cols.map((col) => {
            const value = (row as Record<string, unknown>)[col];
            return value === undefined ? null : value;
          });
          bulkTable.rows.add(...(rowValues as any[]));
        });

        const req = pool.request();
        (req as any).requestTimeout = MSSQL_REQUEST_TIMEOUT;
        await (req as any).bulk(bulkTable, {
          keepIdentity: willSupplyIdentity,
          tableLock: true,
          // checkConstraints: false, // uncomment if you can skip constraint checks during load
        });
      };

      // Data partitioning: split batches across workers first for true parallelism
      const batchesPerWorker = Math.ceil(batches.length / poolSize);
      
      const worker = async (workerIdx: number) => {
        const startIdx = workerIdx * batchesPerWorker;
        const endIdx = Math.min(startIdx + batchesPerWorker, batches.length);
        const myBatches = batches.slice(startIdx, endIdx);
        
        for (const batch of myBatches) {
          if (options?.isCancelled?.()) throw new Error("Run cancelled by user");
          await runBatch(batch);
        }
      };
      
      await Promise.all(Array.from({ length: poolSize }, (_, idx) => worker(idx)));
    } finally {
      if (willSupplyIdentity) {
        const identityReq = pool.request();
        (identityReq as any).requestTimeout = MSSQL_REQUEST_TIMEOUT;
        await identityReq.query(`SET IDENTITY_INSERT ${tbl} OFF;`);
      }
    }
  } finally {
    // Only close pool if we created it (not using persistent pool)
    if (!usePersistentPool) {
      await pool.close();
    }
  }
}

export async function mssqlCountRows(cfg: MsCfg): Promise<number> {
  const sch = cfg.schema || "dbo";
  const pool = new sql.ConnectionPool(toPoolConfig(cfg));
  await pool.connect();
  try {
    const r = await pool.request().query(`SELECT COUNT(*) as cnt FROM [${sch}].[${cfg.table}]`);
    return Number(r.recordset?.[0]?.cnt ?? 0);
  } finally {
    await pool.close();
  }
}

type StreamOptions = { isCancelled?: () => boolean };

export async function mssqlReadStream(
  cfg: MsCfg,
  options?: StreamOptions
): Promise<AsyncGenerator<Row>> {
  const sch = cfg.schema || "dbo";
  const pool = new sql.ConnectionPool(toPoolConfig(cfg));
  await pool.connect();

  return (async function* () {
    const request = pool.request();
    request.stream = true;
    // High buffer size for optimal streaming throughput
    const MAX_QUEUE = 20000; // Increased for better backpressure handling
    let paused = false;
    
    // TABLOCK is better than NOLOCK for full table scans - shared table lock, better sequential scan performance
    const query = `SELECT * FROM [${sch}].[${cfg.table}] WITH (TABLOCK, HOLDLOCK)`;
    console.log(`[mssql] Starting stream query: ${query}`);
    const queryPromise = request.query(query);

    const queue: Row[] = [];
    let done = false;
    let error: Error | null = null;
    let resolver: (() => void) | null = null;
    let rejecter: ((err: Error) => void) | null = null;
    let rowCount = 0;

    const waitForData = () =>
      new Promise<void>((resolve, reject) => {
        resolver = resolve;
        rejecter = reject;
      });

    request.on("row", (row) => {
      if (options?.isCancelled?.()) {
        try {
          request.cancel();
        } catch {}
        return;
      }
      queue.push(row as Row);
      rowCount++;
      if (rowCount === 1 || rowCount % 10000 === 0) {
        console.log(`[mssql] Stream received ${rowCount} rows, queue size: ${queue.length}`);
      }
       // Pause upstream when queue grows too large to avoid unbounded memory.
      if (!paused && queue.length >= MAX_QUEUE && typeof (request as any).pause === "function") {
        try {
          (request as any).pause();
          paused = true;
          console.log(`[mssql] Stream paused at ${rowCount} rows (queue full)`);
        } catch {}
      }
      resolver?.();
      resolver = null;
    });

    request.on("error", (err) => {
      console.error(`[mssql] Stream error after ${rowCount} rows:`, err);
      error = err;
      rejecter?.(err);
      rejecter = null;
    });

    request.on("done", () => {
      console.log(`[mssql] Stream done, total rows: ${rowCount}`);
      done = true;
      resolver?.();
      resolver = null;
    });

    try {
      let yielded = 0;
      while (true) {
        if (options?.isCancelled?.()) {
          try {
            request.cancel();
          } catch {}
          break;
        }
        if (queue.length) {
          yield queue.shift() as Row;
          yielded++;
          if (yielded === 1 || yielded % 10000 === 0) {
            console.log(`[mssql] Yielded ${yielded} rows to consumer`);
          }
          // Resume when back under threshold (50% of MAX_QUEUE)
          if (paused && queue.length < Math.floor(MAX_QUEUE / 2) && typeof (request as any).resume === "function") {
            try {
              (request as any).resume();
              paused = false;
              console.log(`[mssql] Stream resumed at ${yielded} rows`);
            } catch {}
          }
          continue;
        }
        if (error) {
          throw error;
        }
        if (done) {
          console.log(`[mssql] Stream complete, yielded ${yielded} rows total`);
          break;
        }
        await Promise.race([
          waitForData(),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      }
    } finally {
      await queryPromise.catch(() => {});
      await pool.close().catch(() => {});
    }
  })();
}

export async function mssqlTruncateTable(cfg: MsCfg): Promise<void> {
  const sch = cfg.schema || "dbo";
  const pool = new sql.ConnectionPool(toPoolConfig(cfg));
  await pool.connect();
  try {
    await pool.request().query(`TRUNCATE TABLE [${sch}].[${cfg.table}]`);
  } finally {
    await pool.close();
  }
}
