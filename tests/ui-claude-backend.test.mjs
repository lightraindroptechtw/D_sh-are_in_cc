// Claude Code specifics of the ported browser-screen backend: which calls the page may make, the Claude Code worker kind,
// and the explicit "no conversation list" errors. (The Codex-path backend is covered by ui-backend.test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startPluginUi} from '../lib/ui-server.mjs';
import {loadDshHost} from '../lib/dsh-host.mjs';
import {claudeRegistry,claudeUiRegistry} from '../lib/modules/claude/index.mjs';
import {dispatchFileResourceCall,dispatchWorkspaceFilesCall} from '../lib/ui-files.mjs';
import {createRuntime} from '../ui/runtime.mjs';

const runtimeRoot=fileURLToPath(new URL('../',import.meta.url));

test('the page may call the screen backend methods but never a conversation list',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-ui-claude-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const uiRoot=path.join(root,'runtime/ui');await fs.mkdir(path.join(uiRoot,'source'),{recursive:true});
  for(const [name,bytes]of [['manifest.json',JSON.stringify({format:1,name:'x',version:'1',clients:[],assets:[]})],['index.html','<div></div>'],['browser.js',''],['host.css','']])await fs.writeFile(path.join(uiRoot,name),bytes);
  const seen=[];const ui=await startPluginUi({root,rpc:async method=>{seen.push(method);return {method};}});t.after(()=>ui.close());
  const invoke=async method=>await(await fetch(ui.url+'__dsh_ui/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,params:{}})})).json();
  for(const method of ['ui.connection.call','ui.typert.call','ui.events.poll','ui.resources.file','ui.stream.open','ui.stream.read','ui.stream.send','ui.stream.end','ui.stream.cancel'])assert.equal((await invoke(method)).ok,true,method);
  for(const method of ['ui.conversation.describe','ui.conversation.list','ui.conversation.read','ui.backend.describe'])assert.equal((await invoke(method)).error.code,'UI_RPC_UNAVAILABLE',method);
  assert.equal(seen.some(method=>method.startsWith('ui.conversation')||method==='ui.backend.describe'),false);
});

test('a package with a screen gets the real connection and typert modules; without one the stand-in stays',()=>{
  assert.equal(claudeRegistry.has('typert'),false);
  assert.equal(claudeRegistry.get('connection').descriptor.displayName.includes('無作用'),true);
  assert.equal(claudeUiRegistry.has('typert'),true);
  assert.equal(claudeUiRegistry.get('connection').descriptor.displayName.includes('無作用'),false);
  assert.deepEqual([...claudeUiRegistry.keys()].filter(id=>!['connection','typert'].includes(id)),[...claudeRegistry.keys()].filter(id=>id!=='connection'));
});

test('Claude Code worker: screen calls reach a registered handler, and a package without a screen refuses them',{timeout:60000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-ui-claude-host-')),hosts=[];
  t.after(async()=>{try{for(const host of hosts)await host.dispose();}finally{await fs.rm(dir,{recursive:true,force:true});}});
  const sourceRoot=path.join(dir,'source');await fs.mkdir(sourceRoot);
  await fs.writeFile(path.join(sourceRoot,'package.json'),'{"type":"module"}');
  await fs.writeFile(path.join(sourceRoot,'index.js'),"export const inject=['connection'];export function apply(ctx){ctx.connection.rpc.handle('/probe',async(endpoint,payload)=>({ok:true,value:{endpoint,payload}}));}");
  const load=async extra=>{const host=await loadDshHost({entry:path.join(sourceRoot,'index.js'),sourceRoot,stateDir:path.join(dir,'state-'+hosts.length),runtimeRoot,workspace:dir,services:['connection'],hostKind:'claude',...extra});hosts.push(host);return host;};
  const withScreen=await load({uiBackend:true});
  assert.deepEqual(await withScreen.request('ui.connection.call',{channel:'/probe',endpoint:'echo',payload:{a:1}}),{ok:true,value:{endpoint:'echo',payload:{a:1}}});
  assert.deepEqual(await withScreen.request('ui.events.poll',{after:0}),{cursor:0,events:[],lost:false});
  assert.deepEqual((await withScreen.request('ui.backend.describe')).connection.channels,['/probe']);
  await assert.rejects(withScreen.request('ui.conversation.list',{}),{code:'HOST_RPC_UNSUPPORTED'});
  const without=await load({});
  await assert.rejects(without.request('ui.connection.call',{channel:'/probe',endpoint:'echo',payload:null}),{code:'UI_BACKEND_UNSUPPORTED'});
});

test('file addresses that name a conversation fail loudly instead of guessing a folder',async t=>{
  const result=await dispatchFileResourceCall({ctx:{get:()=>({})},params:{address:'dsh-resource://file/session/known/page.txt',operation:'read'},workspace:os.tmpdir()});
  assert.equal(result.ok,false);assert.equal(result.error.code,'UI_CONVERSATION_UNSUPPORTED');
  const files=await dispatchWorkspaceFilesCall({ctx:{get:()=>({})},namespace:'workspaceFiles',method:'stat',args:['known','page.txt'],workspace:os.tmpdir()});
  assert.equal(files.ok,false);assert.equal(files.error.code,'UI_CONVERSATION_UNSUPPORTED');
});

test('browser runtime: sessions and currentConversation report that Claude Code has no conversation list',()=>{
  const runtime=createRuntime({libraries:{},rpc:async()=>{throw new Error('must not call the backend');},context:{manifest:{name:'x',version:'1'}}});
  try{
    for(const name of ['sessions','currentConversation','currentconversation'])assert.throws(()=>runtime.services[name],{code:'UI_CONVERSATION_UNSUPPORTED'},name);
    assert.deepEqual(Object.keys(runtime.services).filter(name=>/session|conversation/i.test(name)),[]);
  }finally{runtime.dispose();}
});
