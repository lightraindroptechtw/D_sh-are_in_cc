/** Stand-in for the `dsh` command line (DeepSeek Harness), for converted plugins that run `dsh` themselves.
 *
 * Only one thing is supported: an unattended prompt run, `dsh [--profile <name>] [--patch <file>]... <prompt>`
 * (the prompt may also come from standard input). The run is handed to the plugin's child host through a loopback
 * endpoint (see cli-endpoint.mjs); the host asks the Claude Code mod for a Claude subagent (`agent.spawn`) and the
 * subagent's final text is printed to stdout. Everything else (`plugin ...`, `web`, `--dump-config`, unknown options)
 * is refused with a clear message and a non-zero exit code; nothing pretends to succeed.
 *
 * build.mjs bundles this file into <plugin>/runtime/dsh-cli/dsh.mjs (zero runtime dependencies).
 * Exit codes: 0 done, 1 the run failed, 2 unsupported or invalid command line, 3 subagents are switched off (allowAgents).
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {parse as parseYaml} from 'yaml';

export const EXIT=Object.freeze({OK:0,FAILED:1,USAGE:2,DISABLED:3});
export const ENV_ENDPOINT='DSH_CLAUDE_CLI_ENDPOINT';
export const ENV_TOKEN='DSH_CLAUDE_CLI_TOKEN';
export const STAND_IN_VERSION='0.1.0';
const MAX_PROMPT_CHARS=900000;
const MAX_OVERLAY_BYTES=1024*1024;
const MAX_STDIN_BYTES=1024*1024;
const STDIN_IDLE_MS=10000;
/** dsh subcommands that exist in the real command line; named only to give a precise refusal. */
const KNOWN_SUBCOMMANDS=new Set(['plugin','web','guard','launch','mcp','config','login','logout','update','doctor','upgrade','install','uninstall','serve','server','agent','session','sessions','skill','skills','profile','profiles']);

export class DshCliError extends Error{constructor(message,exit=EXIT.FAILED,code='DSH_CLI_ERROR'){super(message);this.exit=exit;this.code=code;}}
const usage=message=>new DshCliError(message,EXIT.USAGE,'DSH_CLI_UNSUPPORTED');

const HELP=`dsh（Claude 轉接版，不是 DeepSeek Harness）
用法：dsh [--profile <名稱>] [--patch <overlay 檔>]... <提示詞>
      提示詞也可以從標準輸入讀入（不給提示詞參數時）。
這個程式把一輪無人值守的對話轉交給 Claude Code 的子代理，子代理的最後文字印到標準輸出。
支援：--profile、--patch（可重複）、--version、--help。其他子命令與參數一律報錯。
`;

/** Parse the command line. Returns {kind:'run'|'version'|'help', profile?, patches?, prompt?, stdin?}. Throws DshCliError. */
export function parseDshArgs(argv){
  const args=[...argv];
  let profile=null;const patches=[],positional=[];
  let seenEnd=false;
  const takeValue=(flag,inline,index)=>{
    if(inline!==undefined){if(inline==='')throw usage(`${flag} 缺少值`);return {value:inline,next:index};}
    const value=args[index+1];
    if(value===undefined||value===''||(value.startsWith('--')&&value.length>2))throw usage(`${flag} 缺少值`);
    return {value,next:index+1};
  };
  for(let index=0;index<args.length;index++){
    const arg=args[index];
    if(seenEnd||!arg.startsWith('-')||arg==='-'){positional.push(arg);continue;}
    if(arg==='--'){seenEnd=true;continue;}
    const eq=arg.startsWith('--')?arg.indexOf('='):-1;
    const flag=eq>0?arg.slice(0,eq):arg,inline=eq>0?arg.slice(eq+1):undefined;
    if(flag==='--profile'){const taken=takeValue(flag,inline,index);index=taken.next;
      if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(taken.value))throw usage(`--profile 的名稱不合法：${JSON.stringify(taken.value.slice(0,40))}`);
      profile=taken.value;continue;}
    if(flag==='--patch'){const taken=takeValue(flag,inline,index);index=taken.next;patches.push(taken.value);continue;}
    if((flag==='--version'||flag==='-v'||flag==='-V')&&inline===undefined)return {kind:'version'};
    if((flag==='--help'||flag==='-h')&&inline===undefined)return {kind:'help'};
    if(positional.length&&KNOWN_SUBCOMMANDS.has(positional[0].toLowerCase()))throw usage(`不支援的 dsh 子命令：${positional[0].slice(0,40)}。這個轉接版只能執行「提示詞」，不能管理插件或啟動介面`);
    throw usage(`不支援的參數 ${flag.slice(0,60)}。這個轉接版只支援 --profile、--patch、--version、--help 與一個提示詞`);
  }
  if(positional.length===1&&positional[0]!=='-'&&KNOWN_SUBCOMMANDS.has(positional[0].toLowerCase()))
    throw usage(`不支援的 dsh 子命令：${positional[0]}。這個轉接版只能執行「提示詞」，不能管理插件或啟動介面`);
  if(positional.length>1)
    throw usage(KNOWN_SUBCOMMANDS.has(positional[0].toLowerCase())?`不支援的 dsh 子命令：${positional[0].slice(0,40)}`:'提示詞只能是一個參數（多行文字請整段當成一個參數，或改走標準輸入）');
  const prompt=positional.length===1&&positional[0]!=='-'?positional[0]:null;
  return {kind:'run',profile,patches,prompt,stdin:prompt===null};
}

