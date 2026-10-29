// A plugin may refuse to start unless @deepseek-ai/dsh-tools is EXACTLY the version it was written for
// (real case: dsh-plugin-veriscope wants 0.2.1-alpha.2, the bundled runtime is 0.2.1-rc.2). The comparison of the two releases showed that
// defineTool, ToolArgsError and validateArgs are textually identical, so the plugin may see the requested version through a shim package that
// re-exports the REAL bundled package: no second copy, no second tool registry. Synthetic plugins only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {VERSION_ALIASES,planVersionAliases,installVersionAliases,removeAliasedScope} from '../lib/compat/version-alias.mjs';
import {convertToClaude} from '../lib/converter-claude.mjs';
import {makePlugin,spawnHost,projectRoot} from './claude-host-helpers.mjs';
import {writeStubTemplates} from './claude-package-fixtures.mjs';

const scopeDirectory=path.join(projectRoot,'node_modules','@deepseek-ai');
const tmp=async(t,label)=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),label));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{}));return dir;};

test('planVersionAliases: only the compared pair (requested 0.2.1-alpha.2, bundled 0.2.1-rc.2 of dsh-tools) qualifies',()=>{
  const mismatch=(name,requested,installed)=>({name,requested,installed,status:'outside-declared-range'});
  assert.deepEqual(planVersionAliases([mismatch('@deepseek-ai/dsh-tools','0.2.1-alpha.2','0.2.1-rc.2')]).map(({name,version,hostVersion})=>({name,version,hostVersion})),
    [{name:'@deepseek-ai/dsh-tools',version:'0.2.1-alpha.2',hostVersion:'0.2.1-rc.2'}]);
  assert.deepEqual(planVersionAliases([mismatch('@deepseek-ai/dsh-tools','0.2.1-alpha.3','0.2.1-rc.2')]),[],'another requested version was not compared');
  assert.deepEqual(planVersionAliases([mismatch('@deepseek-ai/dsh-tools','0.2.1-alpha.2','0.2.1-rc.3')]),[],'another bundled version was not compared');
  assert.deepEqual(planVersionAliases([mismatch('@deepseek-ai/dsh-llm','0.2.1-alpha.2','0.2.1-rc.2')]),[],'another package was not compared');
  assert.deepEqual(planVersionAliases([]),[]);assert.deepEqual(planVersionAliases(undefined),[]);
  assert.ok(Object.isFrozen(VERSION_ALIASES)&&VERSION_ALIASES.every(row=>row.comparedExports.length&&row.evidence));
});

test('installVersionAliases: the shim reports the requested version but exports the very same module objects as the real package',async t=>{
  const dir=await tmp(t,'fix tools alias ');
  const scopeLink=path.join(dir,'@deepseek-ai');
  const rows=await installVersionAliases({scopeLink,scopeDirectory,aliases:[{name:'@deepseek-ai/dsh-tools',version:'0.2.1-alpha.2'}]});
  assert.equal(rows.length,1);assert.equal(rows[0].realVersion,JSON.parse(await fs.readFile(path.join(scopeDirectory,'dsh-tools','package.json'),'utf8')).version);
  const shim=JSON.parse(await fs.readFile(path.join(scopeLink,'dsh-tools','package.json'),'utf8'));
  assert.equal(shim.name,'@deepseek-ai/dsh-tools');assert.equal(shim.version,'0.2.1-alpha.2');
  assert.ok(shim.exports['.']&&shim.exports['./package.json']);
  const real=await import(pathToFileURL(path.join(scopeDirectory,'dsh-tools','lib','index.js')).href);
  const aliased=await import(pathToFileURL(path.join(scopeLink,'dsh-tools',shim.exports['.'].slice(2))).href);
  assert.equal(aliased.defineTool,real.defineTool,'one defineTool');
  assert.equal(aliased.ToolArgsError,real.ToolArgsError,'one error class, so instanceof checks across plugin and host agree');
  assert.equal(aliased.default,real.default,'one tool registry class');
  assert.deepEqual(Object.keys(aliased).sort(),Object.keys(real).sort());
  // every other package is a plain link to the real directory
  const other=(await fs.readdir(scopeDirectory)).find(name=>name!=='dsh-tools');
  assert.equal(await fs.realpath(path.join(scopeLink,other)),await fs.realpath(path.join(scopeDirectory,other)));
  // idempotent
  assert.equal((await installVersionAliases({scopeLink,scopeDirectory,aliases:[{name:'@deepseek-ai/dsh-tools',version:'0.2.1-alpha.2'}]})).length,1);
  // removing the aliased scope removes links and the shim only; the real packages stay
  await removeAliasedScope(scopeLink);
  await assert.rejects(fs.access(scopeLink));
  assert.ok((await fs.readdir(path.join(scopeDirectory,'dsh-tools','lib'))).includes('index.js'),'the bundled package is untouched');
});

test('installVersionAliases refuses anything that is not in the table (a hand-edited settings file cannot spoof other packages)',async t=>{
  const dir=await tmp(t,'fix tools alias refuse ');
  for(const row of [{name:'@deepseek-ai/dsh-llm',version:'0.2.1-alpha.2'},{name:'@deepseek-ai/dsh-tools',version:'9.9.9'},null])
    await assert.rejects(installVersionAliases({scopeLink:path.join(dir,'s'),scopeDirectory,aliases:[row]}),error=>error.code==='INVALID_CONFIGURATION');
  await assert.rejects(fs.access(path.join(dir,'s')),'nothing was created');
});

