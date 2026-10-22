import test from 'node:test';
import assert from 'node:assert/strict';
import { contentParts, snapshotObjects, syncContent, readThreads } from '../scripts/pr-content.mjs';

const pr = { number: 1, body: 'Nội dung gốc', user: { login: 'author' }, base: { ref: 'main' }, head: { sha: 'a'.repeat(40) } };
test('long Unicode and hostile fences are reversible without truncation or activated Markdown', () => {
  const value = '🙂 Tiếng Việt\n' + '`'.repeat(47000) + '\n```suggestion\ncode\n```\n@all';
  const parts = contentParts('A/repo', 1, 'body', 1, {}, value);
  const recovered = parts.map(p => {
    const block = p.body.slice(p.body.indexOf('\n\n') + 2);
    const first = block.indexOf('\n'), fenceLength = block.slice(0, first).length - 4;
    return block.slice(first + 1, -(fenceLength + 1));
  }).join('');
  assert.equal(recovered, '{}\n\n' + value);
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
  const a = structuredClone(pr), b = { ...structuredClone(pr), number: 2, body: 'B independent notes' };
  const args = { source: 'A', target: 'B', a, b, sourceBot: 'a-bot', bot: 'b-bot',
    list: async (repo, path) => structuredClone(path.startsWith('/issues/') ? all[repo] : []),
    graphql: async () => { if (fail) throw new Error('Snapshot failed'); return { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } }; },
    api: async (repo, path, opts = {}) => {
      if (!opts.method) return structuredClone(all[repo].find(c => path.endsWith('/' + c.id)));
      writes++;
      let c = opts.method === 'PATCH' ? all[repo].find(c => path.endsWith('/' + c.id)) : null;
      if (!c) { c = { id: ++id, user: { login: repo === 'A' ? 'a-bot' : 'b-bot' } }; all[repo].push(c); }
      c.body = opts.body.body; return structuredClone(c);
    },
  };
  return { all, args, writes: () => writes, fail: () => fail = true };
}
test('both bodies update without overwriting originals or echoing; rerun is idempotent', async () => {
  const f = fixture(); await syncContent(f.args); const before = f.writes();
  await syncContent(f.args); assert.equal(f.writes(), before);
  f.args.a.body = 'edited A'; await syncContent(f.args);
  assert.equal(f.args.b.body, 'B independent notes');
  assert.ok(f.all.B[0].body.includes('edited A'));
  assert.equal(f.writes(), before + 1);
});
test('deleted source comment and shortened long body tombstone obsolete copies', async () => {
  const f = fixture(); f.args.a.body = 'x'.repeat(40000); f.all.A.push({ id: 1, user: { login: 'human' }, body: 'delete me' });
  await syncContent(f.args);
  f.all.A = f.all.A.filter(c => c.id !== 1); f.args.a.body = '';
  await syncContent(f.args);
  const obsolete = f.all.B.filter(c => c.body.includes('no longer published'));
  assert.equal(obsolete.length, 3);
});
test('incomplete API snapshots cause no write or deletion', async () => {
  const f = fixture(); await syncContent(f.args); const before = f.writes(); f.fail();
  await assert.rejects(syncContent(f.args), /Snapshot failed/);
  assert.equal(f.writes(), before);
});
