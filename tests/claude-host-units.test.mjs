import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {claudeToolName,createToolCatalog,shapeContent} from '../lib/claude-host/tools.mjs';
import {resolveClaudeState} from '../lib/claude-host/host.mjs';
import {buildClaudeHost} from '../lib/claude-host/build.mjs';
import {toPrompt} from '../lib/modules/claude/llm.mjs';
import {collectPromptSections} from '../lib/modules/claude/system-prompt.mjs';
import {createClaudeApprovalService} from '../lib/modules/claude/approval.mjs';
import {createClaudeBridgeAgent} from '../lib/modules/claude/common.mjs';

test('tool names are legal Claude names and unique; DSH names stay available as dshName',()=>{
  assert.equal(claudeToolName('web.search'),'web_search');
  assert.equal(claudeToolName('a b/c:d'),'a_b_c_d');
  assert.equal(claudeToolName('x'.repeat(100)).length,64);
  const used=new Set();
  const names=['a.b','a_b','a b','a-b'].map(name=>claudeToolName(name,used));
  assert.equal(new Set(names).size,4);
  for(const name of names)assert.match(name,/^[A-Za-z0-9_-]{1,64}$/);
  const catalog=createToolCatalog();
  const first=catalog.describe([{name:'x.y',description:'d',inputSchema:{type:'object',properties:{a:{}}}},{name:'x_y'}]);
  assert.deepEqual(first.map(t=>t.name),['x_y','x_y_2']);
  assert.deepEqual(first[1].inputSchema,{type:'object'});
  assert.equal(first[1].description,'');
  assert.deepEqual(catalog.describe([{name:'x_y'},{name:'x.y'}]).map(t=>t.name),['x_y_2','x_y'],'a tool keeps its Claude name when the list changes');
  assert.equal(catalog.find([{name:'x.y'}],'x_y').name,'x.y');
  assert.equal(catalog.find([{name:'x.y'}],'x.y').name,'x.y');
  assert.equal(catalog.find([],'x_y'),undefined);
});

test('shapeContent keeps text and names every block it cannot carry',()=>{
  assert.deepEqual(shapeContent([{type:'text',text:'a'},{type:'image',data:'zzz'}]),[{type:'text',text:'a'},{type:'text',text:'[image content omitted: Claude Code tool results carry text only]'}]);
  assert.deepEqual(shapeContent(undefined),[{type:'text',text:''}]);
});

test('state lives outside the plugin cache and outside ~/.claude',()=>{
  const home=path.join(os.tmpdir(),'fake-home');
  assert.equal(resolveClaudeState({root:'/r',settings:{stateMode:'package'},env:{},home}),path.resolve('/r','.state'));
  assert.equal(resolveClaudeState({root:'/r',settings:{},env:{},home}),path.resolve('/r','.state'),'no stateId: package-local state');
  const resolved=resolveClaudeState({root:'/r',settings:{stateId:'plugin-1234'},env:{},home});
  assert.equal(resolved,path.join(home,'.dsh-to-claude','state','plugin-1234'));
  assert.ok(!resolved.includes(path.join(home,'.claude')));
  const base=path.join(os.tmpdir(),'state-base');
  assert.equal(resolveClaudeState({root:'/r',settings:{stateId:'plugin-1234'},env:{DSH_CLAUDE_STATE_ROOT:base},home}),path.join(base,'plugin-1234'));
  assert.throws(()=>resolveClaudeState({root:'/r',settings:{stateId:'Bad/Id'},env:{},home}),/identity/);
  assert.throws(()=>resolveClaudeState({root:'/r',settings:{stateId:'ok'},env:{DSH_CLAUDE_STATE_ROOT:'relative'},home}),/absolute/);
});

test('buildClaudeHost writes one self-contained ESM file under runtime/ and nothing else',async t=>{
  const out=await fs.mkdtemp(path.join(os.tmpdir(),'claude-host-build-'));
  t.after(()=>fs.rm(out,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const result=await buildClaudeHost({outputDir:out});
  assert.equal(result.file,path.join(out,'runtime','claude-host.mjs'));
  assert.ok(result.bytes>10000);
  assert.deepEqual(await fs.readdir(out),['runtime']);
  assert.deepEqual(await fs.readdir(path.join(out,'runtime')),['claude-host.mjs']);
  const text=await fs.readFile(result.file,'utf8');
  assert.ok(!/from\s+['"]\.\.?\//.test(text),'no relative imports are left');
  assert.ok(!text.includes(out.replaceAll('\\','/')),'no absolute build path is baked in');
  await assert.rejects(buildClaudeHost({}),TypeError);
});

test('llm prompt flattening: system/developer go to system; one user message is sent verbatim; non-text blocks are refused',()=>{
  assert.deepEqual(toPrompt({system:'S',messages:[{role:'developer',content:'D'},{role:'user',content:'Hello'}]},'complete'),{prompt:'Hello',system:'S\n\nD'});
  assert.equal(toPrompt({messages:[{role:'user',content:'a'},{role:'assistant',content:[{type:'text',text:'b'}]},{role:'user',content:'c'}]},'complete').prompt,'[user]\na\n\n[assistant]\nb\n\n[user]\nc');
  assert.throws(()=>toPrompt({messages:[{role:'user',content:[{type:'image'}]}]},'complete'),/image/);
  assert.throws(()=>toPrompt({messages:[]},'complete'),/沒有可送出/);
});

test('collectPromptSections keeps text sections and contexts, drops empty ones',()=>{
  assert.deepEqual(collectPromptSections([{name:'a',text:'A'},{name:'b',text:'  '},{name:'c'}],[{name:'x',text:'X'},{name:'y',text:''}]),[{id:'a',text:'A'},{id:'ctx:x',text:'X'}]);
});

test('approval service (pure): no agent or no channel means unavailable; abort means cancelled; secrets are redacted',async()=>{
  const sent=[];
  const agent=createClaudeBridgeAgent({root:{},callId:'c',args:{token:'TOP-SECRET-1',note:'n'}});
  const service=createClaudeApprovalService({requestHost:async(method,params)=>{sent.push({method,params});return {approved:true};}}).service;
  assert.equal(await service.request({}),'unavailable');
  assert.equal(await createClaudeApprovalService({}).service.request({agent}),'unavailable');
  assert.equal(await service.request({agent,toolName:'t',reason:'contains TOP-SECRET-1 here',signal:AbortSignal.abort()}),'cancelled');
  assert.equal(await service.request({agent,toolName:'t',reason:'contains TOP-SECRET-1 here',displayReason:{en:'English TOP-SECRET-1'}}),'allowed-once');
  assert.ok(!JSON.stringify(sent).includes('TOP-SECRET-1'));
  assert.equal(sent[0].method,'approval.request');
  assert.throws(()=>service.somethingElse(),/approval\.somethingElse/);
});

test('interception ask: the approval wait is not bounded by the 20 s policy signal (a person may take minutes)',async()=>{
  const {interceptPre}=await import('../lib/modules/claude/interception.mjs');
  const seen=[];
  const ctx={tools:{},waterfall:async()=>({kind:'ask',reason:'needs a yes'}),parallel:async()=>{},get:()=>({request:async input=>{seen.push(input);return 'allowed-once';}})};
  const answer=await interceptPre({ctx,scopeTarget:()=>({}),tool:'Write',input:{file_path:'a'}});
  assert.deepEqual(answer,{decision:'allow'});
  assert.equal(seen.length,1);
  assert.equal(seen[0].signal,undefined,'no AbortSignal.timeout(20000) on the approval request');
  assert.equal(seen[0].toolName,'Write');
});
