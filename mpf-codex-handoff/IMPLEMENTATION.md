# MPF Portfolio Tracker — Implementation Plan

**Architecture decision:** 2026-10-09
**Status:** Authoritative *target* architecture for Codex refactor; existing code may still use the old FastAPI/shared-worker architecture.
**Repository:** https://github.com/wahackr/MPF-Tracker — `development` branch
**Start here:** `CODEX_START_HERE.md` in the same directory.

> **Non-negotiable:** Four independently deployed business modules, each with its **own TypeScript/ExpressJS API**. **Only Crawler** has an additional independent Python daemon and PostgreSQL-backed asynchronous jobs. Portfolio, Purchase and Valuation execute requests directly and synchronously. No root `shared/` library, renamed equivalent, or cross-module application-code imports. n8n only uses HTTP; it does not connect to PostgreSQL.

## 1. Goal and scope

Build a self-hosted MPF tracker for HSBC and Manulife: ingest published fund prices and history; record verified holdings and versioned allocation/contribution rules; estimate purchases without claiming they are confirmed; calculate daily and on-demand values; reconcile actual eMPF holdings later. Retain historical integrity, auditability, precision, and data-source provenance.

This is a **refactor**, not a new product or a license to delete features. Inspect the current repository, SQL migrations, fixtures, tests, n8n examples and financial logic first. Preserve data and working functionality. Do **not** deploy to production, modify live n8n workflows, or reset any production database without explicit permission.

Non-goals: eMPF login or private API automation, placement of actual trades, public web hosting, multi-user tenancy, headless scraping, a new frontend as a prerequisite, Redis/RabbitMQ/Celery/Kafka, and a combined API gateway.

## 2. Architecture

| Module | Runtime containers | Responsibility | Execution |
|---|---|---|---|
| Crawler | `mpf-crawler-api` (TS/Express) + `mpf-crawler-worker` (Python) | Job submission/status/fund queries; HSBC & Manulife price ingestion | API returns HTTP 202; dedicated Python daemon claims DB jobs |
| Portfolio | `mpf-portfolio` (TS/Express) | Accounts, holdings baselines, allocations, contribution plans, reconciliation | Direct HTTP execution, **no queue or worker** |
| Purchase | `mpf-purchase` (TS/Express) | Expected contribution/purchase processing, confirmation | Direct HTTP execution, **no queue or worker** |
| Valuation | `mpf-valuation` (TS/Express) | Portfolio value calculations, snapshots/rebuild, history | Direct HTTP execution, **no queue or worker** |
| Database | `mpf-db` (PostgreSQL) | Durable business data and crawler-only job queue | Central migrations via one-shot `mpf-migrate` |

```text
                       n8n (scheduler, HTTP only)
                        /      |        |         \
                       v       v        v          v
                Crawler API  Portfolio Purchase  Valuation
                 TS/Express  TS/Express TS/Express TS/Express
                       |       |        |          |
                       +-------+--------+----------+
                                       |
                                  PostgreSQL
                                       ^
                                       | queued crawler jobs + prices
                              Crawler Python daemon
                                 /            \
                               HSBC          Manulife
```

- **One module, one business owner.** Do not put Portfolio endpoints in a Crawler or central API server.
- Every module has its own Dockerfile, runtime dependencies, configuration, database wrapper and API source. The Python worker has its own Dockerfile.
- **No `shared/`, `common/`, `core/`, `packages/shared/`, global DTO or internal helper package.** No imports of other modules' source. Small technical duplication is intentional and acceptable. Shared third-party packages (`pg`, `express`, `zod`, `decimal.js`) are fine.
- PostgreSQL **schemas/contracts** are the integration boundary; explicit table write ownership and least-privilege DB roles. Central migrations, integration tests and documentation are not runtime shared libraries.
- n8n triggers each operation independently. No automatic Crawler → Purchase → Valuation calls.

## 3. Technology and precision

- ExpressJS + TypeScript + Node.js 22+ for all four APIs. Use `pg`, `zod`, parameterized SQL, `X-API-Key` for non-health routes, concise handlers. Avoid NestJS, Prisma, TypeORM, DI frameworks and gratuitous controller/service/repository hierarchies.
- Python 3.12+ for **Crawler worker only**; reuse existing Python provider HTTP/CSV/JSON/parsing/DB ingestion code where sound. No FastAPI or HTTP server in Python worker.
- JavaScript `number` must **not** be used for amounts, unit prices, units or financial calculation: use `decimal.js` (or equivalent) and PostgreSQL `NUMERIC`, with numeric values serialized as decimal strings where appropriate. Python uses `Decimal`. Preserve rounding rules and verify results against old Python fixtures.
- `TIMESTAMPTZ` for audit timestamps; `Asia/Hong_Kong` for business/schedule dates; source price publication dates must remain distinct from download timestamps.

