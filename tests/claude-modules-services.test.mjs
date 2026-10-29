// jobs, userQuestions, credentials, subagents, connection, storage backend and module selection, called directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createClaudeJobsService} from '../lib/modules/claude/jobs.mjs';
import {createClaudeUserQuestionsService,fromAnswer,toAskParams} from '../lib/modules/claude/user-questions.mjs';
import {createClaudeCredentialsService} from '../lib/modules/claude/credentials.mjs';
import {createClaudeSubagentsService} from '../lib/modules/claude/subagents.mjs';
import {createClaudeConnectionService,install as installConnection} from '../lib/modules/claude/connection.mjs';
import {createKvBackend} from '../lib/modules/claude/storage-domain.mjs';
import {claudeRegistry} from '../lib/modules/claude/index.mjs';
import {selectModules} from '../lib/modules/index.mjs';
import {isKnownDshService} from '../lib/dsh-services.mjs';
import {createReverseChannel,REVERSE_METHODS} from '../lib/claude-host/reverse.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const producer=(setup=()=>{})=>handle=>{let finish;const done=new Promise(r=>{finish=r;});const ctl={cancel:reason=>finish({status:'killed',detail:'cancelled'+(reason?'':'')}),finish};setup(handle,ctl);return {cancel:ctl.cancel,done};};

// ---- jobs ----
test('jobs: ids, lifecycle, consuming read vs readAt, result once, events',async t=>{
  const {service,dispose}=createClaudeJobsService();t.after(dispose);
  const events=[];service.events.subscribe({owners:'all'},e=>events.push(e.type));
  const id=service.start({kind:'bash',label:'demo',run:producer((h,ctl)=>{h.append('one ');h.updateProgress('1/2');setTimeout(()=>{h.append('two');ctl.finish({status:'completed',result:'R',detail:'exit code: 0'});},50);})});
  assert.match(id,/^bash-[0-9a-f]{8}$/);
  assert.equal(service.get(id).status,'running');
  const first=service.read(id);assert.equal(first.chunks.map(c=>c.text).join(''),'one ');assert.equal(first.result,undefined);
  const settled=await service.wait(id,2000);
  assert.equal(settled.status,'completed');assert.equal(settled.detail,'exit code: 0');assert.equal(settled.progress,undefined);
  const second=service.read(id);assert.equal(second.chunks.map(c=>c.text).join(''),'two');assert.equal(second.result,'R');
  assert.equal(service.read(id).result,undefined,'the result is handed out once');
  const all=service.readAt(id,0);assert.equal(all.chunks.map(c=>c.text).join(''),'one two');assert.equal(all.next,7);assert.equal(all.lossy,false);
  assert.throws(()=>service.readAt(id,-1),/from/);
  assert.equal(service.list().length,1);service.remove(id);assert.equal(service.list().length,0);
  assert.deepEqual(events,['registered','settled','removed'],'progress staged inside the starter shows at registration, not as an event');
  const late=service.start({kind:'bash',label:'l',run:producer((h,ctl)=>{setTimeout(()=>{h.updateProgress('live');ctl.finish({status:'completed'});},30);})});
  await service.wait(late,2000);assert.ok(events.includes('registered'));
});

test('jobs: kill requests cancel, wait times out without cancelling, abort rejects only while live',async t=>{
  const {service,dispose}=createClaudeJobsService();t.after(dispose);
  const id=service.start({kind:'x',label:'l',run:producer()});
  const timedOut=await service.wait(id,60);assert.equal(timedOut.status,'running');
  const controller=new AbortController();const waiting=service.wait(id,5000,undefined,controller.signal);controller.abort();
  await assert.rejects(waiting,/已取消|ABORT/);
  assert.throws(()=>service.remove(id),/還在執行/);
  assert.equal(service.kill(id,undefined,'because'),'requested');
  const view=await service.wait(id,2000);assert.equal(view.status,'killed');assert.match(view.detail,/because/);
  assert.equal(service.kill(id),'already-finished');
  await assert.rejects(service.wait(id,0),/timeoutMs/);
});

