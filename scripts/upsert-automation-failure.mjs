#!/usr/bin/env node

const [title = '[maintenance] Automated checks require attention', category = 'scheduled maintenance'] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const workflow = process.env.GITHUB_WORKFLOW || 'automation';

if (!token || !repository || !runId) {
  console.error('GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_RUN_ID are required.');
  process.exit(1);
}

// This repository's workflows run on public GitHub. Validate runner metadata
// before attaching credentials; a custom API origin must never receive them.
function requireGithubOrigin(value, expected, name) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error(`${name} must identify the public GitHub origin`); }
  if (url.origin !== expected || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must identify the public GitHub origin`);
  }
}
requireGithubOrigin(process.env.GITHUB_API_URL || 'https://api.github.com', 'https://api.github.com', 'GITHUB_API_URL');
requireGithubOrigin(process.env.GITHUB_SERVER_URL || 'https://github.com', 'https://github.com', 'GITHUB_SERVER_URL');
if (repository.trim() !== repository || runId.trim() !== runId
    || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repository)
    || ['.', '..'].includes(repository.split('/')[1]) || !/^[1-9][0-9]*$/.test(runId)) {
  throw new Error('Invalid GitHub repository or workflow run identity');
}
const runUrl = `https://github.com/${repository}/actions/runs/${runId}`;
const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'laro-automation-failure-recorder',
};

async function github(path, init = {}) {
  if (path.trim() !== path || !/^\/issues(?:\?state=open&per_page=100|\/[1-9][0-9]*)?$/.test(path)) {
    throw new Error('Unexpected automation issue API path');
  }
  const endpoint = new URL('https://api.github.com');
  const [owner, repositoryName] = repository.split('/');
  endpoint.pathname = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}${path.split('?')[0]}`;
  if (path.includes('?')) {
    endpoint.searchParams.set('state', 'open');
    endpoint.searchParams.set('per_page', '100');
  }
  const response = await fetch(endpoint, {
    ...init,
    redirect: 'error',
    headers: { ...headers, ...init.headers },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} while recording automation failure`);
  }
  return response.status === 204 ? undefined : response.json();
}

const body = [
  `The latest ${category} run failed and requires repository-owner review.`,
  '',
  `- Workflow: ${workflow}`,
  `- Run: ${runUrl}`,
  `- Recorded: ${new Date().toISOString()}`,
  '',
  'Review the linked redacted workflow logs, fix or explicitly accept the finding, rerun the workflow, and close this issue only after it passes.',
].join('\n');

const issues = await github('/issues?state=open&per_page=100');
const existing = issues.find((issue) => !issue.pull_request && issue.title === title);

if (existing) {
  await github(`/issues/${existing.number}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
  console.log(`Updated failure issue #${existing.number}.`);
} else {
  const created = await github('/issues', {
    method: 'POST',
    body: JSON.stringify({ title, body }),
  });
  console.log(`Created failure issue #${created.number}.`);
}