// ---------- overlay (--patch) ----------
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clip=(value,limit)=>{const text=String(value??'');return text.length>limit?text.slice(0,limit)+'…':text;};
const stringList=value=>(Array.isArray(value)?value:[value]).filter(item=>typeof item==='string'&&item.trim()).map(item=>clip(item.trim(),200));
const INSTRUCTION_KEYS=['systemPrompt','system_prompt','appendSystemPrompt','instructions','prompt','appendPrompt','system'];
const ALLOW_KEYS=['allowTools','allowedTools','toolAllowlist','enabledTools','allow','tools'];
const DENY_KEYS=['denyTools','deniedTools','disabledTools','deny'];
const SECRET_NAME=/(token|secret|password|passwd|api[-_]?key|authorization|credential)/i;

/** Collect what a DSH overlay says that a Claude subagent can be told about. Pure function; `doc` is parsed YAML. */
export function summarizeOverlay(doc,{file='overlay'}={}){
  const summary={file,entries:[],instructions:[],allowTools:[],denyTools:[],mcpServers:[],model:null};
  const visit=(entry,depth)=>{
    if(depth>8||!isObject(entry))return;
    const config=isObject(entry.config)?entry.config:{};
    const id=typeof entry.id==='string'?entry.id:typeof entry.name==='string'?entry.name:null;
    if(id)summary.entries.push(`${clip(id,80)}${entry.disabled===true?'（disabled）':''}`);
    const looksMcp=/mcp-client/.test(String(entry.name??''))||(typeof config.serverName==='string'&&(config.command!==undefined||config.url!==undefined||config.transport!==undefined));
    if(looksMcp&&entry.disabled!==true){
      const secretArg=(arg,previous)=>SECRET_NAME.test(String(previous??''))||(String(arg).includes('=')&&SECRET_NAME.test(String(arg).split('=')[0]));
      const args=Array.isArray(config.args)?config.args.map((arg,i,list)=>secretArg(arg,list[i-1])?'[redacted]':clip(arg,200)):[];
      summary.mcpServers.push({name:clip(config.serverName??id??'mcp',80),transport:clip(config.transport??'',20),command:clip(config.command??config.url?.replace?.(/\?.*$/,'')??'',200),args:args.slice(0,12),envNames:isObject(config.env)?Object.keys(config.env).slice(0,20):[]});
    }else if(entry.disabled!==true){
      if(id==='agent-default-model'||/default-model/.test(String(id)))summary.model=[config.provider,config.model].filter(Boolean).map(String).join('/')||null;
      for(const key of INSTRUCTION_KEYS)if(typeof config[key]==='string'&&config[key].trim())summary.instructions.push(clip(config[key].trim(),8000));
      for(const key of ALLOW_KEYS)if(config[key]!==undefined)summary.allowTools.push(...stringList(config[key]));
      for(const key of DENY_KEYS)if(config[key]!==undefined)summary.denyTools.push(...stringList(config[key]));
    }
    for(const key of ['insert','replace','patch','patches','entries','plugins']){
      const nested=entry[key];
      if(Array.isArray(nested))for(const item of nested)visit(item,depth+1);else if(isObject(nested))visit(nested,depth+1);
    }
  };
  if(Array.isArray(doc))for(const entry of doc)visit(entry,0);
  else if(isObject(doc)){
    if(Array.isArray(doc.patches)||Array.isArray(doc.entries)||Array.isArray(doc.insert))visit(doc,0);
    else for(const [key,value] of Object.entries(doc)){
      if(Array.isArray(value))for(const item of value)visit(item,1);
      else if(isObject(value)&&('config' in value||'id' in value))visit(value,1);
      else if(INSTRUCTION_KEYS.includes(key)&&typeof value==='string')summary.instructions.push(clip(value,8000));
      else if(ALLOW_KEYS.includes(key))summary.allowTools.push(...stringList(value));
      else if(DENY_KEYS.includes(key))summary.denyTools.push(...stringList(value));
    }
  }else if(doc!==null&&doc!==undefined)throw new DshCliError(`overlay ${clip(file,80)} 的內容不是物件或清單`,EXIT.USAGE,'DSH_CLI_OVERLAY_INVALID');
  summary.allowTools=[...new Set(summary.allowTools)];summary.denyTools=[...new Set(summary.denyTools)];
  return summary;
}

