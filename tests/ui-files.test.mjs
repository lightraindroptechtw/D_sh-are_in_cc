// Port of the Codex file-preview tests. Claude Code has no conversation list, so every address or scope id that names a
// conversation must fail with UI_CONVERSATION_UNSUPPORTED; only absolute addresses (and the plugin workspace) are served.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {LocalFileSystem} from '@deepseek-ai/dsh-fs-local';
import {dispatchFileResourceCall,dispatchWorkspaceFilesCall,dispatchWorkspaceFilesStream} from '../lib/ui-files.mjs';
import {encodeConnectionResult,decodeConnectionResult} from '../ui/transport.mjs';
import {loadDshHost} from '../lib/dsh-host.mjs';
import {fileURLToPath} from 'node:url';

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-ui-files-')),workspace=path.join(directory,'workspace');await fs.mkdir(workspace);await fs.mkdir(path.join(workspace,'folder'));
  await fs.writeFile(path.join(workspace,'page.txt'),'第一行\n\n第三行\n最後');await fs.writeFile(path.join(directory,'outside.txt'),'外面的檔案');await fs.writeFile(path.join(workspace,'binary.bin'),new Uint8Array([0,128,255,3,4]));
  const root=new Context();t.after(async()=>{await root.fiber.dispose();await fs.rm(directory,{recursive:true,force:true});});
  const filesystem=new LocalFileSystem(root,{cwd:workspace,diffBasisMaxBytes:10*1024*1024});
  const environment={ctx:{get:key=>key==='fs'?filesystem:undefined},workspace};
  const call=(params,extra={})=>dispatchFileResourceCall({...environment,params,...extra});
  return {directory,workspace,filesystem,environment,call};
}
const absolute=file=>'dsh-resource://file/absolute/'+file.split(path.sep).map(encodeURIComponent).join('/');
const session=(id,file)=>'dsh-resource://file/session/'+encodeURIComponent(id)+'/'+file.split('/').map(encodeURIComponent).join('/');

test('file resources read real UTF-8 line pages with correct EOF and byte identity',async t=>{
  const f=await fixture(t),page=absolute(path.join(f.workspace,'page.txt'));
  const first=await f.call({address:page,operation:'read',offset:2,limit:2});
  assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.value.text,'\n第三行');assert.equal(first.value.lines,2);assert.equal(first.value.eof,false);assert.equal(first.value.absolutePath,path.join(f.workspace,'page.txt'));
  const last=await f.call({address:page,operation:'read',offset:4,limit:2});assert.equal(last.value.text,'最後');assert.equal(last.value.eof,true);
  const beyond=await f.call({address:page,operation:'read',offset:9,limit:2});assert.equal(beyond.value.lines,0);assert.equal(beyond.value.eof,true);
  const stat=await f.call({address:page,operation:'stat'});assert.equal(stat.value.bytes,Buffer.byteLength('第一行\n\n第三行\n最後'));assert.equal(typeof stat.value.version,'string');
});

test('absolute resources outside the workspace use the existing filesystem read authority',async t=>{
  const f=await fixture(t),resource=await f.call({address:absolute(path.join(f.directory,'outside.txt')),operation:'read'});
  assert.equal(resource.ok,true,JSON.stringify(resource));assert.equal(resource.value.text,'外面的檔案');
  assert.equal((await f.call({address:absolute(path.join(f.workspace,'missing.txt')),operation:'read'})).error.code,'workspace-file/not-found');
  assert.equal((await f.call({address:'dsh-resource://file/other/x',operation:'read'})).error.code,'workspace-file/unsupported-address');
});

test('byte ranges return exact native bytes; text pages and caps fail without truncation',async t=>{
  const f=await fixture(t),binary=absolute(path.join(f.workspace,'binary.bin')),page=absolute(path.join(f.workspace,'page.txt'));
  const window=await f.call({address:binary,operation:'readBytes',options:{range:{offset:1,length:3}}});assert.deepEqual([...window.value.data],[128,255,3]);assert.equal(window.value.offset,1);assert.equal(window.value.eof,false);
  assert.equal((await f.call({address:binary,operation:'readBytes',options:{}},{config:{maxFileBytes:2}})).error.code,'workspace-file/too-large');
  assert.equal((await f.call({address:page,operation:'read',offset:1,limit:1},{config:{maxBytes:3}})).error.code,'workspace-file/too-large');
  assert.equal((await f.call({address:binary,operation:'read'})).error.code,'workspace-file/not-text');
  const after=await f.call({address:binary,operation:'readBytes',options:{range:{offset:99,length:2}}});assert.equal(after.value.data.length,0);assert.equal(after.value.eof,true);
});

