/** Child host of the Claude Code mod: official DSH host + JSON lines on stdout + loopback JSON-RPC. */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {existsSync,realpathSync} from 'node:fs';
import {loadDshHost,permissionFlag} from '../dsh-host.mjs';
import {createExecRunner,findExecutable} from '../modules/claude/exec-support.mjs';
import {blockedText} from '../modules/claude/blocked.mjs';
import {createWin32FsOps} from './win32-fs.mjs';
import {describeStartupFailure,sanitizeLine} from './cause.mjs';
import {createReverseChannel} from './reverse.mjs';
import {createCliEndpoint} from './cli-endpoint.mjs';
import {createToolCatalog,shapeContent} from './tools.mjs';
import {createClaudeUi} from './ui.mjs';

export const DEFAULT_SERVICES=Object.freeze(['timer','fs','settings','webServer','commands','skills']);
const MAX_BODY=8*1024*1024;

export class RpcError extends Error{constructor(code,message){super(message);this.code=code;}}

/** Persistent state never lives in the plugin cache (replaced on update) and never in ~/.claude. */
export function resolveClaudeState({root,settings={},env=process.env,home=os.homedir()}){
  const own=settings.claudeHost?.stateDir;
  if(typeof own==='string'&&path.isAbsolute(own))return own;
  if(settings.stateMode==='package'||!settings.stateId)return path.resolve(root,'.state');
  if(!/^[a-z0-9][a-z0-9-]{0,100}$/.test(settings.stateId))throw new TypeError('Invalid stable plugin state identity');
  const base=env.DSH_CLAUDE_STATE_ROOT||settings.claudeHost?.stateRoot||path.join(home,'.dsh-to-claude','state');
  if(!path.isAbsolute(base))throw new TypeError('The persistent state root must be an absolute path');
  return path.join(base,settings.stateId);
}
const resolveFrom=(root,value)=>typeof value==='string'&&value?path.resolve(root,value):undefined;
const ENV_NAME=/^[A-Za-z_][A-Za-z0-9_]*$/;
/** The blocks a tool call hit (worker `execute` answer or error details): kind, code and the "what" line only, never a value. */
export function callBlocks(value){
  if(!Array.isArray(value))return [];
  return value.filter(row=>row&&typeof row==='object'&&typeof row.kind==='string'&&row.kind).slice(0,8).map(row=>({kind:row.kind.slice(0,40),code:typeof row.code==='string'?row.code.slice(0,60):'',what:typeof row.what==='string'?sanitizeLine(row.what,400):''}));
}

/** `DSH_CLAUDE_SECRET_NAMES` (set by the mod from the plugin's secret options): names only, comma separated. */
export function secretNames(env=process.env){
  return [...new Set(String(env.DSH_CLAUDE_SECRET_NAMES??'').split(',').map(name=>name.trim()).filter(name=>ENV_NAME.test(name)&&!/^DSH_/i.test(name)&&!/^(?:NODE_OPTIONS|NODE_PATH|PATH|PATHEXT)$/i.test(name)))];
}
/** `DSH_CLAUDE_EXTRA_FOLDERS`: absolute folders separated by `;`. Relative entries are ignored (reported back). */
export function extraFolders(env=process.env){
  const accepted=[],ignored=[];
  for(const raw of String(env.DSH_CLAUDE_EXTRA_FOLDERS??'').split(';').map(item=>item.trim().replace(/^"(.*)"$/,'$1')).filter(Boolean)){
    if(path.isAbsolute(raw))accepted.push(path.resolve(raw));else ignored.push(raw);
  }
  return {accepted:[...new Set(accepted)],ignored};
}
const withReal=list=>{const out=new Set();for(const item of list){if(!item)continue;out.add(path.resolve(item));try{out.add(realpathSync.native(item));}catch{}}return [...out];};

