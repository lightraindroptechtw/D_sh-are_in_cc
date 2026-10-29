// 照原始碼補寫：轉換器裝不進 Claude Code 的部分（DSH 前端畫面、不支援的 DSH 服務），由 Claude 子代理照原始碼
// 用 Claude Code 自己的功能補寫。這個檔案只做固定規則的部分，不呼叫模型：
// - rewriteCheck：授權允不允許、哪些部分裝不進來、補寫有沒有意義。
// - prepareRewrite：轉換一份預覽插件給子代理寫，記下寫之前的檔案，產生交給子代理的任務檔。
// - finishRewrite：檢查子代理只寫在允許的位置、補寫結果格式正確，接上進入點、寫授權注意。
// - applyRewrite：安裝時把補寫的檔案搬進正式轉換的插件（install-local --rewrite-from）。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {acquireSource,copySource,filesIn} from './source.mjs';
import {inspectSource} from './inspect.mjs';
import {convertToClaude,buildServiceMapping,isPureNativeUi} from './converter-claude.mjs';
import {claudePluginName,claudePluginVersion} from './claude-package.mjs';
import {dshHome,cacheFolderName} from './npm-source.mjs';

const slash=file=>String(file).split(path.sep).join('/');
const exists=async file=>{try{await fs.access(file);return true;}catch{return false;}};
const readJson=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch{return null;}};
const writeJson=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n','utf8');

// 檔名用中文：給使用者自己打開看的文件。
export const RESULT_FILE='補寫結果.json';
export const NOTICE_FILE='授權注意.md';
export const TASK_FILE='補寫任務.json';
const BEFORE_FILE='寫之前的檔案.json';
// 子代理只能寫這些位置（相對於插件資料夾）。
export const WRITABLE=['hooks/rewrite/','types/','assets/rewrite/',RESULT_FILE];
export const CONCLUSIONS=['done','partial','claude-code-cannot'];
export const MODELS=['haiku','sonnet','opus','fable'];
export const EFFORTS=['low','medium','high','xhigh','max'];

// ---------- 授權 ----------
// permissive：可以改寫，保留原作者與授權；copyleft：可以改寫，但只能自己用，公開必須照原授權；none：沒寫或專有，不補寫。
const PERMISSIVE=new Set(['MIT','MIT-0','ISC','BSD-2-CLAUSE','BSD-3-CLAUSE','0BSD','APACHE-2.0','UNLICENSE','CC0-1.0','ZLIB','BLUEOAK-1.0.0','WTFPL','PYTHON-2.0','BSL-1.0','X11','CC-BY-4.0','CC-BY-3.0']);
const COPYLEFT=/^(?:A?GPL|LGPL|MPL|EPL|EUPL|CDDL|OSL|CPAL|SSPL|CC-BY-SA|CC-BY-NC)/i;
// 沒有 package.json 的 license 欄位時，從授權檔的開頭認。
const LICENSE_TEXTS=[
  [/GNU AFFERO GENERAL PUBLIC LICENSE/i,'AGPL-3.0'],[/GNU LESSER GENERAL PUBLIC LICENSE/i,'LGPL-3.0'],[/GNU GENERAL PUBLIC LICENSE/i,'GPL-3.0'],
  [/Mozilla Public License/i,'MPL-2.0'],[/Apache License[\s\S]{0,40}Version 2\.0/i,'Apache-2.0'],
  [/Permission is hereby granted, free of charge/i,'MIT'],[/Permission to use, copy, modify, and\/or distribute this software for any purpose/i,'ISC'],
  [/Redistribution and use in source and binary forms/i,'BSD-3-Clause'],[/This is free and unencumbered software released into the public domain/i,'Unlicense'],
];