test('directory results and failures are explicit, including cancellation',async t=>{
  const f=await fixture(t),listed=await f.call({address:absolute(f.workspace),operation:'list'},{config:{maxEntries:2}});
  assert.equal(listed.ok,true,JSON.stringify(listed));assert.equal(listed.value.entries.length,2);assert.equal(listed.value.truncated,true);
  assert.equal((await f.call({address:absolute(path.join(f.workspace,'folder')),operation:'stat'})).error.code,'workspace-file/not-regular-file');
  assert.equal((await f.call({address:absolute(path.join(f.workspace,'page.txt')),operation:'list'})).error.code,'workspace-file/not-directory');
  const controller=new AbortController();controller.abort();assert.equal((await f.call({address:absolute(path.join(f.workspace,'page.txt')),operation:'read'},{signal:controller.signal})).error.code,'gateway/cancelled');
});

test('addresses and workspaceFiles scope ids that name a conversation are refused, never mapped to another folder',async t=>{
  const f=await fixture(t);
  const byAddress=await f.call({address:session('known','page.txt'),operation:'read'});assert.equal(byAddress.ok,false);assert.equal(byAddress.error.code,'UI_CONVERSATION_UNSUPPORTED');assert.match(byAddress.error.message,/Claude Code/);
  for(const method of ['stat','read','readBytes','list']){
    const result=await dispatchWorkspaceFilesCall({...f.environment,namespace:'workspaceFiles',method,args:['known','page.txt']});
    assert.equal(result.ok,false,method);assert.equal(result.error.code,'UI_CONVERSATION_UNSUPPORTED',method);
  }
  assert.equal(await dispatchWorkspaceFilesCall({...f.environment,namespace:'other',method:'stat',args:[]}),undefined);
  await assert.rejects(async()=>{const iterator=dispatchWorkspaceFilesStream({...f.environment,namespace:'workspaceFiles',method:'changes',args:['known','page.txt']})[Symbol.asyncIterator]();await iterator.next();},{code:'UI_CONVERSATION_UNSUPPORTED'});
});

test('unary results travel through the JSON codec with native bytes',async t=>{
  const f=await fixture(t),result=await f.call({address:absolute(path.join(f.workspace,'binary.bin')),operation:'readBytes',options:{}});
  const wire=decodeConnectionResult(JSON.parse(JSON.stringify(encodeConnectionResult(result))));
  assert.equal(wire.ok,true);assert.ok(wire.value.data instanceof Uint8Array);assert.deepEqual([...wire.value.data],[0,128,255,3,4]);
});

test('actual Claude Code worker serves file resources without a conversation',{timeout:30000},async t=>{
  const f=await fixture(t),sourceRoot=path.join(f.directory,'source');await fs.mkdir(sourceRoot);await fs.writeFile(path.join(sourceRoot,'package.json'),'{"type":"module"}');await fs.writeFile(path.join(sourceRoot,'index.js'),'export function apply() {}');
  const calls=[],host=await loadDshHost({sourceRoot,entry:path.join(sourceRoot,'index.js'),runtimeRoot:fileURLToPath(new URL('../',import.meta.url)),stateDir:path.join(f.directory,'state'),workspace:f.workspace,services:['fs'],hostKind:'claude',uiBackend:true,bridgeRequest:async method=>{calls.push(method);throw Error('A file request must not reach the conversation: '+method);}});
  try{
    const text=await host.request('ui.resources.file',{address:absolute(path.join(f.workspace,'page.txt')),operation:'read',offset:1,limit:1});assert.equal(text.ok,true,JSON.stringify(text));assert.equal(text.value.text,'第一行');
    const bySession=await host.request('ui.resources.file',{address:session('known','page.txt'),operation:'read'});assert.equal(bySession.ok,false);assert.equal(bySession.error.code,'UI_CONVERSATION_UNSUPPORTED');
    assert.deepEqual(calls,[]);
  }finally{await host.dispose();}
});
