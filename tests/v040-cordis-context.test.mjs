import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {CORDIS_CONTEXT_API_NAMES,isCordisContextName} from '../lib/cordis-context.mjs';
import {inspectJs,inspectSource} from '../lib/inspect.mjs';
import {selectModules,installModules} from '../lib/modules/index.mjs';
import {loadDshHost} from '../lib/dsh-host.mjs';

const caps={codexVersion:'0.160.0',mcp:true,skills:true,appServer:true};

test('A8 Cordis API usage stays separate from required services, including scoped aliases and destructuring',()=>{
  const result=inspectJs(`export function apply(host){
    host.provide('localExtension',{});host.emit('synthetic/event');
    const scoped=host.isolate('webServer').extend({});const {commands:registry,inject:withServices,emit:publish}=scoped;
    scoped.webServer.register({});registry.register({name:'synthetic',handler(){}});
    withServices(['web','credentials'],connection=>{const alias=connection.intercept('web',{});const {settings:config}=alias;config.describe();connection.web.registerSearchProvider({});});
    publish('synthetic/other');function canvas(ctx){ctx.inject=()=>{};ctx.fillStyle='red';}
  }`);
  assert.deepEqual([...result.services].sort(),['commands','credentials','settings','web','webServer']);
  for(const name of ['inject','provide','emit','isolate','extend','intercept']){assert.ok(!result.services.includes(name));assert.ok(result.contextApi.some(item=>item.name===name),name);}
  assert.equal(result.commands[0].name,'synthetic');assert.ok(result.uncertainServices.some(item=>item.name==='fillStyle'));
});

test('A8 service-free event plugins keep a host route without inventing on/provide/emit services',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cordis-analysis-'));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'synthetic-events',main:'index.mjs'}));
  await fs.writeFile(path.join(root,'index.mjs'),`export function apply(context){context.on('synthetic/input',()=>context.emit('synthetic/output'));context.provide('synthetic',{});}`);
  const report=await inspectSource(root);assert.deepEqual(report.host.services,[]);assert.deepEqual(report.capabilities.hostRuntime.services,[]);assert.equal(report.capabilities.hostRuntime.status,'candidate-not-executed');assert.equal(report.convertible,true);
});

test('registry selection excludes every Cordis built-in context name',()=>{
  const selected=selectModules({},{modules:[...CORDIS_CONTEXT_API_NAMES,...Object.getOwnPropertyNames(Object.prototype),'prototype','fs']},caps);
  assert.deepEqual(selected.map(item=>item.id),['fs']);
});

test('registry rejects old/forced built-in rows before provide and preserves a live Cordis context',async t=>{
  const root=new Context();t.after(()=>root.fiber.dispose());
  const accessorNames=Object.entries(root.reflect.props).filter(([,value])=>value.type==='accessor').map(([name])=>name);
  for(const name of accessorNames)assert.equal(isCordisContextName(name),true,`pinned Cordis accessor ${name} must be reserved`);
  const originals={inject:root.inject,provide:root.provide,emit:root.emit};
  const names=[...new Set([...CORDIS_CONTEXT_API_NAMES,...Object.getOwnPropertyNames(Object.prototype),'prototype'])];
  const selected=names.map(name=>({id:`legacy-${name}`,descriptor:{id:`legacy-${name}`,services:[name]},available:false,reason:'old analysis output'}));
  const result=await installModules({root,selected,capabilities:caps});t.after(()=>result.dispose());
  assert.equal(result.modules.length,names.length);assert.ok(result.modules.every(item=>item.runtimeStatus==='disabled'));assert.equal(result.diagnostics.filter(item=>item.code==='CORDIS_CONTEXT_NAME_RESERVED').length,names.length);
  for(const name of names)assert.ok(!Object.hasOwn(result.services,name));
  let calls=0;root.on('synthetic/event',()=>calls++);root.emit('synthetic/event');assert.equal(calls,1);
  const remove=root.provide('synthetic',{ready:true});assert.equal(root.get('synthetic').ready,true);await remove();
  assert.equal(typeof root.inject,'function');assert.equal(typeof root.provide,'function');assert.equal(typeof root.emit,'function');assert.equal(typeof originals.inject,'function');
});

test('registry protects unknown accessors declared by other host packages while retaining nonconflicting unknown diagnostics',async t=>{
  const root=new Context();t.after(()=>root.fiber.dispose());let getters=0;
  root.accessor('futureHostAccessor',{get(){getters++;return 'original';}});
  const forced={id:'future-row',descriptor:{id:'future-row',services:['futureHostAccessor']},available:false,reason:'unknown'};
  const selected=[forced,...selectModules({},{modules:['unknownExtension']},caps)];
  const result=await installModules({root,selected,capabilities:caps});t.after(()=>result.dispose());
  assert.equal(result.modules[0].runtimeStatus,'disabled');assert.ok(result.diagnostics.some(item=>item.code==='CORDIS_CONTEXT_NAME_RESERVED'));
  assert.equal(getters,0,'collision checks must not invoke arbitrary accessors');assert.equal(root.futureHostAccessor,'original');
  assert.throws(()=>root.get('unknownExtension').unmapped(),error=>error.module==='unknownExtension');
});

test('synthetic source initializes and executes with inject/provide/emit even when a legacy report lists them as services',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cordis-host-regression-'));let host;
  t.after(async()=>{await host?.dispose();await fs.rm(root,{recursive:true,force:true});});
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'synthetic-cordis-api',type:'module'}));
  await fs.writeFile(path.join(root,'index.mjs'),`export const inject=['tools'];export function apply(ctx){ctx.provide('syntheticLocal',{ready:true});ctx.emit('synthetic/event');ctx.inject(['tools'],child=>child.emit('synthetic/child'));ctx.tools.register({name:'synthetic_probe',description:'Synthetic regression probe',parameters:{type:'object'},output:{schema:{type:'number'},render:(_,value)=>[{type:'text',text:String(value)}]},execute:async()=>7});}`);
  host=await loadDshHost({entry:path.join(root,'index.mjs'),sourceRoot:root,stateDir:path.join(root,'state'),services:[],plan:{host:{services:['inject','provide','emit']}},codexCapabilities:caps});
  const tool=(await host.getTools()).find(item=>item.name==='synthetic_probe');assert.ok(tool);const result=await tool.execute({});assert.equal(result.isError,false);assert.equal(result.content[0].text,'7');
});
