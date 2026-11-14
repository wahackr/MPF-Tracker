const { test } = require('node:test');
const assert = require('node:assert/strict');
const isCurrent = require('./deployment-current.cjs');
const context = { repo: { owner: 'example', repo: 'mpf' }, sha: 'release' };
function github(head, comparison) {
  return { rest: {
    git: { getRef: async () => ({ data: { object: { sha: head } } }) },
    repos: { compareCommitsWithBasehead: async () => ({ data: comparison }) },
  } };
}
test('deploys the current branch head', async () => {
  assert.equal(await isCurrent({ github: github('release'), context }), true);
});
test('allows newer documentation-only commits', async () => {
  assert.equal(await isCurrent({ github: github('newer', { status: 'ahead', files: [{ filename: 'README.md' }] }), context }), true);
});
for (const filename of ['src/purchase/src/main.ts', 'deploy/compose.yaml', '.github/workflows/deployment-dev-pipeline.yaml']) {
  test(`skips superseded changes to ${filename}`, async () => {
    assert.equal(await isCurrent({ github: github('newer', { status: 'ahead', files: [{ filename }] }), context }), false);
  });
}
test('detects files moved out of application source', async () => {
  assert.equal(await isCurrent({ github: github('newer', { status: 'ahead', files: [{ filename: 'archive/main.ts', previous_filename: 'src/purchase/src/main.ts' }] }), context }), false);
});
for (const comparison of [{ status: 'diverged', files: [] }, { status: 'ahead' }, { status: 'ahead', files: Array(300).fill({ filename: 'README.md' }) }]) {
  test(`rejects uncertain comparisons: ${JSON.stringify(comparison).slice(0, 60)}`, async () => {
    assert.equal(await isCurrent({ github: github('newer', comparison), context }), false);
  });
}

test('n8n permits newer unrelated application changes', async () => {
  assert.equal(await isCurrent({ github: github('newer', { status: 'ahead', files: [{ filename: 'src/purchase/src/main.ts' }] }), context, kind: 'n8n' }), true);
});
for (const filename of ['src/n8n/daily-pipeline.json', 'deploy/n8n/deploy.cjs', '.github/workflows/deploy-n8n.yml', '.github/workflows/deploy-n8n-dev.yml', 'deploy/tools/deployment-current.cjs']) {
  test(`n8n skips superseded ${filename}`, async () => {
    assert.equal(await isCurrent({ github: github('newer', { status: 'ahead', files: [{ filename }] }), context, kind: 'n8n' }), false);
  });
}
test('n8n detects a workflow moved out of source', async () => {
  assert.equal(await isCurrent({ github: github('newer', { status: 'ahead', files: [{ filename: 'archive/pipeline.json', previous_filename: 'src/n8n/daily-pipeline.json' }] }), context, kind: 'n8n' }), false);
});

test('production checks master rather than development', async () => {
  let requestedRef;
  const client = github('release');
  client.rest.git.getRef = async args => {
    requestedRef = args.ref;
    return { data: { object: { sha: 'release' } } };
  };
  assert.equal(await isCurrent({ github: client, context, branch: 'master' }), true);
  assert.equal(requestedRef, 'heads/master');
});
for (const [kind, filename] of [
  ['compose', '.github/workflows/deployment-prod-pipeline.yaml'],
  ['n8n', '.github/workflows/deploy-n8n-prod.yml'],
]) {
  test(`production skips superseded ${filename}`, async () => {
    assert.equal(await isCurrent({ github: github('newer', { status: 'ahead', files: [{ filename }] }), context, branch: 'master', kind }), false);
  });
}
