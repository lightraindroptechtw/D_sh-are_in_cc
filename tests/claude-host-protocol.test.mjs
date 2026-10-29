import test from 'node:test';
import assert from 'node:assert/strict';
import {makePlugin,spawnHost,toolHeader} from './claude-host-helpers.mjs';

const plugin=toolHeader+`export const name='syn-proto';export const inject=['tools','commands','systemPrompt'];
export function apply(ctx){
  ctx.tools.register(tool('echo_tool',async a=>({echo:a.text}),{parameters:{text:{type:'string'}}}));
  ctx.tools.register(tool('fail_tool',async()=>{throw new Error('tool exploded');}));
  ctx.tools.register(tool('slow_tool',async(a,exec)=>new Promise((resolve,reject)=>exec.signal.addEventListener('abort',()=>reject(new Error('plugin saw the cancel signal')),{once:true}))));
  ctx.tools.register(tool('hang_tool',async()=>new Promise(()=>{})));
  ctx.systemPrompt.section({name:'syn:guide',order:10,text:'Synthetic guide text.'});
  ctx.commands.register({name:'hello',description:'Say hello',handler:async inv=>({kind:'success',text:'hello'+inv.rawInput})});
  ctx.commands.register({name:'broken',description:'Always fails',handler:async()=>({kind:'error',text:'command failed on purpose'})});
  setTimeout(()=>{ctx.tools.register(tool('later_tool',async()=>'late'));ctx.systemPrompt.section({name:'syn:late',order:20,text:'Late section.'});},1500);
}`;

async function start(t,settings={}){
  const root=await makePlugin(t,plugin,settings);
  const host=await spawnHost(t,root);
  return {root,host,ready:await host.ready()};
}

test('ready line: port, 32-byte token, tools, commands, prompt sections, interception flag',async t=>{
  const {ready}=await start(t);
  assert.equal(ready.type,'ready');assert.ok(Number.isInteger(ready.port)&&ready.port>0);
  assert.match(ready.token,/^[0-9a-f]{64}$/);
  assert.deepEqual(ready.tools.map(x=>x.dshName).sort(),['echo_tool','fail_tool','hang_tool','slow_tool']);
  const echo=ready.tools.find(x=>x.dshName==='echo_tool');
  assert.equal(echo.name,'echo_tool');assert.match(echo.description,/synthetic echo_tool/);assert.equal(echo.inputSchema.type,'object');assert.ok(echo.inputSchema.properties.text);
  assert.deepEqual(ready.commands.map(x=>x.name).sort(),['broken','hello']);
  assert.equal(ready.commands.find(x=>x.name==='hello').description,'Say hello');
  assert.ok(ready.promptSections.some(s=>s.id==='syn:guide'&&s.text.includes('Synthetic guide text.')));
  assert.equal(ready.interception,false);
  assert.ok(ready.metadata.unsupported.length>0,'what is not mapped is reported, not hidden');
});

test('tools.call returns text content; a throwing tool is an error result; unknown tools are rpc errors',async t=>{
  const {host}=await start(t);
  const ok=await host.rpc('tools.call',{name:'echo_tool',args:{text:'hi'},callId:'c1'});
  assert.equal(ok.isError,false);assert.deepEqual(JSON.parse(ok.content[0].text),{echo:'hi'});assert.equal(ok.content[0].type,'text');
  const failed=await host.rpc('tools.call',{name:'fail_tool',args:{},callId:'c2'});
  assert.equal(failed.isError,true);assert.match(failed.content[0].text,/tool exploded/);
  await assert.rejects(host.rpc('tools.call',{name:'nope',args:{}}),{code:'TOOL_NOT_FOUND'});
  const status=await host.rpc('status');
  assert.equal(status.state,'ready');assert.ok(status.tools.includes('echo_tool'));assert.equal(status.activeCalls,0);
});

test('tools.cancel reaches the plugin through the official abort signal',async t=>{
  const {host}=await start(t);
  const pending=host.rpc('tools.call',{name:'slow_tool',args:{},callId:'cancel-me'});
  await new Promise(resolve=>setTimeout(resolve,500));
  assert.equal((await host.rpc('status')).activeCalls,1);
  assert.deepEqual(await host.rpc('tools.cancel',{callId:'cancel-me'}),{});
  const result=await pending;
  assert.equal(result.isError,true);
  assert.deepEqual(await host.rpc('tools.cancel',{callId:'unknown-call'}),{},'cancelling an unknown call is harmless');
  assert.equal((await host.rpc('tools.call',{name:'echo_tool',args:{text:'after'}})).isError,false);
});

test('an HTTP client that disconnects cancels the running tool',async t=>{
  const {host}=await start(t);
  const controller=new AbortController();
  const request=fetch(`http://127.0.0.1:${host.port}/rpc`,{method:'POST',signal:controller.signal,headers:{authorization:`Bearer ${host.token}`,'content-type':'application/json'},body:JSON.stringify({method:'tools.call',params:{name:'slow_tool',args:{},callId:'drop'}})}).catch(()=>{});
  await new Promise(resolve=>setTimeout(resolve,500));controller.abort();await request;
  for(let i=0;i<20&&(await host.rpc('status')).activeCalls>0;i++)await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal((await host.rpc('status')).activeCalls,0);
});

