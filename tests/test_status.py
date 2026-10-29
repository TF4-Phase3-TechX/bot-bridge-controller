import base64
import io
import json
import unittest
from datetime import datetime, timezone
from urllib.error import HTTPError
from status import GitHub, collect, build_doc, transport_scope
from publish import Publisher

CTRL = "B/controller"
NOW = datetime(2026,10,27,0,0,tzinfo=timezone.utc)
REGISTRY = {"controllerRepo": CTRL, "bot": "transport[bot]", "pairs": [
    {"id": "dev-pair", "source": "A/dev-repo", "target": "B/dev-repo", "branch": "dev", "team": "AI"},
    {"id": "main-pair", "source": "A/main-repo", "target": "B/main-repo"}]}

def job(pair, state="success"):
    return {"name": "Reconcile " + pair, "conclusion": state, "status": "completed", "html_url": "https://github.com/B/controller/actions/runs/1/job/1",
            "created_at": "2026-10-26T23:00:00Z", "started_at": "2026-10-26T23:00:10Z", "completed_at": "2026-10-26T23:01:00Z"}

def pr(repo, branch="dev", author="transport[bot]", head="incoming/a-pr-1", number=1, title="Example contribution", draft=False):
    return {"number":number, "title":title, "draft":draft, "base": {"ref": branch},
            "user": {"login": author}, "head": {"ref": head, "repo": {"full_name": repo}}}

class Fixture:
    def __init__(self, fail=False): self.fail, self.paths = fail, []
    def get(self, path):
        self.paths.append(path)
        if "bridge.config.json" in path:
            return {"content": base64.b64encode(json.dumps(REGISTRY).encode()).decode()}
        return {"private": False}
    def pages(self, path, key=None):
        self.paths.append(path)
        if path.endswith("/runs"):
            yield [{"id": 2,"event":"workflow_dispatch"},{"id": 1,"event":"schedule"}]
        elif "/runs/2/" in path:
            yield [job("dev-pair","failure"), job("main-pair")]
        elif "/jobs?" in path:
            yield [job("dev-pair")]
        elif "B/dev-repo/pulls" in path:
            if self.fail: raise RuntimeError("GitHub read failed: HTTP 403")
            yield [pr("B/dev-repo") for _ in range(100)] + [pr("B/dev-repo",author="human"),pr("B/dev-repo",head="incoming/a-pr-0")]
            yield [pr("B/dev-repo"),pr("B/dev-repo",branch="main")]
        else:
            yield [pr("B/main-repo",branch="main")]

