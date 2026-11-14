const paths = ['src/', 'deploy/', '.github/workflows/deployment-dev-pipeline.yaml'];

// Permit newer documentation-only commits, but never deploy superseded application code.
module.exports = async ({ github, context, branch = 'development', kind = 'compose' }) => {
  const selected = kind === 'n8n' ? ['src/n8n/', 'deploy/n8n/',
    'deploy/tools/deployment-current.cjs', 'deploy/tools/deployment-current.test.cjs',
    '.github/workflows/deploy-n8n.yml', '.github/workflows/deploy-n8n-dev.yml'] : paths;
  if (!['compose', 'n8n'].includes(kind)) throw new Error('Unknown deployment kind');
  const relevant = name => typeof name === 'string' && selected.some(path =>
    path.endsWith('/') ? name.startsWith(path) : name === path);
  const { data: ref } = await github.rest.git.getRef({
    ...context.repo, ref: `heads/${branch}`,
  });
  if (ref.object.sha === context.sha) return true;
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo, basehead: `${context.sha}...${ref.object.sha}`, per_page: 100, page: 1,
  });
  if (comparison.status !== 'ahead' || !Array.isArray(comparison.files) || comparison.files.length >= 300) return false;
  return comparison.files.every(file => !relevant(file.filename) && !relevant(file.previous_filename));
};
