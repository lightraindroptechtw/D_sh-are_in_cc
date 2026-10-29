/** Reverse requests: the child asks the mod to do something only Claude Code can do.
 * A `request` line goes out on stdout; the answer comes back through the `reply` RPC. */
export const REVERSE_METHODS=Object.freeze(['exec.check','approval.request','model.complete','agent.spawn','ui.notify','ui.ask','ui.execute','prompt.submit']);
const DEFAULT_TIMEOUT={ 'exec.check':600000,'approval.request':600000,'model.complete':300000,'agent.spawn':600000,'ui.notify':10000,'ui.ask':600000,'ui.execute':600000,'prompt.submit':30000 };

export function createReverseChannel({emit,timeouts={}}={}){
  const pending=new Map();let sequence=0,closed=false;
  const settle=(id,cause,result)=>{
    const slot=pending.get(id);if(!slot)return false;
    pending.delete(id);clearTimeout(slot.timer);slot.signal?.removeEventListener('abort',slot.abort);
    cause?slot.reject(cause):slot.resolve(result);return true;
  };
  const failure=(message,code)=>Object.assign(new Error(message),{code});
  return {
    /** bridgeRequest callback for loadDshHost. */
    request(method,params={},{signal}={}){
      if(!REVERSE_METHODS.includes(method))return Promise.reject(failure(`Unsupported reverse request: ${method}`,'REVERSE_METHOD_UNSUPPORTED'));
      if(closed)return Promise.reject(failure('The host is shutting down','DISPOSED'));
      if(signal?.aborted)return Promise.reject(failure('Request canceled','HOST_CANCELED'));
      const id=`r${++sequence}`;
      return new Promise((resolve,reject)=>{
        const slot={resolve,reject,signal};
        const cancel=(cause)=>{if(method==='ui.execute')try{emit({type:'requestCanceled',id});}catch{}return settle(id,cause);};
        slot.abort=()=>cancel(failure('Request canceled','HOST_CANCELED'));
        slot.timer=setTimeout(()=>cancel(failure(`The mod did not answer ${method} in time`,'REVERSE_REQUEST_TIMEOUT')),timeouts[method]??DEFAULT_TIMEOUT[method]);
        slot.timer.unref?.();
        signal?.addEventListener('abort',slot.abort,{once:true});
        pending.set(id,slot);
        try{emit({type:'request',id,method,params});}catch(cause){settle(id,cause);}
      });
    },
    /** `reply` RPC from the mod. An unknown id is ignored (late answer after timeout/cancel). */
    reply({id,result,error}={}){
      if(typeof id!=='string')throw failure('reply needs an id','INVALID_PARAMS');
      if(error!==undefined&&error!==null){
        const code=typeof error.code==='string'?error.code:'REVERSE_REQUEST_FAILED';
        return {settled:settle(id,failure(typeof error.message==='string'?error.message:code,code))};
      }
      return {settled:settle(id,null,result)};
    },
    get size(){return pending.size;},
    close(){closed=true;for(const id of [...pending.keys()])settle(id,failure('The host is shutting down','DISPOSED'));},
  };
}