class StatusTests(unittest.TestCase):
    def test_limited_mode_and_pr_links_reuse_existing_reads(self):
        class Mode(Fixture):
            def __init__(self, limited):
                super().__init__()
                self.limited = limited
            def pages(self, path, key=None):
                for items in super().pages(path, key):
                    if '/jobs?' in path:
                        for item in items:
                            item['conclusion'] = 'success'
                            if self.limited:
                                item['steps'] = [{'name':'Transport token without pending Workflows permission',
                                                  'conclusion':'success'}]
                    yield items
        normal, limited = Mode(False), Mode(True)
        collect(normal, normal, CTRL, now=NOW)
        data = collect(limited, limited, CTRL, now=NOW)
        self.assertEqual(normal.paths, limited.paths)
        self.assertTrue(all(row['label']=='Limited' and row['color']=='yellow' for row in data['rows']))
        self.assertEqual(data['rows'][0]['pending'],101)
        self.assertEqual(len(data['rows'][0]['pending_prs']),10)
        doc = json.dumps(build_doc([data],NOW))
        self.assertIn('LIMITED',doc)
        self.assertIn('Workflows write',doc)
        self.assertIn('https://github.com/B/dev-repo/pull/1',doc)
        self.assertIn('Showing 10 of 101 open PRs.',doc)

    def test_failed_steps_stay_red_and_draft_pr_titles_are_rendered_as_text(self):
        class Failed(Fixture):
            def pages(self, path, key=None):
                if '/pulls?' in path:
                    self.paths.append(path)
                    repo = 'B/dev-repo' if 'dev-repo' in path else 'B/main-repo'
                    branch = 'dev' if 'dev-repo' in path else 'main'
                    yield [pr(repo,branch=branch,number=42,title='<b>Review this</b>',draft=True)]
                else:
                    for items in super().pages(path,key):
                        if '/jobs?' in path:
                            for item in items:
                                item['steps']=[{'name':'Transport token without pending Workflows permission','conclusion':'success'},
                                               {'name':'Transfer PRs','conclusion':'failure'}]
                        yield items
        api=Failed(); data=collect(api,api,CTRL,now=NOW)
        self.assertEqual(data['rows'][0]['label'],'Failed')
        self.assertEqual(data['rows'][0]['detail'],'Failed step: Transfer PRs')
        doc=json.dumps(build_doc([data],NOW))
        self.assertIn('#42: <b>Review this</b>',doc)
        self.assertIn('DRAFT',doc)
        self.assertIn('https://github.com/B/dev-repo/pull/42',doc)

    def test_overview_is_compact_and_prs_expand_outside_table(self):
        api = Fixture()
        data = collect(api, api, CTRL, now=NOW)
        data['rows'][0].update(transport_limited=True, label='Limited', color='yellow',
                              detail='Sync continues; workflow-changing PR revisions wait for Workflows write.')
        data['rows'][1].update(transport_limited=True, label='Limited', color='yellow', pending=0, pending_prs=[])
        title = 'A long contribution title ' * 12 + '<script>plain text</script>'
        data['rows'][0]['pending_prs'][0]['title'] = title
        paths = list(api.paths)
        doc = build_doc([data], NOW)
        self.assertEqual(paths, api.paths)
        table = next(n for n in doc['content'] if n['type'] == 'table')
        expands = [n for n in doc['content'] if n['type'] == 'expand']
        self.assertEqual(len(expands), 1)
        self.assertIn('dev-repo', expands[0]['attrs']['title'])
        self.assertIn('101 open PRs', expands[0]['attrs']['title'])
        self.assertNotIn('/pull/1', json.dumps(table))
        self.assertNotIn(title, json.dumps(table))
        self.assertIn(title, json.dumps(expands[0]))
        warnings = [n for n in doc['content'] if n['type'] == 'panel' and n['attrs']['panelType'] == 'warning']
        self.assertEqual(len(warnings), 1)
        self.assertIn('2 repo pairs', json.dumps(warnings))
        self.assertEqual(json.dumps(doc).count('workflow-changing PR revisions wait'), 1)
        self.assertTrue(all(len(row['content']) == 6 for row in table['content']))

    def test_empty_queue_has_no_expands_and_failures_remain_visible(self):
        api = Fixture(); data = collect(api, api, CTRL, now=NOW)
        for row in data['rows']:
            row.update(pending=0, pending_prs=[])
        data['rows'][0].update(transport_limited=True, detail='Failed step: Transfer PRs', stale=True)
        doc = build_doc([data], NOW)
        self.assertFalse(any(n['type'] == 'expand' for n in doc['content']))
        table = next(n for n in doc['content'] if n['type'] == 'table')
        self.assertIn('Failed step: Transfer PRs', json.dumps(table))
        self.assertIn('No successful sync', json.dumps(table))
        self.assertIn('No open contribution PRs.', json.dumps(doc))

    def test_custom_target_branches_are_queried_and_displayed(self):
        from unittest.mock import patch
        from status import valid_target_branch
        for branch in ['init-demo', 'release/v1', 'develop']:
            registry = {**REGISTRY, 'pairs': [{**REGISTRY['pairs'][0], 'branch': branch}]}
            class Custom(Fixture):
                def get(self, path):
                    if 'bridge.config.json' in path:
                        return {'content': base64.b64encode(json.dumps(registry).encode()).decode()}
                    return super().get(path)
                def pages(self, path, key=None):
                    if '/pulls?' in path:
                        self.paths.append(path)
                        yield [pr('B/dev-repo', branch=branch), pr('B/dev-repo', branch='main')]
                    else:
                        yield from super().pages(path, key)
            api = Custom()
            data = collect(api, api, CTRL, now=NOW)
            self.assertEqual(data['rows'][0]['branch'], branch)
            self.assertEqual(data['rows'][0]['pending'], 1)
            self.assertIn(branch, json.dumps(build_doc([data], NOW)))
            from urllib.parse import urlencode
            self.assertTrue(any(urlencode({'base':branch}) in path for path in api.paths))
        for invalid in ['', '../x', 'x y', '-x', 'HEAD', 'x//y', 'x.lock', 'x@{y', None]:
            self.assertFalse(valid_target_branch(invalid))

    def test_credentials_are_routed_by_repository_role(self):
        class Controller(Fixture):
            def pages(self, path, key=None):
                if "/pulls?" in path: raise AssertionError("Controller token used for B PRs")
                yield from super().pages(path, key)
        class Target(Fixture):
            def get(self, path): raise AssertionError("Transport token used for controller contents")
            def pages(self, path, key=None):
                if "/pulls?" not in path: raise AssertionError("Transport token used for Actions")
                yield from super().pages(path, key)
        controller, target = Controller(), Target()
        data = collect(controller, target, CTRL, now=NOW)
        self.assertEqual([row['pending'] for row in data['rows']], [101, 1])
        self.assertTrue(all(path.startswith('/repos/B/controller/') for path in controller.paths))
        self.assertTrue(all('/pulls?' in path for path in target.paths))

    def test_transport_scope_is_only_registered_targets(self):
        self.assertEqual(transport_scope(REGISTRY, CTRL),
                         {'owner':'B', 'repositories':'dev-repo,main-repo'})
        for targets in [['B/controller'], ['B/dev-repo','Other/main-repo'], ['B/bad\nname']]:
            registry = {**REGISTRY, 'pairs':[{'target':t} for t in targets]}
            with self.assertRaises(ValueError): transport_scope(registry, CTRL)

    def test_missing_transport_token_fails_before_network(self):
        import os
        from unittest.mock import patch
        from status import main
        with patch.dict(os.environ, {'GH_TOKEN':'controller-only'}, clear=True), \
             patch('sys.argv', ['status.py','--controller',CTRL,'--out','unused.json']), \
             patch('status.GitHub.get') as read:
            with self.assertRaisesRegex(ValueError, 'TRANSPORT_READ_TOKEN'): main()
            read.assert_not_called()

    def test_registry_targets_identity_pagination_and_last_success(self):
        api=Fixture(); data=collect(api,api,CTRL,now=NOW)
        a,b=data["rows"]
        self.assertEqual([a["branch"],b["branch"]],["dev","main"])
        self.assertEqual([a["pending"],b["pending"]],[101,1])
        self.assertEqual(a["label"],"Failed")
        self.assertEqual(a["last_success"],"2026-10-26T23:01:00Z")
        self.assertTrue(any("base=dev" in p for p in api.paths))
        self.assertTrue(any("base=main" in p for p in api.paths))
        adf=build_doc([data],NOW)
        self.assertEqual(adf["type"],"doc")
        self.assertIn("Last successful sync",json.dumps(adf))
        self.assertEqual(adf["content"][0]["type"], "panel")
        self.assertEqual(adf["content"][0]["attrs"]["panelType"], "info")
        table = next(n for n in adf["content"] if n["type"] == "table")
        self.assertTrue(all(len(row["content"]) == 6 for row in table["content"]))
        self.assertIn("https://github.com/B/controller", json.dumps(adf))
        self.assertIn("No successful sync", json.dumps(build_doc([{**data,"rows":[{**a,"stale":True}]}],NOW)))
    def test_incomplete_reads_fail_instead_of_reporting_zero(self):
        with self.assertRaisesRegex(RuntimeError,"403"): collect(Fixture(),Fixture(True),CTRL,now=NOW)
    def test_missing_history_is_not_green(self):
        api=Fixture(); old=api.pages
        def pages(path,key=None):
            if path.endswith('/runs'): yield []
            else: yield from old(path,key)
        api.pages=pages
        data=collect(api,api,CTRL,now=NOW)
        self.assertTrue(all(r['label']=='Not found in scan' and r['stale'] for r in data['rows']))
    def test_get_retries_503_without_leaking_response(self):
        class Opener:
            count=0
            def open(self,req,timeout):
                self.count+=1
                if self.count==1: raise HTTPError(req.full_url,503,"token-should-not-log",{},None)
                return io.BytesIO(b'{"ok":true}')
        op=Opener(); api=GitHub('test-only-token',op,lambda _:None)
        self.assertEqual(api.get('/repos/B/r'),{'ok':True}); self.assertEqual(op.count,2)
    def test_real_pagination_reads_second_page(self):
        api=GitHub('test-only-token'); seen=[]
        def get(path):
            seen.append(path)
            return list(range(100)) if path.endswith('page=1') else [100]
        api.get=get
        self.assertEqual(len([v for page in api.pages('/repos/B/r/pulls?state=open') for v in page]),101)
        self.assertEqual(len(seen),2)

