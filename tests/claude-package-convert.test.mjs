import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {convertToClaude,buildServiceMapping,isPureNativeUi} from '../lib/converter-claude.mjs';
import {validateClaudePackage} from '../lib/claude-package.mjs';
import {tempRoot,writeStubTemplates,stubBuildHost,writeToolSource,writeSkillOnlySource,writeUiOnlySource} from './claude-package-fixtures.mjs';

const readJson=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const exists=async file=>{try{await fs.access(file);return true;}catch{return false;}};

async function convertTools(t,extra={},sourceOptions={}){
  const root=await tempRoot(t);
  const source=await writeToolSource(root,sourceOptions);
  const templatesDir=await writeStubTemplates(path.join(root,'templates'));
  const out=path.join(root,'out');
  const report=await convertToClaude(source,{outputDir:out,installDependencies:false,templatesDir,buildClaudeHost:stubBuildHost,...extra});
  return {root,source,out,report,templatesDir};
}

// 複製官方宿主環境要幾秒，唯讀的檢查共用同一次轉換。
let shared;
before(async()=>{
  process.env.DSH_CLAUDE_TEST_SECRET='super-secret-value';
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh claude shared '));
  const source=await writeToolSource(root);
  const templatesDir=await writeStubTemplates(path.join(root,'templates'));
  const out=path.join(root,'out');
  const report=await convertToClaude(source,{outputDir:out,installDependencies:false,templatesDir,buildClaudeHost:stubBuildHost,passEnv:['DSH_CLAUDE_TEST_SECRET']});
  shared={root,out,report};
});
after(async()=>{delete process.env.DSH_CLAUDE_TEST_SECRET;if(shared)await fs.rm(shared.root,{recursive:true,force:true});});

test('layout: plugin manifest, hooks, register.ts, runtime, source, skills, report; no bin/',async()=>{
  const {out,report}=shared;
  assert.ok(['partial','converted'].includes(report.conversion.status),JSON.stringify(report.conversion.omitted));
  for(const file of ['.claude-plugin/plugin.json','hooks/hooks.json','hooks/register.ts','runtime/claude-host.mjs','runtime/dsh-host-worker.mjs','runtime/settings.json','runtime/host-env/host-environment.json','source/index.ts','skills/probe-skill/SKILL.md','skills/probe-skill/notes.txt','conversion-report.json'])assert.ok(await exists(path.join(out,file)),file);
  for(const stale of ['bin','runtime/server.mjs','runtime/background.mjs','runtime/codex-hook.mjs','.mcp.json','.codex-plugin'])assert.equal(await exists(path.join(out,stale)),false,stale);
  assert.deepEqual(await readJson(path.join(out,'hooks/hooks.json')),{modules:['./register.ts']});
  assert.equal(report.plugin.layout,'bridge');
  assert.equal(report.conversion.modelCalls,0);
  assert.equal(report.conversion.verification.claudeLoaded,false);
  const settings=await readJson(path.join(out,'runtime/settings.json'));
  assert.equal(settings.name,'@acme/Synthetic Tools');
  assert.equal(settings.background,false);
  assert.equal(report.conversion.validation.valid,true,JSON.stringify(report.conversion.validation.errors));
});

test('naming and manifest: scoped package name becomes a valid dsh- plugin name, description survives escaping',async()=>{
  const manifest=await readJson(path.join(shared.out,'.claude-plugin/plugin.json'));
  assert.equal(manifest.name,'dsh-acme-synthetic-tools');
  assert.equal(manifest.version,'1.2.3');
  assert.match(manifest.description,/Synthetic "quoted" plugin with \$& dollars/);
  assert.equal(manifest.userConfig.allowModelCalls.default,false);
  assert.doesNotMatch(JSON.stringify(manifest),/__DSH_/);
});

