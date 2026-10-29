/** Browser Remote projection, following DSH 0.2.1-rc.2 api-gateway/client.
 * Reference: work/dsh-native-investigation/cli-install/node_modules/@deepseek-ai/
 * dsh-api-gateway/lib/client.browser.js. Input parsers run on the Host; the Client
 * requires strict input codecs and only applies an explicitly supplied result.decode.
 * This page carries unary calls, native binary results and duplex streams.
 * Host update events use the carrier's existing event journal.
 */
import {decodeConnectionResult,openRpcStream} from './transport.mjs';
import {createReconnectingStream} from './reconnecting-stream.mjs';
import {FILE_REMOTE_CONTRIBUTIONS} from './file-descriptors.mjs';
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const localError = (message, code = 'UI_REMOTE_INVALID') => Object.assign(new Error(message), {code});
const unsupported = feature => {throw localError(`此獨立頁面尚未提供${feature}。`, 'UI_REMOTE_UNSUPPORTED');};
const endpointOf = descriptor => `${descriptor.namespace}/${descriptor.method}`;
const RESERVED_METHODS = new Set(['ctx','empty','invokeRemote','methods','name','namespace','has','install','installDirect','installScoped','remove','assertMethodAvailable',...Object.getOwnPropertyNames(Object.prototype)]);
const REMOTE_EVENTS = new Set(['credentials/reference-updated','credentials/record-updated','settings/document-updated','commands/change','llm/adapters-updated']);

export class RemoteError extends Error {
  constructor(code, message, details = {}, options) {
    super(message, options);
    this.name = 'RemoteError';this.code = code;this.details = details;this.isDSHRemoteError = true;
  }
}
const failed = (code, message, cause) => ({ok:false,error:new RemoteError(code,message,{},cause === undefined ? undefined : {cause})});
const withdrawn = endpoint => failed('gateway/internal', `client api: Remote method ${endpoint} is no longer mounted`);

function assertTarget(channel, endpoint) {
  if (typeof channel !== 'string' || typeof endpoint !== 'string' || !/^\/[A-Za-z0-9._~-]+$/.test(channel) || endpoint.split('/').some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9_$.-]+$/.test(part))) {
    throw localError(`Connection（連線）呼叫的路徑無效：${String(channel)}/${String(endpoint)}`, 'UI_CONNECTION_TARGET');
  }
}
function validateResult(result) {
  if (!record(result) || (result.ok !== true && result.ok !== false)) throw localError('Connection（連線）後端未傳回成功或失敗封裝。', 'UI_CONNECTION_RESULT');
  if (result.ok === false && (!record(result.error) || typeof result.error.code !== 'string' || typeof result.error.message !== 'string' || !record(result.error.details))) throw localError('Connection（連線）後端傳回的錯誤封裝無效。', 'UI_CONNECTION_RESULT');
  return result;
}
function assertSignal(signal) {
  if (signal !== undefined && (typeof signal?.addEventListener !== 'function' || typeof signal?.throwIfAborted !== 'function' || typeof signal?.aborted !== 'boolean')) throw localError('取消參數必須是 AbortSignal（取消訊號）。');
}
function projectionOf(descriptor) {
  if (descriptor.invocation.kind === 'context') return {context:descriptor.invocation.context,wire:descriptor.invocation.wire};
  if (!descriptor.scope) return undefined;
  const lookups = descriptor.parameters.map((parameter,index) => ({parameter,index})).filter(row => row.parameter.source === 'lookup');
  const selected = lookups.length === 1 ? lookups[0] : undefined;
  if (!selected || selected.parameter.wire !== descriptor.scope.wire || selected.parameter.lookup !== descriptor.scope.context) throw localError(`Remote（遠端服務）「${endpointOf(descriptor)}」的範圍必須指定唯一的查找參數。`);
  return {context:descriptor.scope.context,wire:descriptor.scope.wire,parameterIndex:selected.index};
}
function strict(codec, endpoint, field) {
  if (codec?.mode !== 'strict') throw localError(`Remote（遠端服務）「${endpoint}」的欄位「${field}」缺少 strict codec（嚴格編解碼宣告）。`);
}

