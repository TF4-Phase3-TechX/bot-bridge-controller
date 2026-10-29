import test from 'node:test';
import assert from 'node:assert/strict';
import { descriptionParts, syncDescription } from '../scripts/pr-description.mjs';
import { assertMutation } from '../scripts/pr-bridge-policy.mjs';

const a = { number: 12, user: { login: 'alice' }, body: '# Summary\n\n- [x] Done\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nlet a = 1;\n```' };
test('source Markdown is unchanged at the top; identity and merge guidance are at the bottom', () => {
  const { body } = descriptionParts('A/repo', a);
  assert.ok(body.startsWith(a.body + '\n\n'));
  assert.ok(body.indexOf('Original author') > a.body.length);
  assert.match(body, /Create a merge commit/);
  assert.equal(descriptionParts('A/repo', a, body).body, body);
});
test('source edits preserve TechX notes, including Unicode and original formatting', () => {
  const notes = '\n\n## TechX acceptance\n- [ ] check release\nTiếng Việt';
  const previous = descriptionParts('A/repo', a).body + notes;
  const edited = { ...a, body: '## Revised source\n\nNew details' };
  const next = descriptionParts('A/repo', edited, previous);
  assert.ok(next.body.startsWith(edited.body));
  assert.ok(next.body.endsWith(notes));
  assert.equal(descriptionParts('A/repo', edited, next.body).body, next.body);
});
test('pre-upgrade body and edits in the managed source region are retained exactly once', () => {
  const previous = descriptionParts('A/repo', a, 'Original TechX notes').body;
  const changed = previous.replace('# Summary', '# B edited this');
  const next = descriptionParts('A/repo', a, changed);
  assert.ok(next.body.endsWith(a.body.replace('# Summary', '# B edited this')));
  assert.ok(next.body.includes('Original TechX notes'));
  assert.equal(descriptionParts('A/repo', a, next.body).body, next.body);
});
test('oversized bodies and reserved source delimiters fail without truncation', () => {
  assert.throws(() => descriptionParts('A/repo', { ...a, body: 'x'.repeat(60000) }), /safe limit/);
  assert.throws(() => descriptionParts('A/repo', { ...a, body: '<!-- bridge-target-notes:A/repo#12 -->' }), /reserved/);
});
test('a concurrent body edit and a non-bot PR cannot be overwritten', async () => {
  const b = { number: 5, body: 'notes', user: { login: 'bot' }, head: { ref: 'incoming/a-pr-12', repo: { full_name: 'B/repo' } } };
  const calls = [];
  const args = { source: 'A/repo', target: 'B/repo', a, b, bot: 'bot', api: async (repo, _path, options) => {
    calls.push(options); return repo === 'A/repo' ? a : { ...b, body: 'New concurrent notes' };
  } };
  await assert.rejects(syncDescription(args), /changed during/);
  assert.ok(calls.every(x => !x));
  await assert.rejects(syncDescription({ ...args, b: { ...b, user: { login: 'human' } } }), /bot-created/);
});
test('body-only updates do not grant title, base, state, merge or source-body mutation', () => {
  const args = { repo: 'B/repo', source: 'A/repo', target: 'B/repo', path: '/pulls/5', method: 'PATCH' };
  const body = descriptionParts('A/repo', a).body;
  assert.doesNotThrow(() => assertMutation({ ...args, body: { body } }));
  for (const extra of [{ state: 'closed' }, { base: 'main' }, { title: 'changed' }]) {
    assert.throws(() => assertMutation({ ...args, body: { body, ...extra } }), /policy/);
  }
  assert.throws(() => assertMutation({ ...args, repo: 'A/repo', body: { body } }), /policy/);
});
