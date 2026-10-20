import test from 'node:test';
import assert from 'node:assert/strict';
import { runBridge } from '../scripts/pr-bridge.mjs';

const config = { source: 'A/repo', target: 'B/repo', bot: 'bridge[bot]', sourceBot: 'sync[bot]', controllerRepo: 'B/controller' };
const sha = c => c.repeat(40);
const base = sha('1'), main = sha('a'), head = sha('b'), second = sha('c'), bExtra = sha('d'), rewritten = sha('e');
const now = Date.parse('2026-10-20T12:00:00Z'), recent = '2026-10-20T11:00:00Z', old = '2026-01-01T00:00:00Z';

function fixture(options = {}) {
  const calls = [], pushes = [], comments = new Map();
  const parents = new Map([[main, [base]], [head, [base]], [second, [base]], [bExtra, [head]], [rewritten, [base]]]);
  const isAncestor = (a, b, visited = new Set()) => {
    if (a === b) return true;
    if (visited.has(b)) return false;
    visited.add(b);
    return (parents.get(b) || []).some(p => isAncestor(a, p, visited));
  };
  const a = n => ({
    number: n, state: 'open', draft: false, title: 'Contribution ' + n,
    updated_at: recent, base: { ref: 'main' },
    head: { sha: n === 2 ? head : second, ref: 'feature-' + n, repo: { full_name: config.source } },
    html_url: `https://github.com/${config.source}/pull/${n}`,
  });
  const sources = [a(2), a(1)];
  const target = {
    number: 20, state: 'open', merged_at: null, merge_commit_sha: null, updated_at: recent,
    user: { login: config.bot, type: 'Bot' }, base: { ref: 'main' },
    head: { sha: head, ref: 'incoming/a-pr-2', repo: { full_name: config.target } },
    body: 'Maintainer notes, no bridge marker.', title: 'Maintainer custom title',
    html_url: `https://github.com/${config.target}/pull/20`,
  };
  const targets = [target];
  if (options.sourceClosed) sources[0].state = 'closed';
  if (options.bAhead) target.head.sha = bExtra;
  if (options.diverged) sources[0].head.sha = rewritten;
  if (options.sourceAhead) {
    sources[0].head.sha = rewritten;
    parents.set(rewritten, [head]);
  }
  if (options.oldClosed) {
    sources[0].state = target.state = 'closed';
    sources[0].updated_at = target.updated_at = old;
  }
  if (options.oldRejected) { target.state = 'closed'; target.updated_at = old; }
  if (options.accepted || options.rewrittenMerge) {
    target.state = 'closed'; target.merged_at = recent; target.merge_commit_sha = main;
    if (options.accepted) parents.set(main, [head]);
  }
  if (options.bAhead && options.rewrittenMerge) target.head.sha = bExtra;
  const env = {
    GITHUB_REPOSITORY: config.controllerRepo, GITHUB_REF: 'refs/heads/main',
    SOURCE_TOKEN: 'fake-A', BRIDGE_APP_TOKEN: 'fake-B', GITHUB_RUN_ID: '10',
  };
  if (options.event) Object.assign(env, {
    TRIGGER_SOURCE_REPO: config.source, TRIGGER_SOURCE_SHA: main,
    TRIGGER_SOURCE_RUN_ID: '11', TRIGGER_SOURCE_EVENT: 'issue_comment', TRIGGER_SOURCE_PR: '2',
  });
  let fetched, mainSha = main, sourceReads = 0;
  const mirrored = new Map();
  const spawnImpl = (_command, raw) => {
    const args = raw.slice(4);
    if (options.branchFetchFailure && args[0] === 'fetch' && args.includes('--prune')) throw new Error('Branch snapshot unavailable');
    let stdout = '', status = 0;
    if (args[0] === 'fetch' && args[3]?.startsWith('refs/pull/')) {
      const n = Number(args[3].split('/')[2]);
      fetched = (args[2].includes('/A/') ? sources : targets).find(p => p.number === n).head.sha;
    }
    if (args[0] === 'rev-parse') stdout = args[1] === 'FETCH_HEAD' ? fetched : mainSha;
    if (args[0] === 'ls-remote') {
      const ref = args.at(-1);
      stdout = `${mirrored.get(ref.slice('refs/heads/'.length))}\t${ref}`;
    }
    if (args[0] === 'for-each-ref') {
      stdout = mainSha + ' ' + args[2] + 'main';
      if (options.reflectIncoming) {
        const refs = args[2].includes('all-b') ? targets.map(p => [p.head.ref, p.head.sha]) : [...mirrored];
        stdout += refs.map(([ref, sha]) => '\n' + sha + ' ' + args[2] + ref).join('');
      }
    }
    if (args[0] === 'merge-base') {
      if (args[1] === '--is-ancestor') status = isAncestor(args[2], args[3]) ? 0 : 1;
      else stdout = base;
    }
    if (args[0] === 'push') {
      pushes.push(args);
      if (options.pushFailure && args.at(-1).endsWith('a-pr-2')) status = 1;
      if (options.reflectIncoming && status === 0) {
        const [sha, ref] = args.at(-1).split(':refs/heads/');
        if (args.includes('https://github.com/A/repo.git')) mirrored.set(ref, sha);
        else for (const p of targets) if (p.head.ref === ref) p.head.sha = sha;
      }
    }
    if (args[0] === 'diff' && options.workflowChange) stdout = '.github/workflows/unsafe.yml';
    return { stdout, stderr: '', status };
  };
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url), method = opts.method || 'GET', body = opts.body && JSON.parse(opts.body);
    calls.push({ path: u.pathname, query: u.search, method, body });
    const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) });
    if (u.pathname === '/installation/repositories') return reply({
      total_count: options.broadToken ? 2 : 1, repositories: [{ full_name: options.wrongRepoToken ? 'Other/repo' : opts.headers.Authorization.endsWith('fake-A') ? config.source : config.target, private: true }],
    });
    const repo = u.pathname.startsWith('/repos/A/') ? config.source : config.target;
    const path = u.pathname.slice(('/repos/' + repo).length), prs = repo === config.source ? sources : targets;
    if (path === '/git/ref/heads/main') return reply({ object: { sha: mainSha } });
    if (options.reflectIncoming && path.startsWith('/git/ref/heads/')) {
      const ref = decodeURIComponent(path.slice('/git/ref/heads/'.length));
      return reply({ object: { sha: repo === config.source ? mirrored.get(ref) : targets.find(p => p.head.ref === ref)?.head.sha } });
    }
    if (path === '/pulls' && method === 'GET') {
      let items = prs.filter(p => u.searchParams.get('state') === 'all' || p.state === u.searchParams.get('state'));
      if (u.searchParams.has('head')) items = items.filter(p => u.searchParams.get('head').endsWith(':' + p.head.ref));
      const page = Number(u.searchParams.get('page') || 1);
      return reply(items.slice((page - 1) * 100, page * 100));
    }
    if (path === '/pulls' && method === 'POST') {
      const n = Number(body.head.match(/\d+$/)[0]);
      const created = { ...target, ...body, base: { ref: body.base }, number: 21, state: 'open', merged_at: null, head: { sha: sources.find(p => p.number === n).head.sha, ref: body.head, repo: { full_name: config.target } } };
      targets.push(created); return reply(created, 201);
    }
    const pr = /^\/pulls\/(\d+)$/.exec(path);
    if (pr) {
      const p = prs.find(p => p.number === Number(pr[1]));
      if (repo === config.source && p.number === 2 && method === 'GET' && ++sourceReads === 2 && options.newerBeforeClose) p.head.sha = rewritten;
      if (method === 'PATCH') Object.assign(p, body);
      return reply(p);
    }
    if (path.endsWith('/reviews')) return reply(options.oversizedReview && path.includes('/20/')
      ? [{ id: 99, submitted_at: recent, state: 'CHANGES_REQUESTED', user: { login: 'reviewer' }, body: 'x'.repeat(61000), commit_id: head }] : []);
    if (/^\/pulls\/\d+\/comments$/.test(path)) return reply([]);
    const issueComments = /^\/issues\/(\d+)\/comments$/.exec(path);
    if (issueComments) {
      const key = repo + '#' + issueComments[1];
      if (!comments.has(key)) comments.set(key, []);
      const entries = comments.get(key);
      if (method === 'GET') return reply(entries);
      const p = { id: 100 + calls.length, user: { type: 'Bot', login: repo === config.source ? config.sourceBot : config.bot }, body: body.body };
      entries.push(p); return reply(p, 201);
    }
    const editComment = /^\/issues\/comments\/(\d+)$/.exec(path);
    if (editComment) {
      const c = [...comments.values()].flat().find(c => c.id === Number(editComment[1]));
      Object.assign(c, body); return reply(c);
    }
    throw new Error(`Unhandled mock API: ${method} ${path}`);
  };
  return {
    calls, pushes, sources, targets, comments, parents,
    advanceMain: () => { parents.set(sha('f'), [mainSha]); mainSha = sha('f'); },
    run: () => runBridge({ config, env, fetchImpl, spawnImpl, now }),
  };
}

