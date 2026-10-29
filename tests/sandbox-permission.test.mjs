// Node permission model for the Claude Code host worker (SECURITY-PLAN.md agreements 3-6), with synthetic DSH plugins.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {makePlugin,spawnHost,toolHeader} from './claude-host-helpers.mjs';
import {permissionArgs,permissionFlag} from '../lib/dsh-host.mjs';
import {sandboxPlan,secretNames,extraFolders} from '../lib/claude-host/host.mjs';
import {blockedText,createBlockedReporter,permissionNotice} from '../lib/modules/claude/blocked.mjs';
import {requireExecApproval} from '../lib/modules/claude/exec-support.mjs';

const node=process.execPath;
const runNode=process.platform==='win32'?`& '${node}' -p 6*7`:`'${node}' -p 6*7`;
const services=['shell','subprocess','credentials'];
const source=toolHeader+`import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
export const name='syn-sandbox';export const inject=['tools',${services.map(s=>`'${s}'`).join(',')}];
export function apply(ctx){
  ctx.tools.register(tool('read_file',async a=>fs.readFileSync(a.path,'utf8'),{parameters:{path:{type:'string'}}}));
  ctx.tools.register(tool('direct_spawn',async()=>{const r=spawnSync(process.execPath,['-e','process.stdout.write(String(7*6))']);if(r.error)throw r.error;return {status:r.status,out:String(r.stdout)};}));
  ctx.tools.register(tool('probe_spawn',async()=>{try{spawnSync('uv',['--version']);return 'ran';}catch(e){return 'caught '+e.code;}}));
  ctx.tools.register(tool('sh',async a=>{const run=await ctx.shell.execute(ctx.shell.resolve({command:a.command,timeoutMs:20000}));const r=await run.result();return {exitCode:r.exitCode,out:r.stdout.text.trim()};},{parameters:{command:{type:'string'}}}));
  ctx.tools.register(tool('env_has',async a=>({present:typeof process.env[a.name]==='string'}),{parameters:{name:{type:'string'}}}));
  ctx.tools.register(tool('cred',async a=>{const r=await ctx.credentials.resolve(a.ref);return {length:r.value.length};},{parameters:{ref:{type:'string'}}}));
}`;
const plan={host:{services}};
const call=(host,name,args={})=>host.rpc('tools.call',{name,args,callId:`${name}-${Math.random()}`});
const text=result=>result.content.map(x=>x.text).join('\n');
const json=result=>{assert.equal(result.isError,false,text(result));return JSON.parse(text(result));};
const notices=host=>host.lines.filter(l=>l.type==='request'&&l.method==='ui.notify').map(l=>l.params);
const fourParts=value=>{for(const label of ['[被擋下]','原因：','怎麼放行：','影響：','（代碼：'])assert.ok(value.includes(label),`missing ${label} in: ${value}`);};

async function outsideFile(t){
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sandbox-outside-')));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}).catch(()=>{}));
  const file=path.join(dir,'secret-notes.txt');await fs.writeFile(file,'outside text');
  return {dir,file};
}
async function start(t,{answer=async()=>({}),env={},settings={},code=source}={}){
  const root=await makePlugin(t,code,{plan,...settings});
  const host=await spawnHost(t,root,{answer,env});
  const ready=await host.ready();
  return {root,host,ready};
}

test('permission flags: --permission on this Node, folders and switches; nothing for the Codex host (no permission option)',()=>{
  assert.equal(permissionFlag(new Set(['--permission'])),'--permission');
  assert.equal(permissionFlag(new Set(['--experimental-permission'])),'--experimental-permission');
  assert.equal(permissionFlag(new Set()),null);
  assert.equal(permissionFlag(),'--permission','Node 24 has the stable flag');
  const base=path.resolve(os.tmpdir(),'x');
  assert.deepEqual(permissionArgs({read:[base,base,'relative'],write:[base]},'--permission'),['--permission',`--allow-fs-read=${base}`,`--allow-fs-write=${base}`]);
  assert.deepEqual(permissionArgs({read:[],write:[],childProcess:true,worker:true,addons:true,wasi:true},'--permission'),['--permission','--allow-child-process','--allow-worker','--allow-addons','--allow-wasi']);
  assert.deepEqual(permissionArgs(undefined),[]);
  assert.deepEqual(permissionArgs({read:[base]},null),[],'an old Node starts the worker normally');
});

