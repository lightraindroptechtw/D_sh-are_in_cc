import {createRemoteServices} from './remote.mjs';
import {createResources,createFileAccess} from './resources.mjs';
import {createSidebarTabs} from './resource-navigation.mjs';
import {createTimer} from './timer.mjs';
export {createSidebarTabs} from './resource-navigation.mjs';
/** Browser-neutral compatibility core. Services implement actual local state or real Host RPC. */
export const HOST_SLOTS = Object.freeze({
  'settings.section': {kind:'list',scope:'root'},
  'settings.general.item': {kind:'list',scope:'root'},
  'plugins.bundle.config': {kind:'keyed',scope:'root'},
  'plugins.item': {kind:'list',scope:'root'},
  main: {kind:'keyed',scope:'root'},
  'sidebar.panellist': {kind:'list',scope:'root'},
  'sidebar.footer.action': {kind:'list',scope:'root'},
  'sidebar.right.pane.tab': {kind:'keyed',scope:'root'},
  'sidebar.right.pane.tab.title': {kind:'keyed',scope:'root'},
  'shell.overlay': {kind:'list',scope:'root'},
  'shell.bottom': {kind:'single',scope:'root'},
});
export const EXCLUDED_SLOTS = Object.freeze(['conversation.*','chat.*','tool.*','root','sidebar','rightbar','rightbar.session']);
const excluded = name => /^(conversation\.|chat\.|tool\.)/.test(name) || ['root','sidebar','rightbar','rightbar.session'].includes(name);
export function observable(initial) {
  let value=initial; const listeners=new Set();
  return {getSnapshot:()=>value,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},set(next){if(Object.is(next,value))return;value=next;for(const fn of [...listeners])fn();}};
}
const once = fn => {let active=true;return (...args)=>{if(!active)return;active=false;return fn(...args);};};
export function compatibilityError(message,code='UI_UNSUPPORTED') {return Object.assign(new Error(message),{code});}

/** Cordis effects collect every yielded disposer, including generator return values. */
export function createEffects(report=()=>{}) {
  const disposers=new Set();let disposed=false;
  const own=fn=>{const off=once(()=>{disposers.delete(off);return fn();});if(disposed)off();else disposers.add(off);return off;};
  const effect=callback=>{
    const local=[];let ended=false;
    const collect=value=>{if(value==null)return;if(typeof value!=='function')throw compatibilityError('副作用必須傳回清理函式。','INVALID_EFFECT');if(ended)value();else local.push(value);};
    const off=own(()=>{ended=true;for(const fn of local.reverse()){try{const result=fn();result?.catch?.(report);}catch(error){report(error);}}});
    try {
      const value=callback();
      if(value?.then)value.then(collect,error=>{report(error);off();});
      else if(value?.[Symbol.iterator]){const iter=value[Symbol.iterator]();while(true){const step=iter.next();collect(step.value);if(step.done)break;}}
      else if(value?.[Symbol.asyncIterator]){void(async()=>{for await(const item of value){if(ended)break;collect(item);}})().catch(error=>{report(error);off();});}
      else collect(value);
    } catch(error) {off();throw error;}
    return off;
  };
  return {effect,own,dispose:once(()=>{disposed=true;for(const off of [...disposers].reverse())off();})};
}

