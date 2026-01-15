import { Pool } from "pg";

export type PgCfg = {
  host: string;
  port?: number | string;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
};

const pools = new Map<string, Pool>();

function keyFor(cfg: PgCfg) {
  return `${cfg.host}:${cfg.port ?? 5432}:${cfg.user}:${cfg.database}`;
}

export function getPgPool(cfg: PgCfg) {
  const key = keyFor(cfg);
  if (!pools.has(key)) {
    const pool = new Pool({
      host: cfg.host,
      port: cfg.port ? Number(cfg.port) : 5432,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: Number(process.env.PG_POOL_IDLE_TIMEOUT_MS ?? 30000),
      connectionTimeoutMillis: Number(process.env.PG_POOL_CONNECTION_TIMEOUT_MS ?? 2000),
    });
    pools.set(key, pool);
  }
  return pools.get(key)!;
}

export async function closeAllPools() {
  const promises: Promise<any>[] = [];
  for (const p of pools.values()) promises.push(p.end().catch(() => {}));
  await Promise.all(promises);
  pools.clear();
}