// The same kind of gate veriscope has: read the version through import.meta.resolve before loading the SDK, then use defineTool.
const gated=`import {readFileSync} from 'node:fs';
const SDK='@deepseek-ai/dsh-tools';
const metadata=JSON.parse(readFileSync(new URL(import.meta.resolve(SDK+'/package.json')),'utf8'));
if(metadata.version!=='0.2.1-alpha.2')throw Object.assign(new Error('[SDK_INCOMPATIBLE] '+SDK+' version mismatch: need 0.2.1-alpha.2, found '+metadata.version),{code:'SDK_INCOMPATIBLE'});
const {defineTool}=await import(SDK);
const tool=(name,execute)=>defineTool({name,description:'synthetic '+name,parameters:{},output:{schema:{type:'json'},render:(_,v)=>[{type:'text',text:JSON.stringify(v)}]},execute});
export const name='version-gated';export const inject=['tools'];
export function apply(ctx){ctx.tools.register(tool('gate_ok',async()=>({seen:metadata.version})));}
`;

test('without the alias a version-gated plugin stops with its own message; with it the plugin starts and its tool runs in the host registry',async t=>{
  const refused=await makePlugin(t,gated);
  const bad=await spawnHost(t,refused,{answer:async()=>({})});
  await assert.rejects(bad.ready(),error=>{assert.match(error.message,/SDK_INCOMPATIBLE|version mismatch/);return true;});
  const accepted=await makePlugin(t,gated,{versionAliases:[{name:'@deepseek-ai/dsh-tools',version:'0.2.1-alpha.2'}]});
  const host=await spawnHost(t,accepted,{answer:async()=>({})});
  const ready=await host.ready();
  assert.deepEqual(ready.tools.map(row=>row.dshName),['gate_ok'],'the tool built by the plugin\'s defineTool is accepted by the host registry (one registry)');
  assert.equal(ready.metadata.versions['@deepseek-ai/dsh-tools'],JSON.parse(await fs.readFile(path.join(scopeDirectory,'dsh-tools','package.json'),'utf8')).version,'the host itself still reports the real bundled version');
  const note=ready.metadata.compat.find(row=>row.id==='version-alias');
  assert.deepEqual({package:note.package,reports:note.reports},{package:'@deepseek-ai/dsh-tools',reports:'0.2.1-alpha.2'});
  assert.deepEqual(note.comparedExports,['defineTool','ToolArgsError','validateArgs']);
  const result=await host.rpc('tools.call',{name:'gate_ok',args:{},callId:'c1'});
  assert.equal(result.isError,false,JSON.stringify(result));
  assert.equal(JSON.parse(result.content[0].text).seen,'0.2.1-alpha.2');
});

test('a plugin that does not use the alias keeps the plain directory link, and a stale aliased scope is cleaned up',async t=>{
  const root=await makePlugin(t,gated,{versionAliases:[{name:'@deepseek-ai/dsh-tools',version:'0.2.1-alpha.2'}]},{});
  const first=await spawnHost(t,root,{answer:async()=>({})});
  await first.ready();await first.stop();
  const settingsFile=path.join(root,'runtime','settings.json');
  const settings=JSON.parse(await fs.readFile(settingsFile,'utf8'));
  delete settings.versionAliases;
  await fs.writeFile(settingsFile,JSON.stringify(settings));
  const second=await spawnHost(t,root,{answer:async()=>({})});
  await assert.rejects(second.ready(),/version mismatch|SDK_INCOMPATIBLE/,'back to the real version: the gate refuses again, the host did not fail on the leftover directory');
  const link=path.join(root,'.state','compiled','node_modules','@deepseek-ai');
  assert.equal((await fs.lstat(link)).isSymbolicLink(),true);
});

test('conversion: the alias is planned from the source\'s own peer dependency, written to settings, noted in the report; other versions are not aliased',async t=>{
  const root=await tmp(t,'fix tools alias convert ');
  const make=async(label,range)=>{
    const source=path.join(root,'src-'+label);await fs.mkdir(source,{recursive:true});
    await fs.writeFile(path.join(source,'package.json'),JSON.stringify({name:'gated-'+label,version:'1.0.0',description:'probe',type:'module',main:'index.mjs',peerDependencies:{'@deepseek-ai/dsh-tools':range}}));
    await fs.writeFile(path.join(source,'index.mjs'),gated);
    return convertToClaude(source,{outputDir:path.join(root,'out-'+label),installDependencies:false,templatesDir:await writeStubTemplates(path.join(root,'templates-'+label)),stateMode:'package',precompileEntry:false});
  };
  const yes=await make('yes','0.2.1-alpha.2');
  const settings=JSON.parse(await fs.readFile(path.join(root,'out-yes','runtime','settings.json'),'utf8'));
  assert.deepEqual(settings.versionAliases,[{name:'@deepseek-ai/dsh-tools',version:'0.2.1-alpha.2'}]);
  const note=yes.conversion.notes.find(row=>row.code==='VERSION_ALIAS');
  assert.ok(note&&/dsh-tools/.test(note.message)&&note.aliases[0].hostVersion);
  assert.ok(yes.conversion.warnings.some(row=>row.code==='HOST_VERSION_MISMATCH'),'the mismatch warning stays: the alias only silences the plugin\'s own gate');
  const no=await make('no','0.2.1-alpha.5');
  assert.equal(JSON.parse(await fs.readFile(path.join(root,'out-no','runtime','settings.json'),'utf8')).versionAliases,undefined);
  assert.equal(no.conversion.notes.some(row=>row.code==='VERSION_ALIAS'),false);
});