/** Node permission model for the worker (SECURITY-PLAN.md agreement 6). Returns { permission, info }. */
export function sandboxPlan({root,stateDir,workspace,runtimeRoot,workerPath,sourceNodePaths=[],settings={},env=process.env,flag=permissionFlag()}){
  const options=settings.claudeHost??{};
  const direct=env.DSH_CLAUDE_ALLOW_DIRECT_EXEC==='1';
  const extra=extraFolders(env);
  if(options.sandbox===false)return {permission:null,info:{enabled:false,reason:'runtime/settings.json 的 claudeHost.sandbox 是 false（權限限制已關閉）',allowDirectExec:direct,extraFolders:extra.accepted}};
  if(!flag)return {permission:null,info:{enabled:false,reason:'此電腦的 Node 版本不支援權限限制',nodeVersion:process.version,allowDirectExec:direct,extraFolders:extra.accepted}};
  const read=withReal([root,stateDir,workspace,runtimeRoot,path.dirname(workerPath),...sourceNodePaths,...extra.accepted]);
  const write=withReal([stateDir,workspace,...extra.accepted]);
  // Native addons and WASI can do anything the user can, so they follow the "run programs directly" switch.
  const permission={read,write,childProcess:direct,worker:direct,addons:direct,wasi:direct};
  return {permission,info:{enabled:true,flag,read,write,allowDirectExec:direct,addons:direct,worker:direct,extraFolders:extra.accepted,...(extra.ignored.length?{ignoredExtraFolders:extra.ignored}:{})}};
}