test('sandbox plan: allowed folders, DSH_CLAUDE_EXTRA_FOLDERS, allowDirectExec, and an old Node is reported',()=>{
  const root=path.resolve(os.tmpdir(),'plug'),state=path.resolve(os.tmpdir(),'state'),ws=path.resolve(os.tmpdir(),'ws'),extra=path.resolve(os.tmpdir(),'extra');
  const args={root,stateDir:state,workspace:ws,runtimeRoot:path.join(root,'runtime','host-env'),workerPath:path.join(root,'runtime','w.mjs')};
  const on=sandboxPlan({...args,env:{DSH_CLAUDE_EXTRA_FOLDERS:`${extra};relative\\dir`},flag:'--permission'});
  assert.equal(on.info.enabled,true);
  for(const dir of [root,state,ws,extra])assert.ok(on.permission.read.includes(dir),dir);
  for(const dir of [state,ws,extra])assert.ok(on.permission.write.includes(dir),dir);
  assert.ok(!on.permission.write.includes(root),'the plugin folder is read only');
  assert.equal(on.permission.childProcess,false);assert.equal(on.permission.addons,false);assert.equal(on.permission.worker,false);
  assert.deepEqual(on.info.ignoredExtraFolders,['relative\\dir']);
  const direct=sandboxPlan({...args,env:{DSH_CLAUDE_ALLOW_DIRECT_EXEC:'1'},flag:'--permission'});
  assert.equal(direct.permission.childProcess,true);assert.equal(direct.permission.addons,true);
  const old=sandboxPlan({...args,env:{},flag:null});
  assert.equal(old.permission,null);assert.equal(old.info.enabled,false);assert.match(old.info.reason,/此電腦的 Node 版本不支援權限限制/);
  const off=sandboxPlan({...args,env:{},settings:{claudeHost:{sandbox:false}},flag:'--permission'});
  assert.equal(off.permission,null);
  assert.deepEqual(extraFolders({DSH_CLAUDE_EXTRA_FOLDERS:` ${extra} ; ;"${extra}"`}).accepted,[extra]);
  assert.deepEqual(secretNames({DSH_CLAUDE_SECRET_NAMES:'TAVILY_API_KEY, bad name,DSH_CLAUDE_X,NODE_OPTIONS,OTHER_TOKEN'}),['TAVILY_API_KEY','OTHER_TOKEN']);
});

test('blocked notices: four parts in Traditional Chinese; one notice per kind of block',()=>{
  const read=permissionNotice({code:'ERR_ACCESS_DENIED',permission:'FileSystemRead',resource:'\\\\?\\D:\\notes'},{plugin:'obsidian',feature:'search_notes'});
  const textValue=blockedText({...read,code:'ERR_ACCESS_DENIED'});
  fourParts(textValue);assert.match(textValue,/D:\\notes/);assert.match(textValue,/extraFolders/);assert.ok(!textValue.includes('\\\\?\\'));
  const exec=permissionNotice({code:'ERR_ACCESS_DENIED',permission:'ChildProcess',resource:'cloudflared'},{plugin:'websearch'});
  assert.match(exec.what,/cloudflared/);assert.match(exec.how,/allowDirectExec/);assert.equal(exec.impact,'插件無法啟動');
  const sent=[];const reporter=createBlockedReporter({notify:value=>sent.push(value)});
  assert.equal(reporter.report({...read,code:'ERR_ACCESS_DENIED'}),true);assert.equal(reporter.report({...read,code:'ERR_ACCESS_DENIED'}),false);
  assert.equal(sent.length,1);assert.equal(reporter.list()[0].count,2);
});

