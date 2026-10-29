/** Claude Code file preview adapter over the existing official ctx.fs capability. */
import path from 'node:path';
import {parseFileAddress} from '../ui/resources.mjs';
const fail=(code,message,details={})=>Object.assign(new Error(message),{code,details});
const defaults={maxBytes:4*1024*1024,maxFileBytes:32*1024*1024,maxLines:500,maxEntries:1000};
const names={stat:['workspaceFileScopeId','path'],read:['workspaceFileScopeId','path','range'],readBytes:['workspaceFileScopeId','path','options'],list:['workspaceFileScopeId','path'],changes:['workspaceFileScopeId','path']};
const paramsOf=(method,args)=>Array.isArray(args)?Object.fromEntries(names[method].map((key,index)=>[key,args[index]])):args??{};
const nonnegative=(value,label)=>{if(!Number.isSafeInteger(value)||value<0)throw fail('gateway/bad-request',`${label}必須是非負整數。`);return value;};
function capabilities(ctx,config){const fs=ctx?.get?.('fs');if(!fs)throw fail('gateway/unavailable','插件尚未啟用檔案讀取服務。');const caps={...defaults,...config};for(const [key,value]of Object.entries(caps))if(!Number.isSafeInteger(value)||value<1)throw fail('gateway/internal',`檔案預覽上限「${key}」無效。`);return {fs,caps};}
function normalized(error,signal){if(signal?.aborted)return {code:'gateway/cancelled',message:'檔案讀取已取消。',details:{}};const mapping={FS_NOT_FOUND:'workspace-file/not-found',FS_NOT_TEXT:'workspace-file/not-text',FS_TOO_LARGE:'workspace-file/too-large',FS_NOT_REGULAR_FILE:'workspace-file/not-regular-file',FS_NOT_DIRECTORY:'workspace-file/not-directory'};return {code:mapping[error.code]??error.code??'workspace-file/internal',message:error.message??String(error),details:error.details??{}};}
/** Claude Code has no conversation list, so a session-scoped address can never name a workspace. */
async function scopeFor(id){
  throw fail('UI_CONVERSATION_UNSUPPORTED','尚未支援 Claude Code 對話列表，無法由對話識別碼找到工作目錄；請改用不含對話的檔案位址。',{sessionId:typeof id==='string'?id:undefined});
}
const checkPath=value=>{if(typeof value!=='string'||value.includes('\0'))throw fail('gateway/bad-request','檔案路徑格式無效。');return value;};
async function locate(fs,root,requested,signal,{directory=false,allowAbsent=false}={}){
  signal?.throwIfAborted();checkPath(requested);if(directory&&requested==='')requested='.';const inspected=await fs.lstat(requested,{...(root?{cwd:root}:{})},signal);
  if(!inspected&&!allowAbsent)throw fail('workspace-file/not-found','找不到指定的檔案或資料夾。',{path:requested});
  if(inspected?.type==='symlink')throw fail(directory?'workspace-file/not-directory':'workspace-file/not-regular-file','預覽不讀取最後一層為符號連結的路徑。',{path:requested,kind:'symlink'});
  if(inspected&&(directory?inspected.type!=='directory':inspected.type!=='file'))throw fail(directory?'workspace-file/not-directory':'workspace-file/not-regular-file',directory?'指定路徑不是資料夾。':'指定路徑不是普通檔案。',{path:requested,kind:inspected.type});
  const target=await fs.resolve(requested,{...(root?{cwd:root}:{}),signal});
  if(directory){if(!root)throw fail('workspace-file/unknown-workspace','列出資料夾需要明確的工作目錄。');const base=await fs.resolve(root,{signal});if(!fs.contains(base,target))throw fail('workspace-file/outside-workspace','資料夾列舉範圍限於此對話的工作目錄。',{path:requested});}
  const info=await fs.stat(target,signal);if(!info){if(allowAbsent)return {target,absolutePath:fs.processPath(target)};throw fail('workspace-file/not-found','檔案已不存在。',{path:requested});}
  if(directory?info.type!=='directory':info.type!=='file')throw fail(directory?'workspace-file/not-directory':'workspace-file/not-regular-file','路徑種類在讀取前已變更。',{path:requested,kind:info.type});
  return {target,info,absolutePath:fs.processPath(target)};
}
const statOf=located=>({absolutePath:located.absolutePath,version:located.info.version,...(typeof located.info.size==='number'?{bytes:located.info.size}:{})});
async function textPage(fs,located,range={},caps,signal){
  if(range===null||typeof range!=='object'||Array.isArray(range))throw fail('gateway/bad-request','文字頁面範圍格式無效。');
  const offset=range?.offset??1,limit=range?.limit??caps.maxLines;if(!Number.isSafeInteger(offset)||offset<1||!Number.isSafeInteger(limit)||limit<1||limit>caps.maxLines)throw fail('gateway/bad-request',`文字頁面起始行須大於零，行數不可超過 ${caps.maxLines}。`);
  const rows=[],last=offset+limit-1;let line=1,parts=[],bytes=0,seen=false,hasCharacters=false;
  const append=value=>{bytes+=Buffer.byteLength(value);if(bytes>caps.maxBytes)throw fail('workspace-file/too-large','這個文字頁面超過傳輸位元組上限，沒有傳回截斷內容。',{path:located.absolutePath,limit:caps.maxBytes});if(value.includes('\0'))throw fail('workspace-file/not-text','文字頁面含有 NUL（空字元），無法作為文字預覽。',{path:located.absolutePath});parts.push(value);};
  const finishLine=()=>{if(line>=offset&&line<=last){if(rows.length&&++bytes>caps.maxBytes)throw fail('workspace-file/too-large','這個文字頁面超過傳輸位元組上限，沒有傳回截斷內容。',{path:located.absolutePath,limit:caps.maxBytes});rows.push(parts.join(''));parts=[];}};
  // Retain only selected lines; long skipped prefixes never accumulate in memory.
  for await(const chunk of await fs.streamText(located.target,signal)){
    signal?.throwIfAborted();let position=0;
    while(position<chunk.length){if(line>last)return {...statOf(located),offset,text:rows.join('\n'),lines:rows.length,eof:false};const newline=chunk.indexOf('\n',position),end=newline===-1?chunk.length:newline,part=chunk.slice(position,end);if(part){seen=true;hasCharacters=true;if(line>=offset)append(part);}if(newline===-1)break;seen=true;finishLine();line++;hasCharacters=false;position=end+1;}
  }
  if(seen&&hasCharacters&&line<=last)finishLine();
  return {...statOf(located),offset,text:rows.join('\n'),lines:rows.length,eof:true};
}
async function execute({ctx,operation,requested,root,range,options,signal,config}){
  const {fs,caps}=capabilities(ctx,config);signal?.throwIfAborted();
  if(!Object.hasOwn(names,operation)||operation==='changes')throw fail('gateway/unsupported','尚未提供這項檔案操作。');
  if(options!==undefined&&(options===null||typeof options!=='object'||Array.isArray(options)))throw fail('gateway/bad-request','位元組讀取選項格式無效。');
  if(options?.range!==undefined&&(options.range===null||typeof options.range!=='object'||Array.isArray(options.range)))throw fail('gateway/bad-request','位元組視窗格式無效。');
  if(operation==='readBytes'&&options?.baseFile!==undefined){
    const relative=checkPath(requested);if(!relative||path.isAbsolute(relative)||path.win32.isAbsolute(relative)||/^[a-z][a-z0-9+.-]*:/i.test(relative))throw fail('gateway/bad-request','指定基準檔案時，目標必須是非空的相對檔案路徑。');
    const base=await locate(fs,root,checkPath(options.baseFile),signal);requested=path.resolve(path.dirname(base.absolutePath),relative);
  }
  const located=await locate(fs,root,checkPath(requested),signal,{directory:operation==='list'});
  if(operation==='stat')return statOf(located);
  if(operation==='read')return textPage(fs,located,range,caps,signal);
  if(operation==='list'){
    const rows=await fs.listDir(located.target,signal);return {path:path.relative(root,located.absolutePath).split(path.sep).join('/'),entries:rows.slice(0,caps.maxEntries).map(({name,type,size})=>({name,type,...(type==='file'&&typeof size==='number'?{size}:{})})),truncated:rows.length>caps.maxEntries};
  }
  const window=options?.range;let data,offset=0;
  if(window!==undefined){offset=nonnegative(window.offset??0,'位元組起點');const length=nonnegative(window.length??caps.maxBytes,'位元組長度');if(length>caps.maxBytes)throw fail('workspace-file/too-large','位元組視窗超過傳輸上限。',{path:located.absolutePath,limit:caps.maxBytes});data=await fs.readByteRange(located.target,{offset,length},signal);}
  else data=await fs.readBytes(located.target,signal,caps.maxFileBytes);
  return {...statOf(located),offset,data,eof:typeof located.info.size==='number'?offset+data.length>=located.info.size:window===undefined||data.length<(window.length??caps.maxBytes)};
}
/** Resource addresses preserve raw path semantics, and absolute Claude Code addresses use ctx.fs directly. */
export async function dispatchFileResourceCall(environment={}){
  const {params={},signal}=environment;try{
    const address=parseFileAddress(params.address);if(!address)throw fail('workspace-file/unsupported-address','無法辨識此檔案資源位址。');
    const scope=address.scope==='session'?await scopeFor(address.sessionId,environment):{workspaceRoot:environment.workspace};
    const value=await execute({...environment,root:scope.workspaceRoot,requested:address.path,operation:params.operation,range:{offset:params.offset,limit:params.limit},options:params.options});signal?.throwIfAborted();return {ok:true,value};
  }catch(error){return {ok:false,error:normalized(error,signal)};}
}
export async function dispatchWorkspaceFilesCall(environment={}){
  const {namespace,method,args={},signal}=environment;if(namespace!=='workspaceFiles'||!Object.hasOwn(names,method)||method==='changes')return undefined;
  try{const input=paramsOf(method,args),scope=await scopeFor(input.workspaceFileScopeId,environment),value=await execute({...environment,operation:method,root:scope.workspaceRoot,requested:input.path,range:input.range,options:input.options});signal?.throwIfAborted();return {ok:true,value};}catch(error){return {ok:false,error:normalized(error,signal)};}
}
/** A real filesystem watch, not success-shaped polling or fabricated changes. */
export function dispatchWorkspaceFilesStream(environment={}){
  const {namespace,method,args={},signal}=environment;if(namespace!=='workspaceFiles'||method!=='changes')return undefined;
  return (async function*(){
    const input=paramsOf(method,args),scope=await scopeFor(input.workspaceFileScopeId,environment),{fs}=capabilities(environment.ctx,environment.config),requested=checkPath(input.path),inspected=await fs.lstat(requested,{cwd:scope.workspaceRoot},signal);
    const located=await locate(fs,scope.workspaceRoot,requested,signal,{directory:inspected?.type==='directory',allowAbsent:true});
    let pending=false,problem,wake,closed=false;const changed=error=>{problem=error;pending=true;wake?.();};
    const abort=()=>wake?.();signal?.addEventListener('abort',abort,{once:true});let close;
    try{
      try{close=await fs.watch(located.target,changed,signal);}catch(error){if(signal?.aborted)throw error;throw fail('workspace-file/watch-unsupported',`無法初始化這個檔案的監聽：${error.message}`,{path:requested});}
      signal?.throwIfAborted();yield {kind:'ready'};
      while(!signal?.aborted&&!closed){
        if(!pending)await new Promise(resolve=>{wake=resolve;if(signal?.aborted||pending)resolve();});wake=undefined;if(signal?.aborted)break;if(problem)throw problem;pending=false;
        const info=await fs.stat(located.target,signal);yield {kind:'change',change:info?{absolutePath:located.absolutePath,version:info.version}:{absolutePath:located.absolutePath,absent:true}};
      }
    }finally{closed=true;signal?.removeEventListener('abort',abort);await close?.();}
  })();
}