/** Split a worker log chunk into bounded, sanitized lines. */
function logLines(text,limit=40){
  return String(text??'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean).slice(0,limit).map(line=>sanitizeLine(line,2000));
}

/**
 * Start the host. `emit(line)` writes one protocol object to stdout.
 * Resolves with {ready, rpc, server, shutdown, done}; rejects with an error that carries `.fatal`.
 */
export async function startClaudeHost({root,settings,emit,env=process.env}){
  const options=settings.claudeHost??{};
  const token=randomBytes(32).toString('hex');
  const reverse=createReverseChannel({emit,timeouts:options.reverseTimeoutMs&&typeof options.reverseTimeoutMs==='object'?options.reverseTimeoutMs:{}});
  const catalog=createToolCatalog();
  const calls=new Map();
  let loaded,cli,server,execRunner,pluginUi,transientLogs='',started=false,state='starting',shutdownPromise,finish;
  const done=new Promise(resolve=>{finish=resolve;});
  const log=(level,text)=>{try{emit({type:'log',level,text:sanitizeLine(text,2000)});}catch{}};
  const notify=(level,text)=>{reverse.request('ui.notify',{level,text:sanitizeLine(text,500)}).catch(()=>{});};
  const logger=({stream,text})=>{
    if(!started)transientLogs=(transientLogs+text).slice(-65536);
    for(const line of logLines(text))log(stream==='stderr'?'warn':'info',line);
  };
  const fail=cause=>{
    const detail=describeStartupFailure(cause,transientLogs,{settings,env});
    // A start-up block is also a notice (agreement 5); the reply never comes because the host ends, which is fine for ui.notify.
    if(detail.blocked){try{emit({type:'request',id:'startup-blocked',method:'ui.notify',params:{level:'warning',text:blockedText(detail.blocked),blocked:{kind:detail.blocked.kind,code:detail.blocked.code}}});}catch{}}
    return Object.assign(new Error(detail.message),{fatal:{code:detail.code,message:detail.message,...(detail.services.length?{services:detail.services}:{}),...(detail.missing?.length?{missing:detail.missing}:{})}});
  };
  let sandbox={enabled:false};
  const hostRestrictions=[];
  try{
    if(options.uiOnly){
      // A frontend-only package has no backend; do not fabricate routes or settings.
      loaded={tools:[],metadata:{host:'claude-ui-only',services:[]},describe:async()=>({name:settings.name,backend:false,uiOnly:true}),onToolsChanged(){},dispose:async()=>{},request:async(method)=>{if(method==='settings.describe'||method==='prompt.sections'||method==='restrictions')return [];if(method==='routes')return null;throw new Error('這個插件只提供畫面，沒有註冊這項後端功能：'+method);}};
    }else{
    const source=path.resolve(root,'source');
    const runtimeRoot=resolveFrom(root,options.runtimeRoot)??path.resolve(root,'runtime/host-env');
    const workerPath=resolveFrom(root,options.workerPath)??path.resolve(root,'runtime/dsh-host-worker.mjs');
    const stateDir=resolveClaudeState({root,settings,env});
    const workspaceEnv=env.DSH_CLAUDE_WORKSPACE;
    const workspace=settings.workspace?path.resolve(root,settings.workspace):workspaceEnv&&path.isAbsolute(workspaceEnv)?workspaceEnv:path.resolve(source,settings.packageDir??'.');
    if(typeof settings.entry!=='string'||!settings.entry)throw Object.assign(new Error('runtime/settings.json has no "entry"'),{code:'SETTINGS_INVALID'});
    // `dsh` stand-in: loopback endpoint + PATH/endpoint/token for the plugin's own `dsh` child processes (null when not installed).
    cli=await createCliEndpoint({root,reverse,log,options,env});
    const sourceNodePaths=(settings.sourceNodePaths??[]).map(dir=>path.resolve(root,dir));
    const plan=sandboxPlan({root,stateDir,workspace,runtimeRoot,workerPath,sourceNodePaths,settings,env});
    sandbox=plan.info;
    if(!sandbox.enabled&&sandbox.reason)hostRestrictions.push({kind:'sandbox-unavailable',code:'SANDBOX_UNAVAILABLE',what:'插件沒有在權限限制下執行',why:sandbox.reason,how:sandbox.reason.includes('Node')?'把 Node.js 更新到 22.13 以上（或 23.5 以上）':'把 claudeHost.sandbox 改回 true 或刪除這個欄位',impact:'插件可以讀寫這台電腦上目前使用者能讀寫的所有檔案、直接執行程式',count:1});
    for(const item of sandbox.ignoredExtraFolders??[])log('warn',`DSH_CLAUDE_EXTRA_FOLDERS: ignored a folder that is not an absolute path (${item.slice(0,200)})`);
    const pluginLabel=typeof settings.name==='string'&&settings.name?settings.name:null;
    // Programs (shell / subprocess services) run here, not in the worker: the folder check and exec.check happen in this process.
    execRunner=createExecRunner({requestHost:(method,params,execution)=>reverse.request(method,params,execution),workspace,plugin:pluginLabel});
    // Secrets the mod passes from the plugin's sensitive options join the worker's environment allow list (values are never logged).
    const passEnv=[...new Set([...(Array.isArray(settings.passEnv)?settings.passEnv:[]),...secretNames(env)])];
    loaded=await loadDshHost({
      ...settings,passEnv,
      ...(cli?{env:{...(settings.env&&typeof settings.env==='object'?settings.env:{}),...cli.env}}:{}),
      ...(plan.permission?{permission:plan.permission}:{}),
      ...(pluginLabel?{pluginLabel}:{}),
      execHandler:(spec,emitEvent)=>execRunner.start(spec,emitEvent),
      localRequests:{...(plan.permission?{'fs.win32':createWin32FsOps({runtimeRoot,writeFolders:plan.permission.write})}:{}),async 'exec.resolveExecutable'(params){const command=typeof params?.command==='string'?params.command:'';if(!command)return {path:null};return {path:findExecutable(command,{PATH:String(params?.env?.PATH??''),PATHEXT:String(params?.env?.PATHEXT??'')||process.env.PATHEXT||''})};}},
      entry:path.resolve(source,settings.entry),sourceRoot:source,
      sourceNodePaths,
      workspace,stateDir,runtimeRoot,workerPath,config:settings.config??{},
      precompiledEntry:resolveFrom(root,options.precompiledEntry)??path.resolve(root,'runtime','plugin.mjs'), // the worker ignores it when the file is absent

      services:settings.services??[...DEFAULT_SERVICES],
      uiBackend:existsSync(path.join(root,'runtime/ui/manifest.json')),bridgeRequest:(method,params,execution)=>reverse.request(method,params,execution),logger,
    });
    }
  }catch(cause){
    reverse.close();
    try{execRunner?.dispose();}catch{}
    try{await cli?.close();}catch{}
    throw cause?.fatal?cause:fail(cause);
  }
  started=true;transientLogs='';

  const allowed=Array.isArray(settings.allowTools)&&settings.allowTools.length?new Set(settings.allowTools):null;
  const currentTools=()=>loaded.tools.filter(tool=>!allowed||allowed.has(tool.name));
  const describeTools=()=>catalog.describe(currentTools());
  const pluginName=options.pluginName??env.DSH_CLAUDE_PLUGIN_NAME??null;
  const ownPrefix=pluginName?`mcp__${pluginName}__`:null;

  const readPrompt=async()=>{try{return await loaded.request('prompt.sections');}catch(cause){log('warn',`prompt sections unavailable: ${cause.message}`);return [];}};
  let promptSections=await readPrompt(),promptKey=JSON.stringify(promptSections),promptTimer;
  loaded.onToolsChanged(()=>{try{emit({type:'toolsChanged',tools:describeTools()});}catch{}});
  loaded.onPromptChanged?.(()=>{
    clearTimeout(promptTimer);
    promptTimer=setTimeout(async()=>{
      if(state!=='ready')return;
      const next=await readPrompt(),key=JSON.stringify(next);
      if(key===promptKey)return;
      promptSections=next;promptKey=key;
      try{emit({type:'promptChanged',promptSections:next});}catch{}
    },50);
    promptTimer.unref?.();
  });

  const metadata=loaded.metadata??{};
  const listeners=metadata.claude?.listeners??{preExecute:0,postExecute:0};
  // Interception (agreement 3/5): only when the person turned on allowInterception; otherwise always false, with a note.
  const interceptionWanted=settings.interception===true||options.interception===true||listeners.preExecute+listeners.postExecute>0;
  const interceptionAllowed=env.DSH_CLAUDE_ALLOW_INTERCEPTION==='1';
  const interception=interceptionWanted&&interceptionAllowed;
  if(interceptionWanted&&!interceptionAllowed)hostRestrictions.push({kind:'interception-off',code:'INTERCEPTION_DISABLED',what:`${settings.name?`「${settings.name}」插件`:'這個插件'}有監督 Claude 工具使用的功能（攔截監聽器）`,why:'插件有攔截監聽器但使用者沒有開啟；預設關閉',how:'在插件選項開啟「允許攔截 Claude Code 的工具」（allowInterception），然後重新啟動插件；開啟後插件也只能擋下工具，不能改寫輸入',impact:'插件的工具監督規則（tools/pre-execute、tools/post-execute）不會作用',count:1});
  const commands=metadata.claude?.commands??[];
  const summary={
    host:metadata.host,versions:metadata.versions,services:metadata.services??[],unsupported:metadata.unsupported??[],
    modules:(metadata.modules??[]).map(row=>({id:row.id,status:row.runtimeStatus??row.status,reason:row.reason??null})),
    moduleDiagnostics:(metadata.moduleDiagnostics??[]).map(item=>({module:item.module,level:item.level??null,code:item.code??null,reason:typeof item.reason==='string'?item.reason:null})),
    lazyDependencies:metadata.lazyDependencies??[],compat:metadata.compat??[],listeners,pluginName:settings.name??null,dshCli:Boolean(cli),
    sandbox,
    interceptionState:{wanted:interceptionWanted,allowed:interceptionAllowed,enabled:interception,...(interceptionWanted&&!interceptionAllowed?{note:'插件有攔截監聽器但使用者沒有開啟（插件選項 allowInterception）'}:{})},
    secretNames:secretNames(env),
    restricted:hostRestrictions,
  };
  state='ready';

  const toolResult=async({name,args,callId},signal)=>{
    const tool=catalog.find(currentTools(),name);
    if(!tool)throw new RpcError('TOOL_NOT_FOUND',`Unknown tool: ${String(name).slice(0,100)}`);
    const id=typeof callId==='string'&&callId?callId:randomUUID();
    if(calls.has(id))throw new RpcError('CALL_ID_IN_USE','callId is already running');
    const controller=new AbortController();calls.set(id,controller);
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    try{
      const result=await tool.execute(args&&typeof args==='object'?args:{},{callId:id,signal:controller.signal});
      const blocked=callBlocks(result.blocked);
      return {content:shapeContent(result.content),isError:Boolean(result.isError),...(blocked.length?{blocked}:{})};
    }catch(cause){
      const code=cause?.code??'TOOL_FAILED';
      if(['HOST_TIMEOUT','HOST_RESTARTED','HOST_EXITED'].includes(code))notify('warning',`DSH tool ${tool.name}: ${cause.message}`);
      const blocked=callBlocks(cause?.details?.blocked);
      return {content:[{type:'text',text:`${code}: ${sanitizeLine(cause?.message??cause)}`}],isError:true,code,...(blocked.length?{blocked}:{})};
    }finally{signal?.removeEventListener('abort',abort);calls.delete(id);}
  };

  const intercepts=tool=>interception&&!(ownPrefix&&typeof tool==='string'&&tool.startsWith(ownPrefix));
  const needText=(value,label)=>{if(typeof value!=='string'||!value)throw new RpcError('INVALID_PARAMS',`${label} must be a non-empty string`);return value;};

  const uiRpc=async(method,params={},execution={})=>{
    if(method==='describe')return loaded.describe();
    if(method==='getTools')return currentTools().map(({execute,...schema})=>schema);
    if(method==='execute'){
      const tool=catalog.find(currentTools(),params.name);
      if(!tool)throw new RpcError('TOOL_NOT_FOUND','這個插件沒有啟用工具「'+params.name+'」。');
      // Re-enter the mod's existing tool pipeline, including posting confirmation and masking.
      return reverse.request('ui.execute',{name:tool.name,args:params.args??{} },execution);
    }
    if(method==='settings.update')return loaded.request(method,{namespace:params.ns,values:params.patch,expectedRevision:params.revision});
    // The signal travels with browser-screen calls so a closed page cancels the host operation (long reads, streams).
    return loaded.request(method,params,execution);
  };
  pluginUi=await createClaudeUi({root,rpc:uiRpc,onNotice:notice=>notify('warning',blockedText({what:'原插件畫面的一項操作未能完成',why:notice.message,how:'請在插件畫面查看「目前未接上的功能」，修正所列設定；缺少服務時需更新轉換器',impact:'這次操作未完成，其他已接好的頁面與工具仍可使用'}))});
  summary.ui=pluginUi?.describe()??{available:false};
  const methods={
    async 'ui.open'(){if(!pluginUi)throw new RpcError('UI_UNAVAILABLE','這個插件沒有可開啟的畫面。');return pluginUi.open();},
    async 'ui.status'(){return pluginUi?.describe()??{available:false};},
    async 'tools.call'(params,signal){return toolResult({name:needText(params.name,'name'),args:params.args,callId:params.callId},signal);},
    async 'tools.cancel'(params){calls.get(params.callId)?.abort();return {};},
    // What happened in the Claude Code conversation (lib/modules/claude/conversation.mjs); the mod sends it only to plugins that listen.
    async 'session.event'(params){return loaded.request('session.event',params&&typeof params==='object'?params:{});},
    async 'commands.run'(params){
      const result=await loaded.request('commands.run',{name:needText(params.name,'name'),args:typeof params.args==='string'?params.args:Array.isArray(params.args)?params.args.join(' '):''});
      return {text:result.text??''};
    },
    async 'interception.pre'(params){
      const tool=needText(params.tool,'tool');
      if(!intercepts(tool))return {decision:'allow'};
      // Only allow / deny travel back: a plugin may block a Claude Code tool, never rewrite its input.
      try{const verdict=await loaded.request('interception.pre',{tool,input:params.input??{},...(params.callId?{callId:String(params.callId)}:{}),...(params.sessionId?{sessionId:String(params.sessionId)}:{})});return verdict?.decision==='allow'?{decision:'allow'}:{decision:'deny',reason:typeof verdict?.reason==='string'&&verdict.reason?verdict.reason:'DSH 插件攔截規則拒絕這次工具操作'};}
      catch(cause){return {decision:'deny',reason:`DSH interception host failed (${cause?.code??'error'}); the tool call was refused`};}
    },
    async 'interception.post'(params){
      const tool=needText(params.tool,'tool');
      if(!intercepts(tool))return {};
      try{return await loaded.request('interception.post',{tool,input:params.input??{},result:params.result??null,...(params.callId?{callId:String(params.callId)}:{}),...(params.sessionId?{sessionId:String(params.sessionId)}:{})});}
      catch(cause){return {result:{content:[{type:'text',text:`The tool already ran, but the DSH interception host could not check its result (${cause?.code??'error'}); side effects cannot be undone.`}],isError:true}};}
    },
    async reply(params){reverse.reply(params);return {};},
    async status(){
      let found=[];try{found=await loaded.request('restrictions');}catch{}
      return {state,plugin:settings.name??null,tools:describeTools().map(tool=>tool.name),services:summary.services,unsupported:summary.unsupported,activeCalls:calls.size,pendingReverseRequests:reverse.size,
        sandbox:{enabled:sandbox.enabled===true,...(sandbox.reason?{reason:sandbox.reason}:{}),allowDirectExec:sandbox.allowDirectExec===true,extraFolders:sandbox.extraFolders??[]},
        // 目前受限的功能: what is blocked right now and how to allow it.
        ui:pluginUi?.describe()??{available:false},restricted:[...hostRestrictions,...(Array.isArray(found)?found:[])]};
    },
    async dispose(){setTimeout(()=>void shutdown(),20).unref?.();return {};},
  };
  let idleTimer;
  const touch=()=>{
    if(!(options.idleExitMs>0))return;
    clearTimeout(idleTimer);idleTimer=setTimeout(()=>{log('info','idle timeout reached; shutting down');void shutdown();},options.idleExitMs);idleTimer.unref?.();
  };
  touch();
  const rpc=async(method,params={},signal)=>{
    touch();
    const handler=Object.hasOwn(methods,method)?methods[method]:null;
    if(!handler)throw new RpcError('METHOD_NOT_FOUND',`Unknown method: ${String(method).slice(0,60)}`);
    if(params===null||typeof params!=='object'||Array.isArray(params))throw new RpcError('INVALID_PARAMS','params must be an object');
    return handler(params,signal);
  };

  const expected=Buffer.from(token);
  server=http.createServer((req,res)=>{
    const send=(status,body)=>{const text=body===undefined?'':JSON.stringify(body);res.writeHead(status,{'content-type':'application/json','content-length':Buffer.byteLength(text)});res.end(text);};
    const provided=Buffer.from(String(req.headers.authorization??'').replace(/^Bearer /,''));
    if(provided.length!==expected.length||!timingSafeEqual(provided,expected)){send(401,{error:{code:'UNAUTHORIZED',message:'A valid bearer token is required'}});req.resume();return;}
    if(req.method!=='POST'||req.url!=='/rpc'){send(req.url==='/rpc'?405:404,{error:{code:'NOT_FOUND',message:'Use POST /rpc'}});req.resume();return;}
    const chunks=[];let size=0,aborted=false;
    const controller=new AbortController();
    res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    req.on('data',chunk=>{size+=chunk.length;if(size>MAX_BODY&&!aborted){aborted=true;send(413,{error:{code:'PAYLOAD_TOO_LARGE',message:'Request body is too large'}});req.destroy();return;}chunks.push(chunk);});
    req.on('end',async()=>{
      if(aborted)return;
      let body;
      try{body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{send(400,{error:{code:'INVALID_JSON',message:'The body is not valid JSON'}});return;}
      try{send(200,{result:await rpc(body?.method,body?.params??{},controller.signal)});}
      catch(cause){send(200,{error:{code:typeof cause?.code==='string'?cause.code:'INTERNAL',message:sanitizeLine(cause?.message??cause)}});}
    });
  });
  server.requestTimeout=0;server.timeout=0;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;

  async function shutdown(){
    if(shutdownPromise)return shutdownPromise;
    state='disposing';
    shutdownPromise=(async()=>{
      clearTimeout(promptTimer);clearTimeout(idleTimer);reverse.close();
      try{execRunner?.dispose();}catch{}
      try{await cli?.close();}catch{}
      for(const controller of calls.values())controller.abort();
      try{await pluginUi?.close();}catch{}
      try{await loaded.dispose();}catch{}
      await new Promise(resolve=>{server.close(()=>resolve());server.closeAllConnections?.();});
      finish();
    })();
    return shutdownPromise;
  }

  const ready={
    type:'ready',port,token,
    tools:describeTools(),commands,promptSections,interception,
    metadata:summary,
  };
  return {ready,rpc,server,port,token,shutdown,done,loaded};
}
