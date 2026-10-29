// 照原始碼補寫（lib/rewrite.mjs）的固定規則部分：授權、要補的部分、補寫結果格式、只寫在允許的位置、接上進入點、安裝時搬過去。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {licenseKind,readLicense,rewriteDecision,checkResult,rewriteCheck,prepareRewrite,finishRewrite,applyRewrite,RESULT_FILE,NOTICE_FILE,TASK_FILE} from '../lib/rewrite.mjs';

const temp=prefix=>fs.mkdtemp(path.join(os.tmpdir(),prefix));
const write=async(file,text)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,typeof text==='string'?text:JSON.stringify(text,null,2));};
const readJson=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const exists=async file=>{try{await fs.access(file);return true;}catch{return false;}};

test('licenseKind: permissive, copyleft, none; OR takes the permissive choice, AND the copyleft one',()=>{
  for(const id of ['MIT','Apache-2.0','ISC','BSD-3-Clause','(MIT AND Apache-2.0)','0BSD'])assert.equal(licenseKind(id),'permissive',id);
  for(const id of ['GPL-3.0-only','AGPL-3.0-or-later','LGPL-3.0','MPL-2.0','MIT AND GPL-2.0+'])assert.equal(licenseKind(id),'copyleft',id);
  for(const id of [undefined,'','UNLICENSED','SEE LICENSE IN LICENSE','Proprietary','My-Own-License'])assert.equal(licenseKind(id),'none',String(id));
  assert.equal(licenseKind('(GPL-3.0 OR MIT)'),'permissive');
});

test('readLicense: package.json first; otherwise the license file; a license of its own is custom, not guessed',async()=>{
  const dir=await temp('dsh-license-');
  assert.deepEqual(await readLicense(dir,{license:'MIT'}),{spdx:'MIT',kind:'permissive',from:'package.json',files:[]});
  await write(path.join(dir,'LICENSE'),'MIT License\n\nPermission is hereby granted, free of charge, to any person');
  assert.equal((await readLicense(dir,{})).spdx,'MIT');
  await write(path.join(dir,'LICENSE'),'GNU GENERAL PUBLIC LICENSE\nVersion 3');
  assert.equal((await readLicense(dir,{})).kind,'copyleft');
  await write(path.join(dir,'LICENSE'),'The Star And Thank Author License (SATA)\n\nPermission is hereby granted, free of charge');
  const custom=await readLicense(dir,{license:'SEE LICENSE IN LICENSE'});
  assert.equal(custom.kind,'custom');
  assert.match(custom.spdx,/SATA/);
  await fs.rm(dir,{recursive:true,force:true});
});

test('rewriteDecision: no license, a license of its own, a model provider, nothing missing, allowed',()=>{
  const plan={host:{behaviors:[]}};
  const targets=[{feature:'DSH 前端畫面'}];
  assert.equal(rewriteDecision({license:{kind:'none',spdx:null},plan,targets}).reasonCode,'NO_LICENSE');
  assert.equal(rewriteDecision({license:{kind:'custom',spdx:'X',from:'LICENSE'},plan,targets}).reasonCode,'CUSTOM_LICENSE');
  assert.equal(rewriteDecision({license:{kind:'permissive',spdx:'MIT'},plan:{host:{behaviors:[{kind:'llm-provider'}]}},targets}).reasonCode,'MODEL_PROVIDER');
  assert.equal(rewriteDecision({license:{kind:'permissive',spdx:'MIT'},plan,targets:[]}).reasonCode,'NOTHING_MISSING');
  const copyleft=rewriteDecision({license:{kind:'copyleft',spdx:'GPL-3.0'},plan,targets});
  assert.equal(copyleft.allowed&&copyleft.meaningful,true);
  assert.match(copyleft.reason,/只能自己用/);
});

