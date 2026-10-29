import test from 'node:test';
import assert from 'node:assert/strict';
import {makePlugin,spawnHost,toolHeader} from './claude-host-helpers.mjs';
import {createReverseChannel} from '../lib/claude-host/reverse.mjs';

const plan={host:{services:['llm','agents','approval']}};
const source=toolHeader+`export const name='syn-reverse';export const inject=['tools','llm','agents'];
export function apply(ctx){
  ctx.on('tools/pre-execute',(exec,next)=>exec.name==='danger_tool'||exec.name==='Write'?{kind:'ask',reason:'Synthetic approval for '+exec.name}:exec.name==='Bash'?{kind:'deny',reason:'no bash for you'}:next());
  ctx.on('tools/post-execute',(exec,result,next)=>exec.name==='Read'?{kind:'block',feedback:[{type:'text',text:'blocked by policy'}]}:exec.name==='Grep'?{kind:'accept',content:[{type:'text',text:'rewritten by policy'}]}:next());
  ctx.tools.register(tool('danger_tool',async a=>({ran:true}),{parameters:{token:{type:'string'},note:{type:'string'}}}));
  ctx.tools.register(tool('ask_model',async()=>{const r=await ctx.llm.complete({system:'Be brief',messages:[{role:'user',content:'Ping'}]});return {text:r.text};}));
  ctx.tools.register(tool('stream_model',async()=>{let text='';for await(const chunk of ctx.llm.stream({messages:[{role:'user',content:[{type:'text',text:'Stream'}]}]}))if(chunk.type==='text-delta')text+=chunk.text;return {text};}));
  ctx.tools.register(tool('model_with_tools',async()=>ctx.llm.complete({messages:[{role:'user',content:'x'}],tools:[{name:'t',description:'d',parameters:{}}]})));
  ctx.tools.register(tool('llm_unmapped',async()=>ctx.llm.registerAdapter(['p'],{})));
  ctx.tools.register(tool('spawn_agent',async()=>{const h=await ctx.agents.create({sessionId:'s1',agentOptions:{subagentType:'general-purpose'}});try{h.agent.send('Do the thing');await h.agent.whenIdle();return {reply:h.agent.lastReply};}finally{await h.dispose();}}));
  ctx.tools.register(tool('notify_tool',async()=>{ctx.emit('bridge/notify',{level:'warning',text:'heads up from the plugin'});return 'sent';}));
}`;

async function start(t,answer,settings={},env={}){
  const root=await makePlugin(t,source,{plan,...settings});
  const host=await spawnHost(t,root,{answer,env});
  await host.ready();return host;
}
const call=(host,name,args={})=>host.rpc('tools.call',{name,args,callId:`${name}-${Math.random()}`});
const text=result=>result.content.map(x=>x.text).join('\n');

test('approval.request: only an explicit approved:true lets the tool run',async t=>{
  const seen=[];let verdict={approved:true};
  const host=await start(t,async(method,params)=>{seen.push({method,params});if(verdict instanceof Error)throw verdict;return verdict;});
  const yes=await call(host,'danger_tool',{token:'SUPER-SECRET-VALUE',note:'plain note'});
  assert.equal(yes.isError,false);assert.deepEqual(JSON.parse(yes.content[0].text),{ran:true});
  const request=seen.find(x=>x.method==='approval.request');
  assert.ok(request);assert.equal(request.params.toolName,'danger_tool');assert.match(request.params.reason,/Synthetic approval for danger_tool/);
  const wire=JSON.stringify(request.params);
  assert.ok(!wire.includes('SUPER-SECRET-VALUE'),'secret values are never sent');assert.ok(!wire.includes('plain note'),'argument values are summarized, not copied');
  assert.match(wire,/\[redacted\]/);
  for(const answer of [{approved:false},{},null,{approved:'true'},{approved:1}]){
    verdict=answer;const denied=await call(host,'danger_tool');
    assert.equal(denied.isError,true,JSON.stringify(answer));assert.match(text(denied),/rejected/);
  }
});

