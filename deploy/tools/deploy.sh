#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/../.."

stage=${1:-}
case "$stage" in validate|build|deploy) ;; *) echo 'Usage: deploy.sh validate|build|deploy' >&2; exit 1 ;; esac

# GitHub forbids empty variables; environment placeholders must be replaced before deployment.
for key in COMPOSE_PROJECT_NAME MPF_INTERNAL_NETWORK DB_MODE API_BIND_ADDRESS \
  CRAWLER_API_HOST_PORT PORTFOLIO_API_HOST_PORT PURCHASE_API_HOST_PORT VALUATION_API_HOST_PORT \
  POSTGRES_DB POSTGRES_USER POSTGRES_BIND_ADDRESS POSTGRES_HOST_PORT POSTGRES_DATA_DIR \
  SHARED_POSTGRES_HOST SHARED_POSTGRES_PORT DEPLOY_DOCKER_CONTEXT CRAWLER_DB_USER PORTFOLIO_DB_USER PURCHASE_DB_USER \
  VALUATION_DB_USER WORKER_POLL_INTERVAL_SECONDS WORKER_LEASE_SECONDS WORKER_HEARTBEAT_SECONDS N8N_NETWORK; do
  if [[ "${!key:-}" == CHANGE_ME ]]; then
    echo "Replace the GitHub deployment placeholder: $key" >&2
    exit 1
  fi
done

required=(COMPOSE_PROJECT_NAME MPF_INTERNAL_NETWORK DB_MODE API_KEY POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD
  CRAWLER_DB_USER CRAWLER_DB_PASSWORD PORTFOLIO_DB_USER PORTFOLIO_DB_PASSWORD
  PURCHASE_DB_USER PURCHASE_DB_PASSWORD VALUATION_DB_USER VALUATION_DB_PASSWORD N8N_NETWORK)
for key in "${required[@]}"; do
  if [[ -z "${!key:-}" || "${!key}" == REPLACE_ME* ]]; then
    echo "Missing GitHub deployment configuration: $key" >&2
    exit 1
  fi
done
if ! [[ "$COMPOSE_PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo 'Invalid COMPOSE_PROJECT_NAME' >&2
  exit 1
fi

# Use an explicit deployment context when configured; otherwise use the runner's local Docker socket.
# Never use an untracked .env or an inherited profile on a persistent runner.
export COMPOSE_PROFILES=''
unset DOCKER_CONTEXT
docker=(docker)
if [[ -n "${DEPLOY_DOCKER_CONTEXT:-}" ]]; then
  docker+=(--context "$DEPLOY_DOCKER_CONTEXT")
  unset DOCKER_HOST DOCKER_TLS_VERIFY DOCKER_CERT_PATH
else
  unset DOCKER_TLS_VERIFY DOCKER_CERT_PATH
  export DOCKER_HOST=unix:///var/run/docker.sock
fi
compose=("${docker[@]}" compose --env-file /dev/null -f deploy/compose.yaml)
case "$DB_MODE" in
  shared)
    if [[ -z "${SHARED_POSTGRES_HOST:-}" ]]; then
      echo 'SHARED_POSTGRES_HOST is required for shared PostgreSQL' >&2
      exit 1
    fi
    compose+=(-f deploy/compose.shared-db.yaml)
    ;;
  bundled)
    if [[ "${POSTGRES_DATA_DIR:-}" != /* || "$POSTGRES_DATA_DIR" == / ]]; then
      echo 'Bundled PostgreSQL requires an absolute POSTGRES_DATA_DIR outside the runner checkout' >&2
      exit 1
    fi
    case "$POSTGRES_DATA_DIR/" in "$PWD/"*) echo 'POSTGRES_DATA_DIR must be outside the runner checkout' >&2; exit 1 ;; esac
    ;;
  *) echo 'DB_MODE must be shared or bundled' >&2; exit 1 ;;
esac
for key in CRAWLER_API_HOST_PORT PORTFOLIO_API_HOST_PORT PURCHASE_API_HOST_PORT VALUATION_API_HOST_PORT POSTGRES_HOST_PORT SHARED_POSTGRES_PORT; do
  value=${!key:-5432}
  if ! [[ "$value" =~ ^[0-9]{1,5}$ ]] || ! (( 10#$value >= 1 && 10#$value <= 65535 )); then
    echo "Invalid port: $key" >&2
    exit 1
  fi
done

ensure_network() {
  if ! "${docker[@]}" network inspect "$N8N_NETWORK" >/dev/null 2>&1; then
    echo "Creating Docker network: $N8N_NETWORK"
    # Another deployment may create this shared network between inspect and create.
    if ! "${docker[@]}" network create "$N8N_NETWORK" >/dev/null; then
      "${docker[@]}" network inspect "$N8N_NETWORK" >/dev/null
    fi
  fi
}

case "$stage" in
  validate)
    "${docker[@]}" info >/dev/null
    "${docker[@]}" compose version
    "${compose[@]}" config --quiet
    ensure_network
    ;;
  build)
    "${compose[@]}" build --pull
    ;;
  deploy)
    ensure_network
    # Compose waits for database readiness, successful migration, then app health checks.
    if ! "${compose[@]}" up -d --no-build --wait --wait-timeout 180; then
      # Detached up hides service output; dump logs so failures like migration errors show the cause.
      "${compose[@]}" logs --no-color --tail 200 || true
      "${compose[@]}" ps -a
      echo 'Deployment failed or application readiness timed out.' >&2
      exit 1
    fi
    "${compose[@]}" ps -a
    ;;
esac
