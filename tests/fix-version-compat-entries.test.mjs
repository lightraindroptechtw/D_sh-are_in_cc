// A package whose cordis.patch.yml mounts SEVERAL plugin rows ("<package>/<subpath>", each backed by a package.json export) used to fail with
// "UNSUPPORTED_ENTRY: Plugin needs a Cordis apply export", because only package.json "main" (a plain library entry) was loaded
// (real case: dsh-agentmail with tools / identity / approval / inbound). Each row is now its own Cordis plugin with the row's config;
// `!!js process.env.X` values are evaluated at start-up from the passEnv environment and never written to disk. Synthetic plugins only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inspectSource} from '../lib/inspect.mjs';
import {evaluateDshExpression,expressionEnvNames,resolveConfigExpressions,UnsupportedExpressionError} from '../lib/compat/dsh-expression.mjs';
import {convertToClaude} from '../lib/converter-claude.mjs';
import {makePlugin,spawnHost} from './claude-host-helpers.mjs';
import {writeStubTemplates} from './claude-package-fixtures.mjs';

const tmp=async(t,label)=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),label));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:300}).catch(()=>{}));return dir;};

test('expressions: environment reads, fallbacks and negation are evaluated; anything else is refused, never executed',()=>{
  const env={A:'alpha',EMPTY:'',ZERO:'0'};
  assert.equal(evaluateDshExpression('process.env.A',env),'alpha');
  assert.equal(evaluateDshExpression("process.env['A']",env),'alpha');
  assert.equal(evaluateDshExpression('process.env.NOPE',env),undefined);
  assert.equal(evaluateDshExpression("process.env.NOPE ?? 'dflt'",env),'dflt');
  assert.equal(evaluateDshExpression("process.env.EMPTY ?? 'dflt'",env),'');
  assert.equal(evaluateDshExpression("process.env.EMPTY || 'dflt'",env),'dflt');
  assert.equal(evaluateDshExpression('!process.env.NOPE && !process.env.NOPE2',env),true);
  assert.equal(evaluateDshExpression('!process.env.A',env),false);
  assert.equal(evaluateDshExpression("process.env.A === 'alpha' ? 'yes' : 'no'",env),'yes');
  // Arithmetic is outside the grammar on purpose (only reads, fallbacks, comparisons and casts are needed by real patches).
  assert.throws(()=>evaluateDshExpression('Number(process.env.ZERO) + 0',env),UnsupportedExpressionError);
  assert.equal(evaluateDshExpression('Number(process.env.ZERO)',env),0);
  assert.equal(evaluateDshExpression('true',env),true);assert.equal(evaluateDshExpression('("x")',env),'x');
  for(const bad of ['process.exit(3)','process.env','process','globalThis.x','require("fs")','(()=>1)()','constructor.constructor("return 1")()','process.env.A.length','1 +','"unterminated','`tpl`','new Date()','process.env.A;process.exit()',''])
    assert.throws(()=>evaluateDshExpression(bad,env),UnsupportedExpressionError,bad);
  assert.deepEqual(expressionEnvNames("process.env.A ?? process.env['B_2'] ?? process.env.A"),['A','B_2']);
  assert.deepEqual(expressionEnvNames('1'),[]);
});

test('resolveConfigExpressions: markers are replaced, undefined keys disappear, unsupported expressions are reported by their variable names only',()=>{
  const unsupported=[];
  const out=resolveConfigExpressions({apiKey:{$dshExpression:'process.env.K'},none:{$dshExpression:'process.env.NOPE'},nested:{a:{$dshExpression:"process.env.K ?? 'x'"},list:[{$dshExpression:'process.env.K'},{$dshExpression:'process.env.NOPE'},3]},literal:true,bad:{$dshExpression:'process.exit(9)'}},
    {env:{K:'v'},onUnsupported:(text,error)=>unsupported.push([text,error.code])});
  assert.deepEqual(out,{apiKey:'v',nested:{a:'v',list:['v',3]},literal:true});
  assert.deepEqual(unsupported,[['process.exit(9)','UNSUPPORTED_EXPRESSION']]);
  assert.equal(resolveConfigExpressions(5),5);
});

// ---------------------------------------------------------------- static analysis