test('register.ts: bridge config embedded as JSON, placeholder gone',async()=>{
  const text=await fs.readFile(path.join(shared.out,'hooks/register.ts'),'utf8');
  assert.doesNotMatch(text,/__DSH_BRIDGE_CONFIG__/);
  const start=text.indexOf('{',text.indexOf('const config = ')),end=text.indexOf(';\nexport const register');
  const config=JSON.parse(text.slice(start,end));
  assert.equal(config.schemaVersion,1);
  assert.equal(config.pluginName,'dsh-acme-synthetic-tools');
  assert.equal(config.displayName,'@acme/Synthetic Tools');
  assert.equal(config.hostEntry,'runtime/claude-host.mjs');
  assert.equal(config.node,'node');
  assert.equal(config.startupTimeoutMs,120000);
  assert.equal(config.callTimeoutMs,60000);
  assert.deepEqual(config.features,{tools:true,commands:true,systemPrompt:true,interception:false,ui:false});
  assert.deepEqual(config.staticTools.map(tool=>tool.dshName),['echo_probe']);
  assert.equal(config.staticTools[0].description,'Echo the input');
  assert.deepEqual(config.staticTools[0].inputSchema,{type:'object'});
});

test('service mapping table: supported, partial, off-by-default and unsupported services',async()=>{
  const {report}=shared;
  const rows=Object.fromEntries(report.conversion.serviceMapping.map(row=>[row.dshService,row]));
  assert.equal(rows.tools.claudeCapability,'$.tool.register');
  assert.equal(rows.tools.level,'完整');
  assert.equal(rows.systemPrompt.claudeCapability,'prompt.compose');
  assert.match(rows.llm.claudeCapability,/model\.complete/);
  assert.equal(rows.llm.enabledByDefault,false);
  assert.match(rows.agents.claudeCapability,/agent\.spawn/);
  assert.equal(rows.agents.enabledByDefault,false);
  assert.equal(rows.sessionController.level,'不支援');
  assert.equal(rows.sessionController.claudeCapability,null);
  assert.ok(rows.sessionController.note.length>0);
  assert.ok(report.conversion.omitted.some(item=>item.code==='SERVICE_UNSUPPORTED'&&item.service==='sessionController'));
  assert.deepEqual(report.conversion.serviceSummary,{complete:1,partial:3,unsupported:1});
  assert.equal(report.conversion.verification.toolsListed,false);
});

test('skills are copied verbatim into skills/<dir> with their resources',async()=>{
  const {out,report}=shared;
  const original=await fs.readFile(path.join(out,'source/skills/Probe Skill/SKILL.md'),'utf8');
  assert.equal(await fs.readFile(path.join(out,'skills/probe-skill/SKILL.md'),'utf8'),original);
  assert.ok(report.conversion.components.some(item=>item.kind==='skill'&&item.path==='skills/probe-skill'));
});

test('report, settings and register.ts never carry environment values',async()=>{
  const {out,report}=shared;
  assert.ok(report.conversion.runtimeOptions.passEnv.includes('DSH_CLAUDE_TEST_SECRET'));
  for(const file of ['conversion-report.json','runtime/settings.json','hooks/register.ts'])assert.doesNotMatch(await fs.readFile(path.join(out,file),'utf8'),/super-secret-value/);
});

test('--name option is normalized the same way; timeouts reach the bridge config',async t=>{
  const {out}=await convertTools(t,{name:'My Custom_Name',initializeTimeoutMs:5000,callTimeoutMs:7000});
  assert.equal((await readJson(path.join(out,'.claude-plugin/plugin.json'))).name,'dsh-my-custom-name');
  const text=await fs.readFile(path.join(out,'hooks/register.ts'),'utf8');
  assert.match(text,/"startupTimeoutMs": 5000/);
  assert.match(text,/"callTimeoutMs": 7000/);
});

