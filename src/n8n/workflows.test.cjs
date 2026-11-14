const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const load = (file = 'daily-pipeline') => JSON.parse(fs.readFileSync(path.join(__dirname, `${file}.json`), 'utf8'));

// Exercise the exported expressions/Code nodes and graph, without touching live APIs.
function simulate(file = 'daily-pipeline', options = {}) {
  const workflow = load(file);
  const outputs = new Map();
  const runs = new Map();
  const requests = [];
  let input = {};
  let next = options.scheduled ? 'Daily 06:00 Hong Kong' : 'Manual run';
  let polls = 0;
  let waits = 0;
  const context = {
    $workflow: { id: 'workflow-fixture' },
    $execution: { id: 'execution-fixture' },
    $now: { setZone: (zone) => {
      assert.equal(zone, 'Asia/Hong_Kong');
      return { toISODate: () => '2026-11-14' };
    } },
    $: (name) => ({ first: () => ({ json: outputs.get(name) }) }),
    $input: { first: () => ({ json: input }) },
  };
  const expr = (value) => {
    if (typeof value !== 'string' || !value.startsWith('=')) return value;
    return vm.runInNewContext(`(${value.slice(3, -2)})`, { ...context, $json: input });
  };
  for (let step = 0; next && step < 1000; step++) {
    const node = workflow.nodes.find((entry) => entry.name === next);
    assert.ok(node, `Missing node ${next}`);
    const runIndex = runs.get(next) || 0;
    runs.set(next, runIndex + 1);
    let branch = 0;
    try {
      switch (node.type.replace('n8n-nodes-base.', '')) {
        case 'code':
          input = vm.runInNewContext(`(function () { ${node.parameters.jsCode}\n})()`, { ...context, $runIndex: runIndex })[0].json;
          break;
        case 'set':
          input = Object.fromEntries(node.parameters.assignments.assignments.map(({ name, value, type }) => {
            const resolved = expr(options.config && Object.hasOwn(options.config, name) ? options.config[name] : value);
            assert.equal(typeof resolved, type, `Configuration type for ${name}`);
            return [name, resolved];
          }));
          break;
        case 'httpRequest': {
          const url = expr(node.parameters.url);
          const body = node.parameters.sendBody ? expr(node.parameters.jsonBody) : undefined;
          const headers = Object.fromEntries((node.parameters.headerParameters?.parameters || []).map(({ name, value }) => [name, expr(value)]));
          requests.push({ name: next, url, body, headers });
          if (next === options.httpFailure) throw new Error('HTTP fixture error');
          if (next === 'Queue download') input = { job_id: 'job-fixture', status: 'queued' };
          if (next === 'Read crawl job') {
            const statuses = options.statuses || ['queued', 'running', 'succeeded'];
            input = { job_id: options.jobId || 'job-fixture', status: statuses[Math.min(polls++, statuses.length - 1)] };
          }
          if (next === 'Process purchases') input = { failed_events: 0, waiting_events: 0, ...options.purchase };
          if (next === 'Rebuild stale valuations') input = { rebuilt_count: 2, rebuilt_dates: ['2026-11-12', '2026-11-13'], invalidations_applied: 1 };
          if (next === 'Save valuation snapshot') input = { calculation_status: 'COMPLETE', unpriced_fund_count: 0, saved_accounts: 1, ...options.snapshot };
          break;
        }
        case 'if':
          branch = expr(node.parameters.conditions.conditions[0].leftValue) === true ? 0 : 1;
          break;
        case 'wait':
          assert.equal(node.parameters.amount, 30);
          assert.equal(node.parameters.unit, 'seconds');
          waits++;
          break;
        case 'manualTrigger': case 'scheduleTrigger': break;
        default: throw new Error(`Unhandled fixture node ${node.type}`);
      }
    } catch (error) {
      return { error, requests, outputs, polls, waits };
    }
    outputs.set(next, input);
    next = workflow.connections[next]?.main[branch]?.[0]?.node;
  }
  assert.ok(!next, 'Execution must terminate');
  return { requests, outputs, polls, waits };
}