/** 一個 SPDX 寫法 → permissive／copyleft／none。`A OR B` 有一個寬鬆就算寬鬆；`A AND B` 有一個傳染性就算傳染性。 */
export function licenseKind(spdx){
  const text=String(spdx??'').trim();
  if(!text||/^(?:UNLICENSED|NONE|PROPRIETARY|SEE LICENSE)/i.test(text))return 'none';
  const ids=expression=>expression.replace(/[()]/g,' ').split(/\s+(?:AND|WITH)\s+/i).map(item=>item.trim().replace(/\+$/,'').replace(/-(?:only|or-later)$/i,'')).filter(Boolean);
  const kinds=text.split(/\s+OR\s+/i).map(choice=>{
    const parts=ids(choice);
    if(parts.some(id=>COPYLEFT.test(id)))return 'copyleft';
    if(parts.length&&parts.every(id=>PERMISSIVE.has(id.toUpperCase())))return 'permissive';
    return 'none';
  });
  if(kinds.includes('permissive'))return 'permissive';
  if(kinds.includes('copyleft'))return 'copyleft';
  return 'none';
}

/** 讀插件的授權：package.json 的 license 欄位，沒有就認授權檔的內容。files 是授權檔（相對於插件資料夾）。 */
export async function readLicense(packageRoot,pkg={}){
  const names=(await fs.readdir(packageRoot).catch(()=>[])).filter(name=>/^(?:LICEN[CS]E|COPYING|NOTICE)(?:[.-].*)?$/i.test(name)).sort();
  let spdx=typeof pkg.license==='string'?pkg.license:typeof pkg.license?.type==='string'?pkg.license.type:null;
  let from=spdx?'package.json':null;
  if(!spdx||/^SEE LICENSE/i.test(spdx)){
    for(const name of names){
      const head=(await fs.readFile(path.join(packageRoot,name),'utf8').catch(()=>'')).slice(0,4000);
      // 標題是沒見過的授權（例如以 MIT 為底、另加條件的自訂授權）：不猜，交給使用者自己看。
      const title=head.split(/\r?\n/).map(line=>line.trim()).find(Boolean)??'';
      if(/licen[cs]e/i.test(title)&&!/^(?:the\s+)?(?:MIT|Apache|GNU|Mozilla|BSD|ISC|Unlicense|Copyright)/i.test(title)&&!/^MIT License$/i.test(title))return {spdx:title.slice(0,80),kind:'custom',from:name,files:names};
      const found=LICENSE_TEXTS.find(([pattern])=>pattern.test(head));
      if(found){spdx=found[1];from=name;break;}
    }
  }
  return {spdx:spdx??null,kind:licenseKind(spdx),from,files:names};
}

// ---------- 哪些部分裝不進來 ----------
// 轉換器的服務對應表裡，跟畫面有關、只算「部分」的服務：沒有可打包的原畫面時，登記會成功，但 Claude Code 這邊看不到。
// 有原畫面時，這兩項由原插件畫面（/<插件名稱>-ui）接上，不算裝不進來。
const UI_SERVICES={webServer:'插件自己的網頁路由（只綁在子程序內，Claude Code 看不到）',connection:'跟 DSH 前端的連線（面板、卡片不會出現）'};

/**
 * 從靜態分析結果找出轉換器裝不進來的部分。每項：feature（給人看的名稱）、why（為什麼轉換器裝不進來）、hint（原始碼從哪裡看起）。
 * 不判斷 Claude Code 能不能實作：那是子代理照原始碼判斷的事。
 */
