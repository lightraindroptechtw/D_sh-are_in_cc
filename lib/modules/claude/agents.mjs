import {randomUUID} from 'node:crypto';
import {claudeError,disabledError,guardService,isDisabled} from './common.mjs';

export const descriptor={
  id:'agents',displayName:'代理模組（Claude Code）',services:['agents'],
  requires:{capabilities:[]},
  methods:{
    create:{support:'partial',reason:'建立的是代理的外殼；每次 send 經 agent.spawn 請 Claude Code 啟動一個一次性子代理。預設關閉，使用者需開啟 allowAgents'},
    'agent.send':{support:'partial',reason:'只支援文字；每次 send 是新的子代理，先前往返的文字會附在提示詞裡，不是同一個長期對話'},
    'agent.whenIdle':{support:'partial',reason:'等待目前的子代理結束'},
    'agent.cancel':{support:'partial',reason:'中斷等待；已經啟動的子代理是否停止由 Claude Code 決定'},
    setup:{support:'partial',reason:'只收集靜態的 systemPrompt.section 文字，併入子代理提示詞前端；工具與範圍變更會明確失敗'},
    currentInitiator:{support:'partial',reason:'永遠回傳 undefined（沒有發起代理）；requireInitiator 明確失敗；withInitiator、withoutInitiator 直接執行操作'},
    resume:{support:'unsupported',reason:'Claude Code 子代理無法用 DSH 對話編號續接'},
    'agent/pre-step':{support:'unsupported',reason:'沒有 DSH 迴圈步驟'},
  },
  requirements:['userConfig.allowAgents=true，否則 agent.spawn 回傳明確錯誤'],
};

const textInput=message=>{
  if(typeof message==='string')return message;
  if(!Array.isArray(message?.content)||message.content.some(x=>x.type!=='text'||typeof x.text!=='string'))throw claudeError('agents','agent.send','只支援文字訊息');
  return message.content.map(x=>x.text).join('\n');
};
const replyText=reply=>typeof reply==='string'?reply:typeof reply?.text==='string'?reply.text:typeof reply?.result==='string'?reply.result:null;