test('exec.check: allow runs, deny does not (reason shown), old mods (UNKNOWN_METHOD / UNSUPPORTED) fall back to approval.request',async()=>{
  const base={module:'shell',method:'execute',toolName:'shell',commandName:'git',commandText:'git status',cwd:os.tmpdir(),args:{command:'git status'},plugin:'syn',feature:'sync'};
  const seen=[];
  await requireExecApproval({...base,requestHost:async(method,params)=>{seen.push({method,params});return {decision:'allow'};}});
  assert.deepEqual(seen,[{method:'exec.check',params:{tool:'Bash',command:'git status',cwd:os.tmpdir(),why:'「syn」插件的「sync」功能要執行 git'}}]);
  const denied=await requireExecApproval({...base,requestHost:async()=>({decision:'deny',reason:'Bash(git:*) is denied by your settings'})}).catch(e=>e);
  assert.equal(denied.code,'DSH_EXEC_DENIED');fourParts(denied.message);assert.match(denied.message,/denied by your settings/);assert.match(denied.message,/git/);
  for(const code of ['UNKNOWN_METHOD','UNSUPPORTED']){
    const methods=[];
    await requireExecApproval({...base,requestHost:async method=>{methods.push(method);if(method==='exec.check')throw Object.assign(new Error('?'),{code});return {approved:true};}});
    assert.deepEqual(methods,['exec.check','approval.request']);
  }
  await assert.rejects(requireExecApproval({...base,requestHost:async()=>({approved:true})}),{code:'DSH_EXEC_DENIED'},'an answer without a decision is not an allow');
});

test('reading a file outside the allowed folders is blocked; the message names the path and extraFolders; one notice; status lists it',async t=>{
  const outside=await outsideFile(t);
  const {host,ready}=await start(t);
  assert.equal(ready.metadata.sandbox.enabled,true);assert.equal(ready.metadata.sandbox.flag,'--permission');
  const first=await call(host,'read_file',{path:outside.file});
  assert.equal(first.isError,true);
  const message=text(first);fourParts(message);
  assert.ok(message.includes(outside.file),message);assert.match(message,/extraFolders/);assert.match(message,/ERR_ACCESS_DENIED/);assert.match(message,/「read_file」功能無法使用/);
  assert.ok(!message.includes('outside text'));
  await call(host,'read_file',{path:outside.file});
  await host.next(l=>l.type==='request'&&l.method==='ui.notify');
  await new Promise(resolve=>setTimeout(resolve,200));
  const sent=notices(host);
  assert.equal(sent.length,1,'the same block is notified once per session');
  assert.equal(sent[0].level,'warning');fourParts(sent[0].text);
  const status=await host.rpc('status');
  const row=status.restricted.find(item=>item.kind==='fs-read');
  assert.ok(row,JSON.stringify(status.restricted));assert.equal(row.count,2);assert.match(row.how,/extraFolders/);
  assert.equal(status.sandbox.enabled,true);
});

test('DSH_CLAUDE_EXTRA_FOLDERS lets the plugin read that folder',async t=>{
  const outside=await outsideFile(t);
  const {host,ready}=await start(t,{env:{DSH_CLAUDE_EXTRA_FOLDERS:outside.dir}});
  assert.ok(ready.metadata.sandbox.extraFolders.includes(outside.dir));
  assert.equal(text(await call(host,'read_file',{path:outside.file})).includes('outside text'),true);
});

test('a plugin that calls child_process itself is blocked unless allowDirectExec is on',async t=>{
  const blocked=await start(t);
  const result=await call(blocked.host,'direct_spawn');
  assert.equal(result.isError,true);
  const message=text(result);fourParts(message);
  assert.match(message,/想直接執行程式 node/);assert.match(message,/allowDirectExec/);
  // A plugin that catches the error itself ("uv is not installed") still produces the notice and a status row.
  assert.equal(text(await call(blocked.host,'probe_spawn')),'caught ERR_ACCESS_DENIED');
  const notice=await blocked.host.next(l=>l.type==='request'&&l.method==='ui.notify'&&/直接執行程式 uv/.test(l.params.text));
  // The mod asks whether to trust the plugin on this kind (templates/claude-mod/register.ts DIRECT_EXEC_KINDS).
  assert.equal(notice.params.blocked?.kind,'exec');
  assert.ok((await blocked.host.rpc('status')).restricted.some(row=>row.kind==='exec'&&/uv/.test(row.what)));
  const allowed=await start(t,{env:{DSH_CLAUDE_ALLOW_DIRECT_EXEC:'1'}});
  assert.equal(allowed.ready.metadata.sandbox.allowDirectExec,true);
  assert.deepEqual(json(await call(allowed.host,'direct_spawn')),{status:0,out:'42'});
});

