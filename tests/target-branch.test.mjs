import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { validTargetBranch } from '../scripts/target-branch.mjs';
import { assertMutation } from '../scripts/pr-bridge-policy.mjs';

test('target syntax follows Git rather than a branch-name whitelist', () => {
  for (const branch of ['main', 'dev', 'init-demo', 'release/v1', 'develop', 'feature/tiếng-việt', "feature/quote'name", 'x;y', '', 'HEAD', '-x', 'x..y', 'x y', 'x//y', 'x.lock', 'x@{y', 'x~y', 'x.', '/x']) {
    const git = spawnSync('git', ['check-ref-format', '--branch', branch], {encoding:'utf8'});
    assert.equal(validTargetBranch(branch), git.status === 0, branch);
  }
});

test('PR mutation targets the configured custom branch only', () => {
  for (const branch of ['init-demo', 'release/v1']) {
    const input = {repo:'B/repo', source:'A/repo', target:'B/repo', path:'/pulls', method:'POST', branch};
    assert.doesNotThrow(() => assertMutation({...input, body:{base:branch, head:'incoming/a-pr-1'}}));
    assert.throws(() => assertMutation({...input, body:{base:'main', head:'incoming/a-pr-1'}}));
  }
});
