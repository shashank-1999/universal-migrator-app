// lib/connectors/mysqlPool.ts
// Shared MySQL connection pool management with environment-based config
import mysql from "mysql2/promise";

const poolCache = new Map<string, mysql.Pool>();

export interface MysqlPoolConfig {
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
}

function getPoolConfigKey(cfg: MysqlPoolConfig): string {
  return `${cfg.host}:${cfg.port || 3306}:${cfg.user}:${cfg.database}`;
}

export function getMysqlPool(cfg: MysqlPoolConfig): mysql.Pool {
  const key = getPoolConfigKey(cfg);
  if (poolCache.has(key)) {
    return poolCache.get(key)!;
  }

  const poolMaxConnections = parseInt(process.env.MYSQL_POOL_MAX || "10", 10);
  const poolIdleTimeoutMs = parseInt(process.env.MYSQL_POOL_IDLE_TIMEOUT_MS || "30000", 10);

  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port ? Number(cfg.port) : 3306,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: poolMaxConnections,
    idleTimeout: poolIdleTimeoutMs,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 30000,
  });

  poolCache.set(key, pool);
  return pool;
}

export async function closeAllMysqlPools(): Promise<void> {
  const promises = Array.from(poolCache.values()).map((p) => p.end());
  await Promise.all(promises);
  poolCache.clear();
}
