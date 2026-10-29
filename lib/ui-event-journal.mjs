/** Ordered, bounded metadata notifications for the independent plugin UI. */
export const UI_EVENT_NAMES=Object.freeze(['credentials/reference-updated','credentials/record-updated','settings/document-updated','commands/change','llm/adapters-updated']);
const eventError=(message,code)=>Object.assign(new Error(message),{code});
const metadataName=value=>typeof value==='string'&&value.length>0&&value.length<=2048&&!/[\u0000-\u001f\u007f]/.test(value);

export function createUiEventJournal({context,capacity=256}={}){
  if(!context||typeof context.on!=='function'||!Number.isSafeInteger(capacity)||capacity<1||capacity>4096)throw new TypeError('UI event journal requires a context and bounded capacity');
  let cursor=0,disposed=false;
  const events=[],disposers=[];
  for(const name of UI_EVENT_NAMES)disposers.push(context.on(name,(key,revision)=>{
    if(disposed)return;
    const noArgs=name==='commands/change'||name==='llm/adapters-updated';
    if(!noArgs&&!metadataName(key))return;
    // These events carry identities and revision numbers only. Never copy extra
    // arguments, record contents, credential values, or source event objects.
    const args=noArgs?[]:[key];
    if(name==='settings/document-updated'){
      if(!Number.isSafeInteger(revision)||revision<0)return;
      args.push(revision);
    }
    events.push({id:++cursor,name,args});
    if(events.length>capacity)events.shift();
  }));
  return {
    poll({after=0}={}){
      if(disposed)throw eventError('插件畫面事件已結束。','UI_EVENTS_DISPOSED');
      if(!Number.isSafeInteger(after)||after<0)throw eventError('無效的畫面事件游標。','UI_EVENTS_INVALID');
      const first=events[0]?.id??cursor+1,lost=after<first-1||after>cursor;
      // A cursor from a previous worker generation also receives a reset notice.
      const position=after>cursor?0:after;
      return {cursor,events:events.filter(event=>event.id>position).map(event=>({...event,args:[...event.args]})),lost};
    },
    async dispose(){if(disposed)return;disposed=true;events.length=0;for(const dispose of disposers.splice(0))if(typeof dispose==='function')await dispose();},
  };
}