test('tokens for multiple repositories or a different pair fail before any Git push', async () => {
  for (const option of [{ broadToken: true }, { wrongRepoToken: true }]) {
    const f = fixture(option), r = await f.run();
    assert.equal(r.passed, false);
    assert.match(r.error, /exactly its private/);
    assert.equal(f.pushes.length, 0);
  }
});
test('branch identity recovers pairing after a maintainer edits the body; custom title/body are preserved', async () => {
  const f = fixture(), before = structuredClone(f.targets[0]);
  const r = await f.run();
  assert.equal(r.passed, true);
  assert.deepEqual(r.pairs.map(p => [p.a, p.b, p.state]), [[2, 20, 'pending'], [1, 21, 'pending']]);
  assert.equal(f.targets[0].body, before.body);
  assert.equal(f.targets[0].title, before.title);
  assert.equal(f.calls.filter(c => c.method === 'POST' && c.path.endsWith('/pulls')).length, 1);
});
test('B Update branch retains its additional commits without a backwards push', async () => {
  const f = fixture({ bAhead: true }), r = await f.run();
  assert.equal(r.passed, true);
  assert.equal(r.pairs[0].state, 'pending');
  assert.ok(!f.pushes.some(p => p.at(-1).endsWith('a-pr-2')));
});
test('normal source fast-forward still updates incoming', async () => {
  const f = fixture({ sourceAhead: true }), r = await f.run();
  assert.equal(r.passed, true);
  assert.ok(f.pushes.some(p => p.at(-1) === rewritten + ':refs/heads/incoming/a-pr-2'));
  assert.ok(f.pushes.every(p => !p.some(arg => arg.startsWith('--force'))));
});
test('branch reconciliation errors remain visible without starving PR contribution', async () => {
  const f = fixture({ branchFetchFailure: true }), r = await f.run();
  assert.equal(r.passed, false);
  assert.match(r.error, /B-to-A branches failed/);
  assert.equal(r.branches[0].state, 'error');
  assert.deepEqual(r.pairs.map(p => p.state), ['pending', 'pending']);
});
test('one run mirrors both newly created and advanced B incoming branches after PR transport', async () => {
  const f = fixture({ reflectIncoming: true, sourceAhead: true }), r = await f.run();
  assert.equal(r.passed, true);
  for (const [branch, sha] of [['incoming/a-pr-1', second], ['incoming/a-pr-2', rewritten]]) {
    const mirrored = r.branches.find(b => b.branch === branch);
    assert.equal(mirrored.state, 'created');
    assert.equal(mirrored.target, sha);
  }
});
test('rewritten A feature branch is blocked per pair without force-push or starving another PR', async () => {
  const f = fixture({ diverged: true }), r = await f.run();
  assert.equal(r.passed, true);
  assert.equal(r.pairs[0].state, 'incoming-diverged');
  assert.equal(r.pairs[1].state, 'pending');
  assert.ok(!f.pushes.some(p => p.at(-1).endsWith('a-pr-2')));
});
test('oversized feedback does not prevent the next pair from being processed', async () => {
  const f = fixture({ oversizedReview: true }), r = await f.run();
  assert.equal(r.passed, false);
  assert.equal(r.pairs[0].state, 'error');
  assert.equal(r.pairs[1].state, 'pending');
  assert.match(f.comments.get(config.source + '#2')[0].body, /could not process/);
});
test('a Git transport failure is isolated to its pair and still fails the run visibly', async () => {
  const f = fixture({ sourceAhead: true, pushFailure: true }), r = await f.run();
  assert.equal(r.passed, false);
  assert.equal(r.pairs[0].state, 'error');
  assert.equal(r.pairs[1].state, 'pending');
});
test('B reopen while A is closed never causes the bot to close B again', async () => {
  const f = fixture({ sourceClosed: true }), r = await f.run();
  assert.equal(r.passed, true);
  assert.equal(r.pairs.find(p => p.a === 2).state, 'source-closed');
  assert.equal(f.targets[0].state, 'open');
  assert.ok(f.comments.get(config.target + '#20')[0].body.includes('B still decides'));
  assert.ok(!f.calls.some(c => c.method === 'PATCH' && c.path.startsWith('/repos/B/repo/pulls/')));
});
test('accepted original history closes A and does not churn its comment on unrelated main advances', async () => {
  const f = fixture({ accepted: true });
  assert.equal((await f.run()).pairs[0].state, 'accepted');
  assert.equal(f.sources[0].state, 'closed');
  const accepted = f.comments.get(config.source + '#2')[0].body;
  assert.match(accepted, /Original source head/);
  // The accepted message contains the acceptance commit, not a changing main snapshot.
  assert.ok(!accepted.includes('A/main synchronized to B/main:'));
  const acceptedId = f.comments.get(config.source + '#2')[0].id;
  const editsBefore = f.calls.filter(c => c.method === 'PATCH' && c.path.endsWith('/issues/comments/' + acceptedId)).length;
  f.advanceMain();
  assert.equal((await f.run()).passed, true);
  assert.equal(f.calls.filter(c => c.method === 'PATCH' && c.path.endsWith('/issues/comments/' + acceptedId)).length, editsBefore);
});
test('B update-branch plus squash is an identity violation, not unseen A commits', async () => {
  const f = fixture({ bAhead: true, rewrittenMerge: true }), r = await f.run();
  assert.equal(r.pairs[0].state, 'identity-not-preserved');
  assert.equal(f.sources[0].state, 'open');
});
test('a new A head observed before closure keeps A open after B accepted the prior revision', async () => {
  const f = fixture({ accepted: true, newerBeforeClose: true });
  const r = await f.run();
  assert.equal(r.passed, true);
  assert.equal(f.sources[0].state, 'open');
  assert.ok(!f.calls.some(c => c.method === 'PATCH' && c.path === '/repos/A/repo/pulls/2'));
});
test('closed history older than the fallback window is skipped, but explicit PR events still process it', async () => {
  const quiet = fixture({ oldClosed: true }), recentOnly = await quiet.run();
  assert.ok(!recentOnly.pairs.some(p => p.a === 2));
  const event = fixture({ oldClosed: true, event: true }), explicit = await event.run();
  assert.equal(explicit.pairs.find(p => p.a === 2).state, 'rejected');
});
test('an open A PR finds its B pair even if B rejected it outside the history window', async () => {
  const f = fixture({ oldRejected: true }), r = await f.run();
  assert.equal(r.pairs.find(p => p.a === 2).state, 'rejected');
  assert.equal(f.sources[0].state, 'closed');
});
test('workflow-changing contribution stays blocked', async () => {
  const f = fixture({ workflowChange: true }), r = await f.run();
  assert.ok(r.pairs.every(p => p.state === 'blocked-workflow-change'));
  assert.equal(f.pushes.length, 0);
});
