import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mainSyncPush } from '../scripts/pr-bridge-policy.mjs';

const source = 'A/repo', target = 'B/repo';
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-main-test-'));
  const remote = join(dir, 'remote.git');
  const git = (args, allowed = [0]) => {
    const result = spawnSync('git', ['-c', 'user.name=Bridge Test', '-c', 'user.email=test@example.invalid', ...args], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    assert.ok(allowed.includes(result.status), result.stderr);
    return { status: result.status, text: result.stdout.trim() };
  };
  try {
    git(['init', '--bare', remote]);
    git(['init', '--initial-branch=main', '.']);
    git(['commit', '--allow-empty', '-m', 'baseline']);
    const base = git(['rev-parse', 'HEAD']).text;
    git(['commit', '--allow-empty', '-m', 'A-only history']);
    const before = git(['rev-parse', 'HEAD']).text;
    git(['push', remote, `${before}:refs/heads/main`]);
    git(['switch', '--detach', base]);
    git(['commit', '--allow-empty', '-m', 'Accepted B history']);
    const accepted = git(['rev-parse', 'HEAD']).text;
    fn({ git, remote, before, accepted });
  } finally {
    // Delete only the exact temporary fixture created above.
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith('bridge-main-test-'));
    assert.equal(realpathSync(dir).toLowerCase(), resolve(dir).toLowerCase());
    rmSync(dir, { recursive: true, force: true });
  }
}
test('replace divergent A atomically, preserve old history, and allow an idempotent recovery ref', () => fixture(({ git, remote, before, accepted }) => {
  const p = mainSyncPush({ source, target, repo: source, before, accepted, replace: true });
  // Existing exact backup is safe to reuse.
  git(['push', remote, `${before}:${p.recovery}`]);
  git(['push', ...p.options, remote, ...p.refs]);
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'main']).text, accepted);
  assert.equal(git(['--git-dir', remote, 'rev-parse', p.recovery]).text, before);
}));
test('concurrent A update fails the lease and leaves both main and recovery unchanged', () => fixture(({ git, remote, before, accepted }) => {
  const p = mainSyncPush({ source, target, repo: source, before, accepted, replace: true });
  git(['switch', '--detach', before]);
  git(['commit', '--allow-empty', '-m', 'Concurrent A update']);
  const newer = git(['rev-parse', 'HEAD']).text;
  git(['push', remote, `${newer}:refs/heads/main`]);
  assert.notEqual(git(['push', ...p.options, remote, ...p.refs], [1]).status, 0);
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'main']).text, newer);
  assert.equal(git(['--git-dir', remote, 'show-ref', '--verify', '--quiet', p.recovery], [1]).status, 1);
}));
test('occupied recovery ref aborts the whole replacement; B and malformed SHAs cannot be targeted', () => fixture(({ git, remote, before, accepted }) => {
  const p = mainSyncPush({ source, target, repo: source, before, accepted, replace: true });
  git(['push', remote, `${accepted}:${p.recovery}`]);
  git(['push', ...p.options, remote, ...p.refs], [1]);
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'main']).text, before);
  assert.equal(git(['--git-dir', remote, 'rev-parse', p.recovery]).text, accepted);
  assert.throws(() => mainSyncPush({ source, target, repo: target, before, accepted, replace: true }));
  assert.throws(() => mainSyncPush({ source, target, repo: source, before: '--all', accepted, replace: true }));
}));
