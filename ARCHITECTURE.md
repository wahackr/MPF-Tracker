# MPF-Tracker structure

The code follows the same small entry point → orchestration → local integration libraries pattern used by `Rankbot-Prompt-Research-Analyser`. Each MPF service keeps its own source, dependencies, and tests because the services are deployed independently.

```text
crawler/
  api/src/          index.ts, app.ts, main.ts, libs/, __tests__/
  worker/src/       app.py, main.py, libs/{hsbc,manulife,db,...}.py, __tests__/
  tests/            cross-service contracts and Docker integration
portfolio/src/      index.ts, app.ts, main.ts, routes/, libs/, __tests__/
purchase/src/       index.ts, app.ts, main.ts, libs/, __tests__/
valuation/src/      index.ts, app.ts, main.ts, libs/, __tests__/
migrations/sql/     additive shared PostgreSQL contracts
n8n/workflows/      importable scheduling examples
```

- `index.ts` or `app.py` starts one runtime. `app.ts` wires HTTP middleware and routes.
- `main.ts` or `main.py` coordinates a business operation. Provider HTTP and reusable persistence helpers live in service local libraries.
- `libs/` holds service local database, provider, and calculation adapters. HSBC and Manulife each own their fetch and crawl flow; only HTTP retry and fixture loading are shared. No service imports another service's source.
- `src/__tests__/unit/` covers business rules and adapters without external services. `crawler/tests/integration/` exercises the full stack using an isolated temporary PostgreSQL mount.
- n8n submits crawler work and polls the returned job. A daily short rolling sync is scheduled; broad backfill is a manual recovery operation.

Run Python unit tests with `python -m pytest -q -m "not integration and not live"`. Run `npm test` in each TypeScript service. The GitHub Actions test workflow runs these checks and the Docker integration suite on pushes and pull requests.
