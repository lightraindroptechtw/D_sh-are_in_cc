// End to end on a real third-party DSH plugin (one of the four allowed, read-only source):
// analyse -> official host build (existing converter functions) -> bundled child host -> tool call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {acquireSource,copySource} from '../lib/source.mjs';
import {inspectSource} from '../lib/inspect.mjs';
import {buildOfficialHost} from '../lib/host-build.mjs';
import {buildClaudeHost} from '../lib/claude-host/build.mjs';
import {projectRoot,spawnHost} from './claude-host-helpers.mjs';

// Same read-only corpus folder as e2e-claude.test.mjs (DSH_E2E_CORPUS); skipped without it.
const SOURCE=path.join(process.env.DSH_E2E_CORPUS??path.join(projectRoot,'tmp','no-corpus'),'dsh-plugin-finance-data_0.3.2');
const available=await fs.access(path.join(SOURCE,'package.json')).then(()=>true,()=>false);

test('dsh-plugin-finance-data: converted layout -> child host -> finance_data ratio(pe) with 50 and 5 gives 10',{skip:available?false:'the finance-data source (read-only corpus) is not on this machine',timeout:180000},async t=>{
  const out=await fs.mkdtemp(path.join(os.tmpdir(),'claude-host-finance-'));
  const cleanup=async()=>fs.rm(out,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
  const before=await fs.readFile(path.join(SOURCE,'lib','index.js'),'utf8');
  const source=await acquireSource(SOURCE,{cacheDir:path.join(out,'.cache')});
  const plan=await inspectSource(source);
  assert.equal(plan.convertible,true);
  await copySource(source.root,path.join(out,'source'));
  await buildOfficialHost({converterRoot:projectRoot,outputDir:out,plan,config:{},allowTools:[],hooks:false,options:{homeMode:'isolated',initializeTimeoutMs:60000,callTimeoutMs:60000,cancelGraceMs:1000,passEnv:[],moduleOptions:{},stateMode:'package',stateId:'finance-data-test',sourceNodePaths:[],serviceConfig:{}}});
  const built=await buildClaudeHost({outputDir:out});
  assert.equal(built.file,path.join(out,'runtime','claude-host.mjs'));
  // The layout the mod relies on.
  for(const file of ['runtime/claude-host.mjs','runtime/dsh-host-worker.mjs','runtime/settings.json','runtime/host-env/host-environment.json'])await fs.access(path.join(out,file));
  await assert.rejects(fs.access(path.join(out,'bin')),'a plugin saved to claude.ai must not contain bin/');

  // Spawn it the way the mod does: no --root, the root follows from the bundle location.
  const host=await spawnHost(t,out,{bundleFile:built.file,rootArg:false,answer:async()=>({})});
  t.after(cleanup);
  const ready=await host.ready();
  assert.equal(ready.tools.length,1);const tool=ready.tools[0];
  assert.equal(tool.dshName,'finance_data');assert.equal(tool.name,'finance_data');assert.ok(tool.inputSchema.properties.action);
  assert.ok(ready.promptSections.some(s=>s.id==='finance-data:instructions'&&s.text.includes('finance_data')),JSON.stringify(ready.promptSections.map(s=>s.id)));
  assert.equal(ready.interception,false);

  const result=await host.rpc('tools.call',{name:'finance_data',args:{action:'ratio',type:'pe',price:50,eps:5},callId:'finance-1'});
  assert.equal(result.isError,false,JSON.stringify(result));
  assert.match(result.content[0].text,/\bpe\b\D*10\b/i);
  assert.equal(await fs.readFile(path.join(SOURCE,'lib','index.js'),'utf8'),before,'the corpus source is untouched');
  const bad=await host.rpc('tools.call',{name:'finance_data',args:{action:'ratio',type:'pe',price:50,eps:0},callId:'finance-2'});
  assert.equal(bad.isError,true,'dividing by a zero EPS is reported as an error, not as a number');
});