export function rewriteTargets(plan,pkg={}){
  const targets=[];
  const client=pkg.dsh?.client;
  // 找得到原畫面程式（lib/ui-assets.mjs 的 discoverPluginUi）時，轉換器會把它打包成獨立網頁。
  const frontend=Boolean(plan.host?.frontend);
  const uiHint='package.json 的 dsh.client 指到的畫面程式裡，登記畫面位置（slots）與取用服務（ctx.get、inject）的地方';
  const leftover={feature:'原插件畫面裡獨立網頁放不下的部分（例如 DSH 聊天裡的面板、卡片、輸入框旁的按鈕）',why:'原畫面會打包成獨立網頁，用 /<插件名稱>-ui 在內建瀏覽器開啟，已經能顯示的部分不用補寫；只有放在 DSH 聊天裡的位置，以及還沒提供的畫面位置或服務，才需要另外補寫。',hint:uiHint};
  if(isPureNativeUi(plan))targets.push(frontend?leftover:{feature:'整個插件（只有 DSH 前端畫面）',why:'這個插件只有 DSH 的畫面，沒有工具、技能或命令，而且找不到能打包的畫面程式，轉換器不產生插件。',hint:client?'package.json 的 dsh.client 與 main 指到的程式':'package.json 的 main'});
  else if(frontend)targets.push(leftover);
  else if(plan.host?.client||client)targets.push({feature:'DSH 前端畫面（面板、側欄、卡片、按鈕）',why:'來源宣告了 DSH 畫面，但找不到能打包的畫面程式，轉換器不轉這部分；工具、命令等其他部分已經轉好。',hint:'package.json 的 dsh.client，以及程式裡跟前端連線（connection、webServer、client）的地方'});
  for(const row of buildServiceMapping(plan).rows){
    if(!row.dshService)continue;
    if(row.level==='不支援')targets.push({feature:`DSH 服務 ${row.dshService}`,why:row.note,hint:`程式裡用到 ${row.dshService} 的地方`});
    else if(UI_SERVICES[row.dshService]&&!frontend&&!targets.some(item=>item.feature.startsWith('整個插件')))targets.push({feature:`DSH 服務 ${row.dshService}：${UI_SERVICES[row.dshService]}`,why:row.note,hint:`程式裡用到 ${row.dshService} 的地方`});
  }
  return targets;
}

const isModelProvider=plan=>(plan.host?.behaviors??[]).some(item=>item.kind==='llm-provider');

/**
 * 能不能補寫。allowed：授權允許；meaningful：有裝不進來的部分、而且不是模型服務商插件。
 * reasonCode：NO_LICENSE／MODEL_PROVIDER／NOTHING_MISSING／OK。
 */
export function rewriteDecision({license,plan,targets}){
  if(license.kind==='custom')return {allowed:false,meaningful:false,reasonCode:'CUSTOM_LICENSE',reason:`授權是作者自訂的「${license.spdx}」（${license.from}），無法用固定規則判斷允不允許改寫，所以不補寫。`};
  if(license.kind==='none')return {allowed:false,meaningful:false,reasonCode:'NO_LICENSE',reason:license.spdx?`授權是「${license.spdx}」，不是開放授權，不能照原始碼改寫。`:'這個插件沒有寫授權，預設是作者保留所有權利，不能照原始碼改寫。'};
  if(isModelProvider(plan))return {allowed:true,meaningful:false,reasonCode:'MODEL_PROVIDER',reason:'這是模型服務商插件：主要功能是把 DSH 的模型換成別家服務。Claude Code 無法實作「換掉自己的模型」，補寫沒有意義。'};
  if(!targets.length)return {allowed:true,meaningful:false,reasonCode:'NOTHING_MISSING',reason:'轉換器已經把這個插件的功能都轉好了，沒有需要補寫的部分。'};
  return {allowed:true,meaningful:true,reasonCode:'OK',reason:license.kind==='copyleft'?`授權是 ${license.spdx}（傳染性授權）：可以補寫，但補寫的代碼只能自己用；如果公開，必須按照原授權。`:`授權是 ${license.spdx}：可以補寫，會保留原作者與授權。`};
}

const sourceOptions=({home,cacheDir,ref})=>({cacheDir:cacheDir??path.join(home,'tmp-sources'),ref,npmCacheDir:cacheDir??path.join(home,'cache')});

async function examine(input,{home=dshHome(),packageDir='.',entry,ref,cacheDir}={}){
  const src=await acquireSource(input,sourceOptions({home,cacheDir,ref}));
  const packageRoot=path.join(src.root,packageDir);
  const pkg=await readJson(path.join(packageRoot,'package.json'))??{};
  const plan=await inspectSource(src,{sourceEntry:entry,packageDir});
  const license=await readLicense(packageRoot,pkg);
  const targets=rewriteTargets(plan,pkg);
  return {src,packageRoot,pkg,plan,license,targets,decision:rewriteDecision({license,plan,targets})};
}

