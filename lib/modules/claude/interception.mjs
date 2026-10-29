import {randomUUID} from 'node:crypto';
import {createClaudeBridgeAgent} from './common.mjs';

export const descriptor={
  id:'interception',displayName:'工具攔截模組（Claude Code）',services:[],
  requires:{capabilities:[]},
  methods:{
    'tools/pre-execute':{support:'partial',reason:'Claude Code 要呼叫工具前，mod 問宿主；deny 擋下，ask 轉成 approval.request，allow 放行；不能改寫輸入'},
    'tools/post-execute':{support:'partial',reason:'工具完成後 mod 問宿主；block 會把結果換成錯誤，accept 帶內容時替換結果；已發生的副作用無法撤銷'},
    'tools/result':{support:'partial',reason:'觀察事件，標明來源是 Claude Code'},
  },
  requirements:['宿主必須正在執行；DSH 規則是用 DSH 工具名稱撰寫的，Claude Code 內建工具名稱不同時規則可能不會命中（假說，未對照過各插件）'],
};
export async function install(){return {services:{},diagnostics:[]};}

const text=value=>typeof value==='string'?value:'';
const reasonOf=decision=>text(decision?.reason)||text(decision?.message)||'DSH 插件攔截規則拒絕這次工具操作';
const blocks=value=>typeof value==='string'?[{type:'text',text:value}]:Array.isArray(value)?value:[{type:'text',text:JSON.stringify(value??null)}];
const textBlocks=content=>(Array.isArray(content)?content:[]).filter(b=>b?.type==='text').map(b=>b.text).join('\n');

function execFor({tool,callId,input,agent,origin,sessionId}){
  return {name:tool,callId,arguments:input??{},agent,signal:AbortSignal.timeout(20000),origin,claudeSessionId:sessionId};
}

/** Official `tools/pre-execute` waterfall for a Claude Code tool call. */
export async function interceptPre({ctx,scopeTarget,approval,tool,input,callId=randomUUID(),sessionId}){
  const agent=createClaudeBridgeAgent({root:ctx,callId,requestId:null,args:input??{}});
  const exec=execFor({tool,callId,input,agent,origin:'claude-code',sessionId});
  const carrier=scopeTarget(ctx.tools,agent);
  let gate=await ctx.waterfall(carrier,'tools/pre-execute',exec,()=>Promise.resolve({kind:'allow'}));
  if(gate.kind==='ask'){
    const service=approval??ctx.get('approval');
    // No 20 s signal here: that one bounds the policy functions, while a person may take minutes to answer the dialog (the reverse channel has its own 600 s limit).
    const outcome=service?await service.request({agent,toolName:tool,callId,reason:gate.reason,displayReason:gate.displayReason}):'unavailable';
    gate=outcome==='allowed-once'?{kind:'allow'}:{kind:'deny',reason:outcome==='rejected'?`the user rejected tool "${tool}"`:outcome==='cancelled'?`approval for tool "${tool}" was cancelled`:`tool "${tool}" requires approval, but no approval channel is available`};
  }
  if(gate.kind==='allow')return {decision:'allow'};
  if(gate.kind==='deny')return {decision:'deny',reason:reasonOf(gate)};
  if(gate.kind==='cancel')return {decision:'deny',reason:'DSH 插件取消了這次工具操作'};
  return {decision:'deny',reason:'DSH 前置規則回傳未知結果，已拒絕操作'};
}

/** Official `tools/post-execute` waterfall + `tools/result` for a finished Claude Code tool call. */
export async function interceptPost({ctx,scopeTarget,tool,input,result,callId=randomUUID(),sessionId}){
  const agent=createClaudeBridgeAgent({root:ctx,callId,requestId:null,args:input??{}});
  const exec=execFor({tool,callId,input,agent,origin:'claude-code',sessionId});
  const carrier=scopeTarget(ctx.tools,agent);
  const content=Array.isArray(result?.content)?result.content:blocks(result);
  const shaped={content,value:result?.value??result??null,isError:Boolean(result?.isError),origin:'claude-code'};
  const decision=await ctx.waterfall(carrier,'tools/post-execute',exec,shaped,()=>Promise.resolve({kind:'accept'}));
  await ctx.parallel(carrier,'tools/result',exec,shaped);
  if(decision.kind==='block')return {result:{content:[{type:'text',text:textBlocks(decision.feedback)||reasonOf(decision)}],isError:true}};
  if(decision.kind!=='accept')return {result:{content:[{type:'text',text:'DSH 後置規則回傳未知結果，已隱藏工具結果'}],isError:true}};
  if(Array.isArray(decision.content))return {result:{content:decision.content.filter(b=>b?.type==='text').map(b=>({type:'text',text:b.text})),isError:shaped.isError}};
  if(Object.hasOwn(decision,'value'))return {result:{content:[{type:'text',text:typeof decision.value==='string'?decision.value:JSON.stringify(decision.value)}],isError:shaped.isError}};
  return {};
}
