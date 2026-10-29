// A plugin whose apply() returns an API object (not a dispose function) used to stop with Cordis "TypeError: Invalid effect"
// (real case: @a9i5k4/dsh-ark9canvas). The contract is the same in cordis 4.0.1 and 4.0.5, so the host adapts the value
// instead of changing the plugin. Synthetic plugins only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {adaptApplyResult} from '../lib/compat/apply-result.mjs';
import {makePlugin,spawnHost,toolHeader} from './claude-host-helpers.mjs';

test('adaptApplyResult: effects Cordis accepts pass through untouched, other values are dropped or turned into a dispose',async()=>{
  const seen=[];
  const note=row=>seen.push(row);
  const fn=()=>{};
  assert.equal(adaptApplyResult(undefined,note),undefined);
  assert.equal(adaptApplyResult(null,note),null);
  assert.equal(adaptApplyResult(fn,note),fn);
  function* gen(){yield fn;}
  const generator=gen();
  assert.equal(adaptApplyResult(generator,note),generator);
  assert.deepEqual(seen,[],'valid effects are not reported');
  assert.equal(adaptApplyResult({api:1,getConfig(){}},note),undefined);
  assert.deepEqual(seen.at(-1),{kind:'object',keys:['api','getConfig']},'only key names are reported, never values');
  assert.equal(adaptApplyResult('text',note),undefined);assert.equal(adaptApplyResult(42,note),undefined);
  assert.equal(adaptApplyResult([1,2],note),undefined);
  assert.deepEqual(adaptApplyResult([fn,undefined],note),[fn,undefined]);
  let disposed=0;
  const withDispose={dispose(){disposed++;return this===withDispose?'ok':'wrong this';}};
  const dispose=adaptApplyResult(withDispose,note);
  assert.equal(typeof dispose,'function');dispose();assert.equal(disposed,1);
  assert.equal(seen.at(-1).kind,'object-with-dispose');
  assert.equal(await adaptApplyResult(Promise.resolve({a:1}),note),undefined);
  assert.equal(typeof await adaptApplyResult(Promise.resolve({dispose(){}}),note),'function');
  assert.equal(await adaptApplyResult(Promise.resolve(fn),note),fn);
});

const probe=(applyBody,extra='')=>toolHeader+`export const name='returns-object';export const inject=['tools'];${extra}
export function apply(ctx){ctx.tools.register(tool('ping',async()=>({pong:true})));${applyBody}}`;

test('apply() returning a plain API object no longer fails with "Invalid effect"; the host reports what it ignored',async t=>{
  const root=await makePlugin(t,probe(`return {api:{secret:'must-not-be-reported'},getConfig:()=>1,dispose(){}};`));
  const host=await spawnHost(t,root,{answer:async()=>({})});
  const ready=await host.ready();
  assert.deepEqual(ready.tools.map(row=>row.dshName),['ping']);
  const note=ready.metadata.compat.find(row=>row.id==='apply-return-value');
  assert.ok(note,JSON.stringify(ready.metadata.compat));
  assert.equal(note.kind,'object-with-dispose');
  assert.deepEqual(note.keys,['api','getConfig','dispose']);
  assert.ok(!JSON.stringify(ready.metadata).includes('must-not-be-reported'),'values never reach the metadata');
  const result=await host.rpc('tools.call',{name:'ping',args:{},callId:'c1'});
  assert.equal(result.isError,false);
});

test('apply() returning an object without dispose, a primitive, or a promise of an object also starts',async t=>{
  for(const [label,body]of [['object',`return {api:1};`],['string',`return 'ready';`],['promise',`return Promise.resolve({api:1});`]]){
    const root=await makePlugin(t,probe(body).replace('export function apply','export async function apply').replace(`export async function apply(ctx){`,`export async function apply(ctx){`));
    const host=await spawnHost(t,root,{answer:async()=>({})});
    const ready=await host.ready().catch(error=>assert.fail(label+': '+error.message));
    assert.deepEqual(ready.tools.map(row=>row.dshName),['ping'],label);
    await host.stop();
  }
});

test('the dispose function of a returned object runs when the host shuts down',async t=>{
  const root=await makePlugin(t,probe(`const file=process.env.DISPOSE_MARKER;return {dispose(){import('node:fs').then(fs=>fs.writeFileSync(file,'done'));}};`),{passEnv:['DISPOSE_MARKER']});
  // The marker lives in the plugin's state folder: the Claude Code worker may only write its allowed folders (Node permission model).
  const marker=path.join(root,'.state','disposed.txt');
  const host=await spawnHost(t,root,{env:{DISPOSE_MARKER:marker},answer:async()=>({})});
  await host.ready();
  await host.rpc('dispose');
  await Promise.race([host.exited,new Promise(resolve=>setTimeout(resolve,8000))]);
  assert.equal(await fs.readFile(marker,'utf8').catch(()=>'missing'),'done');
});

test('a valid effect (dispose function) is not reported as a compat measure',async t=>{
  const root=await makePlugin(t,probe(`return ()=>{};`));
  const host=await spawnHost(t,root,{answer:async()=>({})});
  const ready=await host.ready();
  assert.equal(ready.metadata.compat.some(row=>row.id==='apply-return-value'),false);
});