export async function readOverlay(file,{cwd=process.cwd()}={}){
  const full=path.resolve(cwd,file);
  let text;
  try{
    const info=await fs.stat(full);
    if(!info.isFile()||info.size>MAX_OVERLAY_BYTES)throw new Error('not a regular file or larger than 1 MiB');
    text=await fs.readFile(full,'utf8');
  }catch(cause){throw new DshCliError(`讀不到 --patch 檔案 ${clip(path.basename(file),80)}（${cause.code??cause.message}）`,EXIT.USAGE,'DSH_CLI_OVERLAY_UNREADABLE');}
  let doc;
  try{doc=parseYaml(text);}catch(cause){throw new DshCliError(`--patch 檔案 ${clip(path.basename(file),80)} 不是合法的 YAML：${clip(String(cause.message).split('\n')[0],200)}`,EXIT.USAGE,'DSH_CLI_OVERLAY_INVALID');}
  return summarizeOverlay(doc,{file:path.basename(file)});
}

/** The text sent to the Claude subagent: a short frame, what was relayed, what could not be, then the task. */
export function composePrompt({prompt,profile=null,overlays=[]}){
  const lines=[
    'This task was relayed from the `dsh` command line (an unattended "headless" run) by a plugin that was converted from DeepSeek Harness (DSH) to Claude Code. You are a Claude Code subagent, not a DSH agent.',
    'Nobody is available to answer questions during this run: do not ask for clarification or confirmation; choose sensibly and carry on. Use the tools you have in this session.',
    'Your final message is handed back to the calling program as the command output: end with a short plain-text summary of what you did and the outcome.',
  ];
  const notes=[];
  if(profile)notes.push(`DSH profile requested: ${profile} (profiles are not applied; you run with Claude Code's own tools and permissions).`);
  for(const overlay of overlays){
    notes.push(`Overlay file ${overlay.file}: ${overlay.entries.length} entr${overlay.entries.length===1?'y':'ies'}${overlay.entries.length?` (${overlay.entries.slice(0,12).join(', ')})`:''}.`);
    if(overlay.model)notes.push(`  Model named in the overlay: ${overlay.model} (ignored; you run on Claude Code's model).`);
    for(const text of overlay.instructions)notes.push(`  Additional instructions from the overlay:\n${text.split('\n').map(line=>'    '+line).join('\n')}`);
    if(overlay.allowTools.length)notes.push(`  Tool names the overlay lists as allowed: ${overlay.allowTools.join(', ')} (names are DSH tool names; use them only if an equivalent exists here).`);
    if(overlay.denyTools.length)notes.push(`  Tool names the overlay lists as denied: ${overlay.denyTools.join(', ')} (do not use these or their equivalents).`);
    for(const server of overlay.mcpServers)notes.push(`  MCP server declared by the overlay but NOT attached to this subagent: ${server.name}${server.transport?` (${server.transport})`:''}${server.command?`, command ${server.command}`:''}${server.envNames.length?`, env names ${server.envNames.join(', ')}`:''}. Tools that only that server provides are unavailable unless they already exist in this session; if the task needs one that is missing, say so in your final message instead of pretending it worked.`);
  }
  if(notes.length)lines.push('Relayed settings:\n'+notes.join('\n'));
  lines.push('=== Task ===\n'+prompt);
  return lines.join('\n\n');
}

// ---------- endpoint client ----------
function loopbackUrl(text){
  let url;
  try{url=new URL(text);}catch{throw new DshCliError(`${ENV_ENDPOINT} 不是合法網址`,EXIT.FAILED,'DSH_CLI_ENDPOINT_INVALID');}
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new DshCliError(`${ENV_ENDPOINT} 必須是本機（127.0.0.1）位址`,EXIT.FAILED,'DSH_CLI_ENDPOINT_INVALID');
  return url;
}
/** POST JSON to the host endpoint without any client-side timeout (a subagent run can take many minutes). */
export function postJson(url,token,body,{signal}={}){
  return new Promise((resolve,reject)=>{
    const payload=Buffer.from(JSON.stringify(body));
    const req=http.request(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','content-length':payload.length},agent:false},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(chunks).toString('utf8')}));
      res.on('error',reject);
      res.on('aborted',()=>reject(new Error('the host closed the connection before answering')));
    });
    req.on('error',reject);
    const abort=()=>req.destroy(Object.assign(new Error('canceled'),{code:'ABORT_ERR'}));
    if(signal){if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});req.on('close',()=>signal.removeEventListener('abort',abort));}
    req.end(payload);
  });
}