// Exact public signatures from dsh-api-settings-controller and dsh-commands
// generated typert.remote-client.d.ts. No other Host methods are exposed.
const builtinDescriptor = (namespace, method, names, cancellation = false) => ({
  id:`${namespace}/${method}`,service:namespace,namespace,method,invocation:{kind:'direct'},
  parameters:names.map(name => ({name,wire:name,source:'json',codec:{mode:'strict'}})),
  ...(cancellation ? {cancellation:{parameter:'signal'}} : {}),result:{mode:'src-json'},
});
const commandDescriptor = (method, names, cancellation = false) => {
  const descriptor = builtinDescriptor('commands', method, names, cancellation);
  descriptor.parameters[0] = {...descriptor.parameters[0],source:'lookup',lookup:'agent'};
  descriptor.scope = {context:'agent',wire:'agentId'};
  return descriptor;
};
export const BUILTIN_REMOTE_CONTRIBUTIONS = [
  ...FILE_REMOTE_CONTRIBUTIONS,
  {package:'@deepseek-ai/dsh-api-settings-controller',descriptors:[
    builtinDescriptor('settings','describe',[]),
    builtinDescriptor('settings','mutate',['ns','ops','expectedRevision']),
    builtinDescriptor('settings','replace',['ns','section','expectedRevision']),
    builtinDescriptor('settings','update',['ns','patch','expectedRevision']),
    builtinDescriptor('settings','openSettingsDocument',[],true),
    builtinDescriptor('credentials','describe',['refs']),
    builtinDescriptor('credentials','set',['ref','value']),
    builtinDescriptor('credentials','unset',['ref']),
  ]},
  {package:'@deepseek-ai/dsh-commands',descriptors:[
    commandDescriptor('list',['agentId']),
    commandDescriptor('execute',['agentId','line','submittedAttachments'],true),
  ]},
];

/**
 * rpc(method, params, {signal}) is the page's authenticated JSON transport.
 * It unwraps only the outer UI envelope. ui.connection.call must return the
 * original {ok:true,value}/{ok:false,error:{code,message,details}} result.
 *
 * forContext(caller) supplies scoped method selection and mount ownership:
 * caller.effect should own the disposer, as a Cordis Context does. An optional
 * identity(kind, caller) adapter supplies known context identities; the default
 * reads caller.identities[kind] only and never invents an agent/workspace id.
 */