test('buildServiceMapping: interception rows, commands, timers and uncertain names',()=>{
  const plan={host:{services:['timer','fs','approval','settings','webServer','skills','credentials','sessions','database'],uncertainServices:[{name:'mysteryService',path:'a.ts',line:3,kind:'inject-call'},{name:'subagents',path:'a.ts',line:4,kind:'context-member'},{name:'workspaceRegistry',path:'a.ts',line:5,kind:'context-member'}]},capabilities:{toolRuntime:{tools:[]},hostRuntime:{services:[]},commands:{definitions:[{name:'x'}]}}};
  const {rows,uncertain,summary}=buildServiceMapping(plan,{interception:true});
  const by=Object.fromEntries(rows.map(row=>[row.dshService,row]));
  assert.equal(by.timer.handledBy,'child-host');
  assert.equal(by.fs.level,'完整');
  assert.equal(by.approval.enabledByDefault,true);
  assert.equal(by.commands.claudeCapability,'$.command.register');
  assert.match(by['tools/pre-execute'].claudeCapability,/tool\.call/);
  assert.match(by['tools/post-execute'].claudeCapability,/tool\.call/);
  assert.equal(by.subagents.level,'部分');
  assert.match(by.subagents.claudeCapability,/agent\.spawn/);
  assert.equal(by.workspaceRegistry.level,'不支援');
  assert.equal(by.sessions.level,'不支援');
  assert.equal(by.database.level,'不支援');
  assert.deepEqual(uncertain.map(item=>item.name),['mysteryService']);
  assert.ok(summary.unsupported===3);
  const second=buildServiceMapping({host:{services:[],uncertainServices:[{name:'inject',path:'a.ts',line:1,kind:'context-member'}]},capabilities:{}});
  assert.deepEqual(second.uncertain.map(item=>item.name),['inject']);
  assert.deepEqual(second.rows,[]);
});

test('stateRoot option is passed to the child host settings (claudeHost.stateRoot)',async t=>{
  const root=await tempRoot(t);
  const {out}=await convertTools(t,{stateRoot:path.join(root,'state')});
  const settings=await readJson(path.join(out,'runtime/settings.json'));
  assert.equal(settings.claudeHost.stateRoot,path.join(root,'state'));
  assert.equal(typeof settings.stateId,'string');
});

// 狀態規則（見 lib/converter-claude.mjs 的 ADVISORY_ISSUES）：status 只反映「沒轉或不支援」的項目。
// 「需要宿主服務 systemPrompt」是 Codex 時代的提醒，Claude 版經 prompt.compose 提供；版本範圍不符是相容性提醒，進 warnings。
async function writeSystemPromptSource(root,peer){
  const dir=path.join(root,'source-prompt');
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({name:'prompt-only-tool',version:'1.0.0',type:'module',main:'index.js',...(peer?{peerDependencies:{'@deepseek-ai/dsh-tools':peer}}:{})}));
  await fs.writeFile(path.join(dir,'index.js'),"import{defineTool}from'@deepseek-ai/dsh-tools';export const name='prompt-only-tool';export const inject=['tools','systemPrompt'];export function apply(ctx){ctx.tools.register(defineTool({name:'one',description:'One',parameters:{},output:{schema:{type:'json'},render:(_,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:async()=>({ok:true})}));ctx.systemPrompt.section({name:'g',order:1,text:'Use one.'});}\n");
  return dir;
}
test('status: needing the systemPrompt service alone is not partial; a version-range mismatch is a warning that keeps it partial, with the reason stated',async t=>{
  const root=await tempRoot(t);
  const templatesDir=await writeStubTemplates(path.join(root,'templates'));
  const clean=await convertToClaude(await writeSystemPromptSource(root,undefined),{outputDir:path.join(root,'out-clean'),installDependencies:false,templatesDir,buildClaudeHost:stubBuildHost});
  assert.equal(clean.conversion.status,'converted',JSON.stringify(clean.conversion.omitted));
  assert.deepEqual(clean.conversion.omitted,[]);
  assert.deepEqual(clean.conversion.warnings,[]);
  assert.ok(clean.conversion.notes.some(item=>item.code==='HOST_SERVICES_MAPPED'&&/systemPrompt/.test(item.message)));
  assert.ok(clean.conversion.serviceMapping.some(row=>row.dshService==='systemPrompt'&&row.claudeCapability==='prompt.compose'));
  await fs.rm(path.join(root,'source-prompt'),{recursive:true});
  const mismatch=await convertToClaude(await writeSystemPromptSource(root,'^0.1.0-rc.6'),{outputDir:path.join(root,'out-mismatch'),installDependencies:false,templatesDir,buildClaudeHost:stubBuildHost});
  assert.deepEqual(mismatch.conversion.omitted,[],'a mismatch is not an omission');
  assert.ok(mismatch.conversion.warnings.some(item=>item.code==='HOST_VERSION_MISMATCH'));
  assert.equal(mismatch.conversion.status,'partial');
  assert.match(mismatch.conversion.reason,/HOST_VERSION_MISMATCH/);
  assert.match(mismatch.conversion.reason,/lenient-output/);
});
test('status: a service Claude cannot provide still makes it partial (SERVICE_UNSUPPORTED)',()=>{
  const rows=Object.fromEntries(shared.report.conversion.serviceMapping.map(row=>[row.dshService,row]));
  assert.equal(rows.sessionController.level,'不支援');
  assert.equal(shared.report.conversion.status,'partial');
  assert.ok(!shared.report.conversion.omitted.some(item=>item.code==='HOST_SERVICES'));
});

