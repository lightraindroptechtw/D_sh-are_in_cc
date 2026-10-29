// 安裝前審查與本機插件市場（dsh-local）。
// - renderReviewOverview：把固定規則掃描結果整理成白話表格（給使用者原樣看，不經 AI 改寫）。
// - installLocal：轉換到 <home>/plugins/<名稱>，登記到 <home>/.claude-plugin/marketplace.json。
//   **不**呼叫 `claude plugin install`／`claude plugin marketplace add`；那兩步交給 Claude Code（在它的權限確認下執行）。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {convertToClaude,converterRoot,buildServiceMapping,isPureNativeUi} from './converter-claude.mjs';
import {secretOptionsFromScan} from './security-scan.mjs';
import {dshHome,cacheFolderName} from './npm-source.mjs';
import {applyRewrite} from './rewrite.mjs';

export const LOCAL_MARKETPLACE_NAME='dsh-local';
const PLUGIN_NAME=/^[a-z0-9][a-z0-9-]{0,63}$/;
const exists=async file=>{try{await fs.access(file);return true;}catch{return false;}};
const readJson=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch{return null;}};
const hex=()=>crypto.randomBytes(4).toString('hex');
const slash=file=>String(file).split(path.sep).join('/');
const cell=value=>String(value??'').replace(/\r?\n/g,' ').replace(/\|/g,'\\|');
const code=list=>list.map(item=>'`'+cell(item)+'`').join('、');

export {defaultReportPath} from './downloads.mjs';

async function templateDefaults(){
  const manifest=await readJson(path.join(converterRoot,'templates','claude-mod','plugin.json'));
  return Object.fromEntries(Object.entries(manifest?.userConfig??{}).map(([key,value])=>[key,value?.default]));
}

/**
 * 掃描結果 → 白話表格（Markdown）。純整理，不判斷好壞。逐項位置（檔案與行號）不列，在完整掃描 JSON 裡，審查子代理讀那份。
 * plan 是 inspectSource 的結果（可省略；省略時不列「Claude Code 不支援的 DSH 功能」）。
 */
