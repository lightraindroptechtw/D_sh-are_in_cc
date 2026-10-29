import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateClaudePackage,runClaudePluginValidate,summarizeCliReport,resolveClaudeCli,writeClaudeModFiles,writeClaudeManifestOnly,readTemplates} from '../lib/claude-package.mjs';
import {tempRoot,writeStubTemplates} from './claude-package-fixtures.mjs';

const cliFile=fileURLToPath(new URL('../bin/d-sh-are-in-cc.mjs',import.meta.url));
const write=async(root,file,content)=>{await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),typeof content==='string'?content:JSON.stringify(content,null,2));};

/** 手工組出一個結構正確的橋接插件，再逐項破壞。 */
async function bridgePackage(t){
  const root=await tempRoot(t);
  const templates=await readTemplates(await writeStubTemplates(path.join(root,'templates')));
  const out=path.join(root,'pkg');
  await fs.mkdir(out);
  await writeClaudeModFiles({outputDir:out,templates,name:'dsh-sample',version:'0.1.0',description:'sample',bridgeConfig:{schemaVersion:1,pluginName:'dsh-sample',displayName:'sample',hostEntry:'runtime/claude-host.mjs',node:'node',startupTimeoutMs:1,callTimeoutMs:1,features:{},staticTools:[]}});
  await write(out,'runtime/claude-host.mjs','// host');
  await write(out,'runtime/dsh-host-worker.mjs','// worker');
  await write(out,'runtime/settings.json',{name:'sample'});
  await write(out,'runtime/host-env/host-environment.json',{});
  await write(out,'source/package.json',{name:'sample'});
  await write(out,'conversion-report.json',{conversion:{status:'partial'},plugin:{layout:'bridge'}});
  return out;
}
const errorsOf=async dir=>(await validateClaudePackage(dir,{cli:false})).errors.join('\n');

test('a well-formed bridge package validates',async t=>{
  const out=await bridgePackage(t);
  const result=await validateClaudePackage(out,{cli:false});
  assert.equal(result.valid,true,JSON.stringify(result.errors));
  assert.equal(result.layout,'bridge');
  assert.ok(result.warnings.some(item=>/只是檔案結構檢查/.test(item)));
});

test('rejects invalid manifest names, versions and descriptions',async t=>{
  const out=await bridgePackage(t);
  const file=path.join(out,'.claude-plugin/plugin.json');
  const manifest=JSON.parse(await fs.readFile(file,'utf8'));
  for(const bad of ['Has-Upper','under_score','-lead','trail-','a'.repeat(65),'',null]){
    await fs.writeFile(file,JSON.stringify({...manifest,name:bad}));
    assert.match(await errorsOf(out),/name 只能用/,String(bad));
  }
  await fs.writeFile(file,JSON.stringify({...manifest,version:'latest'}));
  assert.match(await errorsOf(out),/version/);
  await fs.writeFile(file,JSON.stringify({...manifest,description:'  '}));
  assert.match(await errorsOf(out),/description/);
  await fs.writeFile(file,JSON.stringify({...manifest,description:'__DSH_PLUGIN_DESCRIPTION__'}));
  assert.match(await errorsOf(out),/佔位字串/);
  await fs.writeFile(file,'{ not json');
  assert.match(await errorsOf(out),/plugin\.json/);
});

