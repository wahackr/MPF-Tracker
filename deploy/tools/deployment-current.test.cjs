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
