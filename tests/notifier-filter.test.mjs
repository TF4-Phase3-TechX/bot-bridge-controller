import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const template = readFileSync(new URL('../templates/notifier/notify-controller.yml',import.meta.url),'utf8').replaceAll('\r\n','\n');
for(const branch of ['main','dev','init-demo','release/v1']) {
  const yaml = template.replaceAll('TARGET_BRANCH',branch);
  const expr = yaml.split('    if: >-\n')[1].split('    runs-on:')[0].trim();
  const node = yaml.split("node --input-type=module <<'NODE'\n")[1].split('          NODE')[0].split('\n').map(l=>l.slice(10)).join('\n').replace("import { appendFileSync } from 'node:fs';",'');
  const pr=(repo,ref=branch,author='TRANSPORT_BOT[bot]',head='incoming/a-pr-5')=>({number:5,base:{ref},head:{ref:head,repo:{full_name:repo}},user:{login:author}});
  const cases=[
    ['A PR accepted','A_OWNER/A_REPO','pull_request_target','human','User',pr('A_OWNER/A_REPO',branch,'human','feature'),true],
    ['A wrong target','A_OWNER/A_REPO','pull_request_target','human','User',pr('A_OWNER/A_REPO',branch==='dev'?'main':'dev','human','feature'),false],
    ['B internal PR','B_OWNER/B_REPO','pull_request_target','human','User',pr('B_OWNER/B_REPO',branch,'human','feature'),false],
    ['B bridge review','B_OWNER/B_REPO','pull_request_review','human','User',pr('B_OWNER/B_REPO'),true],
    ['B human push','B_OWNER/B_REPO','push','human','User',null,true],
    ['B transport echo','B_OWNER/B_REPO','push','TRANSPORT_BOT[bot]','Bot',null,false],
    ['A push','A_OWNER/A_REPO','push','human','User',null,false],
    ['bot comment echo','B_OWNER/B_REPO','issue_comment','TRANSPORT_BOT[bot]','Bot',pr('B_OWNER/B_REPO'),false],
  ];
  for(const [label,repo,event,login,type,p,expected] of cases) test(`${branch}: ${label} job gate`,()=>{
    const github={repository:repo,event_name:event,ref:'refs/heads/incoming/a-pr-5',event:{sender:{login,type},pull_request:p,issue:{pull_request:{}}}};
    const actual=vm.runInNewContext(expr,{github,startsWith:(s,p)=>s?.startsWith(p)===true});
    assert.equal(actual,expected);
  });
  for(const [label,repo,p,allowed] of [
    ['A feature comment','A_OWNER/A_REPO',pr('A_OWNER/A_REPO',branch,'human','feature'),true],
    ['B internal comment','B_OWNER/B_REPO',pr('B_OWNER/B_REPO',branch,'human','feature'),false],
    ['B spoofed prefix','B_OWNER/B_REPO',pr('B_OWNER/B_REPO',branch,'TRANSPORT_BOT[bot]','incoming/a-pr-fake'),false],
    ['B bridge comment','B_OWNER/B_REPO',pr('B_OWNER/B_REPO'),true],
    ['A retargeted comment','A_OWNER/A_REPO',pr('A_OWNER/A_REPO',branch==='dev'?'main':'dev'),false],
  ]) test(`${branch}: ${label} live scope`,async()=>{
    let output='';
    await vm.runInNewContext(`(async()=>{${node}})()`,{
      process:{env:{GH_TOKEN:'test-token',SOURCE_REPO:repo,SOURCE_EVENT:'issue_comment',SOURCE_PR:'5',GITHUB_OUTPUT:'mock'}},
      appendFileSync:(_path,value)=>{output+=value;},fetch:async()=>({ok:true,json:async()=>p}),AbortSignal,console:{log(){}},
    });
    assert.equal(output,`allowed=${allowed}\n`);
  });
}
