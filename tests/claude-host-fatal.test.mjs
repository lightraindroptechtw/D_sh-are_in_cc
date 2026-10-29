import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {makePlugin,spawnHost,toolHeader} from './claude-host-helpers.mjs';
import {describeStartupFailure,sanitizeLine,waitingServices} from '../lib/claude-host/cause.mjs';

async function expectFatal(t,source,settings={}){
  const root=await makePlugin(t,source,settings);
  const host=await spawnHost(t,root);
  const fatal=await host.fatal();
  const exit=await Promise.race([host.exited,new Promise(resolve=>setTimeout(()=>resolve('timeout'),10000))]);
  assert.notEqual(exit,'timeout','the process exits after fatal');assert.equal(exit.code,1);
  assert.equal(host.lines.filter(l=>l.type==='ready').length,0);
  return fatal;
}

test('fatal names the service a plugin is waiting for (Cordis "pending (waiting for service: shell)")',async t=>{
  const fatal=await expectFatal(t,toolHeader+`export const name='needs-shell';export const inject=['tools','shell'];export function apply(ctx){ctx.tools.register(tool('p',async()=>1));}`);
  assert.match(fatal.message,/waiting for service: shell/);
  assert.deepEqual(fatal.services,['shell']);
  assert.ok(fatal.code);
});

test('fatal reports every missing service, not only the first',async t=>{
  const fatal=await expectFatal(t,toolHeader+`export const name='needs-two';export const inject=['tools','shell','subagents'];export function apply(){}`);
  assert.deepEqual([...fatal.services].sort(),['shell','subagents']);
  assert.match(fatal.message,/shell/);assert.match(fatal.message,/subagents/);
});

test('fatal carries the esbuild resolve error with file and line, not a generic sentence',async t=>{
  const fatal=await expectFatal(t,`import x from 'synthetic-package-that-is-not-installed';export const inject=['tools'];export function apply(){x();}`);
  assert.match(fatal.message,/Could not resolve "synthetic-package-that-is-not-installed"/);
  assert.match(fatal.message,/index\.mjs:1:\d+/);
  assert.equal(fatal.code,'SOURCE_DEPENDENCY_MISSING');
});

test('fatal carries the error thrown by the plugin apply()',async t=>{
  const fatal=await expectFatal(t,`export const inject=['tools'];export function apply(){throw new Error('boom in apply');}`);
  assert.match(fatal.message,/boom in apply/);
});

test('fatal reports a missing export of an official package',async t=>{
  const fatal=await expectFatal(t,`import {definitelyMissingExport} from '@deepseek-ai/dsh-tools';export const inject=['tools'];export function apply(){definitelyMissingExport();}`);
  assert.match(fatal.message,/does not provide an export named 'definitelyMissingExport'/);
  assert.equal(fatal.code,'DSH_API_EXPORT_MISSING');
});

test('fatal reports a missing official runtime package by name',async t=>{
  const fatal=await expectFatal(t,`import x from '@deepseek-ai/dsh-not-bundled-here';export const inject=['tools'];export function apply(){x();}`);
  assert.match(fatal.message,/@deepseek-ai\/dsh-not-bundled-here/);
  assert.equal(fatal.code,'HOST_DEPENDENCY_MISSING');
});

test('fatal reports the Cordis reserved-name collision line itself',async t=>{
  const fatal=await expectFatal(t,`export const inject=['tools'];export function apply(ctx){ctx.provide('inject',{});}`);
  assert.match(fatal.message,/property "inject" is already declared as accessor/);
});

test('fatal for an entry without apply is explicit',async t=>{
  const fatal=await expectFatal(t,`export const inject=['tools'];export const notApply=1;`);
  assert.match(fatal.message,/apply/);assert.equal(fatal.code,'UNSUPPORTED_ENTRY');
});

test('fatal message never carries credentials the plugin printed in its error',async t=>{
  const fatal=await expectFatal(t,`export const inject=['tools'];export function apply(){throw new Error('upstream said token=abcdef1234567890SECRET and Authorization: Bearer abcdefghijklmnop1234');}`);
  assert.ok(!/abcdef1234567890SECRET/.test(fatal.message));assert.ok(!/abcdefghijklmnop1234/.test(fatal.message));
  assert.match(fatal.message,/redacted/);
});

test('fatal when runtime/settings.json is missing or has no entry',async t=>{
  const empty=await fs.mkdtemp(path.join(os.tmpdir(),'claude-host-empty-'));t.after(()=>fs.rm(empty,{recursive:true,force:true}).catch(()=>{}));
  const missing=await (await spawnHost(t,empty)).fatal();
  assert.equal(missing.code,'SETTINGS_UNREADABLE');
  const root=await makePlugin(t,'export function apply(){}',{entry:''});
  const noEntry=await (await spawnHost(t,root)).fatal();
  assert.equal(noEntry.code,'SETTINGS_INVALID');assert.match(noEntry.message,/entry/);
});

test('describeStartupFailure: cause ranking and Cordis stderr parsing (pure)',()=>{
  const logs='dsh-codex-host: warning: 1 entry did not activate\nplugin-a (cordis:target): pending (waiting for service: shell, subagents)\n';
  assert.deepEqual(waitingServices(logs),['shell','subagents']);
  const pending=describeStartupFailure(Object.assign(new Error('Plugin did not activate in the real DSH host (entry a, state 0)'),{code:'HOST_PLUGIN_INACTIVE'}),logs);
  assert.match(pending.message,/waiting for service: shell, subagents/);assert.equal(pending.code,'HOST_PLUGIN_INACTIVE');
  assert.deepEqual(pending.services,['shell','subagents']);
  const thrown=describeStartupFailure(new Error('x'),'t (cordis:target): TypeError: ctx.nope is not a function\n    at foo');
  assert.equal(thrown.message,'TypeError: ctx.nope is not a function');
  const reserved=describeStartupFailure(new Error('Plugin did not activate'),'warn\nx (cordis:target): Error: property "emit" is already declared as accessor\n');
  assert.match(reserved.message,/^property "emit" is already declared as accessor/);
  const built=describeStartupFailure(new Error('Build failed with 1 error:\nC:/a/b/c.mjs:3:9: ERROR: Could not resolve "zzz"'),'');
  assert.equal(built.message,'Could not resolve "zzz" (c.mjs:3:9)');
  assert.equal(describeStartupFailure(new Error('plain failure\nsecond line'),'').message,'plain failure');
  assert.match(describeStartupFailure(undefined,'').message,/no cause reported/);
});

test('sanitizeLine strips colors, collapses whitespace and bounds length',()=>{
  assert.equal(sanitizeLine('\u001b[31mred\u001b[0m   text'),'red text');
  assert.equal(sanitizeLine('x'.repeat(2000),50).length,50);
  assert.match(sanitizeLine('api_key="sk-abcdefghijklmnopqrstuvwxyz"'),/redacted/);
});
