import test from 'node:test';
import assert from 'node:assert/strict';
import { mainSyncDecision, pairDecision } from '../scripts/pr-bridge-policy.mjs';

test('A main follows accepted B history including divergence recovery', () => {
  assert.equal(mainSyncDecision({ equal: true, aIsAncestor: true }), 'current');
  assert.equal(mainSyncDecision({ equal: false, aIsAncestor: true }), 'fast-forward');
  assert.equal(mainSyncDecision({ equal: false, aIsAncestor: false }), 'replace-from-b');
});
test('a B merge does not accept newer unmerged A commits', () => {
  assert.equal(pairDecision({ merged: true, headIncluded: true, mergeResultIncluded: true }), 'accepted');
  assert.equal(pairDecision({ merged: true, headIncluded: false, mergeResultIncluded: true }), 'new-commits-pending');
});
test('rewritten source commits cannot satisfy identity even with exact merged PR head', () => {
  const sourceHead = 'a'.repeat(40);
  assert.equal(pairDecision({ merged: true, mergeResultIncluded: true, sourceHead, mergedHead: sourceHead, headIncluded: false }), 'identity-not-preserved');
});
test('newer or force-rewritten A revision is not silently closed after B squash or rebase', () => {
  assert.equal(pairDecision({ merged: true, mergeResultIncluded: true, sourceHead: 'b'.repeat(40), mergedHead: 'a'.repeat(40) }), 'new-commits-pending');
});
test('missing merge result in main defers acceptance even if source revision matches', () => {
  for (const headIncluded of [true, false]) {
    assert.equal(pairDecision({ merged: true, headIncluded, sourceHead: 'a'.repeat(40), mergedHead: 'a'.repeat(40), mergeResultIncluded: false }), 'merge-result-not-in-main');
  }
});
test('missing or malformed revision is never accepted merely by equality', () => {
  for (const sourceHead of [undefined, '', 'not-a-sha']) {
    assert.equal(pairDecision({ merged: true, mergeResultIncluded: true, sourceHead, mergedHead: sourceHead }), 'new-commits-pending');
  }
  assert.equal(pairDecision({ merged: false, closed: true, sourceHead: 'a'.repeat(40), mergedHead: 'a'.repeat(40), mergeResultIncluded: true }), 'rejected');
});
test('B rejection stays rejected instead of recreating a PR', () => {
  assert.equal(pairDecision({ merged: false, closed: true }), 'rejected');
});
test('withdrawal is distinct from acceptance', () => {
  assert.equal(pairDecision({ sourceClosed: true }), 'withdrawn');
  assert.equal(pairDecision({}), 'pending');
});
