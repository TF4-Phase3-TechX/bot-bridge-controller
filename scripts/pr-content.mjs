import { createHash } from 'node:crypto';
import { textBlock } from './pr-bridge-reviews.mjs';
import { syncDescription } from './pr-description.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
const prefix = (repo, pr) => `<!-- bridge-content:${repo}#${pr}:`;
const choose = (obj, keys) => Object.fromEntries(keys.filter(k => obj[k] !== undefined).map(k => [k, obj[k]]));

// Keep ordinary GitHub Markdown; provenance and structured metadata live below it.
export function contentParts(repo, pr, kind, id, metadata, text) {
  const chunk = (value, limit) => {
    const parts = []; let part = '';
    for (const point of value) {
      if (part.length + point.length > limit) { parts.push(part); part = ''; }
      part += point;
    }
    if (part) parts.push(part);
    return parts;
  };
  // Leave room for the metadata fence even if metadata itself contains long
  // backtick runs (e.g. an inline review's diff hunk).
  const texts = chunk(String(text ?? ''), 45000), details = chunk(JSON.stringify(metadata, null, 2), 3000);
  const count = Math.max(1, texts.length, details.length);
  return Array.from({ length: count }, (_, i) => {
    const marker = `${prefix(repo, pr)}${kind}:${id}:${i + 1} -->`;
    const url = metadata.html_url || metadata.url || `https://github.com/${repo}/pull/${pr}`;
    const body = `${marker}\n${texts[i] ?? ''}\n\n---\nCopied from [${repo}#${pr} · ${kind} ${id}](${url}). Author: **${metadata.author ?? 'not supplied'}**.${metadata.state ? ` State: **${metadata.state}**.` : ''}\n\n<details>\n<summary>Sync details · part ${i + 1}/${count}</summary>\n\n${textBlock(details[i] ?? '')}\n\n</details>`;
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
  const notes = await syncDescription({ source, target, a, b, bot, api });
  // A's description now lives directly in B's PR body. Only B's own notes go back
  // as a comment, so the generated description and footer cannot echo to A.
  snapshots[0].objects = snapshots[0].objects.filter(o => o.kind !== 'body');
  snapshots[1].objects = snapshots[1].objects.filter(o => o.kind !== 'body');
  if (notes.replace(/<!--[^]*?-->/g, '').replace('### TechX maintainer notes', '').trim()) {
    snapshots[1].objects.push({ kind: 'body', id: b.number, metadata: { url: b.html_url, section: 'TechX maintainer notes' }, text: notes });
  }
  for (const [from, to, destinationBot] of [[snapshots[0], snapshots[1], bot], [snapshots[1], snapshots[0], sourceBot]]) {
    const wanted = from.objects.flatMap(o => contentParts(from.repo, from.pr.number, o.kind, o.id, o.metadata, o.text));
    const existing = to.comments.filter(c => c.user?.login === destinationBot && c.body?.startsWith(prefix(from.repo, from.pr.number)));
    const expected = new Set(wanted.map(p => p.marker));
    for (const old of existing) {
      const marker = old.body.split('\n')[0];
      if (!expected.has(marker) && !wanted.some(p => p.marker === marker)) wanted.push({ marker, body: `${marker}\nSource object is no longer published, or this part has been superseded. Reconciled from a complete source snapshot.` });
    }
    for (const part of wanted) {
      const matches = existing.filter(c => c.body.split('\n')[0] === part.marker);
      const old = matches.sort((x, y) => y.id - x.id)[0];
      if (old?.body === part.body) continue;
      if (old) {
        const fresh = await api(to.repo, `/issues/comments/${old.id}`);
        if (fresh.body !== old.body || fresh.user?.login !== destinationBot) throw new Error('Mirror changed concurrently; retry');
      }
      const saved = await api(to.repo, `/issues/${to.pr.number}/comments`, {
        method: 'POST', body: { body: part.body },
      });
      const verified = await api(to.repo, `/issues/comments/${saved.id}`);
      if (verified.body !== part.body || verified.user?.login !== destinationBot) throw new Error('Content read-back mismatch');
    }
  }
  return snapshots[1].reviews;
}
