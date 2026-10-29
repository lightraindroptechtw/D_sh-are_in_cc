import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDshTools, compileDshEntry } from '../lib/runtime.mjs';

async function fixture(t, code, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'entry.ts'), code);
  for (const [name, text] of Object.entries(files)) { const path = join(root, name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text); }
  return { root, entry: join(root, 'entry.ts'), stateDir: join(root, 'state') };
}
const typed = `import {defineTool} from '@deepseek-ai/dsh-tools';
export const inject=['tools'];
export function apply(ctx){ctx.tools.register(defineTool({name:'echo',description:'Echo',parameters:{text:{type:'string',required:true}},output:{schema:{type:'string'},render:(_,v)=>[{type:'text',text:v}]},execute:async a=>a.text}));}`;

test('TypeScript tool DSL validates required args and preserves canonical renderer', async t => {
  const f = await fixture(t, typed); const bridge = await loadDshTools(f); t.after(bridge.dispose);
  assert.equal(bridge.tools.length, 1); assert.deepEqual(bridge.tools[0].inputSchema.required, ['text']);
  assert.equal((await bridge.tools[0].execute({ text: '繁體中文' })).content[0].text, '繁體中文');
  await assert.rejects(bridge.tools[0].execute({ text: 3 }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(bridge.tools[0].execute({}), { code: 'VALIDATION_ERROR' });
});

test('raw JSON Schema constraints reject calls before body and keep legacy MCP errors', async t => {
  const f = await fixture(t, `export function apply(ctx){ctx.tools.register({name:'raw',description:'raw',parameters:{type:'object',properties:{n:{type:'integer',minimum:2}},required:['n'],additionalProperties:false},execute:async()=>({content:[{type:'text',text:'domain failure'}],isError:true})})}`);
  const b = await loadDshTools(f); t.after(b.dispose);
  await assert.rejects(b.tools[0].execute({ n: 1 }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(b.tools[0].execute({ n: 2, sneaky: 3 }), { code: 'VALIDATION_ERROR' });
  assert.equal((await b.tools[0].execute({ n: 2 })).isError, true);
});

test('nested DSL required fields and exact-one unions compile to JSON Schema', async t => {
  const f = await fixture(t, `import {defineTool} from '@deepseek-ai/dsh-tools'; export function apply(ctx){ctx.tools.register(defineTool({name:'nested',description:'nested',parameters:{data:{type:'object',required:true,additionalProperties:false,properties:{id:{oneOf:[{type:'string'},{type:'integer'}],required:true}}}},execute:async a=>a.data}))}`);
  const b = await loadDshTools(f); t.after(b.dispose);
  assert.equal((await b.tools[0].execute({ data: { id: 'x' } })).structuredContent.id, 'x');
  await assert.rejects(b.tools[0].execute({ data: { id: null } }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(b.tools[0].execute({ data: {} }), { code: 'VALIDATION_ERROR' });
});

test('schemastery config defaults are merged then validated without supplying settings', async t => {
  const f = await fixture(t, `import z from '@deepseek-ai/schemastery'; export const Config=z.object({prefix:z.string().default('預設').extra('volatile',true),count:z.natural().default(2).max(4)}); export function apply(ctx,c){ctx.tools.register({name:'config',description:'config',parameters:{type:'object'},execute:async()=>c})}`);
  const b = await loadDshTools({ ...f, config: { count: 3 } }); t.after(b.dispose);
  const r = (await b.tools[0].execute({})).structuredContent;
  assert.equal(r.prefix, '預設'); assert.equal(r.count, 3);
  await assert.rejects(loadDshTools({ ...f, config: { count: -1 } }), { code: 'VALIDATION_ERROR' });
});

test('required host injection rejects before plugin apply', async t => {
  const f = await fixture(t, `import {writeFileSync} from 'node:fs'; export const inject=['tools','webServer']; export function apply(){writeFileSync(new URL('./applied',import.meta.url),'bad')}`);
  await assert.rejects(loadDshTools(f), error => error.code === 'UNSUPPORTED_HOST_FEATURE' && error.unsupported.some(v => v.feature === 'inject:webServer'));
  await assert.rejects(readFile(join(f.root, 'applied')), { code: 'ENOENT' });
});

test('caught unsupported service access still rejects initialization and runs cleanup', async t => {
  const f = await fixture(t, `import {writeFileSync} from 'node:fs'; export function apply(ctx){ctx.effect(()=>()=>writeFileSync(new URL('./disposed',import.meta.url),'yes')); ctx.tools.register({name:'partial',description:'partial',parameters:{type:'object'},execute:async()=>42});try{ctx.settings.update({})}catch{}}`);
  await assert.rejects(loadDshTools(f), error => error.code === 'UNSUPPORTED_HOST_FEATURE' && error.unsupported.some(v => v.feature === 'ctx.settings'));
  assert.equal(await readFile(join(f.root, 'disposed'), 'utf8'), 'yes');
});

test('host event hooks and unimplemented tool policy transforms fail closed', async t => {
  const a = await fixture(t, `export function apply(ctx){ctx.on('ready',()=>{})}`);
  await assert.rejects(loadDshTools(a), { code: 'UNSUPPORTED_HOST_FEATURE' });
  const b = await fixture(t, `export function apply(ctx){ctx.tools.register({name:'policy',description:'policy',parameters:{type:'object'},execute:async()=>1,finalizeContent:()=>[]})}`);
  await assert.rejects(loadDshTools(b), { code: 'UNSUPPORTED_HOST_FEATURE' });
});

test('caught unsupported host access during execute or rendering fails and disables later calls', async t => {
  for (const body of [
    `execute:async()=>{try{ctx.nativeUI.open()}catch{};return 'ok'},output:{schema:{type:'string'},render:(_,v)=>[{type:'text',text:v}]}`,
    `execute:async()=> 'ok',output:{schema:{type:'string'},render:(_,v)=>{try{ctx.slots.register()}catch{};return [{type:'text',text:v}]}}`,
  ]) {
    const f = await fixture(t, `import {defineTool} from '@deepseek-ai/dsh-tools';export function apply(ctx){ctx.tools.register(defineTool({name:'late_host',description:'late_host',parameters:{},${body}}))}`);
    const b = await loadDshTools(f); t.after(b.dispose);
    await assert.rejects(b.tools[0].execute(), { code: 'UNSUPPORTED_HOST_FEATURE' });
    await assert.rejects(b.tools[0].execute(), { code: 'UNSUPPORTED_HOST_FEATURE' });
  }
});

test('source-relative assets, local TS modules and CommonJS dependencies survive bundling', async t => {
  const f = await fixture(t, `import {readFile} from 'node:fs/promises';import dep from './dep.cjs';import {suffix} from './nested/helper.ts';export function apply(ctx){ctx.tools.register({name:'asset',description:'asset',parameters:{type:'object'},execute:async()=>dep+(await readFile(new URL('./asset.txt',import.meta.url),'utf8'))+suffix})}`, { 'dep.cjs': `module.exports='common:';`, 'asset.txt': 'asset', 'nested/helper.ts': `export const suffix:string=':ts'` });
  const b = await loadDshTools(f); t.after(b.dispose);
  assert.equal((await b.tools[0].execute()).content[0].text, 'common:asset:ts');
});

test('canonical output validation, renderer failures and unsupported content cannot report success', async t => {
  for (const [body, code] of [
    [`output:{schema:{type:'integer'},render:()=>[{type:'text',text:'bad'}]},execute:async()=> 'wrong'`, 'VALIDATION_ERROR'],
    [`output:{schema:{type:'string'},render:()=>[{type:'video',url:'x'}]},execute:async()=> 'ok'`, 'UNSUPPORTED_CONTENT'],
    [`output:{schema:{type:'string'},render:()=>{throw new Error('renderer failed')}},execute:async()=> 'ok'`, undefined],
  ]) {
    const f = await fixture(t, `import {defineTool} from '@deepseek-ai/dsh-tools';export function apply(ctx){ctx.tools.register(defineTool({name:'bad',description:'bad',parameters:{},${body}}))}`);
    const b = await loadDshTools(f); t.after(b.dispose);
    await assert.rejects(b.tools[0].execute(), error => code ? error.code === code : error.message === 'renderer failed');
  }
});

test('lossless JSON boundary rejects silent coercions and gives tools frozen detached args', async t => {
  const f = await fixture(t, `export function apply(ctx){ctx.tools.register({name:'json',description:'json',parameters:{type:'object'},execute:async a=>({frozen:Object.isFrozen(a)&&Object.isFrozen(a.x),value:a.x.value})})}`);
  const b = await loadDshTools(f); t.after(b.dispose);
  const args = { x: { value: 3 } }; const r = await b.tools[0].execute(args);
  assert.equal(r.structuredContent.frozen, true); assert.equal(args.x.value, 3); assert.equal(Object.isFrozen(args), false);
  for (const value of [undefined, NaN, Infinity, -0, new Date(), () => {}]) await assert.rejects(b.tools[0].execute({ x: value }));
  await assert.rejects(b.tools[0].execute({ x: { get value() { throw new Error('getter must not execute'); } } }), /accessors/);
});

test('dispose cleans effects once and prevents later tool calls', async t => {
  const f = await fixture(t, `import {appendFileSync} from 'node:fs';export function apply(ctx){ctx.effect(()=>()=>appendFileSync(new URL('./cleanup',import.meta.url),'x'));ctx.tools.register({name:'one',description:'one',parameters:{type:'object'},execute:async()=>1})}`);
  const b = await loadDshTools(f); await b.dispose(); await b.dispose();
  assert.equal(await readFile(join(f.root, 'cleanup'), 'utf8'), 'x');
  await assert.rejects(b.tools[0].execute(), { code: 'DISPOSED' });
});

test('cancellation propagates via exec.signal and timeout remains cooperative', async t => {
  const f = await fixture(t, `export function apply(ctx){ctx.tools.register({name:'cancel',description:'cancel',parameters:{type:'object'},timeoutMs:25,execute:async(a,exec)=>await new Promise((resolve,reject)=>{exec.signal.addEventListener('abort',()=>reject(exec.signal.reason),{once:true})})})}`);
  const b = await loadDshTools(f); t.after(b.dispose);
  await assert.rejects(b.tools[0].execute({}, { signal: AbortSignal.abort(new Error('already canceled')) }), /already canceled/);
  // A normal timer keeps Node alive while AbortSignal.timeout's timer is unref'ed.
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
  await assert.rejects(b.tools[0].execute(), { name: 'TimeoutError' });
});

test('default exclusive calls are serialized even when MCP callers overlap', async t => {
  const f = await fixture(t, `let active=0;export function apply(ctx){ctx.tools.register({name:'exclusive',description:'exclusive',parameters:{type:'object'},execute:async()=>{active++;await new Promise(r=>setTimeout(r,10));const overlap=active;active--;return overlap}})}`);
  const b = await loadDshTools(f); t.after(b.dispose);
  const results = await Promise.all([b.tools[0].execute(), b.tools[0].execute()]);
  assert.deepEqual(results.map(r => r.content[0].text), ['1', '1']);
});

test('compiled entry can run without invoking compiler again', async t => {
  const f = await fixture(t, typed); const outfile = join(f.root, 'compiled.mjs');
  const compiled = await compileDshEntry({ entry: f.entry, sourceRoot: f.root, outfile });
  assert.ok(compiled.inputs.length >= 2);
  const b = await loadDshTools({ entry: outfile, stateDir: f.stateDir, prebundled: true }); t.after(b.dispose);
  assert.equal((await b.tools[0].execute({ text: 'precompiled' })).content[0].text, 'precompiled');
});

test('portable compiled source keeps assets and source-relative require after moving and deleting original', async t => {
  const f = await fixture(t, `import {createRequire} from 'node:module';import {readFile} from 'node:fs/promises';import {nested} from './nested/helper.ts';const localRequire=createRequire(import.meta.url);export function apply(ctx){ctx.tools.register({name:'portable',description:'portable',parameters:{type:'object'},execute:async()=>({asset:await readFile(new URL('./asset%20%23%25繁體.txt',import.meta.url),'utf8'),nested:await nested(),required:localRequire('./data.json').message})})}`, {
    'asset #%繁體.txt': 'main asset', 'data.json': '{"message":"required asset"}',
    'nested/helper.ts': `import {readFile} from 'node:fs/promises';export async function nested(){return readFile(new URL('./nested.txt',import.meta.url),'utf8')}`,
    'nested/nested.txt': 'nested asset',
  });
  const generated = join(f.root, 'generated'); const source = join(generated, 'source');
  await mkdir(source, { recursive: true });
  for (const file of ['entry.ts', 'package.json', 'asset #%繁體.txt', 'data.json', 'nested']) await cp(join(f.root, file), join(source, file), { recursive: true });
  const outfile = join(generated, 'compiled.mjs');
  await compileDshEntry({ entry: join(source, 'entry.ts'), sourceRoot: source, portableRoot: source, outfile });
  const bundleText = await readFile(outfile, 'utf8');
  assert.equal(bundleText.includes(f.root.replaceAll('\\', '\\\\')), false, 'bundle must not retain original absolute source path');
  const moved = await mkdtemp(join(tmpdir(), 'dsh-portable-moved-'));
  t.after(() => rm(moved, { recursive: true, force: true }));
  await cp(generated, join(moved, 'generated'), { recursive: true });
  await rm(f.root, { recursive: true, force: true });
  const b = await loadDshTools({ entry: join(moved, 'generated', 'compiled.mjs'), prebundled: true }); t.after(b.dispose);
  assert.deepEqual({ ...(await b.tools[0].execute()).structuredContent }, { asset: 'main asset', nested: 'nested asset', required: 'required asset' });
});

test('unavailable dependencies and unsupported host imports do not trigger installation', async t => {
  const f = await fixture(t, `import nope from 'dsh-bridge-does-not-exist-123';export function apply(){nope()}`);
  await assert.rejects(loadDshTools(f), /Could not resolve/);
  await assert.rejects(readFile(join(f.root, 'package-lock.json')), { code: 'ENOENT' });
  const g = await fixture(t, `import {Agent} from '@deepseek-ai/dsh-agent';export function apply(){new Agent()}`);
  await assert.rejects(loadDshTools(g), /Unsupported DSH host import/);
});

test('schema features outside the supported DSL are rejected instead of erased', async t => {
  for (const parameters of [
    `{x:{type:'string',items:{type:'integer'}}}`,
    `{x:{type:'array',items:{type:'string',required:true}}}`,
    `{x:{type:'string',format:'email'}}`,
  ]) {
    const f = await fixture(t, `import {defineTool} from '@deepseek-ai/dsh-tools';export function apply(ctx){ctx.tools.register(defineTool({name:'invalid_dsl',description:'invalid_dsl',parameters:${parameters},execute:async()=>1}))}`);
    await assert.rejects(loadDshTools(f), /Unsupported DSH schema keyword/);
  }
});