class ConfluenceTests(unittest.TestCase):
    def publisher(self, opener): return Publisher('11111111-1111-1111-1111-111111111111','123','lab@example.test','dummy',opener)
    def test_conflict_refetches_title_version_and_preserves_unicode(self):
        class Opener:
            calls=[]
            def open(self,req,timeout):
                body=json.loads(req.data) if req.data else None
                self.calls.append((req.method,body))
                count=len(self.calls)
                if count==2: raise HTTPError(req.full_url,409,'conflict',{},None)
                result=({'id':'123','status':'current','title':'Updated title' if count==3 else 'Title','version':{'number':7 if count==3 else 4}}
                        if req.method=='GET' else {'id':'123','version':{'number':8}})
                return io.BytesIO(json.dumps(result).encode())
        op=Opener(); doc={'type':'doc','version':1,'content':[{'type':'paragraph','content':[{'type':'text','text':'Tiếng Việt <script>'}]}]}
        self.assertEqual(self.publisher(op).publish(doc),8)
        self.assertEqual([m for m,_ in op.calls],['GET','PUT','GET','PUT'])
        payload=op.calls[-1][1]
        self.assertEqual(payload['title'],'Updated title')
        self.assertEqual(json.loads(payload['body']['value']),doc)
        self.assertEqual(payload['body']['representation'],'atlas_doc_format')
    def test_403_and_500_fail_with_redacted_errors(self):
        for code in [403,500]:
            class Opener:
                def open(self,req,timeout): raise HTTPError(req.full_url,code,'SECRET_BODY',{},None)
            with self.assertRaisesRegex(RuntimeError,f'HTTP {code}') as ctx:
                self.publisher(Opener()).publish({'type':'doc','version':1,'content':[]})
            self.assertNotIn('SECRET_BODY',str(ctx.exception))
    def test_persistent_conflict_has_one_retry(self):
        class Opener:
            puts=0
            def open(self,req,timeout):
                if req.method=='PUT':
                    self.puts+=1; raise HTTPError(req.full_url,409,'',{},None)
                return io.BytesIO(b'{"id":"123","title":"T","status":"current","version":{"number":1}}')
        op=Opener()
        with self.assertRaisesRegex(RuntimeError,'after retry'):self.publisher(op).publish({'type':'doc','version':1,'content':[]})
        self.assertEqual(op.puts,2)
    def test_local_http_server_contract(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from threading import Thread
        from urllib.request import Request, build_opener
        calls=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def respond(self,status,payload):
                data=json.dumps(payload).encode()
                self.send_response(status); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(data)
            def do_GET(self):
                calls.append(('GET',None))
                self.respond(200,{'id':'123','title':'HTTP lab','status':'current','version':{'number':11 if len(calls)==1 else 12}})
            def do_PUT(self):
                payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                calls.append(('PUT',payload))
                self.respond(409 if len(calls)==2 else 200, {} if len(calls)==2 else {'id':'123','version':{'number':13}})
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=Thread(target=server.serve_forever,daemon=True); thread.start()
        class LocalOpener:
            def open(self,req,timeout):
                redirected=Request(f'http://127.0.0.1:{server.server_port}/wiki/api/v2/pages/123',data=req.data,headers=req.headers,method=req.method)
                return build_opener().open(redirected,timeout=timeout)
        try:
            doc={'type':'doc','version':1,'content':[]}
            self.assertEqual(self.publisher(LocalOpener()).publish(doc),13)
            self.assertEqual([c[0] for c in calls],['GET','PUT','GET','PUT'])
            self.assertEqual(json.loads(calls[-1][1]['body']['value']),doc)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_invalid_config_fails_before_network(self):
        with self.assertRaises(ValueError): Publisher('evil.example','123','x','x')
        with self.assertRaises(ValueError): Publisher('11111111-1111-1111-1111-111111111111','../x','x','x')

if __name__ == '__main__':unittest.main()