async function writePackage(dir,{pkg,patch,files={}}){
  await fs.mkdir(path.join(dir,'lib'),{recursive:true});
  await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({version:'1.0.0',description:'probe',type:'module',...pkg}));
  if(patch!==undefined)await fs.writeFile(path.join(dir,'cordis.patch.yml'),patch);
  for(const [name,text]of Object.entries(files)){await fs.mkdir(path.dirname(path.join(dir,name)),{recursive:true});await fs.writeFile(path.join(dir,name),text);}
}
const libraryIndex=`export const helper=()=>1;\n`;
const toolsEntry=`import {defineTool} from '@deepseek-ai/dsh-tools';
export const name='multi-tools';export const inject=['tools'];
export function apply(ctx,config){
  ctx.tools.register(defineTool({name:'show_config',description:'config seen by this entry',parameters:{},output:{schema:{type:'json'},render:(_,v)=>[{type:'text',text:JSON.stringify(v)}]},
    execute:async()=>({keys:Object.keys(config).sort(),hasKey:typeof config.apiKey==='string',keyIsExpected:config.apiKey===process.env.MULTI_KEY,label:config.label,fallback:config.fallback,notPassed:config.notPassed===undefined?'absent':'present'})}));
}
`;
const gateEntry=`import {defineTool} from '@deepseek-ai/dsh-tools';
export const name='multi-gate';export const inject=['tools','systemPrompt'];
export function apply(ctx,config){
  ctx.systemPrompt.section({name:'multi-gate',order:5,text:'The gate entry is active (deny='+config.deny+').'});
  ctx.tools.register(defineTool({name:'gate_status',description:'gate state',parameters:{},output:{schema:{type:'json'},render:(_,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:async()=>({deny:config.deny})}));
}
`;
const multiPatch=`- insert:
    - id: multi-tools
      name: multi-bundle/tools
      config:
        apiKey: !!js process.env.MULTI_KEY
        label: static
        missing: !!js process.env.MULTI_UNSET
        notPassed: !!js process.env.MULTI_NOT_PASSED
        fallback: !!js process.env.MULTI_UNSET ?? 'dflt'
    - id: multi-gate
      name: multi-bundle/gate
      config:
        deny: true
`;
const multiPackage={pkg:{name:'multi-bundle',main:'./lib/index.js',exports:{'.':'./lib/index.js','./tools':'./lib/tools.js','./gate':'./lib/gate.js','./package.json':'./package.json'},dsh:{bundle:{patch:'./cordis.patch.yml'}}},patch:multiPatch,files:{'lib/index.js':libraryIndex,'lib/tools.js':toolsEntry,'lib/gate.js':gateEntry}};

test('inspect: patch rows named <package>/<subpath> become entries, with their own config and the variables they read',async t=>{
  const dir=await tmp(t,'fix entries inspect ');
  await writePackage(dir,multiPackage);
  const plan=await inspectSource({root:dir});
  assert.equal(plan.entry,'./lib/index.js','the library entry stays the package entry (Codex behaviour is unchanged)');
  assert.deepEqual(plan.entries.map(({id,name,subpath,entry})=>({id,name,subpath,entry})),[
    {id:'multi-tools',name:'multi-bundle/tools',subpath:'./tools',entry:'lib/tools.js'},
    {id:'multi-gate',name:'multi-bundle/gate',subpath:'./gate',entry:'lib/gate.js'}]);
  assert.deepEqual(plan.entries[0].config.apiKey,{$dshExpression:'process.env.MULTI_KEY'});
  assert.equal(plan.entries[0].config.label,'static');assert.deepEqual(plan.entries[1].config,{deny:true});
  assert.deepEqual(plan.environment.requiredNames,['MULTI_KEY','MULTI_NOT_PASSED','MULTI_UNSET']);
  assert.deepEqual(plan.defaultConfig,{},'nothing is mistaken for the default config of a single plugin');
  assert.deepEqual(plan.capabilities.toolRuntime.tools.map(tool=>tool.name).sort(),['gate_status','show_config'],'the entry files are analysed, not only the library entry');
  assert.ok(plan.capabilities.hostRuntime);
  assert.ok(plan.evidence.some(row=>row.kind==='patch-entries'));
  assert.equal(plan.issues.some(row=>/PATCH_/.test(row.code)),false,JSON.stringify(plan.issues));
});

test('inspect: a main row is kept next to subpath rows; ids are legal loader ids and unique',async t=>{
  const dir=await tmp(t,'fix entries main ');
  await writePackage(dir,{...multiPackage,pkg:{...multiPackage.pkg,main:'./lib/tools.js',exports:{...multiPackage.pkg.exports,'.':'./lib/tools.js'}},
    patch:`- insert:\n    - name: multi-bundle\n      config: {label: main}\n    - id: "we ird/id"\n      name: multi-bundle/gate\n      config: {deny: false}\n    - id: "we-ird-id"\n      name: multi-bundle/tools\n`});
  const plan=await inspectSource({root:dir});
  assert.deepEqual(plan.entries.map(row=>[row.id,row.subpath,row.entry]),[['main','.','lib/tools.js'],['we-ird-id','./gate','lib/gate.js'],['we-ird-id-3','./tools','lib/tools.js']]);
  assert.ok(plan.entries.every(row=>/^[A-Za-z0-9_.-]+$/.test(row.id)));
});

