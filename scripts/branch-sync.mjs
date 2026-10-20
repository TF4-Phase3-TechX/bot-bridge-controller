import { createHash } from 'node:crypto';

export function validBranch(branch) {
  return typeof branch === 'string' && branch.length > 0 &&
    !/[\x00-\x20\x7f~^:?*[\\]/.test(branch) && !branch.includes('..') &&
    !branch.includes('@{') && !branch.endsWith('.') &&
    branch.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

// Only B-discovered branch names enter this planner. It cannot target B, tags,
// deletion refspecs or arbitrary event-supplied refs.
export function branchSyncPush({ source, target, repo, branch, before, accepted, replace }) {
  const sha = value => /^[a-f0-9]{40}$/.test(value ?? '');
  if (source === target || repo !== source || !validBranch(branch) || branch === 'main' ||
      !sha(accepted) || (before !== null && !sha(before)) || (replace && !before)) {
    throw new Error('Invalid B-to-A branch sync');
  }
  const ref = `refs/heads/${branch}`;
  const recovery = replace
    ? `refs/heads/recovery/b-sync-${createHash('sha256').update(branch).digest('hex')}-${before}`
    : null;
  const options = ['--atomic', `--force-with-lease=${ref}:${before ?? ''}`];
  const refs = [`${accepted}:${ref}`];
  if (recovery) {
    options.push(`--force-with-lease=${recovery}:`);
    refs.unshift(`${before}:${recovery}`);
  }
  return { options, refs, recovery };
}

// No checkout and no execution of mirrored code. Each push uses a lease and
// preserves divergent A history atomically. No branch is ever deleted.
export async function syncBranches({ source, target, sourceToken, targetToken, git, api, list, ancestor }) {
  const results = [];
  const aUrl = `https://github.com/${source}.git`, bUrl = `https://github.com/${target}.git`;
  const aPrefix = 'refs/remotes/bridge/all-a/', bPrefix = 'refs/remotes/bridge/all-b/';
  const readHeads = prefix => {
    const lines = git(['for-each-ref', '--format=%(objectname) %(refname)', prefix]).text;
    return new Map(lines ? lines.split('\n').map(line => {
      const [sha, ref] = line.trim().split(' ');
      const branch = ref?.slice(prefix.length);
      if (!ref?.startsWith(prefix) || !validBranch(branch) || !/^[a-f0-9]{40}$/.test(sha)) {
        throw new Error('Invalid branch snapshot');
      }
      return [branch, sha];
    }) : []);
  };
  try {
    // Prune only isolated local tracking refs; never prune remote A branches.
    git(['fetch', '--no-tags', '--prune', aUrl, `+refs/heads/*:${aPrefix}*`], sourceToken);
    git(['fetch', '--no-tags', '--prune', bUrl, `+refs/heads/*:${bPrefix}*`], targetToken);
    const aHeads = readHeads(aPrefix), bHeads = readHeads(bPrefix);
    // Do not overwrite any ref serving as a recovery destination in this run.
    const recoveryRefs = new Set();
    for (const [branch, accepted] of bHeads) {
      const before = aHeads.get(branch);
      if (branch !== 'main' && before && before !== accepted && !ancestor(before, accepted)) {
        recoveryRefs.add(branchSyncPush({ source, target, repo: source, branch, before, accepted, replace: true }).recovery);
      }
    }
    for (const [branch, accepted] of bHeads) {
      if (branch === 'main') continue; // existing authoritative-main path
      const before = aHeads.get(branch) ?? null;
      const entry = { branch, before, target: accepted };
      results.push(entry);
      try {
        if (before === accepted) { entry.state = 'current'; continue; }
        if (recoveryRefs.has(`refs/heads/${branch}`)) throw new Error('B branch collides with a recovery destination');
        // Refresh PR ownership just before updating; open A contributions win.
        const prs = await list(source, `/pulls?state=open&head=${encodeURIComponent(source.split('/')[0] + ':' + branch)}`);
        if (prs.some(pr => pr.head.repo?.full_name === source && pr.head.ref === branch)) {
          entry.state = 'deferred-open-pr';
          continue;
        }
        const path = `/git/ref/heads/${encodeURIComponent(branch)}`;
        if ((await api(target, path)).object.sha !== accepted) throw new Error('B branch changed during fetch; retry');
        const replace = before !== null && !ancestor(before, accepted);
        const plan = branchSyncPush({ source, target, repo: source, branch, before, accepted, replace });
        git(['push', ...plan.options, aUrl, ...plan.refs], sourceToken);
        if ((await api(source, path)).object.sha !== accepted) throw new Error('A branch changed after sync; retry');
        entry.state = before === null ? 'created' : replace ? 'replaced-with-recovery' : 'fast-forward';
        entry.recovery = plan.recovery;
      } catch (error) {
        entry.state = 'error'; entry.error = error.message;
      }
    }
    for (const [branch, before] of aHeads) {
      if (!bHeads.has(branch)) results.push({ branch, before, state: 'preserved-a-only' });
    }
  } catch (error) {
    results.push({ state: 'error', error: error.message });
  }
  return results;
}
