import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import * as ReactDOM from 'react-dom';
import {createRoot} from 'react-dom/client';
import * as JSXRuntime from 'react/jsx-runtime';
import {createRuntime,createRpc} from './runtime.mjs';
import {createPrimitives} from './primitives.mjs';
import './primitives.css';
import {createSlotProps} from './slot-props.mjs';
import {parseFileAddress} from './resources.mjs';

let runtime;
const tabTitle=(spec,address)=>runtime.locale.resolveText(typeof spec?.title==='function'?spec.title(address):spec?.title??spec?.kind??'');
function Icon({name}){
  const paths={plus:'M12 5v14M5 12h14',close:'m6 6 12 12M6 18 18 6',refresh:'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3a7 7 0 0 0 11.6-1',panel:'M4 4h16v16H4zM9 4v16',settings:'M4 7h16M4 17h16M8 4v6M16 14v6'};
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]??paths.panel}/></svg>;
}
class PanelBoundary extends React.Component{
  state={error:null};
  static getDerivedStateFromError(error){return {error};}
  componentDidCatch(error){runtime.report(error,{slot:this.props.slot});}
  render(){return this.state.error?<div className="dsh-ui-problem">這個畫面未能載入：{this.state.error.message}。其他頁面仍可使用。</div>:this.props.children;}
}
function Slot({name,slotKey,visible=true}){
  useSyncExternalStore(runtime.slots.changes.subscribe,runtime.slots.changes.getSnapshot);
  return runtime.slots.selected(name,slotKey).map(row=><PanelBoundary key={row.sequence} slot={name}>
    <OriginalEntry row={row} visible={visible}/>
  </PanelBoundary>);
}
const useResource=address=>{const source=runtime.services.resources.source(address);return useSyncExternalStore(source.subscribe,source.getSnapshot,source.getSnapshot);};
const useSessions=(select=value=>value)=>{const source=runtime.services.sessions.list;return select(useSyncExternalStore(source.subscribe,source.getSnapshot,source.getSnapshot));};
const useCurrentConversation=(select=value=>value)=>{const source=runtime.services.currentConversation;return select(useSyncExternalStore(source.subscribe,source.getSnapshot,source.getSnapshot));};
function OriginalEntry({row,visible=true,extra={}}){return <row.component {...createSlotProps(React,row,runtime.locale,{visible,active:visible,selected:visible,useResource,useSessions,useCurrentConversation,...extra})}/>;}
function SidebarSlot({name,tab,visible}){
  useSyncExternalStore(runtime.slots.changes.subscribe,runtime.slots.changes.getSnapshot);
  return runtime.slots.selected(name,tab.registrationId).map(row=><SidebarEntry key={row.sequence} row={row} tab={tab} visible={visible}/>);
}
function SidebarEntry({row,tab,visible}){
  const snapshot=useSyncExternalStore(runtime.sidebarTabs.state.subscribe,runtime.sidebarTabs.state.getSnapshot);
  const info=React.useMemo(()=>runtime.sidebarTabs.info(tab.id,visible),[snapshot,tab.id,visible]);
  // The hook belongs to this mounted tab, including its title and close action.
  const useTabInfo=()=>info;
  return <PanelBoundary slot={row.name}><OriginalEntry row={row} visible={visible} extra={{useTabInfo,...(tab.sessionId?{sessionId:tab.sessionId}:{})}}/></PanelBoundary>;
}
function FilePreview({useTabInfo}){
  const {tab}=useTabInfo(),metadata=useResource(tab.contentId),[refresh,setRefresh]=useState(0),[preview,setPreview]=useState({status:'loading',text:'',eof:true}),controller=useRef(null);
  useEffect(()=>{
    controller.current?.abort();if(metadata.status==='loading'||metadata.status==='none')return;
    if(metadata.status==='failed'){setPreview(previous=>({...previous,status:'failed',error:metadata.failure?.message??'無法取得檔案資料。'}));return;}
    const request=new AbortController();controller.current=request;
    setPreview({status:'loading',text:'',eof:true});
    void runtime.fileAccess.readText(tab.contentId,{offset:1,limit:200},request.signal).then(result=>{
      if(request.signal.aborted)return;if(!result.ok){setPreview({status:'failed',text:'',eof:true,error:result.error.message});return;}
      const value=result.value;setPreview({status:'ready',text:value.text,eof:value.eof,nextOffset:value.offset+value.lines});
    },error=>{if(!request.signal.aborted)setPreview({status:'failed',text:'',eof:true,error:error.message});});
    return()=>request.abort();
  },[tab.contentId,metadata.status,metadata.value?.version,refresh]);
  const more=async()=>{
    const request=controller.current;if(!request||request.signal.aborted)return;setPreview(previous=>({...previous,status:'loading-more'}));
    try{const result=await runtime.fileAccess.readText(tab.contentId,{offset:preview.nextOffset,limit:200},request.signal);if(request.signal.aborted)return;if(!result.ok)throw new Error(result.error.message);const value=result.value;setPreview(previous=>({status:'ready',text:previous.text+(previous.text&&value.lines?'\n':'')+value.text,eof:value.eof,nextOffset:value.offset+value.lines}));}
    catch(error){if(!request.signal.aborted)setPreview(previous=>({...previous,status:'failed',error:error.message}));}
  };
  return <div style={{padding:20,height:'100%',overflow:'auto'}}><div style={{display:'flex',gap:12,alignItems:'center'}}><span style={{flex:1,overflowWrap:'anywhere'}}>{metadata.value?.absolutePath??parseFileAddress(tab.contentId)?.path??tab.contentId}</span><button onClick={()=>setRefresh(value=>value+1)}>重新讀取</button></div>{preview.status==='loading'&&<p>正在讀取檔案…</p>}{preview.error&&<p role="alert">{preview.error}</p>}<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontFamily:'monospace'}}>{preview.text}</pre>{!preview.eof&&<button disabled={preview.status==='loading-more'} onClick={more}>{preview.status==='loading-more'?'正在讀取…':'載入更多'}</button>}</div>;
}
function App({manifest}){
  useSyncExternalStore(runtime.updates.subscribe,runtime.updates.getSnapshot);
  const navigation=useSyncExternalStore(runtime.layout.panelInfo.subscribe,runtime.layout.panelInfo.getSnapshot);
  const [selection,setSelection]=useState('settings'),[tab,setTab]=useState(null),[startOpen,setStartOpen]=useState(false),[resourceAddress,setResourceAddress]=useState(''),[resourceError,setResourceError]=useState('');
  const toolbar=useRef(null);
  const sidebar=useSyncExternalStore(runtime.sidebarTabs.state.subscribe,runtime.sidebarTabs.state.getSnapshot);
  const previousSidebar=useRef(sidebar);
  const catalog=useSyncExternalStore(runtime.sidebarTabs.catalog.subscribe,runtime.sidebarTabs.catalog.getSnapshot);
  const main=runtime.slots.entries('main'),tabs=runtime.slots.entries('sidebar.right.pane.tab').filter(row=>!catalog.some(spec=>spec.id===row.options.key));
  const settingsSections=runtime.slots.entries('settings.section');
  const settings=[...settingsSections,...runtime.slots.entries('plugins.bundle.config'),...runtime.slots.entries('plugins.item').filter(row=>!settingsSections.some(section=>section.registrant===row.registrant))];
  const pages=catalog.filter(spec=>!spec.patterns?.length||spec.guide?.length);
  const hasOriginalNav=runtime.slots.entries('sidebar.panellist').length>0||runtime.slots.entries('sidebar.footer.action').length>0;
  useEffect(()=>{
    const reveal=()=>{const selected=toolbar.current?.querySelector('[role="tab"][aria-selected="true"]');(selected?.closest('.dsh-ui-tab-chip')??selected)?.scrollIntoView({block:'nearest',inline:'nearest'});};
    reveal();window.addEventListener('resize',reveal);return()=>window.removeEventListener('resize',reveal);
  },[selection,sidebar.activeId,tab,navigation.activePanelId,startOpen]);
  useEffect(()=>{
    const closed=previousSidebar.current.tabs.some(old=>!sidebar.tabs.some(current=>current.id===old.id));
    previousSidebar.current=sidebar;
    if(sidebar.activeId&&(!closed||selection==='sidebar')){setSelection('sidebar');setStartOpen(false);}
    else if(!sidebar.activeId&&selection==='sidebar'){setSelection(settings.length?'settings':main.length?'main':tabs.length?'tabs':'start');if(!settings.length&&!main.length&&!tabs.length)setStartOpen(true);}
  },[sidebar.activeId,sidebar.revision]);
  useEffect(()=>{if(navigation.activePanelId)setSelection('main');},[navigation.activePanelId]);
  useEffect(()=>{if(!settings.length&&main.length){runtime.layout.selectPanel(main[0].options.key);setSelection('main');}else if(!settings.length&&!main.length&&tabs.length){setTab(tabs[0].options.key);setSelection('tabs');}else if(!settings.length&&!main.length&&!tabs.length&&!sidebar.activeId&&catalog.length){setStartOpen(true);setSelection('start');}},[settings.length,main.length,tabs.length,catalog.length]);
  const title=row=>{const sidebar=runtime.slots.entries('sidebar.panellist').find(entry=>entry.options.id===row.options.key);let value=row.options.label??row.options.title??sidebar?.options.label??row.options.key??row.options.id;if(typeof value==='function')value=value(runtime.locale.bind(row.locale??row.options.id??''));return runtime.locale.resolveText(value);};
  const focusSelected=()=>requestAnimationFrame(()=>(toolbar.current?.querySelector('[role="tab"][aria-selected="true"]')??toolbar.current?.querySelector('[aria-label="新增頁籤"]'))?.focus());
  const closeTab=id=>{runtime.sidebarTabs.close(id);focusSelected();};
  const closeStart=()=>{if(!sidebar.activeId&&!settings.length&&!main.length&&!tabs.length)return;setStartOpen(false);setSelection(sidebar.activeId?'sidebar':settings.length?'settings':main.length?'main':'tabs');focusSelected();};
  const openPage=kind=>{runtime.services.sidebarRight.openTab(kind,{revealIfOpened:true});setStartOpen(false);setSelection('sidebar');};
  const openResource=event=>{event.preventDefault();try{runtime.services.sidebarRight.openResource(resourceAddress.trim());setResourceError('');setStartOpen(false);setSelection('sidebar');}catch(error){setResourceError(error.message);}};
  const unavailable=runtime.diagnostics;
  return <div className="dsh-ui-shell">
    <header className="dsh-ui-header" ref={toolbar}>
      <div className="dsh-ui-tab-strip" role="tablist" aria-label="插件頁面">
        {settings.length>0&&<button className="dsh-ui-fixed-tab" role="tab" aria-selected={selection==='settings'} onClick={()=>setSelection('settings')}><Icon name="settings"/><span>插件設定</span></button>}
        {main.map(row=><button className="dsh-ui-fixed-tab" role="tab" key={row.sequence} aria-selected={selection==='main'&&navigation.activePanelId===row.options.key} onClick={()=>{runtime.layout.selectPanel(row.options.key);setSelection('main');}}><span>{title(row)}</span></button>)}
        {tabs.map(row=><button className="dsh-ui-fixed-tab" role="tab" key={row.sequence} aria-selected={selection==='tabs'&&tab===row.options.key} onClick={()=>{setTab(row.options.key);setSelection('tabs');}}><span>{title(row)}</span></button>)}
        {sidebar.tabs.map(item=><div key={item.id} className="dsh-ui-tab-chip" data-active={selection==='sidebar'&&sidebar.activeId===item.id}>
          <div role="tab" tabIndex={0} aria-selected={selection==='sidebar'&&sidebar.activeId===item.id} onClick={()=>{runtime.sidebarTabs.select(item.id);setSelection('sidebar');}} onKeyDown={event=>{if(event.target===event.currentTarget&&['Enter',' '].includes(event.key)){event.preventDefault();runtime.sidebarTabs.select(item.id);setSelection('sidebar');}}}>
            {runtime.slots.selected('sidebar.right.pane.tab.title',item.registrationId).length?<SidebarSlot name="sidebar.right.pane.tab.title" tab={item} visible={selection==='sidebar'&&sidebar.activeId===item.id}/>:<span title={item.title}>{item.title}</span>}
          </div><button className="dsh-ui-icon-button dsh-ui-tab-close" aria-label={'關閉頁籤 '+item.title} onClick={()=>closeTab(item.id)}><Icon name="close"/></button>
        </div>)}
        {startOpen&&<div className="dsh-ui-tab-chip" data-active={selection==='start'}><button className="dsh-ui-fixed-tab" role="tab" aria-selected={selection==='start'} onClick={()=>setSelection('start')}>開始</button>{(sidebar.tabs.length>0||settings.length>0||main.length>0||tabs.length>0)&&<button className="dsh-ui-icon-button dsh-ui-tab-close" aria-label="關閉開始頁" onClick={closeStart}><Icon name="close"/></button>}</div>}
      </div>
      {catalog.length>0&&<button className="dsh-ui-icon-button" aria-label="新增頁籤" title="新增頁籤" onClick={()=>{setStartOpen(true);setSelection('start');}}><Icon name="plus"/></button>}
      <div className="dsh-ui-header-actions"><button className="dsh-ui-icon-button" aria-label="重新載入" title="重新載入" onClick={()=>location.reload()}><Icon name="refresh"/></button></div>
    </header>
    <div className="dsh-ui-layout" data-navigation={hasOriginalNav}>
      {hasOriginalNav&&<aside className="dsh-ui-nav" aria-label="原插件導覽"><Slot name="sidebar.panellist"/><div className="dsh-ui-nav-footer"><Slot name="sidebar.footer.action"/></div></aside>}
      <main className="dsh-ui-main">
      {selection==='settings'&&<div className="dsh-ui-settings"><div className="dsh-ui-page-heading"><h1>{manifest.name}</h1><span>v{manifest.version}</span></div>{settings.map(row=><section className="dsh-ui-section" key={row.sequence}><h2>{title(row)}</h2><PanelBoundary slot={row.name}><OriginalEntry row={row}/></PanelBoundary></section>)}</div>}
      {selection==='main'&&<Slot name="main" slotKey={navigation.activePanelId}/>}
      {selection==='tabs'&&<Slot name="sidebar.right.pane.tab" slotKey={tab}/>}
      {sidebar.tabs.length>0&&<div hidden={selection!=='sidebar'||!sidebar.expanded} className="dsh-ui-sidebar-tabs">
        {sidebar.tabs.map(item=><section key={item.id} role="tabpanel" hidden={sidebar.activeId!==item.id} className="dsh-ui-tab-body"><SidebarSlot name="sidebar.right.pane.tab" tab={item} visible={selection==='sidebar'&&sidebar.expanded&&sidebar.activeId===item.id}/>{!runtime.slots.selected('sidebar.right.pane.tab',item.registrationId).length&&<p>此頁籤尚未註冊畫面內容。</p>}</section>)}
      </div>}
      {selection==='start'&&<div className="dsh-ui-start"><h1>開啟插件頁面</h1><p>{manifest.name}</p><div className="dsh-ui-start-pages">{pages.map(spec=><button key={spec.id} className="dsh-ui-page-link" onClick={()=>openPage(spec.kind)}><span className="dsh-ui-page-icon"><Icon name="panel"/></span><span>{tabTitle(spec,'sidebar://'+spec.kind)}</span></button>)}</div>{catalog.some(spec=>spec.patterns?.length)&&<form onSubmit={openResource}><label htmlFor="dsh-resource-address">資源位址</label><div style={{display:'flex',gap:8,marginTop:8}}><input id="dsh-resource-address" style={{flex:1,minWidth:0}} value={resourceAddress} onChange={event=>setResourceAddress(event.target.value)} placeholder="dsh-resource://file/session/…"/><button type="submit">開啟</button></div>{resourceError&&<p role="alert">{resourceError}</p>}</form>}{!pages.length&&!catalog.some(spec=>spec.patterns?.length)&&<p>目前沒有其他可開啟的頁面。</p>}</div>}
      {!settings.length&&!main.length&&!tabs.length&&!catalog.length&&<p className="dsh-ui-empty">此插件未註冊獨立頁面。若有浮窗或快捷按鈕，會出現在本頁。</p>}
      <Slot name="settings.general.item"/><Slot name="shell.bottom"/>
      {unavailable.length>0&&<details className="dsh-ui-diagnostics"><summary>目前未接上的功能（{unavailable.length}）</summary><ul>{unavailable.map((row,index)=><li key={index}>{row.message}</li>)}</ul></details>}
    </main></div><Slot name="shell.overlay"/>
  </div>;
}
async function start(){
  const [manifestResponse,contextResponse]=await Promise.all([fetch('/__dsh_ui/manifest'),fetch('/__dsh_ui/context')]);
  if(!manifestResponse.ok||!contextResponse.ok)throw new Error('無法取得插件畫面資料，請重新開啟插件。');
  const manifest=await manifestResponse.json(),context=await contextResponse.json();
  const primitives=createPrimitives(React,ReactDOM);
  runtime=createRuntime({libraries:{react:React,'react-dom':ReactDOM,'react-dom/client':{createRoot},'react/jsx-runtime':JSXRuntime,'@deepseek-ai/dsh-client-ui-primitives':primitives,'dsh-client-ui-primitives':primitives},rpc:createRpc(fetch.bind(window)),context});
  const filePreviewId='dsh-to-claude.file-preview';
  runtime.sidebarTabs.registry.register({id:filePreviewId,kind:'text',priority:'fallback',patterns:['dsh-resource://file/**'],title:address=>parseFileAddress(address)?.path.split(/[\\/]/).at(-1)??'檔案預覽'});
  runtime.slots.register({name:'sidebar.right.pane.tab',key:filePreviewId,registrant:'dsh-to-claude'},FilePreview);
  window.__ModuleLoader__={load:module=>runtime.load(module)};
  window.__DSH_CLAUDE_UI__=runtime;
  window.addEventListener('error',event=>runtime.report(event.error??new Error(event.message)));
  window.addEventListener('unhandledrejection',event=>runtime.report(event.reason instanceof Error?event.reason:new Error(String(event.reason))));
  window.addEventListener('pagehide',()=>runtime.dispose(),{once:true});
  createRoot(document.getElementById('app')).render(<App manifest={manifest}/>);
  for(const client of manifest.clients){await new Promise(resolve=>{const script=document.createElement('script');script.src=client.url;script.onload=()=>resolve();script.onerror=()=>{runtime.report(new Error('無法讀取原插件畫面：'+client.source));resolve();};document.head.appendChild(script);});}
}
start().catch(error=>{const target=document.getElementById('app');target.textContent='插件畫面無法開啟：'+error.message;});
