import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadDshHost} from '../lib/dsh-host.mjs';
import {createRemoteServices} from '../ui/remote.mjs';

test('ordinary document lookup, Host Context and scoped stream use real official provider registries without Agents',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-document-context-')),sourceRoot=join(root,'source');await mkdir(sourceRoot);
  await writeFile(join(sourceRoot,'package.json'),'{"type":"module"}');
  await writeFile(join(sourceRoot,'index.ts'),`
import {TypertRemoteService,Remote,RemoteScope} from '@deepseek-ai/dsh-typert-protocol';import {z} from 'zod';
export const inject=['connection','typert'];
const codec=schema=>({mode:'strict',schema,typeSymbol:'DocumentId'}),lookup={name:'document',wire:'documentId',source:'lookup',lookup:'document',codec:codec(z.string())};
const method=(name,extra={})=>({id:'doc/'+name,namespace:'documents',service:'documents',method:name,invocation:{kind:'direct'},parameters:[],result:{mode:'src-json'},...extra});
export const TYPERT={package:'document-probe',face:'host',schemas:[],invocations:[method('lookup',{parameters:[lookup],scope:{context:'document',wire:'documentId'}}),method('context',{invocation:{kind:'context',context:'document',wire:'documentId',codec:codec(z.string())}}),method('stream',{mode:'stream',parameters:[lookup],scope:{context:'document',wire:'documentId'}})]};
class Documents extends TypertRemoteService {constructor(ctx){super(ctx,'documents');}lookup(document){return {id:document.id,text:document.text};}context(){return {id:this.ctx.document.id,text:this.ctx.document.text};}*stream(document){yield {id:document.id,text:document.text};}}
class SourceDocuments extends TypertRemoteService {constructor(ctx){super(ctx,'sourceDocuments');}@Remote read(document){return {id:document.id,text:document.text};}@RemoteScope('document') context(){return {id:this.ctx.document.id,text:this.ctx.document.text};}}
export function apply(ctx){
  const docs=new Map([['a',{id:'a',text:'actual document'}]]);
  const off=ctx.typert.lookups.register('document',{parameter:'document',wire:'documentId',hostTypeSymbol:'Document',wireTypeSymbol:'DocumentId',resolve:id=>docs.get(id)});
  ctx.typert.contexts.registerHost('document',{wire:'documentId',wireTypeSymbol:'DocumentId',resolve:id=>docs.has(id)?ctx.root.extend({document:docs.get(id)}):undefined});
  new Documents(ctx);new SourceDocuments(ctx);
  ctx.on('bridge/remove-provider',()=>off());ctx.on('bridge/configure-provider',()=>ctx.typert.lookups.configure('document',id=>docs.has(id)?{id,text:'configured document'}:undefined));
}
`);
  const host=await loadDshHost({entry:join(sourceRoot,'index.ts'),sourceRoot,stateDir:join(root,'state'),runtimeRoot:fileURLToPath(new URL('../',import.meta.url)),services:['connection','typert'],uiBackend:true});
  t.after(async()=>{await host.dispose();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const services=createRemoteServices({builtins:false,rpc:(method,params,options)=>host.request(method,params,options)});t.after(()=>services.dispose());
  const call=(namespace,method,args)=>services.connection.rpc.call('/api',namespace+'/'+method,{args});
  for(const [namespace,method] of [['documents','lookup'],['documents','context'],['sourceDocuments','read'],['sourceDocuments','context']]){
    assert.deepEqual(await call(namespace,method,{documentId:'a'}),{ok:true,value:{id:'a',text:'actual document'}},namespace+'/'+method);
  }
  const clientCodec={mode:'strict'},parameter={name:'document',wire:'documentId',source:'lookup',lookup:'document',codec:clientCodec};
  await services.remote.$mount({package:'document-client',descriptors:[{id:'documents/stream',namespace:'documents',service:'documents',method:'stream',mode:'stream',invocation:{kind:'direct'},parameters:[parameter],scope:{context:'document',wire:'documentId'},result:{mode:'src-json'}}]});
  const scoped=services.forContext({identities:{document:'a'}});assert.deepEqual(await Array.fromAsync(scoped.documents.stream()),[{id:'a',text:'actual document'}]);
  assert.equal((await call('documents','lookup',{documentId:'missing'})).error.code,'gateway/lookup-not-found');
  assert.equal((await call('documents','context',{documentId:'missing'})).error.code,'gateway/context-not-found');
  assert.equal((await call('documents','lookup',{documentId:2})).error.code,'gateway/bad-request');
  await host.dispatchEvent('bridge/configure-provider',[]);assert.deepEqual(await call('documents','lookup',{documentId:'a'}),{ok:true,value:{id:'a',text:'configured document'}});
  await host.dispatchEvent('bridge/remove-provider',[]);assert.equal((await call('documents','lookup',{documentId:'a'})).error.code,'gateway/lookup-unavailable');
  assert.equal((await call('sourceDocuments','read',{documentId:'a'})).error.code,'gateway/lookup-unavailable','official remembered lookup declarations prevent fallback to a JSON object parameter');
});
