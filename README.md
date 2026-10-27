# Public contribution bridge lab controller

Live controller for `Vihnnnn` (A) and `TF4-Phase3-TechX` (B). See `bridge.config.json` for both registered pairs. Each pair declares one target branch (default main). Any valid Git branch name is supported, including init-demo and release/v1; each repository notifier filters events to that configured target. Contributors open PRs only into that configured branch at A; B reviews and merges into the same branch at B. Notifiers automatically dispatch this controller. A six-hour scheduled sweep is a fallback.

## Public lab repositories

- [A primary](https://github.com/Vihnnnn/bot-bridge-lab) / [B primary](https://github.com/TF4-Phase3-TechX/bot-bridge-lab)
- [A second pair](https://github.com/Vihnnnn/bot-bridge-multi-lab) / [B second pair](https://github.com/TF4-Phase3-TechX/bot-bridge-multi-lab)
- [Notifier example](https://github.com/Vihnnnn/bot-bridge-lab/blob/main/.github/workflows/notify-controller.yml)
- [Controller workflow](.github/workflows/controller.yml)

## Configuration

Three Apps: Sync A has Contents, Pull requests and Workflows write on A repos; Transport B has the same permissions on B repos; Dispatch has Actions write only on the controller. Controller variables are `SOURCE_APP_CLIENT_ID`, `BRIDGE_APP_CLIENT_ID`, `BRIDGE_ENABLED`. Its secrets are `SOURCE_APP_PRIVATE_KEY`, `BRIDGE_APP_PRIVATE_KEY`. A/B product repos hold only `CONTROLLER_DISPATCH_APP_CLIENT_ID` and `CONTROLLER_DISPATCH_APP_PRIVATE_KEY` for dispatch.

To reuse: change registry owners/repos/bot slugs and the workflow repository guard; replace the concrete lab A/B/controller names in the notifier. Ensure the configured target exists at A and B from B history, install the Apps on selected repos, configure secrets and branch protection, run tests, then enable `BRIDGE_ENABLED=true`. Run the controller on main without inputs to reconcile all registered pairs. Never store PEMs or tokens in source.

`allowPublicRepositories: true` explicitly permits these public lab endpoints. Private deployments should omit it or set false. Exact registered-repository and one-repo-per-token checks remain enforced. Public lab visibility is not proof of production branch-protection setup.

## Behavior

B owns review and merge. Use Create a merge commit to preserve original commit identity. Squash/rebase can produce the same code but leave A open with an identity warning. B rejecting a PR closes the unchanged A PR. Closing A never closes B. B-to-A branch mirroring retains A-only branches and defers open A PR head branches; divergence is preserved in recovery refs before replacement. No branch deletion or tag mirroring occurs.

PR bodies, published reviews and comments are preserved as bot comments; they are not native approvals. Workflow files are transported without executing PR code inside the controller. Both transport App installations and token steps need Workflows write.

Run `node --check scripts/pr-bridge.mjs` and `node --test tests/*.test.mjs` with Node 24; no npm install is needed. The public sample tests include real local Git fixtures and mocked API orchestration. Historical lab PRs may refer to older main-only behavior; the current target is read from each registry pair.

## Status dashboard and notifier filters

Render the notifier for a registered pair with `node scripts/render-notifier.mjs <pair-id> <output.yml>`. Internal B PR events and Transport push echoes are filtered; human B pushes and bridge reviews/comments still notify.

`status.py` reads the registry branch and bot identity, paginates PRs, distinguishes latest job from latest successful reconcile, and fails on incomplete API reads. `publish.py` updates an existing Confluence page, preserves title, and retries one version conflict. `.github/workflows/status.yml` runs separately from reconciliation. Confluence publication stays disabled until credentials and page variables are supplied. The dashboard reuses the existing three Apps: the job GITHUB_TOKEN reads controller contents and Actions, while a reduced Transport token reads PRs only in registered B repositories. No Status App, new GitHub secret, extra Transport permission, or controller installation is needed. Existing BRIDGE_APP_CLIENT_ID and BRIDGE_APP_PRIVATE_KEY are reused; missing tokens fail closed on public and private repositories alike.
