// Windows long-path fix: the plugin entry is compiled once at conversion time (runtime/plugin.mjs) so the worker
// does not start esbuild.exe on every launch. Also covers CommonJS-style __dirname/__filename in both compile paths.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {convertToClaude} from '../lib/converter-claude.mjs';
import {nodeFileGlobalsPrelude,portableFileUrl,resolveSourceRootPlaceholder,SOURCE_ROOT_PLACEHOLDER} from '../lib/precompile-entry.mjs';
import {spawnHost} from './claude-host-helpers.mjs';
import {writeStubTemplates} from './claude-package-fixtures.mjs';

const readJson=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const exists=async file=>{try{await fs.access(file);return true;}catch{return false;}};
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();

test('prelude: __dirname/__filename are defined only when used and not declared; shebang and "use strict" stay first',()=>{
  const url='file:///a%20b/x.js';
  assert.equal(nodeFileGlobalsPrelude('const a=1;',url),'const a=1;');
  const both=nodeFileGlobalsPrelude('"use strict";\nuse(__dirname,__filename)',url);
  assert.ok(both.startsWith('"use strict";;var __filename='),both);
  assert.ok(nodeFileGlobalsPrelude("'use strict'\nuse(__dirname)",url).startsWith("'use strict';var __dirname="),'a directive without semicolon stays valid');
  assert.match(both,/var __dirname=require\('node:path'\)\.dirname\(/);
  assert.ok(both.endsWith('\nuse(__dirname,__filename)'),'the original code keeps its line');
  assert.ok(nodeFileGlobalsPrelude('#!/usr/bin/env node\nuse(__dirname)',url).startsWith('#!/usr/bin/env node\n;var __dirname='));
  const declared=nodeFileGlobalsPrelude('const __dirname=dirname(fileURLToPath(import.meta.url));use(__dirname,__filename)',url);
  assert.ok(!/var __dirname/.test(declared),'a file that declares __dirname itself keeps its own');
  assert.match(declared,/^;var __filename=/);
});

test('placeholder: portable URLs are relative to the source root and resolve under any new root (spaces, non-ASCII, ..)',()=>{
  const root=path.join(os.tmpdir(),'old root','source');
  const file=path.join(root,'lib dir','é (1).js');
  const url=portableFileUrl(root,file);
  assert.ok(url.startsWith(SOURCE_ROOT_PLACEHOLDER+'/'),url);
  assert.doesNotMatch(url,/[ '()]/);
  const moved=path.join(os.tmpdir(),'new place','deeper','source');
  assert.equal(resolveSourceRootPlaceholder(`a("${url}");b('${portableFileUrl(root,path.join(root,'..','runtime','source-deps','x.js'))}')`,moved),
    `a("${pathToFileURL(path.join(moved,'lib dir','é (1).js')).href}");b('${pathToFileURL(path.join(moved,'..','runtime','source-deps','x.js')).href}')`);
});

const legacy=`const fs=require('fs'),path=require('path');
module.exports={dir:()=>__dirname,file:()=>__filename,read:()=>fs.readFileSync(path.join(__dirname,'data.txt'),'utf8')};
`;
const where=`import{fileURLToPath}from'node:url';export const dir=()=>fileURLToPath(new URL('.',import.meta.url));
`;
const index=`import{defineTool}from'@deepseek-ai/dsh-tools';
import{createRequire}from'node:module';
import{fileURLToPath}from'node:url';
import legacy from'./lib/legacy.cjs';
import{dir}from'./lib/where.mjs';
export const name='precompile-probe';export const inject=['tools'];
export function apply(ctx){ctx.tools.register(defineTool({name:'where',description:'paths seen by the plugin',parameters:{},output:{schema:{type:'json'},render:(_,v)=>[{type:'text',text:JSON.stringify(v)}]},
  execute:async()=>({entryDir:fileURLToPath(new URL('.',import.meta.url)),whereDir:dir(),legacyDir:legacy.dir(),legacyFile:legacy.file(),data:legacy.read(),requireDir:createRequire(import.meta.url)('./lib/legacy.cjs').dir()})}));}
`;

let shared;
before(async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fix precompiled '));
  const source=path.join(root,'src probe');await fs.mkdir(path.join(source,'lib'),{recursive:true});
  await fs.writeFile(path.join(source,'package.json'),JSON.stringify({name:'precompile-probe',version:'1.0.0',description:'probe',type:'module',main:'index.mjs'}));
  await fs.writeFile(path.join(source,'index.mjs'),index);
  await fs.writeFile(path.join(source,'lib','legacy.cjs'),legacy);await fs.writeFile(path.join(source,'lib','where.mjs'),where);await fs.writeFile(path.join(source,'lib','data.txt'),'hello from data');
  const templatesDir=await writeStubTemplates(path.join(root,'templates'));
  const out=path.join(root,'out');
  const report=await convertToClaude(source,{outputDir:out,installDependencies:false,templatesDir,stateMode:'package'});
  shared={root,out,report};
});
after(()=>shared&&fs.rm(shared.root,{recursive:true,force:true,maxRetries:10,retryDelay:300}).catch(()=>{}));
const convertProbe=async()=>shared;

// Copy the converted plugin to another (deeper) place, with no esbuild left in its runtime: starting it
// cannot compile anything at run time.
async function relocate(root,out,label,{withoutEsbuild=true}={}){
  const target=path.join(root,'moved '+label,'a much deeper folder','plugin');
  await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.cp(out,target,{recursive:true});
  await fs.rm(path.join(target,'.state'),{recursive:true,force:true});
  if(withoutEsbuild)for(const dir of ['esbuild','@esbuild'])await fs.rm(path.join(target,'runtime','host-env','node_modules',dir),{recursive:true,force:true});
  return target;
}
async function whereOf(t,target){
  const host=await spawnHost(t,target,{bundleFile:path.join(target,'runtime','claude-host.mjs'),rootArg:false,answer:async()=>({})});
  const ready=await host.ready();
  assert.deepEqual(ready.tools.map(tool=>tool.dshName),['where']);
  const result=await host.rpc('tools.call',{name:'where',args:{},callId:'w1'});
  assert.equal(result.isError,false,JSON.stringify(result));
  return {ready,paths:JSON.parse(result.content[0].text)};
}
function assertPaths(paths,target){
  const source=path.join(target,'source');
  assert.ok(same(paths.entryDir,source),paths.entryDir);
  assert.ok(same(paths.whereDir,path.join(source,'lib')),paths.whereDir);
  assert.ok(same(paths.legacyDir,path.join(source,'lib')),'__dirname: '+paths.legacyDir);
  assert.ok(same(paths.legacyFile,path.join(source,'lib','legacy.cjs')),'__filename: '+paths.legacyFile);
  assert.ok(same(paths.requireDir,path.join(source,'lib')),'createRequire entry: '+paths.requireDir);
  assert.equal(paths.data,'hello from data');
}

test('conversion writes a relocatable runtime/plugin.mjs and plugin.meta.json',async t=>{
  const {out,report}=await convertProbe(t);
  assert.ok(['converted','partial'].includes(report.conversion.status),JSON.stringify(report.conversion.omitted));
  const code=await fs.readFile(path.join(out,'runtime','plugin.mjs'),'utf8');
  const meta=await readJson(path.join(out,'runtime','plugin.meta.json'));
  assert.equal(meta.schemaVersion,1);assert.equal(meta.entry,'index.mjs');assert.deepEqual(meta.lazyDependencies,[]);
  assert.equal(report.conversion.precompiledEntry.file,'runtime/plugin.mjs');
  assert.ok(code.includes(SOURCE_ROOT_PLACEHOLDER+'/index.mjs'),'createRequire entry uses the placeholder');
  assert.ok(code.includes(SOURCE_ROOT_PLACEHOLDER+'/lib/legacy.cjs'));
  assert.ok(/from "@deepseek-ai\/dsh-tools"|from '@deepseek-ai\/dsh-tools'/.test(code),'@deepseek-ai stays a bare external');
  assert.ok(!code.toLowerCase().includes(out.toLowerCase().replaceAll('\\','/')),'no absolute output path baked in');
  assert.ok(!code.toLowerCase().includes(out.toLowerCase().replaceAll('\\','\\\\')),'no absolute output path baked in (escaped)');
  assert.ok(!code.includes(pathToFileURL(out).href.slice(0,40)+encodeURI(path.basename(path.dirname(out)))),'no absolute file URL baked in');
});

test('the converted plugin, moved to another folder with esbuild deleted, starts from the precompiled file and sees its new location',async t=>{
  const {root,out}=await convertProbe(t);
  const target=await relocate(root,out,'one');
  await assert.rejects(fs.access(path.join(target,'runtime','host-env','node_modules','esbuild')));
  const {paths}=await whereOf(t,target);
  assertPaths(paths,target);
  const compiled=await fs.readFile(path.join(target,'.state','compiled','plugin.mjs'),'utf8');
  assert.ok(!compiled.includes(SOURCE_ROOT_PLACEHOLDER),'the placeholder was filled in');
  assert.ok(compiled.includes(pathToFileURL(path.join(target,'source','index.mjs')).href));
});

test('without runtime/plugin.mjs the worker compiles at start-up as before (same __dirname handling)',async t=>{
  const {root,out}=await convertProbe(t);
  const target=await relocate(root,out,'two',{withoutEsbuild:false});
  await fs.rm(path.join(target,'runtime','plugin.mjs'));
  const {paths}=await whereOf(t,target);
  assertPaths(paths,target);
});

test('a precompiled file that does not belong to the entry is ignored and the entry is compiled instead',async t=>{
  const {root,out}=await convertProbe(t);
  const target=await relocate(root,out,'three',{withoutEsbuild:false});
  const meta=path.join(target,'runtime','plugin.meta.json');
  await fs.writeFile(meta,JSON.stringify({...await readJson(meta),entry:'other.mjs'}));
  await fs.writeFile(path.join(target,'runtime','plugin.mjs'),'throw new Error("stale precompiled file was used");\n');
  const {paths}=await whereOf(t,target);
  assertPaths(paths,target);
});

test('conversion can skip the precompiled file (precompileEntry:false) and nothing else changes',async t=>{
  const {root}=await convertProbe(t);
  const source=path.join(root,'src probe'),out=path.join(root,'out-no-precompile');
  const report=await convertToClaude(source,{outputDir:out,installDependencies:false,templatesDir:path.join(root,'templates'),stateMode:'package',precompileEntry:false,buildClaudeHost:async({outputDir})=>fs.writeFile(path.join(outputDir,'runtime','claude-host.mjs'),'// stub\n')});
  assert.equal(await exists(path.join(out,'runtime','plugin.mjs')),false);
  assert.equal(report.conversion.precompiledEntry,undefined);
});
