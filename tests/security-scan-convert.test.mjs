import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {convertToClaude} from '../lib/converter-claude.mjs';
import {validateClaudePackage} from '../lib/claude-package.mjs';
import {writeStubTemplates,stubBuildHost} from './claude-package-fixtures.mjs';
import {writeOutboundSource,writeObfuscatedSource,FAKE_SECRET} from './security-scan-fixtures.mjs';

const readJson=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const exists=async file=>{try{await fs.access(file);return true;}catch{return false;}};
/** 替身範本的 register.ts 是 `const config = <JSON>;`，取出嵌入的設定。 */
const embedded=text=>JSON.parse(text.slice(text.indexOf('const config = ')+15,text.indexOf(';\nexport')));

let root,templatesDir,out,report;
before(async()=>{
  root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh scan convert '));
  templatesDir=await writeStubTemplates(path.join(root,'templates'));
  const source=await writeOutboundSource(root);
  out=path.join(root,'out');
  report=await convertToClaude(source,{outputDir:out,installDependencies:false,templatesDir,buildClaudeHost:stubBuildHost,config:{apiKey:FAKE_SECRET,label:'demo'}});
});
after(()=>fs.rm(root,{recursive:true,force:true}));

test('plugin.json: secret fields merged into userConfig as sensitive strings; template fields kept; template file untouched',async()=>{
  const manifest=await readJson(path.join(out,'.claude-plugin','plugin.json'));
  const field=manifest.userConfig.secret_TAVILY_API_KEY;
  assert.equal(field.type,'string');
  assert.equal(field.sensitive,true);
  assert.match(field.title,/Tavily/);
  assert.match(field.description,/TAVILY_API_KEY/);
  assert.ok(manifest.userConfig.allowModelCalls);
  const template=await readJson(path.join(templatesDir,'plugin.json'));
  assert.equal(template.userConfig.secret_TAVILY_API_KEY,undefined);
  assert.equal(report.conversion.validation.valid,true,JSON.stringify(report.conversion.validation.errors));
});

test('register.ts: outboundTools, secretOptions and securityReport embedded (contract 2)',async()=>{
  const config=embedded(await fs.readFile(path.join(out,'hooks','register.ts'),'utf8'));
  assert.deepEqual(config.outboundTools,[{name:'post_reply',dshName:'post_reply',kind:'comment',targetFields:['bvid'],textFields:['text'],summary:'在影片底下發留言'}]);
  assert.deepEqual(config.secretOptions.map(({option,env,required})=>({option,env,required})),[{option:'secret_TAVILY_API_KEY',env:'TAVILY_API_KEY',required:false}]);
  assert.ok(config.secretOptions[0].title&&config.secretOptions[0].features);
  assert.equal(config.securityReport,'security-report.json');
  assert.ok(config.staticTools.some(tool=>tool.name==='post_reply'));
});

test('security-report.json, SECURITY.md and README.md are written; secret names only, never values',async()=>{
  const scan=await readJson(path.join(out,'security-report.json'));
  assert.equal(scan.engine,'fixed-rules');
  assert.deepEqual(scan.summary.secretNames,['TAVILY_API_KEY']);
  assert.deepEqual(scan.summary.outboundToolNames,['post_reply']);
  assert.deepEqual(scan.configSecrets.map(item=>item.path),['apiKey']);
  const md=await fs.readFile(path.join(out,'SECURITY.md'),'utf8');
  assert.match(md,/對外發文/);
  assert.match(md,/post_reply/);
  assert.match(md,/index\.ts:\d+/);
  const readme=await fs.readFile(path.join(out,'README.md'),'utf8');
  for(const text of ['第三方程式碼','權限和你的使用者帳號一樣','審查不是保證','略過權限確認','secret_TAVILY_API_KEY','被擋下時去哪裡放行','allowDirectExec','extraFolders','outboundMode'])assert.ok(readme.includes(text),text);
  for(const file of ['security-report.json','SECURITY.md','README.md','conversion-report.json'])assert.ok(!(await fs.readFile(path.join(out,file),'utf8')).includes(FAKE_SECRET),file);
});

test('conversion report: security summary, --config secret warning by path, secret names forwarded',async()=>{
  assert.equal(report.security.verdict,'reviewable');
  assert.deepEqual(report.security.outboundTools,['post_reply']);
  assert.deepEqual(report.security.secretOptions,['secret_TAVILY_API_KEY']);
  assert.deepEqual(report.security.configSecrets.map(item=>item.path),['apiKey']);
  const note=report.conversion.notes.find(item=>item.code==='CONFIG_SECRET_IN_SETTINGS');
  assert.ok(note);
  assert.match(note.message,/secret_TAVILY_API_KEY/);
  assert.ok(report.conversion.runtimeOptions.passEnv.includes('TAVILY_API_KEY'));
});

test('validate: a secret_ field that is not sensitive is an error',async()=>{
  const file=path.join(out,'.claude-plugin','plugin.json'),original=await fs.readFile(file,'utf8');
  try{
    const manifest=JSON.parse(original);manifest.userConfig.secret_TAVILY_API_KEY.sensitive=false;
    await fs.writeFile(file,JSON.stringify(manifest));
    const result=await validateClaudePackage(out,{cli:false});
    assert.ok(result.errors.some(item=>/secret_TAVILY_API_KEY/.test(item)));
  }finally{await fs.writeFile(file,original);}
});

test('obfuscated source: refused by default with the reason, no output folder; --allow-unreviewable converts and records it; --outbound-tool flows into the config',async()=>{
  const source=await writeObfuscatedSource(root);
  const refusedOut=path.join(root,'refused');
  await assert.rejects(convertToClaude(source,{outputDir:refusedOut,installDependencies:false,templatesDir,buildClaudeHost:stubBuildHost}),error=>error.code==='UNREVIEWABLE_CODE'&&/lib\/core\.js/.test(error.message)&&/--allow-unreviewable/.test(error.message));
  assert.equal(await exists(refusedOut),false);
  const allowedOut=path.join(root,'allowed');
  const allowed=await convertToClaude(source,{outputDir:allowedOut,installDependencies:false,templatesDir,buildClaudeHost:stubBuildHost,allowUnreviewable:true,outboundTool:['noop']});
  assert.equal(allowed.security.verdict,'unreviewable');
  assert.ok(allowed.conversion.notes.some(item=>item.code==='UNREVIEWABLE_ALLOWED'));
  const config=embedded(await fs.readFile(path.join(allowedOut,'hooks','register.ts'),'utf8'));
  assert.deepEqual(config.outboundTools.map(item=>item.name),['noop']);
  assert.match(await fs.readFile(path.join(allowedOut,'SECURITY.md'),'utf8'),/無法審查/);
});