test('inspect: packages that are not multi-row bundles are untouched (single main row, rows of other packages, explicit entry, unknown subpath, missing file)',async t=>{
  const single=await tmp(t,'fix entries single ');
  await writePackage(single,{pkg:{name:'solo',main:'./lib/tools.js',exports:{'.':'./lib/tools.js','./tools':'./lib/tools.js'},dsh:{bundle:{patch:'./cordis.patch.yml'}}},patch:`- insert:\n    - id: solo-row\n      name: solo\n      config: {label: x}\n`,files:{'lib/tools.js':toolsEntry}});
  const soloPlan=await inspectSource({root:single});
  assert.equal(soloPlan.entries,undefined);assert.deepEqual(soloPlan.defaultConfig,{label:'x'});assert.equal(soloPlan.entry,'./lib/tools.js');

  const others=await tmp(t,'fix entries others ');
  await writePackage(others,{pkg:{name:'@acme/patent',main:'./lib/tools.js',exports:{'.':'./lib/tools.js','./tools':'./lib/tools.js'},dsh:{bundle:{patch:'./cordis.patch.yml'}}},
    patch:`- insert:\n    - id: a\n      name: "@acme/patent"\n      config: {label: x}\n    - id: b\n      name: "@acme/tool-patent"\n    - id: c\n      name: "@acme/patent-extra/tools"\n`,files:{'lib/tools.js':toolsEntry}});
  assert.equal((await inspectSource({root:others})).entries,undefined,'rows named after other packages are not entries');

  const explicit=await tmp(t,'fix entries explicit ');
  await writePackage(explicit,multiPackage);
  const plan=await inspectSource({root:explicit},{sourceEntry:'lib/gate.js'});
  assert.equal(plan.entries,undefined,'an explicit --entry wins');assert.equal(plan.entry,'lib/gate.js');

  const unknown=await tmp(t,'fix entries unknown ');
  await writePackage(unknown,{...multiPackage,patch:`- insert:\n    - id: u\n      name: multi-bundle/not-exported\n    - id: m\n      name: multi-bundle/gate\n`});
  const unknownPlan=await inspectSource({root:unknown});
  assert.deepEqual(unknownPlan.entries.map(row=>row.id),['m'],'a subpath that is not a package export is ignored');

  const missing=await tmp(t,'fix entries missing ');
  await writePackage(missing,{...multiPackage,files:{'lib/index.js':libraryIndex,'lib/tools.js':toolsEntry}});
  const missingPlan=await inspectSource({root:missing});
  assert.deepEqual(missingPlan.entries.map(row=>row.id),['multi-tools']);
  assert.ok(missingPlan.issues.some(row=>row.code==='PATCH_ENTRY_MISSING'&&/gate/.test(row.message)));
});

// ---------------------------------------------------------------- host

const entriesOf=(...ids)=>ids.map(id=>({id,name:'multi-bundle/'+id,entry:id==='multi-tools'?'lib/tools.js':'lib/gate.js',config:id==='multi-tools'?{apiKey:{$dshExpression:'process.env.MULTI_KEY'},label:'static',missing:{$dshExpression:'process.env.MULTI_UNSET'},notPassed:{$dshExpression:'process.env.MULTI_NOT_PASSED'},fallback:{$dshExpression:"process.env.MULTI_UNSET ?? 'dflt'"}}:{deny:true}}));
const hostFiles={'lib/tools.js':toolsEntry,'lib/gate.js':gateEntry};