for (const file of ['daily-pipeline', 'download', 'purchase', 'valuation']) {
  test(`${file}: inactive import structure, API key header and retry limits`, () => {
    const workflow = load(file);
    assert.equal(workflow.active, false);
    assert.equal(workflow.settings.timezone, 'Asia/Hong_Kong');
    const configuration = workflow.nodes.find((node) => node.name === 'Configuration');
    assert.equal(configuration.type, 'n8n-nodes-base.set');
    assert.equal(configuration.parameters.mode, 'manual');
    assert.equal(configuration.parameters.includeOtherFields, false);
    assert.equal(configuration.parameters.assignments.assignments.find((field) => field.name === 'apiKey').value, 'CHANGE_ME');
    const names = new Set(workflow.nodes.map((node) => node.name));
    assert.equal(names.size, workflow.nodes.length);
    assert.equal(new Set(workflow.nodes.map((node) => node.id)).size, workflow.nodes.length);
    for (const [source, { main }] of Object.entries(workflow.connections)) {
      assert.ok(names.has(source));
      for (const output of main) for (const edge of output) assert.ok(names.has(edge.node));
    }
    assert.equal(workflow.nodes.find((node) => node.type.endsWith('.scheduleTrigger')).parameters.rule.interval[0].expression, '0 0 6 * * *');
    for (const node of workflow.nodes.filter((node) => node.type.endsWith('.httpRequest'))) {
      assert.equal(node.parameters.authentication, 'none');
      assert.equal(node.parameters.genericAuthType, undefined);
      assert.equal(node.credentials, undefined);
      assert.equal(node.continueOnFail, undefined);
      assert.equal(node.retryOnFail, true);
      assert.equal(node.maxTries, 3);
      assert.equal(node.waitBetweenTries, 5000);
      assert.ok(node.parameters.options.timeout <= 300000);
    }
    const result = simulate(file, { config: { apiKey: 'fixture-api-key' } });
    assert.equal(result.error, undefined);
    for (const request of result.requests) {
      assert.equal(request.headers['X-API-Key'], 'fixture-api-key');
      assert.equal(request.headers.Authorization, undefined);
    }
  });
}

test('daily: crawl completion precedes purchases, rebuild and snapshot', () => {
  const result = simulate();
  assert.equal(result.error, undefined);
  assert.equal(result.polls, 3);
  assert.equal(result.waits, 2);
  assert.deepEqual(result.requests.map((request) => request.name), ['Queue download', 'Read crawl job', 'Read crawl job', 'Read crawl job', 'Process purchases', 'Rebuild stale valuations', 'Save valuation snapshot']);
  const queue = result.requests[0];
  assert.equal(JSON.stringify(queue.body), JSON.stringify({ provider: 'all', rolling_days: 7 }));
  assert.equal(queue.headers['Idempotency-Key'], 'mpf-n8n-workflow-fixture-execution-fixture');
  assert.equal(result.requests[1].url, 'http://mpf-crawler-api:8000/v1/crawl/jobs/job-fixture');
  assert.equal(result.requests.at(-1).body.as_of_date, '2026-11-14');
  // The header expression always refers to the one captured configuration value.
  const queueNode = load().nodes.find((node) => node.name === 'Queue download');
  assert.equal(queueNode.parameters.headerParameters.parameters[0].value, "={{ $('Configuration').first().json.idempotencyKey }}");
});

