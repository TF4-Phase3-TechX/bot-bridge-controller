import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationMetadata } from '../scripts/pr-bridge-policy.mjs';

const base = { source: 'A/repo', target: 'B/repo', repo: 'A/repo', sha: 'a'.repeat(40), runId: '123', event: 'pull_request_target', pr: '8' };
test('manual invocation has no notification; existing B push input remains valid', () => {
  assert.equal(notificationMetadata({ source: base.source, target: base.target }), null);
  assert.equal(notificationMetadata({ ...base, repo: 'B/repo', event: '', pr: '' }).event, 'push');
});
test('A and B PR, review and conversation notifications retain provenance', () => {
  for (const repo of ['A/repo', 'B/repo']) for (const event of ['pull_request_target', 'issue_comment', 'pull_request_review', 'pull_request_review_comment']) {
    const result = notificationMetadata({ ...base, repo, event });
    assert.equal(result.repository, repo);
    assert.equal(result.event, event);
    assert.equal(result.pr, '8');
    assert.equal(result.run, `https://github.com/${repo}/actions/runs/123`);
  }
});
test('notification rejects foreign repos, injected metadata and invalid event scopes', () => {
  for (const invalid of [
    { repo: 'outside/repo' }, { sha: 'main' }, { runId: '12/../../' }, { event: 'workflow_dispatch' },
    { pr: '0' }, { pr: '8; merge' }, { pr: '' }, { event: 'push', pr: '' },
    { repo: 'B/repo', event: 'push', pr: '8' }, { repo: '', sha: '', runId: '' },
  ]) assert.throws(() => notificationMetadata({ ...base, ...invalid }), /Invalid notification/);
  assert.equal(notificationMetadata({ ...base, repo: 'B/repo', event: 'push', pr: '' }).event, 'push');
});