test('approval.request with a DISABLED reply surfaces an explicit DSH error',async t=>{
  const host=await start(t,async()=>{throw Object.assign(new Error('approval prompts are turned off'),{code:'DISABLED'});});
  const result=await call(host,'danger_tool');
  assert.equal(result.isError,true);assert.match(text(result),/DSH_APPROVAL_DISABLED|approval prompts are turned off/);
});

test('model.complete: prompt and system reach the mod; the reply text returns to the plugin (complete and stream)',async t=>{
  const seen=[];
  const host=await start(t,async(method,params)=>{seen.push({method,params});return {text:params.prompt==='Ping'?'Pong':'Streamed:'+params.prompt};});
  const direct=await call(host,'ask_model');
  assert.equal(direct.isError,false);assert.deepEqual(JSON.parse(direct.content[0].text),{text:'Pong'});
  assert.deepEqual(seen[0],{method:'model.complete',params:{prompt:'Ping',system:'Be brief'}});
  const streamed=await call(host,'stream_model');
  assert.deepEqual(JSON.parse(streamed.content[0].text),{text:'Streamed:Stream'});
});

test('model.complete DISABLED is an explicit DSH error naming allowModelCalls, never a fake answer',async t=>{
  const host=await start(t,async()=>{throw Object.assign(new Error('model calls are off'),{code:'DISABLED'});});
  const result=await call(host,'ask_model');
  assert.equal(result.isError,true);assert.match(text(result),/allowModelCalls/);assert.match(text(result),/model calls are off/);
});

test('llm features that Claude Code cannot provide fail loudly',async t=>{
  const host=await start(t,async()=>({text:'unused'}));
  const withTools=await call(host,'model_with_tools');
  assert.equal(withTools.isError,true);assert.match(text(withTools),/工具呼叫/);
  const adapter=await call(host,'llm_unmapped');
  assert.equal(adapter.isError,true);assert.match(text(adapter),/llm\.registerAdapter/);
});

test('agent.spawn: a sub-agent request goes to the mod and its text comes back; DISABLED is explicit',async t=>{
  let enabled=true;const seen=[];
  const host=await start(t,async(method,params)=>{seen.push({method,params});if(!enabled)throw Object.assign(new Error('sub-agents are off'),{code:'DISABLED'});return {text:'done by sub-agent'};});
  const ok=await call(host,'spawn_agent');
  assert.equal(ok.isError,false);assert.deepEqual(JSON.parse(ok.content[0].text),{reply:'done by sub-agent'});
  assert.equal(seen[0].method,'agent.spawn');assert.match(seen[0].params.prompt,/Do the thing/);assert.equal(seen[0].params.subagentType,'general-purpose');
  enabled=false;
  const off=await call(host,'spawn_agent');
  assert.equal(off.isError,true);assert.match(text(off),/allowAgents/);
});

test('ui.notify: a plugin notification becomes a request line',async t=>{
  const seen=[];
  const host=await start(t,async(method,params)=>{seen.push({method,params});return {};});
  assert.equal((await call(host,'notify_tool')).isError,false);
  const line=await host.next(l=>l.type==='request'&&l.method==='ui.notify');
  assert.deepEqual(line.params,{level:'warning',text:'heads up from the plugin'});
});

test('a mod that never answers is a timeout error, and a late reply is ignored',async t=>{
  const host=await start(t,async()=>undefined,{claudeHost:{reverseTimeoutMs:{'model.complete':400}}});
  const result=await call(host,'ask_model');
  assert.equal(result.isError,true);assert.match(text(result),/did not answer model\.complete/);
  const line=host.lines.find(l=>l.type==='request'&&l.method==='model.complete');
  assert.deepEqual(await host.rpc('reply',{id:line.id,result:{text:'too late'}}),{});
  assert.deepEqual(await host.rpc('reply',{id:'r999',error:{code:'X',message:'unknown id'}}),{});
  await assert.rejects(host.rpc('reply',{}),{code:'INVALID_PARAMS'});
});

