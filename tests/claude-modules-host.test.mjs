// The Claude host service modules, through the real child host with a synthetic DSH plugin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {makePlugin,spawnHost,toolHeader} from './claude-host-helpers.mjs';

const services=['storageDomain','userQuestions','jobs','connection','credentials','subagents','agents','shell','subprocess'];
const node=process.execPath;
const runNode=process.platform==='win32'?`& '${node}' -p 6*7`:`'${node}' -p 6*7`;
const source=toolHeader+`import {defineDomain,domainTable} from '@deepseek-ai/dsh-storage-domain';
import z from 'zod';
export const name='syn-modules';export const inject=['tools',${services.map(s=>`'${s}'`).join(',')}];
const notes=defineDomain({name:'syn_notes',version:1,layout:'per-record',tables:{notes:domainTable(z.object({text:z.string()}))}});
export function apply(ctx){
  let domain;
  const open=async()=>domain??=await ctx.storageDomain.open(notes);
  ctx.tools.register(tool('store_put',async()=>{const d=await open();await d.table('notes').put('a',{text:'persisted'});return {size:d.table('notes').size};}));
  ctx.tools.register(tool('store_reopen',async()=>{const d=await open();await d.close();domain=undefined;const again=await open();return {text:again.table('notes').get('a')?.text??null};}));
  ctx.tools.register(tool('ask_user',async()=>ctx.userQuestions.ask({questions:[{id:'q1',question:'Pick one?',options:[{label:'A'},{label:'B'}]},{id:'q2',question:'Why?'}]})));
  ctx.tools.register(tool('job_run',async()=>{
    const id=ctx.jobs.start({kind:'syn',label:'demo',run:h=>{h.append('hello ');h.append('world');return {cancel(){},done:Promise.resolve({status:'completed',result:'finished'})};}});
    const view=await ctx.jobs.wait(id,2000);const read=ctx.jobs.read(id);
    return {status:view.status,output:read.chunks.map(c=>c.text).join(''),result:read.result,idKind:id.split('-')[0]};
  }));
  ctx.tools.register(tool('conn',async()=>{
    const a=ctx.connection.rpc.handle('/syn',()=>{}),b=ctx.connection.register(ctx,'/syn2',()=>{});
    return {handle:typeof await a,register:typeof await b,reject:typeof ctx.connection.requestRejection,attached:ctx.connection.frontendAttached};
  }));
  ctx.tools.register(tool('cred',async a=>{const r=await ctx.credentials.resolve(a.ref);return {length:r.value.length,source:r.source};},{parameters:{ref:{type:'string'}}}));
  ctx.tools.register(tool('cred_describe',async a=>ctx.credentials.describe(a.ref),{parameters:{ref:{type:'string'}}}));
  ctx.tools.register(tool('cred_set',async()=>ctx.credentials.set('X','v')));
  ctx.tools.register(tool('sub_run',async()=>{
    const a=await ctx.subagents.startActivation({provider:'spawn',label:'t',request:{prompt:[{type:'text',text:'hello sub'}],agentOptions:{model:'ignored'}},signal:new AbortController().signal,delivery:'parent'});
    const r=await a.result;return {text:r.output[0].text,stop:r.stopReason,providers:ctx.subagents.list()};
  }));
  ctx.tools.register(tool('sub_continuable',async()=>ctx.subagents.startContinuable({provider:'spawn'})));
  ctx.tools.register(tool('initiator',async()=>({current:ctx.agents.currentInitiator()??null})));
  ctx.tools.register(tool('sh',async a=>{const spec=ctx.shell.resolve({command:a.command,workdir:a.workdir,timeoutMs:20000});const run=await ctx.shell.execute(spec);const r=await run.result();return {exitCode:r.exitCode,out:r.stdout.text.trim(),timedOut:r.timedOut};},{parameters:{command:{type:'string'},workdir:{type:'string'}}}));
  ctx.tools.register(tool('sp',async a=>{
    const exe=await ctx.subprocess.resolveExecutable('node');
    const h=ctx.subprocess.spawn({argv:[exe,'-p',a.code],cwd:a.cwd??${JSON.stringify('.')},stdio:{stdin:'ignore',stdout:{maxBytes:1024},stderr:{maxBytes:1024}},graceMs:1000});
    const o=await h.done;return {exitCode:o.exitCode,out:h.collected.stdout.readFrom(0).text.trim()};
  },{parameters:{code:{type:'string'},cwd:{type:'string'}}}));
}`;
const plan={host:{services}};
const call=(host,name,args={})=>host.rpc('tools.call',{name,args,callId:`${name}-${Math.random()}`});
const text=result=>result.content.map(x=>x.text).join('\n');
/** A mod built before exec.check answers it with an UNSUPPORTED/UNKNOWN_METHOD error. */
const oldMod=()=>Object.assign(new Error('the bridge does not handle exec.check'),{code:'UNKNOWN_METHOD'});
const json=result=>{assert.equal(result.isError,false,text(result));return JSON.parse(text(result));};

