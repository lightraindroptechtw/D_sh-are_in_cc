// shell and subprocess modules of the Claude host, called directly (no child host).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createClaudeShellService,shellArgv} from '../lib/modules/claude/shell.mjs';
import {createClaudeSubprocessService} from '../lib/modules/claude/subprocess.mjs';
import {TailCollector,findExecutable,insideWorkspace,mergeEnv,programName,resolveWorkdir,scrubbedEnv} from '../lib/modules/claude/exec-support.mjs';

const node=process.execPath;
const q=value=>process.platform==='win32'?`& '${value}'`:`'${value}'`;
async function workspace(t){
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'claude-exec-ws-')));
  t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  return dir;
}
const script=async(ws,name,code)=>{await fs.writeFile(path.join(ws,name),code);return `${q(node)} ${process.platform==='win32'?`'${path.join(ws,name)}'`:`'${path.join(ws,name)}'`}`;};
// Plays a mod built before exec.check (it answers UNKNOWN_METHOD), so these tests exercise the approval.request fallback; exec.check has its own tests.
const approver=(verdict={approved:true})=>{const asked=[];return {asked,requestHost:async(method,params)=>{if(method==='exec.check')throw Object.assign(new Error('unknown'),{code:'UNKNOWN_METHOD'});asked.push({method,params});if(typeof verdict==='function')return verdict(params);if(verdict instanceof Error)throw verdict;return verdict;}};};

test('programName: only the program, never an argument; paths with spaces and quotes work',()=>{
  assert.equal(programName("& 'C:\\Program Files\\nodejs\\node.exe' -p 1+1"),'node');
  assert.equal(programName('"/usr/bin/git" push --force secret-branch'),'git');
  assert.equal(programName('curl -sS https://example.invalid/?k=SECRET'),'curl');
  assert.equal(programName('C:\\Program Files\\x\\tool.exe',{literal:true}),'tool');
  assert.equal(programName('   '),'unknown');
  assert.ok(!programName('rm -rf / --no-preserve-root').includes('-rf'));
});

test('environment: credential-shaped names and DSH_* are dropped; explicit entries survive; undefined removes',()=>{
  const base={PATH:'p',HOME:'h',MY_API_KEY:'k',GITHUB_TOKEN:'t',DB_PASSWORD:'x',SOME_SECRET:'s',DSH_HOME:'d',dsh_lower:'d'};
  assert.deepEqual(scrubbedEnv(base),{PATH:'p',HOME:'h'});
  const merged=mergeEnv({EXTRA_TOKEN:'explicit',PATH:undefined},{DSH_FACT:'1'});
  assert.equal(merged.EXTRA_TOKEN,'explicit');assert.equal(merged.DSH_FACT,'1');assert.equal(merged.PATH,undefined);
});

test('TailCollector: keeps the tail, offsets are whole-stream, a stale offset is lossy',()=>{
  const c=new TailCollector(5);c.push('abc');c.push('defgh');
  assert.deepEqual(c.readFrom(0),{text:'defgh',nextOffset:8,lossy:true});
  assert.deepEqual(c.readFrom(6),{text:'gh',nextOffset:8,lossy:false});
  assert.equal(c.truncated,true);assert.equal(c.text,'defgh');
});

test('resolveWorkdir: inside the workspace only (relative paths, .., and a missing folder are refused)',async t=>{
  const ws=await workspace(t);await fs.mkdir(path.join(ws,'sub'));
  assert.equal(resolveWorkdir('m','x',ws,undefined),ws);
  assert.equal(resolveWorkdir('m','x',ws,'sub'),path.join(ws,'sub'));
  assert.throws(()=>resolveWorkdir('m','x',ws,'..'),/DSH_EXEC_CWD_OUTSIDE_WORKSPACE|工作目錄/);
  assert.throws(()=>resolveWorkdir('m','x',ws,path.parse(ws).root),/工作目錄/);
  assert.throws(()=>resolveWorkdir('m','x',ws,'missing'),/不存在/);
  assert.throws(()=>resolveWorkdir('m','x',null,undefined),/DSH_CLAUDE_WORKSPACE/);
  assert.equal(insideWorkspace(ws,path.join(ws,'sub')),true);assert.equal(insideWorkspace(ws,os.tmpdir()),false);
});

