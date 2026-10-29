// Claude Code 對話轉給 DSH 插件：mod 回報的事情變成官方 session/event，主對話是一個 agent，followup 變成 prompt.submit 反向請求。
import test from 'node:test';
import assert from 'node:assert/strict';
import {makePlugin,spawnHost,toolHeader} from './claude-host-helpers.mjs';

const source=toolHeader+`export const name='syn-conversation';export const inject=['tools'];
export function apply(ctx){
  const seen=[],agents=[];
  ctx.on('session/event',(session,event)=>seen.push({session:session.header?.id??session.id,type:event.type,seq:event.seq,data:event.data}));
  ctx.on('agent/created',({agent})=>agents.push(agent));
  ctx.tools.register(tool('seen',async()=>({events:seen,agents:agents.map(a=>({id:a.id,status:a.status,lastReply:a.lastReply??null}))})));
  ctx.tools.register(tool('speak',async()=>{const agent=agents.find(a=>a.status==='idle');if(!agent)return {sent:false};agent.followup({role:'user',content:[{type:'text',text:'a thought of my own'}],source:{kind:'mate'}});return {sent:true};}));
}`;

const call=async(host,name)=>JSON.parse((await host.rpc('tools.call',{name,args:{},callId:`${name}-${Math.random()}`})).content[0].text);

test('the conversation reaches the plugin as official session/event rows, and the conversation is one agent',async t=>{
  const requests=[];
  const root=await makePlugin(t,source);
  const host=await spawnHost(t,root,{answer:async(method,params)=>{requests.push({method,params});return {queued:true};}});
  const ready=await host.ready();
  assert.equal(ready.metadata.listeners.sessionEvent,1,'the mod learns that the plugin follows the chat');
  assert.equal(ready.metadata.listeners.agentCreated,1);

  await host.rpc('session.event',{sessionId:'s-1',kind:'user',text:'hello there'});
  await host.rpc('session.event',{sessionId:'s-1',kind:'tool-call',callId:'c1',name:'Bash',input:{command:'ls'}});
  await host.rpc('session.event',{sessionId:'s-1',kind:'tool-result',callId:'c1',name:'Bash',text:'a.txt',isError:false});
  const busy=await call(host,'seen');
  assert.equal(busy.agents[0].status,'running','between turn/start and turn/end the conversation is busy');
  await host.rpc('session.event',{sessionId:'s-1',kind:'turn-end',answer:'all done',reason:'answer'});

  const {events,agents}=await call(host,'seen');
  assert.deepEqual(events.map(e=>e.type),['turn/start','user/message','tool/call','tool/result','assistant/message','turn/end']);
  assert.deepEqual(events.map(e=>e.seq),[0,1,2,3,4,5]);
  assert.ok(events.every(e=>e.session==='s-1'));
  const [start,user,toolCall,toolResult,assistant,end]=events;
  assert.deepEqual(start.data,{turn:1});
  assert.equal(user.data.role,'user');assert.deepEqual(user.data.content,[{type:'text',text:'hello there'}]);assert.deepEqual(user.data.source,{kind:'user'});
  assert.equal(toolCall.data.name,'Bash');assert.equal(toolCall.data.arguments,'{"command":"ls"}');assert.equal(toolCall.data.callId,'c1');
  assert.equal(toolResult.data.message.toolCallId,'c1');assert.equal(toolResult.data.message.content[0].text,'a.txt');
  assert.equal(assistant.data.message.role,'assistant');assert.equal(assistant.data.message.content[0].text,'all done');
  assert.deepEqual(end.data,{turn:1,reason:{kind:'completed'}});
  assert.deepEqual(agents,[{id:'claude-code-conversation',status:'idle',lastReply:'all done'}]);

  assert.deepEqual(await call(host,'speak'),{sent:true});
  const submit=await (async()=>{for(let i=0;i<50&&!requests.some(r=>r.method==='prompt.submit');i++)await new Promise(r=>setTimeout(r,20));return requests.find(r=>r.method==='prompt.submit');})();
  assert.ok(submit,'followup asks the mod to send a message');
  assert.deepEqual(submit.params,{text:'a thought of my own',source:{kind:'mate'}});

  await assert.rejects(host.rpc('session.event',{kind:'nonsense'}),/不認得的事件種類/);
});

