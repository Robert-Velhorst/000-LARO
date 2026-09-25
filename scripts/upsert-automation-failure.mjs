#!/usr/bin/env node

const [title = '[maintenance] Automated checks require attention', category = 'scheduled maintenance'] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
const workflow = process.env.GITHUB_WORKFLOW || 'automation';

if (!token || !repository || !runId) {
  console.error('GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_RUN_ID are required.');
  process.exit(1);
}

const apiBase = process.env.GITHUB_API_URL || 'https://api.github.com';
const runUrl = `${serverUrl}/${repository}/actions/runs/${runId}`;
const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'laro-automation-failure-recorder',
};

async function github(path, init = {}) {
  const response = await fetch(`${apiBase}/repos/${repository}${path}`, {
    ...init,
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