test('jobs: a failing producer settles failed; a throwing starter registers nothing; owner fences access',async t=>{
  const {service,dispose}=createClaudeJobsService();t.after(dispose);
  const failing=service.start({kind:'f',label:'l',run:()=>({cancel(){},done:Promise.reject(new Error('boom'))})});
  assert.equal((await service.wait(failing,2000)).status,'failed');
  assert.throws(()=>service.start({kind:'f',label:'l',run:()=>{throw new Error('starter');}}),/starter/);
  assert.equal(service.list().length,1);
  assert.throws(()=>service.start({kind:'',label:'l',run:()=>{}}),/必要欄位/);
  assert.throws(()=>service.start({kind:'k',label:'l',run:()=>({})}),/cancel/);
  const owned=service.start({kind:'o',label:'l',owner:{session:{id:'S1'}},run:producer()});
  assert.equal(service.get(owned,'S1').owner,'S1');
  assert.throws(()=>service.get(owned,'S2'),/沒有這個工作/);
  assert.throws(()=>service.get(owned),/沒有這個工作/);
  assert.equal(service.list('S2').some(v=>v.id===owned),false);assert.equal(service.list('S1').some(v=>v.id===owned),true);
});

test('jobs: pull sources are pumped into the ring and drained at settlement; dispose cancels live jobs',async t=>{
  const {service,dispose}=createClaudeJobsService();
  let text='',finish;
  const id=service.start({kind:'p',label:'l',output:[{channel:'stdout',read:from=>({text:text.slice(from),nextOffset:text.length,lossy:false})}],run:()=>({cancel(){finish({status:'killed'});},done:new Promise(r=>{finish=r;})})});
  text='late output';finish({status:'completed'});
  await service.wait(id,2000);
  assert.equal(service.readAt(id,0).chunks.map(c=>c.text).join(''),'late output');
  const live=service.start({kind:'live',label:'l',run:producer()});
  await dispose();
  assert.throws(()=>service.start({kind:'x',label:'l',run:producer()}),/關閉/);
  assert.notEqual(service.get(live).status,'running');
});

// ---- userQuestions ----
test('userQuestions.toAskParams / fromAnswer: options, more than four options, multi-select, free text',()=>{
  assert.deepEqual(toAskParams({id:'a',question:'Pick?',options:[{label:'X'},{label:'Y'}]}),{question:'Pick?',options:['X','Y'],labels:['X','Y']});
  const many=toAskParams({id:'a',question:'Pick?',options:['1','2','3','4','5'].map(label=>({label})),multiSelect:true,header:'A very long header indeed'});
  assert.equal(many.options,undefined);assert.match(many.question,/Options: 1 \/ 2 \/ 3 \/ 4 \/ 5/);assert.equal(many.header,'A very long ');assert.equal(many.multiSelect,true);
  assert.deepEqual(fromAnswer({id:'a'},'X',['X','Y']),{id:'a',selected:['X']});
  assert.deepEqual(fromAnswer({id:'a'},'something else',['X','Y']),{id:'a',selected:[],custom:'something else'});
  assert.deepEqual(fromAnswer({id:'a',multiSelect:true},'X, Y',['X','Y']),{id:'a',selected:['X','Y']});
  assert.deepEqual(fromAnswer({id:'a',multiSelect:true},'X, other',['X','Y']),{id:'a',selected:['X'],custom:'other'});
});

