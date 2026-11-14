# Deployment

Local Compose commands and shared PostgreSQL setup are described in the root [README](../README.md#quick-start).

## Automatic dev deployment

[deployment-dev-pipeline.yaml](../.github/workflows/deployment-dev-pipeline.yaml) follows the self-hosted Compose pipeline used by Quickbook Invoice Status. Changes to `src/`, `deploy/`, or the workflow on `development` trigger deployment. You can also run the workflow manually on `development`.

The workflow uses the repository’s self-hosted runner with `runs-on: self-hosted`; no custom runner label is required. The defaults are Docker context `dev` and GitHub environment `dev`. Deployments run sequentially and skip commits superseded by newer application or deployment changes. A second check after the image build avoids deploying an older commit that was superseded during the build. This pipeline deploys directly after a matching push; the separate Test workflow runs independently.

### Runner setup

Register a Linux self-hosted runner directly under this personal repository’s **Settings → Actions → Runners**. The runner needs Bash, Docker with Compose 2.24.4+, and access to the `dev` Docker context. The context must point to the intended deployment host. Create the external `automation` network on that Docker host, or configure `N8N_NETWORK` to use an existing network. The runner also needs outbound access to GitHub, Docker Hub, npm, and PyPI for checkout and builds.

Set the `dev` environment variable `DOCKER_CONTEXT` to choose another Docker context.

### GitHub configuration

Under **Settings → Environments → dev**, add these environment **secrets**:

| Secret | Used for |
| --- | --- |
| `API_KEY` | Authentication for all four APIs |
| `POSTGRES_PASSWORD` | PostgreSQL administrator / migration account |
| `CRAWLER_DB_PASSWORD` | Crawler API and worker role |
| `PORTFOLIO_DB_PASSWORD` | Portfolio role |
| `PURCHASE_DB_PASSWORD` | Purchase role |
| `VALUATION_DB_PASSWORD` | Valuation role |

On the same settings page, add these environment **variables** for the default shared PostgreSQL mode:

| Variable | Value / default |
| --- | --- |
| `POSTGRES_USER` | Required: existing administrator with role/schema management privileges |
| `SHARED_POSTGRES_HOST` | Required: server hostname reachable from app containers |
| `SHARED_POSTGRES_PORT` | `5432` |
| `POSTGRES_DB` | `mpf_dev`; create this database before deployment |
| `DB_MODE` | `shared` |

Service users are created by migration, with default names `mpf_dev_crawler`, `mpf_dev_portfolio`, `mpf_dev_purchase`, and `mpf_dev_valuation`. Use `CRAWLER_DB_USER`, `PORTFOLIO_DB_USER`, `PURCHASE_DB_USER`, and `VALUATION_DB_USER` to override them. Keep role names distinct from other deployments because PostgreSQL roles and their passwords are server-wide.

For bundled PostgreSQL, set `DB_MODE=bundled` and `POSTGRES_DATA_DIR` to an absolute directory **on the Docker host, outside the runner checkout**, such as `/srv/mpf-tracker-dev/postgres`. A runner checkout is disposable; PostgreSQL storage must persist independently. `POSTGRES_USER` and `POSTGRES_PASSWORD` initialize a new database only; for existing data they must match its existing administrator. `POSTGRES_HOST_PORT` defaults to `5432` and `POSTGRES_BIND_ADDRESS` to `127.0.0.1`.

Other optional variables:

| Variable | Default |
| --- | --- |
| `COMPOSE_PROJECT_NAME` | `mpf-tracker-dev` |
| `MPF_INTERNAL_NETWORK` | `mpf-tracker-dev-internal` |
| `N8N_NETWORK` | `automation` |
| `API_BIND_ADDRESS` | `0.0.0.0` |
| `CRAWLER_API_HOST_PORT` | `8001` |
| `PORTFOLIO_API_HOST_PORT` | `8002` |
| `PURCHASE_API_HOST_PORT` | `8003` |
| `VALUATION_API_HOST_PORT` | `8004` |
| `WORKER_POLL_INTERVAL_SECONDS` | `2` |
| `WORKER_LEASE_SECONDS` | `90` |
| `WORKER_HEARTBEAT_SECONDS` | `15` |

The workflow reads Actions variables and secrets from the `dev` environment, passes them directly through environment variables, and ignores `.env` files. GitHub accepts empty secrets but requires non-empty variable values. Configuration placeholders use `CHANGE_ME`; replace them before deployment, or delete optional variables to use their workflow defaults. Deployment validation rejects `CHANGE_ME` values. For shared PostgreSQL, delete the bundled-only `POSTGRES_BIND_ADDRESS`, `POSTGRES_HOST_PORT`, and `POSTGRES_DATA_DIR` placeholders to use defaults or leave the data directory unset. It builds all selected images, starts the selected Compose stack, and waits up to 180 seconds for migration completion and container health checks. It does not remove database storage. If readiness fails, the run fails and prints container status; it does not roll back database migrations.

No real deployment occurs until the workflow reaches `development` and a configured runner executes it.