## 4. Crawler module

### 4.1 TypeScript/Express Crawler API

| Method | Path | Outcome |
|---|---|---|
| POST | `/v1/crawl/jobs/sync` | Validate, enqueue, HTTP **202** + `job_id` |
| POST | `/v1/crawl/jobs/backfill` | Validate date range and provider, enqueue, HTTP **202** + `job_id` |
| GET | `/v1/crawl/jobs/:jobId` | Status and detailed actual result/errors |
| GET | `/v1/funds` | Read fund master |
| GET | `/v1/funds/:fundId/prices` | Read stored price history |
| GET | `/health` | API/DB readiness (not proof ingestion is complete) |

Example daily sync body: `{"provider":"all","rolling_days":7}`. Example backfill: `{"provider":"hsbc","from_date":"2026-09-01","to_date":"2026-10-07"}`. Explicit manual backfill dates are authoritative. Broad Manulife history recovery is manual pending source verification.

API scope: authenticate → validate → parameterized INSERT/SELECT in PostgreSQL → return. **Never start, import, execute or manage the Python worker through API endpoints or application startup hooks.** Preserve `Idempotency-Key` behavior without silently mutating an existing job request.

### 4.2 Independent Python worker daemon

Its own Docker container runs `python -m crawler_worker.app` directly as PID 1 (or appropriate exec-style entrypoint). On startup it connects to PostgreSQL and monitors `mpf.jobs` for Crawler jobs. Polling about every 2 seconds is sufficient; optional `LISTEN/NOTIFY` may speed wakeups but must not be required for correctness. It claims a job atomically (`FOR UPDATE SKIP LOCKED`), downloads/validates/upserts fund data, commits result/status and waits again.

Reliability requirements: worker identity and fencing token; lease refresh/heartbeat **during** long jobs; bounded retry attempts and abandoned lease recovery; safe PostgreSQL transactions; graceful SIGTERM; exact per-provider/per-fund failures; accurate full/partial/failed final status; idempotent writes. Expired worker must not overwrite a newer job result. The worker must operate while Crawler API is stopped. The API must enqueue while the worker is stopped.

### 4.3 Verified HSBC source

`GET https://rbwm-api.hsbc.com.hk/wpb-gpbw-mmw-hk-hbap-pa-p-wpp-mpf-market-data-prod-proxy/v1/download-funds`

Query parameters: `schemeCodes=HB`, `fundPricePeriodFrom=YYYY-MM-DD`, `fundPricePeriodTo=YYYY-MM-DD`, `language=en_US`. Do **not** set `fundCode` for an all-funds request. `fundCode=FMF` is only a single-fund example (Age 65 Plus Fund).

The supplied `fixtures/hsbc_all_supertrust_20260901_20261007.csv` contains **20 funds × 26 dates = 520 fund-date rows**, represented as one fund-name column and 26 date-paired BID/OFFER columns. CSV first header row repeats each date twice; second header row is BID, OFFER; data is wide. Preserve both BID and OFFER, unpivot to dated fund records, validate all columns/BOM/date/decimal/duplicates. Limit download requests to cautious date chunks (initially maximum 28 days). Store `price_date` as provider publication date; missing holiday dates are not zero. Maintain stable fund aliases and scheme HB mapping.

### 4.4 Verified Manulife fund list source

`GET https://scmpf.manulife.com.hk/bin/funds/fundslist?productLine=mpf&overrideLocale=en_HK`

The supplied `fixtures/manulife_fundslist.json` contains **76 fund records**: 31 associated with product ID `8`, 45 with ID `22`. Use it to discover fund IDs and retain fund metadata, including the special interest fund `DHK121`. Some records have `displayFrontend=false`; do not conflate products or discard memberships. Use stable `fundId` prefixed by provider. Ignore the funds list's `nav` price data; every stored Manulife price comes from that fund's `fundhistory` response.

### 4.5 Manulife historical recovery

`GET https://scmpf.manulife.com.hk/bin/funds/fundhistory?id=SHK122&productLine=mpf&overrideLocale=en_HK`

