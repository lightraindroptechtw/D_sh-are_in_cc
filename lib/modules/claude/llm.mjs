import {claudeError,disabledError,guardService,isDisabled} from './common.mjs';

export const descriptor={
  id:'llm',displayName:'模型呼叫模組（Claude Code）',services:['llm'],
  requires:{capabilities:[]},
  methods:{
    complete:{support:'partial',reason:'單次文字補全，經 model.complete 交給 Claude Code；預設關閉，使用者需開啟 allowModelCalls'},
    stream:{support:'partial',reason:'以單次 model.complete 的結果包成一次性串流；不支援工具呼叫、圖片與檔案區塊'},
    listProviders:{support:'partial',reason:'只有一個供應商 claude-code'},listModels:{support:'partial',reason:'不列舉模型；由 Claude Code 決定'},
    resolveModelInfo:{support:'unsupported',reason:'Claude Code 不公開模型的上下文與推理規格；呼叫時丟 DSH_MODULE_UNSUPPORTED（dsh-vision-fallback 用它判斷圖片能力）'},
    registerAdapter:{support:'unsupported',reason:'不可替換模型供應商'},prepareCall:{support:'unsupported',reason:'沒有 DSH 供應商路由'},
  },
  requirements:['userConfig.allowModelCalls=true，否則每次呼叫回傳明確錯誤'],
};
const PROVIDER='claude-code';

function textOf(content,method){
  if(typeof content==='string')return content;
  if(!Array.isArray(content))throw claudeError('llm',method,'訊息內容必須是文字或文字區塊');
  return content.map(block=>{
    if(block?.type!=='text'||typeof block.text!=='string')throw claudeError('llm',method,`不支援 ${block?.type??'未知'} 區塊；只能傳遞文字`);
    return block.text;
  }).join('\n');
}
/** Flatten a DSH request into the prompt/system pair that $.model.complete accepts. */
export function toPrompt(options,method){
  if(Array.isArray(options.tools)&&options.tools.length)throw claudeError('llm',method,'model.complete 不支援工具呼叫；請不要傳入 tools');
  const messages=Array.isArray(options.messages)?options.messages:[];
  const systems=[typeof options.system==='string'?options.system:'',...messages.filter(m=>m.role==='system'||m.role==='developer').map(m=>textOf(m.content,method))].filter(Boolean);
  const turns=messages.filter(m=>m.role!=='system'&&m.role!=='developer');
  if(!turns.length)throw claudeError('llm',method,'沒有可送出的使用者訊息');
  const prompt=turns.length===1&&turns[0].role==='user'?textOf(turns[0].content,method):turns.map(m=>`[${m.role}]\n${textOf(m.content,method)}`).join('\n\n');
  return {prompt,system:systems.length?systems.join('\n\n'):undefined};
}
const replyText=reply=>typeof reply==='string'?reply:typeof reply?.text==='string'?reply.text:Array.isArray(reply?.content)?reply.content.filter(b=>b?.type==='text').map(b=>b.text).join(''):null;

export function createClaudeLlmService({requestHost}={}){
  async function complete(options={}){
    if(typeof requestHost!=='function')throw claudeError('llm','complete','沒有 Claude Code 的反向請求通道');
    if(options.signal?.aborted)throw claudeError('llm','complete','呼叫已取消','ABORT_ERR');
    const {prompt,system}=toPrompt(options,'complete');
    let reply;
    try{reply=await requestHost('model.complete',{prompt,...(system?{system}:{}),...(options.maxTokens===undefined?{}:{maxTokens:options.maxTokens}),...(options.temperature===undefined?{}:{temperature:options.temperature})},{signal:options.signal});}
    catch(error){if(isDisabled(error))throw disabledError('llm','complete',error,'allowModelCalls','DSH_MODEL_CALLS_DISABLED');throw error;}
    const text=replyText(reply);
    if(text===null)throw claudeError('llm','complete','mod 的 model.complete 回覆沒有文字','DSH_MODEL_REPLY_INVALID');
    return {text,provider:PROVIDER};
  }
  return guardService({
    complete,
    async *stream(options={}){
      const {text}=await complete({...options});
      yield {type:'block-start',index:0,blockType:'text'};
      if(text)yield {type:'text-delta',index:0,text};
      yield {type:'block-end',index:0,block:{type:'text',text}};
      yield {type:'finish',reason:{kind:'stop'}};
    },
    listProviders:()=>[PROVIDER],
    async listModels(){return [];},
  },'llm','這個 llm 方法沒有對應到 Claude Code 的 model.complete');
}
export async function install({requestHost}={}){
  return {services:{llm:createClaudeLlmService({requestHost})},dispose:async()=>{},diagnostics:[{module:'llm',level:'warning',reason:'模型呼叫經 model.complete；預設關閉。沒有實際測過模型輸出與費用。'}]};
}