test('source is copied unchanged and never executed during conversion',async t=>{
  const root=await tempRoot(t);
  const source=await writeToolSource(root);
  await fs.writeFile(path.join(source,'index.ts'),(await fs.readFile(path.join(source,'index.ts'),'utf8'))+"\nimport fs from'node:fs';fs.writeFileSync(new URL('./initialized',import.meta.url),'yes');\n");
  const templatesDir=await writeStubTemplates(path.join(root,'templates'));
  const out=path.join(root,'out');
  await convertToClaude(source,{outputDir:out,installDependencies:false,templatesDir,buildClaudeHost:stubBuildHost});
  assert.equal(await exists(path.join(source,'initialized')),false);
  assert.equal(await exists(path.join(out,'source/initialized')),false);
  assert.equal(await fs.readFile(path.join(out,'source/index.ts'),'utf8'),await fs.readFile(path.join(source,'index.ts'),'utf8'));
});

test('native-UI package with a frontend is packaged rather than discarded',async t=>{
  const root=await tempRoot(t),source=await writeUiOnlySource(root),out=path.join(root,'out');
  const report=await convertToClaude(source,{outputDir:out,installDependencies:false,templatesDir:await writeStubTemplates(path.join(root,'templates')),buildClaudeHost:stubBuildHost});
  assert.notEqual(report.conversion.status,'not-applicable');
  assert.equal(report.plugin.bridgeConfig.features.ui,true);
  assert.equal(await exists(path.join(out,'runtime/ui/manifest.json')),true);
  assert.equal(await exists(path.join(out,'.claude-plugin/plugin.json')),true);
  const check=await validateClaudePackage(out,{cli:false});assert.equal(check.valid,true,JSON.stringify(check));
});

test('isPureNativeUi needs NATIVE_UI and no tools, skills, commands or MCP',()=>{
  const base={host:{client:true},issues:[],capabilities:{skills:[],commands:{definitions:[],dynamicRegistrations:[]},mcpServers:{},pythonServers:[],toolRuntime:null}};
  assert.equal(isPureNativeUi(base),true);
  assert.equal(isPureNativeUi({...base,capabilities:{...base.capabilities,toolRuntime:{tools:[]}}}),false);
  assert.equal(isPureNativeUi({...base,capabilities:{...base.capabilities,skills:[{name:'s'}]}}),false);
  assert.equal(isPureNativeUi({...base,host:{client:false}}),false);
});

test('skills-only source produces a manifest and skills without hooks or runtime',async t=>{
  const root=await tempRoot(t);
  const source=await writeSkillOnlySource(root);
  const out=path.join(root,'out');
  const report=await convertToClaude(source,{outputDir:out,installDependencies:false,templatesDir:await writeStubTemplates(path.join(root,'templates')),buildClaudeHost:async()=>{throw new Error('host must not be built');}});
  assert.equal(report.plugin.layout,'skills-only');
  assert.equal(await exists(path.join(out,'hooks')),false);
  assert.equal(await exists(path.join(out,'runtime')),false);
  assert.equal(await exists(path.join(out,'skills/only-skill/SKILL.md')),true);
  const check=await validateClaudePackage(out,{cli:false});
  assert.equal(check.valid,true,JSON.stringify(check.errors));
  assert.equal(check.layout,'skills-only');
});

