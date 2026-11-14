#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual: equal } = require('node:util');
const ROOT = path.resolve(__dirname, '../..');
const clone = value => structuredClone(value);
const endpointNames = ['downloadUrl', 'crawlJobUrl', 'purchaseUrl', 'rebuildUrl', 'snapshotUrl'];
function loadWorkflows() {
  return Object.fromEntries(['daily-pipeline', 'download', 'purchase', 'valuation'].map(key =>
    [key, JSON.parse(fs.readFileSync(path.join(ROOT, 'src/n8n', `${key}.json`), 'utf8'))]));
}
function httpUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      /\/:\d/.test(url.pathname)) throw new Error(`${name} must be an HTTP(S) URL without credentials, query, fragment, or misplaced port`);
  return url.href;
}
function configFromEnv(env, workflows = loadWorkflows()) {
  for (const key of ['N8N_URL', 'N8N_API_KEY', 'N8N_WORKFLOW_IDS', 'API_KEY']) {
    if (!env[key]?.trim() || env[key].includes('CHANGE_ME')) throw new Error(`Missing or placeholder ${key}`);
  }
  httpUrl(env.N8N_URL, 'N8N_URL');
  let ids, values;
  try { ids = JSON.parse(env.N8N_WORKFLOW_IDS); values = JSON.parse(env.N8N_ENDPOINT_URLS || '{}'); }
  catch { throw new Error('N8N_WORKFLOW_IDS and N8N_ENDPOINT_URLS must be JSON objects'); }
  for (const [name, object] of [['N8N_WORKFLOW_IDS', ids], ['N8N_ENDPOINT_URLS', values]]) {
    if (!object || Array.isArray(object) || typeof object !== 'object') throw new Error(`${name} must be a JSON object`);
  }
  if (!ids['daily-pipeline']) throw new Error('N8N_WORKFLOW_IDS must include daily-pipeline');
  if (new Set(Object.values(ids)).size !== Object.keys(ids).length) throw new Error('Duplicate target workflow IDs');
  for (const [key, id] of Object.entries(ids)) {
    if (!workflows[key] || typeof id !== 'string' || !/^[\w-]+$/.test(id) || id === 'REPLACE_ON_IMPORT') throw new Error('Unknown workflow key or invalid target ID');
  }
  for (const [name, value] of Object.entries(values)) {
    if (!endpointNames.includes(name) || typeof value !== 'string') throw new Error('Unknown or invalid endpoint setting');
    httpUrl(value, name);
    if (name === 'crawlJobUrl' && !value.endsWith('/')) throw new Error('crawlJobUrl must end with /');
  }
  return { ids, values, apiKey: env.API_KEY };
}
function render(source, live, config, key) {
  if (live.id !== config.ids[key] || live.name !== source.name) throw new Error(`Target ID/name mismatch: ${key}`);
  const payload = clone(Object.fromEntries(['name', 'nodes', 'connections', 'settings'].map(k => [k, source[k]])));
  const node = payload.nodes.find(n => n.name === 'Configuration');
  for (const field of node.parameters.assignments.assignments) {
    if (field.name === 'apiKey') field.value = config.apiKey;
    if (Object.hasOwn(config.values, field.name)) field.value = config.values[field.name];
  }
  return payload;
}
// Recovery definitions are deliberately redacted; reinject API_KEY when restoring.
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(apiKey|api_key|authorization|x-api-key)$/i.test(key) ? '[REDACTED]' : redact(item)]));
  if (/^(apiKey|authorization|x-api-key)$/i.test(value.name || '') && 'value' in result) result.value = '[REDACTED]';
  return result;
}
function verify(saved, payload, active) {
  for (const key of ['name', 'nodes', 'connections']) if (!equal(saved[key], payload[key])) throw new Error(`Saved definition mismatch: ${key}`);
  for (const [key, value] of Object.entries(payload.settings)) if (!equal(saved.settings?.[key], value)) throw new Error(`Saved setting mismatch: ${key}`);
  if (saved.active !== active) throw new Error('Activation state mismatch');
  if (active && (!equal(saved.activeVersion?.nodes, payload.nodes) || !equal(saved.activeVersion?.connections, payload.connections))) throw new Error('Published definition mismatch');
}
function cliRunner(env) {
  return (topic, command, args = [], payload) => {
    try {
      const out = execFileSync('n8n-cli', [topic, command, ...args, '--json'], {
        env, input: payload ? JSON.stringify(payload) : undefined, encoding: 'utf8',
        timeout: 60000, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
      });
      return out.trim() ? JSON.parse(out) : null;
    } catch { throw new Error(`n8n-cli ${topic} ${command} failed; check server access and CLI compatibility`); }
  };
}
async function deploy({ env = process.env, workflows = loadWorkflows(), cli = cliRunner(env), dryRun = false,
  outputDir = env.N8N_DEPLOY_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'mpf-n8n-')),
  log = console.log, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), drainTimeout = 120000 } = {}) {
  const config = configFromEnv(env, workflows);
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const write = (file, value) => fs.writeFileSync(path.join(outputDir, file), JSON.stringify(redact(value), null, 2) + '\n', { mode: 0o600 });
  const entries = Object.keys(config.ids).map(key => {
    const before = cli('workflow', 'get', [config.ids[key]]);
    if (key !== 'daily-pipeline' && before.active) throw new Error('Standalone recovery workflows must be inactive before deployment');
    const payload = render(workflows[key], before, config, key);
    write(`${key}.before.json`, before);
    write(`${key}.desired.json`, payload);
    log(`${key}: ${before.id}; preserve active=${before.active}`);
    return { key, before, payload };
  });
  const report = { commit: env.GITHUB_SHA || null, mode: dryRun ? 'preview' : 'apply', status: 'planned',
    workflows: entries.map(e => ({ key: e.key, id: e.before.id, active: e.before.active })) };
  write('report.json', report);
  if (dryRun) return report;
  let touched = false;
  try {
    for (const e of entries) {
      const current = cli('workflow', 'get', [e.before.id]);
      if (current.versionId !== e.before.versionId || current.active !== e.before.active) throw new Error('Workflow changed during preflight');
    }
    touched = true;
    for (const e of entries) if (e.before.active) cli('workflow', 'deactivate', [e.before.id]);
    const deadline = Date.now() + drainTimeout;
    for (;;) {
      const pending = entries.flatMap(entry => ['running', 'waiting'].flatMap(status => {
        const response = cli('execution', 'list', ['--workflow', entry.before.id, '--status', status, '--limit', '1']);
        const list = Array.isArray(response) ? response : response?.data;
        if (!Array.isArray(list)) throw new Error('Unexpected execution list response');
        return list.filter(e => entries.some(w => w.before.id === e.workflowId));
      }));
      if (!pending.length) break;
      if (Date.now() >= deadline) throw new Error('Timed out waiting for running/waiting executions');
      log(`Waiting for ${pending.length} execution(s)`);
      await sleep(5000);
    }
    for (const e of entries) {
      cli('workflow', 'update', [e.before.id, '--stdin'], e.payload);
      verify(cli('workflow', 'get', [e.before.id]), e.payload, false);
    }
    for (const e of entries) {
      if (e.before.active) cli('workflow', 'activate', [e.before.id]);
      const saved = cli('workflow', 'get', [e.before.id]);
      verify(saved, e.payload, e.before.active);
      write(`${e.key}.after.json`, saved);
    }
    report.status = 'deployed';
  } catch (error) {
    report.status = 'failed';
    // Pause the coordinated schedule if only part of a deployment was saved.
    if (touched) for (const e of entries) if (e.key === 'daily-pipeline') {
      try { cli('workflow', 'deactivate', [e.before.id]); } catch { report.pauseFailed = true; }
    }
    write('report.json', report);
    throw error;
  }
  write('report.json', report);
  return report;
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--dry-run')) { console.error('Only --dry-run is supported'); process.exitCode = 1; }
  else deploy({ dryRun: args.includes('--dry-run') }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { loadWorkflows, configFromEnv, render, redact, verify, cliRunner, deploy };