test('host: every entry becomes its own plugin; config comes from the row with expressions evaluated from passEnv only',async t=>{
  const root=await makePlugin(t,libraryIndex,{entries:entriesOf('multi-tools','multi-gate'),passEnv:['MULTI_KEY','MULTI_UNSET']},{files:hostFiles});
  const host=await spawnHost(t,root,{env:{MULTI_KEY:'value-from-env',MULTI_NOT_PASSED:'visible-only-if-passed'},answer:async()=>({})});
  const ready=await host.ready();
  assert.deepEqual(ready.tools.map(row=>row.dshName).sort(),['gate_status','show_config']);
  assert.ok(ready.promptSections.some(section=>/gate entry is active \(deny=true\)/.test(section.text)),JSON.stringify(ready.promptSections));
  const shown=JSON.parse((await host.rpc('tools.call',{name:'show_config',args:{},callId:'c1'})).content[0].text);
  assert.deepEqual(shown,{keys:['apiKey','fallback','label'],hasKey:true,keyIsExpected:true,label:'static',fallback:'dflt',notPassed:'absent'},
    'unset variables are undefined (key dropped), `??` fallback applies, a variable that is not in passEnv is invisible');
  assert.equal(JSON.parse((await host.rpc('tools.call',{name:'gate_status',args:{},callId:'c2'})).content[0].text).deny,true);
  const missingNote=ready.metadata.compat.find(row=>row.id==='config-env-missing'&&row.entry==='multi-tools');
  assert.deepEqual(missingNote.names,['MULTI_NOT_PASSED','MULTI_UNSET'],'names only: the host says which variables were empty, never their values');
  assert.ok(!JSON.stringify(ready).includes('value-from-env'),'no value is reported');
});

test('host: settings.config[<entry id>] overrides top-level keys of that entry only; unsupported expressions become undefined plus a note, and are not executed',async t=>{
  const entries=entriesOf('multi-tools','multi-gate');
  entries[0].config.hostile={$dshExpression:'process.exit(7)'};
  const root=await makePlugin(t,libraryIndex,{entries,passEnv:['MULTI_KEY'],config:{'multi-tools':{label:'overridden'},'multi-gate':{deny:false},'not-an-entry':{x:1}}},{files:hostFiles});
  const host=await spawnHost(t,root,{env:{MULTI_KEY:'k'},answer:async()=>({})});
  const ready=await host.ready();
  const shown=JSON.parse((await host.rpc('tools.call',{name:'show_config',args:{},callId:'c1'})).content[0].text);
  assert.equal(shown.label,'overridden');assert.equal(shown.hasKey,true);assert.equal(shown.keys.includes('hostile'),false);
  assert.equal(JSON.parse((await host.rpc('tools.call',{name:'gate_status',args:{},callId:'c2'})).content[0].text).deny,false);
  assert.deepEqual(ready.metadata.compat.find(row=>row.id==='config-expression-unsupported'),{id:'config-expression-unsupported',entry:'multi-tools',names:[]});
  assert.equal(host.child.exitCode,null,'process.exit(7) was not executed');
});

test('host: one entry that does not activate stops the whole host (a policy row must not be silently missing)',async t=>{
  const files={...hostFiles,'lib/bad.js':`export const name='needs-missing';export const inject=['tools','nonexistentService'];export function apply(){}`};
  const entries=[...entriesOf('multi-tools'),{id:'multi-bad',name:'multi-bundle/bad',entry:'lib/bad.js',config:{}}];
  const root=await makePlugin(t,libraryIndex,{entries,passEnv:['MULTI_KEY']},{files});
  const host=await spawnHost(t,root,{env:{MULTI_KEY:'k'},answer:async()=>({})});
  await assert.rejects(host.ready(),error=>{assert.match(error.message,/nonexistentService|did not activate/);return true;});
  const only=await makePlugin(t,libraryIndex,{entries:entriesOf('multi-tools'),passEnv:['MULTI_KEY']},{files});
  const fine=await spawnHost(t,only,{env:{MULTI_KEY:'k'},answer:async()=>({})});
  assert.deepEqual((await fine.ready()).tools.map(row=>row.dshName),['show_config'],'the same entry alone starts');
});

test('host: an entry without an apply export is named in the error; duplicate ids are refused',async t=>{
  const files={...hostFiles,'lib/lib.js':`export const helper=1;`};
  const root=await makePlugin(t,libraryIndex,{entries:[{id:'just-a-library',name:'x/lib',entry:'lib/lib.js',config:{}}]},{files});
  const host=await spawnHost(t,root,{answer:async()=>({})});
  await assert.rejects(host.ready(),error=>{assert.match(error.message,/just-a-library|apply export/);return true;});
  const twice=await makePlugin(t,libraryIndex,{entries:[...entriesOf('multi-gate'),...entriesOf('multi-gate')]},{files});
  const dup=await spawnHost(t,twice,{answer:async()=>({})});
  await assert.rejects(dup.ready(),error=>{assert.match(error.message,/not unique|collides/);return true;});
});

// ---------------------------------------------------------------- converter end to end