test('shell service under the permission model: the host runs it after exec.check; deny means nothing runs, with a notice',async t=>{
  const checks=[];let decision={decision:'allow'};
  const {host,root,ready}=await start(t,{answer:async(method,params)=>{if(method==='exec.check'){checks.push(params);return decision;}return {};}});
  assert.equal(ready.metadata.sandbox.enabled,true);
  assert.deepEqual(json(await call(host,'sh',{command:runNode})),{exitCode:0,out:'42'});
  assert.equal(checks.length,1);assert.equal(checks[0].tool,'Bash');assert.equal(checks[0].command,runNode);
  assert.ok(path.isAbsolute(checks[0].cwd));assert.match(checks[0].why,/「syn-sandbox」插件|「synthetic」插件/);assert.match(checks[0].why,/「sh」功能/);
  assert.deepEqual(host.lines.filter(l=>l.type==='request'&&l.method==='approval.request'),[],'exec.check replaces the per-command approval prompt');
  decision={decision:'deny',reason:'Permission to use Bash has been denied.'};
  const marker=path.join(root,'source','marker.txt');
  const writeMarker=process.platform==='win32'?`Set-Content -Path '${marker}' -Value ran`:`echo ran > '${marker}'`;
  const refused=await call(host,'sh',{command:writeMarker});
  assert.equal(refused.isError,true);
  const message=text(refused);fourParts(message);assert.match(message,/DSH_EXEC_DENIED/);assert.match(message,/Permission to use Bash has been denied/);
  await assert.rejects(fs.access(marker),'the command never ran');
  await host.next(l=>l.type==='request'&&l.method==='ui.notify'&&/DSH_EXEC_DENIED/.test(l.params.text));
});

test('secrets: only the names in DSH_CLAUDE_SECRET_NAMES reach the worker; a missing secret names the secret_<NAME> option',async t=>{
  const {host}=await start(t,{env:{DSH_CLAUDE_SECRET_NAMES:'SYN_SECRET_A,SYN_SECRET_MISSING',SYN_SECRET_A:'value-not-logged-1',SYN_OTHER_KEY:'value-not-logged-2'}});
  assert.deepEqual(json(await call(host,'env_has',{name:'SYN_SECRET_A'})),{present:true});
  assert.deepEqual(json(await call(host,'env_has',{name:'SYN_OTHER_KEY'})),{present:false});
  assert.deepEqual(json(await call(host,'cred',{ref:'SYN_SECRET_A'})),{length:'value-not-logged-1'.length});
  const missing=await call(host,'cred',{ref:'SYN_SECRET_MISSING'});
  assert.equal(missing.isError,true);const message=text(missing);fourParts(message);
  assert.match(message,/secret_SYN_SECRET_MISSING/);assert.match(message,/DSH_CREDENTIAL_MISSING/);
  const everything=JSON.stringify(host.lines)+host.stderr.join('');
  assert.ok(!everything.includes('value-not-logged'),'secret values never appear in protocol lines or logs');
});

test('interception: a plugin with listeners reports interception false until allowInterception is on, with a note',async t=>{
  const code=toolHeader+`export const inject=['tools'];export function apply(ctx){ctx.on('tools/pre-execute',exec=>exec.name==='Bash'?{kind:'deny',reason:'no'}:undefined);ctx.tools.register(tool('plain',async()=>1));}`;
  const off=await start(t,{code,settings:{plan:{}}});
  assert.equal(off.ready.interception,false);
  assert.match(off.ready.metadata.interceptionState.note,/插件有攔截監聽器但使用者沒有開啟/);
  assert.deepEqual(await off.host.rpc('interception.pre',{tool:'Bash',input:{}}),{decision:'allow'});
  const status=await off.host.rpc('status');assert.ok(status.restricted.some(row=>row.kind==='interception-off'));
  const on=await start(t,{code,settings:{plan:{}},env:{DSH_CLAUDE_ALLOW_INTERCEPTION:'1'}});
  assert.equal(on.ready.interception,true);
  const verdict=await on.host.rpc('interception.pre',{tool:'Bash',input:{command:'ls'}});
  assert.deepEqual(verdict,{decision:'deny',reason:'no'});assert.ok(!('input' in verdict),'no rewritten input travels back');
});

