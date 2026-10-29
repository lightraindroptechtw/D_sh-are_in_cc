import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import * as esbuild from 'esbuild';
import {compileDshEntry,PRECOMPILED_ENTRY_FILE,PRECOMPILED_META_FILE,PRECOMPILED_SCHEMA_VERSION} from './precompile-entry.mjs';
import {inspectSource} from './inspect.mjs';
import {acquireSource,copySource,inside} from './source.mjs';
import {buildOfficialHost} from './host-build.mjs';
import {planSourceDependencies,installSourceDependencies} from './source-deps.mjs';
import {stablePluginId} from './state-paths.mjs';
import {planVersionAliases} from './compat/version-alias.mjs';
import {webConfiguration} from './modules/web.mjs';
import {buildDshCli} from './claude-host/build.mjs';
import {claudePluginName,claudePluginVersion,claudeSkillDirName,defaultTemplatesDir,readTemplates,writeClaudeModFiles,writeClaudeManifestOnly,validateClaudePackage,mergeSecretUserConfig,writePluginReadme} from './claude-package.mjs';
import {preparePluginUi} from './ui-assets.mjs';
import {scanSecurity,secretOptionsFromScan,configSecretPaths,renderSecurityMarkdown} from './security-scan.mjs';

export const converterRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const defaultProxyNames=['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY'];
const envName=value=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
const jsonWrite=(file,data)=>fs.writeFile(file,JSON.stringify(data,null,2)+'\n','utf8');
const exists=async file=>{try{await fs.access(file);return true;}catch{return false;}};

// 模組設定裡用到的環境變數名稱，以及寫進轉換報告的設定（金鑰類的值不寫進報告）。
function configuredEnvironmentNames(moduleOptions){
  if(!moduleOptions||typeof moduleOptions!=='object'||Array.isArray(moduleOptions))throw new Error('moduleOptions 必須是物件');
  const names=new Set();
  const walk=value=>{if(!value||typeof value!=='object')return;if(Object.hasOwn(value,'environment'))throw new Error('模組設定不得儲存環境變數值；請使用 envMapping 或 credentialEnv 宣告名稱');for(const [key,item]of Object.entries(value)){if(key==='envMapping'){if(!item||typeof item!=='object'||Array.isArray(item)||Object.values(item).some(name=>!envName(name)))throw new Error('envMapping 必須只包含環境變數名稱');for(const name of Object.values(item))names.add(name);}else if(key==='credentialEnv'){if(!envName(item))throw new Error('credentialEnv 必須是環境變數名稱');names.add(item);}else walk(item);}};
  walk(moduleOptions);return [...names];
}
function reportConfiguration(value){
  if(Array.isArray(value))return value.map(reportConfiguration);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/(?:secret|password|passwd|api.?key|token|authorization|credential)/i.test(key)&&!/(?:Env|env_var|envMapping)$/i.test(key)?'[redacted]':reportConfiguration(item)]));
}

/** Config of a mounted patch row for the report: `!!js` expressions stay visible (they hold only a variable name), literal secrets are hidden. */
function entryConfigForReport(value){
  if(Array.isArray(value))return value.map(entryConfigForReport);
  if(!value||typeof value!=='object')return value;
  if(typeof value.$dshExpression==='string'&&Object.keys(value).length===1)return value;
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,item&&typeof item==='object'?entryConfigForReport(item):/(?:secret|password|passwd|api.?key|token|authorization|credential)/i.test(key)?'[redacted]':item]));
}