test('rejects a bin/ folder',async t=>{
  const out=await bridgePackage(t);
  await write(out,'bin/tool.mjs','x');
  assert.match(await errorsOf(out),/bin\//);
});

test('rejects wrong hooks.json shapes and missing or escaping register module',async t=>{
  const out=await bridgePackage(t);
  for(const bad of [{},{modules:[]},{modules:['./a.ts','./b.ts']},{modules:'./register.ts'},{modules:[1]},{modules:['../outside.ts']},{modules:['./register.txt']}]){
    await write(out,'hooks/hooks.json',bad);
    assert.match(await errorsOf(out),/hooks\/hooks\.json/,JSON.stringify(bad));
  }
  await write(out,'hooks/hooks.json',{modules:['./missing.ts']});
  assert.match(await errorsOf(out),/missing\.ts 不存在/);
});

test('rejects register.ts with the placeholder left, mismatched name, or missing host entry',async t=>{
  const out=await bridgePackage(t);
  const file=path.join(out,'hooks/register.ts');
  const good=await fs.readFile(file,'utf8');
  await fs.writeFile(file,'const config = "__DSH_BRIDGE_CONFIG__";');
  assert.match(await errorsOf(out),/__DSH_BRIDGE_CONFIG__/);
  await fs.writeFile(file,good.replace('"pluginName": "dsh-sample"','"pluginName": "dsh-other"'));
  assert.match(await errorsOf(out),/pluginName/);
  await fs.writeFile(file,good.replace('runtime/claude-host.mjs','runtime/nope.mjs'));
  assert.match(await errorsOf(out),/hostEntry 不存在/);
  await fs.writeFile(file,good.replace('runtime/claude-host.mjs','../../escape.mjs'));
  assert.match(await errorsOf(out),/超出插件資料夾/);
  await fs.writeFile(file,'export const register = () => {};');
  assert.match(await errorsOf(out),/找不到內嵌設定/);
});

test('rejects missing runtime files and folders',async t=>{
  for(const [target,pattern] of [['runtime/claude-host.mjs',/runtime\/claude-host\.mjs/],['runtime/dsh-host-worker.mjs',/dsh-host-worker/],['runtime/settings.json',/settings\.json/],['runtime/host-env',/host-env/],['source',/source\//],['conversion-report.json',/conversion-report/]]){
    const out=await bridgePackage(t);
    await fs.rm(path.join(out,target),{recursive:true,force:true});
    assert.match(await errorsOf(out),pattern,target);
  }
});

test('report claiming installed source dependencies requires runtime/source-deps',async t=>{
  const out=await bridgePackage(t);
  await write(out,'conversion-report.json',{conversion:{status:'partial',sourceDependencies:{status:'installed'}},plugin:{layout:'bridge'}});
  assert.match(await errorsOf(out),/source-deps/);
  await write(out,'runtime/source-deps/package.json',{});
  assert.doesNotMatch(await errorsOf(out),/source-deps/);
});

test('layout mismatch between report and folders is an error; empty plugin is an error',async t=>{
  const out=await bridgePackage(t);
  await write(out,'conversion-report.json',{conversion:{status:'partial'},plugin:{layout:'skills-only'}});
  assert.match(await errorsOf(out),/版型/);
  const root=await tempRoot(t);
  const templates=await readTemplates(await writeStubTemplates(path.join(root,'templates')));
  const empty=path.join(root,'empty');await fs.mkdir(empty);
  await writeClaudeManifestOnly({outputDir:empty,templates,name:'dsh-empty',version:'0.1.0',description:'x'});
  await write(empty,'conversion-report.json',{conversion:{status:'partial'}});
  assert.match(await errorsOf(empty),/沒有內容/);
});

test('warns about a foreign .mcp.json and a manifest without the userConfig switches',async t=>{
  const out=await bridgePackage(t);
  await write(out,'.mcp.json',{});
  const manifest=JSON.parse(await fs.readFile(path.join(out,'.claude-plugin/plugin.json'),'utf8'));
  delete manifest.userConfig.allowAgents;
  await write(out,'.claude-plugin/plugin.json',manifest);
  const result=await validateClaudePackage(out,{cli:false});
  assert.equal(result.valid,true);
  const text=result.warnings.join('\n');
  assert.match(text,/\.mcp\.json/);
  assert.match(text,/allowAgents/);
});

test('cli option: true requires the Claude CLI, missing CLI is reported, not thrown',async t=>{
  const out=await bridgePackage(t);
  const missing=path.join(path.dirname(out),'no-such-claude.exe');
  const required=await validateClaudePackage(out,{cli:true,cliPath:missing});
  assert.equal(required.valid,false);
  assert.match(required.errors.join('\n'),/無法執行 claude plugin validate/);
  const auto=await validateClaudePackage(out,{cli:'auto',cliPath:missing});
  assert.equal(auto.valid,true);
  assert.equal(auto.cli.ran,false);
  assert.equal(auto.cli.available,false);
});

test('CLI path resolution: explicit, environment variable, then found automatically',async()=>{
  const find=async env=>env.CLAUDE_CODE_EXECPATH??'claude';
  assert.equal(await resolveClaudeCli(undefined,{},find),'claude');
  assert.equal(await resolveClaudeCli(undefined,{CLAUDE_CODE_EXECPATH:'/running/claude'},find),'/running/claude');
  assert.equal(await resolveClaudeCli(undefined,{DSH_TO_CLAUDE_CLI:'/from/env'},find),'/from/env');
  assert.equal(await resolveClaudeCli('/explicit',{DSH_TO_CLAUDE_CLI:'/from/env'},find),'/explicit');
});

test('runClaudePluginValidate reports a missing CLI without throwing',async t=>{
  const out=await bridgePackage(t);
  const result=await runClaudePluginValidate(out,{cliPath:path.join(path.dirname(out),'absent')});
  assert.equal(result.ran,false);
  assert.match(result.reason,/找不到/);
});

test('summarizeCliReport flattens errors, warnings, hooks notes and directory findings without local paths',()=>{
  const summary=summarizeCliReport({success:false,manifest:{file:'C:/x/plugin.json',errors:[{path:'name',message:'bad name'}],warnings:[{path:'author',message:'no author'}],notes:[]},contents:[{file:'C:/x/hooks/hooks.json',type:'hooks',errors:['broken'],warnings:[],notes:['hooks: session.start'],gatingHooks:[{hook:'tool.call',hasCatch:true}]}],directory:{findings:[{code:'README_MISSING',severity:'error',blocking:true,message:'long text'}]}});
  assert.equal(summary.success,false);
  assert.deepEqual(summary.errors,['plugin.json: name: bad name','hooks.json: broken']);
  assert.deepEqual(summary.warnings,['plugin.json: author: no author']);
  assert.deepEqual(summary.notes,['hooks: session.start']);
  assert.deepEqual(summary.gatingHooks,['tool.call (.catch)']);
  assert.deepEqual(summary.directoryFindings,[{code:'README_MISSING',severity:'error',blocking:true}]);
  assert.doesNotMatch(JSON.stringify(summary),/C:\//);
});

test('real claude plugin validate accepts a skills-only package (skipped when the CLI is not installed)',async t=>{
  const cli=resolveClaudeCli();
  try{await fs.access(cli);}catch{t.skip('Claude Code CLI not found');return;}
  const root=await tempRoot(t);
  const templates=await readTemplates(await writeStubTemplates(path.join(root,'templates')));
  const out=path.join(root,'pkg');await fs.mkdir(out);
  await writeClaudeManifestOnly({outputDir:out,templates,name:'dsh-skill-pack',version:'0.1.0',description:'Skills only'});
  await write(out,'skills/only/SKILL.md','---\nname: only\ndescription: Only skill\n---\n\nHello.\n');
  await write(out,'conversion-report.json',{conversion:{status:'converted'},plugin:{layout:'skills-only'}});
  const result=await validateClaudePackage(out,{cli:true});
  assert.equal(result.cli.ran,true,JSON.stringify(result.cli));
  assert.equal(result.cli.exitCode,0,JSON.stringify(result.cli));
  assert.equal(result.valid,true,JSON.stringify(result.errors));
});

test('command line: help, validate and error exit codes',async t=>{
  const out=await bridgePackage(t);
  const run=(...args)=>spawnSync(process.execPath,[cliFile,...args],{encoding:'utf8'});
  const help=run('help');
  assert.equal(help.status,0);assert.match(help.stdout,/inspect <來源>/);
  const ok=run('validate',out,'--no-cli');
  assert.equal(ok.status,0,ok.stderr);
  assert.equal(JSON.parse(ok.stdout).valid,true);
  await fs.rm(path.join(out,'runtime/claude-host.mjs'));
  const bad=run('validate',out,'--no-cli');
  assert.equal(bad.status,2);
  assert.equal(JSON.parse(bad.stdout).valid,false);
  const unknown=run('frobnicate',out);
  assert.equal(unknown.status,1);
  assert.match(unknown.stderr,/未知命令/);
  const noOut=run('convert',out);
  assert.equal(noOut.status,1);
  assert.match(noOut.stderr,/--out/);
});
