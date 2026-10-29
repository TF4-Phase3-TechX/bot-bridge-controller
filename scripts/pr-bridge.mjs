import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainSyncDecision, mainSyncPush, pairDecision, assertMutation, assertPush, notificationMetadata } from './pr-bridge-policy.mjs';
import { reviewSummary } from './pr-bridge-reviews.mjs';
import { syncContent, digest } from './pr-content.mjs';
import { descriptionParts } from './pr-description.mjs';
import { loadConfig, pairConfig } from './bridge-config.mjs';
import { syncBranches } from './branch-sync.mjs';

export async function runBridge({
  config,
  env = process.env, fetchImpl = fetch, spawnImpl = spawnSync, now = Date.now(),
} = {}) {
const { source, target, bot, sourceBot, controllerRepo, branch: pairBranch = 'main' } = config;
const sourceToken = env.SOURCE_TOKEN;
const targetToken = env.BRIDGE_APP_TOKEN;
const transportWorkflowsWrite = env.TRANSPORT_WORKFLOWS_WRITE === 'true';
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
  assertMutation({ repo, source, target, path, method, body, branch: pairBranch });
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
async function statusComment(pr, content, repo = source, aPr = pr, stateKey = content) {
  const marker = repo === source ? '<!-- b-authoritative-bridge-status -->' : `<!-- bridge-source-status:${source}#${aPr} -->`;
  const key = `<!-- bridge-status-key:${digest(stateKey)} -->`;
  const body = `${marker}\n${content}\n\n${key}`;
  const comments = await list(repo, `/issues/${pr}/comments`);
  const old = comments.filter(x => x.user.login === (repo === source ? sourceBot : bot) && x.body.startsWith(marker)).sort((x, y) => y.id - x.id)[0];
  if (old?.body === body || old?.body.endsWith(key)) return;
  await api(repo, `/issues/${pr}/comments`, { method: 'POST', body: { body } });
}
async function graphql(repo, query, variables) {
  if (![source, target].includes(repo) || !query.trimStart().startsWith('query')) throw new Error('Invalid read scope');
  const response = await fetchImpl('https://api.github.com/graphql', {
    method: 'POST', headers: { Authorization: `Bearer ${repo === source ? sourceToken : targetToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`GraphQL read failed: ${response.status}`);
  const result = await response.json();
  if (result.errors?.length || !result.data) throw new Error('GraphQL thread read incomplete');
  return result.data;
}
async function syncPairContent(a, b) {
  return syncContent({ source, target, a, b, sourceBot, bot, api, list, graphql });
}
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
    if (scope.total_count !== 1 || scope.repositories[0]?.full_name !== expected) throw new Error('Token must cover exactly its private repository');
    if (scope.repositories[0]?.private !== true && config.allowPublicRepositories !== true) throw new Error('Public repository requires explicit allowPublicRepositories opt-in');
  }
  const aUrl = `https://github.com/${source}.git`, bUrl = `https://github.com/${target}.git`;
  git(['fetch', '--no-tags', aUrl, `+refs/heads/${pairBranch}:refs/remotes/bridge/a-main`], sourceToken);
  git(['fetch', '--no-tags', bUrl, `+refs/heads/${pairBranch}:refs/remotes/bridge/b-main`], targetToken);
  const aSha = git(['rev-parse', 'refs/remotes/bridge/a-main']).text;
  const bSha = git(['rev-parse', 'refs/remotes/bridge/b-main']).text;
  report.sourceBefore = aSha; report.targetMain = bSha;
  report.mainSync = mainSyncDecision({ equal: aSha === bSha, aIsAncestor: ancestor(aSha, bSha) });
  if (report.mainSync !== 'current') {
    // Dedicated App A may copy workflow files already accepted by B; never execute them here.
    // Read B again before writing; an older queued event must not dictate the target SHA.
    if ((await api(target, `/git/ref/heads/${pairBranch}`)).object.sha !== bSha) throw new Error('B main changed during fetch; retry using its latest history');
    const plan = mainSyncPush({ source, target, repo: source, before: aSha, accepted: bSha, replace: report.mainSync === 'replace-from-b', branch: pairBranch });
    assertPush({ repo: source, source, target, ref: `refs/heads/${pairBranch}`, branch: pairBranch });
    if (plan.recovery) assertPush({ repo: source, source, target, ref: plan.recovery, branch: pairBranch });
    // Atomic backup + update: if either ref is rejected, neither changes.
    git(['push', ...plan.options, aUrl, ...plan.refs], sourceToken);
    report.recoveryRef = plan.recovery;
  }
  report.sourceAfter = (await api(source, `/git/ref/heads/${pairBranch}`)).object.sha;
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
    if (initial.base.ref !== pairBranch || initial.head.repo?.full_name !== source) continue;
    let a = initial, b;
    try {
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
    if (a.base.ref !== pairBranch || a.head.repo?.full_name !== source) {
      report.pairs.push({ a: a.number, state: 'skipped-non-pair-branch' }); continue;
    }
    if (a.draft && !b) continue;
    if (b) b = await api(target, `/pulls/${b.number}`);
    if (b && (b.base.ref !== pairBranch || b.head.ref !== `incoming/a-pr-${a.number}` || b.head.repo?.full_name !== target)) throw new Error('PR pair refs no longer match bridge policy');
    let reviews = b ? await syncPairContent(a, b) : [];
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
      // If a merge happened after our B/${pairBranch} snapshot, defer closure until the next run.
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
          ? `Accepted in [B PR #${b.number}](${b.html_url}).\n\nB merge result: \`${b.merge_commit_sha}\`, verified in B/${pairBranch} and synchronized to A/${pairBranch}.\n\nOriginal source head \`${aHead}\` is included in accepted history; original commit identities are preserved.\n\nNo independent merge was performed at A.`
          : decision === 'identity-not-preserved'
            ? `Identity constraint not satisfied for [B PR #${b.number}](${b.html_url}): original source head \`${aHead}\` is missing from B/${pairBranch}. Use Create a merge commit; squash/rebase are unsupported. A/${pairBranch} still follows B/${pairBranch}, but this contribution is not marked accepted and no open A PR is closed by this decision. Maintainer must inspect the rewritten history.`
          : decision === 'new-commits-pending'
            ? `B merged [PR #${b.number}](${b.html_url}), but current A head \`${aHead}\` contains unaccepted commits. The ${pairBranch} branch is synchronized only to accepted B history. Submit the remaining changes in a new PR from current ${pairBranch}; this PR is not marked complete.`
            : decision === 'merge-result-not-in-branch'
              ? `B merged [PR #${b.number}](${b.html_url}), but its merge result \`${b.merge_commit_sha}\` is not in the B/${pairBranch} snapshot \`${bSha}\` synchronized by this run. This PR is not marked complete; retry against current B/${pairBranch} or inspect a history rewrite.`
            : decision === 'source-closed'
              ? `A PR is closed; [B PR #${b.number}](${b.html_url}) remains under B's control. No merge or closure is performed at B. Reopen A if further contribution is needed.`
              : `Bridge status: **${decision}**. [B PR #${b.number}](${b.html_url}). No unaccepted code is added to either ${pairBranch}; this pair will not be recreated automatically.`;
        await statusComment(a.number, message);
        // Refresh immediately before closing, so a newer source head is not silently discarded.
        a = await api(source, `/pulls/${a.number}`);
        if (a.state === 'open' && a.head.sha === aHead && ['accepted', 'rejected'].includes(decision)) {
          await api(source, `/pulls/${a.number}`, { method: 'PATCH', body: { state: 'closed' } });
        }
        continue;
      }
      if (!sourceIncludedInBHead && !ancestor(b.head.sha, aHead)) {
        await statusComment(a.number, `Blocked: incoming branch on [B PR #${b.number}](${b.html_url}) diverged from A head \`${aHead}\`. B changes are preserved; no force-push is performed. Coordinate with B or open a new A PR from current A/${pairBranch}. Other PRs continue processing.`);
        report.pairs.push({ a: a.number, b: b.number, state: 'incoming-diverged', sourceHead: aHead }); continue;
      }
    }
    if (a.state !== 'open' || a.draft) continue;
    if (included) { await statusComment(a.number, `Source head \`${aHead}\` is already in B/${pairBranch}. No new destination PR is needed.`); continue; }
    // The source may have been retargeted or advanced since the snapshot; never push a stale revision.
    const latest = await api(source, `/pulls/${a.number}`);
    if (latest.base.ref !== pairBranch || latest.head.repo?.full_name !== source || latest.head.sha !== aHead || latest.state !== 'open' || latest.draft) {
      report.pairs.push({ a: a.number, state: 'source-changed-retry' }); continue;
    }
    const branch = `incoming/a-pr-${a.number}`;
    if (!b || !ancestor(aHead, b.head.sha)) {
      if (!transportWorkflowsWrite) {
        const baseSha = git(['merge-base', aHead, bSha]).text;
        if (git(['diff', '--name-only', baseSha, aHead, '--', '.github/workflows/']).text) {
          await statusComment(a.number, 'Waiting for Transport Workflows write: this revision changes workflow files. Reconciliation and other contributions continue. This PR will be retried on the next reconciliation after the App permission is approved.');
          report.pairs.push({ a: a.number, b: b?.number, state: 'waiting-workflows-permission', sourceHead: aHead });
          continue;
        }
      }
      assertPush({ repo: target, source, target, ref: `refs/heads/${branch}` });
      git(['push', bUrl, `${aHead}:refs/heads/${branch}`], targetToken);
    }
    if (!b) {
      const { body } = descriptionParts(source, a);
      b = await api(target, '/pulls', { method: 'POST', body: { title: `A PR #${a.number}: ${a.title}`, head: branch, base: pairBranch, body } });
      reviews = await syncPairContent(a, b);
    }
    await statusComment(a.number, `Waiting for B approval: [PR #${b.number}](${b.html_url}).\n\nTransferred source head: \`${aHead}\`.\n\nGit mergeability: \`${b.mergeable_state ?? 'pending'}\` (conflict status, not approval). Reviews: ${reviewSummary(reviews)}.\n\nRead the mirrored B review comments below for the requested corrections. Review decisions refer to their recorded commit; B must review newer revisions.\n\nA/${pairBranch} remains at accepted B history \`${bSha}\`. Continue changes on this feature branch; do not merge this PR at A.`, source, a.number, JSON.stringify(['pending', b.number, aHead, b.mergeable_state ?? 'pending', reviewSummary(reviews)]));
    report.pairs.push({ a: a.number, b: b.number, state: 'pending', sourceHead: aHead, url: b.html_url });
    } catch (error) {
      report.pairs.push({ a: initial.number, b: b?.number, state: 'error', error: error.message });
      try { await statusComment(initial.number, `Bridge could not process this pair: ${error.message}. Other pairs continue; inspect the controller run. Main synchronization is reported separately.`); }
      catch { /* Preserve the original failure even when posting the diagnostic fails. */ }
    }
  }
  // Read B heads after PR transport so newly created/advanced incoming branches
  // are mirrored in this same run. Branch failures never starve contribution.
  report.branches = await syncBranches({ source, target, sourceToken, targetToken, git, api, list, ancestor, mainBranch: pairBranch });
  if (report.pairs.some(p => p.state === 'error')) throw new Error('Some PR pairs failed; remaining pairs were still processed');
  if (report.branches.some(b => b.state === 'error')) throw new Error('Some B-to-A branches failed; other branches and PR pairs were still processed');
}
try { await run(); report.passed = true; }
catch (error) { report.passed = false; report.error = error.message; }
finally {
  const summary = ['# B-authoritative PR bridge', '', `Result: **${report.passed ? 'PASS' : 'FAIL'}**`, '',
    transportWorkflowsWrite ? 'Transport Workflows write: available.\n'
      : 'Transport mode: **LIMITED**. Workflow-changing revisions wait for permission; branch reconciliation and ordinary PRs continue.\n',
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
