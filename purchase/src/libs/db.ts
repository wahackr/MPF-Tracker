import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

const pool = new Pool({
  host: process.env.DB_HOST ?? "mpf-db",
  port: Number(process.env.DB_PORT ?? "5432"),
  database: process.env.DB_NAME ?? "mpf",
  user: process.env.DB_USER ?? "mpf_purchase",
  password: process.env.DB_PASSWORD ?? "REPLACE_ME_PURCHASE_PASSWORD",
  max: 10
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  return pool.query<T>(sql, params);
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// Release idle connections when a test suite or service shuts down.
export async function closeDatabase(): Promise<void> {
  await pool.end();
}
