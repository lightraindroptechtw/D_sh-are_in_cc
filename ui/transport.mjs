/** Carrier-only framing. DSH unary bytes use result-relative null placeholders;
 * stream uplink/downlink items remain lossless JSON, as in 0.2.1-rc.2. */
const own = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
const error = message => Object.assign(new Error(message),{code:'UI_REMOTE_TRANSPORT'});
export function isRemoteJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value,-0);
  if (!value || typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value) && ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Object.keys(value).length === value.length && value.every(item => isRemoteJson(item,ancestors))
    : Object.values(value).every(item => isRemoteJson(item,ancestors));
  ancestors.delete(value);return valid;
}
function base64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength).toString('base64');
  let text = '';for (let offset=0;offset<bytes.length;offset+=0x8000) text += String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
  return btoa(text);
}
function unbase64(text) {
  if (typeof text !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw error('二進位附件的編碼無效。');
  const binary = atob(text), bytes = new Uint8Array(binary.length);
  for (let index=0;index<binary.length;index++) bytes[index]=binary.charCodeAt(index);
  if (base64(bytes)!==text) throw error('二進位附件的編碼無效。');
  return bytes;
}
export function projectBinary(input, writeBytes) {
  const ancestors=new Set(),path=[];
  function visit(input,key) {
    let value=input;
    if (value && typeof value==='object' && !(value instanceof Uint8Array) && typeof value.toJSON==='function') value=value.toJSON(key);
    if (value instanceof Uint8Array) return writeBytes(value,[...path]);
    if (!value || typeof value!=='object') return value;
    if (value instanceof Number || value instanceof String || value instanceof Boolean) return value.valueOf();
    if (ancestors.has(value)) throw error('遠端結果包含循環參照。');
    ancestors.add(value);const copy=Array.isArray(value)?[]:{};
    for (const key of Array.isArray(value)?Array.from({length:value.length},(_,index)=>index):Object.keys(value)) {
      if (key==='toJSON' && typeof value[key]==='function') continue;
      path.push(key);const child=visit(value[key],String(key));path.pop();
      Object.defineProperty(copy,key,{value:child,enumerable:true,writable:true,configurable:true});
    }
    ancestors.delete(value);return copy;
  }
  return visit(input,'value');
}
export function hydrateAttachments(value,attachments,decode = item => item.bytes) {
  if (!Array.isArray(attachments)) throw error('二進位附件清單無效。');
  let result=value;const paths=new Set();
  for (const item of attachments) {
    if (!item || !Array.isArray(item.path) || item.path.some(key => typeof key!=='string' && (!Number.isSafeInteger(key)||key<0))) throw error('二進位附件的位置無效。');
    const pathKey=JSON.stringify(item.path);if(paths.has(pathKey))throw error('二進位附件的位置重複。');paths.add(pathKey);
    const bytes=decode(item);if(!(bytes instanceof Uint8Array))throw error('二進位附件必須是位元組陣列。');
    if (!item.path.length) {if(result!==null)throw error('二進位附件缺少空值占位。');result=bytes;continue;}
    let parent=result;
    for (const key of item.path.slice(0,-1)) {if(!parent||typeof parent!=='object'||!own(parent,key))throw error('二進位附件的位置不存在。');parent=parent[key];}
    const key=item.path.at(-1);
    if (!parent||typeof parent!=='object'||!own(parent,key)||parent[key]!==null) throw error('二進位附件缺少空值占位。');
    Object.defineProperty(parent,key,{value:bytes,enumerable:true,writable:true,configurable:true});
  }
  return result;
}
/** Turn a native handler result into JSON transport metadata, retaining void. */
export function encodeConnectionResult(result) {
  if (!result?.ok) return result;
  const native=result.attachments?.length?hydrateAttachments(result.value,result.attachments):result.value, attachments=[];
  const value=projectBinary(native,(bytes,path)=>{attachments.push({path,base64:base64(bytes)});return null;});
  return {ok:true,value,...(attachments.length?{attachments}: {})};
}
export function decodeConnectionResult(result) {
  if (!result?.ok || result.attachments===undefined) return result;
  return {ok:true,value:hydrateAttachments(result.value,result.attachments,item=>unbase64(item.base64))};
}

/** The generated Remote method's single-consumer duplex handle. Opening starts
 * immediately, before the caller reads; send/end remain ordered behind open. */
export function openRpcStream(rpc,params,signal,report=()=>{},onDispose=()=>{}) {
  const lifetime=new AbortController(),combined=signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal;
  let streamId,taken=false,disposed=false,ended=false,terminal=false,chain=Promise.resolve(),cancelled;
  const opened=Promise.resolve().then(()=>{combined.throwIfAborted();return rpc('ui.stream.open',params,{signal:combined});}).then(result=>{
    if(typeof result?.streamId!=='string')throw error('遠端串流缺少識別碼。');
    streamId=result.streamId;if(disposed)void cancel();return streamId;
  });
  opened.catch(()=>{});
  async function cancel() {
    if (!streamId || terminal) return;
    return cancelled??=Promise.resolve(rpc('ui.stream.cancel',{streamId})).catch(report);
  }
  function queue(method,extra={}) {
    if(disposed)throw error('遠端串流已結束。');
    const operation=chain.then(async()=>{await opened;if(disposed)return;await rpc(method,{streamId,...extra},{signal:combined});});
    chain=operation;operation.catch(()=>{});return operation;
  }
  const onAbort=()=>{disposed=true;combined.removeEventListener('abort',onAbort);onDispose();void cancel();};combined.addEventListener('abort',onAbort,{once:true});
  const handle={
    send(value) {if(ended)throw error('遠端串流的上行已關閉。');if(value!==undefined&&!isRemoteJson(value))throw error('串流上行項目必須是無損 JSON。');return queue('ui.stream.send',{value});},
    end() {if(ended||disposed)return;const result=queue('ui.stream.end');ended=true;return result;},
    dispose() {if(!disposed){disposed=true;lifetime.abort();}void cancel();},
    [Symbol.asyncIterator]() {
      if(taken)throw error('遠端串流只能有一個消費者。');taken=true;
      const iterator=(async function*(){try{
        await opened;
        while(!disposed){
          const frame=await rpc('ui.stream.read',{streamId},{signal:combined});
          if(disposed)return;
          if(frame?.pending===true)continue;
          if(typeof frame?.done!=='boolean')throw error('遠端串流傳回的項目格式無效。');
          if(frame.done){terminal=true;return;}
          yield frame.value;
        }
      }catch(cause){if(!disposed)throw cause;}finally{handle.dispose();await cancel();combined.removeEventListener('abort',onAbort);}})();
      return {next:()=>iterator.next(),return:async value=>{handle.dispose();return iterator.return(value);}};
    },
  };
  return handle;
}