test('conversion: one compiled file per entry, expressions kept as expressions, no value on disk; the converted plugin starts without esbuild and sees the environment',async t=>{
  const root=await tmp(t,'fix entries convert ');
  const source=path.join(root,'src');await writePackage(source,multiPackage);
  const secret='sk-synthetic-secret-value-1234567890';
  const out=path.join(root,'out');
  const previous=process.env.MULTI_KEY;process.env.MULTI_KEY=secret;t.after(()=>{if(previous===undefined)delete process.env.MULTI_KEY;else process.env.MULTI_KEY=previous;});
  const report=await convertToClaude(source,{outputDir:out,installDependencies:false,templatesDir:await writeStubTemplates(path.join(root,'templates')),stateMode:'package'});
  assert.ok(['converted','partial'].includes(report.conversion.status),JSON.stringify(report.conversion.omitted));
  assert.deepEqual(report.conversion.entries.map(row=>row.id),['multi-tools','multi-gate']);
  assert.deepEqual(report.conversion.entries[0].config.apiKey,{$dshExpression:'process.env.MULTI_KEY'},'the report shows the variable name, not a value');
  assert.ok(report.conversion.notes.some(row=>row.code==='PATCH_ENTRIES'));
  assert.deepEqual(report.conversion.precompiledEntry.entries.map(row=>row.id),['multi-tools','multi-gate']);
  const settings=JSON.parse(await fs.readFile(path.join(out,'runtime','settings.json'),'utf8'));
  assert.deepEqual(settings.entries.map(row=>[row.id,row.entry]),[['multi-tools','lib/tools.js'],['multi-gate','lib/gate.js']]);
  assert.deepEqual(settings.passEnv.filter(name=>name.startsWith('MULTI_')),['MULTI_KEY','MULTI_NOT_PASSED','MULTI_UNSET'],'variables read by the patch are forwarded like variables read by the code');
  const meta=JSON.parse(await fs.readFile(path.join(out,'runtime','plugin.meta.json'),'utf8'));
  assert.deepEqual(meta.entries.map(row=>[row.id,row.entry,row.file]),[['multi-tools','lib/tools.js','plugins/multi-tools.mjs'],['multi-gate','lib/gate.js','plugins/multi-gate.mjs']]);
  await fs.access(path.join(out,'runtime','plugins','multi-tools.mjs'));await fs.access(path.join(out,'runtime','plugins','multi-gate.mjs'));

  // the value of the variable is nowhere in the converted plugin
  const hits=[];
  const walk=async dir=>{for(const entry of await fs.readdir(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory()){if(!['host-env','node_modules'].includes(entry.name))await walk(full);}
    else if((await fs.stat(full)).size<5e6&&(await fs.readFile(full,'utf8').catch(()=>'')).includes(secret))hits.push(path.relative(out,full));}};
  await walk(out);
  assert.deepEqual(hits,[],'the environment value must not be baked into any file');

  // relocate without esbuild: only the precompiled per-entry files can be used
  const target=path.join(root,'moved','deeper','plugin');await fs.mkdir(path.dirname(target),{recursive:true});await fs.cp(out,target,{recursive:true});
  await fs.rm(path.join(target,'.state'),{recursive:true,force:true});
  for(const dir of ['esbuild','@esbuild'])await fs.rm(path.join(target,'runtime','host-env','node_modules',dir),{recursive:true,force:true});
  const host=await spawnHost(t,target,{bundleFile:path.join(target,'runtime','claude-host.mjs'),rootArg:false,env:{MULTI_KEY:secret,MULTI_NOT_PASSED:'from-parent'},answer:async()=>({})});
  const ready=await host.ready();
  assert.deepEqual(ready.tools.map(row=>row.dshName).sort(),['gate_status','show_config']);
  const shown=JSON.parse((await host.rpc('tools.call',{name:'show_config',args:{},callId:'c1'})).content[0].text);
  assert.equal(shown.keyIsExpected,true);assert.equal(shown.notPassed,'present','a variable the patch reads is forwarded');
  assert.ok(!JSON.stringify(ready).includes(secret));
  // without the variable the entry still starts; the missing value is reported by name.
  // The first host is stopped first: both use the same plugin folder (and so the same .state), as two Claude Code sessions never do.
  await host.stop();
  const bare=await spawnHost(t,target,{bundleFile:path.join(target,'runtime','claude-host.mjs'),rootArg:false,env:{MULTI_KEY:''},answer:async()=>({})});
  const bareReady=await bare.ready();
  assert.ok(bareReady.metadata.compat.some(row=>row.id==='config-env-missing'&&row.names.includes('MULTI_UNSET')));
  // Stop the host before the temporary folder is removed: after hooks run in registration order, and removing the folder of a
  // running host on Windows does not finish (the test file never ended).
  await bare.stop();
});
