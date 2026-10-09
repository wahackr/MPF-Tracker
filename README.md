# MPF Portfolio Tracker

Self-hosted MPF tracking system using four independent FastAPI services and one PostgreSQL database.

## Services

- `mpf-crawler` — fund metadata + price ingestion
- `mpf-portfolio` — accounts, baselines, allocation rules, contribution plans, reconciliations
- `mpf-purchase` — expected contribution event processing and estimated/confirmed purchase transactions
- `mpf-valuation` — on-demand read-only valuation plus snapshot/rebuild jobs
- `mpf-db` — PostgreSQL

All services are independent containers. n8n is expected to schedule and trigger them independently over internal HTTP.

## Repo layout

```text
.
├── compose.yaml
├── migrations/
│   ├── Dockerfile
│   ├── requirements.txt
│   └── sql/
├── mpf-codex-handoff/fixtures/
├── scripts/
├── services/
│   ├── crawler/
│   │   ├── Dockerfile
│   │   └── requirements.txt
│   ├── portfolio/
│   │   ├── Dockerfile
│   │   └── requirements.txt
│   ├── purchase/
│   │   ├── Dockerfile
│   │   └── requirements.txt
│   └── valuation/
│       ├── Dockerfile
│       └── requirements.txt
├── shared/
└── tests/
```

## Container isolation model

- Each application service has its own Dockerfile, entrypoint, and dependency definition.
- Service images copy only:
  - `shared/` infrastructure utilities
  - `services/__init__.py`
  - their own service package (`services/<service>/`)
- The crawler image additionally includes fixture data under `mpf-codex-handoff/fixtures/`.
- No service image copies unrelated service source directories.

## Quick start

1. Create `.env` from sample:

   ```bash
   cp .env.example .env
   ```

2. Ensure private Docker network for n8n connectivity exists:

   ```bash
   docker network inspect automation >/dev/null 2>&1 || docker network create automation
   ```

3. Start stack:

   ```bash
   docker compose up -d --build
   ```

4. Check all services:

   ```bash
   docker compose ps -a
   docker compose logs -f mpf-migrate
   ```

## Security / access

- `/health` is public.
- All `/v1/*` endpoints require `X-API-Key`.
- Services expose internal port `8000` with Docker `expose` only (no host port mapping by default).
- PostgreSQL is not published to host by default.

## Environment variables

See [.env.example](./.env.example). Key settings:

- `ENABLE_JOB_WORKER=true` — enables background job processing loops
- `CRAWLER_USE_FIXTURES=true` — use supplied real fixtures from [mpf-codex-handoff/fixtures/](./mpf-codex-handoff/fixtures/)
- `N8N_NETWORK=automation` — external Docker network name shared with n8n

## API overview

### Crawler (`mpf-crawler`)

- `POST /v1/crawl/jobs/sync`
- `POST /v1/crawl/jobs/backfill`
- `GET /v1/crawl/jobs/{job_id}`
- `GET /v1/funds`

### Portfolio (`mpf-portfolio`)

- `POST /v1/accounts`
- `GET /v1/accounts`
- `POST /v1/accounts/{id}/baselines`
- `GET /v1/accounts/{id}/holdings`
- `PUT /v1/accounts/{id}/allocation-rules`
- `PUT /v1/accounts/{id}/contribution-plans`
- `POST /v1/accounts/{id}/reconciliations`

### Purchase (`mpf-purchase`)

- `POST /v1/purchase/jobs/process-due`
- `GET /v1/purchase/jobs/{job_id}`
- `GET /v1/purchase/events`
- `POST /v1/purchase/events/{id}/confirm`

### Valuation (`mpf-valuation`)

- `POST /v1/valuation/jobs/snapshot`
- `GET /v1/valuation/jobs/{job_id}`
- `GET /v1/valuation/latest`
- `GET /v1/valuation/as-of?date=YYYY-MM-DD`
- `GET /v1/valuation/history`
- `POST /v1/valuation/jobs/rebuild`

## Example calls