export function createSlots(report=()=>{}) {
  const records=new Map(Object.entries(HOST_SLOTS).map(([name,spec])=>[name,{spec,entries:[],version:0,parent:null,listeners:new Set(),watchers:new Set()}]));
  const changes=observable(0);let sequence=0;
  const record=name=>{if(!records.has(name))records.set(name,{entries:[],version:0,listeners:new Set(),watchers:new Set()});return records.get(name);};
  const notify=name=>{const rec=record(name);rec.version++;changes.set(changes.getSnapshot()+1);for(const fn of [...rec.listeners])fn();};
  const reject=name=>{report(compatibilityError(`尚未支援畫面位置「${name}」。此位置不會掛載，其他已支援畫面會繼續執行。`,'UI_SLOT_UNSUPPORTED'),{slot:name});return Object.assign(()=>{},{supported:false});};
  const sync=rec=>{for(const watcher of [...rec.watchers])watcher();};
  function register(options,component) {
    if(!options||typeof options.name!=='string'||!component)throw compatibilityError('畫面註冊缺少位置或元件。','UI_SLOT_INVALID');
    const name=options.name;if(excluded(name))return reject(name);
    const rec=record(name);if(!rec.spec)throw compatibilityError(`畫面位置「${name}」尚未宣告，請使用 slots.inject（插槽注入）等待。`,'UI_SLOT_UNDECLARED');
    if(rec.spec.scope!=='root')return reject(name);
    if(rec.spec.kind==='keyed'&&typeof options.key!=='string')throw compatibilityError(`畫面位置「${name}」需要 key（識別鍵）。`,'UI_SLOT_INVALID');
    if(rec.spec.kind==='list'&&typeof options.id!=='string')throw compatibilityError(`畫面位置「${name}」需要 id（識別碼）。`,'UI_SLOT_INVALID');
    for(const [child,spec] of Object.entries(options.children??{})){
      if(excluded(child)||spec.scope!=='root')throw compatibilityError(`無法宣告畫面位置「${child}」：只支援獨立頁面的根範圍。`,'UI_SLOT_UNSUPPORTED');
      if(record(child).spec)throw compatibilityError(`畫面位置「${child}」已宣告。`,'UI_SLOT_CONFLICT');
    }
    let instance;
    if(options.store){const handle=typeof options.store==='function'?options.store():options.store;if(typeof handle?.create!=='function')throw compatibilityError('此元件使用尚未支援的狀態儲存格式。','UI_STORE_UNSUPPORTED');instance=handle.create();if(typeof instance?.getSnapshot!=='function'||typeof instance?.subscribe!=='function')throw compatibilityError('狀態儲存缺少快照或訂閱介面。','UI_STORE_UNSUPPORTED');}
    const entry={options:{...options},component,inject:options.inject,locale:options.locale,children:options.children,registrant:options.registrant,instance,sequence:++sequence,name};
    rec.entries=[...rec.entries,entry].sort((a,b)=>(a.options.priority??0)-(b.options.priority??0)||(rec.spec.kind==='list'?(a.options.order??0)-(b.options.order??0):0)||a.sequence-b.sequence);
    for(const [child,spec] of Object.entries(options.children??{})){Object.assign(record(child),{spec,parent:name,declaredBy:entry});}
    notify(name);for(const child of Object.keys(options.children??{})){notify(child);sync(record(child));}
    return once(()=>{
      rec.entries=rec.entries.filter(item=>item!==entry);
      for(const child of Object.keys(options.children??{})){const childRec=record(child);if(childRec.declaredBy!==entry)continue;delete childRec.spec;sync(childRec);childRec.entries=[];delete childRec.parent;delete childRec.declaredBy;notify(child);}
      instance?.dispose?.();notify(name);
    });
  }
  const entries=name=>record(name).entries;
  const selected=(name,key)=>{const rec=record(name),rows=rec.entries;if(rec.spec?.kind==='single')return rows.slice(0,1);if(rec.spec?.kind==='keyed')return rows.filter(row=>row.options.key===key).slice(0,1);const ids=new Set();return rows.filter(row=>{if(ids.has(row.options.id))return false;ids.add(row.options.id);return true;});};
  function inject(name,callback){
    if(excluded(name))return reject(name);
    const rec=record(name);let off;
    const syncEffect=()=>{if(rec.spec&&!off){const scope=createEffects(error=>report(error,{slot:name}));try{scope.effect(callback);off=scope.dispose;}catch(error){scope.dispose();report(error,{slot:name});}}else if(!rec.spec&&off){off();off=undefined;}};
    rec.watchers.add(syncEffect);syncEffect();
    return once(()=>{rec.watchers.delete(syncEffect);off?.();});
  }
  function tree(){
    const build=(name,seen=new Set())=>{if(seen.has(name))return null;const rec=record(name);if(!rec.spec)return null;const next=new Set([...seen,name]);const active=new Set(rec.spec.kind==='keyed'?[...new Set(rec.entries.map(e=>e.options.key))].flatMap(key=>selected(name,key)):selected(name));return {type:'slot',name,...rec.spec,declaredBy:rec.declaredBy?.registrant??'dsh-to-claude',occupants:rec.entries.map(e=>({registrant:e.registrant,...e.options,priority:e.options.priority??0,active:active.has(e)})).map(({id,key,order,priority,active,registrant})=>({id,key,order,priority,active,registrant})),children:[...records].filter(([,r])=>r.parent===name).map(([child])=>build(child,next)).filter(Boolean)};};
    return [...records].filter(([,rec])=>rec.spec&&!rec.parent).map(([name])=>build(name));
  }
  return {register,inject,entries,entriesOfSlot:entries,selected,tree,spec:name=>record(name).spec,getVersion:name=>record(name).version,subscribe(name,fn){if(typeof name==='function')return changes.subscribe(name);const rec=record(name);rec.listeners.add(fn);return()=>rec.listeners.delete(fn);},changes,isLive:entry=>entries(entry.name).includes(entry)};
}

