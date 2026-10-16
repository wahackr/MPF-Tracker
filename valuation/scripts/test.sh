#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."

npm run build

# Always remove the container created by this run, including after a failed test.
container=""
trap 'if [[ -n "$container" ]]; then docker rm --force "$container" >/dev/null; fi' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -z "${TEST_DATABASE_URL:-}" ]]; then
  # Docker selects a free local port so this database can coexist with the development stack.
  container=$(docker run --detach --rm \
    --publish 127.0.0.1::5432 \
    --env POSTGRES_DB=mpf \
    --env POSTGRES_USER=mpf_migrator \
    --env POSTGRES_PASSWORD=test \
    --tmpfs /var/lib/postgresql/data \
    postgres:17)

  echo "Waiting for the test database..."
  ready=false
  for ((attempt = 0; attempt < 60; attempt++)); do
    if docker exec "$container" pg_isready -h 127.0.0.1 -U mpf_migrator -d mpf >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 0.5
  done
  if [[ "$ready" != true ]]; then
    echo "Test database did not become ready" >&2
    exit 1
  fi

  # Create service roles, then apply the project's SQL migrations using the container's psql.
  docker exec -i "$container" psql -U mpf_migrator -d mpf -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE mpf_crawler LOGIN PASSWORD 'test';
CREATE ROLE mpf_portfolio LOGIN PASSWORD 'test';
CREATE ROLE mpf_purchase LOGIN PASSWORD 'test';
CREATE ROLE mpf_valuation LOGIN PASSWORD 'test';
SQL

  for migration in ../migrations/sql/*.sql; do
    sed \
      -e 's/{{POSTGRES_DB}}/"mpf"/g' \
      -e 's/{{CRAWLER_DB_USER}}/"mpf_crawler"/g' \
      -e 's/{{PORTFOLIO_DB_USER}}/"mpf_portfolio"/g' \
      -e 's/{{PURCHASE_DB_USER}}/"mpf_purchase"/g' \
      -e 's/{{VALUATION_DB_USER}}/"mpf_valuation"/g' \
      "$migration" | docker exec -i "$container" psql -U mpf_migrator -d mpf -v ON_ERROR_STOP=1 --quiet
  done

  address=$(docker port "$container" 5432/tcp)
  export TEST_DATABASE_URL="postgresql://mpf_migrator:test@127.0.0.1:${address##*:}/mpf"
  export VALUATION_DB_USER=mpf_valuation VALUATION_DB_PASSWORD=test
fi

# A supplied TEST_DATABASE_URL uses the already provisioned database, without creating a container.
node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --coverage "$@"