```bash
curl -X POST http://mpf-crawler:8000/v1/crawl/jobs/sync \
  -H "X-API-Key: ${API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"provider":"all","rolling_days":7}'

curl -X POST http://mpf-purchase:8000/v1/purchase/jobs/process-due \
  -H "X-API-Key: ${API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"as_of_date":"2026-10-07"}'

curl -X POST http://mpf-valuation:8000/v1/valuation/jobs/snapshot \
  -H "X-API-Key: ${API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"as_of_date":"2026-10-07"}'

curl "http://mpf-valuation:8000/v1/valuation/latest" \
  -H "X-API-Key: ${API_KEY}"
```

## Job model

- Jobs are durable rows in `mpf.jobs`.
- API enqueues and returns `202` with `job_id`.
- Service workers claim jobs using `FOR UPDATE SKIP LOCKED`.
- Poll status via service-specific `GET /v1/.../jobs/{job_id}` endpoints.

## Database ownership contracts

All services connect to the same PostgreSQL database, with table write ownership split as follows:

- **Crawler-owned writes**: `mpf.funds`, `mpf.fund_aliases`, `mpf.fund_scheme_memberships`, `mpf.fund_prices`
- **Portfolio-owned writes**: `mpf.accounts`, `mpf.holdings_baselines`, `mpf.allocation_rules`, `mpf.contribution_plans`, `mpf.reconciliation_records`
- **Purchase-owned writes**: `mpf.contribution_events`, `mpf.purchase_transactions`
- **Valuation-owned writes**: `mpf.portfolio_snapshots`, `mpf.snapshot_fund_values`
- **Shared infrastructure tables**: `mpf.jobs`, `mpf.snapshot_invalidation_requests`

Services may read across ownership boundaries, but business-table writes are constrained by role grants in centralized SQL migrations.

## Database migrations

- SQL migrations are in [migrations/sql/](./migrations/sql/).
- Migration runner: [scripts/migrate.py](./scripts/migrate.py)
- `mpf-migrate` runs once before application services are treated as ready.

## Backups

Backup:

```bash
mkdir -p data/backups
docker compose exec -T mpf-db pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" > "data/backups/mpf_$(date +%F_%H%M%S).sql"
```

Restore:

```bash
cat data/backups/<backup_file>.sql | docker compose exec -T mpf-db psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}"
```

## Tests

Unit tests:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest -q
```

Integration (one command, dockerized):

```bash
.venv/bin/python -m pytest -m integration -q
```

The integration suite starts/stops its own Compose project (`mpf-itest`), resets local PostgreSQL bind-mount data, and validates cross-service workflow behavior.
It also verifies each service container excludes other services' source trees.

Unit test coverage includes:

- HSBC fixture parser: 520 normalized rows (20 funds × 26 dates)
- HSBC malformed/duplicate/invalid negative cases
- Manulife fundslist fixture counts and special interest-fund handling
- API auth/health contract checks

## n8n sample workflows

Importable examples are in [n8n/workflows/](./n8n/workflows/).  
They are examples only and are **not** auto-installed anywhere.

- [MPF-01-Daily-Prices.json](./n8n/workflows/MPF-01-Daily-Prices.json)
- [MPF-02-Weekly-Backfill.json](./n8n/workflows/MPF-02-Weekly-Backfill.json)
- [MPF-03-Expected-Purchases.json](./n8n/workflows/MPF-03-Expected-Purchases.json)
- [MPF-04-Daily-Valuation.json](./n8n/workflows/MPF-04-Daily-Valuation.json)
- [MPF-05-OnDemand-Valuation.json](./n8n/workflows/MPF-05-OnDemand-Valuation.json)

## Known limitations / unverified items

- Real Manulife `fundhistory` JSON schema is still unverified in this environment due access denial from source endpoint.
- With `CRAWLER_USE_FIXTURES=true`, crawler imports supplied fixtures only (deterministic tests).
- `fundhistory` backfill reports per-fund blocked/unverified failures when fixture or live payload is unavailable.
