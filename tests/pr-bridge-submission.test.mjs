import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionTitle, verifySubmission } from '../scripts/pr-bridge-submission.mjs';

const sha = 'a'.repeat(40), source = 'A/repo', now = Date.parse('2026-10-20T12:00:00Z');
const trigger = { repository: source, event: 'workflow_dispatch', pr: '3', sha, runId: '11', run: 'https://github.com/A/repo/actions/runs/11' };
function fixture(change = {}, permission = { permission: 'write' }) {
  const run = {
    id: 11, repository: { id: 99, full_name: source }, head_repository: { id: 99 },
    workflow_id: 5, path: '.github/workflows/notify-controller.yml', event: 'workflow_dispatch',
    head_branch: 'main', head_sha: 'b'.repeat(40), display_title: submissionTitle('3', sha),
    actor: { id: 10, type: 'User', login: 'developer' }, triggering_actor: { id: 10 },
    run_attempt: 1, status: 'completed', conclusion: 'success', created_at: '2026-10-20T11:59:00Z',
    ...change,
  };
  const calls = [];
  const api = async (repo, path) => {
    assert.equal(repo, source); calls.push(path);
    if (!path) return { id: 99, default_branch: 'main' };
    if (path === '/actions/workflows/notify-controller.yml') return { id: 5, path: '.github/workflows/notify-controller.yml' };
    if (path === '/actions/runs/11') return run;
    if (path === '/collaborators/developer/permission') return permission;
    throw new Error(`Unexpected API ${path}`);
  };
  return { run, calls, verify: extra => verifySubmission({ trigger, source, api, now, ...extra }) };
}

test('verified GitHub run binds source PR/SHA and actual actor, not caller assertions', async () => {
  const result = await fixture().verify();
  assert.deepEqual(result, { pr: 3, sha, actor: 'developer', run: trigger.run });
  for (const path of ['.github/workflows/notify-controller.yml@main', '.github/workflows/notify-controller.yml@refs/heads/main']) {
    assert.equal((await fixture({ path }).verify()).sha, sha);
  }
});
test('events and schedule carry no authority to transfer code', async () => {
  for (const event of ['push', 'pull_request_target', 'issue_comment']) {
    assert.equal(await verifySubmission({ trigger: { ...trigger, event }, source }), null);
  }
  assert.equal(await verifySubmission({ trigger: null, source }), null);
});
test('reject forged, foreign, edited-ref, rerun, expired and unsuccessful submissions', async () => {
  for (const change of [
    { id: 12 }, { repository: { id: 100, full_name: source } }, { head_repository: { id: 100 } },
    { workflow_id: 6 }, { path: '.github/workflows/other.yml' }, { event: 'push' },
    { head_branch: 'feature/forged' }, { display_title: submissionTitle('4', sha) },
    { display_title: submissionTitle('3', 'c'.repeat(40)) }, { run_attempt: 2 },
    { actor: { id: 10, login: 'app', type: 'Bot' } }, { triggering_actor: { id: 12 } },
    { created_at: '2026-10-19T00:00:00Z' }, { created_at: '2026-10-21T00:00:00Z' },
    { created_at: 'invalid' }, { conclusion: 'failure' }, { conclusion: 'cancelled' },
  ]) await assert.rejects(fixture(change).verify(), /Untrusted|did not succeed/);
});
test('revoked/read-only actor permission fails; custom Write role uses effective permission', async () => {
  await assert.rejects(fixture({}, { permission: 'read' }).verify(), /Write/);
  await assert.rejects(fixture({}, {}).verify(), /Write/);
  assert.equal((await fixture({}, { permission: 'custom', user: { permissions: { push: true } } }).verify()).actor, 'developer');
});
test('controller waits for notifier success and times out without accepting pending runs', async () => {
  const f = fixture({ status: 'in_progress', conclusion: null });
  let waits = 0;
  await f.verify({ sleep: async () => { waits++; f.run.status = 'completed'; f.run.conclusion = 'success'; } });
  assert.equal(waits, 1);
  await assert.rejects(fixture({ status: 'in_progress', conclusion: null }).verify({ sleep: async () => {} }), /not completed/);
});
