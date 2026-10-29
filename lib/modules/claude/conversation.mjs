import {randomUUID} from 'node:crypto';
import {claudeError,guardService} from './common.mjs';

/** The Claude Code conversation as DSH sees its own chat: the mod reports what happened (`session.event`),
 * this file turns it into official `session/event` rows ({ seq, time, type, data }) and raises them on the
 * plugin's context, so a plugin that follows the chat (`ctx.on('session/event')`) works unchanged.
 * It also stands for the conversation as one live agent (`agent/created`): `followup` asks the mod to send
 * a message of its own turn (`prompt.submit`), which the person turns on with allowFollowups.
 * What it has seen is also the read-only `sessionQuery` (this conversation since the plugin started), and the
 * model the mod reports is `agentDefaultModel.currentSelection()`. */

const TEXT_MAX=20000; // one message or tool result handed to the plugin
const LOG_MAX=2000; // rows kept for sessionQuery.readSession; older ones are dropped
const clip=text=>{const value=typeof text==='string'?text:'';return value.length>TEXT_MAX?`${value.slice(0,TEXT_MAX)}…`:value;};
const textBlocks=text=>[{type:'text',text:clip(text)}];
const TURN_END={answer:'completed',aborted:'aborted',refusal:'blocked',error:'error'};

const textOf=message=>{
  if(typeof message==='string')return message;
  const content=message?.content;
  if(typeof content==='string')return content;
  if(!Array.isArray(content))throw claudeError('conversation','agent.followup','只支援文字訊息');
  return content.filter(block=>block?.type==='text'&&typeof block.text==='string').map(block=>block.text).join('\n');
};

export function createConversationBridge({emit,requestHost}={}){
  const publish=(name,...args)=>{try{const r=emit?.(name,...args);r?.catch?.(()=>{});}catch{}};
  let sessionId='claude-code',seq=0,turn=0,open=false,announced=false,lastReply,model='',dropped=0;
  const createdAt=Date.now(),log=[];
  const idleWaiters=[];
  const header={get id(){return sessionId;}};
  const session=guardService({get id(){return sessionId;},header,get seq(){return seq;},projection:Object.freeze({source:'claude-code-conversation',replayValidated:false})},'sessions','Claude Code 對話只轉送即時事件，沒有可讀寫的 DSH 對話紀錄');
  const row=(type,data)=>{
    const event={seq:seq++,time:Date.now(),type,data};
    log.push(event);if(log.length>LOG_MAX){log.shift();dropped+=1;}
    publish('session/event',session,event);return event;
  };
  const setStatus=status=>{publish('agent/status',{agent,status});if(status==='idle')for(const resolve of idleWaiters.splice(0))resolve();};
  const startTurn=()=>{if(open)return;open=true;turn+=1;row('turn/start',{turn});setStatus('running');};
  const endTurn=reason=>{if(!open)return;open=false;row('turn/end',{turn,reason});setStatus('idle');};

  const followup=message=>{
    const text=textOf(message);
    if(!text.trim())throw claudeError('conversation','agent.followup','訊息是空的');
    if(typeof requestHost!=='function')throw claudeError('conversation','agent.followup','沒有 Claude Code 的反向請求通道');
    const source=message&&typeof message==='object'&&message.source&&typeof message.source==='object'?message.source:undefined;
    // DSH's followup returns nothing; a refusal (allowFollowups off) is told to the person by the mod.
    requestHost('prompt.submit',{text:clip(text),...(source?{source}:{})}).catch(()=>{});
  };
  const agent=guardService({
    id:'claude-code-conversation',session,options:Object.freeze({}),
    get status(){return open?'running':'idle';},get lastReply(){return lastReply;},
    followup,send:followup,
    whenIdle:()=>open?new Promise(resolve=>idleWaiters.push(resolve)):Promise.resolve(),
    cancel:()=>{throw claudeError('conversation','agent.cancel','插件不能中斷 Claude Code 的回合');},
  },'agents','Claude Code 的主對話只對應 followup、send、whenIdle 與狀態');

  /** One fact from the mod. kind: user | tool-call | tool-result | turn-end. */
  function event(params={}){
    if(typeof params.sessionId==='string'&&params.sessionId)sessionId=params.sessionId.slice(0,200);
    const step=0;
    switch(params.kind){
      case 'model':{
        if(typeof params.model==='string')model=params.model.slice(0,200);
        return {turn};
      }
      case 'user':{
        startTurn();
        const source=params.source&&typeof params.source==='object'?params.source:{kind:'user'};
        row('user/message',{id:randomUUID(),role:'user',content:textBlocks(params.text),source});
        return {turn};
      }
      case 'tool-call':{
        startTurn();
        const name=String(params.name??'');
        let args='{}';try{args=JSON.stringify(params.input??{})??'{}';}catch{}
        row('tool/call',{turn,step,callId:String(params.callId??randomUUID()),name,arguments:clip(args)});
        return {turn};
      }
      case 'tool-result':{
        startTurn();
        const isError=params.isError===true;
        row('tool/result',{turn,step,message:{id:randomUUID(),role:'tool',source:{kind:'tool',name:String(params.name??'')},toolCallId:String(params.callId??''),content:textBlocks(params.text),...(isError?{isError:true}:{})}});
        return {turn};
      }
      case 'turn-end':{
        startTurn();
        const answer=typeof params.answer==='string'?params.answer:'';
        if(typeof params.model==='string'&&params.model)model=params.model.slice(0,200);
        if(answer){
          lastReply=answer;
          row('assistant/message',{turn,step,message:{id:randomUUID(),role:'assistant',source:{kind:'model',provider:'anthropic',model:model||'claude'},content:textBlocks(answer)},stream:[]});
        }
        const kind=TURN_END[params.reason]??'completed';
        endTurn(kind==='error'?{kind,error:{code:'CLAUDE_TURN_FAILED',message:'Claude Code 回合出錯'}}:{kind});
        return {turn};
      }
      default:throw claudeError('conversation','event',`不認得的事件種類：${String(params.kind)}`,'INVALID_PARAMS');
    }
  }
  /** Raised once the plugin is applied, so its `agent/created` listener sees the conversation. */
  function announce(){if(announced)return;announced=true;publish('agent/created',{agent,source:'startup'});}
  function dispose(){if(!announced)return;announced=false;publish('agent/disposed',{agent});for(const resolve of idleWaiters.splice(0))resolve();}
  const header4=()=>({version:4,id:sessionId,createdAt,isSeeded:false});
  const query={
    capabilities:{readSession:true,listSessions:'current-conversation-only',searchSessions:false,replayValidated:false,modelCalls:0},
    async listSessions(){return [{header:header4(),live:true,persisted:false}];},
    async readSession(id){
      if(id!==sessionId)throw claudeError('sessionQuery','readSession','只能讀目前這個 Claude Code 對話','DSH_SESSION_SCOPE');
      const notes=['只有插件啟動之後、使用者允許（插件選項 shareConversation）時轉來的對話；更早的內容不在這裡。','Presentation projection only; DSH replay validation was not performed.'];
      if(dropped)notes.push(`最早的 ${dropped} 筆事件已經捨棄（最多保留 ${LOG_MAX} 筆）。`);
      return {session:header4(),inheritedEventCount:0,events:structuredClone(log),projection:{source:'claude-code-conversation',schemaVersion:1,replayValidated:false,atomic:false,notes}};
    },
    async close(){},
  };
  /** agentDefaultModel.currentSelection(): the model of this Claude Code session, as the mod last reported it. */
  const selection=()=>({provider:'anthropic',model:model||'claude'});
  return {event,announce,dispose,agent,session,query,selection};
}
