import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {discoverPluginUi,preparePluginUi} from '../lib/ui-assets.mjs';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-ui-assets-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const sourceRoot=path.join(root,'source'),converterRoot=path.join(root,'converter'),outputDir=path.join(root,'generated');
  const write=async(relative,text)=>{const file=path.join(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);};
  await write('source/package.json',JSON.stringify({name:'original-ui',version:'1.2.3',exports:{'./client':{types:'./missing.d.ts',browser:'./lib/client.js',default:'./wrong.js'}},scripts:{prepare:'exit 2'}}));
  await write('source/lib/client.js',"import './chunks/view.js'; globalThis.sourceMustNotExecute=1;\n");
  await write('source/lib/chunks/view.js',"export const image=new URL('./nested/icon.svg',import.meta.url);\n");
  await write('source/lib/chunks/nested/icon.svg','<svg/>');
  await write('source/lib/backend.js','DO NOT PUBLISH THE BACKEND');
  await write('source/lib/.env','PRIVATE');
  await write('source/lib/settings.json','PRIVATE');
  await write('source/public/images/photo.webp',Buffer.from([0,1,255]));
  await write('source/LICENSE','MIT license fixture');
  await write('converter/ui/browser.jsx',"document.getElementById('app').textContent='trusted browser';\n");
  await write('converter/ui/host.css','body{color:red}');
  return {root,sourceRoot,converterRoot,outputDir,write};
}

test('UI preparation discovers conditional exports without source execution and retains byte provenance',async t=>{
  const f=await fixture(t),discovery=await discoverPluginUi(f);
  assert.equal(discovery.clients[0].source,'lib/client.js');assert.equal(discovery.sourceExecuted,false);assert.equal(globalThis.sourceMustNotExecute,undefined);
  const manifest=await preparePluginUi(f),ui=path.join(f.outputDir,'runtime/ui');
  assert.equal(manifest.name,'original-ui');assert.equal(manifest.version,'1.2.3');assert.equal(manifest.sourceExecuted,false);
  const bytes=await fs.readFile(path.join(f.sourceRoot,'lib/client.js'));
  assert.deepEqual(await fs.readFile(path.join(ui,'source/lib/client.js')),bytes);
  assert.equal(manifest.clients[0].sha256,createHash('sha256').update(bytes).digest('hex'));
  for(const relative of ['source/lib/chunks/view.js','source/lib/chunks/nested/icon.svg','source/public/images/photo.webp','source/LICENSE','browser.js','host.css','index.html','manifest.json'])assert.ok((await fs.stat(path.join(ui,relative))).isFile(),relative);
  for(const relative of ['source/lib/backend.js','source/lib/.env','source/lib/settings.json'])await assert.rejects(fs.access(path.join(ui,relative)),{code:'ENOENT'});
  assert.equal(JSON.stringify(manifest).includes(f.root),false,'manifest remains relocatable');
  assert.match(await fs.readFile(path.join(ui,'index.html'),'utf8'),/id="app"/);
});

test('declarative dsh.client entry and metadata fallback are supported; backend-only package has no UI',async t=>{
  const f=await fixture(t);
  await f.write('source/package.json',JSON.stringify({name:'declared',dsh:{client:{entry:'./lib/client.js'}}}));
  assert.equal((await discoverPluginUi(f)).clients[0].source,'lib/client.js');
  await f.write('source/package.json',JSON.stringify({name:'fallback',dsh:{client:{platform:'web',inject:[]}}}));
  assert.equal((await discoverPluginUi(f)).clients[0].source,'lib/client.js');
  await f.write('source/package.json',JSON.stringify({name:'backend',main:'lib/backend.js'}));
  assert.equal(await preparePluginUi(f),null);
});

test('UI discovery rejects entries and package directories outside source without reading private files',async t=>{
  const f=await fixture(t);await f.write('outside.js','PRIVATE');
  await f.write('source/package.json',JSON.stringify({exports:{'./client':'../outside.js'}}));
  await assert.rejects(discoverPluginUi(f),/escapes/);
  await assert.rejects(discoverPluginUi({...f,packageDir:'..'}),/escapes/);
});

test('preparation rejects symlink escapes and retains multiple original client entries',async t=>{
  const f=await fixture(t);await f.write('source/lib/other.js','globalThis.other=1;');
  await f.write('source/package.json',JSON.stringify({name:'multiple',exports:{'./client':'./lib/client.js','./client/other':'./lib/other.js'}}));
  const manifest=await preparePluginUi(f);assert.equal(manifest.clients.length,2);
  await f.write('outside/escape.js','PRIVATE');
  try{await fs.symlink(path.join(f.root,'outside'),path.join(f.sourceRoot,'escape'),'junction');}catch(error){if(error.code==='EPERM'){t.diagnostic('Symlink creation unavailable');return;}throw error;}
  await f.write('source/package.json',JSON.stringify({exports:{'./client':'./escape/escape.js'}}));
  await assert.rejects(discoverPluginUi(f),/symlink escapes/);
});
