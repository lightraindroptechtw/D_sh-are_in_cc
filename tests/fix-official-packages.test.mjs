// Converter bug 2: the bundled official environment lacked packages that 15 of the 100 reviewed
// plugins import (dsh-credentials, dsh-storage-domain, dsh-mcp-client, dsh-client-connection,
// dsh-agent, dsh-plugin-manager, schemastery). All of them exist on npm at 0.2.1-rc.2
// (checked with `npm view <pkg>@0.2.1-rc.2 version`; schemastery is 3.18.5).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {copyHostEnvironment} from '../lib/host-files.mjs';
import {loadDshHost} from '../lib/dsh-host.mjs';
import {diagnoseStartup} from '../lib/startup-diagnostics.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const REQUIRED={
  '@deepseek-ai/dsh-credentials':'0.2.1-rc.2','@deepseek-ai/dsh-storage-domain':'0.2.1-rc.2','@deepseek-ai/dsh-mcp-client':'0.2.1-rc.2',
  '@deepseek-ai/dsh-client-connection':'0.2.1-rc.2','@deepseek-ai/dsh-agent':'0.2.1-rc.2','@deepseek-ai/dsh-plugin-manager':'0.2.1-rc.2','@deepseek-ai/schemastery':'3.18.5',
};
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));

test('package.json, the lock file and node_modules all carry the seven packages at the pinned versions',async()=>{
  const manifest=await json(path.join(root,'package.json')),lock=await json(path.join(root,'package-lock.json'));
  for(const [name,version]of Object.entries(REQUIRED)){
    assert.equal(manifest.dependencies[name],version,`package.json ${name}`);
    const installed=await json(path.join(root,'node_modules',name,'package.json'));
    assert.equal(installed.version,version,`installed ${name}`);
    const row=lock.packages['node_modules/'+name];
    assert.ok(row?.integrity,`lock integrity for ${name}`);assert.equal(row.version,version);
    assert.match(row.resolved,/^https:\/\/registry\.npmjs\.org\//,`${name} comes from the public registry`);
    assert.equal(row.hasInstallScript,undefined,`${name} has no install script, so --ignore-scripts loses nothing`);
  }
});

test('copyHostEnvironment ships every one of them, and a plugin can import all seven from the copied environment',async t=>{
  const target=await fs.mkdtemp(path.join(os.tmpdir(),'fix-hostenv-')),hosts=[];
  t.after(async()=>{for(const host of hosts)await host.dispose();await fs.rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const envDir=path.join(target,'host-env');
  const copied=await copyHostEnvironment({fromRoot:root,toRoot:envDir});
  const names=new Set(copied.packages.map(item=>item.name));
  for(const name of Object.keys(REQUIRED))assert.ok(names.has(name),`${name} missing from the shipped environment`);
  assert.equal(copied.installScriptsExecuted,false);
  const entry=path.join(target,'plugin.mjs');
  await fs.writeFile(entry,`import * as credentials from '@deepseek-ai/dsh-credentials';import * as storage from '@deepseek-ai/dsh-storage-domain';import * as mcp from '@deepseek-ai/dsh-mcp-client';import * as connection from '@deepseek-ai/dsh-client-connection';import * as agent from '@deepseek-ai/dsh-agent';import * as manager from '@deepseek-ai/dsh-plugin-manager';import Schema from '@deepseek-ai/schemastery';
import{defineTool}from'@deepseek-ai/dsh-tools';export const inject=['tools'];
export function apply(ctx){ctx.tools.register(defineTool({name:'import_probe',description:'p',parameters:{},output:{schema:{type:'json'},render:(_,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:async()=>({counts:[credentials,storage,mcp,connection,agent,manager].map(m=>Object.keys(m).length),schema:typeof Schema})}));}`);
  for(const hostKind of [undefined,'claude']){
    const host=await loadDshHost({entry,sourceRoot:target,stateDir:path.join(target,'state-'+(hostKind??'codex')),runtimeRoot:envDir,initializeTimeoutMs:30000,services:[],...(hostKind?{hostKind}:{})});
    hosts.push(host);
    const result=await host.tools[0].execute({});
    assert.equal(result.isError,false,result.content?.[0]?.text);
    assert.equal(result.structuredContent.schema,'function');
    assert.ok(result.structuredContent.counts.every(count=>count>0),'each package exports something: '+result.structuredContent.counts);
  }
});

test('an official package that is genuinely not bundled is reported by name as a missing dependency, not as a missing key',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fix-missing-official-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  await fs.writeFile(path.join(dir,'index.mjs'),`import x from '@deepseek-ai/dsh-credentials-but-not-real';export const inject=['tools'];export function apply(){x();}`);
  const error=await loadDshHost({entry:path.join(dir,'index.mjs'),sourceRoot:dir,stateDir:path.join(dir,'state'),initializeTimeoutMs:15000}).then(()=>null,e=>e);
  assert.ok(error,'must fail');assert.match(error.message,/Official runtime dependency is unavailable: @deepseek-ai\/dsh-credentials-but-not-real/);
  const diagnosis=diagnoseStartup(error,'');
  assert.equal(diagnosis.code,'HOST_DEPENDENCY_MISSING');assert.equal(diagnosis.classification,'missing-dependency');assert.equal(diagnosis.package,'@deepseek-ai/dsh-credentials-but-not-real');
});
