export type JobType = "sync" | "backfill";

type JobRow = {
  job_id: string;
  service: string;
  job_type: JobType;
  status: string;
  request: Record<string, unknown>;
};

type Query = (sql: string, params: unknown[]) => Promise<{ rows: JobRow[] }>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])
    );
  }
  return value;
}

export class IdempotencyConflict extends Error {
  constructor() {
    super("Idempotency-Key is already used for a different crawler request");
  }
}

export async function enqueueCrawlerJob(
  query: Query,
  jobType: JobType,
  request: Record<string, unknown>,
  idempotencyKey: string
): Promise<Pick<JobRow, "job_id" | "service" | "job_type" | "status">> {
  const inserted = await query(
    `INSERT INTO mpf.jobs(service, job_type, status, idempotency_key, request)
     VALUES ('crawler', $1, 'queued', $2, $3::jsonb)
     ON CONFLICT (service, idempotency_key) DO NOTHING
     RETURNING job_id, service, job_type, status, request`,
    [jobType, idempotencyKey, JSON.stringify(request)]
  );
  const row = inserted.rows[0] ?? (await query(
    `SELECT job_id, service, job_type, status, request
     FROM mpf.jobs WHERE service = 'crawler' AND idempotency_key = $1`,
    [idempotencyKey]
  )).rows[0];
  if (!row) {
    throw new Error("Crawler job could not be found after idempotency conflict");
  }
  if (row.job_type !== jobType || JSON.stringify(canonical(row.request)) !== JSON.stringify(canonical(request))) {
    throw new IdempotencyConflict();
  }
  return {
    job_id: row.job_id,
    service: row.service,
    job_type: row.job_type,
    status: row.status
  };
}
