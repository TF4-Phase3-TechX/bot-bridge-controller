"""Publish generated ADF to one existing Confluence page using a scoped API token."""
import argparse
import base64
import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener
from status import NoRedirect, parse_time

SNAPSHOT_PREFIX = 'Contribution status snapshot: '

class Conflict(Exception):
    pass

class Publisher:
    def __init__(self, cloud_id, page_id, email, token, opener=None):
        if not re.fullmatch(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", cloud_id or ""):
            raise ValueError("Invalid CONFLUENCE_CLOUD_ID")
        if not re.fullmatch(r"[1-9][0-9]*", page_id or ""):
            raise ValueError("Invalid CONFLUENCE_PAGE_ID")
        if not email or not token or any(c in email + token for c in "\r\n"):
            raise ValueError("Missing or invalid Confluence credentials")
        self.page_id = page_id
        self.url = f"https://api.atlassian.com/ex/confluence/{cloud_id}/wiki/api/v2/pages/{page_id}"
        self.auth = "Basic " + base64.b64encode((email + ":" + token).encode()).decode()
        self.opener = opener or build_opener(NoRedirect())

    def request(self, method, payload=None):
        request = Request(self.url, method=method, headers={
            "Authorization": self.auth, "Accept": "application/json", "Content-Type": "application/json"},
            data=None if payload is None else json.dumps(payload, ensure_ascii=False).encode())
        try:
            with self.opener.open(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            error.close()
            if error.code == 409 and method == "PUT":
                raise Conflict() from None
            raise RuntimeError(f"Confluence {method} failed: HTTP {error.code}") from None
        except (URLError, TimeoutError, json.JSONDecodeError):
            raise RuntimeError(f"Confluence {method} failed: network or invalid response") from None

    def publish(self, document, snapshot_at=None):
        if not isinstance(document, dict) or document.get("type") != "doc" or document.get("version") != 1 or not isinstance(document.get("content"), list):
            raise ValueError("Expected an ADF document")
        if snapshot_at is not None:
            timestamp = parse_time(snapshot_at)
            if timestamp is None or timestamp.tzinfo is None:
                raise ValueError('Expected a timezone-aware snapshot timestamp')
        for attempt in range(2):
            page = self.request("GET")
            if str(page.get("id")) != self.page_id or page.get("status") != "current":
                raise ValueError("Page ID/status mismatch; only an existing current page can be updated")
            version = page["version"]["number"] + 1
            payload = {"id": self.page_id, "status": "current", "title": page["title"],
                       "body": {"representation": "atlas_doc_format", "value": json.dumps(document, ensure_ascii=False)},
                       "version": {"number": version, "message": SNAPSHOT_PREFIX + snapshot_at if snapshot_at else "Automated contribution status update"}}
            try:
                result = self.request("PUT", payload)
            except Conflict:
                if attempt == 0:
                    continue
                raise RuntimeError("Confluence version conflict after retry") from None
            if str(result.get("id")) != self.page_id or result.get("version", {}).get("number") != version:
                raise RuntimeError("Confluence returned an unexpected page/version")
            return version


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("--snapshot-time-file")
    args = parser.parse_args()
    with open(args.input, encoding="utf-8") as handle:
        document = json.load(handle)
    publisher = Publisher(os.environ.get("CONFLUENCE_CLOUD_ID"), os.environ.get("CONFLUENCE_PAGE_ID"),
                          os.environ.get("CONFLUENCE_EMAIL"), os.environ.get("CONFLUENCE_API_TOKEN"))
    snapshot_at = None
    if args.snapshot_time_file:
        with open(args.snapshot_time_file, encoding='utf-8') as handle:
            snapshot_at = handle.read().strip()
    version = publisher.publish(document, snapshot_at)
    print(f"Published Confluence page {publisher.page_id}, version {version}")

if __name__ == "__main__":
    main()
