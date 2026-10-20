# Private contribution controller

B decides which contributions enter main. This repository polls PRs at Vihnnnn/bot-bridge-lab, transfers original commits to TF4-Phase3-TechX/bot-bridge-lab, and fast-forwards A main after B accepts changes.

Only trusted maintainers may write this repository. Repository A contains no Actions secrets. Reconciliation is enabled with BRIDGE_ENABLED=true; both Apps are installed and their keys are stored only in this controller. App B has no Workflows write permission. The A and B Apps are each scoped to one repository. The controller never calls the B merge endpoint. GitHub Free private repositories still require a supported paid plan to enforce branch restrictions.

Run Actions > Isolated bridge - B decides > Run workflow, or wait for the 15-minute schedule. CI tests run separately without bridge secrets.
