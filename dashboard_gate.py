"""Coalesce completed controller events in the separate status workflow."""
import os
import time
from publish import Publisher, SNAPSHOT_PREFIX
from status import parse_time

WINDOW_SECONDS = 300


def decision(page, event_time, now):
    message = page['version'].get('message', '')
    snapshot = parse_time(message[len(SNAPSHOT_PREFIX):]) if message.startswith(SNAPSHOT_PREFIX) else None
    if snapshot and event_time <= snapshot.timestamp():
        return 'covered', 0
    # Anchor the fixed window to the completed event, not runner start time.
    # A busy runner queue therefore does not add another full five-minute wait.
    published = parse_time(page['version'].get('createdAt'))
    due = max(event_time + WINDOW_SECONDS, (published.timestamp() + WINDOW_SECONDS) if published else 0)
    return ('wait', due - now) if due > now else ('publish', 0)


def wait_for_window(publisher, event_time, clock=time.time, sleep=time.sleep):
    if event_time > clock() + 60:
        raise ValueError('Controller completion time is unexpectedly in the future')
    while True:
        page = publisher.request('GET')
        if str(page.get('id')) != publisher.page_id or page.get('status') != 'current':
            raise ValueError('Dashboard page ID/status mismatch')
        action, delay = decision(page, event_time, clock())
        if action != 'wait':
            return action == 'publish'
        if delay > WINDOW_SECONDS + 60:
            raise ValueError('Dashboard timestamp is unexpectedly in the future')
        print(f'Coalescing dashboard updates for {int(delay + 0.999)} seconds', flush=True)
        # This is a dedicated publisher job: no repository-pair lock is held.
        sleep(delay)


def main():
    publish = True
    if os.environ.get('GITHUB_EVENT_NAME') == 'workflow_run' and os.environ.get('CONFLUENCE_PUBLISH_ENABLED') == 'true':
        event = parse_time(os.environ.get('CONTROLLER_COMPLETED_AT'))
        if event is None or event.tzinfo is None:
            raise ValueError('Missing or invalid controller completion time')
        publisher = Publisher(os.environ.get('CONFLUENCE_CLOUD_ID'), os.environ.get('CONFLUENCE_PAGE_ID'),
                              os.environ.get('CONFLUENCE_EMAIL'), os.environ.get('CONFLUENCE_API_TOKEN'))
        publish = wait_for_window(publisher, event.timestamp())
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as handle:
        handle.write(f"publish={'true' if publish else 'false'}\n")
    print('Dashboard collection is due' if publish else 'Skipped: this completed event is already covered by the published snapshot')


if __name__ == '__main__':
    main()