A live response for `SHK122` was inspected on 2026-10-12. It contained `priceHistory` entries with `asOfDate` and `price`, and reported a history from 2000-12-01 to 2026-10-08 (6,359 entries). A small sample using the observed fields is saved as `fixtures/manulife_fundhistory_SHK122.json`. Both sync and backfill fetch the funds list first, then history for each returned fund ID. Sync defaults to a seven-day window; backfill uses the caller's explicit `from_date` and `to_date` with no fixed cap unless the caller also supplies `manulife_filter_days` as an explicit recency cap. Filter fetched history locally to that window. Other fund IDs and live production backfill remain unverified. Use bounded parallelism (initially three), timeout, retry/backoff for 429/5xx, and per-fund diagnostics.

The `DIS148` history endpoint was also checked on 2026-10-12; it returned 1,327 dated `priceHistory` entries. Fund identity and metadata come from `fundslist`; stored prices come only from `fundhistory`.

These are public website backing URLs, not formally supported APIs. Handle access denial, layout changes and provider terms without bypassing controls.

## 5. Portfolio — direct Express API

Own accounts, verified/estimated holdings baselines, versioned allocations, contribution plans and reconciliations. No worker, queue, Python, or scheduled process in this module.

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/v1/accounts` | List/create |
| GET/PUT | `/v1/accounts/:id` | Read/update |
| POST | `/v1/accounts/:id/baselines` | Record confirmed/estimated unit holdings |
| GET | `/v1/accounts/:id/holdings` | Effective holdings with units status |
| GET/PUT | `/v1/accounts/:id/allocation-rules` | Read/version allocation rules |
| GET/PUT | `/v1/accounts/:id/contribution-plans` | Read/configure contributions |
| POST | `/v1/accounts/:id/reconciliations` | Append actual eMPF correction/baseline |
| GET | `/health` | Readiness |

- Baseline uses actual per-fund units when verified. If only market value is supplied, inferred units must be marked `ESTIMATED`; if only total account value is supplied, do not invent the constituent funds.
- Allocation rules are versioned by account, contribution stream and effective dates. Applicable weights sum to 100% when a full rule set is published; allow draft/incomplete only when explicit.
- Reconciliation preserves earlier records and audit trail; new authoritative baseline must not double-count pre-baseline purchases. Historical snapshots affected by correction should be marked invalidated for explicit rebuild.

## 6. Purchase — direct Express API

**No worker, queue, daemon, asynchronous job endpoint or Python.** n8n HTTP POST waits for processing to finish, then receives the actual result.

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/purchases/process` | Process due events synchronously (e.g. `{"as_of_date":"2026-10-09"}`) |
| GET | `/v1/purchases/events` | Pending/estimated/confirmed contribution events |
| GET | `/v1/purchases/transactions` | Purchase ledger |
| POST | `/v1/purchases/events/:id/confirm` | Confirm actual date/units with audit trail |
| GET | `/health` | Readiness |

Read effective contribution plan and allocations, identify due periods/streams, determine eligible fund prices, estimate per-fund cash/unit purchases using precise decimals, and transactionally persist events and transactions. Do **not** infer actual trustee trade date from planned contribution date. Suggested states: `EXPECTED`, `WAITING_FOR_PRICE`, `ESTIMATED`, `CONFIRMED`, `ADJUSTED`, `FAILED_REVIEW`, `CANCELLED` as applicable. Default estimation policy might select first eligible published price on/after expected date within a bounded window, recording the **actual** selected price date. No future price may leak into an earlier as-of valuation.

Unique constraints such as `(plan_id, period)` and `(event_id, fund_id)` plus transactions and locking must make repeated/concurrent HTTP calls safe. No double-counted economic units. Missing prices return explicit pending/partial results; do not fabricate purchases. Return success only after request finished, not merely accepted. Do not trigger Valuation automatically.

## 7. Valuation — direct Express API

