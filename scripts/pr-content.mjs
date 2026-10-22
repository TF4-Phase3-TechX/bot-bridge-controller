import { createHash } from 'node:crypto';
import { textBlock } from './pr-bridge-reviews.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
const prefix = (repo, pr) => `<!-- bridge-content:${repo}#${pr}:`;
const choose = (obj, keys) => Object.fromEntries(keys.filter(k => obj[k] !== undefined).map(k => [k, obj[k]]));

// Render all content literally. Chunk before fencing, including pathological backticks.
export function contentParts(repo, pr, kind, id, metadata, text) {
  const payload = JSON.stringify(metadata, null, 2) + '\n\n' + String(text ?? '');
  const points = Array.from(payload), parts = [];
  for (let offset = 0; offset < points.length; offset += 15000) parts.push(points.slice(offset, offset + 15000).join(''));
  return parts.map((part, i) => {
    const marker = `${prefix(repo, pr)}${kind}:${id}:${i + 1} -->`;
    const body = `${marker}\nSource: ${repo} PR #${pr} / ${kind} ${id}\nPart ${i + 1}/${parts.length} · SHA256 ${digest(payload)}\n\n${textBlock(part)}`;
    if (body.length > 60000) throw new Error('Mirror part exceeds safe limit');
    return { marker, body };
  });
}

export function snapshotObjects(pr, comments, reviews, inline, threads, originBot) {
  const submitted = reviews.filter(r => r.submitted_at && r.state !== 'PENDING');
  const publishedIds = new Set(submitted.map(r => r.id));
  const humanOrOtherBot = c => c.user?.login !== originBot;
  const metadata = item => ({
    ...choose(item, ['id', 'html_url', 'state', 'commit_id', 'created_at', 'updated_at', 'submitted_at',
      'path', 'line', 'start_line', 'original_line', 'original_start_line', 'side', 'start_side',
      'original_commit_id', 'diff_hunk', 'in_reply_to_id', 'pull_request_review_id', 'subject_type']),
    author: item.user?.login ?? null,
  });
  // PR updated_at changes when the bridge posts comments: omit it to prevent echo churn.
  const objects = [{ kind: 'body', id: pr.number, metadata: {
    url: pr.html_url, author: pr.user?.login ?? null, title: pr.title,
    base: pr.base.ref, head: pr.head.sha, content_sha256: digest(pr.body ?? ''),
  }, text: pr.body ?? '' }];
  for (const c of comments.filter(humanOrOtherBot)) objects.push({ kind: 'comment', id: c.id, metadata: metadata(c), text: c.body });
  for (const r of submitted.filter(humanOrOtherBot)) objects.push({ kind: 'review', id: r.id, metadata: metadata(r), text: r.body });
  for (const c of inline.filter(c => publishedIds.has(c.pull_request_review_id)).filter(humanOrOtherBot)) {
    objects.push({ kind: 'inline', id: c.id, metadata: metadata(c), text: c.body });
  }
  for (const t of threads) objects.push({ kind: 'thread', id: t.id, metadata: t, text: '' });
  return objects;
}

export async function readThreads(graphql, repo, number) {
  const [owner, name] = repo.split('/');
  const objects = []; let after = null;
  do {
    const data = await graphql(repo, `query($owner:String!,$name:String!,$number:Int!,$after:String){
      repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){
        nodes{id isResolved isOutdated path line startLine originalLine originalStartLine diffSide startDiffSide
          resolvedBy{login} comments(first:100){nodes{id databaseId replyTo{id databaseId}} pageInfo{hasNextPage endCursor}}}
        pageInfo{hasNextPage endCursor}
      }}}}`, { owner, name, number, after });
    const page = data.repository?.pullRequest?.reviewThreads;
    if (!page) throw new Error('Missing review thread snapshot');
    for (const thread of page.nodes) {
      const ids = [...thread.comments.nodes]; let info = thread.comments.pageInfo;
      while (info.hasNextPage) {
        const next = await graphql(repo, `query($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{
          comments(first:100,after:$after){nodes{id databaseId replyTo{id databaseId}} pageInfo{hasNextPage endCursor}}
        }}}`, { id: thread.id, after: info.endCursor });
        const comments = next.node?.comments;
        if (!comments) throw new Error('Missing thread comment page');
        ids.push(...comments.nodes); info = comments.pageInfo;
      }
      objects.push({ ...thread, comments: ids });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return objects;
}

export async function syncContent({ source, target, a, b, sourceBot, bot, api, list, graphql }) {
  // Complete BOTH snapshots before mutations, so bot copies cannot echo back.
  const snapshots = [];
  for (const [repo, pr, originBot] of [[source, a, sourceBot], [target, b, bot]]) {
    const comments = await list(repo, `/issues/${pr.number}/comments`);
    const reviews = await list(repo, `/pulls/${pr.number}/reviews`);
    const inline = await list(repo, `/pulls/${pr.number}/comments`);
    const threads = await readThreads(graphql, repo, pr.number);
    snapshots.push({ repo, pr, comments, reviews, objects: snapshotObjects(pr, comments, reviews, inline, threads, originBot) });
  }
  for (const [from, to, destinationBot] of [[snapshots[0], snapshots[1], bot], [snapshots[1], snapshots[0], sourceBot]]) {
    const wanted = from.objects.flatMap(o => contentParts(from.repo, from.pr.number, o.kind, o.id, o.metadata, o.text));
    const existing = to.comments.filter(c => c.user?.login === destinationBot && c.body?.startsWith(prefix(from.repo, from.pr.number)));
    const expected = new Set(wanted.map(p => p.marker));
    for (const old of existing) {
      const marker = old.body.split('\n')[0];
      if (!expected.has(marker)) wanted.push({ marker, body: `${marker}\nSource object is no longer published, or this part has been superseded. Reconciled from a complete source snapshot.` });
    }
    for (const part of wanted) {
      const matches = existing.filter(c => c.body.split('\n')[0] === part.marker);
      if (matches.length > 1) throw new Error('Duplicate content mapping; inspect before retry');
      const old = matches[0];
      if (old?.body === part.body) continue;
      if (old) {
        const fresh = await api(to.repo, `/issues/comments/${old.id}`);
        if (fresh.body !== old.body || fresh.user?.login !== destinationBot) throw new Error('Mirror changed concurrently; retry');
      }
      const saved = await api(to.repo, old ? `/issues/comments/${old.id}` : `/issues/${to.pr.number}/comments`, {
        method: old ? 'PATCH' : 'POST', body: { body: part.body },
      });
      const verified = await api(to.repo, `/issues/comments/${saved.id}`);
      if (verified.body !== part.body || verified.user?.login !== destinationBot) throw new Error('Content read-back mismatch');
    }
  }
  return snapshots[1].reviews;
}