export function createLocale(initial='zh') {
  const dictionaries=new Map(),bindings=new Map();const state=observable({active:initial,locales:[{id:'zh',label:'中文'},{id:'en',label:'English'}],revision:0});
  const publish=next=>state.set({...state.getSnapshot(),...next,revision:state.getSnapshot().revision+1});
  const languages=new Map([['zh',{id:'zh',label:'中文',fallback:'en'}],['en',{id:'en',label:'English'}]]);
  const chain=()=>{const result=[],seen=new Set();let id=state.getSnapshot().active;while(id&&!seen.has(id)){seen.add(id);result.push(id);id=languages.get(id)?.fallback;}if(!seen.has('en'))result.push('en');return result;};
  const lookup=(ns,key)=>{for(const lang of chain()){const text=dictionaries.get(ns)?.get(lang)?.[key];if(text!==undefined)return text;}};
  const locale={getLocale:state.getSnapshot,getSnapshot:state.getSnapshot,subscribe:state.subscribe,
    register(ns,langOrDicts,dict){const pairs=typeof langOrDicts==='string'?[[langOrDicts,dict]]:Object.entries(langOrDicts);const map=dictionaries.get(ns)??new Map();for(const [lang] of pairs){if(map.has(lang))throw compatibilityError(`語系字典「${ns}/${lang}」重複註冊。`,'UI_LOCALE_DUPLICATE');}dictionaries.set(ns,map);for(const [lang,words] of pairs)map.set(lang,words);publish({});return once(()=>{for(const [lang,words] of pairs)if(map.get(lang)===words)map.delete(lang);publish({});});},
    bind(ns){if(!bindings.has(ns))bindings.set(ns,(key,params)=>String(lookup(ns,key)??lookup('common',key)??key).replace(/\{(\w+)\}/g,(match,name)=>params&&name in params?String(params[name]):match));return bindings.get(ns);},
    setLocale(id){if(!languages.has(id))throw compatibilityError(`尚未註冊語系「${id}」。`);publish({active:id});},
    resolveText(text){if(typeof text==='string')return text;for(const lang of chain())if(text?.[lang]!==undefined)return text[lang];return text?.en??'';},
    addLanguage(spec){if(languages.has(spec.id)||!languages.has(spec.fallback))throw compatibilityError('新增語系的識別碼重複，或缺少有效的後備語系。');languages.set(spec.id,{...spec});publish({locales:[...languages.values()]});return once(()=>{languages.delete(spec.id);publish({active:state.getSnapshot().active===spec.id?spec.fallback:state.getSnapshot().active,locales:[...languages.values()]});});},
  };return locale;
}

