import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import React from 'react';
import {createResources,protocolOf,parseFileAddress,createFileAccess} from '../ui/resources.mjs';
import {createSidebarTabs,createRuntime} from '../ui/runtime.mjs';
const address='dsh-resource://file/session/s1/design.drawio';
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('file address parsing matches the pinned official parser without normalizing paths or guessing session directories',async t=>{
  const officialUrl=new URL('../../../work/dsh-native-investigation/cli-install/node_modules/@deepseek-ai/dsh-util-workspace-path/lib/index.js',import.meta.url);
  try{await fs.access(officialUrl);}catch{return t.skip('需要工作區中固定版本的官方位址解析器。');}
  const official=await import(officialUrl.href);
  for(const input of [address,'dsh-resource://file/session/s%2F1/a%20b/../c%2Fd.txt?line=1#x','dsh-resource://file/session/known/','dsh-resource://file/absolute/C:/A%20B/x.txt','dsh-resource://file/absolute/home/x.txt','dsh-resource://file/absolute//server/share/x.txt','dsh-resource://file/session//x','dsh-resource://file/session/id','dsh-resource://file/session/id/%zz','https://example.test/a','dsh-resource://file/bogus/path'])assert.deepEqual(parseFileAddress(input),official.parseFileAddress(input),input);
  assert.deepEqual(parseFileAddress('dsh-resource://file/session/real-id/../x'),{scope:'session',sessionId:'real-id',path:'../x'});
});

test('file provider polls actual metadata frames, reports failures, recovers and cancels the active request',async()=>{
  const calls=[],pending=[],file=createFileAccess({pollIntervalMs:1,rpc:async(method,params,{signal})=>{
    calls.push({method,params,signal});if(calls.length===1)return {ok:true,value:{absolutePath:'C:/fixture/design.drawio',version:'opaque-1',bytes:9}};
    if(calls.length===2)return {ok:false,error:{code:'workspace-file/not-found',message:'檔案不存在',details:{}}};
    if(calls.length===3)return {ok:true,value:{absolutePath:'C:/fixture/design.drawio',version:'opaque-2',bytes:12}};
    return new Promise(resolve=>{pending.push(resolve);signal.addEventListener('abort',()=>resolve({ok:false,error:{code:'cancelled',message:'已取消',details:{}}}),{once:true});});
  }}),pin=new AbortController(),frames=file.provider.open(address,{signal:pin.signal});
  assert.equal((await frames.next()).value.value.version,'opaque-1');
  assert.equal((await frames.next()).value.error.code,'workspace-file/not-found');
  assert.equal((await frames.next()).value.value.version,'opaque-2');
  const final=frames.next();while(calls.length<4)await tick();pin.abort();assert.equal((await final).done,true);assert.equal(calls.at(-1).signal.aborted,true);assert.deepEqual(calls[0].params,{address,operation:'stat'});assert.equal(calls[0].method,'ui.resources.file');
});

test('file content access forwards the exact address and line window with cancellation outside business data',async()=>{
  const calls=[],access=createFileAccess({rpc:async(...args)=>{calls.push(args);return {ok:true,value:{absolutePath:'C:/fixture/x',version:'opaque',offset:4,text:'actual file text',lines:1,eof:true}};}}),controller=new AbortController();
  const result=await access.readText(address,{offset:4,limit:20},controller.signal);assert.equal(result.value.text,'actual file text');assert.deepEqual(calls[0][1],{address,operation:'read',offset:4,limit:20});assert.equal(calls[0][2].signal,controller.signal);
  controller.abort();await assert.rejects(access.readText(address,{},controller.signal),{name:'AbortError'});assert.equal(calls.length,1);
});

test('resource claims follow priority, longest matching glob, case, dotfiles and synchronous veto',()=>{
  const tabs=createSidebarTabs();
  tabs.registry.register({id:'text',kind:'text',priority:'fallback',patterns:['dsh-resource://file/**']});
  tabs.registry.register({id:'generic',kind:'generic',patterns:['*.drawio']});
  tabs.registry.register({id:'specific',kind:'specific',patterns:['**/design.drawio'],canOpen:uri=>!uri.includes('/blocked/')});
  assert.deepEqual(tabs.registry.candidates(address).map(row=>row.kind),['specific','generic','text']);
  assert.equal(tabs.registry.claim('dsh-resource://file/session/s1/.TEST.DRAWIO').kind,'generic');
  assert.equal(tabs.registry.claim('dsh-resource://file/session/blocked/design.drawio').kind,'generic');
  assert.equal(tabs.registry.claim(address,'text').kind,'text');
  assert.equal(tabs.registry.candidates('invalid').length,0);
  assert.equal(tabs.registry.claim('dsh-resource://file/session/s1/x.txt').kind,'text');
  assert.throws(()=>tabs.service.openResource('https://example.test/x.drawio'),{code:'UI_RESOURCE_ADDRESS_INVALID'});
  assert.throws(()=>tabs.service.openResource('dsh-resource://unknown/x'),{code:'UI_RESOURCE_UNCLAIMED'});
  tabs.registry.register({id:'async',kind:'async',patterns:['dsh-resource://other/**'],canOpen:async()=>true});
  assert.throws(()=>tabs.service.openResource('dsh-resource://other/x'),{code:'UI_RESOURCE_PREDICATE_INVALID'});
});