test('shellArgv: PowerShell with an encoded script on Windows, bash -c elsewhere',()=>{
  const win=shellArgv('Get-Date; echo "a b"','win32');
  assert.equal(win[0],'powershell.exe');assert.ok(win.includes('-EncodedCommand'));
  assert.match(Buffer.from(win.at(-1),'base64').toString('utf16le'),/Get-Date; echo "a b"\n.*LASTEXITCODE/s);
  assert.deepEqual(shellArgv('echo hi','linux',()=>true),['/bin/bash','-c','echo hi']);
  assert.deepEqual(shellArgv('echo hi','linux',()=>false),['/bin/sh','-c','echo hi']);
});

test('findExecutable: absolute path, bare name on PATH, relative path with a separator is refused',()=>{
  assert.equal(findExecutable(node),node);
  assert.ok(findExecutable('node',{...process.env}));
  assert.equal(findExecutable('./node'),null);
  assert.equal(findExecutable('definitely-not-a-real-program-xyz'),null);
});

test('shell.resolve: defaults, caps, and a request that is not a command',async t=>{
  const ws=await workspace(t);
  const {service}=createClaudeShellService({requestHost:async()=>({approved:true}),workspace:ws});
  const spec=service.resolve({command:'echo hi',timeoutMs:99999999,sandboxPolicy:{mode:'x'}});
  assert.equal(spec.workdir,ws);assert.equal(spec.timeoutMs,600000);assert.equal(spec.onExpiry,'kill');assert.equal(spec.sandboxPolicy,undefined);
  assert.equal(service.resolve({command:'echo hi'}).timeoutMs,120000);
  assert.throws(()=>service.resolve({command:'  '}),/command/);
  assert.equal(service.sandboxMode,undefined);
  assert.throws(()=>service.nonsense(),/DSH_MODULE_UNSUPPORTED|nonsense/);
});

test('shell.execute: approval first, then the command runs; output, exit code, stdin and env',async t=>{
  const ws=await workspace(t);const {asked,requestHost}=approver();
  const {service,dispose}=createClaudeShellService({requestHost,workspace:ws});t.after(dispose);
  const command=await script(ws,'echo.js','process.stdin.on("data",d=>process.stdout.write("in:"+d));process.stdout.write(process.env.SYN_VALUE+"|"+process.env.SYN_API_KEY);process.stderr.write("err!");');
  const run=await service.execute(service.resolve({command,stdin:'hello',env:{SYN_VALUE:'v'}}));
  const result=await run.result();
  assert.equal(result.exitCode,0);assert.equal(result.timedOut,false);assert.equal(result.aborted,false);
  assert.match(result.stdout.text,/^v\|undefined/);assert.match(result.stdout.text,/in:hello/);assert.match(result.stderr.text,/err!/);
  assert.equal(run.status,'completed');
  assert.equal(asked.length,1);assert.equal(asked[0].method,'approval.request');
  assert.equal(asked[0].params.toolName,'shell');assert.match(asked[0].params.reason,/^Run the local program "node" on this computer:\n.*echo\.js/);assert.match(asked[0].params.reason,/\n工作目錄：/);
  const wire=JSON.stringify(asked[0].params);
  assert.ok(!wire.includes('hello')&&!wire.includes('"v"'),'values never travel');
  assert.ok(!wire.includes('process.stdin'),'the command text never travels');
  assert.match(run.readOutput().delta,/in:hello/);assert.equal(run.readOutput().delta,'','a second read is empty (consuming)');
  assert.equal(await run.done,undefined);
});

test('shell.execute: no, anything else, an outage and DISABLED all stop before a process exists',async t=>{
  const ws=await workspace(t);const marker=path.join(ws,'marker.txt');
  const command=await script(ws,'mark.js',"require('fs').writeFileSync('marker.txt','ran')");
  const cases=[
    [{approved:false},/DSH_EXEC_DENIED|沒有核准/],[{},/沒有核准/],[null,/沒有核准/],[{approved:'true'},/沒有核准/],
    [Object.assign(new Error('timed out'),{code:'REVERSE_REQUEST_TIMEOUT'}),/無法取得使用者核准/],
    [Object.assign(new Error('prompts are off'),{code:'DISABLED'}),/prompts are off/],
  ];
  for(const [verdict,pattern] of cases){
    const {service}=createClaudeShellService({requestHost:approver(verdict).requestHost,workspace:ws});
    await assert.rejects(service.execute(service.resolve({command})),pattern);
  }
  const noChannel=createClaudeShellService({workspace:ws}).service;
  await assert.rejects(noChannel.execute(noChannel.resolve({command})),/反向請求通道/);
  await assert.rejects(fs.access(marker),'the command never ran');
});

