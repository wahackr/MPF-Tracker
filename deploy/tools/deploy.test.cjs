const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const { spawnSync } = require('node:child_process');
const root = resolve(__dirname, '../..');
const defaults = Object.fromEntries(readFileSync(join(root, 'deploy/.env.example'), 'utf8').split('\n')
  .filter(line => line && !line.startsWith('#')).map(line => line.split(/=(.*)/s).slice(0, 2)));
for (const key of Object.keys(defaults)) {
  if (key.endsWith('PASSWORD') || key === 'API_KEY') defaults[key] = 'test-value';
}
function run(stage, changes = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mpf-deploy-test-'));
  const log = join(directory, 'calls');
  writeFileSync(join(directory, 'docker'), `#!/usr/bin/env bash
if [[ "\${DOCKER_HOST:-}" != unix:///var/run/docker.sock || -n "\${DOCKER_CONTEXT:-}" ]]; then exit 90; fi
printf '%s\\n' "$* profiles=$COMPOSE_PROFILES" >> "$TEST_DOCKER_LOG"
if [[ "$1 $2" == "network inspect" && "\${TEST_NETWORK_MISSING:-}" == 1 && ! -f "$TEST_DOCKER_LOG.network" ]]; then exit 1; fi
if [[ "$1 $2" == "network create" ]]; then
  if [[ "\${TEST_NETWORK_CREATE_FAIL:-}" == 1 ]]; then exit 1; fi
  touch "$TEST_DOCKER_LOG.network"
fi
if [[ "\${TEST_FAIL_UP:-}" == 1 && "$*" == *" up "* ]]; then exit 1; fi
`, { mode: 0o755 });
  try {
    const result = spawnSync('bash', ['deploy/tools/deploy.sh', stage], {
      cwd: root, encoding: 'utf8', env: {
        ...process.env, ...defaults, DOCKER_CONTEXT: 'missing-context', DOCKER_HOST: 'tcp://remote.example:2376', COMPOSE_PROJECT_NAME: 'mpf-test',
        MPF_INTERNAL_NETWORK: 'mpf-test-internal', DB_MODE: 'shared',
        SHARED_POSTGRES_HOST: 'shared.example', TEST_DOCKER_LOG: log,
        COMPOSE_PROFILES: 'bundled-db', ...changes, PATH: `${directory}:${process.env.PATH}`,
      },
    });
    let calls = '';
    try { calls = readFileSync(log, 'utf8'); } catch { /* Validation may fail before Docker runs. */ }
    return { ...result, calls };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
test('validates shared mode using local Docker despite inherited remote settings', () => {
  const result = run('validate');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /compose --env-file \/dev\/null -f deploy\/compose.yaml -f deploy\/compose.shared-db.yaml config --quiet profiles=\n/);
  assert.match(result.calls, /network inspect automation/);
  assert.doesNotMatch(result.calls, /--context|context inspect/);
});
test('reuses an existing network without creating it', () => {
  const result = run('validate');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.calls, /network create/);
});
test('creates a missing configured network during validation', () => {
  const result = run('validate', { TEST_NETWORK_MISSING: '1', N8N_NETWORK: 'mpf-automation' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /network create mpf-automation/);
});
test('deployment also creates a missing network before starting containers', () => {
  const result = run('deploy', { TEST_NETWORK_MISSING: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.indexOf('network create automation') < result.calls.indexOf(' up -d'));
});
test('fails before deployment when the network cannot be created', () => {
  const result = run('deploy', { TEST_NETWORK_MISSING: '1', TEST_NETWORK_CREATE_FAIL: '1' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.calls, / up -d/);
});
test('builds bundled mode without the shared override', () => {
  const result = run('build', { DB_MODE: 'bundled', POSTGRES_DATA_DIR: '/srv/mpf-test/postgres' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /build --pull/);
  assert.doesNotMatch(result.calls, /compose.shared-db.yaml/);
});
test('deployment waits for health and migration without rebuilding', () => {
  const result = run('deploy');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /up -d --no-build --wait --wait-timeout 180/);
  assert.match(result.calls, /ps -a/);
});
test('failed readiness fails the deployment', () => {
  const result = run('deploy', { TEST_FAIL_UP: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Deployment failed/);
});
for (const [name, changes] of [
  ['environment placeholder', { N8N_NETWORK: 'CHANGE_ME' }],
  ['missing API secret', { API_KEY: '' }],
  ['placeholder password', { POSTGRES_PASSWORD: 'REPLACE_ME' }],
  ['missing shared host', { SHARED_POSTGRES_HOST: '' }],
  ['unknown mode', { DB_MODE: 'other' }],
  ['bad project', { COMPOSE_PROJECT_NAME: 'Bad project' }],
  ['bad port', { PURCHASE_API_HOST_PORT: '0' }],
  ['relative storage', { DB_MODE: 'bundled', POSTGRES_DATA_DIR: './data' }],
  ['checkout storage', { DB_MODE: 'bundled', POSTGRES_DATA_DIR: join(root, 'data/postgres') }],
]) {
  test(`rejects ${name} before calling Docker`, () => {
    const result = run('validate', changes);
    assert.equal(result.status, 1);
    assert.equal(result.calls, '');
  });
}
