import picomatch from 'picomatch';
import {protocolOf,parseFileAddress} from './resources.mjs';
const error=(message,code)=>Object.assign(new Error(message),{code});
const once=fn=>{let live=true;return()=>{if(live){live=false;return fn();}};};
const observable=initial=>{let value=initial;const listeners=new Set();return {getSnapshot:()=>value,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},set(next){value=next;for(const fn of [...listeners])fn();}};};
const bands={extension:3,builtin:2,fallback:1};

/** Address claims and tab lifetimes for the standalone plugin surface.
 * It deliberately owns no Claude Code conversation chrome or DSH docking engine. */
export function createSidebarTabs({resources,resolveText=value=>typeof value==='string'?value:'',currentSession=()=>undefined,report=()=>{}}={}){
  const registrations=new Map(),catalog=observable([]),state=observable({tabs:[],activeId:null,expanded:true,revision:0}),lifetimes=new Map();let sequence=0,order=0,disposed=false;
  const publish=next=>state.set({...state.getSnapshot(),...next,revision:state.getSnapshot().revision+1});
  const active=()=>[...registrations.values()].filter(row=>![...registrations.values()].some(other=>other.kind===row.kind&&bands[other.priority]>bands[row.priority]));
  const get=kind=>active().find(row=>row.kind===kind);
  const close=id=>{const current=state.getSnapshot(),tabs=current.tabs.filter(tab=>tab.id!==id);if(tabs.length===current.tabs.length)return;lifetimes.get(id)?.controller.abort();lifetimes.delete(id);publish({tabs,activeId:current.activeId===id?(tabs.at(-1)?.id??null):current.activeId});};
  const select=id=>{if(!state.getSnapshot().tabs.some(tab=>tab.id===id))throw error('找不到已開啟的插件頁籤。','UI_TAB_MISSING');publish({activeId:id,expanded:true});};
  const title=(row,address)=>resolveText(typeof row.title==='function'?row.title(address):row.title??row.kind);
  const permits=(row,address)=>{const allowed=row.canOpen?.(address);if(allowed?.then)throw error('資源位址判斷函式必須同步傳回布林值。','UI_RESOURCE_PREDICATE_INVALID');return allowed!==false;};
  function candidates(address){
    let pathname;try{pathname=new URL(address).pathname;}catch{return [];}
    return active().map(row=>({row,length:Math.max(-1,...row.matchers.filter(({whole,match})=>match(whole?address:pathname)).map(item=>item.pattern.length))})).filter(item=>item.length>=0&&permits(item.row,address)).sort((a,b)=>bands[b.row.priority]-bands[a.row.priority]||b.length-a.length||a.row.order-b.row.order).map(item=>item.row);
  }
  function claim(address,kind){const row=kind?get(kind):candidates(address)[0];if(!row||(kind&&!permits(row,address)))throw error(`沒有已註冊的插件頁籤可開啟資源「${address}」。`,'UI_RESOURCE_UNCLAIMED');return {kind:row.kind,contentId:address,title:title(row,address)};}
  function refresh(){
    catalog.set(active());
    for(const tab of [...state.getSnapshot().tabs]){const row=get(tab.kind);if(!row)close(tab.id);else if(row.id!==tab.registrationId)publish({tabs:state.getSnapshot().tabs.map(item=>item.id===tab.id?{...item,registrationId:row.id}:item)});}
  }
  const registry={register(spec){
    if(disposed)throw error('頁籤服務已關閉。','UI_TAB_DISPOSED');
    if(!spec||typeof spec.id!=='string'||!spec.id||typeof spec.kind!=='string'||!spec.kind)throw error('頁籤註冊需要 id 與 kind。','UI_TAB_INVALID');
    if(registrations.has(spec.id))throw error(`頁籤「${spec.id}」重複註冊。`,'UI_TAB_CONFLICT');
    const priority=spec.priority??'extension';if(!bands[priority])throw error('頁籤優先順序必須是 extension、builtin 或 fallback。','UI_TAB_INVALID');
    const same=[...registrations.values()].filter(row=>row.kind===spec.kind);
    if(same.some(row=>row.priority===priority||row.priority==='fallback'||priority==='fallback'))throw error(`頁籤種類「${spec.kind}」已有相同優先順序或無法共存的提供者。`,'UI_TAB_CONFLICT');
    if(spec.patterns!==undefined&&(!Array.isArray(spec.patterns)||spec.patterns.some(pattern=>typeof pattern!=='string')))throw error('資源位址規則必須是字串陣列。','UI_TAB_INVALID');
    const row={...spec,priority,order:++order,matchers:(spec.patterns??[]).map(pattern=>({pattern,whole:pattern.includes(':'),match:picomatch(pattern.includes(':')?pattern:pattern.startsWith('**/')?pattern:'**/'+pattern,{nocase:true,dot:true,posix:true,windows:false})}))};
    registrations.set(row.id,row);refresh();return once(()=>{if(registrations.get(row.id)===row){registrations.delete(row.id);refresh();}});
  },get,entries:()=>catalog.getSnapshot(),subscribe:catalog.subscribe,candidates,claim,guide:()=>active().flatMap(row=>(row.guide??[]).map(entry=>({...entry,kind:row.kind,providerId:row.id}))).sort((a,b)=>(a.order??0)-(b.order??0))};
  function open(address,row,options={},sessionId,claimedTitle){
    if(disposed)throw error('頁籤服務已關閉。','UI_TAB_DISPOSED');
    const current=state.getSnapshot(),replacement=typeof options.replaceTab==='string'?options.replaceTab:undefined;
    const existing=options.revealIfOpened!==false&&!(row.multiple&&address.startsWith('sidebar://'))?current.tabs.find(tab=>tab.kind===row.kind&&tab.contentId===address&&tab.sessionId===sessionId):undefined;
    if(existing){const updated={...existing,navigation:{address,params:options.params,revision:existing.navigation.revision+1}};if(replacement&&replacement!==existing.id){lifetimes.get(replacement)?.controller.abort();lifetimes.delete(replacement);}publish({tabs:current.tabs.filter(tab=>tab.id!==replacement||tab.id===existing.id).map(tab=>tab.id===existing.id?updated:tab),activeId:existing.id,expanded:true});return;}
    const tab={id:'plugin-tab-'+(++sequence),registrationId:row.id,kind:row.kind,contentId:address,title:claimedTitle??title(row,address),sessionId,navigation:{address,params:options.params,revision:1}};
    const controller=new AbortController();lifetimes.set(tab.id,{controller,commands:undefined});resources?.pin(address,controller.signal);
    let tabs=[...current.tabs,tab];if(replacement){const index=current.tabs.findIndex(item=>item.id===replacement);if(index>=0){lifetimes.get(replacement)?.controller.abort();lifetimes.delete(replacement);tabs=[...current.tabs];tabs.splice(index,1,tab);}}
    publish({tabs,activeId:tab.id,expanded:true});
  }
  const openResource=(address,options={},sessionId)=>{if(!protocolOf(address))throw error('資源位址必須使用 dsh-resource:// 通訊協定。','UI_RESOURCE_ADDRESS_INVALID');const selected=claim(address,options.kind),row=get(selected.kind);open(address,row,options,sessionId??currentSession()??parseFileAddress(address)?.sessionId,selected.title);};
  const openTab=(kind,options={},sessionId)=>{const row=get(kind);if(!row)throw error(`找不到頁籤種類「${kind}」。`,'UI_TAB_UNAVAILABLE');open('sidebar://'+kind,row,options,sessionId??currentSession());};
  const service={openResource,openResourceIn:(sessionId,address,options)=>openResource(address,options,sessionId),openTab,openTabIn:(sessionId,kind,options)=>openTab(kind,options,sessionId),close,closeIn:(sessionId,id)=>{if(state.getSnapshot().tabs.some(tab=>tab.id===id&&tab.sessionId===sessionId))close(id);},active:()=>state.getSnapshot().tabs.find(tab=>tab.id===state.getSnapshot().activeId),focus:id=>{if(state.getSnapshot().tabs.some(tab=>tab.id===id))select(id);},isExpanded:()=>state.getSnapshot().expanded,toggleExpanded:()=>publish({expanded:!state.getSnapshot().expanded})};
  const info=(id,visible)=>{const row=state.getSnapshot().tabs.find(tab=>tab.id===id),life=lifetimes.get(id);if(!row||!life)return undefined;const options=input=>({...input,...(input?.replaceTab===true?{replaceTab:id}:{})});return {sidebar:{expanded:state.getSnapshot().expanded,fullscreen:false},panel:{id:'plugin-pane'},tab:{...row,visible,signal:life.controller.signal,actions:{close:()=>close(id),openResource:(address,input)=>openResource(address,options(input),row.sessionId),openTab:(kind,input)=>openTab(kind,options(input),row.sessionId),bindCommands(commands){life.commands=commands;return once(()=>{if(life.commands===commands)life.commands=undefined;});}}}};};
  return {registry,service,catalog,state,select,close,info,dispose:once(()=>{disposed=true;for(const life of lifetimes.values())life.controller.abort();lifetimes.clear();registrations.clear();catalog.set([]);publish({tabs:[],activeId:null});})};
}
