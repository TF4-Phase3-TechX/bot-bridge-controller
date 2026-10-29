"""Read GitHub bridge status and write Confluence ADF; never mutate GitHub."""
import argparse
import base64
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler

ICT = timezone(timedelta(hours=7))
REPO = re.compile(r"^[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+$")
BRIDGE_HEAD = re.compile(r"^incoming/a-pr-[1-9][0-9]*$")
STATUS = {"success": ("OK", "green"), "failure": ("Failed", "red"),
          "timed_out": ("Failed", "red"), "cancelled": ("Cancelled", "yellow"),
          "in_progress": ("Running", "blue"), "queued": ("Queued", "blue"),
          "waiting": ("Waiting", "blue"), "pending": ("Pending", "blue"),
          "skipped": ("Skipped", "neutral"), "action_required": ("Action required", "yellow")}

TEAM_BY_TARGET = {  # TechX repository -> team; keep in sync with bridge.config.json
    "TechX-Corp/spa-workspace-xbrain": "DE",
    "TechX-Corp/qa-agent": "QA",
    "TechX-Corp/testing-intelligence": "QA",
    "TechX-Corp/security-test-platform": "QA",
    "TechX-Corp/Limbic-Hub": "QA",
    "TechX-Corp/Agent_Autonomous_QA": "QA",
    "TechX-Corp/xanima": "Collab",
}

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