test('shell.execute: a bad directory is refused before any approval is asked',async t=>{
  const ws=await workspace(t);const {asked,requestHost}=approver();
  const {service}=createClaudeShellService({requestHost,workspace:ws});
  await assert.rejects(service.execute(service.resolve({command:'echo x',workdir:path.parse(ws).root})),/工作目錄/);
  assert.equal(asked.length,0);
  const noWs=createClaudeShellService({requestHost}).service;
  await assert.rejects(noWs.execute(noWs.resolve({command:'echo x'})),/DSH_CLAUDE_WORKSPACE/);
  assert.equal(asked.length,0);
});

test('shell.execute: timeout kills (timedOut), abort kills (aborted), a non-zero exit is a result, not an error',async t=>{
  const ws=await workspace(t);const {requestHost}=approver();
  const {service,dispose}=createClaudeShellService({requestHost,workspace:ws});t.after(dispose);
  const sleeper=await script(ws,'sleep.js','setTimeout(()=>{},60000)');
  const timed=await (await service.execute(service.resolve({command:sleeper,timeoutMs:400}))).result();
  assert.equal(timed.timedOut,true);assert.equal(timed.aborted,false);assert.equal(timed.timeoutMs,400);
  const controller=new AbortController();
  const running=await service.execute(service.resolve({command:sleeper,signal:controller.signal}));
  setTimeout(()=>controller.abort(),300);
  const aborted=await running.result();
  assert.equal(aborted.aborted,true);assert.equal(aborted.timedOut,false);assert.equal(running.status,'killed');
  const failed=await (await service.execute(service.resolve({command:await script(ws,'exit3.js','process.exit(3)')}))).result();
  assert.equal(failed.exitCode,3);
  const handle=await service.execute(service.resolve({command:sleeper,onExpiry:'none',timeoutMs:100}));
  await new Promise(r=>setTimeout(r,400));
  assert.equal(handle.status,'running','onExpiry none arms no deadline');
  assert.equal(handle.kill(),true);await handle.done;assert.equal(handle.kill(),false);
});

test('subprocess.spawn: validation is synchronous; a cwd outside the workspace throws before any approval',async t=>{
  const ws=await workspace(t);const {asked,requestHost}=approver();
  const {service}=createClaudeSubprocessService({requestHost,workspace:ws});
  const base={argv:[node,'-e','1'],cwd:ws,stdio:{stdin:'ignore',stdout:{maxBytes:10},stderr:{maxBytes:10}},graceMs:100};
  assert.throws(()=>service.spawn({...base,cwd:path.parse(ws).root}),/工作目錄/);
  assert.throws(()=>service.spawn({...base,argv:[]}),/argv/);
  assert.throws(()=>service.spawn({...base,graceMs:0}),/graceMs/);
  assert.throws(()=>service.spawn({...base,stdio:{...base.stdio,stdout:'bogus'}}),/stdout/);
  assert.throws(()=>service.spawn({...base,stdio:{...base.stdio,control:'pipe'}}),/control/);
  const aborted=new AbortController();aborted.abort();
  assert.throws(()=>service.spawn({...base,signal:aborted.signal}),/已取消/);
  assert.equal(asked.length,0);
  assert.throws(()=>service.spawnTerminal({}),/DSH_MODULE_UNSUPPORTED|spawnTerminal|PTY/);
  assert.deepEqual(Object.keys(await service.terminalEnvironment()).sort(),['defaultShell','platform']);
});