test('userQuestions.ask: sequential ui.ask, explicit errors for cancel, bad input and a missing channel',async()=>{
  const seen=[];
  const service=createClaudeUserQuestionsService({requestHost:async(method,params)=>{seen.push([method,params]);return {answer:'Y'};}});
  const result=await service.ask({questions:[{id:'q',question:'Pick?',options:[{label:'X'},{label:'Y'}]}]});
  assert.deepEqual(result,{answers:[{id:'q',selected:['Y']}]});assert.equal(seen[0][0],'ui.ask');
  await assert.rejects(service.ask({questions:[]}),/questions/);
  await assert.rejects(service.ask({questions:[{id:'',question:'x'}]}),/id/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(service.ask({questions:[{id:'q',question:'x'}],signal:controller.signal}),/已取消/);
  const dismissed=createClaudeUserQuestionsService({requestHost:async()=>{throw Object.assign(new Error('x'),{code:'USER_DISMISSED'});}});
  await assert.rejects(dismissed.ask({questions:[{id:'q',question:'x'}]}),e=>e.code==='DSH_USER_QUESTION_CANCELLED'&&/關閉了問題/.test(e.message));
  const invalid=createClaudeUserQuestionsService({requestHost:async()=>({nothing:true})});
  await assert.rejects(invalid.ask({questions:[{id:'q',question:'x'}]}),e=>e.code==='DSH_USER_QUESTION_REPLY_INVALID');
  await assert.rejects(createClaudeUserQuestionsService().ask({questions:[{id:'q',question:'x'}]}),e=>e.code==='DSH_USER_QUESTION_UNAVAILABLE');
  assert.throws(()=>service.askTimed(),/DSH_MODULE_UNSUPPORTED|askTimed/);
});

// ---- credentials ----
test('credentials: reads the environment per call; missing or empty is an error that names the variable and never the value',async()=>{
  const env={PRESENT:'value-1',EMPTY:''};
  const service=createClaudeCredentialsService({env});
  assert.deepEqual(await service.resolve('PRESENT'),{value:'value-1',source:'env'});
  env.PRESENT='value-2';assert.equal((await service.resolve('PRESENT')).value,'value-2','no caching between calls');
  for(const ref of ['EMPTY','ABSENT'])await assert.rejects(service.resolve(ref),e=>e.code==='DSH_CREDENTIAL_MISSING'&&e.message.includes(`缺少金鑰 ${ref}`)&&e.message.includes('環境變數'));
  await assert.rejects(service.resolve('has space'),e=>e.code==='DSH_CREDENTIAL_BAD_REF');
  await assert.rejects(service.resolve(undefined),e=>e.code==='DSH_CREDENTIAL_BAD_REF');
  assert.deepEqual(await service.describe('PRESENT'),{configured:true,source:'env',writable:false});
  assert.deepEqual(await service.describe('EMPTY'),{configured:false,writable:false});
  for(const method of ['set','unset','readRecord','describeRecord','listRecords','modifyRecord','deleteRecord'])assert.throws(()=>service[method]('X','v'),e=>e.code==='DSH_MODULE_UNSUPPORTED',method);
});

// ---- subagents ----
const prompt=text=>[{type:'text',text}];
test('subagents: one spawn provider; startActivation maps to agent.spawn; events and the result shape',async t=>{
  const seen=[],events=[];
  const {service,dispose}=createClaudeSubagentsService({requestHost:async(method,params)=>{seen.push([method,params]);return {text:'answer'};},emit:(...a)=>events.push(a[0])});
  t.after(dispose);
  assert.deepEqual(service.list(),['spawn']);
  const provider=service.getProvider('spawn');
  assert.deepEqual(provider.capabilities,{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false});
  assert.equal(provider.prepareContinuable,undefined);assert.equal(service.getProvider('other'),undefined);
  const activation=await service.startActivation({provider:'spawn',label:'my task',request:{prompt:prompt('do it'),parent:{session:{id:'P'}},agentOptions:{model:'ignored',subagentType:'general-purpose'}},signal:new AbortController().signal,delivery:'parent'});
  const result=await activation.result;
  assert.deepEqual(result,{output:[{type:'text',text:'answer'}],stopReason:'completed'});
  assert.deepEqual(seen[0],['agent.spawn',{prompt:'do it',description:'my task',subagentType:'general-purpose'}]);
  assert.deepEqual(events,['subagent/start','subagent/end']);
  assert.equal((await service.listChildren('P')).length,1);assert.equal((await service.listChildren('nobody')).length,0);
  await activation.dispose();assert.equal((await service.listChildren()).length,0);
});

test('subagents: unsupported requests and DISABLED are explicit, never pretended',async t=>{
  const {service,dispose}=createClaudeSubagentsService({requestHost:async()=>{throw Object.assign(new Error('off'),{code:'DISABLED'});}});t.after(dispose);
  const base={provider:'spawn',label:'l',signal:new AbortController().signal,delivery:'parent'};
  await assert.rejects(service.startActivation({...base,provider:'nope',request:{prompt:prompt('x')}}),e=>e.code==='DSH_SUBAGENT_PROVIDER_UNKNOWN');
  await assert.rejects(service.startActivation({...base,request:{prompt:prompt('x'),agentPreset:'p'}}),/agentPreset/);
  await assert.rejects(service.startActivation({...base,request:{prompt:prompt('x'),outputSchema:{type:'object'}}}),/outputSchema/);
  await assert.rejects(service.startActivation({...base,request:{prompt:[{type:'image'}]}}),/image/);
  await assert.rejects(service.startActivation({...base,request:{prompt:[]}}),/prompt/);
  const activation=await service.startActivation({...base,request:{prompt:prompt('x')}});
  await assert.rejects(activation.result,e=>e.code==='DSH_AGENTS_DISABLED'&&/allowAgents/.test(e.message));
  for(const method of ['startContinuable','sendMessage','registerProvider'])assert.throws(()=>service[method]({}),e=>e.code==='DSH_MODULE_UNSUPPORTED',method);
  const noChannel=createClaudeSubagentsService().service;
  await assert.rejects(noChannel.startActivation({...base,request:{prompt:prompt('x')}}),/反向請求通道/);
});

test('subagents: interrupt aborts the wait, waitForChildren joins running ones, a late dispose is safe',async t=>{
  let release;const {service,dispose}=createClaudeSubagentsService({requestHost:(method,params,{signal})=>new Promise((resolve,reject)=>{release=()=>resolve({text:'late'});signal.addEventListener('abort',()=>reject(Object.assign(new Error('c'),{code:'HOST_CANCELED'})));})});t.after(dispose);
  const base={provider:'spawn',label:'l',signal:new AbortController().signal,delivery:'parent'};
  const a=await service.startActivation({...base,request:{prompt:prompt('a')}});
  let joined=false;const waiting=service.waitForChildren({}).then(v=>{joined=v;});
  await sleep(30);release();await a.result;await waiting;assert.equal(joined,true);
  assert.equal(await service.waitForChildren({}),false);
  const b=await service.startActivation({...base,request:{prompt:prompt('b')}});
  service.interrupt(a.childId);service.interrupt(b.childId);
  await assert.rejects(b.result,/c|cancel/i);
});

// ---- connection ----
test('connection: registrations succeed, are remembered and released; there is no frontend',async()=>{
  const connection=createClaudeConnectionService();
  const off=await connection.rpc.handle('/a',()=>{});connection.register({}, '/b',()=>{});await connection.fetch.register({path:'/c'});
  assert.deepEqual(connection.registeredChannels().sort(),['fetch:/c','rpc:/a','rpc:/b']);
  await off();await off();assert.deepEqual(connection.registeredChannels().sort(),['fetch:/c','rpc:/b']);
  assert.equal(connection.frontendAttached,false);assert.equal(connection.requestRejection,undefined);
  const installed=await installConnection();
  assert.equal(installed.unsupported[0].feature,'DSH frontend connection');
  assert.equal(installed.diagnostics[0].status,'partial');
});

// ---- storage backend (kv facet) ----
class FakeStorageError extends Error{constructor(code,message){super(message);this.code=code;}}
test('storage backend: persists, survives reopen, honours versions and compatibleVersions, refuses damage',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'claude-kv-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const descriptor={name:'notes_unit',version:1,tables:['notes'],hasGlobal:true};
  let backend=createKvBackend({dir,StorageError:FakeStorageError});
  const unit=await backend.kv.open(descriptor);
  assert.deepEqual(await unit.loadAll(),{tables:{notes:{}},global:null});
  await unit.putRecord('notes','k1',{text:'a'});await unit.putRecord('notes','k2',{text:'b'});await unit.deleteRecord('notes','k2');await unit.setGlobal({n:1});
  await assert.rejects(backend.kv.open(descriptor),e=>e.code==='already-open');
  await assert.rejects(unit.putRecord('missing','k',1),e=>e.code==='malformed-medium');
  await backend.close();
  await assert.rejects(unit.loadAll(),e=>e.code==='closed');
  backend=createKvBackend({dir,StorageError:FakeStorageError});
  const again=await backend.kv.open(descriptor);
  assert.deepEqual(await again.loadAll(),{tables:{notes:{k1:{text:'a'}}},global:{n:1}});
  await again.close();
  await assert.rejects(backend.kv.open({...descriptor,version:2}),e=>e.code==='version-mismatch');
  const upgraded=await backend.kv.open({...descriptor,version:2,compatibleVersions:[1]});
  assert.equal((await upgraded.loadAll()).tables.notes.k1.text,'a');await upgraded.putRecord('notes','k3',{text:'c'});await upgraded.close();
  await assert.rejects(backend.kv.open({...descriptor,version:1}),e=>e.code==='version-mismatch','writes stamp the new version');
  await assert.rejects(backend.kv.open({...descriptor,name:'bad name'}),e=>e.code==='malformed-medium');
  await fs.writeFile(path.join(dir,'broken.json'),'{not json');
  await assert.rejects(backend.kv.open({name:'broken',version:1,tables:[],hasGlobal:false}),e=>e.code==='malformed-medium');
  const leftovers=(await fs.readdir(dir)).filter(f=>f.endsWith('.tmp'));assert.deepEqual(leftovers,[],'no temp files remain');
});

