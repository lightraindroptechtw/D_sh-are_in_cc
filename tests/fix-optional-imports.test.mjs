// Converter bug 3: a package the source only loads "if installed" (@mozilla/readability, happy-dom,
// @x402/fetch, undici ...) made esbuild fail the whole bundle with `Could not resolve`.
// Optional imports must stay lazy and fail only when they are actually used.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadDshHost} from '../lib/dsh-host.mjs';

const header=`import{defineTool}from'@deepseek-ai/dsh-tools';const tool=(name,execute)=>defineTool({name,description:name,parameters:{},output:{schema:{type:'json'},render:(_,v)=>[{type:'text',text:JSON.stringify(v)}]},execute});`;
async function load(t,files,options={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fix-optional-'));let host;
  t.after(async()=>{await host?.dispose();await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  for(const [name,text]of Object.entries(files)){await fs.mkdir(path.dirname(path.join(dir,name)),{recursive:true});await fs.writeFile(path.join(dir,name),text);}
  host=await loadDshHost({entry:path.join(dir,'index.mjs'),sourceRoot:dir,stateDir:path.join(dir,'state'),initializeTimeoutMs:15000,services:[],hostKind:'claude',...options});
  return host;
}
const run=async(host,name)=>host.tools.find(tool=>tool.name===name).execute({});

test('import() of an absent package stays a runtime call: the source keeps its own catch fallback',async t=>{
  const host=await load(t,{'index.mjs':header+`export const inject=['tools'];export function apply(ctx){ctx.tools.register(tool('lazy',async()=>{try{await import('synthetic-absent-dynamic');return{loaded:true};}catch(error){return{loaded:false,code:error.code};}}));}`});
  const result=await run(host,'lazy');assert.equal(result.structuredContent.loaded,false);assert.equal(result.structuredContent.code,'ERR_MODULE_NOT_FOUND');
  assert.ok(host.metadata.lazyDependencies.some(row=>row.specifier==='synthetic-absent-dynamic'&&row.mode==='external'),'the conversion report can list it');
});

test('require() of an absent package (CommonJS helper) is left to fail at the call, inside or outside try/catch',async t=>{
  const host=await load(t,{
    'dep.cjs':`module.exports={guarded(){try{require('synthetic-absent-cjs');return 'present';}catch{return 'fallback';}},unguarded(){return require('synthetic-absent-cjs-two');}};`,
    'index.mjs':header+`import dep from './dep.cjs';export const inject=['tools'];export function apply(ctx){ctx.tools.register(tool('guarded',async()=>({value:dep.guarded()})));ctx.tools.register(tool('unguarded',async()=>({value:dep.unguarded()})));ctx.tools.register(tool('ok',async()=>({ok:true})));}`,
  });
  assert.equal((await run(host,'guarded')).structuredContent.value,'fallback');
  const failing=await run(host,'unguarded');assert.equal(failing.isError,true);assert.match(failing.content[0].text,/synthetic-absent-cjs-two/);
  assert.equal((await run(host,'ok')).structuredContent.ok,true,'the rest of the plugin works');
});

test('a static import declared optional (optionalDependencies) loads; using it gives a clear "not installed" error',async t=>{
  const host=await load(t,{
    'package.json':JSON.stringify({name:'optional-static',type:'module',optionalDependencies:{'synthetic-optional-parser':'^1.0.0'}}),
    'index.mjs':header+`import parser,{parse}from'synthetic-optional-parser';export const inject=['tools'];export function apply(ctx){ctx.tools.register(tool('named',async()=>({value:parse('x')})));ctx.tools.register(tool('default_call',async()=>({value:parser('x')})));ctx.tools.register(tool('plain',async()=>({ok:true})));}`,
  });
  assert.equal((await run(host,'plain')).structuredContent.ok,true);
  for(const name of ['named','default_call']){
    const result=await run(host,name);
    assert.equal(result.isError,true,name);assert.match(result.content[0].text,/Optional dependency "synthetic-optional-parser" is not installed/);
  }
  assert.ok(host.metadata.lazyDependencies.some(row=>row.specifier==='synthetic-optional-parser'&&row.mode==='optional-stub'));
});

test('an optional peer dependency (peerDependenciesMeta) is treated the same way',async t=>{
  const host=await load(t,{
    'package.json':JSON.stringify({name:'optional-peer',type:'module',peerDependencies:{'synthetic-peer-lib':'*'},peerDependenciesMeta:{'synthetic-peer-lib':{optional:true}}}),
    'index.mjs':header+`import*as peer from'synthetic-peer-lib';export const inject=['tools'];export function apply(ctx){ctx.tools.register(tool('plain',async()=>({ok:true})));ctx.tools.register(tool('uses_peer',async()=>({value:peer.something.deep})));}`,
  });
  assert.equal((await run(host,'plain')).structuredContent.ok,true);
  const result=await run(host,'uses_peer');assert.equal(result.isError,true);assert.match(result.content[0].text,/synthetic-peer-lib/);
});

test('a missing static import that the source needs and does not declare optional still fails the build with the package name',async t=>{
  await assert.rejects(load(t,{
    'package.json':JSON.stringify({name:'required-static',type:'module',dependencies:{'synthetic-required-lib':'^1.0.0'}}),
    'index.mjs':`import lib from'synthetic-required-lib';export const inject=['tools'];export function apply(){lib();}`,
  }),/Could not resolve "synthetic-required-lib"/);
  await assert.rejects(load(t,{'index.mjs':`import lib from'synthetic-undeclared-lib';export const inject=['tools'];export function apply(){lib();}`}),/Could not resolve "synthetic-undeclared-lib"/);
});

test('an installed optional package is used normally (resolution is tried first)',async t=>{
  const host=await load(t,{
    'package.json':JSON.stringify({name:'optional-present',type:'module',optionalDependencies:{'synthetic-present':'^1.0.0'}}),
    'node_modules/synthetic-present/package.json':JSON.stringify({name:'synthetic-present',version:'1.0.0',type:'module',main:'index.js'}),
    'node_modules/synthetic-present/index.js':`export const parse=text=>'parsed:'+text;`,
    'index.mjs':header+`import{parse}from'synthetic-present';export const inject=['tools'];export function apply(ctx){ctx.tools.register(tool('use',async()=>({value:parse('x')})));}`,
  });
  assert.equal((await run(host,'use')).structuredContent.value,'parsed:x');
  assert.ok(!host.metadata.lazyDependencies.some(row=>row.specifier==='synthetic-present'));
});

test('@deepseek-ai packages never become lazy stubs: a missing official package is an explicit error',async t=>{
  await assert.rejects(load(t,{
    'package.json':JSON.stringify({name:'official-optional',type:'module',optionalDependencies:{'@deepseek-ai/dsh-missing-thing':'*'}}),
    'index.mjs':`import x from'@deepseek-ai/dsh-missing-thing';export const inject=['tools'];export function apply(){x();}`,
  }),/Official runtime dependency is unavailable: @deepseek-ai\/dsh-missing-thing/);
});
