export function mainSyncDecision({ equal, aIsAncestor }) {
  if (equal) return 'current';
  return aIsAncestor ? 'fast-forward' : 'stop';
}

export function pairDecision({ merged, closed, sourceClosed, headIncluded }) {
  if (merged) return headIncluded ? 'accepted' : 'new-commits-pending';
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
  if (repo === target && /^refs\/heads\/incoming\/a-pr-[1-9][0-9]*$/.test(ref)) return;
  throw new Error('Push outside bridge policy');
}