test('checkResult: every item has a status and its reason; the conclusion follows the items',()=>{
  const ok={conclusion:'partial',summary:'做了一半',items:[{feature:'面板',status:'done',how:'$.ui.open'},{feature:'拖拽',status:'claude-code-cannot',why:'沒有浮動視窗'}]};
  assert.deepEqual(checkResult(ok),[]);
  assert.deepEqual(checkResult({conclusion:'claude-code-cannot',summary:'都不行',items:[{feature:'餘額',status:'claude-code-cannot',why:'沒有服務商 API'}]}),[]);
  assert.ok(checkResult({...ok,conclusion:'done'}).some(item=>/應該是 partial/.test(item)));
  assert.ok(checkResult({...ok,items:[{feature:'拖拽',status:'claude-code-cannot'}]}).some(item=>/why/.test(item)));
  assert.ok(checkResult({...ok,items:[{feature:'x',status:'maybe'}]}).some(item=>/status/.test(item)));
  assert.ok(checkResult({conclusion:'寫不出來',summary:'x',items:[]}).length>=2);
});

/** 一個只有 DSH 前端的小插件（純介面），授權由參數決定。 */
async function uiOnlySource(license='MIT'){
  const dir=await temp('dsh-rewrite-src-');
  await write(path.join(dir,'package.json'),{name:'dsh-tiny-ui',version:'1.2.3',description:'tiny ui',author:'Someone <a@b.c>',license,main:'lib/index.js',dsh:{client:{platform:'web'}}});
  await write(path.join(dir,'lib','index.js'),'export const name = "dsh-tiny-ui"\nexport function apply() {}\n');
  await write(path.join(dir,'LICENSE'),license==='MIT'?'MIT License\n\nPermission is hereby granted, free of charge':'GNU GENERAL PUBLIC LICENSE\nVersion 3');
  return dir;
}
// 轉換器換成假的：純介面插件轉不出插件，只留報告。
const fakeConvert=async(input,{outputDir})=>{await write(path.join(outputDir,'conversion-report.json'),{conversion:{status:'not-applicable'}});return {conversion:{status:'not-applicable'},plugin:{name:'dsh-tiny-ui',version:'1.2.3'},description:'tiny ui'};};

const REWRITE=`import type { Register } from 'claude-code'

export async function onSessionStart($: any, e: any, next: any) {
  await $.command.register({ name: 'tiny', description: 'tiny' })
  return next(e)
}

export const register: Register = on => {
  on('command.run', { command: 'tiny' }, async () => ({ text: 'tiny' }))
}
`;
const RESULT={conclusion:'partial',summary:'指令做了，設定頁做不到',items:[{feature:'指令',status:'done',how:'斜線指令'},{feature:'設定頁',status:'claude-code-cannot',why:'Claude Code 沒有插件設定頁'}]};

test('rewriteCheck: a screen-only plugin whose screen can be packed is not rewritten whole',async()=>{
  const source=await uiOnlySource();
  await write(path.join(source,'lib','client.js'),'window.__ModuleLoader__.load({id:"dsh-tiny-ui",factory:()=>({apply(){}})})\n');
  const check=await rewriteCheck(source,{home:await temp('dsh-rewrite-home-')});
  assert.ok(!check.targets.some(item=>/整個插件/.test(item.feature)));
  assert.match(check.targets[0].feature,/獨立網頁放不下/);
  assert.match(check.targets[0].why,/-ui/);
  assert.equal(check.convertedPart,true);
});

