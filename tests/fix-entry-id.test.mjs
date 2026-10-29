// Converter bug 4: a scoped package name (@copylee/dsh-office) was used as the loader entry id,
// which must match /^[A-Za-z0-9_.-]+$/, and the host failed with "Plugin entry id is invalid".
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {entryIdFor,ENTRY_ID_PATTERN} from '../lib/entry-id.mjs';
import {loadDshHost} from '../lib/dsh-host.mjs';

test('entryIdFor: scoped names become scope-name; valid names are untouched',()=>{
  assert.equal(entryIdFor('@copylee/dsh-office'),'copylee-dsh-office');
  assert.equal(entryIdFor('@scope/name'),'scope-name');
  assert.equal(entryIdFor('@mall/plugin.mall_v2'),'mall-plugin.mall_v2');
  assert.equal(entryIdFor('dsh-plugin-finance-data'),'dsh-plugin-finance-data');
  assert.equal(entryIdFor('Plain_name.1'),'Plain_name.1');
});

test('entryIdFor: every result is a legal id, whatever the input',()=>{
  for(const input of ['@a/b/c','@/x','@@@','名稱','a b c','../evil','x'.repeat(300),'@scope/名稱','',undefined,null,42,'-.-']){
    const id=entryIdFor(input);
    assert.match(id,ENTRY_ID_PATTERN,String(input));assert.ok(!id.includes('/')&&!id.includes('\\'));
    // Names that already are legal ids pass through untouched; everything rewritten stays short.
    if(typeof input==='string'&&ENTRY_ID_PATTERN.test(input))assert.equal(id,input);else assert.ok(id.length<=110);
  }
  assert.equal(entryIdFor(undefined),'target-plugin');
  assert.match(entryIdFor('名稱'),/^source-[0-9a-f]+$/,'a name with no usable characters falls back to a fingerprint, never to an empty id');
  assert.notEqual(entryIdFor('名稱'),entryIdFor('別名'));
});

async function load(t,source,options={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fix-entry-id-'));let host;
  t.after(async()=>{await host?.dispose();await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  await fs.writeFile(path.join(dir,'index.mjs'),source);
  host=await loadDshHost({entry:path.join(dir,'index.mjs'),sourceRoot:dir,stateDir:path.join(dir,'state'),initializeTimeoutMs:15000,services:[],...options});
  return host;
}
const body=name=>`import{defineTool}from'@deepseek-ai/dsh-tools';export const name=${JSON.stringify(name)};export const inject=['tools'];export function apply(ctx){ctx.tools.register(defineTool({name:'id_probe',description:'p',parameters:{},output:{schema:{type:'json'},render:(_,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:async()=>({ok:true})}));}`;

test('host: a plugin whose package name is scoped starts, in both Codex and Claude mode, under the id scope-name',async t=>{
  for(const hostKind of [undefined,'claude']){
    const host=await load(t,body('@copylee/dsh-office'),hostKind?{hostKind}:{});
    const entries=(await host.describe()).entries;
    assert.ok(entries.some(entry=>entry.id==='copylee-dsh-office'&&entry.active),JSON.stringify(entries));
    assert.equal((await host.tools[0].execute({})).structuredContent.ok,true);
  }
});

test('host: an explicit entryId option written as a scoped name is normalised the same way',async t=>{
  const host=await load(t,body('anything'),{entryId:'@plugin-mall/mall',hostKind:'claude'});
  assert.ok((await host.describe()).entries.some(entry=>entry.id==='plugin-mall-mall'&&entry.active));
});

test('host: a name that collides with a bridge service id is still refused, not silently renamed',async t=>{
  await assert.rejects(load(t,body('bridge-modules')),{code:'INVALID_CONFIGURATION'});
});