test('same kind and address reveal existing identity, update params/revision and keep captured title',()=>{
  let label='first';const tabs=createSidebarTabs();tabs.registry.register({id:'canvas',kind:'canvas',patterns:['*.drawio'],title:()=>label});
  tabs.service.openResource(address,{params:{line:7}});const first=tabs.service.active(),signal=tabs.info(first.id,true).tab.signal;
  tabs.service.openResource(address.replace('design','second'));const second=tabs.service.active();label='changed';
  tabs.service.openResource(address,{params:{line:12}});const revealed=tabs.service.active();
  assert.equal(revealed.id,first.id);assert.equal(revealed.title,'first');assert.deepEqual(revealed.navigation,{address,params:{line:12},revision:2});
  assert.equal(tabs.state.getSnapshot().tabs.length,2);assert.equal(signal.aborted,false);assert.equal(tabs.info(first.id,false).tab.signal,signal);
  tabs.service.openResource(address,{revealIfOpened:false});assert.equal(tabs.state.getSnapshot().tabs.length,3);
  assert.notEqual(tabs.service.active().id,first.id);tabs.close(second.id);assert.equal(signal.aborted,false);tabs.close(first.id);assert.equal(signal.aborted,true);
});

test('tab-owned opens preserve explicit session identity, replace in position and abort only the removed occurrence',()=>{
  const tabs=createSidebarTabs();tabs.registry.register({id:'canvas',kind:'canvas',patterns:['*.drawio']});
  tabs.service.openTabIn('explicit-session','canvas');const first=tabs.service.active(),info=tabs.info(first.id,true);
  info.tab.actions.openResource(address);assert.equal(tabs.service.active().sessionId,'explicit-session');assert.equal(info.tab.signal.aborted,false);
  const opened=tabs.service.active(),openedInfo=tabs.info(opened.id,true);
  openedInfo.tab.actions.openResource(address.replace('design','replacement'),{replaceTab:true});
  assert.equal(openedInfo.tab.signal.aborted,true);assert.equal(info.tab.signal.aborted,false);assert.equal(tabs.state.getSnapshot().tabs.length,2);
  assert.equal(tabs.state.getSnapshot().tabs[1].contentId,address.replace('design','replacement'));
  tabs.dispose();assert.equal(info.tab.signal.aborted,true);assert.throws(()=>tabs.service.openTab('canvas'),{code:'UI_TAB_UNAVAILABLE'});
});

test('extension takeover switches body registration and restores builtin without destroying tab lifetime',()=>{
  const tabs=createSidebarTabs();tabs.registry.register({id:'builtin',kind:'canvas',priority:'builtin',patterns:['*.drawio']});tabs.service.openResource(address);
  const id=tabs.service.active().id,signal=tabs.info(id,true).tab.signal;
  const off=tabs.registry.register({id:'extension',kind:'canvas',patterns:['*.drawio']});assert.equal(tabs.service.active().registrationId,'extension');
  assert.equal(tabs.service.active().id,id);assert.equal(signal.aborted,false);
  assert.throws(()=>tabs.registry.register({id:'duplicate',kind:'canvas'}),{code:'UI_TAB_CONFLICT'});
  off();assert.equal(tabs.service.active().registrationId,'builtin');assert.equal(signal.aborted,false);tabs.dispose();assert.equal(signal.aborted,true);
});

test('resources share provider stream across subscribers and pins, retain last value on failure and abort at final release',async()=>{
  const resources=createResources(),controllers=[];let push;
  resources.register({protocol:'file',async *open(_address,{signal}){controllers.push(signal);yield {ok:true,value:{version:'one'}};while(!signal.aborted){const frame=await new Promise(resolve=>{push=resolve;signal.addEventListener('abort',()=>resolve(null),{once:true});});if(frame)yield frame;}}});
  const source=resources.source(address);assert.equal(source,resources.source(address));assert.equal(controllers.length,0);
  const a=source.subscribe(()=>{}),b=source.subscribe(()=>{});await tick();assert.equal(controllers.length,1);assert.equal(source.getSnapshot().status,'live');
  push({ok:false,error:{code:'file/missing',message:'找不到檔案',details:{}}});await tick();assert.equal(source.getSnapshot().status,'failed');assert.equal(source.getSnapshot().value.version,'one');
  const pin=new AbortController();resources.pin(address,pin.signal);a();b();assert.equal(controllers[0].aborted,false);pin.abort();await tick();assert.equal(controllers[0].aborted,true);assert.equal(source.getSnapshot().status,'loading');assert.equal(source.getSnapshot().value,undefined);
  const c=source.subscribe(()=>{});await tick();assert.equal(controllers.length,2);c();resources.dispose();
});

