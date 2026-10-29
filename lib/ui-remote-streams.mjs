/** JSON RPC carrier for the official Typert Remote stream contract. Reads are
 * pull-driven and long-poll rather than a fabricated DSH WebSocket endpoint. */
import {randomUUID} from 'node:crypto';
import {isRemoteJson} from '../ui/transport.mjs';
const failure=(message,code='UI_STREAM_INVALID')=>Object.assign(new Error(message),{code});
export function createRemoteStreamRegistry({open,readWaitMs=20000}={}) {
  if(typeof open!=='function')throw new TypeError('需要遠端串流開啟函式。');
  const streams=new Map(),openings=new Set();let disposed=false;
  function rowFor(params){const row=streams.get(params?.streamId);if(!row)throw failure('遠端串流不存在或已關閉。','UI_STREAM_NOT_FOUND');return row;}
  function close(row) {
    if(row.closed)return Promise.resolve();row.closed=true;streams.delete(row.id);row.ended=true;row.queue.length=0;row.controller.abort(failure('遠端串流已取消。','gateway/cancelled'));row.wake?.();
    // A plugin may ignore cancellation while its generator is blocked. Its
    // eventual cleanup is observed, but cannot keep the carrier shutdown open.
    row.closing=Promise.resolve().then(()=>row.iterator?.return?.()).catch(()=>{});return Promise.resolve();
  }
  return {
    async request(method,params={},requestSignal) {
      if(disposed)throw failure('遠端串流服務已關閉。','DISPOSED');
      requestSignal?.throwIfAborted();
      if(method==='ui.stream.open') {
        const controller=new AbortController(),row={id:randomUUID(),controller,queue:[],ended:false,closed:false,taken:false};
        const uplink={ [Symbol.asyncIterator](){if(row.taken)throw failure('串流上行只能讀取一次。');row.taken=true;return {
          async next(){while(!row.queue.length&&!row.ended&&!row.closed)await new Promise(resolve=>row.wake=resolve);if(row.closed||!row.queue.length)return {done:true};return {done:false,value:row.queue.shift()};},
          async return(){row.ended=true;row.queue.length=0;row.wake?.();return {done:true};},
        };}};
        let abort,requestAbort;openings.add(row);
        const opening=Promise.resolve().then(()=>open(params,controller.signal,uplink)).then(source=>{
          if(source?.ok===false)throw failure(source.error?.message??'遠端串流開啟失敗。',source.error?.code??'gateway/internal');
          if(typeof source?.[Symbol.asyncIterator]!=='function')throw failure('遠端串流方法未傳回可迭代物件。','gateway/result-invalid');
          row.iterator=source[Symbol.asyncIterator]();if(row.closed)Promise.resolve(row.iterator.return?.()).catch(()=>{});return row.iterator;
        });opening.catch(()=>{});
        try {
          requestAbort=()=>{void close(row);};requestSignal?.addEventListener('abort',requestAbort,{once:true});if(requestSignal?.aborted)requestAbort();
          await Promise.race([opening,new Promise((_,reject)=>{abort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted)abort();})]);
          if(disposed){void close(row);throw failure('遠端串流服務已關閉。','DISPOSED');}
          streams.set(row.id,row);return {streamId:row.id};
        }catch(error){void close(row);throw error;}
        finally{openings.delete(row);requestSignal?.removeEventListener('abort',requestAbort);controller.signal.removeEventListener('abort',abort);}
      }
      if(method==='ui.stream.cancel'){const row=streams.get(params.streamId);if(row)void close(row);return null;}
      const row=rowFor(params);
      if(method==='ui.stream.send') {
        if(row.ended)throw failure('串流上行已關閉。','gateway/protocol');
        if(params.value!==undefined&&!isRemoteJson(params.value)){void close(row);throw failure('串流上行項目必須是無損 JSON。','gateway/bad-request');}
        row.queue.push(params.value);row.wake?.();return null;
      }
      if(method==='ui.stream.end'){row.ended=true;row.wake?.();return null;}
      if(method!=='ui.stream.read')throw failure('未知的遠端串流方法。');
      if(row.reading)throw failure('遠端串流同時只能有一個讀取要求。');row.reading=true;
      let timer,abort,requestAbort;
      try {
        requestAbort=()=>{void close(row);};requestSignal?.addEventListener('abort',requestAbort,{once:true});if(requestSignal?.aborted)requestAbort();
        row.pending??=Promise.resolve().then(()=>row.iterator.next());row.pending.catch(()=>{});
        const frame=await Promise.race([row.pending,new Promise(resolve=>{timer=setTimeout(()=>resolve({pending:true}),readWaitMs);}),new Promise((_,reject)=>{abort=()=>reject(row.controller.signal.reason);row.controller.signal.addEventListener('abort',abort,{once:true});if(row.controller.signal.aborted)abort();})]);
        if(frame.pending)return frame;
        row.pending=undefined;
        if(frame.done){void close(row);return {done:true};}
        if(frame.value!==undefined&&!isRemoteJson(frame.value)){void close(row);throw failure('串流下行項目不是無損 JSON。','gateway/result-invalid');}
        return {done:false,value:frame.value};
      }catch(error){void close(row);throw error;}
      finally{clearTimeout(timer);row.controller.signal.removeEventListener('abort',abort);requestSignal?.removeEventListener('abort',requestAbort);row.reading=false;}
    },
    async dispose(){if(disposed)return;disposed=true;await Promise.allSettled([...streams.values(),...openings].map(close));},
    get size(){return streams.size;},
  };
}