const authorOf=pkg=>typeof pkg.author==='string'?pkg.author.replace(/\s*[<(].*$/,'').trim():pkg.author?.name??null;

/** rewrite-check：只讀原始碼做固定規則判斷，不轉換、不呼叫模型。 */
export async function rewriteCheck(input,options={}){
  const {src,pkg,plan,license,targets,decision}=await examine(input,options);
  return {
    name:plan.name,version:plan.version,author:authorOf(pkg),root:slash(src.root),packageDir:plan.packageDir,
    pinnedSource:src.npm?`npm:${src.npm.name}@${src.npm.version}`:src.remote&&src.commit?`${src.origin}/tree/${src.commit}`:input,
    license,...decision,targets,
    // 有沒有轉換的部分（會執行原插件的程式）：有的話，補寫前要先照安裝技能做安全審查。
    // 打包的原畫面也是原插件的程式（在內建瀏覽器裡執行），所以也算。
    convertedPart:(Boolean(plan.convertible)&&!isPureNativeUi(plan))||Boolean(plan.host?.frontend),
    note:'固定規則判斷，沒有呼叫模型。Claude Code 能不能實作，由補寫的子代理照原始碼判斷。',
  };
}

async function sha(file){return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');}
async function snapshot(dir){
  const result={};
  for(const file of await filesIn(dir,{limit:50000}))result[slash(path.relative(dir,file))]=await sha(file);
  return result;
}
const writable=rel=>WRITABLE.some(prefix=>prefix.endsWith('/')?rel.startsWith(prefix):rel===prefix);

/** 純 DSH 介面插件沒有轉換出插件：做一個只放補寫部分的空殼（plugin.json、hooks.json、原始碼副本）。 */
async function scaffold(dir,{plan,pkg,sourceRoot}){
  await fs.mkdir(path.join(dir,'.claude-plugin'),{recursive:true});
  await fs.mkdir(path.join(dir,'hooks'),{recursive:true});
  await writeJson(path.join(dir,'.claude-plugin','plugin.json'),{name:claudePluginName(plan.name),version:claudePluginVersion(plan.version),description:String(pkg.description??plan.description??plan.name).slice(0,500)});
  await writeJson(path.join(dir,'hooks','hooks.json'),{modules:['./main.ts']});
  await copySource(sourceRoot,path.join(dir,'source'));
}

/**
 * rewrite-prepare：在 <home>/rewrites/<名稱>-<版本>/plugin 轉換一份預覽插件（不裝來源依賴，只給子代理寫和檢查用），
 * 記下寫之前的檔案，寫出任務檔。真正安裝時 install-local 會從固定版本的來源重新轉換，再搬進補寫的檔案。
 */
export async function prepareRewrite(input,{home=dshHome(),packageDir='.',entry,ref,cacheDir,convert=convertToClaude}={}){
  home=path.resolve(home);
  const {src,packageRoot,pkg,plan,license,targets,decision}=await examine(input,{home,packageDir,entry,ref,cacheDir});
  if(!decision.allowed||!decision.meaningful)throw Object.assign(new Error(decision.reason),{code:`REWRITE_${decision.reasonCode}`});
  const workDir=path.join(home,'rewrites',cacheFolderName(claudePluginName(plan.name),String(plan.version??'unknown')));
  const pluginDir=path.join(workDir,'plugin');
  await fs.rm(workDir,{recursive:true,force:true});
  await fs.mkdir(workDir,{recursive:true});
  const report=await convert(input,{outputDir:pluginDir,packageDir,sourceEntry:entry,ref,installDependencies:false,cacheDir:sourceOptions({home,cacheDir}).cacheDir,npmCacheDir:sourceOptions({home,cacheDir}).npmCacheDir});
  const status=report?.conversion?.status;
  const convertedPart=['converted','partial'].includes(status);
  if(!convertedPart)await scaffold(pluginDir,{plan,pkg,sourceRoot:packageRoot});
  const pluginName=JSON.parse(await fs.readFile(path.join(pluginDir,'.claude-plugin','plugin.json'),'utf8')).name;
  // 轉換好的工具：補寫的畫面可以用 $.tool.call 叫它們拿資料。
  // 名稱照轉換報告的 staticTools（跟執行時子程序回報的同一套規則）；實際清單以子程序啟動後回報為準。
  const descriptions=new Map((plan.capabilities?.toolRuntime?.tools??[]).map(tool=>[tool.name,String(tool.description??'').slice(0,300)]));
  const tools=convertedPart?(report.plugin?.bridgeConfig?.staticTools??[]).map(tool=>({name:`mcp__${pluginName}__${tool.name}`,original:tool.dshName,description:descriptions.get(tool.dshName)??''})):[];
  await writeJson(path.join(workDir,BEFORE_FILE),await snapshot(pluginDir));
  const task={
    plugin:{name:pluginName,original:plan.name,version:plan.version,author:authorOf(pkg)},
    source:{root:slash(packageRoot),copy:slash(path.join(pluginDir,'source')),pinnedSource:src.npm?`npm:${src.npm.name}@${src.npm.version}`:src.remote&&src.commit?`${src.origin}/tree/${src.commit}`:input,packageDir:plan.packageDir},
    license,conversionStatus:status,convertedPart,targets,tools,
    pluginDir:slash(pluginDir),writable:WRITABLE.map(item=>slash(path.join(pluginDir,item)).replace(/\/$/,'')+(item.endsWith('/')?'/':'')),
    entryModule:'hooks/rewrite/register.tsx（或 .ts）',
    resultFile:slash(path.join(pluginDir,RESULT_FILE)),
  };
  await writeJson(path.join(workDir,TASK_FILE),task);
  return {workDir:slash(workDir),taskFile:slash(path.join(workDir,TASK_FILE)),pluginDir:slash(pluginDir),pluginName,conversionStatus:status,convertedPart,license,targets,tools};
}

// ---------- 補寫結果 ----------
/** 檢查子代理寫的補寫結果：結論與逐項一致，Claude Code 無法實作的每項都寫了原因。回傳錯誤清單（空的就是對）。 */
export function checkResult(result){
  const errors=[];
  if(!result||typeof result!=='object')return [`${RESULT_FILE} 不是 JSON 物件`];
  if(!CONCLUSIONS.includes(result.conclusion))errors.push(`conclusion 必須是 ${CONCLUSIONS.join('／')}`);
  if(typeof result.summary!=='string'||!result.summary.trim())errors.push('summary 要用一兩句白話說明結果');
  const items=Array.isArray(result.items)?result.items:[];
  if(!items.length)errors.push('items 要逐項列出每個要補的部分');
  items.forEach((item,index)=>{
    const where=`items[${index}]`;
    if(typeof item?.feature!=='string'||!item.feature.trim())errors.push(`${where}.feature 要寫原插件的功能名稱`);
    if(item?.status==='done'){if(typeof item.how!=='string'||!item.how.trim())errors.push(`${where}.how 要寫在 Claude Code 裡怎麼做到`);}
    else if(item?.status==='claude-code-cannot'){if(typeof item.why!=='string'||!item.why.trim())errors.push(`${where}.why 要寫 Claude Code 無法實作的原因`);}
    else errors.push(`${where}.status 必須是 done 或 claude-code-cannot`);
  });
  if(items.length&&CONCLUSIONS.includes(result.conclusion)){
    const done=items.filter(item=>item?.status==='done').length;
    const expected=done===items.length?'done':done===0?'claude-code-cannot':'partial';
    if(result.conclusion!==expected)errors.push(`逐項有 ${done}／${items.length} 項做到，conclusion 應該是 ${expected}`);
  }
  return errors;
}

// 補寫的程式用到哪些 Claude Code 能力：給使用者在安裝前看，固定規則比對，不是 AI 判斷。
const ABILITIES=[
  [/\$\.http\.fetch\b/,'連網路（$.http.fetch）'],[/\$\.process\./,'開程式（$.process）'],[/\$\.fs\.(?:write|remove|rm|mkdir|rename|append)/,'寫檔案（$.fs）'],[/\$\.fs\./,'讀檔案（$.fs）'],
  [/\$\.model\./,'呼叫模型，會用到你的用量（$.model）'],[/\$\.agent\./,'開子代理，會用到你的用量（$.agent）'],[/\$\.tool\.call\b/,'呼叫工具（$.tool.call，會經過 Claude Code 的權限確認）'],
  [/\$\.prompt\.submit\b/,'自己送出訊息（$.prompt.submit）'],[/\$\.command\.run\b/,'執行斜線指令（$.command.run）'],[/on\(\s*['"]tool\.call['"]/,'攔截 Claude 的工具使用（tool.call hook）'],
  [/on\(\s*['"]prompt\.(?:submit|compose)['"]/,'改寫你的訊息或系統提示（prompt hook）'],[/\$\.store\./,'跨工作階段存資料（$.store）'],
];
export async function scanAbilities(dir){
  const found=new Set(),domains=new Set();
  for(const file of await filesIn(dir).catch(()=>[])){
    if(!/\.(?:[cm]?[jt]sx?)$/.test(file))continue;
    const text=await fs.readFile(file,'utf8');
    for(const [pattern,label] of ABILITIES)if(pattern.test(text))found.add(label);
    for(const match of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi))domains.add(match[1].toLowerCase());
  }
  if(found.has('寫檔案（$.fs）'))found.delete('讀檔案（$.fs）');
  return {abilities:[...found],domains:[...domains].sort()};
}

const entryModule=async pluginDir=>{for(const name of ['register.tsx','register.ts'])if(await exists(path.join(pluginDir,'hooks','rewrite',name)))return name;return null;};

// 轉換的部分（hooks/register.ts）已經登記、沒有條件的事件。同一個插件不能重複登記，補寫的部分改成匯出 on<事件> 函式，
// 由 hooks/rewrite-shared.ts 接到轉換的部分（它呼叫 next 的地方）；純 DSH 介面插件沒有轉換的部分，由 hooks/main.ts 直接登記。
export const SHARED_HOOKS=[['session.start','SessionStart'],['session.end','SessionEnd'],['tool.call','ToolCall'],['prompt.submit','PromptSubmit'],['prompt.compose','PromptCompose'],['command.run','CommandRun'],['turn.complete','TurnComplete']];
const exportsFunction=(text,name)=>new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b|export\\s+const\\s+${name}\\s*[:=]`).test(text);

function sharedModule(rewrite,present){
  const lines=[
    '// 補寫的部分在共用事件上的 hook（D_sh-are_in_cc 產生，不要手改）：轉換的部分（register.ts 的 handOver）呼叫 next 的地方接到這裡。',
    '// 補寫的 hook 出錯時不擋住整個流程，直接交給 next。',
  ];
  if(present.length)lines.push(`import { ${present.map(name=>`on${name}`).join(', ')} } from './rewrite/${rewrite}'`);
  for(const [,name] of SHARED_HOOKS){
    lines.push('');
    if(present.includes(name))lines.push(`export async function rewrite${name}($: any, e: any, next: any) {`,'  try {',`    return await on${name}($, e, next)`,'  } catch {','    return next(e)','  }','}');
    else lines.push(`export function rewrite${name}($: unknown, e: unknown, next: (e: never) => unknown) {`,'  return next(e as never)','}');
  }
  return lines.join('\n')+'\n';
}

function mainModule({converted,rewrite,present}){
  if(converted)return [
    '// 進入點（D_sh-are_in_cc 產生，不要手改）：轉換的部分（register.ts）加上照原始碼補寫的部分（rewrite/）。',
    '// 補寫的部分在共用事件上的 hook 由 rewrite-shared.ts 接到轉換的部分；其他事件由補寫的部分自己登記。',
    "import type { Register } from 'claude-code'",
    "import { register as converted } from './register.ts'",
    `import { register as rewritten } from './rewrite/${rewrite}'`,
    '',
    'export const register: Register = (on, options) => {',
    '  converted(on, options)',
    '  rewritten(on, options)',
    '}',
    '',
  ].join('\n');
  return [
    '// 進入點（D_sh-are_in_cc 產生，不要手改）：原插件只有 DSH 畫面，這個插件只有照原始碼補寫的部分（rewrite/）。',
    "import type { Register } from 'claude-code'",
    `import { ${['register as rewritten',...present.map(name=>`on${name}`)].join(', ')} } from './rewrite/${rewrite}'`,
    '',
    'export const register: Register = (on, options) => {',
    '  rewritten(on, options)',
    ...SHARED_HOOKS.filter(([,name])=>present.includes(name)).map(([event,name])=>`  on('${event}', on${name})`),
    '}',
    '',
  ].join('\n');
}

function noticeText({name,version,license}){
  const files=license.files?.length?license.files.map(file=>`source/${file}`).join('、'):'原插件的授權檔';
  return [
    '# 授權注意',
    '',
    `這個插件的「Claude 補寫版」程式（hooks/rewrite/）是照 ${name} ${version} 的原始碼改寫的。原插件的授權是 **${license.spdx}**，屬於傳染性授權：`,
    '',
    '- **這份代碼只能自己用。**',
    `- **如果公開**（上傳到 GitHub、分享給別人、發佈成插件），**必須按照原授權 ${license.spdx}**：一起公開原始碼、沿用同一個授權、保留原作者的版權聲明。`,
    '',
    `原授權全文：${files}。`,
    '',
  ].join('\n');
}

/**
 * 補寫完成後的固定步驟（rewrite-finish 與 install-local --rewrite-from 共用）：
 * 讀補寫結果並檢查格式；有做到的部分就接上進入點 hooks/main.ts、補 plugin.json（Claude 補寫版、型別檔）、
 * 傳染性授權寫授權注意。conclusion 是 claude-code-cannot 時不接任何程式。
 */
export async function wireRewrite(pluginDir,{license,original,model,effort}={}){
  const result=await readJson(path.join(pluginDir,RESULT_FILE));
  const errors=checkResult(result);
  if(errors.length)throw Object.assign(new Error(`${RESULT_FILE} 格式不對：${errors.join('；')}`),{code:'REWRITE_RESULT_INVALID',errors});
  const manifestFile=path.join(pluginDir,'.claude-plugin','plugin.json');
  const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
  const rewrite=await entryModule(pluginDir);
  if(result.conclusion==='claude-code-cannot')return {result,wired:false,manifest,license};
  if(!rewrite)throw Object.assign(new Error(`補寫結果說有做到的部分，但找不到 hooks/rewrite/register.tsx 或 register.ts`),{code:'REWRITE_ENTRY_MISSING'});
  const entryText=await fs.readFile(path.join(pluginDir,'hooks','rewrite',rewrite),'utf8');
  if(!exportsFunction(entryText,'register'))throw Object.assign(new Error(`hooks/rewrite/${rewrite} 沒有 export const register`),{code:'REWRITE_ENTRY_MISSING'});
  const present=SHARED_HOOKS.map(([,name])=>name).filter(name=>exportsFunction(entryText,`on${name}`));
  const converted=await exists(path.join(pluginDir,'hooks','register.ts'));
  if(converted)await fs.writeFile(path.join(pluginDir,'hooks','rewrite-shared.ts'),sharedModule(rewrite,present),'utf8');
  await fs.writeFile(path.join(pluginDir,'hooks','main.ts'),mainModule({converted,rewrite,present}),'utf8');
  await writeJson(path.join(pluginDir,'hooks','hooks.json'),{modules:['./main.ts']});
  const label=`Claude 補寫版（原作者 ${original?.author??'未註明'}，${license?.spdx??'授權未知'}）`;
  const description=String(manifest.description??'').replace(/^Claude 補寫版（[^）]*）[:：]\s*/,'');
  const next={...manifest,description:`${label}：${description}`.slice(0,1000)};
  if(!next.author&&original?.author)next.author={name:original.author};
  if(await exists(path.join(pluginDir,'types','index.d.ts')))next.types='./types/index.d.ts';
  await writeJson(manifestFile,next);
  if(license?.kind==='copyleft')await fs.writeFile(path.join(pluginDir,NOTICE_FILE),noticeText({name:original?.name??manifest.name,version:original?.version??manifest.version,license}),'utf8');
  if(model||effort)await writeJson(path.join(pluginDir,RESULT_FILE),{...result,by:{model:model??null,effort:effort??null,wiredAt:new Date().toISOString()}});
  return {result,wired:true,manifest:next,license};
}

/** rewrite-finish：子代理寫完後執行。先確認只寫在允許的位置，再接上進入點。 */
export async function finishRewrite(workDir,{model,effort}={}){
  workDir=path.resolve(workDir);
  const task=await readJson(path.join(workDir,TASK_FILE));
  const before=await readJson(path.join(workDir,BEFORE_FILE));
  if(!task||!before)throw Object.assign(new Error(`${slash(workDir)} 不是 rewrite-prepare 準備的資料夾`),{code:'REWRITE_NOT_PREPARED'});
  if(model!==undefined&&!MODELS.includes(model))throw new Error(`模型只能是 ${MODELS.join('、')}`);
  if(effort!==undefined&&!EFFORTS.includes(effort))throw new Error(`思考強度只能是 ${EFFORTS.join('、')}`);
  const pluginDir=path.join(workDir,'plugin');
  const after=await snapshot(pluginDir);
  const outside=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(rel=>before[rel]!==after[rel]&&!writable(rel)&&rel!=='hooks/main.ts'&&rel!=='hooks/rewrite-shared.ts').sort();
  if(outside.length)throw Object.assign(new Error(`補寫的子代理改到不允許的位置：${outside.slice(0,10).join('、')}${outside.length>10?` 等 ${outside.length} 個`:''}`),{code:'REWRITE_OUTSIDE',files:outside});
  const wired=await wireRewrite(pluginDir,{license:task.license,original:{name:task.plugin.original,version:task.plugin.version,author:task.plugin.author},model,effort});
  const written=Object.keys(after).filter(rel=>before[rel]!==after[rel]).sort();
  // 這一步自己改的檔案記進「寫之前」，再跑一次（例如子代理修正後）不會被當成子代理改的。
  for(const rel of ['.claude-plugin/plugin.json','hooks/hooks.json','hooks/main.ts','hooks/rewrite-shared.ts',NOTICE_FILE])if(await exists(path.join(pluginDir,rel)))before[rel]=await sha(path.join(pluginDir,rel));
  await writeJson(path.join(workDir,BEFORE_FILE),before);
  const scanned=wired.wired?await scanAbilities(path.join(pluginDir,'hooks','rewrite')):{abilities:[],domains:[]};
  return {
    workDir:slash(workDir),pluginDir:slash(pluginDir),pluginName:task.plugin.name,conclusion:wired.result.conclusion,summary:wired.result.summary,items:wired.result.items,
    wired:wired.wired,written,...scanned,license:task.license,copyleft:task.license.kind==='copyleft',noticeFile:task.license.kind==='copyleft'&&wired.wired?slash(path.join(pluginDir,NOTICE_FILE)):null,
    pinnedSource:task.source.pinnedSource,packageDir:task.source.packageDir,
  };
}

/** install-local --rewrite-from：把預覽插件裡補寫的檔案搬進正式轉換的插件，再接上進入點。 */
export async function applyRewrite(workDir,stagingDir,{report,input,sourceRoot}={}){
  workDir=path.resolve(workDir);
  const task=await readJson(path.join(workDir,TASK_FILE));
  if(!task)throw Object.assign(new Error(`${slash(workDir)} 不是 rewrite-prepare 準備的資料夾`),{code:'REWRITE_NOT_PREPARED'});
  // 補寫是照哪個版本寫的，就只能裝那個版本。
  if(input!==undefined&&input!==task.source.pinnedSource)throw Object.assign(new Error(`補寫是照 ${task.source.pinnedSource} 寫的，這次要安裝的來源是 ${input}，版本不同，不能搬過去。`),{code:'REWRITE_SOURCE_MISMATCH'});
  const fromDir=path.join(workDir,'plugin');
  const result=await readJson(path.join(fromDir,RESULT_FILE));
  if(result?.conclusion==='claude-code-cannot')throw Object.assign(new Error('補寫結果是「Claude Code 無法實作」，沒有可以安裝的補寫部分。'),{code:'REWRITE_NOTHING'});
  const status=report?.conversion?.status;
  if(!['converted','partial'].includes(status)){
    const plan={name:task.plugin.original,version:task.plugin.version,description:report?.description};
    await scaffold(stagingDir,{plan,pkg:{description:report?.description},sourceRoot:sourceRoot??path.join(fromDir,'source')});
  }
  for(const item of WRITABLE){
    const from=path.join(fromDir,item);
    if(await exists(from))await fs.cp(from,path.join(stagingDir,item),{recursive:true});
  }
  return wireRewrite(stagingDir,{license:task.license,original:{name:task.plugin.original,version:task.plugin.version,author:task.plugin.author},model:result?.by?.model,effort:result?.by?.effort});
}