export async function renderReviewOverview(scan,{plan=null,source={},reportPath=null}={}){
  const s=scan.summary,lines=[];
  const live=list=>(list??[]).filter(item=>item.context!=='test');
  const name=plan?.name??scan.package.name,version=plan?.version??scan.package.version;
  lines.push(`# DSH 插件安全掃描：${name}${version?' '+version:''}`,'');
  // 裝不進 Claude Code 的插件：結論放在最前面，使用者不用讀完整張表格才知道。
  if(plan&&isPureNativeUi(plan))lines.push('> **裝不進 Claude Code**：這是純 DSH 介面插件（沒有工具、技能、命令），只改 DSH 自己的畫面。轉成 Claude Code 插件沒有意義，轉換器不會產生插件，不需要再審查或安裝。','');
  lines.push(`- 來源：\`${cell(source.origin??'')}\`${source.npm?`（npm 版本 ${source.npm.version}${source.npm.integrity?`，完整性 \`${cell(source.npm.integrity.slice(0,30))}…\``:''}）`:''}${source.commit?`（提交 \`${source.commit.slice(0,12)}\`）`:''}`);
  lines.push(`- 原始碼${source.remote?'已下載到':'位置'}：\`${cell(slash(source.root??''))}\`（**沒有安裝，也沒有執行**）`);
  if(reportPath)lines.push(`- 完整掃描結果（JSON，每項附檔案與行號）：\`${cell(slash(reportPath))}\``);
  lines.push('- 這份表格由轉換器用**固定規則**產生，沒有經過 AI。它只標出值得去看的位置，不代表安全，也不代表惡意。','');
  lines.push('## 一覽','','| 項目 | 結果 | 處數 |','|---|---|---|');
  const row=(item,result,count='')=>lines.push(`| ${item} | ${result} | ${count} |`);
  row('能不能審查',s.obfuscated?`**無法審查**：有混淆過的程式碼（${code(s.obfuscatedFiles.slice(0,5))}）`:'可以審查（沒看到混淆過的程式碼）',s.obfuscatedFiles.length||'');
  const proc=live(scan.processes),net=live(scan.network),files=live(scan.fileAccess);
  row('自己開程式',s.spawnsProcesses?`**會**：${s.programs.length?code(s.programs.slice(0,10)):''}${s.unknownPrograms?`${s.programs.length?'；':''}${s.unknownPrograms} 處看不出程式名稱`:''}`:'沒看到',proc.length||'');
  row('連網路',s.usesNetwork?`**會**：${s.domains.length?code(s.domains.slice(0,12))+(s.domains.length>12?' 等':''):'網域看不出來（網址是組出來的）'}`:'沒看到',net.length||'');
  row('寫入或刪除檔案',s.writesFiles?`**會**（${s.fileFlags.write} 處）${s.fileFlags.absolute?`，${s.fileFlags.absolute} 處用絕對路徑`:''}${s.fileFlags.parent?`，${s.fileFlags.parent} 處用 .. 往外`:''}`:'沒看到',files.length||'');
  row('用到使用者家目錄',s.fileFlags.home?`**會**（${s.fileFlags.home} 處）`:'沒看到',s.fileFlags.home||'');
  row('需要金鑰',s.secretNames.length?`**需要**：${code(s.secretNames)}`:'沒看到',s.secretNames.length||'');
  row('用你的帳號對外發文的工具',s.outboundToolNames.length?`**有**：${code(s.outboundToolNames)}`:'沒有',s.outboundToolNames.length||'');
  if(s.internalOutboundToolNames.length)row('內附 Python 工具裡會對外發文的',code(s.internalOutboundToolNames),s.internalOutboundToolNames.length);
  row('工具總數',String(s.tools),'');
  row('其他語言的檔案',s.otherLanguageFiles?`${s.otherLanguageFiles} 個，其中 ${s.otherLanguagesExecuted.length} 個可能會被執行`:'沒有',s.otherLanguageFiles||'');
  row('執行檔或二進位檔（看不到內容）',s.binaries.length?code(s.binaries.slice(0,8)):'沒有',s.binaries.length||'');
  row('安裝腳本',s.installScripts.length?`${code(s.installScripts)}（轉換與安裝時一律不執行）`:'沒有',s.installScripts.length||'');
  row('把整份環境變數交出去',s.passesWholeEnvironment?'**有**（環境變數裡可能有你其他的金鑰）':'沒看到','');
  row('寫死、看起來像金鑰的字串',s.hardcodedSecrets?`${s.hardcodedSecrets} 處（值沒有記錄）`:'沒看到',s.hardcodedSecrets||'');
  row('壓縮過的程式（難以閱讀，不算混淆）',s.minifiedFiles.length?`${s.minifiedFiles.length} 個檔案`:'沒有',s.minifiedFiles.length||'');
  lines.push('');

  const secrets=secretOptionsFromScan(scan,{displayName:name});
  if(secrets.length){
    lines.push('## 需要的金鑰（安裝後填在插件選項的敏感欄位）','','| 插件選項 | 環境變數 | 用到的功能 | 程式位置 |','|---|---|---|---|');
    for(const item of secrets)lines.push(`| \`${item.option}\` | \`${item.env}\` | ${cell(item.features)} | ${cell(item.locations.slice(0,3).map(loc=>`${loc.path}${loc.line?':'+loc.line:''}`).join('、'))} |`);
    lines.push('','金鑰存在系統的安全儲存區，不寫進插件資料夾；不需要那些功能可以留空。','');
  }

  const defaults=await templateDefaults();
  const limits=[];
  const on=key=>defaults[key]===true;
  if(s.spawnsProcesses&&!on('allowDirectExec'))limits.push(['插件自己開程式'+(s.programs.length?`（${s.programs.slice(0,6).join('、')}）`:''),'擋下','插件選項 `allowDirectExec` 打開（打開後不經 Claude Code 權限確認）']);
  if(s.outboundToolNames.length)limits.push([`對外發文（${s.outboundToolNames.slice(0,6).join('、')}）`,defaults.outboundMode==='auto'?'自動發':defaults.outboundMode==='deny'?'不准發':'每次先問你','插件選項 `outboundMode`（ask／auto／deny）']);
  const services=new Set(plan?.host?.services??[]);
  if((services.has('llm'))&&!on('allowModelCalls'))limits.push(['插件呼叫模型','關閉','插件選項 `allowModelCalls`']);
  if((services.has('agents')||services.has('subagents'))&&!on('allowAgents'))limits.push(['插件開子代理','關閉','插件選項 `allowAgents`']);
  const interception=(plan?.host?.behaviors??[]).some(item=>item.kind==='tool-hook');
  if(interception&&!on('allowInterception'))limits.push(['插件在 Claude 用工具前檢查並擋下（攔截）','關閉','插件選項 `allowInterception`']);
  const chat=new Set((plan?.host?.chatEvents??[]).map(item=>item.name));
  if(chat.has('agent.followup')&&!on('allowFollowups'))limits.push(['插件自己送出訊息（主動說話）','關閉','插件選項 `allowFollowups`']);
  if(s.fileFlags.absolute||s.fileFlags.home||s.fileFlags.parent)limits.push(['讀寫插件資料夾以外的地方','可能被擋（限制讀寫的資料夾）','插件選項 `extraFolders` 加上資料夾（以 ; 分隔的絕對路徑）']);
  if(plan?.host?.frontend)lines.push('## 原插件畫面','','設定頁、主頁和浮窗會封裝成獨立網頁；安裝後使用該插件的 /<插件名稱>-ui 指令開啟。實際可用項目取決於原插件使用的服務，聊天外觀不處理。','');
  lines.push('## 裝了之後預設會受限的功能','');
  if(limits.length){lines.push('| 功能 | 預設 | 放行方式 |','|---|---|---|');for(const [a,b,c]of limits)lines.push(`| ${cell(a)} | ${cell(b)} | ${c} |`);}
  else lines.push('- 依掃描結果，沒有會被預設保護擋下的功能。');
  if(chat.has('session/event')&&on('shareConversation'))lines.push('','- 這個插件會跟著對話：你的訊息、Claude 的回答、工具呼叫和結果都會轉給它（它原本在 DSH 就有這個功能，第一次會通知）。不要的話把插件選項 `shareConversation` 關閉。');
  lines.push('');
  if(plan){
    const mapping=buildServiceMapping(plan,{interception});
    const unsupported=mapping.rows.filter(item=>item.level==='不支援');
    const nativeUi=Boolean(plan.host?.client)&&!plan.host?.frontend;
    if(unsupported.length||nativeUi||isPureNativeUi(plan)){
      lines.push('## Claude Code 不支援的 DSH 功能','');
      if(isPureNativeUi(plan))lines.push('- 純 DSH 介面插件，裝不進 Claude Code（見最上方）。');
      else if(nativeUi)lines.push('- DSH 的畫面、側欄、設定頁不轉換。');
      for(const item of unsupported)lines.push(`- DSH 服務 \`${item.dshService}\`：${cell(item.note)}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ---------- 本機插件市場 ----------
function marketplaceFile(home){return path.join(home,'.claude-plugin','marketplace.json');}
async function writeJsonAtomic(file,data){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temp=file+'.tmp-'+hex();
  await fs.writeFile(temp,JSON.stringify(data,null,2)+'\n','utf8');
  await fs.rename(temp,file);
}
export async function readLocalMarketplace(home=dshHome()){
  const data=await readJson(marketplaceFile(home));
  return data&&typeof data==='object'&&Array.isArray(data.plugins)?data:null;
}
/** 新增或更新一個插件項目（同名覆蓋）。回傳更新後的整份 marketplace.json。 */
export async function upsertMarketplaceEntry(home,entry,{marketplaceName=LOCAL_MARKETPLACE_NAME}={}){
  const current=await readLocalMarketplace(home);
  const data=current??{name:marketplaceName,description:'由 D_sh-are_in_cc 轉換的 DSH（DeepSeek Harness）插件，只在這台電腦上',owner:{name:'D_sh-are_in_cc'},plugins:[]};
  data.plugins=data.plugins.filter(item=>item?.name!==entry.name);
  data.plugins.push(entry);
  data.plugins.sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  await writeJsonAtomic(marketplaceFile(home),data);
  return data;
}

/**
 * 轉換並登記到本機插件市場。不安裝進 Claude Code。
 * options：home（預設 ~/.dsh-to-claude）、replace（名稱相同但來源不同時仍覆蓋）、convert（測試用替身），其餘原樣交給 convertToClaude。
 * 結果 registered=false 時表示沒有登記（轉換結果為 unsupported 或 not-applicable），資料夾不留。
 */
export async function installLocal(input,{home,replace=false,convert=convertToClaude,marketplaceName=LOCAL_MARKETPLACE_NAME,rewriteFrom,...convertOptions}={}){
  home=path.resolve(home??dshHome());
  const pluginsDir=path.join(home,'plugins');
  await fs.mkdir(pluginsDir,{recursive:true});
  // 清掉前一次失敗留下的暫存資料夾（盡力而為）。
  for(const entry of await fs.readdir(pluginsDir,{withFileTypes:true}))if(entry.isDirectory()&&/^\.(?:old|new)-[0-9a-f]{8}$/.test(entry.name))await fs.rm(path.join(pluginsDir,entry.name),{recursive:true,force:true}).catch(()=>{});
  const staging=path.join(pluginsDir,'.new-'+hex());
  const cache=path.join(home,'cache');
  let report;
  try{report=await convert(input,{...convertOptions,outputDir:staging,cacheDir:convertOptions.cacheDir??cache,npmCacheDir:convertOptions.npmCacheDir??cache});}
  catch(error){await fs.rm(staging,{recursive:true,force:true});throw error;}
  const status=report?.conversion?.status;
  // --rewrite-from：把照原始碼補寫的部分搬進這次正式轉換的插件（純 DSH 介面插件則做一個只放補寫部分的插件）。
  let rewrite=null;
  if(rewriteFrom){
    try{rewrite=await applyRewrite(rewriteFrom,staging,{report,input});}
    catch(error){await fs.rm(staging,{recursive:true,force:true});throw error;}
  }
  const base={home:slash(home),marketplace:{name:marketplaceName,root:slash(home),file:slash(marketplaceFile(home))},conversion:{status,reason:report?.conversion?.reason??null},source:report?.source??null};
  if(!['converted','partial'].includes(status)&&!rewrite?.wired){
    await fs.rm(staging,{recursive:true,force:true});
    return {...base,registered:false,pluginName:report?.plugin?.name??null,message:status==='not-applicable'?'這個 DSH 插件不適合轉成 Claude Code 插件（純 DSH 介面），沒有登記。':'轉換沒有產生可用的插件，沒有登記。'};
  }
  const name=report.plugin.name;
  if(!PLUGIN_NAME.test(name)){await fs.rm(staging,{recursive:true,force:true});throw new Error(`轉換出的插件名稱不合法：${name}`);}
  const origin=report.source?.origin??null;
  const existing=(await readLocalMarketplace(home))?.plugins?.find(item=>item?.name===name);
  const previousOrigin=existing?.metadata?.dshSource?.origin;
  if(previousOrigin&&origin&&previousOrigin!==origin&&!replace){
    await fs.rm(staging,{recursive:true,force:true});
    throw Object.assign(new Error(`本機插件市場已有同名插件 ${name}，但來源不同（原本 ${previousOrigin}，這次 ${origin}）。確定要覆蓋請加 --replace。`),{code:'NAME_CONFLICT'});
  }
  const finalDir=path.join(pluginsDir,name);
  let backup=null;const warnings=[];
  if(await exists(finalDir)){
    backup=path.join(pluginsDir,'.old-'+hex());
    try{await fs.rename(finalDir,backup);}
    catch(error){await fs.rm(staging,{recursive:true,force:true});throw Object.assign(new Error(`無法替換舊的插件資料夾 ${slash(finalDir)}（${error.code??error.message}）。可能有 Claude Code 工作階段正在使用這個插件；請關閉使用它的工作階段後再試。`),{code:'PLUGIN_DIR_BUSY'});}
  }
  try{await fs.rename(staging,finalDir);}
  catch(error){if(backup)await fs.rename(backup,finalDir).catch(()=>{});await fs.rm(staging,{recursive:true,force:true});throw error;}
  if(backup)await fs.rm(backup,{recursive:true,force:true}).catch(error=>warnings.push(`舊版資料夾 ${slash(backup)} 沒有刪掉（${error.code??error.message}），下次安裝時會再清一次`));
  const manifest=await readJson(path.join(finalDir,'.claude-plugin','plugin.json'))??{};
  const entry={
    name,source:`./plugins/${name}`,
    description:String(manifest.description??report.description??'').slice(0,1000),
    category:'dsh',
    metadata:{...(rewrite?.wired?{rewrite:{conclusion:rewrite.result.conclusion,model:rewrite.result.by?.model??null,effort:rewrite.result.by?.effort??null,license:rewrite.license?.spdx??null}}:{}),dshSource:{origin,name:report.source?.name??null,version:report.source?.version??null,commit:report.source?.commit??null,packageDir:report.source?.packageDir??null},conversionStatus:status,convertedAt:new Date().toISOString(),converter:report.converter??null}
  };
  await upsertMarketplaceEntry(home,entry,{marketplaceName});
  const secretOptions=Object.entries(manifest.userConfig??{}).filter(([key,value])=>key.startsWith('secret_')&&value?.sensitive).map(([key,value])=>({option:key,title:value.title??key}));
  const quotedHome=`"${slash(home)}"`;
  return {
    ...base,registered:true,installed:false,...(rewrite?.wired?{rewrite:{conclusion:rewrite.result.conclusion,items:rewrite.result.items,copyleft:rewrite.license?.kind==='copyleft'}}:{}),replaced:Boolean(backup),pluginName:name,pluginDir:slash(finalDir),pluginVersion:manifest.version??null,
    security:report.security??null,secretOptions,warnings,
    next:{
      note:'轉換器只負責轉換與登記，沒有安裝進 Claude Code。下面的指令要由 Claude Code 執行（會經過它的權限確認）。',
      marketplaceAdd:`claude plugin marketplace add ${quotedHome}`,
      install:`claude plugin install ${name}@${marketplaceName}`,
      reload:'/reload-plugins',
      configure:`/plugin configure ${name}@${marketplaceName}`,
      reinstallNote:'已經安裝過同名插件時不必再裝：本機市場的插件直接從這個資料夾載入，執行 /reload-plugins 或重開 Claude Code 就會用新版。'
    }
  };
}
