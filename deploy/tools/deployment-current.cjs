const paths = ['src/', 'deploy/', '.github/workflows/deployment-dev-pipeline.yaml'];
const relevant = name => typeof name === 'string' && paths.some(path =>
  path.endsWith('/') ? name.startsWith(path) : name === path);

// Permit newer documentation-only commits, but never deploy superseded application code.
module.exports = async ({ github, context }) => {
  const { data: ref } = await github.rest.git.getRef({
    ...context.repo, ref: 'heads/development',
  });
  if (ref.object.sha === context.sha) return true;
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo, basehead: `${context.sha}...${ref.object.sha}`, per_page: 100, page: 1,
  });
  if (comparison.status !== 'ahead' || !Array.isArray(comparison.files) || comparison.files.length >= 300) return false;
  return comparison.files.every(file => !relevant(file.filename) && !relevant(file.previous_filename));
};
