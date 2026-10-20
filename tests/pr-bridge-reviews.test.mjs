import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewFeedback, reviewSummary, textBlock } from '../scripts/pr-bridge-reviews.mjs';

const review = { id: 42, user: { login: 'maintainer' }, state: 'CHANGES_REQUESTED', commit_id: 'a'.repeat(40), body: 'Add the missing validation.' };
const inline = { id: 9, pull_request_review_id: 42, user: { login: 'maintainer' }, path: 'src/app.js', line: 12, side: 'RIGHT', body: 'Reject empty input.', diff_hunk: '@@ -1 +1 @@\n+input', commit_id: review.commit_id };
test('A receives review body, exact file, line, source SHA and inline text', () => {
  const output = reviewFeedback(review, [inline], 14);
  for (const text of ['CHANGES_REQUESTED', review.body, inline.path, 'Line: 12', review.commit_id, inline.body, inline.diff_hunk]) assert.ok(output.includes(text));
});
test('only comments from this review are copied and outdated locations are explicit', () => {
  const output = reviewFeedback(review, [{ ...inline, line: null, original_line: 12 }, { ...inline, pull_request_review_id: 999, body: 'OTHER REVIEW' }], 14);
  assert.match(output, /original location; outdated/);
  assert.ok(!output.includes('OTHER REVIEW'));
});
test('review text cannot break out of its literal block', () => {
  const output = textBlock('```\n![external](https://example.com/tracker)\n<script>bad</script>\n@someone');
  assert.ok(output.startsWith('````text\n'));
  assert.ok(output.endsWith('\n````'));
});
test('comment-only review does not erase a prior changes-requested decision', () => {
  assert.match(reviewSummary([review, { ...review, state: 'COMMENTED' }]), /CHANGES_REQUESTED/);
  assert.match(reviewSummary([review, { ...review, state: 'APPROVED', commit_id: 'b'.repeat(40) }]), /APPROVED \(bbbbbbb\)/);
});
test('oversized review fails explicitly instead of hiding missing feedback', () => {
  assert.throws(() => reviewFeedback({ ...review, body: 'x'.repeat(60000) }, [], 14), /too large/);
});
test('long code and suggestion lines remain byte-for-byte inside the literal block', () => {
  const body = '```suggestion\nconst message = "' + 'alpha beta gamma '.repeat(10) + '";\n```';
  assert.ok(reviewFeedback({ ...review, body }, [], 14).includes(body));
});
