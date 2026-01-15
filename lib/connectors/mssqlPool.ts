// lib/connectors/mssqlPool.ts
// Shared MSSQL connection pool management with environment-based config
import sql from "mssql";

const poolCache = new Map<string, sql.ConnectionPool>();

export interface MssqlPoolConfig {
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
}

function getPoolConfigKey(cfg: MssqlPoolConfig): string {
  return `${cfg.host}:${cfg.port || 1433}:${cfg.user}:${cfg.database}`;
}

export async function getMssqlPool(cfg: MssqlPoolConfig): Promise<sql.ConnectionPool> {
  const key = getPoolConfigKey(cfg);
  if (poolCache.has(key)) {
    const existingPool = poolCache.get(key)!;
    if (existingPool.connected) {
      return existingPool;
    }
  }

  const poolMax = parseInt(process.env.MSSQL_POOL_MAX || "10", 10);
  const poolIdleTimeoutMs = parseInt(process.env.MSSQL_POOL_IDLE_TIMEOUT_MS || "30000", 10);
  const REQUEST_TIMEOUT = 0; // no timeout for large loads

  const pool = new sql.ConnectionPool({
    server: cfg.host,
    port: cfg.port ? Number(cfg.port) : 1433,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    requestTimeout: REQUEST_TIMEOUT,
    options: {
      encrypt: false,
      trustServerCertificate: true,
    },
    pool: {
      max: poolMax,
      min: 0,
      idleTimeoutMillis: poolIdleTimeoutMs,
    },
  });

  await pool.connect();
  poolCache.set(key, pool);
  return pool;
}

export async function closeAllMssqlPools(): Promise<void> {
  const promises = Array.from(poolCache.values()).map((p) => p.close());
  await Promise.all(promises);
  poolCache.clear();
}
