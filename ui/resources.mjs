/** DSH resource providers share one cancellable metadata stream per address.
 * Contract: pinned dsh-client-resources 0.2.1-rc.2 client/contract.d.ts. */
const error=(message,code)=>Object.assign(new Error(message),{code});
const once=fn=>{let live=true;return()=>{if(live){live=false;return fn();}};};
export function protocolOf(address){try{const url=new URL(address);return url.protocol==='dsh-resource:'&&url.hostname?url.hostname.toLowerCase():undefined;}catch{return undefined;}}
/** Preserve the official raw-address grammar, including encoded separators and
 * dot segments. Path resolution belongs to the Host, never the URL parser. */
export function parseFileAddress(address){
  try{
    const prefix='dsh-resource://file/';if(typeof address!=='string'||!address.startsWith(prefix))return;
    const end=address.search(/[?#]/),[scope,...rest]=address.slice(prefix.length,end===-1?undefined:end).split('/');
    if(scope==='session'){const [id,...segments]=rest;if(id===undefined||id===''||segments.length===0)return;return {scope,sessionId:decodeURIComponent(id),path:segments.map(decodeURIComponent).join('/')};}
    if(scope==='absolute'){const unc=rest[0]===''&&rest.length>1,segments=(unc?rest.slice(1):rest).map(decodeURIComponent);if(!segments.length||segments[0]==='')return;return {scope,path:unc?'//'+segments.join('/'):/^[A-Za-z]:$/.test(segments[0])?segments.join('/'):'/'+segments.join('/')};}
  }catch{return;}
}
export function createFileAccess({rpc,pollIntervalMs=1000}={}){
  const request=async(address,operation,options={},signal)=>{
    signal?.throwIfAborted();const result=await rpc('ui.resources.file',{address,operation,...options},{signal});signal?.throwIfAborted();
    if(result?.ok!==true&&result?.ok!==false)throw error('檔案後端沒有傳回成功或失敗資料。','UI_RESOURCE_FILE_RESULT');return result;
  };
  const delay=signal=>new Promise(resolve=>{const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,pollIntervalMs);signal.addEventListener('abort',finish,{once:true});if(signal.aborted)finish();});
  return {request,readText:(address,options,signal)=>request(address,'read',options,signal),provider:{protocol:'file',async *open(address,{signal}){
    let previous;
    while(!signal.aborted){
      let result;try{result=await request(address,'stat',{},signal);}catch(problem){if(signal.aborted)return;result={ok:false,error:{code:problem.code??'workspace-file/internal',message:problem.message??String(problem),details:{}}};}
      if(signal.aborted)return;
      const signature=JSON.stringify(result);if(signature!==previous){previous=signature;yield result;}
      await delay(signal);
    }
  }}};
}
export function createResources({report=()=>{}}={}){
  const providers=new Map(),records=new Map();let disposed=false;
  const initial=address=>({status:providers.has(protocolOf(address))?'loading':'none',value:undefined,failure:undefined});
  function record(address){
    if(records.has(address))return records.get(address);
    const row={address,holders:0,listeners:new Set(),snapshot:initial(address),controller:undefined};
    row.source={getSnapshot:()=>row.snapshot,subscribe(listener){row.listeners.add(listener);hold(row);return once(()=>{row.listeners.delete(listener);release(row);});}};
    records.set(address,row);return row;
  }
  function publish(row,snapshot){row.snapshot=snapshot;for(const listener of [...row.listeners])listener();}
  function stop(row){row.controller?.abort();row.controller=undefined;}
  function start(row){
    const provider=providers.get(protocolOf(row.address));if(!provider||!row.holders||disposed)return;
    const controller=new AbortController();row.controller=controller;
    publish(row,{status:'loading',value:undefined,failure:undefined});
    void(async()=>{try{
      const stream=provider.open(row.address,{signal:controller.signal});
      if(!stream?.[Symbol.asyncIterator])throw error('資源提供者沒有傳回非同步資料流。','UI_RESOURCE_PROVIDER_INVALID');
      for await(const frame of stream){
        if(controller.signal.aborted||row.controller!==controller)return;
        if(frame?.ok===true)publish(row,{status:'live',value:frame.value,failure:undefined});
        else if(frame?.ok===false&&frame.error)publish(row,{status:'failed',value:row.snapshot.value,failure:frame.error});
        else throw error('資源提供者傳回的資料框架無效。','UI_RESOURCE_FRAME_INVALID');
      }
    }catch(problem){if(!controller.signal.aborted&&row.controller===controller){report(problem);publish(row,{status:'failed',value:row.snapshot.value,failure:{code:problem.code??'UI_RESOURCE_PROVIDER_ERROR',message:problem.message??String(problem),details:{}}});}}})();
  }
  function hold(row){if(disposed)throw error('資源服務已關閉。','UI_RESOURCE_DISPOSED');if(++row.holders===1)start(row);}
  function release(row){if(row.holders&&--row.holders===0){stop(row);publish(row,initial(row.address));}}
  return {
    register(provider){
      if(disposed)throw error('資源服務已關閉。','UI_RESOURCE_DISPOSED');
      if(typeof provider?.protocol!=='string'||!provider.protocol||typeof provider.open!=='function')throw error('資源提供者需要通訊協定名稱及開啟函式。','UI_RESOURCE_PROVIDER_INVALID');
      const protocol=provider.protocol.toLowerCase();if(providers.has(protocol))throw error(`資源通訊協定「${protocol}」重複註冊。`,'UI_RESOURCE_PROVIDER_DUPLICATE');
      providers.set(protocol,provider);
      for(const row of records.values())if(protocolOf(row.address)===protocol){if(row.holders)start(row);else publish(row,initial(row.address));}
      return once(()=>{if(providers.get(protocol)!==provider)return;providers.delete(protocol);for(const row of records.values())if(protocolOf(row.address)===protocol){stop(row);publish(row,initial(row.address));}});
    },
    source:address=>record(address).source,
    pin(address,signal){if(signal.aborted)return;const row=record(address);hold(row);signal.addEventListener('abort',()=>release(row),{once:true});},
    dispose:once(()=>{disposed=true;providers.clear();for(const row of records.values()){stop(row);publish(row,{status:'none',value:undefined,failure:undefined});}}),
  };
}
