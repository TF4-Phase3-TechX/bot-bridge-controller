import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationCopies } from '../scripts/pr-bridge-comments.mjs';
const comment = { id: 1, user: { type: 'User', login: 'dev' }, author_association: 'MEMBER', body: 'Addressed finding at abc123.', html_url: 'https://github.com/org/repo/pull/1#issuecomment-1', created_at: '2026-10-20', updated_at: '2026-10-20' };
const args = { originRepo: 'org/repo', originPr: 1, originSide: 'A', comments: [comment], existing: [], destinationBot: 'bridge[bot]' };
test('copies human conversation with identity, provenance and literal content', () => {
  const [copy] = conversationCopies(args);
  assert.match(copy.body, /A comment by dev/);
  assert.match(copy.body, /```text\nAddressed finding/);
  assert.match(copy.body, /merge authority remain at B/);
});
test('ignores bots and outside collaborators without an allowed association', () => {
  assert.deepEqual(conversationCopies({ ...args, comments: [
    { ...comment, user: { type: 'Bot', login: 'bridge[bot]' } },
    { ...comment, author_association: 'NONE' },
  ] }), []);
});
test('idempotent and edits only a copy authored by the expected bot', () => {
  const [copy] = conversationCopies(args);
  const existing = [{ id: 2, user: { login: 'bridge[bot]' }, body: copy.body }];
  assert.deepEqual(conversationCopies({ ...args, existing }), []);
  const [edit] = conversationCopies({ ...args, existing, comments: [{ ...comment, body: 'Updated finding.' }] });
  assert.equal(edit.id, 2);
  assert.equal(conversationCopies({ ...args, existing: [{ ...existing[0], user: { login: 'someone' } }] })[0].id, undefined);
});
test('does not activate markdown commands and fails explicitly on oversized comments', () => {
  const [copy] = conversationCopies({ ...args, comments: [{ ...comment, body: '```\n![image](https://example.com)\n@everyone /merge' }] });
  assert.match(copy.body, /````text\n```/);
  assert.throws(() => conversationCopies({ ...args, comments: [{ ...comment, body: 'x'.repeat(60000) }] }), /too large/);
});
