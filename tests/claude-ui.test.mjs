import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {makePlugin,spawnHost,toolHeader,projectRoot} from './claude-host-helpers.mjs';
import {preparePluginUi} from '../lib/ui-assets.mjs';
import {convertToClaude} from '../lib/converter-claude.mjs';
import {validateClaudePackage} from '../lib/claude-package.mjs';
const client='globalThis.__ModuleLoader__.load({id:"fixture",factory:()=>({apply(){}})});';
test('Claude child UI shares actual settings and routes; tools return through the mod gate',async t=>{
 const root=await makePlugin(t,toolHeader+"import Schema from '@deepseek-ai/schemastery';export const Config=Schema.object({value:Schema.string().default('old').volatile()});export const name='ui-test';export const inject=['tools','settings','webServer'];export function apply(ctx){ctx.tools.register(tool('echo',async input=>input));}",{}, {files:{'package.json':JSON.stringify({name:'fixture',version:'1.0.0',type:'module',dsh:{client:true},exports:{'.':'./index.mjs','./client':'./client.js'}}),'client.js':client}});
 await preparePluginUi({converterRoot:projectRoot,outputDir:root,sourceRoot:path.join(root,'source')});
 const reverse=[];const host=await spawnHost(t,root,{answer:async(method,params)=>{reverse.push({method,params});return {content:[{type:'text',text:'gate-result'}]};}});
 await host.ready();const first=await host.rpc('ui.open');assert.match(first.url,/^http:\/\/127.0.0.1:/);assert.equal((await host.rpc('ui.open')).url,first.url);
 const call=async(method,params={})=>{const r=await fetch(first.url+'__dsh_ui/rpc',{method:'POST',headers:{'content-type':'application/json',origin:new URL(first.url).origin},body:JSON.stringify({method,params})});const body=await r.json();assert.equal(body.ok,true,JSON.stringify(body));return body.result;};
 assert.equal((await fetch(first.url)).status,200);
 const settings=await call('settings.describe');assert.ok(Array.isArray(settings));
 const section=settings.find(s=>s.ns==='ui-test'||s.namespace==='ui-test'||s.name==='ui-test'||s.ns==='target-plugin'||s.title==='ui-test');assert.ok(section,JSON.stringify(settings));
 await call('settings.update',{ns:'ui-test',patch:{value:'saved'},revision:section.revision});
 assert.match(JSON.stringify(await call('settings.describe')),/saved/);
 const result=await call('execute',{name:'echo',args:{value:'hello'}});assert.match(JSON.stringify(result),/gate-result/);assert.equal(reverse.at(-1).method,'ui.execute');
 assert.equal((await call('getTools'))[0].name,'echo');
 const denied=await fetch(first.url+'__dsh_ui/rpc',{method:'POST',headers:{'content-type':'application/json',origin:new URL(first.url).origin},body:JSON.stringify({method:'dispose'})});assert.equal(denied.status,400);
 const url=first.url;await host.stop();await assert.rejects(fetch(url));
});
test('frontend-only package converts, validates and opens without fabricated backend',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cc-ui-conversion-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100}));
 const source=path.join(dir,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,'package.json'),JSON.stringify({name:'ui-only-test',version:'1.0.0',type:'module',dsh:{client:true},exports:{'./client':'./client.js'}}));await fs.writeFile(path.join(source,'client.js'),client);
 const outputDir=path.join(dir,'converted');const report=await convertToClaude(source,{outputDir,installDependencies:false});assert.equal(report.plugin.layout,'bridge');assert.equal(report.plugin.bridgeConfig.features.ui,true);
 const check=await validateClaudePackage(outputDir,{cli:false});assert.equal(check.valid,true,JSON.stringify(check));
 const host=await spawnHost(t,outputDir,{bundleFile:path.join(outputDir,'runtime/claude-host.mjs')});await host.ready();assert.match((await host.rpc('ui.open')).url,/127.0.0.1/);assert.deepEqual((await host.rpc('status')).services,[]);await host.stop();
});

test('browser cancellation is forwarded to the mod while awaiting approval',async()=>{
 const {createReverseChannel}=await import('../lib/claude-host/reverse.mjs');const messages=[];
 const reverse=createReverseChannel({emit:message=>messages.push(message)});const controller=new AbortController();
 const pending=reverse.request('ui.execute',{name:'send'},{signal:controller.signal});controller.abort();
 await assert.rejects(pending,{code:'HOST_CANCELED'});assert.equal(reverse.size,0);
 assert.deepEqual(messages.map(m=>m.type),['request','requestCanceled']);assert.equal(messages[0].id,messages[1].id);reverse.close();
});
