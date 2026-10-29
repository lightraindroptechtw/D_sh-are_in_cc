import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadDshHost} from '../lib/dsh-host.mjs';
import {diagnoseStartup} from '../lib/startup-diagnostics.mjs';

async function fixture(t,source,options={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'v040-regression-')),entry=path.join(dir,'index.mjs');let host;
  t.after(async()=>{await host?.dispose();await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  await fs.writeFile(entry,source);
  host=await loadDshHost({entry,stateDir:path.join(dir,'state'),sourceRoot:dir,initializeTimeoutMs:10000,...options});return host;
}
const tool=`import{defineTool}from'@deepseek-ai/dsh-tools';const probe=execute=>defineTool({name:'probe',description:'synthetic',parameters:{},output:{schema:{type:'json'},render:(_,v)=>[{type:'text',text:JSON.stringify(v)}]},execute});`;
test('scoped source name initializes without changing source metadata',async t=>{
  const host=await fixture(t,tool+`export const name='@synthetic/scoped';export const inject=['tools'];export function apply(ctx){ctx.tools.register(probe(async()=>({ok:true})));}`);
  assert.equal((await host.tools[0].execute()).structuredContent.ok,true);
});
test('missing lazy import preserves original catch fallback; missing static import still fails',async t=>{
  const host=await fixture(t,tool+`export const inject=['tools'];export function apply(ctx){ctx.tools.register(probe(async()=>{try{await Promise.all([import('synthetic-uninstalled-one'),import('synthetic-uninstalled-two')]);return{fallback:false};}catch{return{fallback:true};}}));}`);
  assert.equal((await host.tools[0].execute()).structuredContent.fallback,true);
  await assert.rejects(fixture(t,`import x from'synthetic-missing-static';export function apply(){return x;}`),/Could not resolve/);
});
test('web provider reaches official named-export tool companion in real worker',async t=>{
  const host=await fixture(t,`export const inject=['web'];export function apply(ctx){ctx.web.registerSearchProvider({id:'synthetic',available:()=>true,search:async()=>({sources:[{url:'https://example.invalid',title:'synthetic'}],truncated:false})});}`,{services:['web'],codexCapabilities:{codexVersion:'0.160.0',mcp:true,skills:true},serviceConfig:{web:{searchProvider:'synthetic'}}});
  const found=host.tools.find(row=>row.name==='web_search');assert.ok(found);const result=await found.execute({queries:['fixture']});assert.equal(result.isError,false);assert.match(result.content[0].text,/synthetic/);
});
test('startup diagnostics distinguish missing credential package from a missing key and never copy unknown secrets',()=>{
  assert.equal(diagnoseStartup(new Error('Official runtime dependency is unavailable: @deepseek-ai/dsh-credentials')).classification,'missing-dependency');
  assert.equal(diagnoseStartup(new Error('API key is missing')).classification,'missing-credential');
  const result=diagnoseStartup(new Error('arbitrary SECRET_UNRECOGNISED_TEXT'));assert.equal(result.classification,'other');assert.doesNotMatch(JSON.stringify(result),/SECRET_UNRECOGNISED_TEXT/);assert.match(result.fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(diagnoseStartup(new Error("The requested module '/hidden/path' does not provide an export named 'LegacySymbol'")).code,'DSH_API_EXPORT_MISSING');
});
test('native variable SDK import and metadata resolution share the pinned runtime',async t=>{
  const host=await fixture(t,tool+`const sdk='@deepseek-ai/dsh-tools';const url=import.meta.resolve(sdk+'/package.json');const loaded=await import(sdk);export const inject=['tools'];export function apply(ctx){ctx.tools.register(probe(async()=>({metadata:url.startsWith('file:'),sdk:typeof loaded.defineTool==='function'})));}`);
  assert.deepEqual((await host.tools[0].execute()).structuredContent,{metadata:true,sdk:true});
});
