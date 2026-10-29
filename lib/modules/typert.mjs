import {backendError,validSegment} from './connection.mjs';
import {isRemoteJson,projectBinary,hydrateAttachments} from '../../ui/transport.mjs';
const bridgeKey=Symbol('claude-ui-typert-dispatch');
const sourceFibers=new WeakSet();
const blocked=new Set(['__proto__','prototype','constructor','then']);
export const descriptor={id:'typert',displayName:'插件宣告的遠端方法',services:['typert'],requires:{capabilities:[]},methods:{register:{support:'partial',reason:'實際登記一般方法、二進位結果及雙向串流，沿用官方情境與物件查找登記服務'},invoke:{support:'partial',reason:'執行插件明確公開的方法，依實際轉接器解析情境與物件，支援取消與 invocation 上行串流'}},requirements:[]};
export function markUiSourceContext(context){if(context?.fiber)sourceFibers.add(context.fiber);}
function isSourceFiber(fiber){const seen=new Set();while(fiber&&!seen.has(fiber)){if(sourceFibers.has(fiber))return true;seen.add(fiber);fiber=fiber.parent?.fiber;}return false;}
function safeName(value){return validSegment(value)&&!blocked.has(value);}
function failure(code,message){return {ok:false,error:{code,message,details:{}}};}
function jsonValue(value,seen=new Set()){
  if(value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value))return true;
  if(!value||typeof value!=='object'||seen.has(value)||!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
  seen.add(value);const valid=Object.values(value).every(item=>jsonValue(item,seen));seen.delete(value);return valid;
}
function parseCodec(codec,value){
  if(codec?.mode==='src-json'){if(value!==undefined&&!jsonValue(value))throw new TypeError('Expected JSON');return value;}
  if(codec?.mode!=='strict')throw backendError('這個方法沒有可用的參數驗證器。','UI_BACKEND_UNSUPPORTED');
  const schema=codec.create?.()??codec.schema;
  if(typeof schema?.parse!=='function')throw backendError('這個方法沒有可用的參數驗證器。','UI_BACKEND_UNSUPPORTED');
  return schema.parse(value);
}
export async function install({root,load}){
  const {TypertRegistry}=await load('@deepseek-ai/dsh-typert-registry');
  const {remoteMethods}=await load('@deepseek-ai/dsh-typert-protocol');
  const typescript=await load('typescript'),ts=typescript.default??typescript;
  const local=new Map(),seen=new Set(),listeners=new Set();
  let disposed=false;
  const notify=key=>{for(const listener of listeners)try{listener({kind:'local',key});}catch{}};
  class Typert extends TypertRegistry{
    constructor(ctx){super(ctx);}
    register(manifest){
      const owner=this.ctx;
      if(!manifest||typeof manifest.package!=='string'||!Array.isArray(manifest.invocations))throw backendError('無效的插件遠端宣告。','UI_BACKEND_INVALID');
      const descriptors=manifest.invocations.map(item=>{
        if(!item||!safeName(item.namespace)||!safeName(item.method)||!safeName(item.service)||!Array.isArray(item.parameters))throw backendError('無效的插件遠端方法。','UI_BACKEND_INVALID');
        return {...item,parameters:item.parameters.map(parameter=>({...parameter,wire:parameter.wire??parameter.name,source:parameter.source??'json'}))};
      });
      return owner.effect(()=>{
        const keys=new Set();for(const item of descriptors){const key=item.namespace+'/'+item.method;if(local.has(key)||keys.has(key))throw backendError('插件遠端方法已登記。','UI_BACKEND_DUPLICATE');keys.add(key);}
        const rows=descriptors.map(descriptor=>({descriptor,owner}));
        for(const row of rows){const key=row.descriptor.namespace+'/'+row.descriptor.method;local.set(key,row);seen.add(key);notify(key);}
        return()=>{for(const row of rows){const key=row.descriptor.namespace+'/'+row.descriptor.method;if(local.get(key)===row){local.delete(key);notify(key);}}};
      },'claude-ui: typert '+manifest.package);
    }
    get local(){const owner=this.ctx;return {get:key=>local.get(key)?.descriptor,hasSeen:key=>seen.has(key),list:()=>[...local.values()].map(row=>row.descriptor),subscribe:listener=>owner.effect(()=>{listeners.add(listener);return()=>listeners.delete(listener);})};}
  }
  let service;
  const fork=root.plugin({name:'claude-ui-typert',apply(ctx){service=new Typert(ctx);}});await fork.await();
  function sources(){
    const values=[];
    for(const impl of Reflect.ownKeys(root.reflect.store??{}).map(key=>root.reflect.store[key])){
      if(!impl||!isSourceFiber(impl.fiber)||impl.fiber.state!==2)continue;
      const value=impl.value,binding=value?.typertRemote;
      if(!binding||binding.service!==value||binding.serviceKey!==impl.name||!safeName(binding.namespace))continue;
      values.push({key:impl.name,value,binding});
    }
    return values;
  }
  async function execute({namespace,method,args},signal=new AbortController().signal,stream=false,uplink,peer){
    if(disposed)throw backendError('插件遠端服務已結束。','DISPOSED');
    if(!safeName(namespace)||!safeName(method)||!Array.isArray(args)&&(!args||typeof args!=='object'))throw backendError('無效的插件遠端請求。','UI_BACKEND_INVALID');
    if(signal.aborted)throw backendError('插件請求已取消。','HOST_CANCELED');
    const registered=local.get(namespace+'/'+method);
    if(!registered&&seen.has(namespace+'/'+method))return stream?Promise.reject(backendError('這個方法的嚴格宣告已卸載。','gateway/definition-unavailable')):failure('gateway/definition-unavailable','這個方法的嚴格宣告已卸載。');
    if(registered&&!isSourceFiber(registered.owner.fiber))throw backendError('這個遠端方法不屬於插件。','UI_BACKEND_NOT_REGISTERED');
    const source=sources().find(item=>item.binding.namespace===namespace&&(!registered||item.key===registered.descriptor.service));
    if(!source)throw backendError('插件未提供這個遠端服務。','UI_BACKEND_NOT_REGISTERED');
    const marker=remoteMethods(source.value).find(item=>(item.exportName??item.method)===method);
    let definition=registered?.descriptor??(marker?{...marker,implementation:marker.method}:undefined);
    if(!definition)throw backendError('插件未公開這個遠端方法。','UI_BACKEND_NOT_REGISTERED');
    const fail=(code,message)=>{if(stream)throw backendError(message,code);return failure(code,message);};
    if(!['direct','context'].includes(definition.invocation?.kind))return fail('gateway/signature-invalid','遠端方法的接收範圍宣告無效。');
    if((definition.mode==='stream')!==stream)return fail('gateway/signature-invalid',stream?'一般遠端方法不能使用串流通道。':'串流遠端方法必須使用串流通道。');
    const implementation=definition.implementation??definition.method;
    if(!safeName(implementation)||typeof source.value[implementation]!=='function')throw backendError('插件遠端實作不存在。','UI_BACKEND_NOT_REGISTERED');
    let values,receiverContext=root,wireArgs=args;
    try{
      if(!registered){
          // Source-mode Remote derives lookup wires from the actual signature
          // and live official provider declarations, exactly as the Gateway.
          const text=Function.prototype.toString.call(source.value[implementation]);
          const file=ts.createSourceFile('remote-source.ts','class RemoteSource { '+text+' }',ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
          const methodNode=file.statements[0]?.members?.[0];
          if(file.parseDiagnostics.length||!methodNode?.parameters)throw new TypeError('Unsupported source signature');
          const names=methodNode.parameters.map(parameter=>{if(!ts.isIdentifier(parameter.name)||parameter.dotDotDotToken)throw new TypeError('Unsupported source parameter');return parameter.name.text;});
          const cancellation=names.at(-1)==='signal'?{parameter:names.pop()}:undefined;
          const parameters=names.map(name=>{const matches=service.lookups.definitions().filter(provider=>provider.parameter===name);if(matches.length>1)throw backendError('來源參數符合多個物件查找宣告。','gateway/signature-invalid');const lookup=matches[0];return {name,wire:lookup?.wire??name,source:lookup?'lookup':'json',...(lookup?{lookup:lookup.key}:{}),codec:{mode:'src-json'}};});
          let invocation=definition.invocation;
          if(invocation.kind==='context'){const adapter=service.contexts.getHost(invocation.context);if(!adapter)throw backendError('遠端方法的情境轉接器尚未登記。','gateway/context-unavailable');invocation={...invocation,wire:adapter.wire,codec:{mode:'src-json'}};}
          definition={...definition,parameters,invocation,...(cancellation?{cancellation}: {})};
      }
      const params=definition.parameters,contextInvocation=definition.invocation.kind==='context'?definition.invocation:undefined;
      if(Array.isArray(args)){if(contextInvocation)throw backendError('情境遠端方法需要具名範圍識別碼。','gateway/bad-request');if(args.length>params.length)throw new TypeError('Too many arguments');wireArgs=Object.fromEntries(params.map((param,index)=>[param.wire,args[index]]));}
      const allowed=new Set([...params.map(item=>item.wire),...(contextInvocation?[contextInvocation.wire]:[])]);
      if(Object.keys(wireArgs).some(key=>!allowed.has(key)))throw new TypeError('Unknown argument');
      const validated=new Map(params.map(param=>[param.wire,parseCodec(param.codec,wireArgs[param.wire])]));
      if(contextInvocation){
        const provider=service.contexts.getHost(contextInvocation.context);if(!provider)throw backendError('遠端方法的情境轉接器尚未登記。','gateway/context-unavailable');
        if(provider.wire!==contextInvocation.wire||contextInvocation.codec.mode==='strict'&&provider.wireTypeSymbol!==contextInvocation.codec.typeSymbol)throw backendError('情境轉接器的型別或傳輸欄位與方法不符。','gateway/provider-mismatch');
        const identity=parseCodec(contextInvocation.codec,wireArgs[contextInvocation.wire]);
        try{receiverContext=await provider.resolve(identity);}catch(error){throw backendError(error.message??'情境解析失敗。',error.code??'gateway/context-failed');}
        if(!receiverContext)throw backendError('找不到指定的情境。','gateway/context-not-found');
      }
      values=await Promise.all(params.map(async param=>{
        const value=validated.get(param.wire);if(param.source==='json'||!Object.hasOwn(wireArgs,param.wire))return value;
        if(param.source!=='lookup')throw backendError('遠端參數來源無效。','gateway/signature-invalid');
        const provider=service.lookups.get(param.lookup);if(!provider)throw backendError('遠端參數的物件查找服務尚未登記。','gateway/lookup-unavailable');
        if(provider.wire!==param.wire||param.codec.mode==='strict'&&provider.wireTypeSymbol!==param.codec.typeSymbol)throw backendError('物件查找服務的型別或傳輸欄位與方法不符。','gateway/provider-mismatch');
        let resolved;try{resolved=await provider.resolve(value);}catch(error){throw backendError(error.message??'物件查找失敗。',error.code??'gateway/lookup-failed');}
        if(resolved===undefined)throw backendError('找不到指定的物件。','gateway/lookup-not-found');return resolved;
      }));
    }catch(error){if(error.code==='UI_BACKEND_UNSUPPORTED')return fail('gateway/unsupported',error.message);return fail(error.code??'gateway/bad-request',error.code?error.message:'插件參數驗證失敗。');}
    const control=new AbortController(),lifetime=AbortSignal.any([signal,control.signal]);let taken=false,input;
    if(definition.cancellation)values.push(lifetime);
    const empty={async *[Symbol.asyncIterator](){}},carrier=uplink??empty;
    const invocation={request:{namespace,method,args:wireArgs},service:source.key,peer:peer??root.get('connection')?.browserPeer,signal:lifetime,uplink(){
      if(taken)throw backendError('每次遠端呼叫的上行串流只能讀取一次。','gateway/protocol');taken=true;
      const sourceIterator=carrier[Symbol.asyncIterator]();input={
        async next(){try{
          const next=await abortable(sourceIterator.next(),lifetime);if(next.done)return next;
          const value=definition.uplink?parseCodec(definition.uplink.codec,next.value):next.value;
          if(!definition.uplink&&value!==undefined&&!isRemoteJson(value))throw backendError('串流上行項目必須是無損 JSON。','gateway/bad-request');
          return {done:false,value};
        }catch(error){control.abort(error);throw error;}},
        async return(){return await sourceIterator.return?.()??{done:true};},
        [Symbol.asyncIterator](){return this;},
      };return input;
    }};
    const closeInput=async()=>{taken=true;await (input??carrier[Symbol.asyncIterator]()).return?.();};
    const receiver=receiverContext.extend({invocation}).get(source.key);
    if(!receiver||typeof receiver[implementation]!=='function'){await closeInput();return fail('gateway/service-unavailable','指定情境沒有可用的遠端服務實作。');}
    try{
      let value=Reflect.apply(receiver[implementation],receiver,values);
      if(stream){
        if(!value?.[Symbol.asyncIterator]&&!value?.[Symbol.iterator]){await closeInput();throw backendError('串流遠端方法必須傳回可迭代物件。','gateway/result-invalid');}
        const iterator=(value[Symbol.asyncIterator]??value[Symbol.iterator]).call(value);
        return (async function*(){try{while(true){
          const next=await abortable(iterator.next(),lifetime);if(next.done)return;yield next.value;
        }}catch(error){throw backendError(error.message??'插件串流執行失敗。',lifetime.aborted?(lifetime.reason?.code??'gateway/cancelled'):(error.code??'gateway/internal'));}
        finally{control.abort();await closeInput();await iterator.return?.();}})();
      }
      value=await value;
      if(registered)value=parseCodec(definition.result,value);
      const attachments=[],write=(bytes,path)=>{attachments.push({bytes,path:[...path]});return null;};
      const metadata=definition.result?.mode==='strict'&&typeof definition.result.encode==='function'?definition.result.encode(value,write):projectBinary(value,write);
      if(metadata!==undefined&&!jsonValue(metadata))return failure('gateway/unsupported','此方法的結果無法轉換為 JSON 與二進位附件。');
      return {ok:true,value:attachments.length?hydrateAttachments(metadata,attachments):metadata};
    }catch(error){return fail(signal.aborted?'gateway/cancelled':error.code??'gateway/internal',error.message??'插件方法執行失敗。');}
    finally{if(!stream)await closeInput();}
  }
  Object.defineProperty(service,bridgeKey,{value:{call:(params,signal)=>execute(params,signal),open:(params,signal,uplink,peer)=>execute(params,signal,true,uplink,peer),describe:()=>({methods:[...local.keys()],sourceServices:sources().map(item=>({namespace:item.binding.namespace,service:item.key,methods:remoteMethods(item.value).map(marker=>marker.exportName??marker.method)}))})}});
  return {services:{typert:service},diagnostics:[],async dispose(){disposed=true;local.clear();listeners.clear();await fork.dispose();}};
}
export function callTypert(service,params,signal){const bridge=service?.[bridgeKey];if(!bridge)throw backendError('插件遠端服務未啟用。');return bridge.call(params,signal);}
export function openTypert(service,params,signal,uplink,peer){const bridge=service?.[bridgeKey];if(!bridge)throw backendError('插件遠端服務未啟用。');return bridge.open(params,signal,uplink,peer);}
export function describeTypert(service){return service?.[bridgeKey]?.describe()??{methods:[],sourceServices:[]};}
function abortable(value,signal){return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason??backendError('遠端呼叫已取消。','gateway/cancelled'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();Promise.resolve(value).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});}

