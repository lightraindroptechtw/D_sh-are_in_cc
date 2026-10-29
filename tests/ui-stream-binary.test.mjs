import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {encodeConnectionResult,decodeConnectionResult,hydrateAttachments,openRpcStream} from '../ui/transport.mjs';
import {createRemoteServices} from '../ui/remote.mjs';
import {createRemoteStreamRegistry} from '../lib/ui-remote-streams.mjs';
import {loadDshHost} from '../lib/dsh-host.mjs';
const timeout=promise=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('測試等待逾時。')),3000);timer.unref();})]);

test('unary byte projection survives JSON transport, byte offsets, empty arrays, root values and special keys',()=>{
  const backing=new Uint8Array([100,0,128,255,101]);
  const value=JSON.parse('{"__proto__":null,"nested":[null]}');value.__proto__=backing.subarray(1,4);value.nested[0]=new Uint8Array();
  const wire=JSON.parse(JSON.stringify(encodeConnectionResult({ok:true,value})));
  assert.deepEqual(wire.attachments,[{path:['__proto__'],base64:'AID/'},{path:['nested',0],base64:''}]);
  const result=decodeConnectionResult(wire);assert.ok(Object.hasOwn(result.value,'__proto__'));assert.deepEqual([...result.value.__proto__],[0,128,255]);assert.equal(result.value.nested[0].byteLength,0);
  assert.equal(Object.getPrototypeOf(result.value),Object.prototype);
  assert.deepEqual([...decodeConnectionResult(JSON.parse(JSON.stringify(encodeConnectionResult({ok:true,value:backing.subarray(1,4)})))).value],[0,128,255]);
  assert.deepEqual(decodeConnectionResult({ok:true}),{ok:true});
  const failure={ok:false,error:{code:'fixture',message:'refused',details:{}}};assert.equal(encodeConnectionResult(failure),failure);
});

test('official handler attachment placeholders restore native Uint8Array and malformed metadata fails',()=>{
  const encoded=encodeConnectionResult({ok:true,value:{bytes:null},attachments:[{path:['bytes'],bytes:new Uint8Array([2,3])}]});
  assert.deepEqual([...decodeConnectionResult(JSON.parse(JSON.stringify(encoded))).value.bytes],[2,3]);
  for(const attachments of [[{path:['missing'],base64:'AA=='}],[{path:['bytes'],base64:'not base64'}],[{path:['bytes'],base64:'AB=='}],[{path:['bytes'],base64:'AA=='},{path:['bytes'],base64:'AA=='}]])assert.throws(()=>decodeConnectionResult({ok:true,value:{bytes:null},attachments}),{code:'UI_REMOTE_TRANSPORT'});
  assert.throws(()=>hydrateAttachments({},[{path:['bytes'],bytes:new Uint8Array()}]),/位置|占位/);
});

test('generated duplex handle opens immediately, orders queued uplink, half-closes and consumes downlink once',async t=>{
  const registry=createRemoteStreamRegistry({open:async(_params,_signal,uplink)=>(async function*(){for await(const item of uplink)yield item===undefined?undefined:{reply:item};})(),readWaitMs:5});t.after(()=>registry.dispose());
  const calls=[],services=createRemoteServices({builtins:false,rpc:async(method,params,options)=>{calls.push(method);return registry.request(method,JSON.parse(JSON.stringify(params)),options?.signal);}});t.after(()=>services.dispose());
  await services.remote.$mount({package:'fixture',descriptors:[{service:'echo',namespace:'echo',method:'duplex',mode:'stream',invocation:{kind:'direct'},parameters:[],result:{mode:'src-json'}}]});
  const handle=services.remote.echo.duplex();await handle.send({text:'first'});await handle.send(undefined);await handle.end();
  assert.equal(calls[0],'ui.stream.open');const values=[];for await(const value of handle)values.push(value);
  assert.deepEqual(values,[{reply:{text:'first'}},undefined]);assert.equal(registry.size,0);
  assert.throws(()=>handle[Symbol.asyncIterator](),/一個消費者/);assert.throws(()=>handle.send('late'),/關閉/);
});

