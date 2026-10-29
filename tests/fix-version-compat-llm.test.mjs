// Plugins written for @deepseek-ai/dsh-llm 0.1.0-rc.6 import CallId, assertNever and deepFreeze, which 0.2.1-rc.2 no longer exports
// (real cases: dsh-vision-web, dsh-youreyes: "does not provide an export named 'CallId'"). The plugin entry compile now serves
// '@deepseek-ai/dsh-llm' through a compat module: the real 0.2 package plus those three names. Synthetic plugins only.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';
import {createRequire} from 'node:module';
import * as realLlm from '@deepseek-ai/dsh-llm';
import {COMPAT_MODULES,compatModuleFor} from '../lib/compat/index.mjs';
import {compileDshEntry} from '../lib/precompile-entry.mjs';
import {convertToClaude} from '../lib/converter-claude.mjs';
import {makePlugin,spawnHost,toolHeader,projectRoot} from './claude-host-helpers.mjs';
import {writeStubTemplates} from './claude-package-fixtures.mjs';

const OLD_ONLY=['CallId','assertNever','deepFreeze'];

test('compat table: the names 0.2.1-rc.2 lacks are provided, every other name of the package passes through',()=>{
  const row=compatModuleFor('@deepseek-ai/dsh-llm');
  assert.ok(row);assert.deepEqual([...row.provides],OLD_ONLY);assert.equal(row.olderRelease,'0.1.0-rc.6');
  for(const name of OLD_ONLY)assert.equal(Object.hasOwn(realLlm,name),false,`${name} is really missing in the bundled 0.2 package (if it appears, the compat entry is no longer needed)`);
  const spec='@deepseek-ai/dsh-llm';
  const text=row.render(spec,['createUserMessage','ToolCallId','default']);
  assert.match(text,/export \{createUserMessage,ToolCallId\} from "@deepseek-ai\/dsh-llm"/,'real names are re-exported one by one, so an unknown name stays an import error');
  assert.match(text,/export \{default\} from/);assert.doesNotMatch(text,/export \* from/);
  for(const name of OLD_ONLY)assert.match(text,new RegExp('export const '+name+'='));
  assert.match(row.render(spec,null),/export \* from/,'fallback when the export list cannot be read');
  assert.doesNotMatch(row.render(spec,['CallId','deepFreeze','assertNever']),/export const/,'a name the real package gains later is not shadowed or duplicated');
  assert.equal(compatModuleFor('@deepseek-ai/dsh-tools'),undefined);
  assert.equal(compatModuleFor('toString'),undefined,'inherited object keys are not packages');
  assert.deepEqual(row.unavailable,[],'every missing 0.1 name has an equivalent; a name without one would be listed here and throw when used');
  assert.ok(Object.isFrozen(COMPAT_MODULES));
});

const checks=`import {CallId,MessageId,assertNever,callConfigEquals,deepFreeze,freezeMessage,HarnessError,createUserMessage,LlmError} from '@deepseek-ai/dsh-llm';
import * as llm from '@deepseek-ai/dsh-llm';
import DefaultExport from '@deepseek-ai/dsh-llm';`;
const body=`
export const name='llm-v01';export const inject=['tools'];
export function apply(ctx){ctx.tools.register(tool('checks',async()=>{
  const out={};
  out.callId=CallId('call_1');out.messageId=MessageId('m_1');
  const frozen=deepFreeze({a:{b:[1,{c:2}]}});out.deepFrozen=Object.isFrozen(frozen)&&Object.isFrozen(frozen.a.b[1]);
  try{assertNever('x','switch site');}catch(e){out.assertNever=e.message;}
  out.callConfigEquals=[callConfigEquals({model:'a',stop:['x']},{model:'a',stop:['x']}),callConfigEquals({model:'a'},{model:'b'})];
  out.freeze=Object.isFrozen(freezeMessage({id:'m',role:'user',content:[{type:'text',text:'hi'}],source:{kind:'user'}}));
  out.harnessError=new HarnessError('boom','X').code;
  out.userMessage=createUserMessage({content:[{type:'text',text:'hello'}],source:{kind:'user'}}).role;
  out.realNamesStillThere=typeof LlmError==='function'&&typeof llm.createAssistantMessage==='function'&&typeof DefaultExport==='function';
  out.sameBrandAsTool=llm.CallId===llm.ToolCallId;
  return out;
}));}
`;
const expected=result=>{
  assert.equal(result.isError,false,JSON.stringify(result));
  const value=JSON.parse(result.content[0].text);
  assert.equal(value.callId,'call_1');assert.equal(value.messageId,'m_1');
  assert.equal(value.deepFrozen,true);
  assert.match(value.assertNever,/^unreachable variant in switch site: "x"$/);
  assert.deepEqual(value.callConfigEquals,[true,false]);
  assert.equal(value.freeze,true);assert.equal(value.harnessError,'X');assert.equal(value.userMessage,'user');
  assert.equal(value.realNamesStillThere,true,'the real 0.2 exports (and the default export) are still there');
  assert.equal(value.sameBrandAsTool,true,'CallId is the 0.2 ToolCallId');
};