test('interception: ready advertises it; pre deny/ask/allow and post block/rewrite follow the plugin policies',async t=>{
  let approved=true;const asked=[];
  // The person turned on allowInterception (the mod passes DSH_CLAUDE_ALLOW_INTERCEPTION=1).
  const host=await start(t,async(method,params)=>{asked.push({method,params});return {approved};},{},{DSH_CLAUDE_ALLOW_INTERCEPTION:'1'});
  const ready=host.lines.find(l=>l.type==='ready');
  assert.equal(ready.interception,true);
  assert.deepEqual(await host.rpc('interception.pre',{tool:'Bash',input:{command:'ls'}}),{decision:'deny',reason:'no bash for you'});
  assert.deepEqual(await host.rpc('interception.pre',{tool:'Glob',input:{}}),{decision:'allow'});
  assert.deepEqual(await host.rpc('interception.pre',{tool:'Write',input:{file_path:'a.txt',content:'SECRET-BODY'}}),{decision:'allow'});
  const prompt=asked.find(x=>x.method==='approval.request');
  assert.ok(prompt);assert.equal(prompt.params.toolName,'Write');assert.ok(!JSON.stringify(prompt.params).includes('SECRET-BODY'));
  approved=false;
  const refused=await host.rpc('interception.pre',{tool:'Write',input:{}});
  assert.equal(refused.decision,'deny');assert.match(refused.reason,/rejected/);
  const blocked=await host.rpc('interception.post',{tool:'Read',input:{},result:{content:[{type:'text',text:'file body'}],isError:false}});
  assert.deepEqual(blocked,{result:{content:[{type:'text',text:'blocked by policy'}],isError:true}});
  const rewritten=await host.rpc('interception.post',{tool:'Grep',input:{},result:{content:[{type:'text',text:'matches'}]}});
  assert.deepEqual(rewritten,{result:{content:[{type:'text',text:'rewritten by policy'}],isError:false}});
  assert.deepEqual(await host.rpc('interception.post',{tool:'Glob',input:{},result:{content:[{type:'text',text:'x'}]}}),{});
});

test('interception skips the plugin\'s own tools so policies do not run twice',async t=>{
  const host=await start(t,async()=>({approved:true}),{claudeHost:{pluginName:'syn-reverse'}});
  assert.deepEqual(await host.rpc('interception.pre',{tool:'mcp__syn-reverse__danger_tool',input:{}}),{decision:'allow'});
  assert.deepEqual(host.lines.filter(l=>l.type==='request'&&l.method==='approval.request'),[]);
});

test('interception stays off, and costs nothing, for a plugin without those listeners',async t=>{
  const root=await makePlugin(t,toolHeader+`export const inject=['tools'];export function apply(ctx){ctx.tools.register(tool('plain',async()=>1));}`);
  const host=await spawnHost(t,root);
  assert.equal((await host.ready()).interception,false);
  assert.deepEqual(await host.rpc('interception.pre',{tool:'Bash',input:{}}),{decision:'allow'});
  assert.deepEqual(await host.rpc('interception.post',{tool:'Bash',input:{},result:{content:[]}}),{});
});

test('reverse channel (pure): only whitelisted methods, cancel, timeout, shutdown',async()=>{
  const out=[];const channel=createReverseChannel({emit:line=>out.push(line),timeouts:{'agent.spawn':50}});
  await assert.rejects(channel.request('fs.delete',{}),{code:'REVERSE_METHOD_UNSUPPORTED'});
  assert.equal(out.length,0,'a refused method never reaches the mod');
  const controller=new AbortController();const canceled=channel.request('model.complete',{prompt:'x'},{signal:controller.signal});
  controller.abort();await assert.rejects(canceled,{code:'HOST_CANCELED'});
  await assert.rejects(channel.request('agent.spawn',{prompt:'x'}),{code:'REVERSE_REQUEST_TIMEOUT'});
  const answered=channel.request('approval.request',{});
  const id=out.at(-1).id;assert.equal(channel.reply({id,result:{approved:true}}).settled,true);assert.deepEqual(await answered,{approved:true});
  assert.equal(channel.reply({id,result:{}}).settled,false,'a second reply to the same id is ignored');
  const rejected=channel.request('ui.notify',{});channel.reply({id:out.at(-1).id,error:{code:'DISABLED',message:'off'}});
  await assert.rejects(rejected,{code:'DISABLED',message:'off'});
  const pending=channel.request('model.complete',{});channel.close();await assert.rejects(pending,{code:'DISPOSED'});
  await assert.rejects(channel.request('model.complete',{}),{code:'DISPOSED'});
});