test('start-up: reading outside the allowed folders while the plugin starts gives a fatal four-part message',async t=>{
  const outside=await outsideFile(t);
  const code=`import fs from 'node:fs';export const name='syn-startup';export function apply(){fs.readFileSync(${JSON.stringify(outside.file)});}`;
  const root=await makePlugin(t,code,{});
  const host=await spawnHost(t,root,{});
  const fatal=await host.fatal();
  assert.equal(fatal.code,'ERR_ACCESS_DENIED');
  fourParts(fatal.message);assert.ok(fatal.message.includes(outside.file),fatal.message);assert.match(fatal.message,/插件無法啟動/);
  assert.ok(host.lines.some(l=>l.type==='request'&&l.method==='ui.notify'&&l.params.level==='warning'));
});

test('start-up: a configuration that does not validate names the setting and the secret option',async t=>{
  const code=`export const name='syn-config';
export const Config={'~standard':{version:1,vendor:'syn',validate:value=>typeof value?.apiKey==='string'?{value}:{issues:[{message:'expected string but got undefined',path:['apiKey']}]}}};
export function apply(){}`;
  const root=await makePlugin(t,code,{entries:[{id:'syn-config',entry:'index.mjs',config:{apiKey:{$dshExpression:'process.env.SYN_CFG_KEY'}}}],passEnv:['SYN_CFG_KEY']});
  const host=await spawnHost(t,root,{});
  const fatal=await host.fatal();
  assert.equal(fatal.code,'PLUGIN_CONFIG_INVALID',fatal.message);
  assert.match(fatal.message,/apiKey/);assert.match(fatal.message,/SYN_CFG_KEY/);assert.match(fatal.message,/secret_SYN_CFG_KEY/);
  assert.deepEqual(fatal.missing,[{path:'apiKey',env:'SYN_CFG_KEY',option:'secret_SYN_CFG_KEY'}]);
});

test('official file service (ctx.fs) inside the workspace: create, overwrite (Windows DACL/ReplaceFileW in the host), read, realpath',async t=>{
  const ws=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sandbox-ws-')));
  t.after(()=>fs.rm(ws,{recursive:true,force:true}).catch(()=>{}));
  const code=toolHeader+`import nodeFs from 'node:fs';export const name='syn-fs';export const inject=['tools','fs'];export function apply(ctx){
    ctx.tools.register(tool('memo',async a=>{
      const target=await ctx.fs.resolve('.dsh/memo.md',{});
      const before=await ctx.fs.stat(target);
      const existing=before!==undefined?await ctx.fs.readText(target):'';
      await ctx.fs.writeText(target,existing+a.line+'\\n');
      return {text:await ctx.fs.readText(target),real:nodeFs.realpathSync(ctx.fs.processPath(target))===ctx.fs.processPath(target)};
    },{parameters:{line:{type:'string'}}}));
  }`;
  const {host}=await start(t,{code,settings:{plan:{host:{services:['fs']}}},env:{DSH_CLAUDE_WORKSPACE:ws}});
  assert.deepEqual(json(await call(host,'memo',{line:'hello -> bonjour'})),{text:'hello -> bonjour\n',real:true});
  assert.deepEqual(json(await call(host,'memo',{line:'cat -> chat'})),{text:'hello -> bonjour\ncat -> chat\n',real:true},'the second write replaces an existing file');
  assert.equal(await fs.readFile(path.join(ws,'.dsh','memo.md'),'utf8'),'hello -> bonjour\ncat -> chat\n');
  assert.deepEqual(notices(host),[],'nothing was blocked');
});

test('notices for a denial without a resource name the operation; a descriptor API is explained',()=>{
  const plain=permissionNotice({code:'ERR_ACCESS_DENIED',permission:'FileSystemRead',resource:''},{plugin:'p',feature:'f'});
  assert.match(plain.what,/Node 沒有提供路徑/);
  const withPath=permissionNotice({code:'ERR_ACCESS_DENIED',permission:'FileSystemRead',resource:'',attemptedPath:'D:\\x\\y.txt',operation:'statSync'},{plugin:'p'});
  assert.match(withPath.what,/D:\\x\\y\.txt/);assert.match(withPath.what,/statSync/);
  const fd=permissionNotice({code:'ERR_ACCESS_DENIED',message:'fchown API is disabled when Permission Model is enabled.'},{plugin:'p',feature:'f'});
  assert.equal(fd.kind,'disabled-api');assert.match(fd.why,/fchown/);
});
