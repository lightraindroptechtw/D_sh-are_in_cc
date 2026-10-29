import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {planSourceDependencies,installSourceDependencies} from '../lib/source-deps.mjs';

async function fixture(t,pkg,lock){const root=await fs.mkdtemp(path.join(os.tmpdir(),'v040-deps-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'package.json'),JSON.stringify(pkg));if(lock)await fs.writeFile(path.join(root,'package-lock.json'),JSON.stringify(lock));return root;}
const row=(version='1.0.0')=>({version,resolved:'https://registry.npmjs.org/probe/-/probe-1.0.0.tgz',integrity:'sha512-AAAA'});
const lock=()=>({lockfileVersion:3,packages:{'':{dependencies:{probe:'1.0.0','@deepseek-ai/dsh-tools':'*'},devDependencies:{dev:'1.0.0'}},'node_modules/probe':{...row(),dependencies:{leaf:'1.0.0','@deepseek-ai/dsh-tools':'*'}},'node_modules/leaf':row(),'node_modules/dev':{...row(),dev:true},'node_modules/@deepseek-ai/dsh-tools':row()}});

test('A2 plan filters official, alias-to-official and development dependencies; disabled install runs nothing',async t=>{
  const root=await fixture(t,{dependencies:{probe:'1.0.0','@deepseek-ai/dsh-tools':'*',alias:'npm:@deepseek-ai/dsh-tools@*'},devDependencies:{dev:'1.0.0'},scripts:{preinstall:'MUST_NOT_EXECUTE'}});
  const plan=await planSourceDependencies(root);assert.deepEqual(plan.packages,[{name:'probe',requested:'1.0.0'}]);assert.equal(plan.excluded.length,2);
  const result=await installSourceDependencies(plan,{enabled:false,runner(){throw Error('MUST_NOT_RUN');}});assert.equal(result.status,'disabled');assert.equal(result.sourceExecuted,false);
});

test('A2 sanitizes a valid lock, uses npm ci, reports plan before runner, retains integrity and source files',async t=>{
  const root=await fixture(t,{dependencies:{probe:'1.0.0','@deepseek-ai/dsh-tools':'*'},devDependencies:{dev:'1.0.0'}},lock());
  const before=await fs.readFile(path.join(root,'package-lock.json'),'utf8');const plan=await planSourceDependencies(root);assert.equal(plan.lockMode,'sanitized-production-lock');assert.deepEqual(Object.keys(plan.lock.packages),['','node_modules/leaf','node_modules/probe']);assert.equal(plan.lock.packages['node_modules/probe'].dependencies['@deepseek-ai/dsh-tools'],undefined);
  let planned=false;const calls=[];
  const result=await installSourceDependencies(plan,{destination:path.join(root,'out'),npm:{command:'npm-fixture',prefix:[]},onPlan:async p=>{assert.equal(p.status,'planned');planned=true;},runner:async(command,args,options)=>{assert.ok(planned);calls.push({command,args,options});return {code:0,stdout:'',stderr:''};}});
  assert.equal(result.status,'installed');assert.equal(result.method,'npm-ci');assert.equal(result.sourceFilesUnchanged,true);assert.equal(calls.length,1);assert.equal(calls[0].args[0],'ci');for(const arg of ['--ignore-scripts','--omit=dev','--legacy-peer-deps','--no-audit','--no-fund'])assert.ok(calls[0].args.includes(arg));assert.equal(result.installed.length,2);assert.equal(result.installed[0].integrity,'sha512-AAAA');assert.equal(await fs.readFile(path.join(root,'package-lock.json'),'utf8'),before);
});

test('A2 unsupported specifications and errors never expose URL credentials or child output',async t=>{
  const root=await fixture(t,{dependencies:{secret:'https://user:SECRET@example.com/x.tgz'}});const plan=await planSourceDependencies(root);assert.ok(!JSON.stringify(plan).includes('SECRET'));assert.equal((await installSourceDependencies(plan,{destination:path.join(root,'out')})).error.code,'DEPENDENCY_SPEC_UNSUPPORTED');
  const good=await fixture(t,{dependencies:{probe:'1.0.0'}},lock());const result=await installSourceDependencies(await planSourceDependencies(good),{destination:path.join(good,'out'),npm:{command:'npm',prefix:[]},runner:async()=>({code:1,stdout:'TOKEN=SECRET',stderr:'https://user:SECRET@example.com'})});assert.equal(result.status,'failed');assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('A2 invalid source locks report fallback and metadata-only resolution precedes npm ci',async t=>{
  const root=await fixture(t,{dependencies:{probe:'1.0.0'}},{lockfileVersion:1});const plan=await planSourceDependencies(root);assert.equal(plan.lockFallbackReason,'LOCK_FORMAT');const calls=[];
  const result=await installSourceDependencies(plan,{destination:path.join(root,'out'),npm:{command:'npm',prefix:[]},runner:async(_command,args,options)=>{calls.push(args);if(args[0]==='install')await fs.writeFile(path.join(options.cwd,'package-lock.json'),JSON.stringify(lock()));return {code:0};}});assert.equal(result.status,'installed');assert.ok(calls[0].includes('--package-lock-only'));assert.equal(calls[1][0],'ci');assert.equal(result.method,'npm-resolve-then-ci');
});