export function createRemoteServices({rpc, report = () => {}, context = {}, identity = (kind, caller) => caller && own(caller,'identities') ? caller.identities?.[kind] : undefined, builtins = true, onNamespaceChange = () => {}, pollIntervalMs = 1000} = {}) {
  if (typeof rpc !== 'function') throw localError('Remote（遠端服務）需要可呼叫的後端傳輸。');
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) throw localError('遠端事件輪詢間隔必須是非負毫秒數。');
  const namespaces = new Map(), packages = new Map(), faces = new Map();let disposed = false;
  const subscriptions = new Set(),streams = new Set();let eventCursor = 0, pollTimer, pollRequest;
  const connection = {rpc:{async call(channel, endpoint, payload, signal) {
    if (disposed) throw localError('Connection（連線）已關閉。', 'UI_CONNECTION_DISPOSED');
    assertTarget(channel,endpoint);assertSignal(signal);signal?.throwIfAborted();
    const result = await rpc('ui.connection.call',{channel,endpoint,payload},{signal});
    signal?.throwIfAborted();return decodeConnectionResult(validateResult(result));
  },open(channel,endpoint,payload,signal,uplink) {
    if (disposed) throw localError('Connection（連線）已關閉。','UI_CONNECTION_DISPOSED');
    assertTarget(channel,endpoint);assertSignal(signal);signal?.throwIfAborted();
    const handle=openRpcStream(rpc,{channel,endpoint,payload},signal,error=>safeReport(error),()=>streams.delete(handle));streams.add(handle);
    if(uplink) void (async()=>{try{for await(const value of uplink)await handle.send(value);await handle.end();}catch(error){handle.dispose();safeReport(error);}})();
    return handle;
  }}};
  const safeReport = error => {try {report(error);} catch { /* Diagnostics never change cleanup. */ }};
  const safeNotify = () => {try {onNamespaceChange();} catch(error) {safeReport(error);}};
  function stopPolling() {
    if (pollTimer !== undefined) {clearTimeout(pollTimer);pollTimer = undefined;}
    const previous = pollRequest;pollRequest = undefined;previous?.abort();
  }
  function schedulePoll() {
    if (disposed || subscriptions.size === 0 || pollTimer !== undefined || pollRequest !== undefined) return;
    pollTimer = setTimeout(() => {pollTimer = undefined;void pollEvents();},pollIntervalMs);
  }
  async function pollEvents() {
    if (disposed || subscriptions.size === 0 || pollRequest !== undefined) return;
    const request = new AbortController(), after = eventCursor;pollRequest = request;
    try {
      const response = await rpc('ui.events.poll',{after},{signal:request.signal});
      // A carrier may settle despite cancellation. A retired request owns no delivery.
      if (disposed || request.signal.aborted || pollRequest !== request) return;
      if (!record(response) || !Number.isSafeInteger(response.cursor) || response.cursor < 0 || (response.cursor < after && response.lost !== true) || !Array.isArray(response.events) || typeof response.lost !== 'boolean') throw localError('遠端事件後端傳回的輪詢資料無效。','UI_REMOTE_EVENTS_FORMAT');
      // A restarted Host explicitly reports lost history and begins a new id sequence.
      let previousId = response.lost && response.cursor < after ? 0 : after;
      for (const event of response.events) {
        if (!record(event) || !Number.isSafeInteger(event.id) || event.id <= previousId || event.id > response.cursor || typeof event.name !== 'string' || !Array.isArray(event.args)) throw localError('遠端事件後端傳回的事件資料無效。','UI_REMOTE_EVENTS_FORMAT');
        previousId = event.id;
      }
      eventCursor = response.cursor;
      if (response.lost) safeReport(localError('遠端事件紀錄已超過保留容量，部分更新通知無法補回。','UI_REMOTE_EVENTS_LOST'));
      for (const event of response.events) {
        if (disposed || request.signal.aborted || pollRequest !== request) return;
        if (!REMOTE_EVENTS.has(event.name)) {safeReport(localError(`尚未支援遠端事件「${event.name}」，未呼叫監聽函式。`,'UI_REMOTE_EVENT_UNSUPPORTED'));continue;}
        for (const subscription of [...subscriptions]) {
          if (!subscription.active || subscription.event !== event.name) continue;
          try {
            const result = subscription.listener(...event.args);
            if (typeof result?.then === 'function') Promise.resolve(result).catch(safeReport);
          } catch(error) {safeReport(error);}
        }
      }
    } catch(error) {
      if (!disposed && !request.signal.aborted && pollRequest === request) safeReport(error);
    } finally {
      if (pollRequest === request) {pollRequest = undefined;schedulePoll();}
    }
  }
  function subscribe(caller,event,listener) {
    if (!REMOTE_EVENTS.has(event)) {
      safeReport(localError(`尚未支援遠端事件「${String(event)}」，未建立訂閱；其他功能會繼續執行。`,'UI_REMOTE_EVENT_UNSUPPORTED'));
      return Object.assign(() => {},{supported:false});
    }
    if (disposed) throw localError('Remote（遠端服務）已關閉。','UI_REMOTE_DISPOSED');
    if (typeof listener !== 'function') throw localError('遠端事件訂閱需要監聽函式。');
    const setup = () => {
      const subscription = {event,listener,active:true};subscriptions.add(subscription);
      // The initial request starts immediately; later requests wait one interval.
      if (pollTimer === undefined && pollRequest === undefined) void pollEvents();
      return Object.assign(() => {
        if (!subscription.active) return;subscription.active = false;subscriptions.delete(subscription);
        if (subscriptions.size === 0) stopPolling();
      },{supported:true});
    };
    const off = typeof caller?.effect === 'function' ? caller.effect(setup) : setup();
    return Object.assign(off,{supported:true});
  }
  const faceFor = caller => {
    if (faces.has(caller)) return faces.get(caller).remote;
    const views = new Map();
    const remote = {
      async $mount(contribution) {
        let off;
        if (typeof caller?.effect === 'function') {
          const mounted = caller.effect(() => {off = mount(contribution);return off;});
          await mounted;
          if (off === undefined) throw localError('Remote（遠端服務）掛載的副作用未執行。');
          return async () => {await mounted();};
        }
        off = mount(contribution);return off;
      },
      $on(event,listener) {return subscribe(caller,event,listener);},
      $stream(options) {const stream=createReconnectingStream(options);streams.add(stream);return stream;},
    };
    // Host facts must be explicit; this UI cannot infer the Host home or carrier locality.
    Object.defineProperty(remote,'$host',{enumerable:true,get:() => {
      if (!record(context.hostFacts)) return unsupported('遠端主機資訊');
      return context.hostFacts;
    }});
    const face = {remote,views};faces.set(caller,face);
    for (const namespace of namespaces.keys()) expose(face,namespace,caller);
    return remote;
  };
  function expose(face, name, caller) {
    if (face.views.has(name)) return;
    const view = Object.create(null);face.views.set(name,view);
    Object.defineProperty(face.remote,name,{enumerable:true,configurable:true,value:view});
    refreshView(view,name,caller);
  }
  function refreshView(view, name, caller) {
    const methods = namespaces.get(name);
    for (const method of Object.keys(view)) if (!methods?.has(method)) delete view[method];
    for (const [method, variants] of methods ?? []) if (!own(view,method)) Object.defineProperty(view,method,{enumerable:true,configurable:true,get:() => {
      // Capture the current mount token when the method is read, matching DSH.
      const direct = variants.direct, scoped = variants.scoped;
      return (...values) => invoke(direct,scoped,caller,values);
    }});
  }
  function syncFaces() {
    for (const [caller,face] of faces) {
      for (const name of face.views.keys()) if (!namespaces.has(name)) {delete face.remote[name];face.views.delete(name);}
      for (const name of namespaces.keys()) {expose(face,name,caller);refreshView(face.views.get(name),name,caller);}
    }
    safeNotify();
  }
  function mount(contribution) {
    if (disposed) throw localError('Remote（遠端服務）已關閉。', 'UI_REMOTE_DISPOSED');
    if (!record(contribution) || typeof contribution.package !== 'string' || !contribution.package || !Array.isArray(contribution.descriptors)) throw localError('Remote（遠端服務）掛載需要套件名稱與方法宣告陣列。');
    if (packages.has(contribution.package)) throw localError(`Remote（遠端服務）套件「${contribution.package}」重複掛載。`, 'UI_REMOTE_CONFLICT');
    const additions = [], seen = new Set();
    for (const descriptor of contribution.descriptors) {
      if (!record(descriptor) || typeof descriptor.namespace !== 'string' || typeof descriptor.method !== 'string' || !Array.isArray(descriptor.parameters) || !['direct','context'].includes(descriptor.invocation?.kind) || !record(descriptor.result)) throw localError('Remote（遠端服務）方法宣告不完整。');
      const endpoint = endpointOf(descriptor);assertTarget('/api',endpoint);
      if (descriptor.namespace.startsWith('$') || ['__proto__','constructor','prototype','then'].includes(descriptor.namespace) || RESERVED_METHODS.has(descriptor.method) || descriptor.method === 'then') throw localError(`Remote（遠端服務）名稱「${endpoint}」與服務本身衝突。`, 'UI_REMOTE_CONFLICT');
      for (const parameter of descriptor.parameters) {
        if (typeof parameter?.wire !== 'string' || !parameter.wire || !['json','lookup'].includes(parameter.source)) throw localError(`Remote（遠端服務）「${endpoint}」的參數宣告無效。`);
        strict(parameter.codec,endpoint,parameter.wire);
      }
      if (descriptor.uplink) strict(descriptor.uplink.codec,endpoint,'uplink');
      if (descriptor.invocation.kind === 'context') strict(descriptor.invocation.codec,endpoint,descriptor.invocation.wire);
      if (descriptor.mode !== undefined && descriptor.mode !== 'stream') throw localError(`Remote（遠端服務）「${endpoint}」的呼叫模式無效。`);
      const projection = projectionOf(descriptor);
      const kinds = [...(descriptor.invocation.kind === 'direct' ? ['direct'] : []),...(projection ? ['scoped'] : [])];
      for (const kind of kinds) {
        const key = `${endpoint}:${kind}`;
        if (seen.has(key) || namespaces.get(descriptor.namespace)?.get(descriptor.method)?.[kind]) throw localError(`Remote（遠端服務）「${endpoint}」重複掛載。`, 'UI_REMOTE_CONFLICT');
        seen.add(key);
      }
      additions.push({descriptor,projection,kinds,active:true,abort:new AbortController()});
    }
    packages.set(contribution.package, additions);
    for (const item of additions) {
      const {descriptor,kinds} = item;
      if (!namespaces.has(descriptor.namespace)) namespaces.set(descriptor.namespace,new Map());
      const methods = namespaces.get(descriptor.namespace);
      const variants = methods.get(descriptor.method) ?? {};
      for (const kind of kinds) variants[kind] = item;
      methods.set(descriptor.method,variants);
    }
    syncFaces();
    let active = true;
    return () => {
      if (!active) return;active = false;packages.delete(contribution.package);
      for (const item of additions) {
        item.active = false;item.abort.abort();
        const methods = namespaces.get(item.descriptor.namespace), variants = methods?.get(item.descriptor.method);
        for (const kind of item.kinds) if (variants?.[kind] === item) delete variants[kind];
        if (variants && !variants.direct && !variants.scoped) methods.delete(item.descriptor.method);
        if (methods?.size === 0) namespaces.delete(item.descriptor.namespace);
      }
      syncFaces();
    };
  }
  function invoke(direct, scoped, caller, values) {
    const bound = scoped ? identity(scoped.projection.context,caller) : undefined;
    const item = bound !== undefined ? scoped : direct ?? scoped;
    if (!item) throw localError('Remote（遠端服務）方法已解除掛載。');
    const {descriptor} = item, endpoint = endpointOf(descriptor);
    if (descriptor.mode === 'stream') return invokeStream(item,bound !== undefined || !direct ? item.projection : undefined,caller,values,bound);
    return invokeUnary(item, bound !== undefined || !direct ? item.projection : undefined, caller,values,bound);
  }
  function invokeStream(item,projection,caller,values,bound) {
    const {descriptor}=item,endpoint=endpointOf(descriptor);
    if(!item.active)throw localError(`遠端方法「${endpoint}」已解除掛載。`);
    const expected=descriptor.parameters.length-(projection?.parameterIndex===undefined?0:1);
    const hasSignal=descriptor.cancellation!==undefined&&values.length===expected+1;
    if(values.length!==expected&&!hasSignal)throw localError(`Remote（遠端服務）「${endpoint}」需要 ${expected} 個業務參數${descriptor.cancellation?'，最後可附取消訊號':''}；實際收到 ${values.length} 個。`);
    const args=Object.create(null);
    if(projection){const selected=bound??identity(projection.context,caller);if(selected===undefined)throw localError(`Remote（遠端服務）「${endpoint}」需要「${projection.context}」的範圍識別碼。`,'UI_REMOTE_CONTEXT');args[projection.wire]=selected;}
    let offset=0;descriptor.parameters.forEach((parameter,index)=>{if(index===projection?.parameterIndex)return;const value=values[offset++];if(value!==undefined)args[parameter.wire]=value;});
    const callerSignal=hasSignal?values[expected]:undefined;assertSignal(callerSignal);
    const signal=callerSignal===undefined?item.abort.signal:AbortSignal.any([item.abort.signal,callerSignal]);
    return connection.rpc.open('/api',endpoint,{args},signal);
  }
  async function invokeUnary(item, projection, caller, values, bound) {
    const {descriptor} = item, endpoint = endpointOf(descriptor);
    if (!item.active) return withdrawn(endpoint);
    const expected = descriptor.parameters.length - (projection?.parameterIndex === undefined ? 0 : 1);
    const hasSignal = descriptor.cancellation !== undefined && values.length === expected + 1;
    if (values.length !== expected && !hasSignal) throw localError(`Remote（遠端服務）「${endpoint}」需要 ${expected} 個業務參數${descriptor.cancellation ? '，最後可附取消訊號' : ''}；實際收到 ${values.length} 個。`);
    const args = Object.create(null);
    if (projection) {
      const selected = bound ?? identity(projection.context,caller);
      if (selected === undefined) throw localError(`Remote（遠端服務）「${endpoint}」需要「${projection.context}」的範圍識別碼。`, 'UI_REMOTE_CONTEXT');
      args[projection.wire] = selected;
    }
    let offset = 0;
    descriptor.parameters.forEach((parameter,index) => {
      if (index === projection?.parameterIndex) return;
      const value = values[offset++];if (value !== undefined) args[parameter.wire] = value;
    });
    const callerSignal = hasSignal ? values[expected] : undefined;assertSignal(callerSignal);
    const signal = callerSignal === undefined ? item.abort.signal : AbortSignal.any([item.abort.signal,callerSignal]);
    try {
      const result = await connection.rpc.call('/api',endpoint,{args},signal);
      if (!item.active) return withdrawn(endpoint);
      signal.throwIfAborted();
      if (!result.ok) return {ok:false,error:new RemoteError(result.error.code,result.error.message,result.error.details)};
      return {ok:true,value:descriptor.result.mode === 'strict' && typeof descriptor.result.decode === 'function' ? descriptor.result.decode(result.value) : result.value};
    } catch(error) {
      if (!item.active) return withdrawn(endpoint);
      if (signal.aborted) return failed('gateway/cancelled',`client api: Remote invocation "${endpoint}" was aborted`,error);
      return failed('gateway/internal',`client api: ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`,error);
    }
  }
  if (builtins) for (const contribution of BUILTIN_REMOTE_CONTRIBUTIONS) mount(contribution);
  const remote = faceFor(context);
  return {connection,remote,forContext:faceFor,lookup(name,caller=context) {
    if (name === 'connection') return connection;
    if (name === 'remote') return faceFor(caller);
    if (typeof name === 'string' && name.startsWith('remote.')) return faceFor(caller)[name.slice(7)];
    return undefined;
  },dispose() {
    if (disposed) return;disposed = true;
    for (const subscription of subscriptions) subscription.active = false;
    subscriptions.clear();stopPolling();
    for(const stream of streams)stream.dispose();streams.clear();
    for (const additions of packages.values()) for (const item of additions) {item.active = false;item.abort.abort();}
    packages.clear();namespaces.clear();syncFaces();faces.clear();
  }};
}
