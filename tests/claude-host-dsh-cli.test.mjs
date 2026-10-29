import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {makePlugin,spawnHost,toolHeader} from './claude-host-helpers.mjs';
import {buildDshCli,sourceResolvesDshEntry} from '../lib/claude-host/build.mjs';
import {createCliEndpoint,CLI_ROUTE} from '../lib/claude-host/cli-endpoint.mjs';
import {parseDshArgs,summarizeOverlay,composePrompt,runDshCli,EXIT,DshCliError} from '../lib/claude-host/dsh-cli.mjs';

const OVERLAY=`- id: credentials
  disabled: false

- id: agent-default-model
  config:
    provider: deepseek-account
    model: deepseek-v4
- insert:
    - id: mcp-bili-duty
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: bili-duty
        transport: stdio
        command: 'python'
        args:
          - 'C:/state/mcp_server.py'
        env:
          BILI_MCP_TOOLS: 'bili_search,bili_subtitle'
`;
const temporary=async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-cli-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{}));return dir;};
const sink=()=>{let text='';return {write:chunk=>{text+=chunk;},get text(){return text;}};};

// ---------- command line ----------
test('parseDshArgs: the headless run form used by plugins',()=>{
  const parsed=parseDshArgs(['--profile','headless','--patch','a.yml','--patch=b.yml','Do the thing\nsecond line']);
  assert.deepEqual(parsed,{kind:'run',profile:'headless',patches:['a.yml','b.yml'],prompt:'Do the thing\nsecond line',stdin:false});
  assert.equal(parseDshArgs(['--profile=web','hello']).profile,'web');
  assert.deepEqual(parseDshArgs([]),{kind:'run',profile:null,patches:[],prompt:null,stdin:true});
  assert.equal(parseDshArgs(['-']).stdin,true);
  assert.equal(parseDshArgs(['--','--looks-like-a-flag']).prompt,'--looks-like-a-flag');
  assert.equal(parseDshArgs(['--version']).kind,'version');
  assert.equal(parseDshArgs(['--help']).kind,'help');
});

test('parseDshArgs: subcommands, unknown options and bad values are refused, never ignored',()=>{
  const refuse=(argv,pattern)=>assert.throws(()=>parseDshArgs(argv),error=>error instanceof DshCliError&&error.exit===EXIT.USAGE&&pattern.test(error.message),argv.join(' '));
  refuse(['plugin','--profile','web','add','x'],/子命令：plugin/);
  refuse(['web','--port','3080'],/子命令：web/);
  refuse(['web'],/子命令：web/);
  refuse(['--profile','web','--dump-config'],/--dump-config/);
  refuse(['--profile'],/--profile 缺少值/);
  refuse(['--profile','--patch','x','p'],/--profile 缺少值/);
  refuse(['--profile','bad name','p'],/名稱不合法/);
  refuse(['--patch'],/--patch 缺少值/);
  refuse(['one','two'],/只能是一個參數/);
  refuse(['--config.ignore-scripts=true','p'],/不支援的參數/);
});

test('summarizeOverlay: instructions, tool lists, model and MCP servers are separated; secrets in args are redacted',()=>{
  const { parse } = { parse: undefined }; void parse;
  const summary=summarizeOverlay([
    {id:'agent-default-model',config:{provider:'p',model:'m'}},
    {id:'sys',config:{systemPrompt:'Be terse.',allowTools:['a','b'],denyTools:'c'}},
    {insert:[{id:'mcp-x',name:'@deepseek-ai/dsh-mcp-client',config:{serverName:'x',transport:'stdio',command:'node',args:['server.js','--api-key','SECRETVALUE','token=SECRETTWO'],env:{A:'1',B:'2'}}}]},
    {id:'off',disabled:true,config:{systemPrompt:'ignored'}},
  ],{file:'o.yml'});
  assert.equal(summary.model,'p/m');
  assert.deepEqual(summary.instructions,['Be terse.']);
  assert.deepEqual(summary.allowTools,['a','b']);assert.deepEqual(summary.denyTools,['c']);
  assert.equal(summary.mcpServers.length,1);
  const server=summary.mcpServers[0];
  assert.equal(server.name,'x');assert.deepEqual(server.envNames,['A','B']);
  assert.ok(!JSON.stringify(summary).includes('SECRET'),'secret-looking arguments never leave the overlay');
  assert.ok(summary.entries.includes('off（disabled）'));
});

