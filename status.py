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

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

class GitHub:
    def __init__(self, token, opener=None, sleep=time.sleep):
        if not token:
            raise ValueError("Missing GH_TOKEN")
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


def collect(api, controller, max_runs=200, public_lab=False, now=None):
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
        if p.get("branch", "main") not in ("main", "dev"):
            raise ValueError("Contribution branch must be main or dev")
        if public_lab and api.get(f"/repos/{p['target']}")["private"]:
            raise ValueError("Public lab fallback cannot read a private target; configure Status App")
    jobs, successes = latest_jobs(api, controller, {p["id"] for p in pairs}, max_runs)
    rows = []
    for p in pairs:
        branch, job, success = p.get("branch", "main"), jobs.get(p["id"]), successes.get(p["id"])
        state = (job.get("conclusion") or job.get("status")) if job else None
        label, color = STATUS.get(state, ("Not found in scan", "neutral"))
        pending = 0
        query = urlencode({"state": "open", "base": branch})
        for prs in api.pages(f"/repos/{p['target']}/pulls?{query}"):
            pending += sum(1 for pr in prs if pr["base"]["ref"] == branch
                           and pr.get("user", {}).get("login") == bot
                           and pr["head"].get("repo", {}).get("full_name") == p["target"]
                           and BRIDGE_HEAD.fullmatch(pr["head"]["ref"]))
        completed = success.get("completed_at") if success else None
        stale = not completed or (now - parse_time(completed)).total_seconds() > 86400
        rows.append({"id": p["id"], "team": p.get("team") or ("AI" if p["target"].split('/')[1].startswith('xora-') else "Unassigned"),
                     "source": p["source"], "target": p["target"], "branch": branch,
                     "time": job and (job.get("completed_at") or job.get("started_at") or job.get("created_at")),
                     "last_success": completed, "run_url": job and job["html_url"],
                     "label": label, "color": color, "pending": pending, "stale": stale})
    return {"controller": controller, "rows": rows, "scan_limit": max_runs}


def text(value, href=None):
    return {"type": "text", "text": str(value), **({"marks": [{"type": "link", "attrs": {"href": href}}]} if href else {})}


def cell(*inline, header=False):
    return {"type": "tableHeader" if header else "tableCell", "content": [{"type": "paragraph", "content": list(inline)}]}


def build_doc(sections, now=None):
    now = now or datetime.now(ICT)
    content = [{"type": "paragraph", "content": [text(f"Generated {now.astimezone(ICT):%H:%M %d/%m/%Y} (ICT). Latest reconcile job status; OK does not mean every PR was accepted. Missing history is bounded by the scan limit. Do not edit this generated page manually.")]}]
    for index, section in enumerate(sections):
        headers = ["Team", "XBrain / A", "TechX / B", "Target", "Latest reconcile", "Job status", "Last successful reconcile", "Open bridge PRs", "Freshness"]
        table = [{"type": "tableRow", "content": [cell(text(h), header=True) for h in headers]}]
        for i, row in enumerate(section["rows"]):
            stamp = text(fmt_time(row["time"]), row["run_url"])
            table.append({"type": "tableRow", "content": [
                cell(text(row["team"])), cell(text(row["source"], "https://github.com/" + row["source"])),
                cell(text(row["target"], "https://github.com/" + row["target"])), cell(text(row["branch"])), cell(stamp),
                cell({"type": "status", "attrs": {"text": row["label"], "color": row["color"], "localId": f"s{index}-{i}"}}),
                cell(text(fmt_time(row["last_success"]))), cell(text(row["pending"])),
                cell(text("No success in last 24h / scan" if row["stale"] else "Recent success"))]})
        content += [{"type": "heading", "attrs": {"level": 2}, "content": [text(section["controller"])]},
                    {"type": "paragraph", "content": [text(f"Scanned up to {section['scan_limit']} latest controller runs.")]},
                    {"type": "table", "attrs": {"layout": "default"}, "content": table}]
    return {"type": "doc", "version": 1, "content": content}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--controller", action="append", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--snapshot", default="snapshot.json")
    parser.add_argument("--max-runs", type=int, default=200)
    parser.add_argument("--public-lab", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.max_runs <= 1000:
        parser.error("max-runs must be between 1 and 1000")
    api = GitHub(os.environ.get("GH_TOKEN"))
    sections = [collect(api, c, args.max_runs, args.public_lab) for c in args.controller]
    for filename, data in [(args.out, build_doc(sections)), (args.snapshot, sections)]:
        with open(filename, "w", encoding="utf-8") as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
    print("Collected", sum(len(s["rows"]) for s in sections), "pairs; GitHub reads only")

if __name__ == "__main__":
    main()
