# Contribution bridge controller

Three GitHub Apps separate synchronization into A, PR transport into B, and event dispatch. Contributors open same-repository PRs targeting **dev** at A. B owns review and merge. The controller transfers original commits, creates a paired B/dev PR, mirrors published PR descriptions/comments/reviews, and copies B branch heads back to A.

Live lab: `TF4-Phase3-TechX/bot-bridge-controller`. Registry opt-in allows its intentionally public sample endpoints.

## Setup

1. Copy this repository into a controller repository owned by B, with default branch `main`.
2. Edit `bridge.config.json`: controller repository, App bot logins and unique A/B pairs. Also replace the repository guard in `.github/workflows/controller.yml`. The sample uses `XBrainVN` and `TechX-Corp`; use your actual owners.
3. Create three GitHub Apps. Sync A: Contents, Pull requests and Workflows read/write, installed only on A repos. Transport B: the same permissions, installed only on B repos. Dispatch: Actions read/write, installed only on the controller. Metadata is read-only; webhooks are not used. Accept new installation permissions after permission changes.
4. Controller variables: `SOURCE_APP_CLIENT_ID`, `BRIDGE_APP_CLIENT_ID`, `BRIDGE_ENABLED=false`. Controller secrets: `SOURCE_APP_PRIVATE_KEY`, `BRIDGE_APP_PRIVATE_KEY`. Product repo variable/secret: `CONTROLLER_DISPATCH_APP_CLIENT_ID`, `CONTROLLER_DISPATCH_APP_PRIVATE_KEY`. These keys belong to their matching App, not to user PATs.
5. Bootstrap A/main and A/dev from B without rewriting commit history. Protect A/main and A/dev so only Sync A may update them; protect B/main and B/dev for maintainer review. Keep the controller under trusted maintainers.
6. Install [the complete notifier](https://github.com/pho-veteran/xora-contribution-controller/blob/main/templates/notifier.yml) on product main/default and dev branches. Replace `A_OWNER`, `A_REPO`, `B_OWNER`, `B_REPO`, `CONTROLLER_REPO`. Push events read their own branch workflow, so update active B branches too. Notifiers never check out PR code. Existing deployment CI must be restricted to its intended repository before mirroring.
7. Run `node --check scripts/pr-bridge.mjs` and `node --test tests/*.test.mjs` using Node 24. No npm dependencies are required. Enable `BRIDGE_ENABLED=true`; run controller workflow on main without inputs for all pairs, then test a new dev PR.

## Behavior

- PRs targeting branches other than dev are not contributions. Drafts without an existing pair are deferred. Push at A does not dispatch; PR synchronization does.
- B branch pushes trigger reconciliation. A-only branches remain. Open A PR head branches are deferred. Divergence at A is backed up atomically under recovery refs before B history replaces it. No branch deletion or tag sync occurs.
- B merge: A closes only after original source history and the merge result are in accepted B/dev and A/dev is synchronized. Use **Create a merge commit**, never squash/rebase, if you require this identity policy.
- Squash/rebase may copy equivalent code while leaving A open with an identity warning. The controller does not accept patch equivalence as original commit identity.
- B closes without merge: A closes as rejected when its head is unchanged at closure. A closing does not close B; B remains in control. B reopen does not automatically reopen A.
- PR body snapshots, published reviews, inline replies and thread metadata are mirrored as bot comments, not native approvals. Edits refresh copies; removed content gets a tombstone. Existing B title/body are not overwritten.
- Workflow files are transported at the original SHA. Both code-writing App installations and token steps require Workflows write. The controller never executes contribution code.
- Events select one registered pair; manual dispatch without inputs and the six-hour fallback schedule select all. Per-pair concurrency serializes runs. Dispatch success means the request was accepted, not that the PR was synchronized.

## Public labs versus private deployments

Private endpoints are the default. For intentionally public lab repos, set `"allowPublicRepositories": true` in the registry. The exact repository allowlist and one-repository-per-token checks still apply. Keep internal controllers private because summaries/logs can expose contribution content. Public labs must contain only public test data. No credentials are included here; store PEMs in Actions secrets.

This public source repository is a distribution, not your live controller. Publishing or updating it does not deploy changes into another organization.
