import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMutation, assertPush } from '../scripts/pr-bridge-policy.mjs';

const source = 'A/repo', target = 'B/repo';
const mutation = input => assertMutation({ source, target, repo: target, ...input });
test('B may receive a paired PR but never a merge or reference API mutation', () => {
  assert.doesNotThrow(() => mutation({ method: 'POST', path: '/pulls', body: { head: 'incoming/a-pr-2', base: 'main' } }));
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const path of ['/pulls/2/merge', '/git/refs/heads/main', '/branches/main/protection']) {
      assert.throws(() => mutation({ method, path, body: {} }), /outside bridge policy/);
    }
  }
  assert.throws(() => mutation({ method: 'POST', path: '/pulls', body: { head: 'main', base: 'main' } }));
  assert.throws(() => mutation({ method: 'PATCH', path: '/pulls/2', body: { base: 'release' } }));
});
test('Git push may update A main or paired B feature branch only', () => {
  assert.doesNotThrow(() => assertPush({ source, target, repo: source, ref: 'refs/heads/main' }));
  assert.doesNotThrow(() => assertPush({ source, target, repo: target, ref: 'refs/heads/incoming/a-pr-2' }));
  for (const ref of ['refs/heads/main', 'refs/tags/v1', 'refs/heads/incoming/a-pr-0', '+refs/heads/incoming/a-pr-2', ':refs/heads/main']) {
    assert.throws(() => assertPush({ source, target, repo: target, ref }));
  }
  assert.throws(() => assertPush({ source, target, repo: 'other/repo', ref: 'refs/heads/main' }));
});
test('Source comments, marked B conversation copies and limited PR edits are allowed', () => {
  assert.doesNotThrow(() => mutation({ repo: source, method: 'POST', path: '/issues/2/comments', body: { body: 'accepted' } }));
  assert.doesNotThrow(() => mutation({ repo: source, method: 'PATCH', path: '/pulls/2', body: { state: 'closed' } }));
  assert.throws(() => mutation({ method: 'PATCH', path: '/pulls/2', body: { state: 'closed' } }));
  assert.throws(() => mutation({ method: 'PATCH', path: '/pulls/2', body: { body: 'overwrite maintainer notes' } }));
  assert.doesNotThrow(() => mutation({ method: 'POST', path: '/issues/2/comments', body: { body: '<!-- bridge-source-status:A/repo#2 -->\nA is closed; B decides.' } }));
  assert.throws(() => mutation({ repo: 'other/repo', method: 'GET', path: '/pulls' }));
  assert.throws(() => mutation({ method: 'POST', path: '/issues/2/comments', body: { body: 'unscoped comment' } }));
  assert.doesNotThrow(() => mutation({ method: 'POST', path: '/issues/2/comments', body: { body: '<!-- bridge-conversation:A/repo#2:123 -->\nAddressed finding.' } }));
  assert.throws(() => mutation({ method: 'PATCH', path: '/pulls/2', body: { state: 'open' } }));
});