test('rewriteCheck → prepareRewrite → finishRewrite → applyRewrite, for a plugin that is only DSH screens',async()=>{
  const source=await uiOnlySource();
  const home=await temp('dsh-rewrite-home-');
  const check=await rewriteCheck(source,{home});
  assert.equal(check.allowed,true);assert.equal(check.meaningful,true);
  assert.match(check.targets[0].feature,/整個插件/);
  assert.equal(check.author,'Someone');

  const prepared=await prepareRewrite(source,{home,convert:fakeConvert});
  assert.equal(prepared.convertedPart,false);
  const plugin=prepared.pluginDir;
  assert.deepEqual(await readJson(path.join(plugin,'hooks','hooks.json')),{modules:['./main.ts']});
  assert.ok(await exists(path.join(plugin,'source','lib','index.js')),'原始碼副本');
  const task=await readJson(prepared.taskFile);
  assert.equal(task.plugin.author,'Someone');
  assert.ok(task.writable.some(item=>item.endsWith('hooks/rewrite/')));

  // 子代理寫了不允許的位置 → 拒絕，並列出檔案。
  await write(path.join(plugin,'hooks','rewrite','register.tsx'),REWRITE);
  await write(path.join(plugin,RESULT_FILE),RESULT);
  await write(path.join(plugin,'.claude-plugin','plugin.json'),{name:'dsh-tiny-ui',version:'1.2.3',description:'changed by the subagent'});
  await assert.rejects(finishRewrite(prepared.workDir),error=>error.code==='REWRITE_OUTSIDE'&&error.files.includes('.claude-plugin/plugin.json'));
  // 改回原樣（跟 scaffold 寫的格式一樣，雜湊才會相同）。
  await fs.writeFile(path.join(plugin,'.claude-plugin','plugin.json'),JSON.stringify({name:'dsh-tiny-ui',version:'1.2.3',description:'tiny ui'},null,2)+'\n');

  const finished=await finishRewrite(prepared.workDir,{model:'sonnet',effort:'high'});
  assert.equal(finished.conclusion,'partial');assert.equal(finished.wired,true);
  assert.deepEqual(finished.written,['hooks/rewrite/register.tsx',RESULT_FILE]);
  assert.deepEqual(finished.abilities,[],'只註冊斜線指令，沒有用到要特別說明的能力');
  const main=await fs.readFile(path.join(plugin,'hooks','main.ts'),'utf8');
  assert.match(main,/import \{ register as rewritten, onSessionStart \} from '\.\/rewrite\/register\.tsx'/);
  assert.match(main,/on\('session\.start', onSessionStart\)/);
  assert.doesNotMatch(main,/register\.ts'/);
  const manifest=await readJson(path.join(plugin,'.claude-plugin','plugin.json'));
  assert.match(manifest.description,/^Claude 補寫版（原作者 Someone，MIT）：tiny ui/);
  assert.deepEqual(manifest.author,{name:'Someone'});
  assert.equal((await readJson(path.join(plugin,RESULT_FILE))).by.model,'sonnet');
  assert.equal(await exists(path.join(plugin,NOTICE_FILE)),false,'寬鬆授權不寫授權注意');
  // 再跑一次（例如子代理修正後）不會把自己寫的檔案當成子代理改的。
  await finishRewrite(prepared.workDir,{model:'sonnet',effort:'high'});

  // 安裝時：來源不同就拒絕；相同就在新的轉換資料夾做出只有補寫部分的插件。
  const staging=await temp('dsh-rewrite-staging-');
  await assert.rejects(applyRewrite(prepared.workDir,staging,{report:{conversion:{status:'not-applicable'}},input:'npm:other@1.0.0'}),error=>error.code==='REWRITE_SOURCE_MISMATCH');
  const applied=await applyRewrite(prepared.workDir,staging,{report:{conversion:{status:'not-applicable'},description:'tiny ui'},input:task.source.pinnedSource});
  assert.equal(applied.wired,true);
  for(const file of ['hooks/main.ts','hooks/rewrite/register.tsx',RESULT_FILE,'.claude-plugin/plugin.json','source/lib/index.js'])assert.ok(await exists(path.join(staging,file)),file);
  for(const dir of [source,home,staging])await fs.rm(dir,{recursive:true,force:true});
});

test('a converted part: rewrite-shared.ts calls the rewritten hooks, main.ts registers both modules',async()=>{
  const source=await uiOnlySource('GPL-3.0-only');
  const home=await temp('dsh-rewrite-home-');
  // 假的轉換：有轉換的部分（register.ts 與預設的 rewrite-shared.ts）。
  const convert=async(input,{outputDir})=>{
    await write(path.join(outputDir,'.claude-plugin','plugin.json'),{name:'dsh-tiny-ui',version:'1.2.3',description:'tiny ui'});
    await write(path.join(outputDir,'hooks','hooks.json'),{modules:['./register.ts']});
    await write(path.join(outputDir,'hooks','register.ts'),'export const register = () => {}\n');
    await write(path.join(outputDir,'hooks','rewrite-shared.ts'),'export function rewriteSessionStart($, e, next) { return next(e) }\n');
    return {conversion:{status:'partial'},plugin:{name:'dsh-tiny-ui',version:'1.2.3',bridgeConfig:{staticTools:[{dshName:'tiny.search',name:'tiny_search'}]}}};
  };
  const prepared=await prepareRewrite(source,{home,convert});
  assert.equal(prepared.convertedPart,true);
  assert.deepEqual(prepared.tools.map(tool=>tool.name),['mcp__dsh-tiny-ui__tiny_search']);
  await write(path.join(prepared.pluginDir,'hooks','rewrite','register.tsx'),REWRITE);
  await write(path.join(prepared.pluginDir,RESULT_FILE),RESULT);
  const finished=await finishRewrite(prepared.workDir);
  assert.equal(finished.copyleft,true);
  const notice=await fs.readFile(path.join(prepared.pluginDir,NOTICE_FILE),'utf8');
  assert.match(notice,/只能自己用/);assert.match(notice,/如果公開/);assert.match(notice,/GPL-3\.0/);
  const main=await fs.readFile(path.join(prepared.pluginDir,'hooks','main.ts'),'utf8');
  assert.match(main,/import \{ register as converted \} from '\.\/register\.ts'/);
  assert.match(main,/converted\(on, options\)\n  rewritten\(on, options\)/);
  const shared=await fs.readFile(path.join(prepared.pluginDir,'hooks','rewrite-shared.ts'),'utf8');
  assert.match(shared,/import \{ onSessionStart \} from '\.\/rewrite\/register\.tsx'/);
  assert.match(shared,/return await onSessionStart\(\$, e, next\)/);
  assert.match(shared,/export function rewriteToolCall\(/,'沒用到的事件保留什麼都不做的版本');
  for(const dir of [source,home])await fs.rm(dir,{recursive:true,force:true});
});

test('Claude Code cannot do any of it: nothing is wired, nothing to install; a bad result is refused with the reasons',async()=>{
  const source=await uiOnlySource();
  const home=await temp('dsh-rewrite-home-');
  const prepared=await prepareRewrite(source,{home,convert:fakeConvert});
  await write(path.join(prepared.pluginDir,RESULT_FILE),{conclusion:'partial',summary:'x',items:[{feature:'餘額',status:'claude-code-cannot',why:'沒有服務商 API'}]});
  await assert.rejects(finishRewrite(prepared.workDir),error=>error.code==='REWRITE_RESULT_INVALID'&&error.errors.some(item=>/claude-code-cannot/.test(item)));
  await write(path.join(prepared.pluginDir,RESULT_FILE),{conclusion:'claude-code-cannot',summary:'核心是 DSH 服務商餘額',items:[{feature:'餘額',status:'claude-code-cannot',why:'沒有服務商 API'}]});
  const finished=await finishRewrite(prepared.workDir);
  assert.equal(finished.wired,false);
  assert.equal(await exists(path.join(prepared.pluginDir,'hooks','main.ts')),false);
  const staging=await temp('dsh-rewrite-staging-');
  await assert.rejects(applyRewrite(prepared.workDir,staging,{report:{conversion:{status:'not-applicable'}}}),error=>error.code==='REWRITE_NOTHING');
  for(const dir of [source,home,staging])await fs.rm(dir,{recursive:true,force:true});
});

test('prepareRewrite refuses without a license, and with a model of its own the plugin is not prepared',async()=>{
  const source=await uiOnlySource();
  await write(path.join(source,'package.json'),{name:'dsh-tiny-ui',version:'1.2.3',license:'UNLICENSED',dsh:{client:{}}});
  await fs.rm(path.join(source,'LICENSE'));
  const home=await temp('dsh-rewrite-home-');
  await assert.rejects(prepareRewrite(source,{home,convert:fakeConvert}),error=>error.code==='REWRITE_NO_LICENSE');
  assert.equal(await exists(path.join(home,'rewrites')),false);
  for(const dir of [source,home])await fs.rm(dir,{recursive:true,force:true});
});

test('TASK_FILE lists what the subagent may write and the result file it must leave',()=>{
  assert.equal(TASK_FILE,'補寫任務.json');
  assert.equal(RESULT_FILE,'補寫結果.json');
});
