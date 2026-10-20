// Render review content as inert text: no images, HTML, mentions or commands execute.
export function textBlock(value) {
  const text = String(value ?? '');
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(m => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}
export function reviewFeedback(review, comments, targetPr) {
  const rows = [
    `### B review #${review.id} — ${review.state}`,
    `Reviewer: **${review.user.login}** · B PR **#${targetPr}**`,
    `Reviewed commit: \`${review.commit_id}\``,
    'This is review feedback copied from B. Make corrections on the A feature branch; B decides whether to accept them.',
    '**Review message**',
    textBlock(review.body || '(No overall message; see line comments below.)'),
  ];
  for (const comment of comments.filter(c => c.pull_request_review_id === review.id)) {
    const outdated = comment.line == null && comment.original_line != null;
    rows.push(`**Line comment #${comment.id} by ${comment.user.login}**`,
      textBlock(`File: ${comment.path}\nLine: ${comment.line ?? comment.original_line ?? 'file-level'}${outdated ? ' (original location; outdated)' : ''}\nSide: ${comment.side ?? 'not specified'}\nComment commit: ${comment.commit_id ?? review.commit_id}`),
      textBlock(comment.body));
    if (comment.diff_hunk) rows.push('Context at review time:', textBlock(comment.diff_hunk));
  }
  const body = rows.join('\n\n');
  // Stop explicitly rather than silently dropping feedback when GitHub's comment limit is approached.
  if (body.length > 60000) throw new Error(`B review #${review.id} is too large for one mirrored comment; maintainer must split the feedback`);
  return body;
}

export function reviewSummary(reviews) {
  const latest = new Map();
  for (const review of reviews) {
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) {
      latest.set(review.user.login, `${review.user.login}: ${review.state} (${review.commit_id.slice(0, 7)})`);
    }
  }
  return [...latest.values()].join('; ') || 'none yet';
}