class GitHub:
    def __init__(self, token, opener=None, sleep=time.sleep):
        if not token:
            raise ValueError("Missing GitHub token")
        self.opener = opener or build_opener(NoRedirect())
        self.token, self.sleep = token, sleep

    def get(self, path):
        if not path.startswith("/repos/") or ".." in path:
            raise ValueError("Invalid GitHub read path")
        request = Request("https://api.github.com" + path, headers={
            "Authorization": "Bearer " + self.token, "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "contribution-status"})
        for attempt in range(3):
            try:
                with self.opener.open(request, timeout=30) as response:
                    return json.load(response)
            except HTTPError as error:
                error.close()
                retryable = error.code in (429, 500, 502, 503, 504)
                if not retryable or attempt == 2:
                    raise RuntimeError(f"GitHub read failed: HTTP {error.code}") from None
                self.sleep(2 ** attempt)
            except (URLError, TimeoutError, json.JSONDecodeError):
                if attempt == 2:
                    raise RuntimeError("GitHub read failed: network or invalid response") from None
                self.sleep(2 ** attempt)

    def pages(self, path, key=None, max_pages=1000):
        for page in range(1, max_pages + 1):
            data = self.get(path + ("&" if "?" in path else "?") + f"per_page=100&page={page}")
            rows = data[key] if key else data
            if not isinstance(rows, list):
                raise ValueError("Invalid paginated GitHub response")
            yield rows
            if len(rows) < 100:
                return
        raise RuntimeError("GitHub pagination limit reached; refusing an incomplete snapshot")


def latest_jobs(api, controller, pair_ids, max_runs=200):
    latest, successes, inspected = {}, {}, 0
    path = f"/repos/{controller}/actions/workflows/controller.yml/runs"
    for batch in api.pages(path, "workflow_runs"):
        for run in batch:
            inspected += 1
            if inspected > max_runs:
                return latest, successes
            if run["event"] not in ("workflow_dispatch", "schedule"):
                continue
            for jobs in api.pages(f"/repos/{controller}/actions/runs/{run['id']}/jobs?filter=latest", "jobs"):
                for job in jobs:
                    name = job["name"]
                    if not name.startswith("Reconcile "):
                        continue
                    pair_id = name.removeprefix("Reconcile ").strip()
                    if pair_id not in pair_ids:
                        continue
                    # Runs arrive newest first; retries use filter=latest.
                    latest.setdefault(pair_id, job)
                    if job.get("conclusion") == "success":
                        successes.setdefault(pair_id, job)
            if len(latest) == len(pair_ids) and len(successes) == len(pair_ids):
                return latest, successes
    return latest, successes


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def fmt_time(value):
    date = parse_time(value)
    return date.astimezone(ICT).strftime("%H:%M %d/%m/%Y") if date else "—"


def transport_scope(registry, controller):
    """Select only registered B repositories for a reduced Transport token."""
    if not REPO.fullmatch(controller) or registry.get("controllerRepo") != controller or not registry.get("pairs"):
        raise ValueError("Controller registry mismatch or empty registry")
    targets = {p["target"] for p in registry["pairs"]}
    if any(not REPO.fullmatch(t) or t.lower() == controller.lower() for t in targets):
        raise ValueError("Invalid target repository or controller used as a target")
    owners = {t.split("/")[0] for t in targets}
    if len(owners) != 1:
        raise ValueError("Status workflow requires one Transport installation owner")
    return {"owner": next(iter(owners)), "repositories": ",".join(sorted(t.split("/")[1] for t in targets))}



def valid_target_branch(branch):
    return (isinstance(branch, str) and bool(branch) and branch != "HEAD"
            and not branch.startswith("-")
            and not re.search(r"[\x00-\x20\x7f~^:?*\[\\]", branch)
            and ".." not in branch and "@{" not in branch and not branch.endswith(".")
            and all(part and not part.startswith(".") and not part.endswith(".lock")
                    for part in branch.split("/")))


def collect(api, target_api, controller, max_runs=200, now=None):
    if not REPO.fullmatch(controller):
        raise ValueError("Invalid controller repository")
    now = now or datetime.now(timezone.utc)
    registry_file = api.get(f"/repos/{controller}/contents/bridge.config.json?ref=main")
    registry = json.loads(base64.b64decode(registry_file["content"]))
    if registry.get("controllerRepo") != controller or not registry.get("pairs"):
        raise ValueError("Controller registry mismatch or empty registry")
    bot = registry["bot"]
    pairs = registry["pairs"]
    if len({p["id"] for p in pairs}) != len(pairs):
        raise ValueError("Duplicate pair ID")
    for p in pairs:
        if not all(REPO.fullmatch(p[k]) for k in ("source", "target")):
            raise ValueError("Invalid pair endpoint")
        # Matches production registry semantics, not repository default_branch.
        if not valid_target_branch(p.get("branch", "main")):
            raise ValueError("Invalid contribution target branch")
    jobs, successes = latest_jobs(api, controller, {p["id"] for p in pairs}, max_runs)
    rows = []
    for p in pairs:
        branch, job, success = p.get("branch", "main"), jobs.get(p["id"]), successes.get(p["id"])
        state = (job.get("conclusion") or job.get("status")) if job else None
        label, color = STATUS.get(state, ("Not found in scan", "neutral"))
        steps = job.get("steps", []) if job else []
        limited = any(s.get("name") == "Transport token without pending Workflows permission"
                      and s.get("conclusion") == "success" for s in steps)
        failed = [s["name"] for s in steps if s.get("conclusion") == "failure"]
        detail = ""
        if state in ("failure", "timed_out") and failed:
            detail = "Failed step: " + failed[-1]
        elif limited:
            detail = "Sync continues; workflow-changing PR revisions wait for Workflows write."
            if state == "success":
                label, color = "Limited", "yellow"
        pending = 0
        pending_prs = []
        query = urlencode({"state": "open", "base": branch})
        for prs in target_api.pages(f"/repos/{p['target']}/pulls?{query}"):
            for pr in prs:
                if (pr["base"]["ref"] == branch and pr.get("user", {}).get("login") == bot
                        and pr["head"].get("repo", {}).get("full_name") == p["target"]
                        and BRIDGE_HEAD.fullmatch(pr["head"]["ref"])):
                    pending += 1
                    if len(pending_prs) < 10:
                        pending_prs.append({"number": pr["number"], "title": pr.get("title", ""),
                                            "draft": bool(pr.get("draft"))})
        completed = success.get("completed_at") if success else None
        stale = not completed or (now - parse_time(completed)).total_seconds() > 86400
        rows.append({"id": p["id"], "team": TEAM_BY_TARGET.get(p["target"]) or p.get("team") or
                     ("AI" if p["target"].split('/')[1].startswith('xora-') else "Unassigned"),
                     "source": p["source"], "target": p["target"], "branch": branch,
                     "time": job and (job.get("completed_at") or job.get("started_at") or job.get("created_at")),
                     "last_success": completed, "run_url": job and job["html_url"],
                     "label": label, "color": color, "detail": detail, "transport_limited": limited,
                     "pending": pending, "pending_prs": pending_prs, "stale": stale})
    return {"controller": controller, "rows": rows, "scan_limit": max_runs}


def text(value, href=None):
    return {"type": "text", "text": str(value), **({"marks": [{"type": "link", "attrs": {"href": href}}]} if href else {})}


def cell(*inline, header=False):
    return {"type": "tableHeader" if header else "tableCell", "content": [{"type": "paragraph", "content": list(inline)}]}


def build_doc(sections, now=None):
    now = now or datetime.now(ICT)
    content = [{"type": "panel", "attrs": {"panelType": "info"}, "content": [
        {"type": "paragraph", "content": [text(
            f"Updated automatically. Do not edit manually. Last updated {now.astimezone(ICT):%H:%M %d/%m/%Y} (ICT).")]}]}]
    limited_count = sum(bool(row.get("transport_limited")) for section in sections for row in section["rows"])
    if limited_count:
        content.append({"type": "panel", "attrs": {"panelType": "warning"}, "content": [
            {"type": "paragraph", "content": [text(
                f"Workflow transfer limited for {limited_count} repo pairs in their latest run. "
                "Sync continues; workflow-changing PR revisions wait for Workflows write. "
                "Approve the Transport App permission and installation update to restore full transfer.")]}]})
    for index, section in enumerate(sections):
        headers = ["Team", "Repository pair", "Target", "Latest run (ICT)", "Sync status", "Open PRs"]
        table = [{"type": "tableRow", "content": [cell(text(h), header=True) for h in headers]}]
        for i, row in enumerate(section["rows"]):
            stamp = cell(text(fmt_time(row["time"])))
            if row["run_url"]:
                stamp["content"][0]["content"] += [text(" · "), text("Run", row["run_url"])]
            if row["label"] not in ("OK", "Limited") or row["stale"]:
                stamp["content"].append({"type": "paragraph", "content": [
                    text("Last successful sync: " + fmt_time(row["last_success"]))]})
            state = cell({"type": "status", "attrs": {"text": row["label"].upper(), "color": row["color"], "localId": f"s{index}-{i}"}})
            # Keep failures visible; the shared permission warning belongs above the table.
            if row.get("detail") and (not row.get("transport_limited") or row["label"] == "Failed"):
                state["content"].append({"type": "paragraph", "content": [text(row["detail"])]})
            if row["stale"]:
                state["content"].append({"type": "paragraph", "content": [text("No successful sync in last 24h / scan")]})
            branch = text(row["branch"])
            branch["marks"] = [{"type": "code"}]
            pair = cell(text(row["target"].split("/")[1]))
            pair["content"].append({"type": "paragraph", "content": [
                text("XBrain", "https://github.com/" + row["source"]), text(" · "),
                text("TechX", "https://github.com/" + row["target"])]})
            table.append({"type": "tableRow", "content": [
                cell(text(row["team"])), pair, cell(branch), stamp, state, cell(text(row["pending"]))]})
        content += [
            {"type": "heading", "attrs": {"level": 2}, "content": [text("Repository overview")]},
            {"type": "paragraph", "content": [text("Controller: "), text(section["controller"], "https://github.com/" + section["controller"])]},
            {"type": "table", "attrs": {"layout": "wide"}, "content": table},
            {"type": "paragraph", "content": [text(
                f"Status reflects the latest reconciliation job, not PR approval. LIMITED means reduced workflow-transfer permissions. History covers up to {section['scan_limit']} controller runs.")]},
            {"type": "heading", "attrs": {"level": 2}, "content": [text("Open contribution PRs at TechX")]},
            {"type": "paragraph", "content": [text(
                "Expand a repository to view its PRs. Includes drafts and approved PRs awaiting merge; OPEN does not indicate review approval.")]}]
        open_rows = [row for row in section["rows"] if row["pending"]]
        for i, row in enumerate(open_rows):
            repo = row["target"].split("/")[1]
            entries = []
            for j, pr in enumerate(row.get("pending_prs", [])):
                entries.append({"type": "listItem", "content": [{"type": "paragraph", "content": [
                    text(f"#{pr['number']}: {pr['title']}", f"https://github.com/{row['target']}/pull/{pr['number']}"),
                    text(" "), {"type": "status", "attrs": {
                        "text": "DRAFT" if pr["draft"] else "OPEN", "color": "neutral" if pr["draft"] else "blue",
                        "localId": f"pr{index}-{i}-{j}"}}]}]})
            details = [{"type": "paragraph", "content": [text("Target: " + row["branch"])]}]
            if entries:
                details.append({"type": "bulletList", "content": entries})
            if row["pending"] > len(entries):
                details.append({"type": "paragraph", "content": [
                    text(f"Showing {len(entries)} of {row['pending']} open PRs.")]})
            query = urlencode({"q": f"is:pr is:open base:{row['branch']}"})
            details.append({"type": "paragraph", "content": [
                text("Browse open PRs on this target branch", f"https://github.com/{row['target']}/pulls?{query}")]})
            content.append({"type": "expand", "attrs": {"title": f"{repo} · {row['pending']} open PRs"}, "content": details})
        if not open_rows:
            content.append({"type": "paragraph", "content": [text("No open contribution PRs.")]})
    return {"type": "doc", "version": 1, "content": content}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--controller", action="append", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--snapshot", default="snapshot.json")
    parser.add_argument("--max-runs", type=int, default=200)
    parser.add_argument("--snapshot-time-out")
    args = parser.parse_args()
    if not 1 <= args.max_runs <= 1000:
        parser.error("max-runs must be between 1 and 1000")
    if not os.environ.get("GH_TOKEN") or not os.environ.get("TRANSPORT_READ_TOKEN"):
        raise ValueError("Both GH_TOKEN and TRANSPORT_READ_TOKEN are required; no token fallback")
    api = GitHub(os.environ["GH_TOKEN"])
    target_api = GitHub(os.environ["TRANSPORT_READ_TOKEN"])
    snapshot_at = datetime.now(timezone.utc).isoformat()
    sections = [collect(api, target_api, c, args.max_runs) for c in args.controller]
    for filename, data in [(args.out, build_doc(sections)), (args.snapshot, sections)]:
        with open(filename, "w", encoding="utf-8") as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
    if args.snapshot_time_out:
        with open(args.snapshot_time_out, 'w', encoding='utf-8') as output:
            output.write(snapshot_at + '\n')
    print("Collected", sum(len(s["rows"]) for s in sections), "pairs; GitHub reads only")

if __name__ == "__main__":
    main()