**No worker, queue, daemon, asynchronous job endpoint or Python.** n8n HTTP POST waits for calculation/snapshot completion.

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/valuation/snapshot` | Calculate/upsert snapshot synchronously (body e.g. `{"as_of_date":"2026-10-09"}`) |
| POST | `/v1/valuation/rebuild` | Bounded synchronous rebuild of invalidated dates |
| GET | `/v1/valuation/latest` | Read-only current/as-of calculation |
| GET | `/v1/valuation/as-of?date=YYYY-MM-DD` | Read-only historical as-of calculation |
| GET | `/v1/valuation/history` | Stored snapshots |
| GET | `/health` | Readiness |

Effective units on date D = **most recent applicable baseline effective on or before D** + eligible unit-changing transactions **strictly after that baseline and on/before D**. Define whether confirmed-only or confirmed-plus-estimated is used; preserve both distinctions where necessary. Use latest eligible published price with `price_date <= D`, never look ahead. HSBC BID and Manulife history price are **candidate provider-specific valuation conventions** to validate against trustee reporting.

Each per-fund result must include units, verification state, selected price/type/date, source and stale/missing status. Return `PARTIAL` / `STALE`, priced subtotal and unpriced breakdown rather than a misleading complete value. Daily snapshot is derived data with `(account_id, as_of_date)` uniqueness, revision/invalidation/rebuild semantics; ordinary on-demand GET must not write or fetch external provider prices. Distinguish portfolio market-value change (includes contributions) from approximate cash-flow-adjusted P&L; only calculate meaningful return or XIRR if required cash-flow history is available. No unsupported performance estimates.

## 8. PostgreSQL ownership and migrations

Keep the existing `mpf` database and tables where possible; **do not reset existing data**. Central SQL migrations are acceptable; only the one-shot migration container owns DDL.

| Tables | Write owner |
|---|---|
| `mpf.funds`, `mpf.fund_aliases`, `mpf.fund_scheme_memberships`, `mpf.fund_prices` | Crawler worker |
| `mpf.accounts`, `mpf.holdings_baselines`, `mpf.allocation_rules`, `mpf.contribution_plans`, reconciliation/audit | Portfolio API |
| `mpf.contribution_events`, `mpf.purchase_transactions` | Purchase API |
| `mpf.portfolio_snapshots`, `mpf.snapshot_fund_values` | Valuation API |
| `mpf.jobs` | Crawler API inserts/reads; Crawler worker claims/updates |
| `mpf.snapshot_invalidation_requests` | Approved producer/consumer grants according to its cross-module contract |

The Crawler API and worker need separate least-privilege credentials where practical; other modules can read relevant tables across boundaries but cannot write other modules' business tables. API should never get the DB superuser credentials. Enforce referential integrity and date/identity/idempotency constraints. On retries, UPSERT may update corrections but must not erase unrelated past data. Existing `mpf.jobs` rows from Purchase/Valuation may require a documented non-destructive transition; do **not** drop them without an approved retention/migration policy.

## 9. n8n workflows

n8n **only sends HTTP** and is not granted PostgreSQL connectivity. Keep five independent workflows and **update example files** (not running workflows) to the new API paths/semantics.

| Workflow | Illustrative HKT schedule | Target | Completion semantics |
|---|---|---|---|
| MPF-01 Daily Prices | Daily 07:00 | `POST http://mpf-crawler-api:8000/v1/crawl/jobs/sync` | HTTP 202 → poll `GET /v1/crawl/jobs/:jobId` until terminal; alert on partial/failure |
| MPF-02 Manual Backfill | Manual recovery | `POST http://mpf-crawler-api:8000/v1/crawl/jobs/backfill` | HTTP 202 → poll and inspect per-fund failures; example targets HSBC while Manulife history is unverified |
| MPF-03 Expected Purchases | Daily 08:00 | `POST http://mpf-purchase:8000/v1/purchases/process` | Wait for actual completed operation; inspect pending and errors |
| MPF-04 Daily Valuation | Daily 08:30 | `POST http://mpf-valuation:8000/v1/valuation/snapshot` | Wait for completed operation; handle missing/stale prices |
| MPF-05 On-demand | Manual/Telegram | `GET http://mpf-valuation:8000/v1/valuation/latest` | Read-only; no crawler/purchase side effects |

Schedules are provisional and should use `Asia/Hong_Kong` timezone. No workflow should automatically trigger another responsibility. Use appropriate API timeouts, retries and error notifications; do not put full fund CSV/JSON history in n8n. Do not modify installed n8n workflows without explicit approval.

## 10. Required repository layout and Docker

```text
MPF-Tracker/
├── crawler/
│   ├── api/               # TS Express; own Dockerfile, package.json, tsconfig.json, src/
│   └── worker/            # Python daemon; own Dockerfile, requirements.txt, src/
├── portfolio/             # TS Express; own Dockerfile, package.json, src/
├── purchase/              # TS Express; own Dockerfile, package.json, src/
├── valuation/             # TS Express; own Dockerfile, package.json, src/
├── migrations/            # Central schema migrations; one-shot migration container
├── mpf-codex-handoff/     # These authoritative docs + original fixtures
├── n8n/workflows/         # Importable examples only
├── crawler/tests/         # Crawler-adjacent integration + architecture checks
├── crawler/worker/src/__tests__/  # Crawler worker unit + live checks
├── compose.yaml
├── .env.example
└── README.md
```

