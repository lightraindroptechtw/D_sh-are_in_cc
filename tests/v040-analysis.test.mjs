import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {inspectJs,inspectSource} from '../lib/inspect.mjs';
import {checkRuntimeVersions} from '../lib/runtime-versions.mjs';

test('A1 intentionally includes prereleases for matching ranges and wildcard but excludes older minor',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'v040-range-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const dir=path.join(root,'node_modules/@deepseek-ai/dsh-tools');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-tools',version:'0.2.1-rc.2'}));
  for(const requested of ['^0.2.0-rc.2','*','^0.1']){const r=await checkRuntimeVersions({dependencies:{'@deepseek-ai/dsh-tools':requested}},{runtimeRoot:root});assert.equal(r.requirements[0].status,requested==='^0.1'?'outside-declared-range':'in-declared-range');assert.equal(r.rangePolicy.includePrerelease,true);}
});

test('A8 tracks apply parameter, context/service aliases, destructuring and inject callback context',()=>{
  const r=inspectJs(`export const inject={required:['tools'],optional:['web']};
export function apply(host){const alias=host;const {settings:config,webServer:server}=alias;const second=alias;second.inject(['commands'], (connection)=>{connection.webServer.register({});const {llm:model}=connection;model.list();});config.describe();server.register({});}
function canvas(ctx){ctx.fillStyle='red';ctx.jitless();ctx.tools.fake();}
export function drawing(ctx){ctx.fillStyle='blue';}
`);
  for(const name of ['tools','web','settings','webServer','commands','llm'])assert.ok(r.services.includes(name),name);
  assert.ok(!r.services.includes('inject'));assert.ok(r.contextApi.some(item=>item.name==='inject'));
  assert.ok(!r.services.includes('fillStyle'));assert.ok(!r.services.includes('jitless'));
  assert.ok(r.uncertainServices.some(x=>x.name==='fillStyle'));assert.ok(r.uncertainServices.some(x=>x.name==='jitless'));
});

test('A8 excludes nested shadowing and preserves unknown DSH declarations as uncertain',()=>{
  const r=inspectJs(`export const inject=['futureService'];export const apply=({tools:registry,...rest})=>{registry.register({});function paint({tools}){tools.draw();}function inner(ctx){ctx.settings.fake();} rest.webServer.register();};`);
  assert.ok(r.services.includes('tools'));assert.ok(!r.services.includes('settings'));assert.ok(!r.services.includes('webServer'));assert.ok(!r.services.includes('futureService'));assert.ok(r.uncertainServices.some(x=>x.name==='futureService'));
});

test('A3/A4 report only reachable static environment names and homedir evidence without ambient values',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'v040-env-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'environment',main:'index.mjs'}));
  await fs.writeFile(path.join(root,'index.mjs'),`import './reachable.mjs';export function apply(host){host.tools.register({name:'safe'});}process.env.TAVILY_API_KEY;process.env['GITHUB_TOKEN'];process.env[dynamic];`);
  await fs.writeFile(path.join(root,'reachable.mjs'),`import {homedir as home} from 'node:os';home();process.env.XDG_CONFIG_HOME;`);
  await fs.writeFile(path.join(root,'unreachable.mjs'),`process.env.SECRET_UNREACHABLE;`);
  const r=await inspectSource(root);assert.deepEqual(r.environment.requiredNames,['GITHUB_TOKEN','TAVILY_API_KEY','XDG_CONFIG_HOME']);assert.equal(r.homeAccess.detected,true);assert.ok(r.homeAccess.evidence.some(x=>x.kind==='os.homedir'&&x.path==='reachable.mjs'));assert.equal(r.environment.sourceExecuted,false);
});

test('static tool timeout literals and dynamic declarations are recorded separately',()=>{
  const result=inspectJs(`export function apply(ctx){ctx.tools.register({name:'long',timeoutMs:180000,execute(){return 1}});ctx.tools.register({name:'dynamic',timeoutMs:config.timeout,execute(){return 1}});}`);
  assert.deepEqual(result.toolTimeouts.map(x=>({static:x.static,timeoutMs:x.timeoutMs})),[{static:true,timeoutMs:180000},{static:false,timeoutMs:null}]);
});
