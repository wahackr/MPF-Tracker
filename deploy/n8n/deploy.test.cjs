const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadWorkflows, configFromEnv, deploy } = require('./deploy.cjs');
const workflows = loadWorkflows();
const env = { N8N_URL: 'http://n8n.example/api/v1', N8N_API_KEY: 'n8n-management-secret',
  API_KEY: 'application-secret', N8N_WORKFLOW_IDS: '{"daily-pipeline":"target"}',
  N8N_ENDPOINT_URLS: '{"downloadUrl":"http://10.7.7.79:38001/v1/crawl/jobs/sync"}' };
function fixture(t, { active = false, failUpdate = false, mismatch = false, pending = false, concurrent = false } = {}) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpf-deploy-test-'));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  let saved = { ...structuredClone(workflows['daily-pipeline']), id: 'target', versionId: 'one', active };
  const fields = saved.nodes.find(n => n.name === 'Configuration').parameters.assignments.assignments;
  fields.find(f => f.name === 'apiKey').value = 'old-secret';
  const calls = [];
  let gets = 0;
  const cli = (topic, command, args, payload) => {
    calls.push([topic, command, args]);
    if (topic === 'execution') return pending ? [{ workflowId: 'target' }] : [];
    if (command === 'get') {
      gets++;
      const value = structuredClone(saved);
      if (concurrent && gets === 2) value.versionId = 'edited';
      return value;
    }
    if (command === 'deactivate') { saved.active = false; return saved; }
    if (command === 'update') {
      if (failUpdate) throw new Error('Upload failed');
      saved = { ...structuredClone(payload), id: 'target', versionId: 'two', active: false };
      if (mismatch) saved.connections = {};
      return saved;
    }
    if (command === 'activate') {
      saved.active = true;
      saved.activeVersion = { nodes: saved.nodes, connections: saved.connections };
      return saved;
    }
    throw new Error(`Unexpected call ${topic} ${command}`);
  };
  return { outputDir, cli, calls, saved: () => saved, options: { env, workflows, cli, outputDir, log: () => {} } };
}
for (const patch of [{ API_KEY: '' }, { API_KEY: 'CHANGE_ME' }, { N8N_API_KEY: '' },
  { N8N_WORKFLOW_IDS: '{"daily-pipeline":"same","download":"same"}' },
  { N8N_WORKFLOW_IDS: '{"download":"only"}' }, { N8N_WORKFLOW_IDS: '{"unknown":"id","daily-pipeline":"target"}' },
  { N8N_ENDPOINT_URLS: '{"downloadUrl":"http://10.7.7.79/:38001/v1/crawl/jobs/sync"}' },
  { N8N_ENDPOINT_URLS: '{"crawlJobUrl":"http://crawler/jobs"}' },
  { N8N_URL: 'https://user:password@n8n.example' }]) {
  test(`rejects invalid configuration ${Object.keys(patch)}`, () => {
    assert.throws(() => configFromEnv({ ...env, ...patch }, workflows));
  });
}
test('preview reads remote definitions but never mutates them', async t => {
  const f = fixture(t);
  const report = await deploy({ ...f.options, dryRun: true });
  assert.equal(report.mode, 'preview');
  assert.ok(f.calls.every(([, command]) => command === 'get'));
});
test('injects secrets and full URLs, preserves inactive state and redacts recovery files', async t => {
  const f = fixture(t);
  assert.equal((await deploy(f.options)).status, 'deployed');
  const saved = f.saved();
  assert.equal(saved.active, false);
  const fields = Object.fromEntries(saved.nodes.find(n => n.name === 'Configuration').parameters.assignments.assignments.map(f => [f.name, f.value]));
  assert.equal(fields.apiKey, env.API_KEY);
  assert.equal(fields.downloadUrl, 'http://10.7.7.79:38001/v1/crawl/jobs/sync');
  for (const filename of fs.readdirSync(f.outputDir)) {
    const content = fs.readFileSync(path.join(f.outputDir, filename), 'utf8');
    for (const secret of [env.API_KEY, env.N8N_API_KEY, 'old-secret']) assert.equal(content.includes(secret), false);
  }
  assert.ok(f.calls.some(([, command, args]) => command === 'update' && args.includes('--stdin')));
});
test('pauses, updates, and republishes an already active daily workflow', async t => {
  const f = fixture(t, { active: true });
  await deploy(f.options);
  assert.equal(f.saved().active, true);
  const commands = f.calls.map(([, command]) => command);
  assert.ok(commands.indexOf('deactivate') < commands.indexOf('update'));
  assert.ok(commands.indexOf('update') < commands.indexOf('activate'));
});
test('wrong target name stops before writes', async t => {
  const f = fixture(t);
  f.saved().name = 'Unrelated workflow';
  await assert.rejects(deploy(f.options), /ID\/name mismatch/);
  assert.ok(f.calls.every(([, command]) => command === 'get'));
});
test('concurrent edits stop before writes', async t => {
  const f = fixture(t, { concurrent: true });
  await assert.rejects(deploy(f.options), /changed during preflight/);
  assert.ok(f.calls.every(([, command]) => command === 'get'));
});
for (const failure of [{ failUpdate: true }, { mismatch: true }, { pending: true }]) {
  test(`failed deployment leaves daily workflow paused: ${JSON.stringify(failure)}`, async t => {
    const f = fixture(t, { active: true, ...failure });
    await assert.rejects(deploy({ ...f.options, drainTimeout: 0 }));
    assert.equal(f.saved().active, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.outputDir, 'report.json'))).status, 'failed');
    if (failure.pending) assert.equal(f.calls.some(([, command]) => command === 'update'), false);
  });
}
test('an active standalone draft is rejected before writes', async t => {
  const f = fixture(t);
  const cli = (topic, command, args, payload) => args[0] === 'download-target'
    ? { ...workflows.download, id: 'download-target', active: true }
    : f.cli(topic, command, args, payload);
  await assert.rejects(deploy({ ...f.options, cli, env: { ...env, N8N_WORKFLOW_IDS: '{"daily-pipeline":"target","download":"download-target"}' } }), /Standalone/);
  assert.ok(f.calls.every(([, command]) => command === 'get'));
});

test('production rejects missing endpoint overrides instead of falling back to source hosts', () => {
  assert.throws(() => configFromEnv({ ...env, N8N_ENV: 'prod' }), /Production requires all five/);
});
test('production accepts explicit full endpoint configuration', () => {
  const values = {
    downloadUrl: 'http://production:8001/v1/crawl/jobs/sync',
    crawlJobUrl: 'http://production:8001/v1/crawl/jobs/',
    purchaseUrl: 'http://production:8003/v1/purchases/process',
    rebuildUrl: 'http://production:8004/v1/valuation/rebuild',
    snapshotUrl: 'http://production:8004/v1/valuation/snapshot',
  };
  assert.deepEqual(configFromEnv({ ...env, N8N_ENV: 'prod', N8N_ENDPOINT_URLS: JSON.stringify(values) }).values, values);
});
