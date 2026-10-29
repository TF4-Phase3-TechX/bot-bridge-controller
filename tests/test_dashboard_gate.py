import copy
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dashboard_gate import decision, wait_for_window, main
from publish import Publisher, SNAPSHOT_PREFIX
from status import parse_time

STAMP = '2026-10-29T00:00:00+00:00'
EVENT = parse_time(STAMP).timestamp()


def page(snapshot=None, created=None):
    return {'id': '123', 'status': 'current', 'version': {
        'message': SNAPSHOT_PREFIX + snapshot if snapshot else 'Automated contribution status update',
        'createdAt': created}}


class GateTests(unittest.TestCase):
    def test_first_event_uses_completion_time_not_runner_start(self):
        self.assertEqual(decision(page(), EVENT, EVENT + 60), ('wait', 240))
        self.assertEqual(decision(page(), EVENT, EVENT + 301), ('publish', 0))

    def test_burst_events_covered_by_snapshot_skip_even_if_notification_arrives_late(self):
        current = page('2026-10-29T00:05:00+00:00', '2026-10-29T00:06:00Z')
        for seconds in (0, 30, 180, 300):
            self.assertEqual(decision(current, EVENT + seconds, EVENT + 400), ('covered', 0))

    def test_last_event_during_collection_is_not_dropped(self):
        current = page('2026-10-29T00:05:00+00:00', '2026-10-29T00:06:00Z')
        self.assertEqual(decision(current, EVENT + 310, EVENT + 400), ('wait', 260))
        self.assertEqual(decision(current, EVENT + 310, EVENT + 660), ('publish', 0))

    def test_wait_rechecks_page_before_collecting(self):
        class Fake:
            page_id = '123'
            reads = 0
            def request(self, method):
                self.reads += 1
                return page() if self.reads == 1 else page('2026-10-29T00:05:00+00:00')
        clock = [EVENT + 10]
        sleeps = []
        def sleep(seconds):
            sleeps.append(seconds); clock[0] += seconds
        publisher = Fake()
        self.assertFalse(wait_for_window(publisher, EVENT, lambda: clock[0], sleep))
        self.assertEqual(sleeps, [290])
        self.assertEqual(publisher.reads, 2)

    def test_expired_window_publishes_without_sleep_and_rejects_wrong_page(self):
        class Fake:
            page_id = '123'
            def request(self, method): return page()
        self.assertTrue(wait_for_window(Fake(), EVENT, lambda: EVENT + 301,
                                       lambda _: self.fail('Unexpected wait')))
        f = Fake(); f.page_id = '456'
        with self.assertRaisesRegex(ValueError, 'ID/status'):
            wait_for_window(f, EVENT, lambda: EVENT + 301)
        with self.assertRaisesRegex(ValueError, 'future'):
            wait_for_window(Fake(), EVENT + 1000, lambda: EVENT)

    def test_manual_schedule_and_disabled_publish_do_not_need_confluence_gate_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory) / 'output')
            for event, enabled in [('workflow_dispatch', 'true'), ('schedule', 'true'), ('workflow_run', 'false')]:
                with patch.dict(os.environ, {'GITHUB_EVENT_NAME': event, 'CONFLUENCE_PUBLISH_ENABLED': enabled,
                                              'GITHUB_OUTPUT': output}, clear=True), patch('dashboard_gate.Publisher') as publisher:
                    main()
                    publisher.assert_not_called()
            self.assertEqual(Path(output).read_text().count('publish=true'), 3)

    def test_automatic_event_requires_completion_time(self):
        with patch.dict(os.environ, {'GITHUB_EVENT_NAME': 'workflow_run', 'CONFLUENCE_PUBLISH_ENABLED': 'true'}, clear=True):
            with self.assertRaisesRegex(ValueError, 'completion time'):
                main()

    def test_publish_records_collection_start_and_preserves_existing_title(self):
        class Opener:
            payload = None
            def open(self, req, timeout):
                if req.method == 'GET':
                    return io.BytesIO(b'{"id":"123","status":"current","title":"Current title","version":{"number":4}}')
                self.payload = json.loads(req.data)
                return io.BytesIO(b'{"id":"123","version":{"number":5}}')
        opener = Opener()
        publisher = Publisher('11111111-1111-1111-1111-111111111111', '123', 'test@example.test', 'dummy', opener)
        publisher.publish({'type': 'doc', 'version': 1, 'content': []}, STAMP)
        self.assertEqual(opener.payload['version']['message'], SNAPSHOT_PREFIX + STAMP)
        self.assertEqual(opener.payload['title'], 'Current title')
        with self.assertRaises(ValueError):
            publisher.publish({'type': 'doc', 'version': 1, 'content': []}, '2026-10-29T00:00:00')


if __name__ == '__main__':
    unittest.main()
