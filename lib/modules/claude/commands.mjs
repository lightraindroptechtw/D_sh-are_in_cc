import {randomUUID} from 'node:crypto';
import {claudeError,createClaudeBridgeAgent} from './common.mjs';

const reason='官方 commands.execute 需要真實 DSH Agent 與對話紀錄；Claude Code 宿主改由 commands.run 直接呼叫已登記的處理函式，不寫入 DSH 對話紀錄';
export const descriptor={
  id:'commands',displayName:'斜線指令模組（Claude Code）',services:['commands'],officialPackage:'@deepseek-ai/dsh-commands',
  requires:{capabilities:[]},
  methods:{
    register:{support:'full',reason:'沿用官方命令登記、重複名稱檢查與清除機制'},
    list:{support:'partial',reason:'可列舉全域命令；沒有 DSH Agent，不含代理專屬命令'},
    find:{support:'partial',reason:'可查找全域命令定義'},
    execute:{support:'unsupported',reason},
    run:{support:'partial',reason:'commands.run 以不含 DSH Agent 的承載物呼叫處理函式；若處理函式使用 agent.session、agent.send 等會得到明確錯誤'},
  },
  requirements:['處理函式不得依賴 DSH Agent 對話才能運作'],
};

export async function install({root}={}){
  const official=root?.get?.('commands');
  if(!official)return {services:{},diagnostics:[{module:'commands',code:'MODULE_SERVICE_UNAVAILABLE',reason:'官方命令登記服務尚未掛載'}]};
  const originals=new Map();
  for(const method of ['execute','registerFileReceiptResolver']){
    originals.set(method,Object.getOwnPropertyDescriptor(official,method));
    Object.defineProperty(official,method,{configurable:true,writable:true,value(){throw claudeError('commands',method,reason,'DSH_MODULE_METHOD_UNSUPPORTED');}});
  }
  return {services:{commands:official},diagnostics:[{module:'commands',code:'COMMAND_EXECUTION_PARTIAL',reason}],dispose:async()=>{for(const [method,original]of originals)if(original)Object.defineProperty(official,method,original);else delete official[method];}};
}

/** Run a registered global command without a DSH agent. Returns {text}. */
export async function runCommand(root,{name,args='',signal}={}){
  const registry=root.get('commands');
  if(!registry)throw claudeError('commands','run','官方命令登記服務沒有掛載','HOST_SERVICE_UNAVAILABLE');
  if(typeof name!=='string'||!/^[a-z][a-z0-9_-]*$/.test(name))throw claudeError('commands','run','命令名稱不合法','INVALID_ARGUMENT');
  const definition=registry.find(undefined,name);
  if(!definition)throw claudeError('commands','run',`找不到全域命令 /${name}（代理專屬命令無法在沒有 DSH Agent 時執行）`,'COMMAND_NOT_FOUND');
  const rawInput=typeof args==='string'&&args.length?(/^\s/.test(args)?args:' '+args):'';
  const agent=createClaudeBridgeAgent({root,callId:`command-${name}`,args:{}});
  const outcome=await definition.handler({commandId:`claude-${randomUUID()}`,agent,rawInput,attachments:[],signal:signal??new AbortController().signal});
  if(outcome?.kind==='error')throw claudeError('commands','run',String(outcome.text??'命令回報錯誤'),'COMMAND_FAILED');
  return {text:typeof outcome?.text==='string'?outcome.text:''};
}