export function normalizeSettings(value) {
  if(Array.isArray(value))return {writable:true,namespaces:value};
  if(value&&Array.isArray(value.namespaces))return {writable:value.writable===true,namespaces:value.namespaces};
  throw compatibilityError('設定後端傳回的資料格式無法辨識。','UI_SETTINGS_FORMAT');
}
export function createConfigForms(rpc,report=()=>{}) {
  const mirror=observable({status:'loading',view:undefined,error:undefined}),forms=new Map();let pending;
  async function load(){if(pending)return pending;pending=(async()=>{try{const view=normalizeSettings(await rpc('settings.describe',{}));mirror.set({status:'ready',view,error:undefined});return view;}catch(error){mirror.set({...mirror.getSnapshot(),status:'unavailable',error:error.message});throw error;}finally{pending=undefined;}})();return pending;}
  const ensure=()=>mirror.getSnapshot().view?Promise.resolve(mirror.getSnapshot().view):load();
  function get(ns){
    if(forms.has(ns))return forms.get(ns);
    const state=observable({status:'loading',value:undefined,base:undefined,user:undefined,revision:undefined,writable:false});let tail=Promise.resolve();
    const derive=()=>{const current=mirror.getSnapshot(),row=current.view?.namespaces.find(entry=>entry.ns===ns);state.set(row?{status:'ready',mode:'host',value:row.value,base:row.base,user:row.user,revision:row.revision,writable:current.view.writable}:{...state.getSnapshot(),status:current.status==='loading'?'loading':'unavailable',writable:false,error:current.error});};
    mirror.subscribe(derive);derive();
    const write=(patch,revision)=>{const task=tail.then(async()=>{await ensure();const snapshot=state.getSnapshot();if(!snapshot.writable)throw compatibilityError(`設定「${ns}」未提供寫入權限。`,'UI_SETTINGS_READONLY');try{const answer=await rpc('settings.update',{ns,patch,revision:revision??snapshot.revision});if(answer?.applied!==true)throw compatibilityError('後端未確認設定已保存。','UI_SETTINGS_NOT_APPLIED');await load();return true;}catch(error){await load().catch(()=>{});throw error;}});tail=task.then(()=>{},()=>{});return task;};
    const mutate=(ops,revision)=>{
      if(!Array.isArray(ops)||ops.some(op=>!['set','unset'].includes(op.op)||!Array.isArray(op.path)||!op.path.length))return Promise.reject(compatibilityError('請指定要變更的設定欄位。','UI_SETTINGS_MUTATE_INVALID'));
      if(ops.every(op=>op.op==='set'&&op.path.length===1))return write(Object.fromEntries(ops.map(op=>[op.path[0],structuredClone(op.value)])),revision);
      const task=tail.then(async()=>{await ensure();const snapshot=state.getSnapshot();if(!snapshot.writable)throw compatibilityError(`設定「${ns}」未提供寫入權限。`,'UI_SETTINGS_READONLY');try{const answer=await rpc('ui.connection.call',{channel:'/api',endpoint:'settings/mutate',payload:{args:{ns,ops,expectedRevision:revision??snapshot.revision}}});if(answer?.ok!==true)throw compatibilityError(answer?.error?.message??'後端未確認設定已保存。',answer?.error?.code??'UI_SETTINGS_NOT_APPLIED');await load();return true;}catch(error){await load().catch(()=>{});throw error;}});tail=task.catch(()=>{});return task;
    };
    const form={getSnapshot:state.getSnapshot,subscribe:state.subscribe,set:(field,value)=>write({[field]:structuredClone(value)}),update:(patch,revision)=>write(structuredClone(patch),revision),unset(field,revision){if(typeof field!=='string'&&!Array.isArray(field))return Promise.reject(compatibilityError('請指定要清除的設定欄位。','UI_SETTINGS_UNSET_INVALID'));return mutate([{op:'unset',path:Array.isArray(field)?field:field.split('.')}],revision);},mutate};
    forms.set(ns,form);void ensure().catch(report);return form;
  }
  return {get,bind:spec=>get(spec.namespace),load,accept(value){mirror.set({status:'ready',view:normalizeSettings(value),error:undefined});},describe:()=>({...mirror,load,ensure}),whileServed(namespaces,register){let off;const sync=()=>{const served=new Set(mirror.getSnapshot().view?.namespaces.map(row=>row.ns)??[]);if(namespaces.some(ns=>served.has(ns))){if(!off)off=register(served);}else{off?.();off=undefined;}};const unsub=mirror.subscribe(sync);sync();void ensure().catch(report);return once(()=>{unsub();off?.();});}};
}

