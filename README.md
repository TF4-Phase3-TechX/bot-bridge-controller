# Private contribution controller

B decides whether contributions enter main. Event notifiers at A/B dispatch this trusted controller; the six-hour schedule is a fallback. Three Apps separate A synchronization, B contribution transport, and Actions dispatch.

Code transport keys remain here. A/B each hold the dispatch key (Actions write on this controller), so developers allowed to run workflows at A can use that key. A/main is copied from authoritative B/main, preserving divergent A history in a recovery ref before an atomic replacement with a lease. Only Git objects are transported; contribution code is never executed here.

PR identity is the expected bot author plus the B repository and `incoming/a-pr-N` head branch. Maintainer edits to B title/body are retained. B may append commits; the controller never force-pushes B. Diverged branches get a per-pair status. Closed A does not cause the bot to close B. B still decides. PR body asks for Create a merge commit to preserve original commit identity; it is a human convention, not enforced by merge-method settings.

Open PRs and closed PRs updated within seven days are reconciled; explicit PR events can reach older pairs. Pair-local failures are reported while other pairs continue. Overall failure remains visible. Main synchronization runs before pair processing.

Set `BRIDGE_ENABLED=true` only after setup and policy checks. Push/PR events test the controller without App keys. Schedule/dispatch runs tests on the event's pinned main revision in the reconcile job before minting scoped App tokens. Policy and reconcile have separate concurrency groups.

Production must restrict App B from writing or merging B/main and developers from merging A/main using supported GitHub protection. This is separate from merge-method guidance. Treat incoming PR code as untrusted in B CI: no secrets/write tokens in its build/test job. Guard B-only deployment workflows by repository before copying them to A.

Run `node --check scripts/pr-bridge.mjs` and `node --test tests/*.test.mjs`. The suite includes policy, review/comment rendering, real local Git recovery/lease fixtures, and mocked controller orchestration. Live GitHub validation is separate.