// ---------- 服務對應表 ----------
// 每列說明「這個 DSH 服務在 Claude 版本裡由誰負責」。level 是設計上的涵蓋程度，不是測試結果；
// 全部列都尚未在實際的 Claude Code 工作階段驗證（報告的 verification 欄位另有說明）。
const FULL='完整',PARTIAL='部分',NONE='不支援';
const unsupported=reason=>({claudeCapability:null,handledBy:'none',level:NONE,note:reason});
const SERVICE_MAP={
  tools:{claudeCapability:'$.tool.register',handledBy:'mod+child-host',level:FULL,note:'子程序回報工具清單，mod 用 $.tool.register 逐一註冊；呼叫經本機 127.0.0.1 的 tools.call 交給官方 DSH 工具服務，結果轉成文字內容，取消用 tools.cancel。'},
  systemPrompt:{claudeCapability:'prompt.compose',handledBy:'mod+child-host',level:PARTIAL,note:'DSH 提示段落以文字加入 Claude 的系統提示；DSH 的 order 排序與條件式段落不保證與原宿主一致。'},
  commands:{claudeCapability:'$.command.register',handledBy:'mod+child-host',level:PARTIAL,note:'子程序回報命令清單，mod 用 $.command.register 註冊斜線指令，執行時送 commands.run 取得文字。官方命令執行本來需要 DSH 代理與對話紀錄，Claude 端沒有這些，能做到的範圍以子程序宿主實作為準。'},
  llm:{claudeCapability:'model.complete（反向請求）',handledBy:'mod+child-host',level:PARTIAL,enabledByDefault:false,note:'子程序送 model.complete 請 mod 用 $.model.complete 代辦。預設關閉，需使用者在 userConfig 開啟 allowModelCalls；關閉時回 DISABLED 錯誤，不假裝成功。'},
  agents:{claudeCapability:'agent.spawn（反向請求）',handledBy:'mod+child-host',level:PARTIAL,enabledByDefault:false,note:'子程序送 agent.spawn 請 mod 用 $.agent.spawn 代辦。預設關閉，需使用者在 userConfig 開啟 allowAgents；關閉時回 DISABLED 錯誤。'},
  subagents:{claudeCapability:'agent.spawn（反向請求）',handledBy:'mod+child-host',level:PARTIAL,enabledByDefault:false,note:'同 agents：預設關閉，需開啟 allowAgents。'},
  approval:{claudeCapability:'approval.request（反向請求，詢問使用者）',handledBy:'mod+child-host',level:FULL,enabledByDefault:true,note:'子程序送 approval.request，mod 用 $.ui 詢問使用者；只有使用者明確同意才放行。'},
  timer:{claudeCapability:null,handledBy:'child-host',level:FULL,note:'沿用官方 Cordis 計時器，在子程序內執行；只在子程序存活期間有效，工作階段結束子程序也結束。'},
  fs:{claudeCapability:null,handledBy:'child-host',level:FULL,note:'沿用官方本機檔案服務，具有目前使用者的檔案權限，不是沙箱。'},
  settings:{claudeCapability:null,handledBy:'child-host',level:PARTIAL,note:'官方設定服務在子程序內運作，資料存在子程序的資料目錄；原設定頁可在獨立網頁讀取與保存，未嵌入 Claude 自己的設定畫面。'},
  webServer:{claudeCapability:null,handledBy:'child-host',level:PARTIAL,note:'原路由綁定本機；獨立畫面會把請求轉到原插件已登記的路由，支援 JSON、表單與串流；尚未提供 WebSocket 升級代理。'},
  skills:{claudeCapability:null,handledBy:'child-host',level:PARTIAL,note:'來源裡的 SKILL.md 複製到 skills/ 由 Claude 載入；執行期才動態註冊的技能留在子程序，Claude 看不到。'},
  credentials:{claudeCapability:null,handledBy:'child-host',level:PARTIAL,note:'官方憑證服務在子程序內運作，只讀轉傳（passEnv）進去的環境變數；金鑰不寫進設定、日誌或報告。'},
  web:{claudeCapability:null,handledBy:'child-host',level:PARTIAL,note:'沿用官方 dsh-web 服務設定，在子程序內運作；沒有 DSH 的瀏覽器介面。'},
  logger:{claudeCapability:'log（子程序 → mod）',handledBy:'child-host',level:FULL,note:'日誌寫到子程序標準錯誤或 log 訊息，不含金鑰。'},
  shell:{claudeCapability:'exec.check（反向請求 → Bash 權限檢查）',handledBy:'mod+child-host',level:PARTIAL,note:'程式由子程序宿主執行；每次執行前送 exec.check，照 Claude Code 對 Bash 的權限規則允許、拒絕或詢問使用者。插件選項 allowDirectExec 打開時插件可以自己開程式，不經檢查。'},
  subprocess:{claudeCapability:'exec.check（反向請求 → Bash 權限檢查）',handledBy:'mod+child-host',level:PARTIAL,note:'同 shell：由子程序宿主執行，每次先經 Claude Code 的 Bash 權限檢查。'},
  workspaceRegistry:unsupported('Claude 端沒有 DSH 工作區登記的對應，也沒有子程序模組。'),
  connection:{claudeCapability:null,handledBy:'child-host',level:PARTIAL,note:'有原插件畫面時，畫面透過它呼叫插件自己的後端（用 /<插件名稱>-ui 開啟）；沒有畫面時只是登記成功，不會有呼叫進來。放在 DSH 聊天裡的面板與卡片不會出現。'},
  sessionController:unsupported('Claude 端沒有 DSH 對話控制的對應，也沒有子程序模組。'),
  sessions:unsupported('DSH 的對話紀錄寫入與控制沒有對應；讀取請用 sessionQuery。'),
  sessionQuery:{claudeCapability:'session.event（mod 轉送的對話）',handledBy:'mod+child-host',level:PARTIAL,note:'只讀得到目前這個 Claude Code 對話，而且只有插件啟動之後、插件選項 shareConversation 開著時轉來的部分（最多 2000 筆事件）；讀不到其他對話或更早的紀錄。'},
  agentDefaultModel:{claudeCapability:'$.session.model',handledBy:'mod+child-host',level:PARTIAL,note:'currentSelection() 回傳這個工作階段的 Claude 模型（provider 是 anthropic）；不能切換模型，也查不到 DSH 服務商的餘額。'}
};
// 跟著對話的寫法（lib/inspect.mjs 的 chatEvents）。不是 DSH 服務，所以另列。
const CHAT_ROWS={
  'session/event':{dshService:'session/event（對話事件）',claudeCapability:'prompt.submit、tool.call、turn.complete 掛鉤 → session.event',handledBy:'mod+child-host',level:PARTIAL,note:'使用者訊息、工具呼叫和結果、Claude 的回答、回合開始和結束，照 DSH 的格式轉給插件；子代理的回合、斜線指令、系統自己送的通知不算。插件選項 shareConversation 預設開啟，第一次會顯示通知；沒有 DSH 的步驟、思考過程和串流。'},
  'agent/created':{dshService:'agent/created（主對話代理）',claudeCapability:'session.event',handledBy:'mod+child-host',level:PARTIAL,note:'整個 Claude Code 對話是一個代理：有狀態（閒置／執行中）、lastReply、whenIdle、followup；不能中斷 Claude 的回合。'},
  'agent.followup':{dshService:'agent.followup（主動送訊息）',claudeCapability:'prompt.submit（反向請求 → $.prompt.submit）',handledBy:'mod+child-host',level:PARTIAL,enabledByDefault:false,note:'插件的訊息在 Claude Code 閒置時以插件名義送出，開啟一個新回合。預設關閉，使用者要在插件選項開啟 allowFollowups；關閉時插件收到 DISABLED，畫面只通知一次。'},
};
CHAT_ROWS['agent/disposed']=CHAT_ROWS['agent/created'];CHAT_ROWS['agent/status']=CHAT_ROWS['agent/created'];
const INTERCEPTION_ROWS=[
  {dshService:'tools/pre-execute',claudeCapability:'tool.call 掛鉤 → interception.pre',handledBy:'mod+child-host',level:PARTIAL,note:'工具執行前，mod 的 tool.call 掛鉤問子程序，回 allow 或 deny（可改寫輸入）。僅在分析偵測到攔截或使用者啟用時才打開（features.interception）。'},
  {dshService:'tools/post-execute',claudeCapability:'tool.call 掛鉤 → interception.post',handledBy:'mod+child-host',level:PARTIAL,note:'工具執行後，mod 的 tool.call 掛鉤把結果交給子程序，可取代結果。同上，預設跟隨偵測結果。'}
];
// 狀態規則：converted = 沒有未轉項目（omitted）也沒有相容性警告（warnings）；partial = 其中之一不為空。
// - HOST_SERVICES 是檢查來源時的結果：「來源需要哪些宿主服務」。Claude 版由 serviceMapping 逐項判斷（systemPrompt 經 prompt.compose 提供；
//   真正不支援的服務由 SERVICE_UNSUPPORTED 列入 omitted），所以它本身不再讓狀態變成 partial，只留在 notes。
// - 版本範圍不符（HOST_VERSION_*）不是「沒轉」，但不是無害的提醒：整合測試（tests/e2e-claude.test.mjs）實測，四個允許的來源在內附官方套件
//   0.2.1-rc.2 下，輸出含 undefined 欄位的動作會被官方輸出驗證拒絕（"value is not lossless JSON"）。是否由版本差異造成是假說（沒有在來源宣告的版本上對照過）。
//   因此列在 warnings 並讓狀態維持 partial；--lenient-output 會丟掉值為 undefined 的欄位，實測可避開這個錯誤。
const ADVISORY_ISSUES=new Set(['HOST_SERVICES']);
const UNCERTAIN_NOTE='靜態分析無法確認這是 DSH 服務；不當作服務掛載，也沒有列入對應。';

