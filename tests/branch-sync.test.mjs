import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { branchSyncPush, syncBranches, validBranch } from '../scripts/branch-sync.mjs';

const source = 'A/repo', target = 'B/repo';
async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-branches-test-'));
  const a = join(dir, 'a.git'), b = join(dir, 'b.git');
  const raw = (args, allow = [0]) => {
    const r = spawnSync('git', ['-c', 'user.name=Branch Test', '-c', 'user.email=test@example.invalid', ...args], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (!allow.includes(r.status)) throw new Error(r.stderr);
    return { text: r.stdout.trim(), status: r.status };
  };
  try {
    raw(['init', '--bare', a]); raw(['init', '--bare', b]); raw(['init', '--initial-branch=main', '.']);
    const commit = parent => {
      if (parent) raw(['switch', '--detach', parent]);
      raw(['commit', '--allow-empty', '-m', 'branch commit ' + (++n)]);
      return raw(['rev-parse', 'HEAD']).text;
    };
    let n = 0;
    const base = commit(), next = commit(base), other = commit(base);
    const set = (repo, branch, sha) => raw(['push', '--force', repo === source ? a : b, `${sha}:refs/heads/${branch}`]);
    const get = (repo, branch) => raw(['--git-dir', repo === source ? a : b, 'rev-parse', '--verify', `refs/heads/${branch}`]).text;
    set(source, 'main', base); set(target, 'main', base);
    const pushes = [], open = new Set();
    let beforePush, beforeRead, failBranch;
    const git = (args, token, allow) => {
      if (args[0] === 'push') {
        pushes.push([...args]);
        assert.equal(token, 'source-token');
        assert.ok(args.includes(`https://github.com/${source}.git`));
        if (beforePush) { const f = beforePush; beforePush = null; f(); }
        if (failBranch && args.at(-1).endsWith(':' + 'refs/heads/' + failBranch)) throw new Error('Simulated rejected branch');
      }
      return raw(args.map(arg => arg === `https://github.com/${source}.git` ? a : arg === `https://github.com/${target}.git` ? b : arg), allow);
    };
    const api = async (repo, path) => {
      const branch = decodeURIComponent(path.slice('/git/ref/heads/'.length));
      if (beforeRead) { const f = beforeRead; beforeRead = null; f(); }
      return { object: { sha: get(repo, branch) } };
    };
    const list = async () => [...open].map(ref => ({ head: { ref, repo: { full_name: source } } }));
    const run = () => syncBranches({
      source, target, sourceToken: 'source-token', targetToken: 'target-token', git, api, list,
      ancestor: (old, newer) => raw(['merge-base', '--is-ancestor', old, newer], [0, 1]).status === 0,
    });
    await fn({ base, next, other, set, get, raw, a, b, run, open, pushes,
      raceA: f => { beforePush = f; }, raceB: f => { beforeRead = f; }, fail: branch => { failBranch = branch; } });
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith('bridge-branches-test-'));
    assert.equal(realpathSync(dir).toLowerCase(), resolve(dir).toLowerCase());
    rmSync(dir, { recursive: true, force: true });
  }
}