async function start(t,answer,{env={},settings={}}={}){
  const root=await makePlugin(t,source,{plan,services:['timer','fs','settings','webServer','commands','skills'],passEnv:['SYN_PRESENT_KEY'],...settings});
  const host=await spawnHost(t,root,{answer,env});
  const ready=await host.ready();
  return {host,root,ready};
}

test('every new service is mounted: the plugin starts and nothing is "No generic module"',async t=>{
  const {ready}=await start(t,async()=>({approved:true}));
  const mods=Object.fromEntries((ready.metadata.modules??[]).map(m=>[m.id,m.runtimeStatus??m.status]));
  for(const id of services)assert.equal(mods[id],'installed',`${id}: ${JSON.stringify(mods)}`);
});

test('storageDomain: the official domain service persists through the Claude host backend',async t=>{
  const {host,root}=await start(t,async()=>({approved:true}));
  assert.deepEqual(json(await call(host,'store_put')),{size:1});
  assert.deepEqual(json(await call(host,'store_reopen')),{text:'persisted'});
  const files=[];
  const walk=async dir=>{for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await walk(p);else files.push(p);}};
  await walk(path.join(root,'.state'));
  assert.ok(files.some(f=>f.endsWith(path.join('storage','syn_notes.json'))),'the unit file is under the host state folder: '+files.join(', '));
});

test('userQuestions: ui.ask per question; labels map back, other text is custom; cancel is an explicit error',async t=>{
  const seen=[];let mode='ok';
  const {host}=await start(t,async(method,params)=>{
    if(method!=='ui.ask')return {approved:true};
    seen.push(params);
    if(mode==='cancel')throw Object.assign(new Error('dismissed'),{code:'USER_DISMISSED'});
    return {answer:params.question.startsWith('Pick')?'B':'because I said so'};
  });
  assert.deepEqual(json(await call(host,'ask_user')),{answers:[{id:'q1',selected:['B']},{id:'q2',selected:[],custom:'because I said so'}]});
  assert.deepEqual(seen[0],{question:'Pick one?',options:['A','B']});
  assert.deepEqual(seen[1],{question:'Why?'});
  mode='cancel';
  const cancelled=await call(host,'ask_user');
  assert.equal(cancelled.isError,true);assert.match(text(cancelled),/DSH_USER_QUESTION_CANCELLED|not answered|沒有被回答/);
});

test('jobs: start, wait, consuming read with the result',async t=>{
  const {host}=await start(t,async()=>({approved:true}));
  assert.deepEqual(json(await call(host,'job_run')),{status:'completed',output:'hello world',result:'finished',idKind:'syn'});
});

test('connection: registering a channel succeeds and does nothing; requestRejection does not exist',async t=>{
  const {host}=await start(t,async()=>({approved:true}));
  assert.deepEqual(json(await call(host,'conn')),{handle:'function',register:'function',reject:'undefined',attached:false});
});

test('credentials: environment variable by name; missing is an explicit error, never an empty value; set is unsupported',async t=>{
  const {host}=await start(t,async()=>({approved:true}),{env:{SYN_PRESENT_KEY:'abc123-not-logged'}});
  assert.deepEqual(json(await call(host,'cred',{ref:'SYN_PRESENT_KEY'})),{length:'abc123-not-logged'.length,source:'env'});
  const missing=await call(host,'cred',{ref:'SYN_ABSENT_KEY'});
  assert.equal(missing.isError,true);assert.match(text(missing),/缺少金鑰 SYN_ABSENT_KEY/);
  assert.ok(!text(missing).includes('abc123'));
  assert.deepEqual(json(await call(host,'cred_describe',{ref:'SYN_PRESENT_KEY'})),{configured:true,source:'env',writable:false});
  assert.deepEqual(json(await call(host,'cred_describe',{ref:'SYN_ABSENT_KEY'})),{configured:false,writable:false});
  const set=await call(host,'cred_set');
  assert.equal(set.isError,true);assert.match(text(set),/DSH_MODULE_UNSUPPORTED|credentials\.set/);
  const bad=await call(host,'cred',{ref:'not a name'});
  assert.equal(bad.isError,true);
});

