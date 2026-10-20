// A dispatch key is only a wake-up credential. GitHub's run record binds consent
// to the PR/SHA in run-name; caller-supplied actor or revision is never sufficient.
export function submissionTitle(pr, sha) {
  return `Submit A PR #${pr} at ${sha}`;
}

export async function verifySubmission({ trigger, source, api, now = Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  if (trigger?.repository !== source || trigger.event !== 'workflow_dispatch') return null;
  const repository = await api(source, '');
  const workflow = await api(source, '/actions/workflows/notify-controller.yml');
  let run;
  for (let attempt = 0; attempt < 12; attempt++) {
    run = await api(source, `/actions/runs/${trigger.runId}`);
    const age = now - Date.parse(run.created_at);
    if (String(run.id) !== trigger.runId || run.repository?.id !== repository.id
      || run.repository?.full_name !== source || run.head_repository?.id !== repository.id
      || run.workflow_id !== workflow.id || workflow.path !== '.github/workflows/notify-controller.yml'
      || !['.github/workflows/notify-controller.yml', `.github/workflows/notify-controller.yml@refs/heads/${repository.default_branch}`, `.github/workflows/notify-controller.yml@${repository.default_branch}`].includes(run.path)
      || run.event !== 'workflow_dispatch' || run.head_branch !== repository.default_branch
      || run.display_title !== submissionTitle(trigger.pr, trigger.sha)
      || run.run_attempt !== 1 || run.actor?.type !== 'User'
      || run.actor?.id !== run.triggering_actor?.id
      || !Number.isFinite(age) || age < -60000 || age > 60 * 60 * 1000) {
      throw new Error('Untrusted manual submission run');
    }
    if (run.status === 'completed') break;
    if (attempt === 11) throw new Error('Submission run has not completed; submit again');
    await sleep(5000);
  }
  if (run.conclusion !== 'success') throw new Error('Submission notifier did not succeed');
  const access = await api(source, `/collaborators/${encodeURIComponent(run.actor.login)}/permission`);
  if (!['write', 'admin', 'maintain'].includes(access.permission) && access.user?.permissions?.push !== true) {
    throw new Error('Submission actor must still have Write permission');
  }
  return { pr: Number(trigger.pr), sha: trigger.sha, actor: run.actor.login, run: trigger.run };
}