export function createClaudeAgentService({requestHost,emit=()=>{}}={}){
  const live=new Map();let closed=false;
  const publish=(event,...args)=>{try{const r=emit(event,...args);r?.catch?.(()=>{});}catch{}};
  async function create(input={}){
    if(closed)throw claudeError('agents','create','模組已關閉');
    if(typeof requestHost!=='function')throw claudeError('agents','create','沒有 Claude Code 的反向請求通道');
    if(input.signal?.aborted)throw claudeError('agents','create','建立已取消','ABORT_ERR');
    if(input.seed!==undefined||input.parentAgent!==undefined)throw claudeError('agents','create','DSH 種子與分支沒有對應');
    const id=input.sessionId??randomUUID();
    if(typeof id!=='string'||!id||live.has(id))throw claudeError('agents','create','對話編號必須是尚未使用的非空字串');
    const sections=[];let open=true;
    const reject=name=>{throw claudeError('agents','setup',`不支援的 setup 操作：${name}`);};
    const prompt=new Proxy({section(section){
      if(!open)return reject('late prompt mutation');
      if(typeof section?.text!=='string'||section.complete)return reject('dynamic or complete prompt section');
      sections.push({...section});return ()=>{const i=sections.findIndex(x=>x.name===section.name);if(i>=0)sections.splice(i,1);};
    }},{get(target,key){if(key==='then'||typeof key==='symbol')return undefined;return key in target?target[key]:(...args)=>reject(`systemPrompt.${String(key)}`);}});
    const setupContext=new Proxy({systemPrompt:prompt,get(name){return name==='systemPrompt'?prompt:reject(`get(${name})`);}},{get(target,key){if(key==='then'||typeof key==='symbol')return undefined;return key in target?target[key]:reject(String(key));},set(){return reject('context mutation');}});
    if(input.setup){const result=await input.setup(setupContext,Object.freeze({id,options:Object.freeze({...input.agentOptions})}));if(result!==undefined)reject('setup commit callbacks');}
    open=false;
    const header=sections.sort((a,b)=>(a.order??0)-(b.order??0)||String(a.name).localeCompare(String(b.name))).map(s=>s.text).join('\n\n');
    const subagentType=input.agentOptions?.subagentType??input.subagentType??input.meta?.subagentType;
    const history=[];let active=null,disposed=false;
    const session=guardService(Object.freeze({id,projection:Object.freeze({source:'claude-agent-spawn',replayValidated:false})}),'sessions');
    const run=async text=>{
      const controller=new AbortController();
      const transcript=history.map(h=>`[user]\n${h.user}\n\n[assistant]\n${h.assistant}`).join('\n\n');
      const body=[header,transcript&&`Earlier exchange:\n${transcript}`,`Task:\n${text}`].filter(Boolean).join('\n\n');
      active={controller};
      try{
        const reply=await requestHost('agent.spawn',{prompt:body,...(subagentType?{subagentType:String(subagentType)}:{})},{signal:controller.signal});
        const answer=replyText(reply);
        if(answer===null)throw claudeError('agents','agent.send','agent.spawn 的回覆沒有文字','DSH_AGENT_REPLY_INVALID');
        history.push({user:text,assistant:answer});publish('agent/status',{agent,status:'idle'});return answer;
      }catch(error){
        if(isDisabled(error))throw disabledError('agents','agent.send',error,'allowAgents','DSH_AGENTS_DISABLED');
        throw error;
      }finally{active=null;}
    };
    let lastTask=Promise.resolve();
    const send=message=>{
      if(disposed)throw claudeError('agents','agent.send','代理已釋放');
      if(active)throw claudeError('agents','agent.send','上一個子代理還沒結束；Claude Code 子代理不支援排隊或中途插話');
      const text=textInput(message);publish('agent/status',{agent,status:'running'});
      lastTask=run(text);lastTask.catch(()=>{});
    };
    const agent=guardService({id,session,options:Object.freeze({...input.agentOptions}),ctx:setupContext,get status(){return active?'running':'idle';},get lastReply(){return history.at(-1)?.assistant;},
      send,followup:send,
      whenIdle:async()=>{await lastTask;},cancel:()=>{active?.controller.abort();},
    },'agents','這個代理方法沒有對應到 Claude Code 子代理');
    const handle={agent,async dispose(){if(disposed)return;disposed=true;active?.controller.abort();live.delete(id);publish('agent/disposed',{agent});}};
    live.set(id,handle);publish('agent/created',{agent,source:'startup'});
    return handle;
  }
  // Initiator scope: no DSH agent loop runs here, so there is never an initiating Agent. These answer truthfully
  // (currentInitiator -> undefined, as DSH does outside an initiator boundary) instead of throwing UNSUPPORTED.
  const initiator={
    currentInitiator:()=>undefined,
    requireInitiator:()=>{throw claudeError('agents','requireInitiator','Claude Code 宿主沒有 DSH 代理迴圈，這裡不會有發起代理','DSH_NO_INITIATOR');},
    withInitiator:(_agent,operation)=>operation(),
    withoutInitiator:operation=>operation(),
  };
  return {service:guardService({create,get:id=>live.get(id)?.agent,list:()=>[...live.values()].map(h=>h.agent),roots:()=>[...live.values()].map(h=>h.agent),...initiator},'agents','這個 agents 方法沒有對應到 Claude Code'),async dispose(){closed=true;await Promise.all([...live.values()].map(h=>h.dispose()));}};
}
export async function install({requestHost,emit}={}){
  const runtime=createClaudeAgentService({requestHost,emit});
  return {services:{agents:runtime.service},dispose:()=>runtime.dispose(),diagnostics:[{module:'agents',level:'warning',reason:'子代理經 agent.spawn 交給 Claude Code；預設關閉，沒有 DSH 原生 Agent 迴圈，也沒有實際測過子代理輸出。'}]};
}