export function createRpc(fetchImpl) {
  return async(method,params={},execution={})=>{const response=await fetchImpl('/__dsh_ui/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,params}),signal:execution.signal});let body;try{body=await response.json();}catch{throw compatibilityError(`後端回應無法解析（HTTP ${response.status}）。`,'UI_RPC_FORMAT');}if(!response.ok||body.ok!==true){const problem=body.error;throw compatibilityError(problem?.message??String(problem??`後端呼叫失敗（HTTP ${response.status}）。`),problem?.code??'UI_RPC_ERROR');}return body.result;};
}

export function createRuntime({libraries={},rpc=async()=>{throw compatibilityError('未連接插件後端。');},context={}}={}) {
  const updates=observable(0),diagnostics=[],modules=new Map(),events=new Map();let activeModule;const resources=new Set();
  const touch=()=>updates.set(updates.getSnapshot()+1);
  const report=(error,details={})=>{const item={code:error.code??'UI_CLIENT_ERROR',message:error.message??String(error),module:details.module??activeModule,...details};if(!diagnostics.some(row=>row.code===item.code&&row.message===item.message&&row.module===item.module)){diagnostics.push(item);touch();}return item;};
  const timerScope=createEffects(report),timer=createTimer(timerScope);resources.add(timerScope);
  const slots=createSlots(report),locale=createLocale('zh'),configForms=createConfigForms(rpc,error=>report(error));
  const serviceWatchers=new Set();
  const remoteServices=createRemoteServices({rpc,report,context,onNamespaceChange:()=>{for(const sync of [...serviceWatchers])sync();touch();}});
  const resourceService=createResources({report}),fileAccess=createFileAccess({rpc}),sidebarTabs=createSidebarTabs({resources:resourceService,resolveText:locale.resolveText,currentSession:()=>undefined,report});
  resourceService.register(fileAccess.provider);
  const navigation=observable({activePanelId:null}),geometry=observable({sidebarOpen:true,rightbarOpen:false,fullscreen:false});let controller=new AbortController();
  const layout={panelInfo:navigation,geometry,selectPanel(id){if(id!==null&&!slots.entries('main').some(entry=>entry.options.key===id))throw compatibilityError(`找不到主頁「${id}」。`,'UI_PANEL_MISSING');controller.abort();navigation.set({activePanelId:id});},beginNavigation(){controller.abort();controller=new AbortController();return controller.signal;},toggleSidebar(){geometry.set({...geometry.getSnapshot(),sidebarOpen:!geometry.getSnapshot().sidebarOpen});},openRightbar(track,fullscreen){geometry.set({...geometry.getSnapshot(),rightbarOpen:true,track,fullscreen});},closeRightbar(){geometry.set({...geometry.getSnapshot(),rightbarOpen:false});}};
  const services={slots,locale,configForms,settingsScope:{bind:configForms.bind},layout,timer,resources:resourceService,sidebarRightTabs:sidebarTabs.registry,sidebarRight:sidebarTabs.service,connection:remoteServices.connection,remote:remoteServices.remote};
  const emit=(name,...args)=>{for(const fn of [...events.get(name)??[]])fn(...args);};
  // Claude Code has no conversation list. Using these names fails loudly instead of returning empty data.
  const conversationUnsupported=()=>{throw compatibilityError('尚未支援 Claude Code 對話列表。','UI_CONVERSATION_UNSUPPORTED');};
  Object.defineProperties(services,{sessions:{enumerable:false,get:conversationUnsupported},currentConversation:{enumerable:false,get:conversationUnsupported},currentconversation:{enumerable:false,get:conversationUnsupported}});
  locale.subscribe(()=>{emit('locale/change',locale.getLocale());touch();});slots.changes.subscribe(touch);navigation.subscribe(touch);geometry.subscribe(touch);
  sidebarTabs.catalog.subscribe(touch);sidebarTabs.state.subscribe(touch);
  function makeContext(id){
    const effects=createEffects(error=>report(error,{module:id}));resources.add(effects);
    const scopedSlots=new Proxy(slots,{get(target,key){const value=target[key];if(['register','inject'].includes(key))return(...args)=>effects.own(value(...(key==='register'?[{...args[0],registrant:args[0]?.registrant??id},args[1]]:args)));return value;}});
    const scopedTabs={...sidebarTabs.registry,register:spec=>effects.own(sidebarTabs.registry.register(spec))};
    const scopedResources={...resourceService,register:provider=>effects.own(resourceService.register(provider))};
    const scopedTimer=createTimer(effects);
    let proxy;
    const lookup=name=>name==='slots'?scopedSlots:name==='sidebarRightTabs'?scopedTabs:name==='resources'?scopedResources:name==='timer'?scopedTimer:name==='remote'||name.startsWith('remote.')?remoteServices.lookup(name,proxy):services[name];
    const local={get:lookup,effect:effects.effect,dispose:effects.dispose,
      provide(name,value){if(services[name]!==undefined)throw compatibilityError(`服務「${name}」已存在。`,'UI_SERVICE_CONFLICT');services[name]=value;touch();return effects.own(()=>{if(services[name]===value)delete services[name];});},
      inject(names,callback){const keys=Array.isArray(names)?names:Object.entries(names??{}).flatMap(([key,required])=>required?[key]:[]);const missing=keys.filter(key=>!lookup(key));if(missing.length){if(missing.every(key=>key.startsWith('remote.'))){let off;const sync=()=>{if(keys.every(key=>lookup(key))){if(!off)off=effects.effect(()=>callback(proxy));}else{off?.();off=undefined;}};serviceWatchers.add(sync);sync();return effects.own(()=>{serviceWatchers.delete(sync);off?.();});}report(compatibilityError(`插件「${id}」要求尚未提供的服務：${missing.join('、')}。相關功能未啟用。`,'UI_SERVICE_UNSUPPORTED'),{module:id,services:missing});return Object.assign(()=>{},{supported:false});}return effects.effect(()=>callback(proxy));},
      on(name,fn){if(!events.has(name))events.set(name,new Set());events.get(name).add(fn);return effects.own(()=>events.get(name)?.delete(fn));},
      once(name,fn){const off=local.on(name,(...args)=>{off();fn(...args);});return off;},
      emit,logger:{info:console.info,warn:console.warn,error:console.error,debug:console.debug},
      ...scopedTimer,
    };
    proxy=new Proxy(local,{get(target,key){if(key in target)return target[key];if(typeof key==='symbol'||key==='then')return undefined;const service=lookup(key);if(service!==undefined)return service;throw compatibilityError(`插件「${id}」使用尚未提供的服務「${key}」。`,'UI_SERVICE_UNSUPPORTED');}});
    return proxy;
  }
  function load({id,factory}){
    if(typeof id!=='string'||typeof factory!=='function')throw compatibilityError('原始前端模組格式錯誤。','UI_MODULE_INVALID');
    if(modules.has(id))return modules.get(id).exports;
    const row={id,status:'loading',exports:undefined};modules.set(id,row);activeModule=id;
    try {
      const exports=factory(name=>{if(Object.hasOwn(libraries,name))return libraries[name];if(modules.has(name)&&modules.get(name).exports)return modules.get(name).exports;throw compatibilityError(`插件「${id}」需要尚未提供的程式庫「${name}」。`,'UI_LIBRARY_UNSUPPORTED');});
      row.exports=exports;const ctx=makeContext(id);row.context=ctx;
      const requires=Array.isArray(exports?.inject)?exports.inject:Object.entries(exports?.inject??{}).filter(([,v])=>v===true).map(([key])=>key);
      for(const service of requires)if(!ctx.get(service))report(compatibilityError(`插件「${id}」要求尚未提供的服務「${service}」。使用它的功能可能無法啟用。`,'UI_SERVICE_UNSUPPORTED'),{module:id,service});
      const apply=typeof exports==='function'?exports:exports?.apply;if(typeof apply!=='function')throw compatibilityError(`插件「${id}」未匯出 apply（啟用函式）。`,'UI_MODULE_INVALID');
      const result=apply(ctx);if(result?.then){row.status='starting';result.then(cleanup=>{if(typeof cleanup==='function')ctx.effect(()=>cleanup);row.status='loaded';touch();},error=>{row.status='partial';report(error,{module:id});});}else{if(typeof result==='function'||result?.[Symbol.iterator])ctx.effect(()=>result);row.status='loaded';}
    }catch(error){row.status=row.exports?'partial':'failed';row.error=error.message;report(error,{module:id});}
    finally{activeModule=undefined;touch();}return row.exports;
  }
  const runtime={load,slots,locale,layout,configForms,sidebarTabs,fileAccess,services,diagnostics,modules,updates,context,report,
    snapshot:()=>({modules:[...modules.values()].map(({id,status,error})=>({id,status,error})),diagnostics:[...diagnostics],slots:slots.tree()}),
    dispose:once(()=>{controller.abort();for(const effects of [...resources].reverse())effects.dispose();serviceWatchers.clear();remoteServices.dispose();sidebarTabs.dispose();resourceService.dispose();touch();}),
  };return runtime;
}