test('long-poll pending preserves one in-flight next; consumer return cancels a blocked downlink',async t=>{
  let reads=0,resolveNext,aborted=false;
  const registry=createRemoteStreamRegistry({readWaitMs:5,open:async(_params,signal)=>({[Symbol.asyncIterator](){return {next(){reads++;return new Promise(resolve=>{resolveNext=resolve;signal.addEventListener('abort',()=>{aborted=true;resolve({done:true});},{once:true});});},return(){return {done:true};}};}})});t.after(()=>registry.dispose());
  const {streamId}=await registry.request('ui.stream.open',{});
  assert.deepEqual(await registry.request('ui.stream.read',{streamId}),{pending:true});assert.deepEqual(await registry.request('ui.stream.read',{streamId}),{pending:true});assert.equal(reads,1);
  resolveNext({done:false,value:'next'});assert.deepEqual(await registry.request('ui.stream.read',{streamId}),{done:false,value:'next'});
  await registry.request('ui.stream.cancel',{streamId});assert.equal(aborted,true);assert.equal(registry.size,0);
});

test('opening cancellation, read cancellation and uncooperative generator disposal do not retain carrier rows',async()=>{
  let signal;
  const opening=createRemoteStreamRegistry({open:async(_params,value)=>{signal=value;return new Promise(()=>{});}}),controller=new AbortController();
  const pending=opening.request('ui.stream.open',{},controller.signal);await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(timeout(pending));assert.equal(signal.aborted,true);assert.equal(opening.size,0);await timeout(opening.dispose());
  const disposing=createRemoteStreamRegistry({open:async()=>new Promise(()=>{})});const uncompleted=disposing.request('ui.stream.open',{});await timeout(disposing.dispose());await assert.rejects(timeout(uncompleted),{code:'gateway/cancelled'});
  const registry=createRemoteStreamRegistry({open:async()=>({[Symbol.asyncIterator](){return {next:()=>new Promise(()=>{}),return:()=>new Promise(()=>{})};}})});
  const {streamId}=await registry.request('ui.stream.open',{}),readController=new AbortController();
  const read=registry.request('ui.stream.read',{streamId},readController.signal);readController.abort();await assert.rejects(timeout(read),{code:'gateway/cancelled'});assert.equal(registry.size,0);await timeout(registry.dispose());
});

test('JSON-invalid uplink/downlink fail explicitly and open RemoteResult failures retain their code',async()=>{
  const registry=createRemoteStreamRegistry({open:async()=>({async *[Symbol.asyncIterator](){yield new Uint8Array([1]);}})});
  let {streamId}=await registry.request('ui.stream.open',{});await assert.rejects(registry.request('ui.stream.read',{streamId}),{code:'gateway/result-invalid'});assert.equal(registry.size,0);
  ({streamId}=await registry.request('ui.stream.open',{}));await assert.rejects(registry.request('ui.stream.send',{streamId,value:NaN}),{code:'gateway/bad-request'});await registry.dispose();
  const failed=createRemoteStreamRegistry({open:async()=>({ok:false,error:{code:'fixture/refused',message:'實際拒絕'}})});await assert.rejects(failed.request('ui.stream.open',{}),{code:'fixture/refused'});await failed.dispose();
});

test('domain $stream keeps generation ids stable, accepts baseline, restarts and disposes',async()=>{
  const services=createRemoteServices({builtins:false,rpc:async()=>{throw Error('未預期的RPC');}});
  let opened=0;
  const stream=services.remote.$stream({name:'fixture',open:signal=>(async function*(){opened++;yield 'baseline';yield 'delta';signal.throwIfAborted();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));})(),ended:()=>Error('ended')});
  const iterator=stream[Symbol.asyncIterator]();const first=await iterator.next();first.value.accept();assert.equal(first.value.generation,1);assert.equal((await iterator.next()).value.generation,1);
  stream.restart();const replacement=await timeout(iterator.next());assert.equal(replacement.value.generation,2);assert.equal(opened,2);await timeout(stream.dispose());assert.equal(stream.signal.aborted,true);services.dispose();
});

