import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainSyncDecision, mainSyncPush, pairDecision, assertMutation, assertPush, notificationMetadata } from './pr-bridge-policy.mjs';
import { reviewFeedback, reviewSummary } from './pr-bridge-reviews.mjs';
import { conversationCopies } from './pr-bridge-comments.mjs';
import { loadConfig, pairConfig } from './bridge-config.mjs';
import { syncBranches } from './branch-sync.mjs';

export async function runBridge({
  config,
  env = process.env, fetchImpl = fetch, spawnImpl = spawnSync, now = Date.now(),
} = {}) {
const { source, target, bot, sourceBot, controllerRepo } = config;
const sourceToken = env.SOURCE_TOKEN;
const targetToken = env.BRIDGE_APP_TOKEN;
const report = { source, target, controller: controllerRepo, pairs: [], run: `https://github.com/${controllerRepo}/actions/runs/${env.GITHUB_RUN_ID}` };
const shaPattern = /^[a-f0-9]{40}$/;
function requireSha(value) {
  if (!shaPattern.test(value)) throw new Error('Invalid commit SHA');
  return value;
}
function git(args, token, allowed = [0]) {
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(gitEnv)) {
    if (/TOKEN|PRIVATE_KEY|^GIT_TRACE|^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete gitEnv[key];
  }
  if (token) {
    gitEnv.GIT_CONFIG_COUNT = '2';
    gitEnv.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'; gitEnv.GIT_CONFIG_VALUE_0 = '';
    gitEnv.GIT_CONFIG_KEY_1 = 'http.https://github.com/.extraheader';
    gitEnv.GIT_CONFIG_VALUE_1 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  const result = spawnImpl('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', ...args], { env: gitEnv, encoding: 'utf8' });
  if (!allowed.includes(result.status)) throw new Error(`Git ${args[0]} failed (exit ${result.status}); inspect permissions, branch rules and concurrent ref changes`);
  return { text: result.stdout.trim(), status: result.status };
}
const ancestor = (a, b) => git(['merge-base', '--is-ancestor', requireSha(a), requireSha(b)], null, [0, 1]).status === 0;
async function api(repo, path, { method = 'GET', body } = {}) {
  assertMutation({ repo, source, target, path, method, body });
  const token = repo === source ? sourceToken : targetToken;
  const response = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${repo}${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function list(repo, path) {
  const values = [];
  for (let page = 1; ; page++) {
    const batch = await api(repo, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    values.push(...batch);
    if (batch.length < 100) return values;
  }
}
async function statusComment(pr, content, repo = source, aPr = pr) {
  const marker = repo === source ? '<!-- b-authoritative-bridge-status -->' : `<!-- bridge-source-status:${source}#${aPr} -->`;
  const body = `${marker}\n${content}`;
  const comments = await list(repo, `/issues/${pr}/comments`);
  const old = comments.find(x => x.user.login === (repo === source ? sourceBot : bot) && x.body.startsWith(marker));
  if (old?.body === body) return;
  await api(repo, old ? `/issues/comments/${old.id}` : `/issues/${pr}/comments`, { method: old ? 'PATCH' : 'POST', body: { body } });
}
async function syncReviewFeedback(aPr, bPr) {
  const reviews = await list(target, `/pulls/${bPr}/reviews`);
  const inline = await list(target, `/pulls/${bPr}/comments`);
  const existing = await list(source, `/issues/${aPr}/comments`);
  for (const review of reviews) {
    if (!review.submitted_at || review.state === 'PENDING') continue;
    const marker = `<!-- bridge-review:${target}#${bPr}:${review.id} -->`;
    const body = `${marker}\n${reviewFeedback(review, inline, bPr)}`;
    const old = existing.find(c => c.user.login === sourceBot && c.body.startsWith(marker));
    if (old?.body === body) continue;
    await api(source, old ? `/issues/comments/${old.id}` : `/issues/${aPr}/comments`, {
      method: old ? 'PATCH' : 'POST', body: { body },
    });
  }
  return reviews;
}
async function syncConversation(aPr, bPr) {
  // Read both snapshots before writing; only human comments are copied, never bot echoes.
  const aComments = await list(source, `/issues/${aPr}/comments`);
  const bComments = await list(target, `/issues/${bPr}/comments`);
  for (const side of [
    { originRepo: source, originPr: aPr, originSide: 'A', comments: aComments, existing: bComments, destinationBot: bot, repo: target, pr: bPr },
    { originRepo: target, originPr: bPr, originSide: 'B', comments: bComments, existing: aComments, destinationBot: sourceBot, repo: source, pr: aPr },
  ]) {
    // author_association can be CONTRIBUTOR for an org owner when viewed by an App.
    // Check actual repository permission instead; no organization Members access is needed.
    for (const c of side.comments) {
      if (c.user?.type !== 'User') continue;
      const key = `${side.originRepo}:${c.user.login}`;
      if (!conversationPermissions.has(key)) {
        const result = await api(side.originRepo, `/collaborators/${encodeURIComponent(c.user.login)}/permission`);
        conversationPermissions.set(key, result.permission);
      }
      c.bridge_permission = conversationPermissions.get(key);
    }
    for (const copy of conversationCopies(side)) {
      await api(side.repo, copy.id ? `/issues/comments/${copy.id}` : `/issues/${side.pr}/comments`, {
        method: copy.id ? 'PATCH' : 'POST', body: { body: copy.body },
      });
    }
  }
}
const conversationPermissions = new Map();
async function relevantPulls(repo) {
  const values = new Map((await list(repo, '/pulls?state=open')).map(p => [p.number, p]));
  // Bound fallback work; older pairs remain reachable via explicit PR events.
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  for (let page = 1; ; page++) {
    const batch = await api(repo, `/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`);
    for (const p of batch) if (Date.parse(p.updated_at) >= cutoff) values.set(p.number, p);
    if (batch.length < 100 || batch.some(p => Date.parse(p.updated_at) < cutoff)) break;
  }
  return values;
}
const pairedNumber = p => p.user?.login === bot && p.head.repo?.full_name === target
  ? Number(/^incoming\/a-pr-([1-9][0-9]*)$/.exec(p.head.ref)?.[1]) : null;
async function run() {
  if (env.GITHUB_REPOSITORY !== controllerRepo || env.GITHUB_REF !== 'refs/heads/main') throw new Error('Controller must run from isolated controller main');
  report.trigger = notificationMetadata({
    source, target, repo: env.TRIGGER_SOURCE_REPO, sha: env.TRIGGER_SOURCE_SHA,
    runId: env.TRIGGER_SOURCE_RUN_ID, event: env.TRIGGER_SOURCE_EVENT, pr: env.TRIGGER_SOURCE_PR,
  });
  if (!sourceToken || !targetToken) throw new Error('Missing scoped tokens');
  for (const [token, expected] of [[sourceToken, source], [targetToken, target]]) {
    const response = await fetchImpl('https://api.github.com/installation/repositories', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('Cannot verify installation token scope');
    const scope = await response.json();
    if (scope.total_count !== 1 || scope.repositories[0]?.full_name !== expected || !scope.repositories[0]?.private) throw new Error('Token must cover exactly its private repository');
  }
  const aUrl = `https://github.com/${source}.git`, bUrl = `https://github.com/${target}.git`;
  git(['fetch', '--no-tags', aUrl, '+refs/heads/main:refs/remotes/bridge/a-main'], sourceToken);
  git(['fetch', '--no-tags', bUrl, '+refs/heads/main:refs/remotes/bridge/b-main'], targetToken);
  const aSha = git(['rev-parse', 'refs/remotes/bridge/a-main']).text;
  const bSha = git(['rev-parse', 'refs/remotes/bridge/b-main']).text;
  report.sourceBefore = aSha; report.targetMain = bSha;
  report.mainSync = mainSyncDecision({ equal: aSha === bSha, aIsAncestor: ancestor(aSha, bSha) });
  if (report.mainSync !== 'current') {
    // Dedicated App A may copy workflow files already accepted by B; never execute them here.
    // Read B again before writing; an older queued event must not dictate the target SHA.
    if ((await api(target, '/git/ref/heads/main')).object.sha !== bSha) throw new Error('B main changed during fetch; retry using its latest history');
    const plan = mainSyncPush({ source, target, repo: source, before: aSha, accepted: bSha, replace: report.mainSync === 'replace-from-b' });
    assertPush({ repo: source, source, target, ref: 'refs/heads/main' });
    if (plan.recovery) assertPush({ repo: source, source, target, ref: plan.recovery });
    // Atomic backup + update: if either ref is rejected, neither changes.
    git(['push', ...plan.options, aUrl, ...plan.refs], sourceToken);
    report.recoveryRef = plan.recovery;
  }
  report.sourceAfter = (await api(source, '/git/ref/heads/main')).object.sha;
  if (report.sourceAfter !== bSha) throw new Error('A main changed concurrently; retry after inspection');

  const prs = await relevantPulls(source);
  const targetPRs = await relevantPulls(target);
  if (report.trigger?.pr) {
    const p = await api(report.trigger.repository, `/pulls/${report.trigger.pr}`);
    (report.trigger.repository === source ? prs : targetPRs).set(p.number, p);
  }
  for (const p of targetPRs.values()) {
    const n = pairedNumber(p);
    if (n && !prs.has(n)) prs.set(n, await api(source, `/pulls/${n}`));
  }
  for (const initial of prs.values()) {
    if (initial.base.ref !== 'main' || initial.head.repo?.full_name !== source) continue;
    let a = initial, b;
    try {
    const marker = `<!-- b-authoritative-bridge:${source}#${initial.number} -->`;
    let matches = [...targetPRs.values()].filter(p => pairedNumber(p) === initial.number);
    if (!matches.length) {
      // A may still be open even when its paired B PR was closed long ago.
      matches = (await list(target, `/pulls?state=all&head=${encodeURIComponent(target.split('/')[0] + ':incoming/a-pr-' + initial.number)}`))
        .filter(p => pairedNumber(p) === initial.number);
    }
    if (matches.length > 1) throw new Error(`Multiple B PRs mapped to A#${initial.number}`);
    b = matches[0];
    if (!b && initial.state !== 'open') continue;
    a = await api(source, `/pulls/${initial.number}`);
    if (a.draft && !b) continue;
    if (b) b = await api(target, `/pulls/${b.number}`);
    if (b && (b.base.ref !== 'main' || b.head.ref !== `incoming/a-pr-${a.number}` || b.head.repo?.full_name !== target)) throw new Error('PR pair refs no longer match bridge policy');
    let reviews = b ? await syncReviewFeedback(a.number, b.number) : [];
    if (b) await syncConversation(a.number, b.number);
    const aHead = requireSha(a.head.sha);
    git(['fetch', '--no-tags', aUrl, `refs/pull/${a.number}/head`], sourceToken);
    const fetched = git(['rev-parse', 'FETCH_HEAD']).text;
    if (fetched !== aHead) { report.pairs.push({ a: a.number, state: 'source-changed-retry' }); continue; }
    const included = ancestor(aHead, bSha);
    if (b) {
      git(['fetch', '--no-tags', bUrl, `refs/pull/${b.number}/head`], targetToken);
      if (git(['rev-parse', 'FETCH_HEAD']).text !== b.head.sha) {
        report.pairs.push({ a: a.number, b: b.number, state: 'target-changed-retry' }); continue;
      }
      const sourceIncludedInBHead = ancestor(aHead, b.head.sha);
      // If a merge happened after our B/main snapshot, defer closure until the next run.
      const mergeResultIncluded = Boolean(b.merged_at) && shaPattern.test(b.merge_commit_sha ?? '')
        && git(['cat-file', '-e', `${b.merge_commit_sha}^{commit}`], null, [0, 1, 128]).status === 0
        && ancestor(b.merge_commit_sha, bSha);
      const decision = pairDecision({
        merged: Boolean(b.merged_at), closed: b.state === 'closed', sourceClosed: a.state === 'closed',
        headIncluded: included, mergeResultIncluded, sourceHead: aHead, mergedHead: b.head.sha, sourceIncludedInBHead,
      });
      if (decision !== 'pending') {
        const row = { a: a.number, b: b.number, state: decision, sourceHead: aHead, mergedHead: b.head.sha, mergeCommit: b.merge_commit_sha, mergeResultIncluded };
        report.pairs.push(row);
        if (decision === 'source-closed') {
          await statusComment(b.number, `A PR #${a.number} is closed${a.merged_at ? ' (merged at A outside the contribution flow)' : ''}. B still decides whether this contribution is accepted or rejected. This bot will not close or reopen this B PR. Reopen A if further contribution is needed.`, target, a.number);
        }
        const message = decision === 'accepted'
          ? `Accepted in [B PR #${b.number}](${b.html_url}).\n\nB merge result: \`${b.merge_commit_sha}\`, verified in B/main and synchronized to A/main.\n\nOriginal source head \`${aHead}\` is included in accepted history; original commit identities are preserved.\n\nNo independent merge was performed at A.`
          : decision === 'identity-not-preserved'
            ? `Identity constraint not satisfied for [B PR #${b.number}](${b.html_url}): original source head \`${aHead}\` is missing from B/main. Use Create a merge commit; squash/rebase are unsupported. A/main still follows B/main, but this contribution is not marked accepted and no open A PR is closed by this decision. Maintainer must inspect the rewritten history.`
          : decision === 'new-commits-pending'
            ? `B merged [PR #${b.number}](${b.html_url}), but current A head \`${aHead}\` contains unaccepted commits. Main is synchronized only to accepted B history. Submit the remaining changes in a new PR from current main; this PR is not marked complete.`
            : decision === 'merge-result-not-in-main'
              ? `B merged [PR #${b.number}](${b.html_url}), but its merge result \`${b.merge_commit_sha}\` is not in the B/main snapshot \`${bSha}\` synchronized by this run. This PR is not marked complete; retry against current B/main or inspect a history rewrite.`
            : decision === 'source-closed'
              ? `A PR is closed; [B PR #${b.number}](${b.html_url}) remains under B's control. No merge or closure is performed at B. Reopen A if further contribution is needed.`
              : `Bridge status: **${decision}**. [B PR #${b.number}](${b.html_url}). No unaccepted code is added to either main; this pair will not be recreated automatically.`;
        await statusComment(a.number, message);
        // Refresh immediately before closing, so a newer source head is not silently discarded.
        a = await api(source, `/pulls/${a.number}`);
        if (a.state === 'open' && a.head.sha === aHead && ['accepted', 'rejected'].includes(decision)) {
          await api(source, `/pulls/${a.number}`, { method: 'PATCH', body: { state: 'closed' } });
        }
        continue;
      }
      if (!sourceIncludedInBHead && !ancestor(b.head.sha, aHead)) {
        await statusComment(a.number, `Blocked: incoming branch on [B PR #${b.number}](${b.html_url}) diverged from A head \`${aHead}\`. B changes are preserved; no force-push is performed. Coordinate with B or open a new A PR from current A/main. Other PRs continue processing.`);
        report.pairs.push({ a: a.number, b: b.number, state: 'incoming-diverged', sourceHead: aHead }); continue;
      }
    }
    if (a.state !== 'open' || a.draft) continue;
    if (included) { await statusComment(a.number, `Source head \`${aHead}\` is already in B/main. No new destination PR is needed.`); continue; }
    const baseSha = git(['merge-base', aHead, bSha]).text;
    if (git(['diff', '--name-only', baseSha, aHead, '--', '.github/workflows/']).text) {
      await statusComment(a.number, 'Blocked: contribution changes workflow files. Maintainer B must handle workflow changes separately; no branch update was sent.');
      report.pairs.push({ a: a.number, b: b?.number, state: 'blocked-workflow-change', sourceHead: aHead });
      continue;
    }
    const branch = `incoming/a-pr-${a.number}`;
    if (!b || !ancestor(aHead, b.head.sha)) {
      assertPush({ repo: target, source, target, ref: `refs/heads/${branch}` });
      git(['push', bUrl, `${aHead}:refs/heads/${branch}`], targetToken);
    }
    const body = `${marker}\nContribution from [A PR #${a.number}](${a.html_url}).\n\nInitial source head: \`${aHead}\`. See the source PR status and current branch commits for subsequent updates.\n\n### Merge instruction: preserve contributor identity\n\nPlease select **Create a merge commit** for this contribution. Do not squash or rebase this PR: original commit SHAs, authors and committers must be preserved. This is an instruction to the maintainer, not a restriction enforced by repository settings or branch protection.\n\nB is the source of truth. The controller synchronizes A/main to B/main and closes the accepted source PR only when its original head and B merge result are in main. If original commits are missing, the controller reports the identity issue; it cannot undo a merge or restore identity merely by synchronizing main.`;
    if (!b) {
      b = await api(target, '/pulls', { method: 'POST', body: { title: `A PR #${a.number}: ${a.title}`, head: branch, base: 'main', body } });
      await syncConversation(a.number, b.number);
    }
    await statusComment(a.number, `Waiting for B approval: [PR #${b.number}](${b.html_url}).\n\nTransferred source head: \`${aHead}\`.\n\nGit mergeability: \`${b.mergeable_state ?? 'pending'}\` (conflict status, not approval). Reviews: ${reviewSummary(reviews)}.\n\nRead the mirrored B review comments below for the requested corrections. Review decisions refer to their recorded commit; B must review newer revisions.\n\nA/main remains at accepted B history \`${bSha}\`. Continue changes on this feature branch; do not merge this PR at A.`);
    report.pairs.push({ a: a.number, b: b.number, state: 'pending', sourceHead: aHead, url: b.html_url });
    } catch (error) {
      report.pairs.push({ a: initial.number, b: b?.number, state: 'error', error: error.message });
      try { await statusComment(initial.number, `Bridge could not process this pair: ${error.message}. Other pairs continue; inspect the controller run. Main synchronization is reported separately.`); }
      catch { /* Preserve the original failure even when posting the diagnostic fails. */ }
    }
  }
  // Read B heads after PR transport so newly created/advanced incoming branches
  // are mirrored in this same run. Branch failures never starve contribution.
  report.branches = await syncBranches({ source, target, sourceToken, targetToken, git, api, list, ancestor });
  if (report.pairs.some(p => p.state === 'error')) throw new Error('Some PR pairs failed; remaining pairs were still processed');
  if (report.branches.some(b => b.state === 'error')) throw new Error('Some B-to-A branches failed; other branches and PR pairs were still processed');
}
try { await run(); report.passed = true; }
catch (error) { report.passed = false; report.error = error.message; }
finally {
  const summary = ['# B-authoritative PR bridge', '', `Result: **${report.passed ? 'PASS' : 'FAIL'}**`, '',
    report.trigger ? `Triggered by [${report.trigger.repository} / ${report.trigger.event}${report.trigger.pr ? ` / PR #${report.trigger.pr}` : ''}](${report.trigger.run}) at event SHA \`${report.trigger.sha}\`. Reconciliation reads current PRs and B/main; event metadata is not an instruction to merge or update a supplied ref.\n` : '',
    `A/main before: \`${report.sourceBefore ?? 'unknown'}\``, `B/main: \`${report.targetMain ?? 'unknown'}\``,
    `A/main after: \`${report.sourceAfter ?? 'unknown'}\``, `Main sync: **${report.mainSync ?? 'not-started'}**`, '',
    report.recoveryRef ? `Previous A/main preserved at \`${report.recoveryRef}\` before replacement.\n` : '',
    '## B-to-A branches', '',
    ...((report.branches ?? []).map(b => `- ${encodeURIComponent(b.branch ?? '(snapshot)')}: **${b.state}**${b.recovery ? `; recovery: ${encodeURIComponent(b.recovery)}` : ''}`)),
    '', 'Open A PR heads are deferred; A-only branches are retained. No branch deletions or reverse mirroring.', '',
    '| A PR | B PR | State | Source head |', '|---|---|---|---|',
    ...report.pairs.map(p => `| [#${p.a}](https://github.com/${source}/pull/${p.a}) | ${p.b ? `[#${p.b}](https://github.com/${target}/pull/${p.b})` : '—'} | ${p.state} | \`${p.sourceHead ?? ''}\` |`),
    report.error ? `\nStopped: ${report.error}` : '', ''].join('\n');
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
}
return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runBridge({ config: pairConfig(loadConfig(), process.env.BRIDGE_PAIR_ID) });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