test('all B heads (including slash, dev and incoming) arrive at identical SHA; A-only heads and B remain untouched', () => fixture(async f => {
  for (const branch of ['dev', 'release/2026', 'incoming/a-pr-42', 'unicode/nhánh']) f.set(target, branch, f.next);
  f.set(source, 'feature/a-only', f.other);
  const r = await f.run();
  assert.equal(r.filter(x => x.state === 'created').length, 4);
  for (const branch of ['dev', 'release/2026', 'incoming/a-pr-42', 'unicode/nhánh']) {
    assert.equal(f.get(source, branch), f.next); assert.equal(f.get(target, branch), f.next);
  }
  assert.equal(f.get(source, 'feature/a-only'), f.other);
  const writes = f.pushes.length;
  assert.ok((await f.run()).every(x => ['current', 'preserved-a-only'].includes(x.state)));
  assert.equal(f.pushes.length, writes);
}));
test('fast-forward and divergent B rewrite preserve old A history atomically', () => fixture(async f => {
  f.set(source, 'release/ff', f.base); f.set(target, 'release/ff', f.next);
  f.set(source, 'release/diverged', f.other); f.set(target, 'release/diverged', f.next);
  const r = await f.run();
  assert.equal(r.find(x => x.branch === 'release/ff').state, 'fast-forward');
  const replaced = r.find(x => x.branch === 'release/diverged');
  assert.equal(replaced.state, 'replaced-with-recovery');
  assert.equal(f.get(source, replaced.recovery.slice('refs/heads/'.length)), f.other);
  assert.equal(f.get(source, 'release/diverged'), f.next);
}));
test('open source PR heads defer until closed while unrelated branches still synchronize', () => fixture(async f => {
  f.set(source, 'feature/active', f.other); f.set(target, 'feature/active', f.next);
  f.set(target, 'release/ready', f.next); f.open.add('feature/active');
  const r = await f.run();
  assert.equal(r.find(x => x.branch === 'feature/active').state, 'deferred-open-pr');
  assert.equal(f.get(source, 'feature/active'), f.other);
  assert.equal(f.get(source, 'release/ready'), f.next);
  f.open.clear();
  assert.equal((await f.run()).find(x => x.branch === 'feature/active').state, 'replaced-with-recovery');
}));
test('deleted B branches remain at A and stale local B tracking refs are pruned', () => fixture(async f => {
  f.set(target, 'release/deleted', f.next); await f.run();
  f.raw(['push', f.b, ':refs/heads/release/deleted']);
  const r = await f.run();
  assert.equal(r.find(x => x.branch === 'release/deleted').state, 'preserved-a-only');
  assert.equal(f.get(source, 'release/deleted'), f.next);
}));
test('concurrent source advance fails lease without overwriting history or creating backup', () => fixture(async f => {
  f.set(source, 'release/race', f.base); f.set(target, 'release/race', f.next);
  f.raceA(() => f.set(source, 'release/race', f.other));
  assert.equal((await f.run()).find(x => x.branch === 'release/race').state, 'error');
  assert.equal(f.get(source, 'release/race'), f.other);
}));
test('concurrent B advance is detected before write', () => fixture(async f => {
  f.set(source, 'release/race', f.base); f.set(target, 'release/race', f.next);
  f.raceB(() => f.set(target, 'release/race', f.other));
  const r = await f.run();
  assert.equal(r.find(x => x.branch === 'release/race').state, 'error');
  assert.equal(f.get(source, 'release/race'), f.base); assert.equal(f.pushes.length, 0);
}));
test('occupied recovery or ref-prefix conflict cannot destroy A; other branches still sync', () => fixture(async f => {
  f.set(source, 'release/diverged', f.other); f.set(target, 'release/diverged', f.next);
  const p = branchSyncPush({ source, target, repo: source, branch: 'release/diverged', before: f.other, accepted: f.next, replace: true });
  f.set(source, p.recovery.slice('refs/heads/'.length), f.next);
  f.set(source, 'blocked', f.other); f.set(target, 'blocked/child', f.next);
  f.set(target, 'release/works', f.next);
  const r = await f.run();
  assert.equal(r.filter(x => x.state === 'error').length, 2);
  assert.equal(f.get(source, 'release/diverged'), f.other);
  assert.equal(f.get(source, 'blocked'), f.other);
  assert.equal(f.get(source, 'release/works'), f.next);
}));
test('planner rejects reverse sync, tags, deletion and invalid branch/commit input', () => {
  const args = { source, target, repo: source, branch: 'release/x', before: null, accepted: 'a'.repeat(40), replace: false };
  assert.throws(() => branchSyncPush({ ...args, repo: target }));
  for (const branch of ['main', '', '../bad', 'x..y', 'x:y', 'x y', 'x\\y', 'x.lock', 'x/.hidden', 'x@{y', 'x//y', 'x*', 'x[']) {
    assert.throws(() => branchSyncPush({ ...args, branch }), branch);
  }
  assert.equal(validBranch('release/normal'), true);
  assert.throws(() => branchSyncPush({ ...args, accepted: '--all' }));
});
