/** DSH injection hooks adapt observable stores into React hooks for original components. */
export function createSlotProps(React,row,locale,extra={}){
  const injected=typeof row.inject==='function'?row.inject():row.inject??{};
  const {hooks,...props}=injected;
  const adapted={};
  for(const [name,store]of Object.entries(hooks??{})){
    if(typeof store?.getSnapshot!=='function'||typeof store?.subscribe!=='function')throw new Error(`畫面狀態「${name}」缺少讀取或訂閱方法。`);
    adapted['use'+name[0].toUpperCase()+name.slice(1)]=(select=value=>value)=>select(React.useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot));
  }
  return {t:locale.bind(row.locale??row.registrant??''),store:row.instance,...props,...adapted,...extra};
}