test('provider attachment, withdrawal, replacement and malformed-stream failures do not apply stale frames',async()=>{
  const reported=[],resources=createResources({report:error=>reported.push(error)}),source=resources.source(address);const off=source.subscribe(()=>{});
  assert.equal(source.getSnapshot().status,'none');let resume;
  const unregister=resources.register({protocol:'file',async *open(){await new Promise(resolve=>resume=resolve);yield {ok:true,value:'stale'};}});await tick();assert.equal(source.getSnapshot().status,'loading');
  assert.throws(()=>resources.register({protocol:'FILE',open(){}}),{code:'UI_RESOURCE_PROVIDER_DUPLICATE'});unregister();resume();await tick();assert.equal(source.getSnapshot().status,'none');
  resources.register({protocol:'file',async *open(){yield {ok:true,value:'new'};yield {wrong:true};}});await tick();assert.equal(source.getSnapshot().status,'failed');assert.equal(source.getSnapshot().value,'new');assert.equal(reported[0].code,'UI_RESOURCE_FRAME_INVALID');
  assert.equal(resources.source('sidebar://canvas').getSnapshot().status,'none');assert.equal(protocolOf('dsh-resource://FILE/a'),'file');off();resources.dispose();
});

test('runtime owns original-style provider and resource tab registration through unload',async()=>{
  const runtime=createRuntime();let scope,signal;
  const custom='dsh-resource://custom/session/s1/design.drawio';
  runtime.load({id:'resource-owner',factory:()=>({apply(ctx){scope=ctx;ctx.resources.register({protocol:'custom',async *open(_,{signal:current}){signal=current;yield {ok:true,value:'metadata'};}});ctx.sidebarRightTabs.register({id:'resource-owner',kind:'canvas',patterns:['*.drawio']});ctx.sidebarRight.openResource(custom);}})});
  await tick();assert.equal(runtime.services.resources.source(custom).getSnapshot().value,'metadata');assert.deepEqual(runtime.diagnostics,[]);scope.dispose();assert.equal(signal.aborted,true);assert.equal(runtime.sidebarTabs.state.getSnapshot().tabs.length,0);runtime.dispose();
});

test('unmodified corpus DrawAI registers its actual address route and parses the navigation file path',async t=>{
  const file=new URL('../../../work/dsh-corpus-100/sources/dsh-drawai_0.3.2/lib/client.js',import.meta.url);
  try{await fs.access(file);}catch{return t.skip('需要工作區中的未修改 DrawAI 原始插件。');}
  const source=await fs.readFile(file,'utf8');let module;const styles=[];
  const document={createElement:()=>({setAttribute(){},parentNode:null}),head:{appendChild(style){styles.push(style);style.parentNode={removeChild(){styles.splice(styles.indexOf(style),1);}};}}};
  vm.runInNewContext(source,{window:{__ModuleLoader__:{load:value=>module=value}},document,console,URL,AbortController,TextEncoder,TextDecoder,setTimeout,clearTimeout,setInterval,clearInterval});
  const runtime=createRuntime({libraries:{react:React}});runtime.load(module);
  assert.equal(runtime.modules.get('dsh-drawai').status,'loaded');assert.ok(runtime.modules.get('dsh-drawai').context.get('timer'));assert.equal(runtime.diagnostics.some(row=>row.service==='timer'||row.services?.includes('timer')),false);const registration=runtime.sidebarTabs.catalog.getSnapshot().find(row=>row.patterns?.includes('**/*.drawio'));assert.ok(registration);
  runtime.services.sidebarRight.openResource(address);const tab=runtime.sidebarTabs.service.active();assert.equal(tab.registrationId,registration.id);assert.equal(tab.contentId,address);
  const internals=runtime.modules.get('dsh-drawai').exports.__routeInternals;assert.equal(internals.pathFromAddress(runtime.sidebarTabs.info(tab.id,true).tab.navigation.address),'design.drawio');
  assert.equal(runtime.slots.selected('sidebar.right.pane.tab',tab.registrationId).length,1);runtime.dispose();assert.equal(styles.length,0);
});
