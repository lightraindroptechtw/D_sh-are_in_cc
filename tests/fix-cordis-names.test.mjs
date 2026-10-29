// Converter bug 1: Cordis method names (inject, provide, emit, ...) were treated as DSH services,
// root.provide("inject") then failed with `property "inject" is already declared as accessor`
// and took the whole module layer (and the plugin) down with it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {inspectJs,inspectSource} from '../lib/inspect.mjs';
import {CORDIS_CONTEXT_API_NAMES,isCordisContextName} from '../lib/cordis-context.mjs';
import {isKnownDshService,DSH_SERVICES} from '../lib/dsh-services.mjs';
import {selectModules,installModules} from '../lib/modules/index.mjs';
import {claudeRegistry,claudeCapabilities} from '../lib/modules/claude/index.mjs';
import {loadDshHost} from '../lib/dsh-host.mjs';

const caps={mcp:true,skills:true};
const header=`import{defineTool}from'@deepseek-ai/dsh-tools';const tool=(name,execute)=>defineTool({name,description:name,parameters:{},output:{schema:{type:'json'},render:(_,v)=>[{type:'text',text:JSON.stringify(v)}]},execute});`;
async function fixture(t,source,options={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fix-cordis-'));let host;
  t.after(async()=>{await host?.dispose();await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  await fs.writeFile(path.join(dir,'index.mjs'),source);
  host=await loadDshHost({entry:path.join(dir,'index.mjs'),sourceRoot:dir,stateDir:path.join(dir,'state'),initializeTimeoutMs:15000,...options});
  return host;
}

test('analysis: every Cordis method name is context API, not a service; unknown names are only uncertain evidence',()=>{
  const result=inspectJs(`export const inject=['tools'];export function apply(ctx){
    ctx.inject(['commands'],c=>c.commands.register({name:'x',handler(){}}));ctx.provide('mine',{});ctx.emit('a');ctx.on('a',()=>{});ctx.once('a',()=>{});
    ctx.plugin(()=>{});ctx.get('tools');ctx.set('k',1);ctx.extend({});ctx.isolate('fs');ctx.effect(()=>()=>{});ctx.parallel('a');ctx.waterfall('a');ctx.bail('a');ctx.serial('a');
    ctx.accessor('z',{get(){}});ctx.mixin('q',['r']);ctx.scope;ctx.fiber;ctx.logger;ctx.strangeThing.go();
  }`);
  assert.deepEqual([...result.services].sort(),['commands','fs','tools'].filter(name=>result.services.includes(name)));
  for(const name of ['inject','provide','emit','on','once','plugin','get','set','extend','isolate','effect','parallel','waterfall','bail','serial','accessor','mixin','scope'])assert.ok(!result.services.includes(name),`${name} must not be a service`);
  for(const name of ['inject','provide','emit','plugin','on','get','set','extend','isolate','scope'])assert.equal(isCordisContextName(name),true,name);
  assert.ok(result.uncertainServices.some(item=>item.name==='strangeThing'),'unknown names stay as evidence');
  assert.ok(!result.services.includes('strangeThing'));
});

test('analysis: the DSH services seen in the 100-plugin review are known; Cordis names never are',()=>{
  for(const name of ['shell','subagents','subprocess','workspaceRegistry','connection','sessionController','agentDefaultModel','fs','llm','agents','sessions'])assert.equal(isKnownDshService(name),true,name);
  for(const name of CORDIS_CONTEXT_API_NAMES)assert.equal(DSH_SERVICES.has(name),false,`${name} is a Cordis member`);
  assert.equal(isKnownDshService('fillStyle'),false);
});

test('analysis: a service-free source analyzed from disk keeps no inject/provide/emit requirement',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fix-cordis-src-'));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'only-cordis-api',main:'index.mjs'}));
  await fs.writeFile(path.join(root,'index.mjs'),`export function apply(ctx){ctx.inject(['tools'],c=>c.emit('x'));ctx.provide('s',{});ctx.on('x',()=>{});}`);
  const report=await inspectSource(root);
  assert.ok(!report.host.services.some(name=>['inject','provide','emit','on'].includes(name)),JSON.stringify(report.host.services));
});

test('registry: Cordis names and unknown spellings from analysis never produce a module row or a provide()',()=>{
  const plan={host:{services:[...CORDIS_CONTEXT_API_NAMES,'fillStyle','neverHeardOfIt','shell','fs']}};
  const rows=selectModules(plan,{},caps);
  const ids=rows.map(row=>row.id);
  assert.ok(ids.includes('fs')&&ids.includes('shell'),'known services are kept');
  assert.ok(!ids.includes('fillStyle')&&!ids.includes('neverHeardOfIt'));
  for(const name of CORDIS_CONTEXT_API_NAMES)assert.ok(!ids.includes(name),name);
  assert.deepEqual([...rows.uncertainServices].sort(),['fillStyle','neverHeardOfIt']);
  const claudeRows=selectModules(plan,{},claudeCapabilities,claudeRegistry);
  assert.ok(claudeRows.every(row=>!CORDIS_CONTEXT_API_NAMES.includes(row.id)));
});

test('registry: one failing service never takes the others down (module install and provide)',async t=>{
  const root=new Context();t.after(()=>root.fiber.dispose());
  // A small registry: the first module throws while installing, the second one is fine ...
  const module=(id,install)=>({descriptor:{id,displayName:id,services:[id],requires:{capabilities:[]},methods:{}},install});
  const modules=new Map([['boom',module('boom',async()=>{throw Object.assign(new Error('install exploded'),{code:'BOOM'});})],['fine',module('fine',async()=>({services:{fine:{ok:true}}}))],['other',module('other',async()=>({services:{other:{ok:true}}}))]]);
  const rows=selectModules({},{modules:['boom','fine']},caps,modules);
  const result=await installModules({root,selected:rows,registry:modules,capabilities:caps});t.after(()=>result.dispose());
  const byId=Object.fromEntries(result.modules.map(row=>[row.id,row.runtimeStatus]));
  assert.equal(byId.boom,'disabled');
  assert.equal(byId.fine,'installed','a later module is installed even though an earlier one failed');
  assert.throws(()=>root.get('boom').call(),error=>error.module==='boom');
  // ... and a provide() that throws for one name is contained as well.
  const fragile=new Context();t.after(()=>fragile.fiber.dispose());
  const realProvide=fragile.provide.bind(fragile);
  fragile.provide=(name,value)=>{if(name==='fine')throw new Error('provide exploded');return realProvide(name,value);};
  const second=await installModules({root:fragile,selected:selectModules({},{modules:['fine','other']},caps,modules),registry:modules,capabilities:caps});t.after(()=>second.dispose());
  assert.ok(second.diagnostics.some(item=>/could not be mounted/.test(item.reason??'')));
  assert.ok(fragile.get('other'),'the next service is still mounted');
});

test('host: a plugin using inject/provide/emit/on/plugin/extend/isolate loads and runs even if a legacy report lists them as services',async t=>{
  const source=header+`export const inject=['tools'];export function apply(ctx){
    ctx.provide('localThing',{n:1});ctx.on('mine/event',()=>{});ctx.emit('mine/event');
    ctx.inject(['tools'],child=>child.emit('mine/child'));const scoped=ctx.isolate('localThing').extend({});scoped.emit('mine/scoped');
    ctx.plugin({apply(inner){inner.on('mine/event',()=>{});}});
    ctx.tools.register(tool('names_probe',async()=>({ok:true})));}`;
  for(const hostKind of [undefined,'claude']){
    const host=await fixture(t,source,{services:[],plan:{host:{services:['inject','provide','emit','on','plugin','extend','isolate','get','set','scope']}},codexCapabilities:caps,...(hostKind?{hostKind}:{})});
    const result=await host.tools.find(tool=>tool.name==='names_probe').execute({});
    assert.equal(result.isError,false,String(hostKind));assert.equal(result.structuredContent.ok,true);
  }
});

test('host: a real DSH service without a mapped module (sessionController) gives an explicit unavailable service, never a fake one',async t=>{
  const source=header+`export const inject=['tools','sessionController'];export function apply(ctx){
    ctx.tools.register(tool('plain',async()=>({ok:true})));
    ctx.tools.register(tool('uses_sessionctl',async()=>ctx.sessionController.run('echo hi')));}`;
  const host=await fixture(t,source,{services:[],plan:{host:{services:['sessionController']}},hostKind:'claude'});
  assert.equal((await host.tools.find(tool=>tool.name==='plain').execute({})).isError,false);
  const used=await host.tools.find(tool=>tool.name==='uses_sessionctl').execute({});
  assert.equal(used.isError,true);assert.match(used.content[0].text,/sessionController\.run/);assert.match(used.content[0].text,/No generic module maps this DSH service/);
});

test('host: an injected service that is neither mounted nor a known DSH service keeps the plugin inactive and is named',async t=>{
  await assert.rejects(fixture(t,header+`export const inject=['tools','totallyUnknownService'];export function apply(){}`,{services:[],plan:{host:{services:['totallyUnknownService']}},hostKind:'claude'}),error=>error.code==='HOST_PLUGIN_INACTIVE'&&error.unsupported.some(item=>item.feature==='service:totallyUnknownService'));
});
