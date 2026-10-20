export function mainSyncDecision({ equal, aIsAncestor }) {
  if (equal) return 'current';
  return aIsAncestor ? 'fast-forward' : 'replace-from-b';
}

export function mainSyncPush({ source, target, repo, before, accepted, replace }) {
  if (repo !== source || source === target || ![before, accepted].every(s => /^[a-f0-9]{40}$/.test(s))) {
    throw new Error('Invalid authoritative main sync');
  }
  const recovery = replace ? `refs/heads/recovery/a-main-${before}` : null;
  const options = ['--atomic', `--force-with-lease=refs/heads/main:${before}`];
  const refs = [`${accepted}:refs/heads/main`];
  if (recovery) {
    options.push(`--force-with-lease=${recovery}:`);
    refs.unshift(`${before}:${recovery}`);
  }
  return { recovery, options, refs };
}

export function notificationMetadata({ source, target, repo, sha, runId, event, pr }) {
  if (![repo, sha, runId, event, pr].some(Boolean)) return null;
  if (![source, target].includes(repo) || !/^[a-f0-9]{40}$/.test(sha ?? '') || !/^[1-9][0-9]*$/.test(runId ?? '')) {
    throw new Error('Invalid notification metadata');
  }
  // Accept existing B/main notifications while the notifier is being upgraded.
  const kind = event || (repo === target ? 'push' : '');
  if (!['push', 'pull_request_target', 'issue_comment', 'pull_request_review', 'pull_request_review_comment'].includes(kind)) {
    throw new Error('Invalid notification event');
  }
  if (kind === 'push' ? repo !== target || Boolean(pr) : !/^[1-9][0-9]*$/.test(pr ?? '')) {
    throw new Error('Invalid notification PR scope');
  }
  return { repository: repo, sha, event: kind, pr: pr || null, run: `https://github.com/${repo}/actions/runs/${runId}` };
}

export function pairDecision({ merged, closed, sourceClosed, headIncluded, mergeResultIncluded, sourceHead, mergedHead }) {
  if (merged) {
    if (!mergeResultIncluded) return 'merge-result-not-in-main';
    // Identity requires the original commits in main, not just equivalent changes.
    const exactRevision = /^[a-f0-9]{40}$/.test(sourceHead ?? '') && sourceHead === mergedHead;
    if (headIncluded) return 'accepted';
    return exactRevision ? 'identity-not-preserved' : 'new-commits-pending';
  }
  if (closed) return 'rejected';
  if (sourceClosed) return 'withdrawn';
  return 'pending';
}

export function assertMutation({ repo, source, target, path, method, body }) {
  if (![source, target].includes(repo)) throw new Error('Repository outside bridge scope');
  if (method === 'GET') return;
  const createPR = repo === target && method === 'POST' && path === '/pulls'
    && body.base === 'main' && /^incoming\/a-pr-[1-9][0-9]*$/.test(body.head);
  const editPR = method === 'PATCH' && /^\/pulls\/[1-9][0-9]*$/.test(path)
    && Object.keys(body).every(key => ['title', 'body', 'state'].includes(key))
    && (!body.state || body.state === 'closed');
  const comment = ((method === 'POST' && /^\/issues\/[1-9][0-9]*\/comments$/.test(path))
    || (method === 'PATCH' && /^\/issues\/comments\/[1-9][0-9]*$/.test(path)))
    && Object.keys(body).every(key => key === 'body')
    && (repo === source || (typeof body.body === 'string' && body.body.startsWith(`<!-- bridge-conversation:${source}#`)));
  if (!createPR && !editPR && !comment) throw new Error('Mutation outside bridge policy');
}

export function assertPush({ repo, source, target, ref }) {
  if (repo === source && ref === 'refs/heads/main') return;
  if (repo === source && /^refs\/heads\/recovery\/a-main-[a-f0-9]{40}$/.test(ref)) return;
  if (repo === target && /^refs\/heads\/incoming\/a-pr-[1-9][0-9]*$/.test(ref)) return;
  throw new Error('Push outside bridge policy');
}
