# MPF Portfolio Tracker

Modular MPF tracker with four independently deployable application modules and one shared PostgreSQL database.

## Application modules

- `mpf-crawler-api` (TypeScript + Express): enqueue crawler jobs, query crawler job status, list funds/prices
- `mpf-crawler-worker` (Python daemon): executes crawler jobs from `mpf.jobs`
- `mpf-portfolio` (TypeScript + Express): account, baseline, allocation, contribution-plan, reconciliation APIs (direct execution)
- `mpf-purchase` (TypeScript + Express): expected purchase processing + confirmation APIs (direct execution)
- `mpf-valuation` (TypeScript + Express): valuation snapshot/rebuild/query APIs (direct execution)
- `mpf-db` (PostgreSQL)
- `mpf-migrate` (one-shot migration runner)

There is no shared application-code directory. Modules are coupled only via PostgreSQL schema contracts.

## Repository layout

```text
.
├── compose.yaml
├── crawler/
│   ├── api/src/              # app.ts, main.ts, libs/, __tests__/
│   ├── tests/
│   │   ├── contracts/
│   │   └── integration/
│   └── worker/src/           # app.py, main.py, libs/, __tests__/
├── portfolio/src/            # app.ts, main.ts, routes/, libs/, __tests__/
├── purchase/src/             # app.ts, main.ts, libs/, __tests__/
├── valuation/src/            # app.ts, main.ts, libs/, __tests__/
├── migrations/
├── scripts/
├── n8n/workflows/
└── pytest.ini
```

## Quick start

1. Copy environment file:

   ```bash
   cp .env.example .env
   ```

2. Ensure private n8n network exists:

   ```bash
   docker network inspect automation >/dev/null 2>&1 || docker network create automation
   ```

3. Start stack:

   ```bash
   docker compose up -d --build
   ```

4. Check status:

   ```bash
   docker compose ps -a
   docker compose logs -f mpf-migrate
   ```

## Environment highlights

See [`.env.example`](./.env.example).

- `CRAWLER_USE_FIXTURES=false` by default (live crawling by default)
- Set `CRAWLER_USE_FIXTURES=true` explicitly for local deterministic tests/dev
- Optional `CRAWLER_FIXTURE_DIR` can override fixture path (auto-detects container/local defaults otherwise)
- `WORKER_POLL_INTERVAL_SECONDS`, `WORKER_LEASE_SECONDS`, `WORKER_HEARTBEAT_SECONDS` control crawler worker leasing

## API overview

All `/v1/*` routes require `X-API-Key`.

### Crawler API

- `POST /v1/crawl/jobs/sync`
- `POST /v1/crawl/jobs/backfill`
- `GET /v1/crawl/jobs/{job_id}`
- `GET /v1/funds`
- `GET /v1/funds/{fund_id}/prices`

### Portfolio API

- `GET /v1/accounts`
- `POST /v1/accounts`
- `GET /v1/accounts/{id}`
- `PUT /v1/accounts/{id}`
- `GET /v1/accounts/{id}/holdings`
- `POST /v1/accounts/{id}/baselines`
- `GET /v1/accounts/{id}/allocation-rules`
- `PUT /v1/accounts/{id}/allocation-rules`
- `GET /v1/accounts/{id}/contribution-plans`
- `PUT /v1/accounts/{id}/contribution-plans`
- `POST /v1/accounts/{id}/reconciliations`

### Purchase API

- `POST /v1/purchases/process`
- `GET /v1/purchases/events`
- `GET /v1/purchases/transactions`
- `POST /v1/purchases/events/{event_id}/confirm`

### Valuation API

- `POST /v1/valuation/snapshot`
- `POST /v1/valuation/rebuild`
- `GET /v1/valuation/latest`
- `GET /v1/valuation/as-of?date=YYYY-MM-DD`
- `GET /v1/valuation/history`

### Health

- `GET /health` is public on each API container.

## Database ownership contracts

- Crawler-owned writes: `funds`, `fund_aliases`, `fund_scheme_memberships`, `fund_prices`, `jobs`
- Portfolio-owned writes: `accounts`, `holdings_baselines`, `allocation_rules`, `contribution_plans`, `reconciliation_records`
- Purchase-owned writes: `contribution_events`, `purchase_transactions`
- Valuation-owned writes: `portfolio_snapshots`, `snapshot_fund_values`
- Cross-service invalidation contract: `snapshot_invalidation_requests` (insert by crawler/portfolio/purchase, consume by valuation)

## n8n workflows

Importable examples are under [`n8n/workflows/`](./n8n/workflows/):

1. Daily crawler sync
2. Manual HSBC backfill for recovery (Manulife history requires a verified source schema)
3. Expected purchase processing
4. Daily valuation snapshot
5. On-demand valuation

n8n communicates via HTTP only.
The daily crawler example polls the queued job to a terminal status and fails its run on
`partial` or `failed`. The manual backfill example avoids an automatic broad history crawl.

## Testing

Unit tests:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -r crawler/worker/requirements.txt
.venv/bin/python -m pytest -q
for service in crawler/api portfolio purchase valuation; do (cd "$service" && npm test); done
```

Integration tests (dockerized, includes container-isolation assertions):

```bash
.venv/bin/python -m pytest -m integration -q
```

Live crawler smoke tests (real provider APIs, opt-in):

```bash
MPF_RUN_LIVE_TESTS=1 .venv/bin/python -m pytest -m live -q
```

By default these tests are skipped unless `MPF_RUN_LIVE_TESTS=1` is set.
Run one provider at a time with `MPF_RUN_LIVE_TESTS=1 .venv/bin/python -m pytest -q crawler/worker/src/__tests__/live/test_hsbc_live.py` or the corresponding `test_manulife_live.py` path.

## Known limitations / explicit caveats

- Real Manulife `fundhistory` schema remains unverified in this environment; worker reports blocked/unverified historical failures explicitly.
- Crawler job execution is asynchronous and durable via `mpf.jobs`.
- Purchase and valuation execute synchronously via HTTP endpoints and do not use `mpf.jobs`.
