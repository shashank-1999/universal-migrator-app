// lib/connectors/postgres.ts
import { Client } from "pg";
import QueryStream from "pg-query-stream";
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
  query?: string;
  customQuery?: string;
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
  } finally {
    try {
      await client.end();
    } catch {}
  }
}

/** Fetch table schema (column name + PG data type) */
export async function pgSchema(cfg: PgCfg): Promise<SchemaColumn[]> {
  const customQuery = normalizeQuery(cfg);
  const client = pgClient(cfg);
  await client.connect();
  try {
    if (customQuery) {
      const wrapped = `SELECT * FROM (${customQuery}) AS src LIMIT 0`;
      const r = await client.query(wrapped);
      if (Array.isArray(r.fields)) {
        return r.fields.map((field) => ({
          name: field.name,
          type: "CUSTOM",
        }));
      }
      return [];
    }
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
  const customQuery = normalizeQuery(cfg);
  const client = pgClient(cfg);
  await client.connect();
  try {
    // Optimize for large reads
    await client.query(`SET work_mem = '256MB'`);
    
    if (customQuery) {
      // Use custom query if provided
      const r = await client.query(customQuery);
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

type StreamOptions = { isCancelled?: () => boolean };

export async function pgReadStream(
  cfg: PgCfg & { query?: string },
  options?: StreamOptions
): Promise<AsyncGenerator<Row>> {
  const customQuery = normalizeQuery(cfg);
  const client = pgClient(cfg);
  await client.connect();

  return (async function* () {
    try {
      await client.query(`SET work_mem = '256MB'`);
      const sch = cfg.schema || "public";
      const sql = customQuery || `SELECT * FROM "${sch}"."${cfg.table}"`;
      const stream = client.query(new QueryStream(sql, undefined, { batchSize: 1000 }));

      for await (const row of stream as AsyncIterable<Row>) {
        if (options?.isCancelled?.()) {
          try {
            (stream as any).destroy(new Error("Run cancelled by user"));
          } catch {}
          break;
        }
        yield row;
      }
    } finally {
      await client.end().catch(() => {});
    }
  })();
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

/** Insert rows into schema.table using INSERT statements with parallel writers */
type WriteOptions = { 
  isCancelled?: () => boolean; 
  onProgress?: (written: number) => void;
  client?: Client; // Reuse existing connection (for single writer mode)
  pgClients?: Client[]; // Reuse existing connection pool (for parallel mode)
  poolSize?: number; // Number of parallel writer connections (only if creating new connections)
  useCopy?: boolean; // Use COPY protocol for 3-7x faster bulk inserts (opt-in)
};

export async function pgWriteRows(cfg: PgCfg & { createTable?: boolean }, rows: Row[], options?: WriteOptions): Promise<void> {
  if (!rows.length) return;
  
  // Use COPY protocol if enabled (3-7x faster for bulk inserts)
  if (options?.useCopy) {
    return pgWriteRowsWithCopy(cfg, rows, options);
  }
  
  const sch = cfg.schema || "public";
  const cols = Object.keys(rows[0]);
  
  // Calculate max rows per INSERT based on Postgres parameter limit
  const maxParamsPerInsert = 60000;
  const maxRowsPerInsert = Math.min(15000, Math.floor(maxParamsPerInsert / cols.length)); // Align with MySQL
  
  // Use persistent pool if provided, otherwise determine mode
  if (options?.pgClients && options.pgClients.length > 0) {
    // PARALLEL MODE: Split rows across workers FIRST, then each worker does its own chunking
    const clients = options.pgClients;
    const numWorkers = clients.length;
    const rowsPerWorker = Math.ceil(rows.length / numWorkers);
    
    const worker = async (client: Client, workerIdx: number) => {
      const startIdx = workerIdx * rowsPerWorker;
      const endIdx = Math.min(startIdx + rowsPerWorker, rows.length);
      const myRows = rows.slice(startIdx, endIdx);
      
      if (!myRows.length) return;
      
      // Process this worker's rows in chunks limited by parameter count
      for (let i = 0; i < myRows.length; i += maxRowsPerInsert) {
        if (options?.isCancelled?.()) throw new Error("Run cancelled by user");
        
        const chunk = myRows.slice(i, Math.min(i + maxRowsPerInsert, myRows.length));
        const values: unknown[] = [];
        const valueClauses = chunk.map((row, rowIdx) => {
          const base = rowIdx * cols.length;
          cols.forEach((c) => values.push((row as Record<string, unknown>)[c]));
          const placeholders = cols.map((_, colIdx) => `$${base + colIdx + 1}`).join(", ");
          return `(${placeholders})`;
        });
        const sql = `INSERT INTO "${sch}"."${cfg.table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES ${valueClauses.join(",")}`;
        await client.query(sql, values);
      }
    };
    
    await Promise.all(clients.map((client, idx) => worker(client, idx)));
    
    const maybe = options?.onProgress?.(rows.length);
    if (maybe && typeof maybe === 'object' && 'then' in maybe) {
      await maybe;
    }
  } else if (options?.client) {
    // Single writer mode: use provided client
    const client = options.client;
    
    for (let i = 0; i < rows.length; i += maxRowsPerInsert) {
      if (options?.isCancelled?.()) throw new Error("Run cancelled by user");
      const chunk = rows.slice(i, Math.min(i + maxRowsPerInsert, rows.length));
      const values: unknown[] = [];
      const valueClauses = chunk.map((row, rowIdx) => {
        const base = rowIdx * cols.length;
        cols.forEach((c) => values.push((row as Record<string, unknown>)[c]));
        const placeholders = cols.map((_, colIdx) => `$${base + colIdx + 1}`).join(", ");
        return `(${placeholders})`;
      });
      const sql = `INSERT INTO "${sch}"."${cfg.table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES ${valueClauses.join(",")}`;
      await client.query(sql, values);
    }
    
    const maybe = options?.onProgress?.(rows.length);
    if (maybe && typeof maybe === 'object' && 'then' in maybe) {
      await maybe;
    }
  } else {
    // No persistent connections provided, create and manage our own
    const poolSize = options?.poolSize || 1;
    
    // Split rows into batches for processing
    const batches: Row[][] = [];
    for (let i = 0; i < rows.length; i += maxRowsPerInsert) {
      batches.push(rows.slice(i, Math.min(i + maxRowsPerInsert, rows.length)));
    }
    
    if (poolSize === 1) {
      // Single writer mode: create new connection
      const client = pgClient(cfg);
      await client.connect();
      try {
        for (const chunk of batches) {
          if (options?.isCancelled?.()) throw new Error("Run cancelled by user");
          const values: unknown[] = [];
          const valueClauses = chunk.map((row, rowIdx) => {
            const base = rowIdx * cols.length;
            cols.forEach((c) => values.push((row as Record<string, unknown>)[c]));
            const placeholders = cols.map((_, colIdx) => `$${base + colIdx + 1}`).join(", ");
            return `(${placeholders})`;
          });
          const sql = `INSERT INTO "${sch}"."${cfg.table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES ${valueClauses.join(",")}`;
          await client.query(sql, values);
        }
        const maybe = options?.onProgress?.(rows.length);
        if (maybe && typeof maybe === 'object' && 'then' in maybe) {
          await maybe;
        }
      } finally {
        await client.end();
      }
    } else {
      // Parallel writer mode: create multiple connections with data partitioning
      const clients: Client[] = [];
      for (let i = 0; i < poolSize; i++) {
        const client = pgClient(cfg);
        await client.connect();
        clients.push(client);
      }
      
      try {
        // Data partitioning: split batches across workers FIRST to avoid work-stealing serialization
        const batchesPerWorker = Math.ceil(batches.length / poolSize);
        
        const worker = async (client: Client, workerIdx: number) => {
          const startIdx = workerIdx * batchesPerWorker;
          const endIdx = Math.min(startIdx + batchesPerWorker, batches.length);
          const myBatches = batches.slice(startIdx, endIdx);
          
          for (const chunk of myBatches) {
            if (options?.isCancelled?.()) throw new Error("Run cancelled by user");
            
            const values: unknown[] = [];
            const valueClauses = chunk.map((row, rowIdx) => {
              const base = rowIdx * cols.length;
              cols.forEach((c) => values.push((row as Record<string, unknown>)[c]));
              const placeholders = cols.map((_, colIdx) => `$${base + colIdx + 1}`).join(", ");
              return `(${placeholders})`;
            });
            const sql = `INSERT INTO "${sch}"."${cfg.table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES ${valueClauses.join(",")}`;
            await client.query(sql, values);
          }
        };
        
        await Promise.all(clients.map((client, idx) => worker(client, idx)));
        
        const maybe = options?.onProgress?.(rows.length);
        if (maybe && typeof maybe === 'object' && 'then' in maybe) {
          await maybe;
        }
      } finally {
        await Promise.all(clients.map((client) => client.end().catch(() => {})));
      }
    }
  }
}

function normalizeQuery(cfg: { query?: string; customQuery?: string }) {
  const raw = (cfg.customQuery ?? cfg.query ?? "").trim();
  if (!raw) return null;
  return raw.replace(/;+\s*$/, "");
}

/** High-performance COPY FROM STDIN protocol (3-7x faster than INSERT) */
async function pgWriteRowsWithCopy(cfg: PgCfg, rows: Row[], options?: WriteOptions): Promise<void> {
  const sch = cfg.schema || "public";
  const cols = Object.keys(rows[0]);
  
  // COPY protocol is single-threaded, so use one connection
  const client = options?.pgClients?.[0] || options?.client || pgClient(cfg);
  const shouldDisconnect = !options?.pgClients && !options?.client;
  
  if (shouldDisconnect) {
    await client.connect();
  }
  
  try {
    // COPY command with proper escaping
    const copySQL = `COPY "${sch}"."${cfg.table}" (${cols.map((c) => `"${c}"`).join(",")}) FROM STDIN WITH (FORMAT csv, HEADER false, DELIMITER E'\\t', NULL '\\N', ESCAPE '\\\\')`;
    
    const stream = client.query(require('stream').Readable.from(generateCopyData()));
    
    async function* generateCopyData() {
      for (const row of rows) {
        if (options?.isCancelled?.()) {
          throw new Error("Run cancelled by user");
        }
        
        // Generate TSV row with proper escaping
        const values = cols.map((col) => {
          const val = (row as Record<string, unknown>)[col];
          if (val === null || val === undefined) return '\\N';
          const str = String(val);
          // Escape special characters
          return str.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
        });
        
        yield values.join('\t') + '\n';
      }
    }
    
    await stream;
    
    const maybe = options?.onProgress?.(rows.length);
    if (maybe && typeof maybe === 'object' && 'then' in maybe) {
      await maybe;
    }
  } finally {
    if (shouldDisconnect) {
      await client.end().catch(() => {});
    }
  }
}
