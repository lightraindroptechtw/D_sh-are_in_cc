import {bridgeAgentSecrets,disabledError,guardService,isDisabled,redactText} from './common.mjs';

export const descriptor={
  id:'approval',displayName:'核准模組（Claude Code）',services:['approval'],
  requires:{capabilities:[]},
  methods:{request:{support:'partial',reason:'每次呼叫送出 approval.request 給 mod，由使用者在 Claude Code 對話框明確同意才放行；不建立持續性的 DSH 核准政策'}},
  requirements:['只有 mod 回覆 {approved:true} 才放行','逾時、取消或沒有回覆一律視為未核准'],
};

/** The DSH ApprovalService.request contract: allowed-once | rejected | cancelled | unavailable. */
export function createClaudeApprovalService({requestHost}={}){
  const active=new Set();let disposed=false;
  return {
    service:guardService({async request(input={}){
      if(disposed||typeof requestHost!=='function'||!input.agent)return 'unavailable';
      if(input.signal?.aborted)return 'cancelled';
      const controller=new AbortController();active.add(controller);
      const abort=()=>controller.abort();input.signal?.addEventListener('abort',abort,{once:true});
      try{
        const secrets=bridgeAgentSecrets(input.agent);
        const english=typeof input.displayReason==='object'&&input.displayReason?input.displayReason.en:input.displayReason;
        const response=await requestHost('approval.request',{
          toolName:String(input.toolName??'unknown'),callId:typeof input.callId==='string'?input.callId:undefined,
          reason:redactText(english??input.reason??'This tool asks for a single approval.',secrets).slice(0,600),
          argumentSummary:input.agent.bridgeArgumentSummary??{},
        },{signal:controller.signal,requestId:input.agent.bridgeRequestId});
        if(controller.signal.aborted)return 'cancelled';
        return response?.approved===true?'allowed-once':'rejected';
      }catch(error){
        if(controller.signal.aborted)return 'cancelled';
        if(isDisabled(error))throw disabledError('approval','request',error,'the approval prompt','DSH_APPROVAL_DISABLED');
        return error?.code==='REVERSE_REQUEST_TIMEOUT'?'cancelled':'unavailable';
      }finally{input.signal?.removeEventListener('abort',abort);active.delete(controller);}
    }},'approval'),
    async dispose(){disposed=true;for(const controller of active)controller.abort();active.clear();},
  };
}
export async function install({requestHost}={}){
  const runtime=createClaudeApprovalService({requestHost});
  return {services:{approval:runtime.service},dispose:()=>runtime.dispose(),diagnostics:[{module:'approval',status:'partial',level:'info',reason:'核准經 approval.request 交給 Claude Code 使用者；沒有 DSH 原生 Agent 生命週期。'}]};
}