// ---- selection / registry / protocol ----
test('the Claude registry carries every new service and selection picks them up from an analysis plan',()=>{
  const names=['shell','subprocess','subagents','credentials','storageDomain','userQuestions','jobs','connection'];
  for(const name of names){
    assert.ok([...claudeRegistry.values()].some(m=>m.descriptor.services.includes(name)),`${name} has a Claude module`);
    assert.equal(isKnownDshService(name),true,`${name} is a known DSH service`);
  }
  const rows=selectModules({host:{services:names}},{services:names},{host:'claude',mcp:true,skills:true},claudeRegistry);
  for(const name of names){
    const row=rows.find(r=>r.services.includes(name));
    assert.ok(row,name);assert.equal(row.available,true,name);
  }
  assert.deepEqual(rows.uncertainServices,[]);
  for(const [id,module] of claudeRegistry)assert.equal(module.descriptor.id,id);
});

test('reverse channel: ui.ask is a known method with its own timeout; unknown names are still refused',async()=>{
  assert.ok(REVERSE_METHODS.includes('ui.ask'));
  const lines=[];const channel=createReverseChannel({emit:l=>lines.push(l),timeouts:{'ui.ask':30}});
  await assert.rejects(channel.request('ui.ask',{question:'?'}),e=>e.code==='REVERSE_REQUEST_TIMEOUT');
  assert.equal(lines[0].method,'ui.ask');
  const pending=channel.request('ui.ask',{question:'?'});channel.reply({id:lines[1].id,result:{answer:'ok'}});
  assert.deepEqual(await pending,{answer:'ok'});
  await assert.rejects(channel.request('ui.nothing',{}),e=>e.code==='REVERSE_METHOD_UNSUPPORTED');
});