test('configured full endpoint URLs control every HTTP request', () => {
  const config = {
    downloadUrl: 'https://crawler.example/custom/sync',
    crawlJobUrl: 'https://crawler.example/custom/jobs/',
    purchaseUrl: 'https://purchase.example/custom/process',
    rebuildUrl: 'https://valuation.example/custom/rebuild',
    snapshotUrl: 'https://valuation.example/custom/snapshot',
  };
  const expected = {
    'Queue download': config.downloadUrl,
    'Read crawl job': `${config.crawlJobUrl}job-fixture`,
    'Process purchases': config.purchaseUrl,
    'Rebuild stale valuations': config.rebuildUrl,
    'Save valuation snapshot': config.snapshotUrl,
  };
  for (const file of ['daily-pipeline', 'download', 'purchase', 'valuation']) {
    const result = simulate(file, { config });
    assert.equal(result.error, undefined);
    for (const request of result.requests) assert.equal(request.url, expected[request.name]);
  }
});

for (const status of ['partial', 'failed', 'unknown']) {
  test(`crawler ${status} blocks purchases and valuations`, () => {
    const result = simulate('daily-pipeline', { statuses: [status] });
    assert.match(result.error.message, new RegExp(status));
    assert.equal(result.requests.length, 2);
  });
}

test('poll exhaustion and mismatched IDs block downstream work', () => {
  const timed = simulate('daily-pipeline', { statuses: ['running'], config: { maxPolls: 3 } });
  assert.match(timed.error.message, /polling limit/);
  assert.equal(timed.polls, 3);
  assert.equal(timed.waits, 2);
  const mismatch = simulate('daily-pipeline', { jobId: 'wrong-id' });
  assert.match(mismatch.error.message, /mismatched/);
});

test('final allowed poll can succeed', () => {
  const result = simulate('download', { config: { maxPolls: 3 } });
  assert.equal(result.error, undefined);
  assert.equal(result.polls, 3);
});

test('failed purchase response blocks valuation; waiting details survive', () => {
  const failed = simulate('daily-pipeline', { purchase: { failed_events: 1 } });
  assert.match(failed.error.message, /failed events/);
  assert.equal(failed.requests.at(-1).name, 'Process purchases');
  const details = [{ event_id: 'event-fixture', reason: 'missing price' }];
  const waiting = simulate('daily-pipeline', { purchase: { waiting_events: 1, waiting_details: details } });
  assert.equal(waiting.error, undefined);
  assert.equal(waiting.outputs.get('Check purchases').needsReview, true);
  assert.equal(waiting.outputs.get('Check purchases').waiting_details, details);
  const malformed = simulate('daily-pipeline', { purchase: { failed_events: undefined } });
  assert.match(malformed.error.message, /Unexpected purchase/);
});

for (const name of ['Queue download', 'Read crawl job', 'Process purchases', 'Rebuild stale valuations']) {
  test(`HTTP failure at ${name} stops downstream requests`, () => {
    const result = simulate('daily-pipeline', { httpFailure: name });
    assert.match(result.error.message, /HTTP fixture error/);
    assert.equal(result.requests.at(-1).name, name);
  });
}

for (const snapshot of [{ calculation_status: 'PARTIAL', unpriced_fund_count: 1 }, { calculation_status: 'STALE' }, { calculation_status: 'COMPLETE', unpriced_fund_count: 1 }]) {
  test(`snapshot quality failure is visible: ${JSON.stringify(snapshot)}`, () => {
    const result = simulate('valuation', { snapshot });
    assert.match(result.error.message, /Snapshot saved but needs review/);
    assert.equal(result.requests.at(-1).name, 'Save valuation snapshot');
  });
}

test('historical date/account override and scheduled entry use the same chain', () => {
  const result = simulate('daily-pipeline', { scheduled: true, config: { asOfDate: '2026-10-31', accountId: 'account-fixture' } });
  assert.equal(result.error, undefined);
  for (const request of result.requests.filter((entry) => ['Process purchases', 'Save valuation snapshot'].includes(entry.name))) {
    assert.equal(request.body.as_of_date, '2026-10-31');
    assert.equal(request.body.account_id, 'account-fixture');
  }
  assert.equal(result.requests.find((entry) => entry.name === 'Rebuild stale valuations').body.account_id, 'account-fixture');
});
