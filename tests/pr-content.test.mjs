import test from 'node:test';
import assert from 'node:assert/strict';
import { contentParts, snapshotObjects, syncContent, readThreads } from '../scripts/pr-content.mjs';

const pr = { number: 1, body: 'Nội dung gốc', user: { login: 'author' }, base: { ref: 'main' }, head: { sha: 'a'.repeat(40) } };
test('Markdown remains outside wrappers and long Unicode content is retained in parts', () => {
  const value = '# Heading\n\n| A | B |\n|---|---|\n| one | two |\n\n```js\nconsole.log(1)\n```\n' + '🙂'.repeat(16000);
  const parts = contentParts('A/repo', 1, 'comment', 1, { author: 'alice' }, value);
  const recovered = parts.map(p => p.body.slice(p.marker.length + 1, p.body.lastIndexOf('\n\n---\nCopied from'))).join('');
  assert.equal(recovered, value);
  assert.ok(parts[0].body.startsWith(parts[0].marker + '\n# Heading'));
  assert.ok(parts.every(p => p.body.length <= 60000));
});
test('published reviews and replies retain provenance; pending feedback and bridge echoes are excluded', () => {
  const reviews = [{ id: 1, submitted_at: 'now', state: 'CHANGES_REQUESTED', body: 'fix', user: { login: 'reviewer' } }, { id: 2, state: 'PENDING', body: 'secret' }];
  const inline = [{ id: 3, pull_request_review_id: 1, in_reply_to_id: 9, body: 'reply', start_line: 1, original_line: 3, diff_hunk: 'context', user: { login: 'reader' } }, { id: 4, pull_request_review_id: 2, body: 'secret' }];
  const rows = snapshotObjects(pr, [{ id: 5, body: 'echo', user: { login: 'sync[bot]' } }, { id: 6, body: 'read-only user feedback', user: { login: 'reader' } }], reviews, inline, [], 'sync[bot]');
  assert.equal(rows.length, 4);
  assert.equal(rows.find(r => r.kind === 'inline').metadata.in_reply_to_id, 9);
  assert.ok(!JSON.stringify(rows).includes('secret'));
  assert.ok(!JSON.stringify(rows).includes('echo'));
});
test('thread reader paginates threads and nested comments and preserves resolution', async () => {
  let n = 0;
  const result = await readThreads(async (_repo, _q, v) => {
    n++;
    if (v.id) return { node: { comments: { nodes: [{ databaseId: 2 }], pageInfo: { hasNextPage: false } } } };
    return { repository: { pullRequest: { reviewThreads: { nodes: v.after ? [] : [{ id: 'thread', isResolved: true, comments: { nodes: [{ databaseId: 1 }], pageInfo: { hasNextPage: true, endCursor: 'comment-page' } } }], pageInfo: { hasNextPage: !v.after, endCursor: 'thread-page' } } } } };
  }, 'A/repo', 1);
  assert.equal(n, 3);
  assert.equal(result[0].isResolved, true);
  assert.deepEqual(result[0].comments.map(c => c.databaseId), [1, 2]);
});
function fixture() {
  const all = { A: [], B: [] }; let id = 10, writes = 0, fail = false;
  const a = structuredClone(pr), b = { ...structuredClone(pr), number: 2, body: 'B independent notes', user: {login: 'b-bot'}, head: {ref: 'incoming/a-pr-1', repo: {full_name: 'B'}} };
  const args = { source: 'A', target: 'B', a, b, sourceBot: 'a-bot', bot: 'b-bot',
    list: async (repo, path) => structuredClone(path.startsWith('/issues/') ? all[repo] : []),
    graphql: async () => { if (fail) throw new Error('Snapshot failed'); return { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } }; },
    api: async (repo, path, opts = {}) => {
      if (path.startsWith('/pulls/')) {
        const p = repo === 'A' ? a : b;
        if (opts.method === 'PATCH') { writes++; p.body = opts.body.body; }
        return structuredClone(p);
      }
      if (!opts.method) return structuredClone(all[repo].find(c => path.endsWith('/' + c.id)));
      writes++;
      let c = opts.method === 'PATCH' ? all[repo].find(c => path.endsWith('/' + c.id)) : null;
      if (!c) { c = { id: ++id, user: { login: repo === 'A' ? 'a-bot' : 'b-bot' } }; all[repo].push(c); }
      c.body = opts.body.body; return structuredClone(c);
    },
  };
  return { all, args, writes: () => writes, fail: () => fail = true };
}
test('A body updates B directly while B notes survive; rerun is idempotent with no echo', async () => {
  const f = fixture(); await syncContent(f.args); const before = f.writes();
  await syncContent(f.args); assert.equal(f.writes(), before);
  f.args.a.body = '# Edited A\n\n- [x] checked'; await syncContent(f.args);
  assert.ok(f.args.b.body.startsWith(f.args.a.body + '\n\n'));
  assert.ok(f.args.b.body.includes('B independent notes'));
  assert.ok(f.all.A[0].body.includes('B independent notes'));
  assert.equal(f.writes(), before + 1);
  assert.equal(f.all.B.length, 0);
});
test('comment edits and deletion append history once without changing older copies', async () => {
  const f = fixture(); f.all.A.push({ id: 1, user: { login: 'human' }, body: '# First' });
  await syncContent(f.args);
  const original = structuredClone(f.all.B[0]);
  f.all.A[0].body = '# Second'; await syncContent(f.args);
  assert.equal(f.all.B.length, 2);
  assert.deepEqual(f.all.B[0], original);
  assert.ok(f.all.B[1].body.includes('# Second'));
  f.all.A = f.all.A.filter(c => c.id !== 1); await syncContent(f.args);
  assert.equal(f.all.B.length, 3);
  assert.ok(f.all.B[2].body.includes('no longer published'));
  const before = f.writes(); await syncContent(f.args); assert.equal(f.writes(), before);
});
test('incomplete API snapshots cause no write or deletion', async () => {
  const f = fixture(); await syncContent(f.args); const before = f.writes(); f.fail();
  await assert.rejects(syncContent(f.args), /Snapshot failed/);
  assert.equal(f.writes(), before);
});