/** 依靜態分析結果建出服務對應表。純函式，不執行來源。 */
export function buildServiceMapping(plan,{interception=false}={}){
  const used=new Map();
  const add=(service,origin)=>{if(!used.has(service))used.set(service,origin);};
  for(const name of plan.host?.services??[])add(name,'static-analysis');
  for(const name of plan.capabilities?.hostRuntime?.services??[])add(name,'static-analysis');
  if(plan.capabilities?.toolRuntime||plan.capabilities?.hostRuntime)add('tools','static-analysis');
  if((plan.capabilities?.commands?.definitions??[]).length)add('commands','static-analysis');
  const uncertain=new Map();
  for(const item of plan.host?.uncertainServices??[]){
    if(Object.hasOwn(SERVICE_MAP,item.name))add(item.name,'static-analysis-uncertain');
    else if(!uncertain.has(item.name))uncertain.set(item.name,{name:item.name,path:item.path,line:item.line,kind:item.kind,note:UNCERTAIN_NOTE});
  }
  const rows=[...used].map(([service,origin])=>{
    const row=SERVICE_MAP[service]??unsupported('此轉換器的規格沒有列出這個服務的對應。');
    return {dshService:service,detectedBy:origin,...row,enabledByDefault:row.enabledByDefault??(row.level===NONE?false:true)};
  });
  const chatRows=new Set((plan.host?.chatEvents??[]).map(item=>CHAT_ROWS[item.name]).filter(Boolean));
  rows.push(...[...chatRows].map(row=>({detectedBy:'static-analysis',...row,enabledByDefault:row.enabledByDefault??true})));
  if(interception)rows.push(...INTERCEPTION_ROWS.map(row=>({detectedBy:'static-analysis',enabledByDefault:true,...row})));
  const summary={complete:0,partial:0,unsupported:0};
  for(const row of rows){if(row.level===FULL)summary.complete++;else if(row.level===PARTIAL)summary.partial++;else summary.unsupported++;}
  return {rows,summary,uncertain:[...uncertain.values()]};
}

/**
 * 靜態分析找到的「改變模型或工具行為」證據（見 lib/inspect.mjs 的 modelBehavior）：網頁搜尋後端（web-provider）、模型供應商（llm-provider）、
 * 模型串流／能力攔截（llm-hook）、工具執行前後攔截（tool-hook）、每步攔截（agent-hook）。
 * 系統提示段落（prompt-section）只留在 plan.host.behaviors 當證據，不算：100 個來源裡宣告 DSH 前端又登記提示段落的三個插件
 * （dsh-armory、dsh-messaging-gateway、dsh-auth-tunnel），那些段落都是替 DSH 的對話代理或 DSH 網頁入口寫的。
 */
export function modelBehaviors(plan){return (plan.host?.behaviors??[]).filter(item=>item.kind!=='prompt-section');}

/**
 * 純 DSH 介面插件：標為原生介面，且沒有工具、技能、命令、MCP，也沒有改變模型或工具行為的程式（網頁搜尋後端、模型供應商、
 * 各種攔截、系統提示段落）。只有找不到可載入的前端時才記為不適用；有前端的插件可由獨立網頁承載。
 * 只有計時器或 webServer 路由、但宣告了 DSH 前端（dsh.client）的插件，那些路由與計時器是替自己的前端服務，仍算純介面；
 * 沒有宣告前端的插件本來就不是原生介面，不經過這個判斷。
 */
export function isPureNativeUi(plan){
  const native=Boolean(plan.host?.client)||(plan.issues??[]).some(item=>item.code==='NATIVE_UI');
  if(!native||plan.host?.frontend)return false;
  const commands=plan.capabilities?.commands??{};
  return !plan.capabilities?.toolRuntime&&!(plan.capabilities?.skills??[]).length&&!(commands.definitions??[]).length&&!(commands.dynamicRegistrations??[]).length&&!Object.keys(plan.capabilities?.mcpServers??{}).length&&!(plan.capabilities?.pythonServers??[]).length&&!modelBehaviors(plan).length;
}

