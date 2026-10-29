/** Domain stream generations, following Gateway Remote.$stream's public
 * options and acceptance/restart contract. The carrier has no DSH generation
 * observable: only explicitly marked carrier failures get one immediate retry. */
export function createReconnectingStream(options) {
  if(typeof options?.name!=='string'||typeof options.open!=='function'||typeof options.ended!=='function')throw Object.assign(new Error('遠端串流需要名稱、開啟函式與結束分類函式。'),{code:'UI_REMOTE_INVALID'});
  const lifetime=new AbortController();let revision=0,generationAbort,iterator,closing,taken=false;
  const stream={
    get signal(){return lifetime.signal;},
    restart(){if(lifetime.signal.aborted)return;revision++;generationAbort?.abort(new Error('遠端串流重新啟動。'));},
    dispose(){if(closing)return closing;lifetime.abort(new Error('遠端串流已關閉。'));generationAbort?.abort(lifetime.signal.reason);return closing=Promise.resolve(iterator?.return?.()).then(()=>{});},
    [Symbol.asyncIterator](){if(taken)throw new Error('遠端串流只能有一個消費者。');taken=true;iterator=read();return iterator;},
  };
  async function* read(){let generation=0,attempt=0;try{
    while(!lifetime.signal.aborted){
      const started=revision,generationId=++generation,abort=new AbortController();generationAbort=abort;const signal=AbortSignal.any([lifetime.signal,abort.signal]);let accepted=false;
      try{
        for await(const value of options.open(signal)){
          if(lifetime.signal.aborted)return;if(started!==revision)break;
          yield {generation:generationId,value,signal,accept(){if(generationAbort===abort&&started===revision){accepted=true;attempt=0;}}};
        }
        if(lifetime.signal.aborted)return;if(started!==revision){attempt=0;continue;}
        throw options.ended(accepted);
      }catch(error){
        if(lifetime.signal.aborted)return;if(started!==revision){attempt=0;continue;}
        if(error?.isRemoteStreamCarrierError===true&&attempt++===0){options.carrierFailed?.(error);continue;}
        throw error;
      }finally{generationAbort=undefined;abort.abort(new Error('遠端串流這一代已結束。'));}
    }
  }finally{lifetime.abort(new Error('遠端串流的消費者已關閉。'));generationAbort?.abort(lifetime.signal.reason);generationAbort=undefined;}}
  return stream;
}