test('a hung tool times out, the worker restarts, and later calls succeed',async t=>{
  const {host}=await start(t,{callTimeoutMs:400,cancelGraceMs:150});
  const hung=await host.rpc('tools.call',{name:'hang_tool',args:{},callId:'hang'});
  assert.equal(hung.isError,true);assert.equal(hung.code,'HOST_TIMEOUT');assert.match(hung.content[0].text,/HOST_TIMEOUT/);
  const after=await host.rpc('tools.call',{name:'echo_tool',args:{text:'recovered'},callId:'after'});
  assert.equal(after.isError,false);assert.deepEqual(JSON.parse(after.content[0].text),{echo:'recovered'});
});

test('commands.run executes a registered command without a DSH agent; failures are explicit',async t=>{
  const {host}=await start(t);
  assert.deepEqual(await host.rpc('commands.run',{name:'hello',args:'world'}),{text:'hello world'});
  await assert.rejects(host.rpc('commands.run',{name:'broken',args:''}),{code:'COMMAND_FAILED',message:/command failed on purpose/});
  await assert.rejects(host.rpc('commands.run',{name:'missing'}),{code:'COMMAND_NOT_FOUND'});
});

test('toolsChanged and promptChanged lines follow late registrations',async t=>{
  const {host}=await start(t);
  const changed=await host.next(l=>l.type==='toolsChanged'&&l.tools.some(x=>x.dshName==='later_tool'));
  assert.ok(changed.tools.length>=5);
  const prompt=await host.next(l=>l.type==='promptChanged');
  assert.ok(prompt.promptSections.some(s=>s.id==='syn:late'));
  assert.ok((await host.rpc('status')).tools.includes('later_tool'));
});

test('every request needs the bearer token; wrong paths and methods are refused',async t=>{
  const {host}=await start(t);
  const url=`http://127.0.0.1:${host.port}/rpc`,body=JSON.stringify({method:'status',params:{}});
  assert.equal((await fetch(url,{method:'POST',body})).status,401);
  assert.equal((await fetch(url,{method:'POST',body,headers:{authorization:'Bearer '+'0'.repeat(64)}})).status,401);
  assert.equal((await fetch(url,{method:'POST',body,headers:{authorization:'Bearer short'}})).status,401);
  assert.equal((await fetch(url,{method:'POST',body,headers:{authorization:`Basic ${host.token}`}})).status,401);
  assert.equal((await fetch(url,{method:'GET'})).status,401);
  const auth={authorization:`Bearer ${host.token}`};
  assert.equal((await fetch(url,{method:'GET',headers:auth})).status,405);
  assert.equal((await fetch(url.replace('/rpc','/other'),{method:'POST',body,headers:auth})).status,404);
  assert.equal((await fetch(url,{method:'POST',body:'{not json',headers:auth})).status,400);
  assert.equal((await fetch(url,{method:'POST',body,headers:auth})).status,200);
  const unknown=await (await fetch(url,{method:'POST',body:JSON.stringify({method:'constructor'}),headers:auth})).json();
  assert.equal(unknown.error.code,'METHOD_NOT_FOUND');
  const secretLeak=host.lines.concat(host.stderr.map(text=>({text}))).filter(l=>l.type!=='ready').some(l=>JSON.stringify(l).includes(host.token));
  assert.equal(secretLeak,false,'the token appears only in the ready line');
});

test('the server only listens on loopback',async t=>{
  const {host}=await start(t);
  const {execFile}=await import('node:child_process');
  const out=await new Promise(resolve=>execFile(process.platform==='win32'?'netstat':'ss',process.platform==='win32'?['-ano']:['-ltn'],(error,stdout)=>resolve(stdout??'')));
  const mine=out.split(/\r?\n/).filter(line=>line.includes(`:${host.port} `)&&/LISTEN/i.test(line));
  assert.ok(mine.length>0);assert.ok(mine.every(line=>line.includes('127.0.0.1')),mine.join('\n'));
});

test('dispose answers, then the process exits and the port closes',async t=>{
  const {host}=await start(t);
  assert.deepEqual(await host.rpc('dispose'),{});
  const exit=await Promise.race([host.exited,new Promise(resolve=>setTimeout(()=>resolve('timeout'),10000))]);
  assert.notEqual(exit,'timeout');assert.equal(exit.code,0);
  await assert.rejects(host.rpc('status'));
});

test('idleExitMs: a host nobody talks to shuts itself down; every RPC resets the timer',async t=>{
  const {host}=await start(t,{claudeHost:{idleExitMs:1500}});
  for(let i=0;i<3;i++){await new Promise(resolve=>setTimeout(resolve,700));assert.equal((await host.rpc('status')).state,'ready');}
  const exit=await Promise.race([host.exited,new Promise(resolve=>setTimeout(()=>resolve('timeout'),15000))]);
  assert.notEqual(exit,'timeout');assert.equal(exit.code,0);
});

test('DSH_CLAUDE_PARENT_PID: the host leaves when the process that started it is gone',async t=>{
  const {spawn}=await import('node:child_process');
  const parent=spawn(process.execPath,['-e','setTimeout(()=>{},1500)'],{stdio:'ignore',windowsHide:true});
  const root=await makePlugin(t,plugin);
  const host=await spawnHost(t,root,{env:{DSH_CLAUDE_PARENT_PID:String(parent.pid),DSH_CLAUDE_PARENT_POLL_MS:'200'}});
  await host.ready();
  const exit=await Promise.race([host.exited,new Promise(resolve=>setTimeout(()=>resolve('timeout'),20000))]);
  assert.notEqual(exit,'timeout','the host must not outlive its parent');assert.equal(exit.code,0);
});
