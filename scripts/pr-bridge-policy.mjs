export function mainSyncDecision({ equal, aIsAncestor }) {
  if (equal) return 'current';
  return aIsAncestor ? 'fast-forward' : 'replace-from-b';
}

export function mainSyncPush({ source, target, repo, before, accepted, replace, branch = 'main' }) {
  if (repo !== source || source === target || ![before, accepted].every(s => /^[a-f0-9]{40}$/.test(s))) {
    throw new Error('Invalid authoritative main sync');
  }
  const recovery = replace ? `refs/heads/recovery/a-${branch}-${before}` : null;
  const options = ['--atomic', `--force-with-lease=refs/heads/${branch}:${before}`];
  const refs = [`${accepted}:refs/heads/${branch}`];
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
  if (!['push', 'pull_request_target', 'issue_comment', 'pull_request_review', 'pull_request_review_comment'].includes(kind)) {
    throw new Error('Invalid notification event');
  }
  if (kind === 'push' ? repo !== target || Boolean(pr) : !/^[1-9][0-9]*$/.test(pr ?? '')) {
    throw new Error('Invalid notification PR scope');
  }
  return { repository: repo, sha, event: kind, pr: pr || null, run: `https://github.com/${repo}/actions/runs/${runId}` };
}

export function pairDecision({ merged, closed, sourceClosed, headIncluded, mergeResultIncluded, sourceHead, mergedHead, sourceIncludedInBHead }) {
  if (merged) {
    if (!mergeResultIncluded) return 'merge-result-not-in-branch';
    // Identity requires the original commits in main, not just equivalent changes.
    const exactRevision = /^[a-f0-9]{40}$/.test(sourceHead ?? '') && sourceHead === mergedHead;
    if (headIncluded) return 'accepted';
    return exactRevision || sourceIncludedInBHead ? 'identity-not-preserved' : 'new-commits-pending';
  }
  if (closed) return 'rejected';
  if (sourceClosed) return 'source-closed';
  return 'pending';
}

export function assertMutation({ repo, source, target, path, method, body, branch = 'main' }) {
  if (![source, target].includes(repo)) throw new Error('Repository outside bridge scope');
  if (method === 'GET') return;
  const createPR = repo === target && method === 'POST' && path === '/pulls'
    && body.base === branch && /^incoming\/a-pr-[1-9][0-9]*$/.test(body.head);
  const editPR = repo === source && method === 'PATCH' && /^\/pulls\/[1-9][0-9]*$/.test(path)
    && Object.keys(body).length === 1 && body.state === 'closed';
  const editDescription = repo === target && method === 'PATCH' && /^\/pulls\/[1-9][0-9]*$/.test(path)
    && Object.keys(body).length === 1 && typeof body.body === 'string'
    && body.body.includes(`\n\n<!-- b-authoritative-bridge:${source}#`);
  const comment = ((method === 'POST' && /^\/issues\/[1-9][0-9]*\/comments$/.test(path))
    || (method === 'PATCH' && /^\/issues\/comments\/[1-9][0-9]*$/.test(path)))
    && Object.keys(body).every(key => key === 'body')
    && (repo === source || (typeof body.body === 'string' && (
      body.body.startsWith(`<!-- bridge-content:${source}#`)
      || body.body.startsWith(`<!-- bridge-conversation:${source}#`)
      || body.body.startsWith(`<!-- bridge-source-status:${source}#`))));
  if (!createPR && !editPR && !editDescription && !comment) throw new Error('Mutation outside bridge policy');
}

export function assertPush({ repo, source, target, ref, branch = 'main' }) {
  if (repo === source && ref === `refs/heads/${branch}`) return;
  if (repo === source && ref.startsWith(`refs/heads/recovery/a-${branch}-`) && /^[a-f0-9]{40}$/.test(ref.slice(`refs/heads/recovery/a-${branch}-`.length))) return;
  if (repo === target && /^refs\/heads\/incoming\/a-pr-[1-9][0-9]*$/.test(ref)) return;
  throw new Error('Push outside bridge policy');
}