test('a plugin that imports CallId/assertNever/deepFreeze starts and they behave like 0.1 (runtime compile path)',async t=>{
  const root=await makePlugin(t,toolHeader+checks+body);
  const host=await spawnHost(t,root,{answer:async()=>({})});
  const ready=await host.ready();
  assert.deepEqual(ready.tools.map(row=>row.dshName),['checks']);
  assert.deepEqual(ready.metadata.compat.filter(row=>row.id==='package-compat'),[{id:'package-compat',package:'@deepseek-ai/dsh-llm',olderRelease:'0.1.0-rc.6',provides:OLD_ONLY}]);
  expected(await host.rpc('tools.call',{name:'checks',args:{},callId:'c1'}));
});

test('a name that never existed is still an explicit error (the compat module does not hide real mistakes)',async t=>{
  const root=await makePlugin(t,toolHeader+`import {NoSuchLegacyName} from '@deepseek-ai/dsh-llm';export const name='bad';export const inject=['tools'];export function apply(ctx){ctx.tools.register(tool('x',async()=>NoSuchLegacyName));}`);
  const host=await spawnHost(t,root,{answer:async()=>({})});
  await assert.rejects(host.ready(),error=>{assert.match(error.message,/NoSuchLegacyName/);return true;});
});

test('conversion precompiles with the compat module, records it, and the converted plugin starts from the precompiled file',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fix llm compat '));
  t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:300}).catch(()=>{}));
  const source=path.join(root,'src');await fs.mkdir(source,{recursive:true});
  await fs.writeFile(path.join(source,'package.json'),JSON.stringify({name:'llm-v01',version:'1.0.0',description:'probe',type:'module',main:'index.mjs',peerDependencies:{'@deepseek-ai/dsh-llm':'^0.1.0-rc.6'}}));
  await fs.writeFile(path.join(source,'index.mjs'),toolHeader+checks+body);
  const out=path.join(root,'out');
  const report=await convertToClaude(source,{outputDir:out,installDependencies:false,templatesDir:await writeStubTemplates(path.join(root,'templates')),stateMode:'package'});
  assert.deepEqual(report.conversion.precompiledEntry.compat,[{package:'@deepseek-ai/dsh-llm',olderRelease:'0.1.0-rc.6',provides:OLD_ONLY}]);
  const meta=JSON.parse(await fs.readFile(path.join(out,'runtime','plugin.meta.json'),'utf8'));
  assert.deepEqual(meta.compat.map(row=>row.package),['@deepseek-ai/dsh-llm']);
  const code=await fs.readFile(path.join(out,'runtime','plugin.mjs'),'utf8');
  assert.match(code,/from "@deepseek-ai\/dsh-llm"/,'the real package stays a bare external inside the compat module');
  assert.match(code,/from "@deepseek-ai\/dsh-util-values"/);
  const host=await spawnHost(t,out,{bundleFile:path.join(out,'runtime','claude-host.mjs'),rootArg:false,answer:async()=>({})});
  const ready=await host.ready();
  assert.equal(ready.metadata.compat.some(row=>row.package==='@deepseek-ai/dsh-llm'),true,'compat rows of the precompiled file are reported too');
  expected(await host.rpc('tools.call',{name:'checks',args:{},callId:'c2'}));
  await host.stop(); // before the temporary folder is removed (after hooks run in registration order)
});

test('compileDshEntry (portable) reports the substitution once and keeps the official packages external',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fix llm esbuild '));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}).catch(()=>{}));
  await fs.writeFile(path.join(dir,'a.mjs'),`import {CallId} from '@deepseek-ai/dsh-llm';export const v=CallId('x');`);
  const seen=[];
  await compileDshEntry({esbuild,requireFromHost:createRequire(path.join(projectRoot,'package.json')),entry:path.join(dir,'a.mjs'),outfile:path.join(dir,'out.mjs'),sourceRoot:dir,nodePaths:[path.join(projectRoot,'node_modules')],portable:true,onCompat:row=>seen.push(row.package)});
  assert.deepEqual(seen,['@deepseek-ai/dsh-llm'],'reported once');
  const code=await fs.readFile(path.join(dir,'out.mjs'),'utf8');
  assert.ok(/CallId/.test(code));
  assert.match(code,/from "@deepseek-ai\/dsh-llm"/);
});