test('composePrompt: the task is kept verbatim and the limits are stated',()=>{
  const overlay=summarizeOverlay([{insert:[{id:'m',name:'@deepseek-ai/dsh-mcp-client',config:{serverName:'bili-duty',transport:'stdio',command:'python',env:{BILI_MCP_TOOLS:'x'}}}]}],{file:'o.yml'});
  const text=composePrompt({prompt:'LINE ONE\nLINE TWO',profile:'headless',overlays:[overlay]});
  assert.ok(text.endsWith('=== Task ===\nLINE ONE\nLINE TWO'));
  assert.match(text,/Claude Code subagent/);assert.match(text,/profile requested: headless/);
  assert.match(text,/NOT attached.*bili-duty/s);assert.match(text,/BILI_MCP_TOOLS/);
});

// ---------- endpoint and program, in process ----------
async function endpointRoot(t){
  const root=await temporary(t);
  await fs.mkdir(path.join(root,'runtime','dsh-cli'),{recursive:true});
  await fs.writeFile(path.join(root,'runtime','dsh-cli','dsh.mjs'),'// placeholder\n');
  return root;
}
const fakeReverse=handler=>({calls:[],request(method,params,execution){this.calls.push({method,params});return handler(method,params,execution);}});

test('createCliEndpoint: nothing is started without the stand-in or when disabled',async t=>{
  const empty=await temporary(t);
  assert.equal(await createCliEndpoint({root:empty,reverse:fakeReverse(()=>({text:'x'}))}),null);
  const root=await endpointRoot(t);
  assert.equal(await createCliEndpoint({root,reverse:fakeReverse(()=>({text:'x'})),options:{dshCli:false}}),null);
});

test('createCliEndpoint: env has the stand-in first on PATH, a loopback URL and a token; bad callers are refused',async t=>{
  const root=await endpointRoot(t);
  const reverse=fakeReverse(()=>({text:'ok'}));
  const endpoint=await createCliEndpoint({root,reverse,env:{PATH:'/usr/bin'},platform:'linux'});
  t.after(()=>endpoint.close());
  assert.equal(endpoint.env.PATH.split(path.delimiter)[0],path.join(root,'runtime','dsh-cli'));
  assert.ok(endpoint.env.PATH.endsWith(path.delimiter+'/usr/bin'));
  assert.equal('Path' in endpoint.env,false);
  assert.match(endpoint.env.DSH_CLAUDE_CLI_ENDPOINT,new RegExp(`^http://127\\.0\\.0\\.1:${endpoint.port}${CLI_ROUTE}$`));
  assert.match(endpoint.env.DSH_CLAUDE_CLI_TOKEN,/^[0-9a-f]{64}$/);
  const url=endpoint.env.DSH_CLAUDE_CLI_ENDPOINT,token=endpoint.env.DSH_CLAUDE_CLI_TOKEN;
  const send=(headers,{method='POST',target=url,body={prompt:'p'}}={})=>fetch(target,{method,headers:{'content-type':'application/json',...headers},body:method==='POST'?JSON.stringify(body):undefined});
  assert.equal((await send({})).status,401);
  assert.equal((await send({authorization:'Bearer '+'0'.repeat(64)})).status,401);
  assert.equal((await send({authorization:'Bearer short'})).status,401);
  assert.equal((await send({authorization:'Bearer '+token},{target:url.replace(CLI_ROUTE,'/other')})).status,404);
  assert.equal((await send({authorization:'Bearer '+token},{method:'GET'})).status,405);
  assert.equal((await send({authorization:'Bearer '+token},{body:{prompt:''}})).status,400);
  assert.equal(reverse.calls.length,0,'refused requests never reach the mod');
  const ok=await send({authorization:'Bearer '+token},{body:{prompt:'hello',description:'d'}});
  assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{result:{text:'ok'}});
  assert.deepEqual(reverse.calls,[{method:'agent.spawn',params:{prompt:'hello',description:'d'}}]);
});

