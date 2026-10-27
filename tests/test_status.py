import base64
import io
import json
import unittest
from datetime import datetime, timezone
from urllib.error import HTTPError
from status import GitHub, collect, build_doc
from publish import Publisher

CTRL = "B/controller"
NOW = datetime(2026,10,27,0,0,tzinfo=timezone.utc)
REGISTRY = {"controllerRepo": CTRL, "bot": "transport[bot]", "pairs": [
    {"id": "dev-pair", "source": "A/dev-repo", "target": "B/dev-repo", "branch": "dev", "team": "AI"},
    {"id": "main-pair", "source": "A/main-repo", "target": "B/main-repo"}]}

def job(pair, state="success"):
    return {"name": "Reconcile " + pair, "conclusion": state, "status": "completed", "html_url": "https://github.com/B/controller/actions/runs/1/job/1",
            "created_at": "2026-10-26T23:00:00Z", "started_at": "2026-10-26T23:00:10Z", "completed_at": "2026-10-26T23:01:00Z"}

def pr(repo, branch="dev", author="transport[bot]", head="incoming/a-pr-1"):
    return {"base": {"ref": branch}, "user": {"login": author}, "head": {"ref": head, "repo": {"full_name": repo}}}

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
    def test_registry_targets_identity_pagination_and_last_success(self):
        api=Fixture(); data=collect(api,CTRL,now=NOW)
        a,b=data["rows"]
        self.assertEqual([a["branch"],b["branch"]],["dev","main"])
        self.assertEqual([a["pending"],b["pending"]],[101,1])
        self.assertEqual(a["label"],"Failed")
        self.assertEqual(a["last_success"],"2026-10-26T23:01:00Z")
        self.assertTrue(any("base=dev" in p for p in api.paths))
        self.assertTrue(any("base=main" in p for p in api.paths))
        adf=build_doc([data],NOW)
        self.assertEqual(adf["type"],"doc")
        self.assertIn("Last successful reconcile",json.dumps(adf))
    def test_incomplete_reads_fail_instead_of_reporting_zero(self):
        with self.assertRaisesRegex(RuntimeError,"403"): collect(Fixture(True),CTRL,now=NOW)
    def test_missing_history_is_not_green(self):
        api=Fixture(); old=api.pages
        def pages(path,key=None):
            if path.endswith('/runs'): yield []
            else: yield from old(path,key)
        api.pages=pages
        data=collect(api,CTRL,now=NOW)
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
    def test_invalid_config_fails_before_network(self):
        with self.assertRaises(ValueError): Publisher('evil.example','123','x','x')
        with self.assertRaises(ValueError): Publisher('11111111-1111-1111-1111-111111111111','../x','x','x')

if __name__ == '__main__':unittest.main()