test('actual worker executes strict Typert duplex, source stream, cancellation and native unary binary',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-stream-binary-')),sourceRoot=join(root,'source');await mkdir(sourceRoot);
  await writeFile(join(sourceRoot,'package.json'),'{"type":"module"}');
  await writeFile(join(sourceRoot,'index.ts'),`
import {TypertRemoteService,Remote} from '@deepseek-ai/dsh-typert-protocol';import {z} from 'zod';
export const inject=['connection','typert'];const codec=schema=>({mode:'strict',schema});
const method=(name,result,extra={})=>({id:'fixture/'+name,service:'streamProbe',namespace:'streamProbe',method:name,invocation:{kind:'direct'},parameters:[],result,...extra});
export const TYPERT={package:'stream-fixture',face:'host',schemas:[],invocations:[method('duplex',{mode:'src-json'},{mode:'stream',uplink:{codec:codec(z.string())}}),method('bytes',codec(z.object({data:z.instanceof(Uint8Array)}))),method('blocked',{mode:'src-json'},{mode:'stream',cancellation:{parameter:'signal'}}),method('state',{mode:'src-json'})]};
class Probe extends TypertRemoteService {aborted=false;constructor(ctx){super(ctx,'streamProbe');}async *duplex(){for await(const item of this.ctx.invocation.uplink())yield {text:item,owner:this.ctx.invocation.peer.principal.kind};}bytes(){return {data:new Uint8Array([3,0,255])};}async *blocked(signal){await new Promise(resolve=>signal.addEventListener('abort',()=>{this.aborted=true;resolve();},{once:true}));}state(){return this.aborted;}}
class SourceProbe extends TypertRemoteService {constructor(ctx){super(ctx,'sourceProbe');} @Remote({mode:'stream'}) *read(){yield {source:true};}}
export function apply(ctx){new Probe(ctx);new SourceProbe(ctx);ctx.connection.rpc.handle('/binary',()=>({ok:true,value:{data:null},attachments:[{path:['data'],bytes:new Uint8Array([4,128])}]}));}
`);
  const host=await loadDshHost({entry:join(sourceRoot,'index.ts'),sourceRoot,stateDir:join(root,'state'),runtimeRoot:fileURLToPath(new URL('../',import.meta.url)),services:['connection','typert'],uiBackend:true});
  t.after(async()=>{await host.dispose();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const services=createRemoteServices({builtins:false,rpc:(method,params,execution)=>host.request(method,params,execution)});t.after(()=>services.dispose());
  for(const [channel,endpoint,expected] of [['/binary','read',[4,128]],['/api','streamProbe/bytes',[3,0,255]]]){
    const result=await services.connection.rpc.call(channel,endpoint,{args:{}});assert.equal(result.ok,true,JSON.stringify(result));assert.ok(result.value.data instanceof Uint8Array);assert.deepEqual([...result.value.data],expected);
  }
  const handle=services.connection.rpc.open('/api','streamProbe/duplex',{args:{}});await handle.send('one');await handle.send('two');await handle.end();const replies=[];for await(const value of handle)replies.push(value);assert.deepEqual(replies,[{text:'one',owner:'owner'},{text:'two',owner:'owner'}]);
  const invalid=services.connection.rpc.open('/api','streamProbe/duplex',{args:{}});await invalid.send(10);await assert.rejects(async()=>{for await(const _ of invalid){}},/Expected string|上行|驗證|type/i);
  const source=services.connection.rpc.open('/api','sourceProbe/read',{args:{}});assert.deepEqual(await Array.fromAsync(source),[{source:true}]);
  const controller=new AbortController(),blocked=services.connection.rpc.open('/api','streamProbe/blocked',{args:{}},controller.signal),iterator=blocked[Symbol.asyncIterator](),read=iterator.next();await new Promise(resolve=>setTimeout(resolve,30));controller.abort();assert.deepEqual(await timeout(read),{done:true,value:undefined});
  const state=await services.connection.rpc.call('/api','streamProbe/state',{args:{}});assert.deepEqual(state,{ok:true,value:true});
});
