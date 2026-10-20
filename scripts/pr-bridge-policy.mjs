export function mainSyncDecision({ equal, aIsAncestor }) {
  if (equal) return 'current';
  return aIsAncestor ? 'fast-forward' : 'replace-from-b';
}

export function mainSyncPush({ source, target, repo, before, accepted, replace, sourceBranch = 'main' }) {
  if (!['main', 'dev'].includes(sourceBranch)) throw new Error('Invalid source branch');
  if (repo !== source || source === target || ![before, accepted].every(s => /^[a-f0-9]{40}$/.test(s))) {
    throw new Error('Invalid authoritative main sync');
  }
  const recovery = replace ? `refs/heads/recovery/a-${sourceBranch}-${before}` : null;
  const options = ['--atomic', `--force-with-lease=refs/heads/${sourceBranch}:${before}`];
  const refs = [`${accepted}:refs/heads/${sourceBranch}`];
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
  const kind = event;
  if (!['workflow_dispatch', 'push', 'pull_request_target', 'issue_comment', 'pull_request_review', 'pull_request_review_comment'].includes(kind)) {
    throw new Error('Invalid notification event');
  }
  if (kind === 'push' ? repo !== target || Boolean(pr) : !/^[1-9][0-9]*$/.test(pr ?? '')) {
    throw new Error('Invalid notification PR scope');
  }
  if (kind === 'workflow_dispatch' && repo !== source) throw new Error('Manual submission must originate at A');
  return { repository: repo, sha, event: kind, pr: pr || null, runId, run: `https://github.com/${repo}/actions/runs/${runId}` };
}

export function pairDecision({ merged, closed, sourceClosed, headIncluded, mergeResultIncluded, sourceHead, mergedHead, sourceIncludedInBHead }) {
  if (merged) {
    if (!mergeResultIncluded) return 'merge-result-not-in-main';
    // Identity requires the original commits in main, not just equivalent changes.
    const exactRevision = /^[a-f0-9]{40}$/.test(sourceHead ?? '') && sourceHead === mergedHead;
    if (headIncluded) return 'accepted';
    return exactRevision || sourceIncludedInBHead ? 'identity-not-preserved' : 'new-commits-pending';
  }
  if (closed) return 'rejected';
  if (sourceClosed) return 'source-closed';
  return 'pending';
}

export function assertMutation({ repo, source, target, path, method, body, targetBranch = 'main' }) {
  if (![source, target].includes(repo)) throw new Error('Repository outside bridge scope');
  if (method === 'GET') return;
  const createPR = repo === target && method === 'POST' && path === '/pulls'
    && body.base === targetBranch && ['main', 'dev'].includes(targetBranch) && /^incoming\/a-pr-[1-9][0-9]*$/.test(body.head);
  const editPR = repo === source && method === 'PATCH' && /^\/pulls\/[1-9][0-9]*$/.test(path)
    && Object.keys(body).length === 1 && body.state === 'closed';
  const comment = ((method === 'POST' && /^\/issues\/[1-9][0-9]*\/comments$/.test(path))
    || (method === 'PATCH' && /^\/issues\/comments\/[1-9][0-9]*$/.test(path)))
    && Object.keys(body).every(key => key === 'body')
    && (repo === source || (typeof body.body === 'string' && (
      body.body.startsWith(`<!-- bridge-conversation:${source}#`)
      || body.body.startsWith(`<!-- bridge-source-status:${source}#`))));
  if (!createPR && !editPR && !comment) throw new Error('Mutation outside bridge policy');
}

export function assertPush({ repo, source, target, ref, sourceBranch = 'main' }) {
  if (!['main', 'dev'].includes(sourceBranch)) throw new Error('Invalid source branch');
  if (repo === source && ref === `refs/heads/${sourceBranch}`) return;
  if (repo === source && new RegExp(`^refs/heads/recovery/a-${sourceBranch}-[a-f0-9]{40}$`).test(ref)) return;
  if (repo === target && /^refs\/heads\/incoming\/a-pr-[1-9][0-9]*$/.test(ref)) return;
  throw new Error('Push outside bridge policy');
}