async function readStdin(stdin){
  if(!stdin||stdin.isTTY)throw usage('沒有提示詞：請把提示詞當成最後一個參數，或從標準輸入給');
  const chunks=[];let size=0;
  return new Promise((resolve,reject)=>{
    let timer;
    const done=cause=>{clearTimeout(timer);stdin.off?.('data',onData);stdin.off?.('end',onEnd);stdin.off?.('error',done);cause?reject(cause):resolve(Buffer.concat(chunks).toString('utf8'));};
    const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>done(usage('沒有提示詞：標準輸入沒有資料')),STDIN_IDLE_MS);timer.unref?.();};
    const onData=chunk=>{size+=chunk.length;if(size>MAX_STDIN_BYTES){done(usage('標準輸入的提示詞超過 1 MiB'));return;}chunks.push(Buffer.from(chunk));arm();};
    const onEnd=()=>done();
    stdin.on('data',onData);stdin.once('end',onEnd);stdin.once('error',done);arm();
  });
}

/** Run the command line. Resolves with the exit code; never throws. */
export async function runDshCli({argv=process.argv.slice(2),env=process.env,stdin=process.stdin,stdout=process.stdout,stderr=process.stderr,cwd=process.cwd(),signal}={}){
  const out=text=>{try{stdout.write(text);}catch{}};
  const err=text=>{try{stderr.write(text);}catch{}};
  try{
    const parsed=parseDshArgs(argv);
    if(parsed.kind==='help'){out(HELP);return EXIT.OK;}
    if(parsed.kind==='version'){out(`dsh-claude-stand-in ${STAND_IN_VERSION} (not DeepSeek Harness; runs prompts through a Claude Code subagent)\n`);return EXIT.OK;}
    const endpoint=env[ENV_ENDPOINT],token=env[ENV_TOKEN];
    if(!endpoint||!token)throw new DshCliError(`這個 dsh 只能在轉換後的插件宿主裡執行：缺少環境變數 ${ENV_ENDPOINT} 或 ${ENV_TOKEN}`,EXIT.FAILED,'DSH_CLI_NO_HOST');
    const url=loopbackUrl(endpoint);
    let prompt=parsed.prompt;
    if(prompt===null)prompt=await readStdin(stdin);
    if(!prompt.trim())throw usage('提示詞是空的');
    if(prompt.length>MAX_PROMPT_CHARS)throw usage('提示詞太長（上限約 90 萬字元）');
    const overlays=[];
    for(const file of parsed.patches)overlays.push(await readOverlay(file,{cwd}));
    for(const overlay of overlays)for(const server of overlay.mcpServers)
      err(`[dsh-claude] 注意：overlay 的 MCP 伺服器「${server.name}」無法掛到 Claude 子代理；只有 Claude 這邊本來就有的工具能用。\n`);
    const text=composePrompt({prompt,profile:parsed.profile,overlays});
    let response;
    try{response=await postJson(url,token,{prompt:text,description:`dsh${parsed.profile?` --profile ${parsed.profile}`:''} (relayed)`,profile:parsed.profile},{signal});}
    catch(cause){
      if(cause?.code==='ABORT_ERR'||signal?.aborted)throw new DshCliError('已取消',EXIT.FAILED,'DSH_CLI_CANCELED');
      throw new DshCliError(`連不到插件宿主的內部端點：${clip(cause?.code??cause?.message,100)}`,EXIT.FAILED,'DSH_CLI_ENDPOINT_UNREACHABLE');
    }
    let body;
    try{body=JSON.parse(response.text||'{}');}catch{body={};}
    if(response.status===401)throw new DshCliError('內部端點拒絕了權杖（這個 dsh 不是由目前的宿主執行的）',EXIT.FAILED,'UNAUTHORIZED');
    if(body.error){
      const code=typeof body.error.code==='string'?body.error.code:'FAILED';
      throw new DshCliError(clip(body.error.message??code,2000),code==='DISABLED'?EXIT.DISABLED:EXIT.FAILED,code);
    }
    if(response.status!==200||typeof body.result?.text!=='string')throw new DshCliError(`內部端點回覆無法理解（HTTP ${response.status}）`,EXIT.FAILED,'DSH_CLI_BAD_REPLY');
    out(body.result.text.endsWith('\n')?body.result.text:body.result.text+'\n');
    return EXIT.OK;
  }catch(cause){
    if(cause instanceof DshCliError){err(`dsh: ${cause.message}${cause.code&&!['DSH_CLI_ERROR'].includes(cause.code)?` [${cause.code}]`:''}\n`);return cause.exit;}
    err(`dsh: 未預期的錯誤：${clip(cause?.message??cause,300)}\n`);return EXIT.FAILED;
  }
}