test('host build failure: first-line reason recorded, falls back to skills-only when skills exist',async t=>{
  const {out,report}=await convertTools(t,{buildClaudeHost:async()=>{throw new Error('Could not resolve "x"\n    at secret stack');}});
  assert.equal(report.plugin.layout,'skills-only');
  const failure=report.conversion.omitted.find(item=>item.code==='HOST_BUILD');
  assert.equal(failure.message,'Could not resolve "x"');
  assert.ok(report.conversion.omitted.some(item=>item.code==='SKILLS_ONLY_FALLBACK'));
  assert.equal(await exists(path.join(out,'runtime/claude-host.mjs')),false);
  assert.equal(await exists(path.join(out,'hooks')),false);
});

test('host build failure without skills is unsupported and writes no plugin manifest',async t=>{
  const {out,report}=await convertTools(t,{buildClaudeHost:async()=>{throw Object.assign(new Error('boom'),{code:'CLAUDE_HOST_MISSING'});}},{withSkill:false});
  assert.equal(report.conversion.status,'unsupported');
  assert.match(report.conversion.reason,/boom/);
  assert.equal(await exists(path.join(out,'.claude-plugin')),false);
});

test('missing mod templates fail with a clear error',async t=>{
  const root=await tempRoot(t);
  const source=await writeToolSource(root);
  await assert.rejects(convertToClaude(source,{outputDir:path.join(root,'out'),installDependencies:false,templatesDir:path.join(root,'no-templates'),buildClaudeHost:stubBuildHost}),/找不到 mod 範本/);
});

test('refuses an existing output folder, overlapping folders, and invalid options',async t=>{
  const root=await tempRoot(t);
  const source=await writeToolSource(root);
  const existing=path.join(root,'existing');await fs.mkdir(existing);
  await assert.rejects(convertToClaude(source,{outputDir:existing}),/已存在/);
  await assert.rejects(convertToClaude(source,{outputDir:path.join(source,'inside')}),/互相包含/);
  await assert.rejects(convertToClaude(source,{outputDir:path.join(root,'o1'),passEnv:['bad name']}),/passEnv/);
  await assert.rejects(convertToClaude(source,{outputDir:path.join(root,'o2'),homeMode:'weird'}),/homeMode/);
  await assert.rejects(convertToClaude(source,{}),/--out/);
});

// 整合：用真正的 mod 範本與子程序宿主打包（兩者都存在才跑）。仍然不啟動插件、不載入 Claude Code。
const here=path.dirname(fileURLToPath(import.meta.url));
const realParts=await Promise.all(['../templates/claude-mod/register.ts','../lib/claude-host/build.mjs'].map(file=>exists(path.resolve(here,file))));
test('integration: real templates and real child-host build produce a package that validates',{skip:!realParts.every(Boolean)&&'templates/claude-mod or lib/claude-host/build.mjs missing'},async t=>{
  const root=await tempRoot(t);
  const source=await writeToolSource(root);
  const out=path.join(root,'out');
  const report=await convertToClaude(source,{outputDir:out,installDependencies:false});
  assert.equal(report.plugin.layout,'bridge',JSON.stringify(report.conversion.omitted));
  assert.ok((await fs.stat(path.join(out,'runtime/claude-host.mjs'))).size>1000);
  const text=await fs.readFile(path.join(out,'hooks/register.ts'),'utf8');
  assert.doesNotMatch(text,/__DSH_BRIDGE_CONFIG__/);
  const check=await validateClaudePackage(out,{cli:'auto'});
  assert.equal(check.valid,true,JSON.stringify(check.errors));
  if(check.cli?.ran)assert.equal(check.cli.success,true,JSON.stringify(check.cli.errors));
});