test('createCliEndpoint: a second concurrent run is refused with BUSY and a dropped caller cancels the wait',async t=>{
  const root=await endpointRoot(t);
  let release,signalSeen;
  const reverse=fakeReverse((method,params,{signal})=>new Promise((resolve,reject)=>{signalSeen=signal;release=()=>resolve({text:'late'});signal.addEventListener('abort',()=>reject(Object.assign(new Error('Request canceled'),{code:'HOST_CANCELED'})));}));
  const endpoint=await createCliEndpoint({root,reverse,options:{dshCli:{maxConcurrent:1}}});
  t.after(()=>endpoint.close());
  const headers={authorization:'Bearer '+endpoint.env.DSH_CLAUDE_CLI_TOKEN,'content-type':'application/json'};
  const controller=new AbortController();
  const first=fetch(endpoint.env.DSH_CLAUDE_CLI_ENDPOINT,{method:'POST',headers,body:JSON.stringify({prompt:'one'}),signal:controller.signal}).catch(error=>error);
  while(!signalSeen)await new Promise(r=>setTimeout(r,10));
  const second=await fetch(endpoint.env.DSH_CLAUDE_CLI_ENDPOINT,{method:'POST',headers,body:JSON.stringify({prompt:'two'})});
  assert.equal((await second.json()).error.code,'BUSY');
  controller.abort();await first;
  for(let i=0;i<100&&!signalSeen.aborted;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(signalSeen.aborted,true,'the reverse request is canceled when the caller goes away');
  void release;
});

async function inProcess(t,{argv,reverseHandler=()=>({text:'ANSWER'}),stdinText,env}){
  const root=await endpointRoot(t);
  const reverse=fakeReverse(reverseHandler);
  const endpoint=await createCliEndpoint({root,reverse});
  t.after(()=>endpoint.close());
  const stdout=sink(),stderr=sink();
  const code=await runDshCli({argv,env:env??{DSH_CLAUDE_CLI_ENDPOINT:endpoint.env.DSH_CLAUDE_CLI_ENDPOINT,DSH_CLAUDE_CLI_TOKEN:endpoint.env.DSH_CLAUDE_CLI_TOKEN},stdin:stdinText===undefined?Readable.from([]):Readable.from([stdinText]),stdout,stderr});
  return {code,stdout:stdout.text,stderr:stderr.text,reverse};
}

test('runDshCli: prompt argument -> agent.spawn -> the subagent text on stdout, exit 0',async t=>{
  const dir=await temporary(t);const overlay=path.join(dir,'o.yml');await fs.writeFile(overlay,OVERLAY);
  const run=await inProcess(t,{argv:['--profile','headless','--patch',overlay,'Round prompt\nwith lines'],reverseHandler:()=>({text:'Report written.'})});
  assert.equal(run.code,0);assert.equal(run.stdout,'Report written.\n');
  assert.equal(run.reverse.calls.length,1);
  const {prompt,description}=run.reverse.calls[0].params;
  assert.ok(prompt.endsWith('=== Task ===\nRound prompt\nwith lines'));
  assert.match(prompt,/NOT attached.*bili-duty/s);assert.match(description,/headless/);
  assert.match(run.stderr,/bili-duty.*無法掛到 Claude 子代理/,'the MCP limitation is announced on stderr');
});

test('runDshCli: the prompt can come from standard input',async t=>{
  const run=await inProcess(t,{argv:['--profile','headless'],stdinText:'From stdin',reverseHandler:()=>'plain string reply'});
  assert.equal(run.code,0);assert.equal(run.stdout,'plain string reply\n');
  assert.ok(run.reverse.calls[0].params.prompt.endsWith('=== Task ===\nFrom stdin'));
  const empty=await inProcess(t,{argv:[],stdinText:''});
  assert.equal(empty.code,EXIT.USAGE);assert.match(empty.stderr,/提示詞是空的/);assert.equal(empty.reverse.calls.length,0);
});

test('runDshCli: DISABLED -> exit 3 with a message naming allowAgents; other failures -> exit 1; nothing on stdout',async t=>{
  const off=await inProcess(t,{argv:['p'],reverseHandler:()=>{throw Object.assign(new Error('subagents are off'),{code:'DISABLED'});}});
  assert.equal(off.code,EXIT.DISABLED);assert.equal(off.stdout,'');assert.match(off.stderr,/allowAgents/);assert.match(off.stderr,/DISABLED/);
  const broken=await inProcess(t,{argv:['p'],reverseHandler:()=>{throw Object.assign(new Error('the mod went away'),{code:'REVERSE_REQUEST_TIMEOUT'});}});
  assert.equal(broken.code,EXIT.FAILED);assert.equal(broken.stdout,'');assert.match(broken.stderr,/the mod went away/);
  const noText=await inProcess(t,{argv:['p'],reverseHandler:()=>({unexpected:true})});
  assert.equal(noText.code,EXIT.FAILED);assert.equal(noText.stdout,'');assert.match(noText.stderr,/AGENT_REPLY_INVALID/);
});

test('runDshCli: unsupported commands, bad overlays, a missing endpoint and a wrong token all fail loudly',async t=>{
  const plugin=await inProcess(t,{argv:['plugin','--profile','web','add','x']});
  assert.equal(plugin.code,EXIT.USAGE);assert.equal(plugin.stdout,'');assert.equal(plugin.reverse.calls.length,0);
  const dir=await temporary(t);
  await fs.writeFile(path.join(dir,'bad.yml'),'a: [unclosed');
  const bad=await inProcess(t,{argv:['--patch',path.join(dir,'bad.yml'),'p']});
  assert.equal(bad.code,EXIT.USAGE);assert.match(bad.stderr,/YAML/);
  const missing=await inProcess(t,{argv:['--patch',path.join(dir,'nope.yml'),'p']});
  assert.equal(missing.code,EXIT.USAGE);assert.match(missing.stderr,/讀不到/);
  assert.equal(bad.reverse.calls.length+missing.reverse.calls.length,0);
  const stdout=sink(),stderr=sink();
  assert.equal(await runDshCli({argv:['p'],env:{},stdout,stderr}),EXIT.FAILED);assert.match(stderr.text,/DSH_CLAUDE_CLI_ENDPOINT/);
  const remote=sink();
  assert.equal(await runDshCli({argv:['p'],env:{DSH_CLAUDE_CLI_ENDPOINT:'http://example.com:80/dsh/run',DSH_CLAUDE_CLI_TOKEN:'x'},stdout,stderr:remote}),EXIT.FAILED);assert.match(remote.text,/127\.0\.0\.1/,'the token is never sent to a non-loopback address');
  const wrong=await inProcess(t,{argv:['p'],env:{DSH_CLAUDE_CLI_ENDPOINT:'http://127.0.0.1:1/dsh/run',DSH_CLAUDE_CLI_TOKEN:'x'}});
  assert.equal(wrong.code,EXIT.FAILED);assert.match(wrong.stderr,/連不到/);
});

// ---------- build output ----------
test('buildDshCli writes the launchers and the dsh package layout; the root-level package only for plugins that resolve it',async t=>{
  const out=await temporary(t);
  await fs.mkdir(path.join(out,'source'),{recursive:true});
  await fs.writeFile(path.join(out,'source','index.js'),"export const x = 1\n");
  const plain=await buildDshCli({outputDir:out,sourceDir:path.join(out,'source')});
  assert.equal(plain.resolvableFromSource,false);
  const dir=path.join(out,'runtime','dsh-cli');
  for(const file of ['dsh.mjs','dsh.cmd','dsh','node_modules/@deepseek-ai/dsh/package.json','node_modules/@deepseek-ai/dsh/lib/bin.js'])await fs.access(path.join(dir,file));
  await assert.rejects(fs.access(path.join(out,'node_modules')),'no root-level package for a plugin that never looks dsh up');
  assert.match(await fs.readFile(path.join(dir,'dsh.cmd'),'utf8'),/%~dp0dsh\.mjs" %\*/);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'node_modules/@deepseek-ai/dsh/package.json'),'utf8')).name,'@deepseek-ai/dsh');
  await fs.writeFile(path.join(out,'source','index.js'),"const p=require.resolve('@deepseek-ai/dsh/lib/bin.js')\n");
  assert.equal(await sourceResolvesDshEntry(path.join(out,'source')),true);
  const resolving=await buildDshCli({outputDir:out,sourceDir:path.join(out,'source')});
  assert.equal(resolving.resolvableFromSource,true);
  await fs.access(path.join(out,'node_modules/@deepseek-ai/dsh/lib/bin.js'));
  const version=spawnSync(process.execPath,[path.join(dir,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--version'],{encoding:'utf8',env:{}});
  assert.equal(version.status,0);assert.match(version.stdout,/not DeepSeek Harness/);
  const root=spawnSync(process.execPath,[path.join(out,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--help'],{encoding:'utf8',env:{}});
  assert.equal(root.status,0);assert.match(root.stdout,/Claude/);
  if(process.platform==='win32'){
    const cmd=spawnSync('cmd.exe',['/d','/c',path.join(dir,'dsh.cmd'),'plugin','add','x'],{encoding:'utf8',env:{...process.env}});
    assert.equal(cmd.status,EXIT.USAGE,'the .cmd launcher passes the exit code through');assert.match(cmd.stderr,/子命令：plugin/);
  }else{
    const sh=spawnSync(path.join(dir,'dsh'),['plugin','add','x'],{encoding:'utf8',env:{...process.env}});
    assert.equal(sh.status,EXIT.USAGE);assert.match(sh.stderr,/子命令：plugin/);
  }
});

// ---------- a plugin that runs `dsh` itself, through the real child host ----------
const pluginSource=toolHeader+`import {spawn} from 'node:child_process';import {createRequire} from 'node:module';import {existsSync} from 'node:fs';import {join,delimiter} from 'node:path';
export const name='syn-dsh-cli';export const inject=['tools'];
const run=(args,env={})=>new Promise(resolve=>{const entry=args.entry;const c=spawn(process.execPath,[entry,...args.argv],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,...env}});let out='',err='';c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>err+=d);c.on('error',e=>resolve({code:-1,stdout:out,stderr:String(e.message)}));c.on('close',code=>resolve({code,stdout:out,stderr:err}));});
const onPath=()=>{for(const dir of String(process.env.PATH||'').split(delimiter)){const p=join(dir,'dsh.mjs');if(existsSync(p))return p;}return '';};
const argvOf=a=>JSON.parse(a.argvJson);
export function apply(ctx){
  const params={argvJson:{type:'string'}};
  ctx.tools.register(tool('dsh_path',async a=>{const entry=onPath();if(!entry)return {code:-2,stderr:'no dsh.mjs on PATH'};return run({entry,argv:argvOf(a)});},{parameters:params}));
  ctx.tools.register(tool('dsh_resolve',async a=>run({entry:createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js'),argv:argvOf(a)}),{parameters:params}));
  ctx.tools.register(tool('dsh_wrong_token',async a=>run({entry:onPath(),argv:argvOf(a)},{DSH_CLAUDE_CLI_TOKEN:'0'.repeat(64)}),{parameters:params}));
  ctx.tools.register(tool('show_env',async()=>({firstPath:String(process.env.PATH||'').split(delimiter)[0],endpoint:process.env.DSH_CLAUDE_CLI_ENDPOINT||null,token:process.env.DSH_CLAUDE_CLI_TOKEN||null,node:process.env.DSH_CLAUDE_NODE||null})));
}`;
async function startPlugin(t,answer,{install=true,claudeHost={}}={}){
  const root=await makePlugin(t,pluginSource,{claudeHost});
  if(install)await buildDshCli({outputDir:root,sourceDir:path.join(root,'source')});
  // The plugin starts `dsh` itself (child_process), which the Node permission model only allows with allowDirectExec.
  const host=await spawnHost(t,root,{answer,env:{DSH_CLAUDE_ALLOW_DIRECT_EXEC:'1'}});
  const ready=await host.ready();
  return {root,host,ready};
}
const call=async(host,name,args={})=>{const result=await host.rpc('tools.call',{name,args,callId:`${name}-${Math.random()}`});assert.equal(result.isError,false,result.content.map(x=>x.text).join());return JSON.parse(result.content[0].text);};
const argvArgs=(...argv)=>({argvJson:JSON.stringify(argv)});

test('a plugin that runs dsh: PATH has the stand-in first, the agent request reaches the mod, the text comes back on stdout',async t=>{
  const seen=[];
  const {root,host,ready}=await startPlugin(t,async(method,params)=>{seen.push({method,params});return {text:'ROUND DONE'};});
  // Node children of a sandboxed worker inherit its permission model, so the overlay lives in an allowed folder (the workspace).
  const overlay=path.join(root,'source','o.yml');await fs.writeFile(overlay,OVERLAY);
  assert.equal(ready.metadata.dshCli,true);
  const env=await call(host,'show_env');
  assert.equal(path.resolve(env.firstPath),path.join(root,'runtime','dsh-cli'));
  assert.match(env.endpoint,/^http:\/\/127\.0\.0\.1:\d+\/dsh\/run$/);assert.match(env.token,/^[0-9a-f]{64}$/);assert.equal(env.node,process.execPath);
  const via=await call(host,'dsh_path',argvArgs('--profile','headless','--patch',overlay,'Round prompt'));
  assert.equal(via.code,0,via.stderr);assert.equal(via.stdout,'ROUND DONE\n');
  const request=seen.find(x=>x.method==='agent.spawn');
  assert.ok(request,'agent.spawn was sent to the mod');
  assert.ok(request.params.prompt.endsWith('=== Task ===\nRound prompt'));assert.match(request.params.prompt,/bili-duty/);
  assert.match(via.stderr,/bili-duty/);
  const resolved=await call(host,'dsh_resolve',argvArgs('--profile','headless','Second prompt'));
  assert.equal(resolved.code,0,resolved.stderr);assert.equal(resolved.stdout,'ROUND DONE\n');
  assert.equal(seen.filter(x=>x.method==='agent.spawn').length,2);
  const everything=JSON.stringify(host.lines)+host.stderr.join('');
  assert.ok(!everything.includes(env.token),'the stand-in token is not in any protocol line or stderr output');
});

test('a plugin that runs dsh: DISABLED gives a non-zero exit code and an explicit error',async t=>{
  const {host}=await startPlugin(t,async method=>{if(method==='agent.spawn')throw Object.assign(new Error('subagents are off'),{code:'DISABLED'});return {};});
  const result=await call(host,'dsh_path',argvArgs('--profile','headless','Round prompt'));
  assert.equal(result.code,EXIT.DISABLED);assert.equal(result.stdout,'');assert.match(result.stderr,/allowAgents/);
  const failed=await call(host,'dsh_path',argvArgs('plugin','add','x'));
  assert.equal(failed.code,EXIT.USAGE);assert.match(failed.stderr,/子命令：plugin/);
});

test('a plugin that runs dsh: a wrong token is refused and the mod is never asked',async t=>{
  const seen=[];
  const {host}=await startPlugin(t,async(method,params)=>{seen.push(method);return {text:'must not happen'};});
  const result=await call(host,'dsh_wrong_token',argvArgs('--profile','headless','Round prompt'));
  assert.equal(result.code,EXIT.FAILED);assert.equal(result.stdout,'');assert.match(result.stderr,/UNAUTHORIZED|權杖/);
  assert.ok(!seen.includes('agent.spawn'));
});

test('without the stand-in installed, or with claudeHost.dshCli=false, the environment is left alone',async t=>{
  const plain=await startPlugin(t,async()=>({text:'x'}),{install:false});
  assert.equal(plain.ready.metadata.dshCli,false);
  const envPlain=await call(plain.host,'show_env');
  assert.equal(envPlain.endpoint,null);assert.equal(envPlain.token,null);
  assert.notEqual(path.resolve(envPlain.firstPath),path.join(plain.root,'runtime','dsh-cli'));
  const off=await startPlugin(t,async()=>({text:'x'}),{claudeHost:{dshCli:false}});
  assert.equal(off.ready.metadata.dshCli,false);
  assert.equal((await call(off.host,'show_env')).endpoint,null);
});
