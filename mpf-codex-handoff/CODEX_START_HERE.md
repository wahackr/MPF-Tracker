# Codex — Start Here (Current MPF-Tracker Architecture)

**Decision date:** 2026-10-09
**Repo:** https://github.com/wahackr/MPF-Tracker — branch `development`
**Source of truth:** `mpf-codex-handoff/IMPLEMENTATION.md` (the companion implementation plan). These two documents supersede previous MPF architecture prompts and obsolete architecture descriptions in README. They document the **target**, not a claim that the code already conforms.

## Read before changing code

1. Read **this document and the full companion `IMPLEMENTATION.md`**. Inspect any `AGENTS.md` and follow applicable repository instructions.
2. Inspect actual source, migrations, tests, original provider fixtures, Compose and sample n8n workflows. Do not assume the current FastAPI code is already compliant.
3. First produce a concise, concrete refactoring plan identifying current cross-module imports, old worker startup hooks, legacy endpoints, database privileges/migrations and which business behaviors must survive. Then **perform the refactor**, test and report results.

## Non-negotiable final architecture

| Business module | HTTP entry point | Execution |
|---|---|---|
| **Crawler** | Its own TypeScript/ExpressJS API (`mpf-crawler-api`) | API enqueues into PostgreSQL; independent **Python Crawler daemon** (`mpf-crawler-worker`) processes jobs |
| **Portfolio** | Its own TypeScript/ExpressJS API (`mpf-portfolio`) | Direct CRUD/reconciliation; **no worker** |
| **Purchase** | Its own TypeScript/ExpressJS API (`mpf-purchase`) | **Synchronous** HTTP-triggered calculation/transactions; **no queue/worker** |
| **Valuation** | Its own TypeScript/ExpressJS API (`mpf-valuation`) | **Synchronous** HTTP-triggered snapshots, read-only GET queries; **no queue/worker** |

- **Four independent business modules, four independently deployed Express APIs**, plus **one separate Crawler Python daemon**, and a shared PostgreSQL database/migration container.
- **No combined API gateway**, no shared internal application libraries (`shared/`, renamed `common/`, `core/`, `packages/shared/`, etc.), and no cross-module source imports. A module owns its own configuration, dependencies, Dockerfile, DB access and logic. External third-party packages are allowed.
- **n8n talks to each module over HTTP only**; n8n does **not** require direct PostgreSQL access. n8n independently schedules Crawler, Purchase and Valuation; Portfolio is user-driven. No automatic inter-service triggering.
- **Only Crawler is asynchronous** (HTTP 202 + job ID + polling). Crawler worker starts when **its own Docker container starts**, **never** via an API endpoint, FastAPI startup, or HTTP server thread. It safely claims jobs from PostgreSQL with leases/retries/heartbeat/fencing.
- **Portfolio/Purchase/Valuation execute directly in Express routes**, returning actual completed results and explicit partial/error outcomes. Do not use `mpf.jobs` for these modules.
- Use TypeScript + Express + `pg` + `zod` for each API, and `decimal.js` or equivalent precise decimal math for finance. Keep Python only for Crawler's actual download/parse/ingestion worker. No NestJS, ORM, DI framework or needless layers.
- Preserve existing SQL data, ownership, idempotency, historical financial behavior, provider parsers and fixtures; **no destructive database reset**.

## Verified sources and explicit blocker

- HSBC all-funds CSV fixture: **20 funds × 26 dates = 520 normalized records**; use BID/OFFER and source publication dates.
- Manulife fundslist fixture: **76 fund records**, memberships 31/45 across products 8/22. Use it for fund IDs and metadata; store prices only from each fund's `fundhistory` response. `DHK121` is a special interest fund whose zero price must not be stored as an ordinary fund price.
- Live Manulife `fundhistory` responses for `SHK122` and `DIS148` were inspected on 2026-10-12. They contain `priceHistory` entries with `asOfDate` and `price`; a small `SHK122` sample is saved as `fixtures/manulife_fundhistory_SHK122.json`. Other fund IDs remain unverified.
- Estimated MPF purchases are **not** confirmed trustee transactions. Use verified baseline + eligible later transaction deltas; never double count. Preserve exact price dates, missing/stale statuses, and no look-ahead valuation.

## Required work order

1. Audit repo and protect data; document the refactor plan.
2. Migrate Crawler API to minimal TypeScript/Express queue/status endpoints.
3. Move Python Crawler into its **own Docker-started daemon container** with reliable job claims and state.
4. Migrate Portfolio to independent direct-execution TypeScript/Express.
5. Migrate Purchase to independent direct-execution TypeScript/Express + precise decimals.
6. Migrate Valuation to independent direct-execution TypeScript/Express + precise decimals.
7. Remove old root `shared/`, FastAPI and non-Crawler worker/queue code. Keep separate Dockerfiles, separate source trees, separate DB credentials/grants.
8. Update Compose, SQL migrations, unit/integration tests, five example n8n workflows, README and other stale documentation. Keep examples separate from running n8n.

## Acceptance and reporting

- Prove all four Express APIs independently build and start, and Crawler worker stays alive when its API is stopped (and vice versa).
- Prove Purchase/Valuation run synchronously with no worker or job row; prove independently repeated POSTs don't duplicate economic transactions or snapshots.
- Prove no global shared source or cross-module imports/images; enforce DB write grants per owner.
- Crawler queue survives restarts, has heartbeat/retry/atomic claim/fencing, and reports partial provider failures honestly.
- Run actual tests and Docker builds. Report files changed, commands run, pass/fail and unresolved provider verification. Do not claim unrun tests passed.
- **No production deployment, changes to live n8n, or modification of production PostgreSQL data without explicit user authorization.**

**When any earlier prompt/spec/README conflicts, follow this document + `IMPLEMENTATION.md`. Do not create redundant version-numbered copies.**
