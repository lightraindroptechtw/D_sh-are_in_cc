import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadDshHost} from '../lib/dsh-host.mjs';
import {inspectSource} from '../lib/inspect.mjs';
const runtimeRoot=fileURLToPath(new URL('../',import.meta.url));
async function fixture(t,source){
  const root=await mkdtemp(join(tmpdir(),'dsh-ui-backend-')),sourceRoot=join(root,'source');await mkdir(sourceRoot);
  await writeFile(join(sourceRoot,'package.json'),'{"type":"module"}');await writeFile(join(sourceRoot,'index.ts'),source);
  const hosts=[];t.after(async()=>{try{for(const host of hosts)await host.dispose();}finally{await rm(root,{recursive:true,force:true});}});
  return {root,sourceRoot,async load(options={}){const host=await loadDshHost({entry:join(sourceRoot,'index.ts'),sourceRoot,stateDir:join(root,'state'),runtimeRoot,services:['connection','typert'],uiBackend:true,...options});hosts.push(host);return host;}};
}
test('registered Connection calls execute the actual handler and disposal withdraws it',async t=>{
  const f=await fixture(t,`export const inject=['connection'];export function apply(ctx){let calls=0;const stop=ctx.connection.rpc.handle('/probe',async(endpoint,payload,signal,peer)=>({ok:true,value:{endpoint,payload,calls:++calls,aborted:signal.aborted,principal:peer.principal.kind}}));ctx.connection.rpc.handle('/relay',(endpoint,payload,signal)=>ctx.connection.rpc.call('/probe',endpoint,payload,signal));ctx.on('bridge/withdraw',()=>stop());}`);
  const host=await f.load();
  assert.deepEqual((await host.request('ui.backend.describe')).connection.channels,['/probe','/relay']);
  const input={channel:'/probe',endpoint:'echo',payload:{text:'actual'}};
  assert.deepEqual(await host.request('ui.connection.call',input),{ok:true,value:{endpoint:'echo',payload:{text:'actual'},calls:1,aborted:false,principal:'owner'}});
  assert.equal((await host.request('ui.connection.call',input)).value.calls,2);
  assert.equal((await host.request('ui.connection.call',{...input,channel:'/relay'})).value.calls,3,'plugin rpc.call must execute the original registered handler');
  await assert.rejects(host.request('ui.connection.call',{...input,channel:'/unregistered'}),{code:'UI_BACKEND_NOT_REGISTERED'});
  await assert.rejects(host.request('ui.connection.call',{...input,endpoint:'../escape'}),{code:'UI_BACKEND_INVALID'});
  await host.dispatchEvent('bridge/withdraw',[]);
  await assert.rejects(host.request('ui.connection.call',input),{code:'UI_BACKEND_NOT_REGISTERED'});
});
test('Connection cancellation reaches the original AbortSignal and supports shared interception',async t=>{
  const f=await fixture(t,`export const inject=['connection'];export function apply(ctx){ctx.connection.rpc.intercept('/api',endpoint=>endpoint==='probe/state',async()=>({ok:true,value:'intercepted'}));ctx.connection.rpc.handle('/wait',async(_endpoint,_payload,signal)=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve({ok:false,error:{code:'cancelled',message:'aborted',details:{}}}),{once:true})));}`);
  const host=await f.load();
  assert.deepEqual(await host.request('ui.connection.call',{channel:'/api',endpoint:'probe/state',payload:null}),{ok:true,value:'intercepted'});
  const controller=new AbortController();const pending=host.request('ui.connection.call',{channel:'/wait',endpoint:'sleep',payload:null},{signal:controller.signal});
  setTimeout(()=>controller.abort(),50);await assert.rejects(pending,error=>['HOST_CANCELED','HOST_CANCELED_RESTART'].includes(error.code));
});
test('Typert exported descriptor validates inputs and executes only explicitly published plugin methods',async t=>{
  const f=await fixture(t,`import {TypertRemoteService} from '@deepseek-ai/dsh-typert-protocol';import {z} from 'zod';export const inject=['typert'];const codec=schema=>({mode:'strict',schema});export const TYPERT={package:'probe',face:'host',schemas:[],invocations:[{id:'probe#counter/add',namespace:'counter',service:'counter',method:'add',invocation:{kind:'direct'},parameters:[{name:'amount',wire:'amount',source:'json',codec:codec(z.number().int())}],result:codec(z.number())}]};class Counter extends TypertRemoteService{constructor(ctx){super(ctx,'counter');}count=0;add(amount){return this.count+=amount;}secret(){return 'unpublished';}}export function apply(ctx){new Counter(ctx);}`);
  const host=await f.load();
  assert.deepEqual(await host.request('ui.typert.call',{namespace:'counter',method:'add',args:[2]}),{ok:true,value:2});
  assert.deepEqual(await host.request('ui.typert.call',{namespace:'counter',method:'add',args:{amount:3}}),{ok:true,value:5});
  assert.deepEqual(await host.request('ui.connection.call',{channel:'/api',endpoint:'counter/add',payload:{args:{amount:0}}}),{ok:true,value:5});
  assert.equal((await host.request('ui.typert.call',{namespace:'counter',method:'add',args:['bad']})).error.code,'gateway/bad-request');
  assert.equal((await host.request('ui.typert.call',{namespace:'counter',method:'add',args:[1]})).value,6,'invalid input must not execute the method');
  await assert.rejects(host.request('ui.typert.call',{namespace:'counter',method:'secret',args:[]}),{code:'UI_BACKEND_NOT_REGISTERED'});
  await assert.rejects(host.request('ui.typert.call',{namespace:'counter',method:'constructor',args:[]}),{code:'UI_BACKEND_INVALID'});
  await assert.rejects(host.request('ui.typert.call',{namespace:'tools',method:'execute',args:[]}),{code:'UI_BACKEND_NOT_REGISTERED'});
});
test('Typert manual contribution is live, removable, and cannot export a host-owned service',async t=>{
  const f=await fixture(t,`import {bindTypertRemote} from '@deepseek-ai/dsh-typert-protocol';export const inject=['typert'];const method=(service,method)=>({id:'manual#'+service+'/'+method,service,namespace:service,method,invocation:{kind:'direct'},parameters:[],result:{mode:'src-json'}});export function apply(ctx){const api={read:()=>({text:'real source'}),hidden:()=>42};api.typertRemote=bindTypertRemote(api,'manual');ctx.provide('manual',api);const stop=ctx.typert.register({package:'manual',invocations:[method('manual','read'),method('tools','schemas')]});ctx.on('bridge/withdraw',()=>stop());}`);
  const host=await f.load();assert.deepEqual(await host.request('ui.typert.call',{namespace:'manual',method:'read',args:[]}),{ok:true,value:{text:'real source'}});
  await assert.rejects(host.request('ui.typert.call',{namespace:'tools',method:'schemas',args:[]}),{code:'UI_BACKEND_NOT_REGISTERED'});
  await host.dispatchEvent('bridge/withdraw',[]);assert.equal((await host.request('ui.typert.call',{namespace:'manual',method:'read',args:[]})).error.code,'gateway/definition-unavailable');
});
test('Typert preserves a strict void result and a package without a screen has no UI backend',async t=>{
  const f=await fixture(t,`import {bindTypertRemote} from '@deepseek-ai/dsh-typert-protocol';import {z} from 'zod';export const inject=['typert'];export function apply(ctx){const api={clear(){}};api.typertRemote=bindTypertRemote(api,'voidProbe');ctx.provide('voidProbe',api);ctx.typert.register({package:'void-probe',invocations:[{namespace:'voidProbe',service:'voidProbe',method:'clear',invocation:{kind:'direct'},parameters:[],result:{mode:'strict',schema:z.void()}}]});}`);
  const host=await f.load();const result=await host.request('ui.connection.call',{channel:'/api',endpoint:'voidProbe/clear',payload:{args:{}}});
  assert.equal(result.ok,true);assert.equal(result.value,undefined);
  // Not ported: the Codex explicit-disable option (disabledModules) does not exist in the Claude Code host. Without a screen the services are simply absent:
  const g=await fixture(t,'export function apply(){}');const plain=await g.load({services:[],uiBackend:false});
  await assert.rejects(plain.request('ui.connection.call',{channel:'/probe',endpoint:'read',payload:{}}),{code:'UI_BACKEND_UNSUPPORTED'});
});
test('real CapMap community backend serves a graph through its registered Connection handler',async t=>{
  const sourceRoot=resolve(runtimeRoot,'../../work/dsh-corpus-100/sources/_chenjh12_dsh-capmap-viz_0.2.4');
  try{await access(join(sourceRoot,'lib/index.js'));}catch{t.skip('Optional local community corpus is absent');return;}
  const f=await fixture(t,'');const docs=join(f.root,'project','docs');await mkdir(docs,{recursive:true});await writeFile(join(docs,'overview.md'),'# Actual graph\n\nBackend source verification.');
  const host=await f.load({entry:join(sourceRoot,'lib/index.js'),sourceRoot});
  const response=await host.request('ui.connection.call',{channel:'/capmap',endpoint:'revision',payload:{root:dirname(docs)}});
  assert.deepEqual(response,{ok:true,value:{revision:0}});
  const graph=await host.request('ui.connection.call',{channel:'/capmap',endpoint:'parse',payload:{root:dirname(docs)}});
  assert.equal(graph.ok,true,JSON.stringify(graph));assert.equal(graph.value.docsRoot,docs);assert.ok(Array.isArray(graph.value.nodes));
  const content=await host.request('ui.connection.call',{channel:'/capmap',endpoint:'read',payload:{root:dirname(docs),path:'overview.md'}});
  assert.deepEqual(content,{ok:true,value:{path:'overview.md',text:'# Actual graph\n\nBackend source verification.'}});
  const invalid=await host.request('ui.connection.call',{channel:'/capmap',endpoint:'parse',payload:{}});assert.equal(invalid.ok,false);assert.match(invalid.error.message,/root/);
});
test('real Graft community Typert backend reads local status through the generated named-argument contract',async t=>{
  const sourceRoot=resolve(runtimeRoot,'../../work/dsh-corpus-100/sources/dsh-graft-plugin_0.2.1');
  try{await access(join(sourceRoot,'src/index.js'));}catch{t.skip('Optional local community corpus is absent');return;}
  const f=await fixture(t,'');const host=await f.load({entry:join(sourceRoot,'src/index.js'),sourceRoot,config:{cwd:f.root,tools:false,command:false,autoBuild:false}});
  const state=await host.request('ui.backend.describe');assert.ok(state.typert.sourceServices.some(item=>item.namespace==='graftStatus'&&item.methods.includes('status')),JSON.stringify(state));
  const result=await host.request('ui.connection.call',{channel:'/api',endpoint:'graftStatus/status',payload:{args:{sessionId:'missing-fixture-session'}}});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.value.ok,false);assert.match(result.value.reason,/no graft index/);assert.equal(result.value.from,f.root);
  await assert.rejects(host.request('ui.typert.call',{namespace:'graftStatus',method:'constructor',args:[]}),{code:'UI_BACKEND_INVALID'});
});
// The Codex test 'worker journals committed credential notifications' is not ported: it drives the Codex credential bridge (codex.credentials.*);
// the Claude Code credentials service is read-only (lib/modules/claude/credentials.mjs) and emits no credential events.
test('worker forwards real settings document revisions without configuration contents',async t=>{
  const f=await fixture(t,`import z from '@deepseek-ai/schemastery';export const name='event-settings';export const Config=z.object({count:z.natural().default(0).volatile()});export function apply(){}`);
  const host=await f.load({services:['settings']});const rows=await host.request('settings.describe');const row=rows.find(item=>item.ns==='event-settings');assert.ok(row);
  const before=await host.request('ui.events.poll',{after:0});
  const update=await host.request('ui.connection.call',{channel:'/api',endpoint:'settings/update',payload:{args:{ns:'event-settings',patch:{count:11},expectedRevision:row.revision}}});
  assert.equal(update.ok,true,JSON.stringify(update));
  const after=await host.request('ui.events.poll',{after:before.cursor});const event=after.events.find(item=>item.name==='settings/document-updated'&&item.args[0]==='event-settings');
  assert.ok(event,JSON.stringify(after));assert.ok(event.args[1]>row.revision);assert.equal(event.args.length,2);assert.ok(!JSON.stringify(after).includes('count'));
});
test('real Zhihu settings namespace follows its source patch mount id',async t=>{
  const sourceRoot=resolve(runtimeRoot,'../../work/dsh-corpus-100/sources/dsh-zhihu-search_2.2.1');
  try{await access(join(sourceRoot,'lib/index.js'));}catch{t.skip('Optional local community corpus is absent');return;}
  const plan=await inspectSource({root:sourceRoot});assert.equal(plan.entryId,'dsh-zhihu-search');assert.equal(plan.entries,undefined);
  const f=await fixture(t,'');const host=await f.load({entry:join(sourceRoot,'lib/index.js'),sourceRoot,services:['settings'],plan:{entryId:plan.entryId},bridgeRequest:()=>{throw Error('No credential or network requests are expected');}});
  const descriptors=await host.request('settings.describe');assert.ok(descriptors.some(row=>row.ns==='dsh-zhihu-search'),JSON.stringify(descriptors.map(row=>row.ns)));
  assert.ok(!descriptors.some(row=>row.ns==='zhihu-search'));
  const described=await host.request('ui.connection.call',{channel:'/api',endpoint:'settings/describe',payload:{args:{}}});assert.equal(described.ok,true);assert.ok(described.value.namespaces.some(row=>row.ns==='dsh-zhihu-search'));
});
test('explicit entry id wins over the source plan mount id',async t=>{
  const f=await fixture(t,`import z from '@deepseek-ai/schemastery';export const name='display-name';export const Config=z.object({count:z.natural().default(0).volatile()});export function apply(){}`);
  const host=await f.load({services:['settings'],entryId:'explicit-entry',plan:{entryId:'source-entry'}});
  assert.ok((await host.request('settings.describe')).some(row=>row.ns==='explicit-entry'));
});
