import {guardService} from './common.mjs';

export const descriptor={
  id:'agentDefaultModel',displayName:'目前模型（Claude Code，只能讀）',services:['agentDefaultModel'],
  requires:{capabilities:[]},
  methods:{
    currentSelection:{support:'partial',reason:'回傳這個 Claude Code 工作階段的模型（provider 固定是 anthropic）；不能切換模型，也查不到 DSH 服務商的餘額或金鑰'},
  },
  requirements:['mod 在工作階段開始時回報模型（session.event 的 model）；還沒回報時 model 是 claude'],
};

export async function install({conversation}={}){
  const service=guardService({currentSelection:()=>conversation?.selection()??{provider:'anthropic',model:'claude'}},'agentDefaultModel','Claude Code 只提供目前模型，不能切換');
  return {services:{agentDefaultModel:service},diagnostics:[]};
}