Compose roles: `mpf-crawler-api`, `mpf-crawler-worker`, `mpf-portfolio`, `mpf-purchase`, `mpf-valuation`, `mpf-db`, `mpf-migrate` (one shot). Five running application containers (four APIs + one Crawler daemon), PostgreSQL, and one-shot migration. All images contain **only the owning module's source and dependencies**. API containers join private n8n network plus internal DB network; worker joins only DB network. PostgreSQL has no published public port; HTTP services are internal-only by default. Use persistent PostgreSQL bind mount compatible with Postgres major version, health checks, secure environment injection, graceful shutdown, backup/restore runbook, and non-destructive migrations. **Never make API startup spawn the worker.** The worker uses real provider endpoints; tests mock HTTP responses with saved provider data.

## 11. Testing / definition of done

- HSBC fixture unpivots to exactly 520 records; robust negative parser cases; BID/OFFER source dates retained.
- Manulife fundslist fixture produces 76 fund identities and product mappings 31/45. It supplies no stored prices. The historical parser accepts the observed `SHK122` response shape and its saved sample; `DIS148` history was also inspected. Other fund IDs require live validation.
- Each of four Express APIs builds and runs independently; route sets and DB permissions are owner-scoped; **no shared application library or cross-module imports**.
- Crawler worker runs without API, API can queue while worker stopped, worker processes pending queue on restart, status is accurate, and retry/heartbeat/fencing are tested.
- Portfolio direct CRUD/reconciliation preserves effective dates and audit history.
- Purchase direct POST is synchronous, idempotent and concurrency-safe; retries don't create extra units; missing-price paths are explicit; decimal financial results match verified old behavior.
- Valuation direct POST is synchronous, read-only GET has **no DB mutations or external provider calls**; no look-ahead, no baseline double count, snapshot revisions and invalidations work; precise TypeScript calculations match reference cases.
- Example n8n workflows use **only Crawler async polling**, with Purchase/Valuation synchronous responses and correct service hostnames; workflows remain independent.
- Build all images independently, run actual unit and integration tests, verify image source isolation, DB roles, worker restart and stored-data preservation. Report **actual** commands and pass/fail; never claim unrun tests passed.
- README, Compose, example workflows, start-here and this spec must all agree. No redundant version-numbered duplicate documents.

## 12. Codex execution sequence

1. **Audit** current `development` repo: FastAPI routes, `shared/` imports, current queue, service Dockerfiles, migrations, formulas, fixtures and n8n examples. Make concise migration/refactor plan and identify data-risk points.
2. **Crawler API**: convert to TypeScript/Express minimal job insert/status and fund/price query routes; no worker lifecycle within API.
3. **Crawler Worker**: extract/reuse Python provider clients/parsers/upsert code into independent Docker-started daemon; implement queue reliability, status and safe shutdown.
4. **Portfolio API**: migrate to standalone TypeScript/Express, direct database operations, no queue.
5. **Purchase API**: port precise calculations to TypeScript/`decimal.js`; direct synchronous idempotent processing; no job endpoint/worker.
6. **Valuation API**: port calculations and snapshots to TypeScript/`decimal.js`; direct synchronous snapshot/rebuild and read-only GET; no worker.
7. **Isolation cleanup**: remove old `shared/`, FastAPI applications, Purchase/Valuation queued jobs and old source imports. **Preserve database content** and replace only after validating behavior.
8. **Integration**: update grants, additive migrations, Compose, example n8n JSON, tests, README and handoff documentation. Execute available tests/builds, record failures/blockers. Do not deploy production without permission.

**Follow through on implementation, not only a plan**, unless an external dependency is genuinely blocking. When code conflicts with this document, this **2026-10-09 target architecture wins**; existing code and README describe the old state until refactored.

## Appendix: Internal HTTP examples

```bash
curl -X POST http://mpf-crawler-api:8000/v1/crawl/jobs/sync \
  -H 'X-API-Key: REPLACE_ME' -H 'Content-Type: application/json' \
  -d '{"provider":"all","rolling_days":7}'
# HTTP 202; subsequently GET /v1/crawl/jobs/<job_id> until terminal.

curl -X POST http://mpf-purchase:8000/v1/purchases/process \
  -H 'X-API-Key: REPLACE_ME' -H 'Content-Type: application/json' \
  -d '{"as_of_date":"2026-10-09"}'
# Synchronous actual processing result.

curl -X POST http://mpf-valuation:8000/v1/valuation/snapshot \
  -H 'X-API-Key: REPLACE_ME' -H 'Content-Type: application/json' \
  -d '{"as_of_date":"2026-10-09"}'
# Synchronous completed snapshot or explicit partial/error result.

curl -H 'X-API-Key: REPLACE_ME' http://mpf-valuation:8000/v1/valuation/latest
# Side-effect-free read.
```
