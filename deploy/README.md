# Deployment

Local Compose commands and shared PostgreSQL setup are described in the root [README](../README.md#quick-start).

## Automatic dev deployment

[deployment-dev-pipeline.yaml](../.github/workflows/deployment-dev-pipeline.yaml) follows the self-hosted Compose pipeline used by Quickbook Invoice Status. Changes to `src/`, `deploy/`, or the workflow on `development` trigger deployment. You can also run the workflow manually on `development`.

The workflow uses the repository’s self-hosted runner with `runs-on: self-hosted`; no custom runner label is required. Deployments use Docker on the runner machine and GitHub environment `dev`. Deployments run sequentially and skip commits superseded by newer application or deployment changes. A second check after the image build avoids deploying an older commit that was superseded during the build. This pipeline deploys directly after a matching push; the separate Test workflow runs independently.

### Runner setup

Register a Linux self-hosted runner directly under this personal repository’s **Settings → Actions → Runners**. The runner needs Bash, Docker with Compose 2.24.4+, and permission to access the local Docker socket at `/var/run/docker.sock`. No Docker context setup is needed. The pipeline creates the Docker network named by `N8N_NETWORK` (default `automation`) if it is missing and reuses it if it exists. If n8n already uses a different Docker network, set `N8N_NETWORK` to that network name to connect the applications to it. The runner also needs outbound access to GitHub, Docker Hub, npm, and PyPI for checkout and builds.

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
| `POSTGRES_USER` | Required: existing administrator with access to `postgres`, role/schema management privileges, and `CREATEDB` if the application database is missing |
| `SHARED_POSTGRES_HOST` | Required: server hostname reachable from app containers |
| `SHARED_POSTGRES_PORT` | `5432` |
| `POSTGRES_DB` | `mpf_dev`; migration creates this database if missing |
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

## n8n workflow deployment

The [dev caller](../.github/workflows/deploy-n8n-dev.yml) runs on `development` pushes affecting n8n source, deployment tooling, or its Actions workflows, and supports manual runs on `development`. It calls [deploy-n8n.yml](../.github/workflows/deploy-n8n.yml), following the reusable-job pattern in [Quickbook Invoice Status](https://github.com/AlohaOnline/Quickbook-Invoice-Status/blob/development/.github/workflows/deploy-n8n.yml). It uses the repository's `self-hosted` runner and the GitHub `dev` environment. The runner must reach n8n; n8n must reach the configured application endpoints. No custom runner label is required.

Configure these in **Settings → Environments → dev**:

| Setting | Kind | Value |
| --- | --- | --- |
| `N8N_API_ENDPOINT` | Variable | Dev n8n URL, e.g. `http://10.7.7.79:15678/api/v1` |
| `N8N_API_KEY` | Secret | n8n management API key with workflow read/update/activate/deactivate and execution-list permissions |
| `API_KEY` | Secret | Existing application API key, also used by Compose deployment |
| `N8N_WORKFLOW_IDS` | Variable | JSON mapping source filenames without `.json` to existing n8n IDs; see below |
| `N8N_ENDPOINT_URLS` | Variable | Optional JSON overrides for full endpoint URLs in Configuration; see below |

For the existing daily workflow:

```json
{"daily-pipeline":"ABAM8iVNQPVVewmO"}
```

Only mapped workflows are deployed. `daily-pipeline` is required. Add `download`, `purchase`, or `valuation` mappings only after importing those drafts manually. Each target's name must match its source; deployment never creates workflows or guesses IDs. Standalone recovery workflows must remain inactive.

If n8n cannot use the Compose service hostnames, set the full endpoint overrides. The current dev host ports use:

```json
{
  "downloadUrl": "http://10.7.7.79:38001/v1/crawl/jobs/sync",
  "crawlJobUrl": "http://10.7.7.79:38001/v1/crawl/jobs/",
  "purchaseUrl": "http://10.7.7.79:38003/v1/purchases/process",
  "rebuildUrl": "http://10.7.7.79:38004/v1/valuation/rebuild",
  "snapshotUrl": "http://10.7.7.79:38004/v1/valuation/snapshot"
}
```

`crawlJobUrl` must end in `/`; polling appends the job ID. With no overrides, source URLs use the shared Compose network. Other Configuration settings (provider, dates, account, polling, schedule) come from source, so commit intended changes before deployment. The deployer injects the real `API_KEY` into the Set node and sends workflow payloads to the CLI over stdin; source JSON keeps a placeholder.

The job validates source and configuration, installs `@n8n/cli@0.15.0`, previews targets, rechecks for newer relevant commits, then applies and verifies definitions. Unrelated application commits do not supersede n8n deployment. Deployment preserves the daily workflow's prior activation state: an inactive workflow stays inactive; an active workflow is paused and republished after verification. It waits up to two minutes for running/waiting executions to finish before uploading. It does not execute any business workflow or change Compose services. Compose deployment remains a separate pipeline; n8n deployment does not wait for an application rollout.

On apply failure, the coordinated workflow is requested inactive to prevent a partially updated scheduled run. Review the failure before resuming it. The seven-day Actions artifact contains the report and redacted before/desired/after definitions. For recovery, restore the affected `*.before.json` through n8n, replace `[REDACTED]` in Configuration with the correct application API key, verify settings, and restore the recorded activation state manually. These redacted files are recovery references and are not directly runnable. Real API keys are never intentionally included in artifacts.

Local validation (no server access):

```bash
node --test src/n8n/workflows.test.cjs deploy/n8n/deploy.test.cjs deploy/tools/*.test.cjs
```

With the same variables/secrets exported, `node deploy/n8n/deploy.cjs --dry-run` reads target workflows and writes a redacted preview without updating them.

## Production deployment

The production copies use `master` and GitHub environment `prod` on the same self-hosted Docker runner as dev:

- [deployment-prod-pipeline.yaml](../.github/workflows/deployment-prod-pipeline.yaml) builds and deploys the production Compose stack.
- [deploy-n8n-prod.yml](../.github/workflows/deploy-n8n-prod.yml) calls the shared n8n deployment job for production.

Both support manual runs on `master` and deploy matching pushes to that branch. Configure the `prod` environment before promoting a release to `master`; GitHub environment settings are separate from `dev` and are not copied automatically.

Production uses the same variable and secret names documented above. Its defaults isolate the stack on the shared Docker host:

| Setting | Production default |
| --- | --- |
| `COMPOSE_PROJECT_NAME` | `mpf-tracker-prod` |
| `MPF_INTERNAL_NETWORK` | `mpf-tracker-prod-internal` |
| `POSTGRES_DB` | `mpf_prod` |
| Service database roles | `mpf_prod_crawler`, `mpf_prod_portfolio`, `mpf_prod_purchase`, `mpf_prod_valuation` |
| API host ports | `8001`, `8002`, `8003`, `8004` (dev uses `38001`–`38004`) |
| `N8N_NETWORK` | `mpf-tracker-prod-automation` |
| `DB_MODE` | `shared` |

Set production `POSTGRES_USER`, `POSTGRES_PASSWORD`, `SHARED_POSTGRES_HOST`, and the four service-role passwords for the intended PostgreSQL server. Use a separate production `API_KEY`. If using bundled PostgreSQL, set an independent persistent `POSTGRES_DATA_DIR` such as `/srv/mpf-tracker-prod/postgres` and a host port that does not overlap any existing database.

Keep the production automation network separate from dev's `automation`: both stacks have the same Compose service names, so a shared automation network can make service-name routing ambiguous. Connect production n8n persistently to `mpf-tracker-prod-automation`, or use the production host's published ports for all endpoint URLs.

For production n8n, set `N8N_API_ENDPOINT`, secret `N8N_API_KEY`, and `N8N_WORKFLOW_IDS` for the intended production instance and its own imported workflow IDs. Do not reuse the dev workflow ID. `N8N_ENDPOINT_URLS` must explicitly contain all five full endpoint URLs in production; no source-host defaults are accepted. With host-port routing on the current Docker host:

```json
{
  "downloadUrl": "http://10.7.7.79:8001/v1/crawl/jobs/sync",
  "crawlJobUrl": "http://10.7.7.79:8001/v1/crawl/jobs/",
  "purchaseUrl": "http://10.7.7.79:8003/v1/purchases/process",
  "rebuildUrl": "http://10.7.7.79:8004/v1/valuation/rebuild",
  "snapshotUrl": "http://10.7.7.79:8004/v1/valuation/snapshot"
}
```

The n8n and container deployments remain separate pipelines. Verify the production APIs and manually check the imported inactive daily workflow before its first schedule activation. Later n8n deployments preserve that activation state and retain the same redacted recovery artifacts as dev.