test('subprocess.spawn: approval, collected output, piped stdin/stdout, exit facts',async t=>{
  const ws=await workspace(t);const {asked,requestHost}=approver();
  const {service,dispose}=createClaudeSubprocessService({requestHost,workspace:ws});t.after(dispose);
  const collected=service.spawn({argv:[node,'-e','process.stdout.write("out-"+process.env.SYN_KEY_TOKEN);process.stderr.write("e");process.exit(2)'],cwd:ws,env:{SYN_KEY_TOKEN:'explicit'},stdio:{stdin:'ignore',stdout:{maxBytes:1024},stderr:{maxBytes:1024}},graceMs:200});
  assert.deepEqual(await collected.done,{exitCode:2,signal:null});
  assert.equal(collected.collected.stdout.readFrom(0).text,'out-explicit');assert.equal(collected.collected.stderr.readFrom(0).text,'e');
  assert.equal(await collected.waitForExit(),true);
  const piped=service.spawn({argv:[node,'-e','process.stdin.pipe(process.stdout)'],cwd:ws,stdio:{stdin:'pipe',stdout:'pipe',stderr:{maxBytes:64}},graceMs:200});
  piped.stdin.end('echo me');
  let text='';for await(const chunk of piped.stdout)text+=chunk;
  assert.equal(text,'echo me');assert.equal((await piped.done).exitCode,0);
  const data=service.spawn({argv:[node,'-e','process.stdin.pipe(process.stdout)'],cwd:ws,stdio:{stdin:{data:'batch'},stdout:{maxBytes:64},stderr:'inherit'},graceMs:200});
  await data.done;assert.equal(data.collected.stdout.readFrom(0).text,'batch');
  assert.equal(asked.length,3);for(const item of asked){assert.equal(item.params.toolName,'subprocess');assert.match(item.params.reason,/"node"/);}
  // The person sees the command line and folder they approve; environment values are never sent.
  assert.match(asked[0].params.reason,/process\.stdout\.write/);assert.ok(asked[0].params.reason.includes(`工作目錄：${ws}`));
  assert.ok(!JSON.stringify(asked).includes('explicit'),'env values are not sent');
});

test('subprocess.spawn: a refusal rejects done and the program is never started',async t=>{
  const ws=await workspace(t);
  const {service}=createClaudeSubprocessService({requestHost:approver({approved:false}).requestHost,workspace:ws});
  const handle=service.spawn({argv:[node,'-e',"require('fs').writeFileSync('marker.txt','ran')"],cwd:ws,stdio:{stdin:'ignore',stdout:{maxBytes:8},stderr:{maxBytes:8}},graceMs:100});
  await assert.rejects(handle.done,/DSH_EXEC_DENIED|沒有核准/);
  await new Promise(r=>setTimeout(r,300));
  await assert.rejects(fs.access(path.join(ws,'marker.txt')));
});

test('subprocess: terminate and abort stop a running program (also while still waiting for the answer)',async t=>{
  const ws=await workspace(t);
  const {service,dispose}=createClaudeSubprocessService({requestHost:approver().requestHost,workspace:ws});t.after(dispose);
  const spec=signal=>({argv:[node,'-e','setTimeout(()=>{},60000)'],cwd:ws,stdio:{stdin:'ignore',stdout:{maxBytes:8},stderr:{maxBytes:8}},graceMs:200,...(signal?{signal}:{})});
  const a=service.spawn(spec());setTimeout(()=>a.terminate(),400);
  const outcome=await a.done.catch(error=>error);assert.ok(outcome.signal||outcome.exitCode!==0||outcome instanceof Error);
  const controller=new AbortController();const b=service.spawn(spec(controller.signal));controller.abort();
  await assert.rejects(b.done,/已取消|ABORT/);
  assert.equal(await b.waitForExit(),true);
  let hang;const waiting=createClaudeSubprocessService({requestHost:()=>new Promise((_,reject)=>{hang=reject;}),workspace:ws}).service;
  const c=waiting.spawn(spec());c.terminate();
  await assert.rejects(c.done);
});

test('subprocess.resolveExecutable: bare name, absolute path, and loud failures',async t=>{
  const ws=await workspace(t);
  const {service}=createClaudeSubprocessService({requestHost:approver().requestHost,workspace:ws});
  assert.ok(await service.resolveExecutable('node'));
  assert.equal(await service.resolveExecutable(node),node);
  await assert.rejects(service.resolveExecutable('definitely-not-a-real-program-xyz'),e=>e.name==='SubprocessExecutableNotFoundError');
  await assert.rejects(service.resolveExecutable('./relative/tool'),e=>e.name==='SubprocessExecutableNotFoundError');
  await assert.rejects(service.resolveExecutable(''),/command/);
});
