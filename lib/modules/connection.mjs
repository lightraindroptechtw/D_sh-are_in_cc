/** Carrier adapter for the published Connection handler contract. No HTTP login is fabricated. */
import {hydrateAttachments} from '../../ui/transport.mjs';
const bridgeKey=Symbol('claude-ui-connection-dispatch');
const channelPattern=/^\/[A-Za-z0-9._~-]+$/;
const segmentPattern=/^[A-Za-z0-9_$.-]+$/;
export const descriptor={id:'connection',displayName:'插件畫面與後端通訊',services:['connection'],requires:{capabilities:[]},methods:{'rpc.handle':{support:'full',reason:'登記實際處理函式並隨插件卸載移除'},'rpc.call':{support:'full',reason:'僅派送已登記通道'},'fetch.register':{support:'partial',reason:'登記確切路徑；不偽造原宿主瀏覽器登入'}},requirements:[]};
export function backendError(message,code='UI_BACKEND_UNAVAILABLE'){return Object.assign(new Error(message),{code});}
export function validSegment(value){return typeof value==='string'&&segmentPattern.test(value)&&value!=='.'&&value!=='..';}
function endpointValid(value){return typeof value==='string'&&value.split('/').every(validSegment);}
export async function install({root,load}){
  const {Service}=await load('@deepseek-ai/cordis');
  const {Peer}=await load('@deepseek-ai/dsh-client-connection');
  const channels=new Map(),interceptors=new Map(),routes=new Map();
  let disposed=false;
  class Connection extends Service{
    constructor(ctx){super(ctx,'connection');this.browserPeer=new Peer(ctx,{principal:{kind:'owner'},interactions:'none'});this.allowsRemoteAuthorities=false;}
    get rpc(){const owner=this.ctx;return {
      handle:(channel,handler)=>{
        if(typeof channel!=='string'||!channelPattern.test(channel)||channel==='/api'||typeof handler!=='function')throw backendError('無效或保留的插件通道。','UI_BACKEND_INVALID');
        return owner.effect(()=>{if(channels.has(channel))throw backendError('插件通道已被登記。','UI_BACKEND_DUPLICATE');const row={owner,handler};channels.set(channel,row);return()=>{if(channels.get(channel)===row)channels.delete(channel);};},'claude-ui: '+channel);
      },
      intercept:(channel,matches,handler)=>{
        if(channel!=='/api'||typeof matches!=='function'||typeof handler!=='function')throw backendError('無效的共享通道處理函式。','UI_BACKEND_INVALID');
        return owner.effect(()=>{if(interceptors.has(channel))throw backendError('共享通道已被登記。','UI_BACKEND_DUPLICATE');const row={owner,matches,handler};interceptors.set(channel,row);return()=>{if(interceptors.get(channel)===row)interceptors.delete(channel);};},'claude-ui: shared interceptor');
      },
      call:(channel,endpoint,payload,signal)=>call({channel,endpoint,payload},signal),
    };}
    get fetch(){const owner=this.ctx;return {register:route=>{
      if(!route||!route.path?.startsWith('/api/')||!endpointValid(route.path.slice(5))||typeof route.fetch!=='function'||!Array.isArray(route.methods)||!route.methods.length||route.methods.some(method=>!['GET','HEAD','POST'].includes(method))||!['buffered','streaming'].includes(route.requestBody))throw backendError('無效的插件 Fetch 路徑。','UI_BACKEND_INVALID');
      return owner.effect(()=>{if(routes.has(route.path))throw backendError('插件路徑已被登記。','UI_BACKEND_DUPLICATE');routes.set(route.path,route);return()=>{if(routes.get(route.path)===route)routes.delete(route.path);};},'claude-ui: '+route.path);
    }};}
    createPeer(options){return new Peer(this.ctx,options);}
    // This carrier receives no original DSH credential. Never grant HTTP authentication.
    requestRejection(){return 401;}
    admit(){return {rejection:401};}
    admitConnection(){return {rejection:401};}
    authenticatedUrl(){throw backendError('請使用 Claude Code 插件畫面提供的網址。','UI_BACKEND_AUTH_UNSUPPORTED');}
    authorizeIndex(_request,response){response.writeHead(401);response.end('unauthorized');return false;}
    createSharedFetchHandler(channel){if(channel!=='/api')throw backendError('無效共享通道。','UI_BACKEND_INVALID');return {
      requestBodyMode:({method,url})=>routes.get(url.pathname)?.methods.includes(method)?routes.get(url.pathname).requestBody:'buffered',
      fetch:async(request,peer)=>{const route=routes.get(new URL(request.url).pathname);if(!route||!route.methods.includes(request.method))return new Response('not found',{status:404});if(peer?.principal?.kind!=='owner')return new Response('forbidden',{status:403});return route.fetch(request);},
    };}
  }
  let service;
  const fork=root.plugin({name:'claude-ui-connection',apply(ctx){service=new Connection(ctx);}});await fork.await();
  async function call({channel,endpoint,payload},signal=new AbortController().signal){
    if(disposed)throw backendError('插件通訊已結束。','DISPOSED');
    if(typeof channel!=='string'||!channelPattern.test(channel)||!endpointValid(endpoint))throw backendError('無效的插件通道或方法。','UI_BACKEND_INVALID');
    if(signal?.aborted)throw backendError('插件請求已取消。','HOST_CANCELED');
    const row=channels.get(channel)??(channel==='/api'&&interceptors.get(channel)?.matches(endpoint)?interceptors.get(channel):undefined);
    if(!row)throw backendError('插件未登記這個後端通道。','UI_BACKEND_NOT_REGISTERED');
    const result=await row.handler(endpoint,payload,signal,service.browserPeer);
    if(!result||typeof result.ok!=='boolean'||result.ok&&!Object.hasOwn(result,'value')||!result.ok&&(!result.error||typeof result.error.code!=='string'||typeof result.error.message!=='string'))throw backendError('插件回傳了無效的 Connection 結果。','UI_BACKEND_RESULT_INVALID');
    if(result.ok&&result.attachments!==undefined)return {ok:true,value:hydrateAttachments(result.value,result.attachments)};
    return result;
  }
  Object.defineProperty(service,bridgeKey,{value:{call,describe:()=>({channels:[...channels.keys()],interceptors:[...interceptors.keys()],fetchRoutes:[...routes.keys()]})}});
  return {services:{connection:service},diagnostics:[],async dispose(){disposed=true;channels.clear();interceptors.clear();routes.clear();await service.browserPeer.dispose();await fork.dispose();}};
}
export function callConnection(service,params,signal){const bridge=service?.[bridgeKey];if(!bridge)throw backendError('插件通訊服務未啟用。');return bridge.call(params,signal);}
export function describeConnection(service){return service?.[bridgeKey]?.describe()??{channels:[],interceptors:[],fetchRoutes:[]};}
