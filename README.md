# Public contribution bridge lab controller

Live controller for `Vihnnnn` (A) and `TF4-Phase3-TechX` (B). See `bridge.config.json` for both registered pairs. Contributors open PRs into A/dev; B reviews and merges into B/dev. Notifiers automatically dispatch this controller. A six-hour scheduled sweep is a fallback.

## Public lab repositories

- [A primary](https://github.com/Vihnnnn/bot-bridge-lab) / [B primary](https://github.com/TF4-Phase3-TechX/bot-bridge-lab)
- [A second pair](https://github.com/Vihnnnn/bot-bridge-multi-lab) / [B second pair](https://github.com/TF4-Phase3-TechX/bot-bridge-multi-lab)
- [Notifier example](https://github.com/Vihnnnn/bot-bridge-lab/blob/main/.github/workflows/notify-controller.yml)
- [Controller workflow](.github/workflows/controller.yml)

## Configuration

Three Apps: Sync A has Contents, Pull requests and Workflows write on A repos; Transport B has the same permissions on B repos; Dispatch has Actions write only on the controller. Controller variables are `SOURCE_APP_CLIENT_ID`, `BRIDGE_APP_CLIENT_ID`, `BRIDGE_ENABLED`. Its secrets are `SOURCE_APP_PRIVATE_KEY`, `BRIDGE_APP_PRIVATE_KEY`. A/B product repos hold only `CONTROLLER_DISPATCH_APP_CLIENT_ID` and `CONTROLLER_DISPATCH_APP_PRIVATE_KEY` for dispatch.

To reuse: change registry owners/repos/bot slugs and the workflow repository guard; replace the concrete lab A/B/controller names in the notifier. Create main and dev from B history, install the Apps on selected repos, configure secrets and branch protection, run tests, then enable `BRIDGE_ENABLED=true`. Run the controller on main without inputs to reconcile all registered pairs. Never store PEMs or tokens in source.

`allowPublicRepositories: true` explicitly permits these public lab endpoints. Private deployments should omit it or set false. Exact registered-repository and one-repo-per-token checks remain enforced. Public lab visibility is not proof of production branch-protection setup.

## Behavior

B owns review and merge. Use Create a merge commit to preserve original commit identity. Squash/rebase can produce the same code but leave A open with an identity warning. B rejecting a PR closes the unchanged A PR. Closing A never closes B. B-to-A branch mirroring retains A-only branches and defers open A PR head branches; divergence is preserved in recovery refs before replacement. No branch deletion or tag mirroring occurs.

PR bodies, published reviews and comments are preserved as bot comments; they are not native approvals. Workflow files are transported without executing PR code inside the controller. Both transport App installations and token steps need Workflows write.

Run `node --check scripts/pr-bridge.mjs` and `node --test tests/*.test.mjs` with Node 24; no npm install is needed. The public sample tests include real local Git fixtures and mocked API orchestration. Historical lab PRs may refer to older main-only behavior; the current contribution target is dev.