test('a turn the person stopped or that failed ends with the matching DSH reason',async t=>{
  const root=await makePlugin(t,source);
  const host=await spawnHost(t,root,{answer:async()=>({})});
  await host.ready();
  await host.rpc('session.event',{kind:'user',text:'one'});
  await host.rpc('session.event',{kind:'turn-end',answer:'',reason:'aborted'});
  await host.rpc('session.event',{kind:'user',text:'two'});
  await host.rpc('session.event',{kind:'turn-end',answer:'',reason:'error'});
  const {events}=await call(host,'seen');
  const ends=events.filter(e=>e.type==='turn/end').map(e=>e.data);
  assert.deepEqual(ends.map(e=>[e.turn,e.reason.kind]),[[1,'aborted'],[2,'error']]);
  assert.ok(!events.some(e=>e.type==='assistant/message'),'no answer, no assistant message');
});

const readerSource=toolHeader+`export const name='syn-reader';export const inject=['tools','sessionQuery','agentDefaultModel'];
export function apply(ctx){
  ctx.tools.register(tool('history',async()=>{const [row]=await ctx.sessionQuery.listSessions();const s=await ctx.sessionQuery.readSession(row.header.id);return {id:row.header.id,types:s.events.map(e=>e.type),source:s.projection.source};}));
  ctx.tools.register(tool('other',async()=>{try{await ctx.sessionQuery.readSession('someone-else');return {read:true};}catch(e){return {code:e.code};}}));
  ctx.tools.register(tool('model',async()=>ctx.agentDefaultModel.currentSelection()));
}`;

test('sessionQuery reads this conversation only, and agentDefaultModel is the model the mod reported',async t=>{
  const root=await makePlugin(t,readerSource,{plan:{host:{services:['sessionQuery','agentDefaultModel']}}});
  const host=await spawnHost(t,root,{answer:async()=>({})});
  await host.ready();
  assert.deepEqual(await call(host,'model'),{provider:'anthropic',model:'claude'},'before the mod reports one');
  await host.rpc('session.event',{sessionId:'s-9',kind:'model',model:'claude-opus-5-5'});
  await host.rpc('session.event',{sessionId:'s-9',kind:'user',text:'hi'});
  await host.rpc('session.event',{sessionId:'s-9',kind:'turn-end',answer:'hello',reason:'answer'});
  assert.deepEqual(await call(host,'model'),{provider:'anthropic',model:'claude-opus-5-5'});
  assert.deepEqual(await call(host,'history'),{id:'s-9',types:['turn/start','user/message','assistant/message','turn/end'],source:'claude-code-conversation'});
  assert.deepEqual(await call(host,'other'),{code:'DSH_SESSION_SCOPE'});
});

test('an entry that declares no inject still gets the services static analysis found',async t=>{
  const noInject=toolHeader+`export const name='syn-no-inject';
export function apply(ctx){
  ctx.systemPrompt.section({name:'guide',order:1,text:'Be kind.'});
  ctx.tools.register(tool('ping',async()=>'pong'));
}`;
  const root=await makePlugin(t,noInject,{plan:{host:{services:['systemPrompt','tools']}}});
  const host=await spawnHost(t,root,{answer:async()=>({})});
  const ready=await host.ready();
  assert.ok(ready.tools.some(x=>x.name==='ping'));
  assert.ok(ready.promptSections.some(x=>x.text==='Be kind.'));
  assert.ok(ready.metadata.compat.some(x=>x.id==='inject-inferred'&&x.names.includes('systemPrompt')));
});