// 靜態工具名稱要和子程序宿主回報的一致：有 lib/claude-host/tools.mjs 就用它的 claudeToolName，否則用同樣規則的備用版。
const fallbackToolName=(name,used)=>{const base=String(name).replace(/[^A-Za-z0-9_-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,64)||'tool';let result=base,n=1;while(used.has(result)){n+=1;const suffix='_'+n;result=base.slice(0,64-suffix.length)+suffix;}used.add(result);return result;};
async function loadToolNamer(){
  const file=path.join(converterRoot,'lib','claude-host','tools.mjs');
  if(await exists(file)){try{const module=await import(pathToFileURL(file).href);if(typeof module.claudeToolName==='function')return module.claudeToolName;}catch{/* 用備用版 */}}
  return fallbackToolName;
}

/** Compile the plugin entry once, at conversion time, into runtime/plugin.mjs (+ plugin.meta.json).
 * Same esbuild settings as the worker's start-up compile (lib/precompile-entry.mjs); only paths are portable.
 * Without it the worker would start esbuild.exe on every launch, which fails when the plugin sits in a very deep path on Windows. */
async function precompilePluginEntry({outputDir,entry,entries,sourceNodePaths=[]}){
  const runtimeRoot=path.join(outputDir,'runtime','host-env'),sourceRoot=path.join(outputDir,'source');
  const entryFile=path.resolve(sourceRoot,entry),outfile=path.join(outputDir,'runtime',PRECOMPILED_ENTRY_FILE),pluginsDir=path.join(outputDir,'runtime','plugins');
  const requireFromHost=createRequire(path.join(runtimeRoot,'package.json'));
  const nodePaths=[...sourceNodePaths.map(item=>path.resolve(outputDir,item)),path.join(runtimeRoot,'node_modules')];
  const lazyDependencies=[],compat=[];
  const addUnique=(list,row,same)=>{if(!list.some(x=>same(x,row)))list.push(row);};
  // Compile one entry; returns the lazy/compat rows that this entry alone produced (the worker reports them per entry).
  const compileOne=async(file,target)=>{
    const lazy=[],used=[];
    await compileDshEntry({esbuild,requireFromHost,entry:file,outfile:target,sourceRoot,nodePaths,portable:true,
      onLazyDependency:row=>{addUnique(lazy,{specifier:row.specifier,kind:row.kind,mode:row.mode},(x,y)=>x.specifier===y.specifier&&x.mode===y.mode);},
      onCompat:row=>used.push({package:row.package,olderRelease:row.olderRelease,provides:row.provides})});
    for(const row of lazy)addUnique(lazyDependencies,row,(x,y)=>x.specifier===y.specifier&&x.mode===y.mode);
    for(const row of used)addUnique(compat,row,(x,y)=>x.package===y.package);
    return {lazy,used};
  };
  const meta={schemaVersion:PRECOMPILED_SCHEMA_VERSION,entry:path.relative(sourceRoot,entryFile).split(path.sep).join('/'),lazyDependencies,compat};
  try{
    if(entries?.length){
      // A bundle whose patch mounts several plugin entries: runtime/plugins/<id>.mjs per entry, listed in plugin.meta.json.
      await fs.mkdir(pluginsDir,{recursive:true});
      meta.entries=[];
      for(const item of entries){
        const file=path.resolve(sourceRoot,item.entry),target=path.join(pluginsDir,item.id+'.mjs');
        const {lazy,used}=await compileOne(file,target);
        meta.entries.push({id:item.id,entry:path.relative(sourceRoot,file).split(path.sep).join('/'),file:'plugins/'+item.id+'.mjs',lazyDependencies:lazy,compat:used,bytes:(await fs.stat(target)).size});
      }
      await jsonWrite(path.join(outputDir,'runtime',PRECOMPILED_META_FILE),meta);
      return {file:'runtime/plugins/',entries:meta.entries.map(({id,entry:entryPath,file,bytes})=>({id,entry:entryPath,file:'runtime/'+file,bytes})),bytes:meta.entries.reduce((sum,item)=>sum+item.bytes,0),lazyDependencies,compat};
    }
    await compileOne(entryFile,outfile);
    await jsonWrite(path.join(outputDir,'runtime',PRECOMPILED_META_FILE),meta);
  }catch(error){
    await fs.rm(outfile,{force:true});await fs.rm(pluginsDir,{recursive:true,force:true});await fs.rm(path.join(outputDir,'runtime',PRECOMPILED_META_FILE),{force:true});throw error;
  }
  return {file:'runtime/'+PRECOMPILED_ENTRY_FILE,bytes:(await fs.stat(outfile)).size,lazyDependencies,compat};
}

async function loadBuildClaudeHost(){
  const file=path.join(converterRoot,'lib','claude-host','build.mjs');
  if(!await exists(file))throw Object.assign(new Error('lib/claude-host/build.mjs 不存在，無法打包子程序宿主'),{code:'CLAUDE_HOST_MISSING'});
  const module=await import(pathToFileURL(file).href);
  if(typeof module.buildClaudeHost!=='function')throw Object.assign(new Error('lib/claude-host/build.mjs 沒有匯出 buildClaudeHost'),{code:'CLAUDE_HOST_MISSING'});
  return module.buildClaudeHost;
}

async function copySkills({outputDir,plan,report}){
  const skillsDir=path.join(outputDir,'skills'),used=new Set(),copied=[];
  for(const skill of plan.capabilities.skills){
    const dirName=claudeSkillDirName(skill.name);
    if(used.has(dirName)){report.conversion.omitted.push({code:'SKILL_COLLISION',message:`技能資料夾名稱重複：${dirName}（${skill.name}），後者未複製`});continue;}
    used.add(dirName);
    const sourceDir=path.dirname(skill.path)==='.'?null:path.join(outputDir,'source',path.dirname(skill.path));
    const destination=path.join(skillsDir,dirName);
    await fs.mkdir(destination,{recursive:true});
    if(sourceDir)await fs.cp(sourceDir,destination,{recursive:true,filter:file=>!['node_modules','.git'].includes(path.basename(file))});
    else{await fs.copyFile(path.join(outputDir,'source',skill.path),path.join(destination,'SKILL.md'));report.conversion.omitted.push({code:'SKILL_AT_SOURCE_ROOT',message:`技能 ${skill.name} 的 SKILL.md 在來源根目錄，只複製 SKILL.md，不複製同層的其他檔案`});}
    copied.push(dirName);
    report.conversion.components.push({kind:'skill',name:skill.name,path:`skills/${dirName}`,status:'copied-unexecuted'});
  }
  if(copied.length)report.conversion.omitted.push({code:'SKILL_HOST_CONTEXT',message:'技能原樣複製，內容沒有改寫；其中提到的 DSH 專屬工具、事件名稱或路徑在 Claude Code 裡不一定存在，也尚未逐項驗證。'});
  return copied;
}

export async function convertToClaude(input,{outputDir,cacheDir,npmCacheDir,ref,name,version,config={},allowTools=[],sourceEntry,packageDir='.',installDependencies=true,passEnv=[],homeMode='isolated',initializeTimeoutMs=120000,callTimeoutMs=60000,cancelGraceMs=1000,lenientOutput=false,moduleOptions={},services,stateMode='persistent',stateRoot,workspace,startupTimeoutMs,dependencyRunner,buildClaudeHost,templatesDir,precompileEntry=true,allowUnreviewable=false,outboundTool=[],notOutboundTool=[]}={}){
  for(const [key,list]of Object.entries({outboundTool,notOutboundTool}))if(!Array.isArray(list)||list.some(item=>typeof item!=='string'||!item.trim()))throw new Error(key+' 必須是工具名稱陣列');
  const configuredEnvNames=configuredEnvironmentNames(moduleOptions);
  if(typeof installDependencies!=='boolean'||typeof lenientOutput!=='boolean')throw new Error('安裝依賴與寬鬆輸出選項必須是布林值');
  if(!['isolated','real'].includes(homeMode))throw new Error('homeMode 必須是 isolated 或 real');
  if(!Array.isArray(passEnv)||passEnv.some(item=>!envName(item)))throw new Error('passEnv 必須只包含環境變數名稱');
  for(const [key,value]of Object.entries({initializeTimeoutMs,callTimeoutMs,cancelGraceMs}))if(typeof value!=='number'||!Number.isFinite(value)||value<(key==='cancelGraceMs'?0:1))throw new Error(key+' 必須是有效毫秒數');
  if(!['persistent','package'].includes(stateMode))throw new Error('stateMode 必須是 persistent 或 package');
  if(!Array.isArray(allowTools)||allowTools.some(value=>typeof value!=='string'||!value.trim())||new Set(allowTools).size!==allowTools.length)throw new Error('allowTools 必須是不重複的工具名稱陣列');
  if(name!==undefined&&(typeof name!=='string'||!name.trim()))throw new Error('name 必須是非空字串');
  if(!outputDir)throw new Error('需要 --out 指定新的輸出資料夾');
  outputDir=path.resolve(outputDir);
  if(await exists(outputDir))throw new Error('輸出資料夾已存在；為保留使用者修改，請指定新資料夾');

  const source=await acquireSource(input,{cacheDir:cacheDir??path.join(path.dirname(outputDir),'.dsh-source-cache'),ref,npmCacheDir});
  if(inside(source.root,outputDir)||inside(outputDir,source.root))throw new Error('來源與輸出資料夾不可互相包含');
  const plan=await inspectSource(source,{sourceEntry,packageDir});
  // 安全掃描（固定規則）：混淆過的程式碼無法審查，預設拒絕轉換。
  const scan=await scanSecurity(source.root,{packageDir:plan.packageDir,outboundTool,notOutboundTool});
  if(scan.summary.obfuscated&&!allowUnreviewable){
    const files=scan.obfuscation.files.filter(item=>item.context!=='test');
    throw Object.assign(new Error(`偵測到混淆過的程式碼，無法審查，預設拒絕轉換：${files.slice(0,5).map(item=>`${item.path}（${item.reasons[0]}）`).join('；')}${files.length>5?`；另有 ${files.length-5} 個檔案`:''}。混淆的程式看不出實際在做什麼，安裝等於盲目執行第三方程式。確定要轉換請加 --allow-unreviewable。`),{code:'UNREVIEWABLE_CODE',files:files.map(item=>item.path)});
  }
  const configSecrets=configSecretPaths(config);
  const secretOptions=secretOptionsFromScan(scan,{displayName:plan.name});
  const pluginName=name!==undefined?claudePluginName(name):claudePluginName(plan.name);
  const pluginVersion=claudePluginVersion(version??plan.version);
  const converterVersion=JSON.parse(await fs.readFile(path.join(converterRoot,'package.json'),'utf8')).version;
  const forwardedNames=[...new Set([...defaultProxyNames,...(plan.environment?.requiredNames??[]),...passEnv,...configuredEnvNames,...secretOptions.map(item=>item.env)])].sort();
  const stateId=stablePluginId({origin:source.origin,packageDir:plan.packageDir,name:plan.name});
  const hostOptions={passEnv:forwardedNames,homeMode,initializeTimeoutMs,callTimeoutMs,cancelGraceMs,lenientOutput,moduleOptions,services,background:false,stateId,stateMode,...(stateRoot?{stateRoot}:{})};
  const report={
    schemaVersion:1,target:'claude-code-plugin',converter:{name:'D_sh-are_in_cc',version:converterVersion},
    source:{...plan.source,name:plan.name,version:plan.version,license:plan.license,packageDir:plan.packageDir,entry:plan.entry},
    description:plan.description,defaultConfig:reportConfiguration(plan.defaultConfig),serviceConfig:reportConfiguration(plan.serviceConfig),
    runtimeCompatibility:plan.runtimeCompatibility,environment:plan.environment,homeAccess:plan.homeAccess,host:plan.host,issues:plan.issues,
    plugin:{name:pluginName,version:pluginVersion,layout:null},
    conversion:{engine:'fixed-rules',modelCalls:0,generatedAt:new Date().toISOString(),status:'unsupported',reason:null,components:[],omitted:plan.issues.filter(item=>!ADVISORY_ISSUES.has(item.code)),warnings:[],notes:[],serviceMapping:[],uncertainServices:[],verification:{claudeLoaded:false,toolsListed:false,toolsCalled:[],note:'轉換不載入 Claude Code，也不啟動子程序宿主；以下對應與完整度是設計層面的說明，尚未在實際工作階段驗證。'}}
  };
  const finish=async()=>{await jsonWrite(path.join(outputDir,'conversion-report.json'),report);return report;};
  await fs.mkdir(outputDir,{recursive:true});

  // ---- 安全掃描結果 ----
  // 對外發文工具的 Claude 名稱：和 staticTools 用同一個命名規則與順序，掃描多找到的工具接在後面。
  const toolNamer=await loadToolNamer(),namingUsed=new Set(),claudeNames=new Map();
  for(const tool of plan.capabilities.toolRuntime?.tools??[])if(!claudeNames.has(tool.name))claudeNames.set(tool.name,toolNamer(tool.name,namingUsed));
  const outboundTools=scan.tools.filter(item=>item.outbound).map(item=>{
    if(!claudeNames.has(item.name))claudeNames.set(item.name,toolNamer(item.name,new Set(namingUsed)));
    const firstLine=String(item.description??'').split(/\n|。|\.\s/)[0].trim();
    return {name:claudeNames.get(item.name),dshName:item.name,kind:item.kind??'other',targetFields:item.targetFields??[],textFields:item.textFields??[],summary:(firstLine||`用你的帳號對外送出內容（${item.name}）`).slice(0,160)};
  });
  const embeddedSecrets=secretOptions.map(({option,env,title,features,required})=>({option,env,title,features,required}));
  report.security={engine:'fixed-rules',report:'security-report.json',summaryFile:'SECURITY.md',verdict:scan.summary.verdict,allowUnreviewable,
    obfuscatedFiles:scan.summary.obfuscatedFiles,spawnsProcesses:scan.summary.spawnsProcesses,programs:scan.summary.programs,usesNetwork:scan.summary.usesNetwork,domains:scan.summary.domains,
    secretNames:scan.summary.secretNames,outboundTools:outboundTools.map(item=>item.name),secretOptions:secretOptions.map(item=>item.option),configSecrets};
  if(configSecrets.length)report.conversion.notes.push({code:'CONFIG_SECRET_IN_SETTINGS',message:`--config 裡有看起來是金鑰的欄位（${configSecrets.map(item=>item.path).join('、')}）：值會以純文字寫進 runtime/settings.json，分享插件資料夾就會跟著出去。建議改用插件選項的金鑰欄位${secretOptions.length?`（${secretOptions.map(item=>item.option).join('、')}）`:'（secret_<環境變數名稱>）並讓插件從環境變數讀取'}。值沒有記錄。`,paths:configSecrets.map(item=>item.path)});
  if(scan.summary.obfuscated)report.conversion.notes.push({code:'UNREVIEWABLE_ALLOWED',message:'偵測到混淆過的程式碼，使用者以 --allow-unreviewable 堅持轉換：'+scan.summary.obfuscatedFiles.join('、')});
  await jsonWrite(path.join(outputDir,'security-report.json'),{...scan,configSecrets,outboundTools,secretOptions:embeddedSecrets,allowUnreviewable});
  await fs.writeFile(path.join(outputDir,'SECURITY.md'),renderSecurityMarkdown(scan,{displayName:plan.name,pluginName,outboundTools,secretOptions,allowUnreviewable,configSecrets}),'utf8');

  if(isPureNativeUi(plan)&&!plan.host?.frontend){
    report.conversion.status='not-applicable';
    report.conversion.reason='純 DSH 原生介面插件：沒有工具、技能、命令、MCP，也沒有網頁搜尋後端、模型供應商或模型／工具攔截，Claude Code 沒有對應的 DSH 介面可以承接，因此不產生插件。這不是轉換失敗。';
    report.conversion.intrinsicallyUnsupported=[{feature:'DSH-native-UI',reason:'找不到可載入的前端檔案；也沒有可轉換的工具或技能'}];
    return finish();
  }
  if(plan.host?.client&&!plan.host?.frontend&&modelBehaviors(plan).length)report.conversion.notes.push(`此插件同時宣告 DSH 前端：前端部分不轉換；仍轉換的是改變模型或工具行為的部分（${[...new Set(modelBehaviors(plan).map(item=>item.kind))].join('、')}）。`);
  if(!plan.convertible){
    report.conversion.reason='靜態分析找不到可轉換的內容（沒有技能、MCP 或可執行的 DSH 入口）';
    return finish();
  }

  report.conversion.sourceCopy=await copySource(source.root,path.join(outputDir,'source'));
  report.conversion.runtimeOptions={passEnv:forwardedNames,homeMode,initializeTimeoutMs,callTimeoutMs,cancelGraceMs,lenientOutput,stateId,stateMode};
  let packagedUi=null;
  if(plan.host?.frontend){
    packagedUi=await preparePluginUi({converterRoot,outputDir,sourceRoot:source.root,packageDir:plan.packageDir});
    report.conversion.components.push({kind:'dsh-ui',status:'packaged-not-executed',sourceExecuted:false,clients:packagedUi.clients});
    report.conversion.notes.push({code:'ORIGINAL_UI',message:'原插件設定頁、主頁與浮窗可由獨立網頁載入；聊天外觀不處理。原後端服務是否齊備仍以實際操作為準。'});
  }
  const wantsHost=Boolean(plan.capabilities.hostRuntime||(packagedUi&&plan.entry));
  let hostBuilt=null,bridgeConfig=null;

  if(wantsHost){
    const dependencyPlan=await planSourceDependencies(source,{packageDir:plan.packageDir});
    const sourceDependencies=await installSourceDependencies(dependencyPlan,{destination:outputDir,enabled:installDependencies,...(dependencyRunner?{runner:dependencyRunner}:{}),onPlan:async proposed=>{report.conversion.sourceDependencies=proposed;await jsonWrite(path.join(outputDir,'conversion-report.json'),report);}});
    report.conversion.sourceDependencies=sourceDependencies;
    if(sourceDependencies.status==='failed')report.conversion.omitted.push({code:'SOURCE_DEPENDENCIES_FAILED',message:sourceDependencies.error.message,dependencyError:sourceDependencies.error.code});
    if(sourceDependencies.status==='disabled'&&sourceDependencies.packages.length)report.conversion.omitted.push({code:'SOURCE_DEPENDENCIES_DISABLED',message:'已依選項略過來源正式依賴安裝；尚未確認來源可編譯或啟動'});
    hostOptions.serviceConfig={web:webConfiguration(plan)};
    hostOptions.sourceNodePaths=sourceDependencies.nodePaths.map(item=>'./'+path.relative(outputDir,item).split(path.sep).join('/'));
    // A patch that mounts several plugin entries (dsh-agentmail): each row is its own plugin; `!!js process.env.X` config values stay
    // expressions here and are evaluated by the worker from the passEnv environment, so no value is written to disk.
    if(plan.entries?.length){
      hostOptions.entries=plan.entries.map(({id,name,entry:entryPath,config:entryConfig})=>({id,name,entry:entryPath,config:entryConfig}));
      report.conversion.entries=plan.entries.map(({id,name,subpath,entry:entryPath,config:entryConfig})=>({id,name,subpath,entry:entryPath,config:entryConfigForReport(entryConfig)}));
      report.conversion.notes.push({code:'PATCH_ENTRIES',message:`cordis.patch.yml 掛載了 ${plan.entries.length} 個插件列（${plan.entries.map(item=>item.id).join('、')}）：每列各自編譯、各自成為一個 Cordis 插件；設定取自 patch，\`!!js process.env.X\` 於啟動時由 passEnv 傳入的環境變數取值（沒有就是 undefined）。任何一列沒有啟動，整個宿主視為啟動失敗（例如核准列不可在缺席下放行寄信）。`});
    }
    const aliasRows=planVersionAliases(plan.runtimeCompatibility?.mismatches);
    if(aliasRows.length){
      hostOptions.versionAliases=aliasRows.map(({name,version})=>({name,version}));
      report.conversion.notes.push({code:'VERSION_ALIAS',message:'來源以精確版本檢查官方套件；已在比對過它用到的介面後，讓它看到符合的版本（外殼套件重新匯出內附的真實套件，不另裝第二份）：'+aliasRows.map(item=>`${item.name} 回報 ${item.version}（實際內附 ${item.hostVersion}；比對過 ${item.comparedExports.join('、')}）`).join('；'),aliases:aliasRows});
    }
    for(const item of plan.runtimeCompatibility?.mismatches??[])report.conversion.warnings.push({code:'HOST_VERSION_MISMATCH',message:`官方執行套件 ${item.name} 的版本 ${item.installed} 不符合來源 ${item.declaredIn} 宣告的 ${item.requested}；不能據此把原工具失敗歸因於 Claude Code，需在來源支援的 DSH 版本對照驗證`,...item});
    for(const item of plan.runtimeCompatibility?.unresolved??[])if(!item.optional)report.conversion.warnings.push({code:'HOST_VERSION_UNCONFIRMED',message:`無法確認來源宣告的官方套件 ${item.name}@${item.requested} 與內附執行環境相容；未安裝或替換來源依賴`,...item});
    try{
      const built=await buildOfficialHost({converterRoot,outputDir,plan,config,allowTools,workspace,options:hostOptions});
      // 子程序宿主讀 settings.claudeHost.* 決定資料目錄；其餘欄位沿用官方宿主的設定格式。
      if(stateRoot){const file=path.join(outputDir,'runtime','settings.json'),settings=JSON.parse(await fs.readFile(file,'utf8'));settings.claudeHost={...settings.claudeHost,stateRoot:path.resolve(stateRoot)};await jsonWrite(file,settings);}
      const build=buildClaudeHost??await loadBuildClaudeHost();
      await build({outputDir});
      if(!await exists(path.join(outputDir,'runtime','claude-host.mjs')))throw Object.assign(new Error('buildClaudeHost 沒有產生 runtime/claude-host.mjs'),{code:'CLAUDE_HOST_MISSING'});
      hostBuilt=built;
      // 假的 `dsh` 命令列（runtime/dsh-cli）：插件自己執行 `dsh --profile ... <提示詞>` 時改由 Claude 子代理執行。
      try{const cli=await buildDshCli({outputDir,sourceDir:path.join(outputDir,'source')});report.conversion.notes.push({code:'DSH_CLI_STAND_IN',message:'已產生假的 dsh 命令列（runtime/dsh-cli）；執行時 PATH 最前面會放它，插件執行 dsh 提示詞時改由 Claude 子代理執行（需開啟 allowAgents）。只支援「--profile / --patch / 提示詞」；plugin、web 等子命令與 overlay 裡的 MCP 伺服器不支援。',resolvableFromSource:cli.resolvableFromSource});}
      catch(error){report.conversion.notes.push({code:'DSH_CLI_SKIPPED',message:'假的 dsh 命令列沒有建成：'+String(error.message).split('\n')[0].slice(0,500)});}
      if(precompileEntry){
        try{report.conversion.precompiledEntry=await precompilePluginEntry({outputDir,entry:built.settings.entry,entries:plan.entries,sourceNodePaths:hostOptions.sourceNodePaths});}
        catch(error){report.conversion.notes.push({code:'PRECOMPILE_SKIPPED',message:'轉換時預先編譯入口失敗，啟動時會改在執行時編譯（同樣的設定，原因通常會重現）：'+String(error.message).split('\n')[0].slice(0,1000)});}
      }
      report.conversion.components.push({kind:'dsh-host',name:'claude-host',status:'built-not-executed',host:'official-dsh-cordis',packages:built.environment.packages,runtimeTemplate:built.runtimeTemplate,sourceExecuted:false});
    }catch(error){
      report.conversion.omitted.push({code:error.code==='CLAUDE_HOST_MISSING'?'CLAUDE_HOST_MISSING':'HOST_BUILD',message:String(error.message).split('\n')[0].slice(0,2000)});
      for(const file of ['runtime/claude-host.mjs','runtime/dsh-host-worker.mjs','runtime/settings.json'])await fs.rm(path.join(outputDir,file),{force:true});
      await fs.rm(path.join(outputDir,'runtime','host-env'),{recursive:true,force:true});
    }
  }else{
    if(plan.capabilities.toolRuntime||plan.host.features.length)report.conversion.omitted.push({code:'NO_HOST_ENTRY',message:'分析找到工具或宿主服務，但沒有可執行的 DSH 入口，未產生子程序宿主'});
  }
  if(packagedUi&&!hostBuilt){
    const settings={name:plan.name,claudeHost:{uiOnly:true}};
    await jsonWrite(path.join(outputDir,'runtime/settings.json'),settings);
    await (buildClaudeHost??await loadBuildClaudeHost())({outputDir});
    hostBuilt={settings};
    report.conversion.components.push({kind:'dsh-ui-host',status:'built-not-executed',backend:false,sourceExecuted:false});
  }
  for(const key of Object.keys(plan.capabilities.mcpServers))report.conversion.omitted.push({code:'MCP_NOT_MAPPED',message:`來源宣告的 MCP 連線 ${key} 未轉成 Claude 插件的 .mcp.json；此版本不處理`});
  for(const item of plan.capabilities.pythonServers)report.conversion.omitted.push({code:'PYTHON_CANDIDATE_ONLY',message:`內附 Python 服務 ${item.path} 僅是候選，未掛載`});

  // ---- 技能與 Claude 插件檔案 ----
  const copiedSkills=await copySkills({outputDir,plan,report});
  const mapping=buildServiceMapping(plan,{interception:Boolean(hostBuilt?.settings?.interception)});
  report.conversion.serviceMapping=mapping.rows;
  report.conversion.serviceSummary=mapping.summary;
  report.conversion.uncertainServices=mapping.uncertain;
  report.conversion.requiredServices=plan.host?.services??[];
  report.conversion.intrinsicallyUnsupported=[...(plan.host?.client?[{feature:'DSH-chat-appearance',reason:'不修改 Claude Code 的聊天外觀；原插件的獨立畫面可由瀏覽器開啟'}]:[]),{feature:'DSH-model-provider-replacement',reason:'無法從來源插件替換 Claude Code 自身的模型供應商'},{feature:'DSH-internal-agent-loop',reason:'無法改造 Claude Code 的內部代理執行流程'}];
  for(const row of mapping.rows)if(row.level===NONE)report.conversion.omitted.push({code:'SERVICE_UNSUPPORTED',message:`DSH 服務 ${row.dshService} 不支援：${row.note}`,service:row.dshService});
  if(mapping.uncertain.length)report.conversion.omitted.push({code:'SERVICE_UNCERTAIN',message:`靜態分析無法確認的名稱：${mapping.uncertain.map(item=>item.name).join(', ')}；不當作服務掛載`});

  const description=((plan.description||'').trim()?`${plan.description.trim()}（由 DSH 插件 ${plan.name} 轉換）`:`由 DSH 插件 ${plan.name} 轉換`).slice(0,1000);
  const producible=hostBuilt||copiedSkills.length;
  if(producible){
    const templates=await readTemplates(templatesDir??defaultTemplatesDir(converterRoot));
    if(hostBuilt){
      const interception=Boolean(hostBuilt.settings.interception);
      const usedToolNames=new Set();
      bridgeConfig={schemaVersion:1,pluginName,displayName:plan.name,hostEntry:'runtime/claude-host.mjs',node:'node',startupTimeoutMs:startupTimeoutMs??initializeTimeoutMs,callTimeoutMs,
        features:{tools:true,commands:true,systemPrompt:true,interception,ui:Boolean(packagedUi)},
        staticTools:(plan.capabilities.toolRuntime?.tools??[]).map(tool=>({dshName:tool.name,name:toolNamer(tool.name,usedToolNames),description:tool.description??'',inputSchema:{type:'object'}})),
        // 約定 2：對外發文工具、金鑰欄位、安全報告檔名（mod 端讀取）。
        outboundTools,secretOptions:embeddedSecrets,securityReport:'security-report.json'};
      await writeClaudeModFiles({outputDir,templates,name:pluginName,version:pluginVersion,description,bridgeConfig});
      const manifest=await mergeSecretUserConfig(outputDir,secretOptions);
      await writePluginReadme(outputDir,{name:pluginName,displayName:plan.name,description,userConfig:manifest.userConfig,outboundTools,secretOptions,securitySummary:scan.summary,ui:Boolean(packagedUi)});
      report.plugin.layout='bridge';
      report.plugin.bridgeConfig={...bridgeConfig,staticTools:bridgeConfig.staticTools.map(({dshName,name})=>({dshName,name})),outboundTools:outboundTools.map(({name,dshName,kind})=>({name,dshName,kind})),secretOptions:embeddedSecrets.map(({option,env})=>({option,env}))};
      for(const issue of plan.issues.filter(item=>item.code==='HOST_SERVICES'))report.conversion.notes.push({code:'HOST_SERVICES_MAPPED',message:issue.message+'；Claude 版對應見 serviceMapping，不支援的服務另列在 omitted（SERVICE_UNSUPPORTED）。'});
      report.conversion.notes.push({code:'HOST_BOUNDARIES',message:'子程序宿主沿用官方 DSH 的工具政策、設定與提示內容；不建立 DSH 模型迴圈、不接管 Claude 的模型、不改聊天介面。工具清單以子程序啟動後回報為準，靜態清單只供參考。'});
    }else{
      const {manifest}=await writeClaudeManifestOnly({outputDir,templates,name:pluginName,version:pluginVersion,description});
      await writePluginReadme(outputDir,{name:pluginName,displayName:plan.name,description,userConfig:manifest.userConfig,outboundTools:[],secretOptions:[],securitySummary:scan.summary});
      report.plugin.layout='skills-only';
      if(wantsHost)report.conversion.omitted.push({code:'SKILLS_ONLY_FALLBACK',message:'子程序宿主沒有建成，只輸出技能；這個插件不會有 DSH 工具、提示或命令'});
    }
    report.conversion.status=report.conversion.omitted.length||report.conversion.warnings.length?'partial':'converted';
    if(report.conversion.status==='partial'){
      const causes=[];
      if(report.conversion.omitted.length)causes.push('有項目沒轉或不支援（omitted：'+[...new Set(report.conversion.omitted.map(item=>item.code))].join(', ')+'）');
      if(report.conversion.warnings.length)causes.push('相容性警告（warnings：'+[...new Set(report.conversion.warnings.map(item=>item.code))].join(', ')+'；來源宣告的官方套件版本與內附的不同，輸出含 undefined 欄位的動作可能被官方輸出驗證拒絕，可加 --lenient-output）');
      report.conversion.reason=causes.join('；');
    }
  }else{
    report.conversion.status='unsupported';
    report.conversion.reason=report.conversion.omitted.find(item=>['HOST_BUILD','CLAUDE_HOST_MISSING'].includes(item.code))?.message??'沒有可輸出的內容';
  }
  await finish();
  if(producible){
    report.conversion.validation=await validateClaudePackage(outputDir,{cli:false});
    if(!report.conversion.validation.valid){report.conversion.status='unsupported';report.conversion.omitted.push({code:'PACKAGE_INVALID',message:report.conversion.validation.errors.join('; ')});}
    await finish();
  }
  return report;
}