test('subagents: startActivation goes through agent.spawn; DISABLED and continuable are explicit',async t=>{
  let enabled=true;const seen=[];
  const {host}=await start(t,async(method,params)=>{
    if(method!=='agent.spawn')return {approved:true};
    seen.push(params);
    if(!enabled)throw Object.assign(new Error('sub-agents are off'),{code:'DISABLED'});
    return {text:'sub says hi'};
  });
  assert.deepEqual(json(await call(host,'sub_run')),{text:'sub says hi',stop:'completed',providers:['spawn']});
  assert.equal(seen[0].prompt,'hello sub');
  enabled=false;
  const off=await call(host,'sub_run');
  assert.equal(off.isError,true);assert.match(text(off),/allowAgents|DSH_AGENTS_DISABLED/);
  const continuable=await call(host,'sub_continuable');
  assert.equal(continuable.isError,true);assert.match(text(continuable),/DSH_MODULE_UNSUPPORTED|startContinuable/);
});

test('agents: currentInitiator answers undefined instead of throwing',async t=>{
  const {host}=await start(t,async()=>({approved:true}));
  assert.deepEqual(json(await call(host,'initiator')),{current:null});
});

test('shell (mod without exec.check, falls back to approval.request): every execution asks first; the reason shows the command being approved; a no stops it',async t=>{
  const asked=[];let approved=true;
  const {host}=await start(t,async(method,params)=>{if(method==='exec.check')throw oldMod();if(method==='approval.request'){asked.push(params);return {approved};}return {};});
  const ran=json(await call(host,'sh',{command:runNode}));
  assert.deepEqual({exitCode:ran.exitCode,out:ran.out},{exitCode:0,out:'42'});
  assert.equal(asked.length,1);
  assert.equal(asked[0].toolName,'shell');assert.match(asked[0].reason,/"node"/);
  assert.ok(asked[0].reason.includes('6*7'),'the person sees the command they approve');
  approved=false;
  const refused=await call(host,'sh',{command:runNode});
  assert.equal(refused.isError,true);assert.match(text(refused),/DSH_EXEC_DENIED|沒有核准/);
  assert.equal(asked.length,2);
});

test('shell and subprocess: the working directory cannot leave the workspace',async t=>{
  const asked=[];
  const {host}=await start(t,async(method,params)=>{if(method==='approval.request'||method==='exec.check')asked.push(params);return method==='exec.check'?{decision:'allow'}:{approved:true};});
  const outside=await call(host,'sh',{command:runNode,workdir:path.parse(process.cwd()).root});
  assert.equal(outside.isError,true);assert.match(text(outside),/DSH_EXEC_CWD_OUTSIDE_WORKSPACE|DSH_EXEC_BAD_CWD|工作目錄/);
  const sp=await call(host,'sp',{code:'1+1',cwd:path.parse(process.cwd()).root});
  assert.equal(sp.isError,true);assert.match(text(sp),/工作目錄/);
  assert.equal(asked.length,0,'nothing is asked, and nothing is run, for a directory that is not allowed');
});

test('subprocess (mod without exec.check): resolveExecutable, one approval per spawn, collected output; a no rejects done and nothing runs',async t=>{
  const asked=[];let approved=true;
  const {host}=await start(t,async(method,params)=>{if(method==='exec.check')throw oldMod();if(method==='approval.request'){asked.push(params);return {approved};}return {};});
  assert.deepEqual(json(await call(host,'sp',{code:'6*7'})),{exitCode:0,out:'42'});
  assert.equal(asked.length,1);assert.equal(asked[0].toolName,'subprocess');assert.match(asked[0].reason,/"node"/);
  approved=false;
  const refused=await call(host,'sp',{code:'6*7'});
  assert.equal(refused.isError,true);assert.match(text(refused),/DSH_EXEC_DENIED|沒有核准/);
});
