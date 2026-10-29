// Port of the Codex official-service tests. Claude Code keeps credentials read-only (environment variables), so the Codex
// credential-store, credential-record and redaction tests are replaced by a metadata-only check on the Claude Code service.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRemoteServices} from '../ui/remote.mjs';
import {dispatchOfficialUiCall} from '../lib/ui-official-services.mjs';
import {createClaudeCredentialsService} from '../lib/modules/claude/credentials.mjs';

test('browser credential calls expose metadata only and never write: Claude Code credentials are read-only environment variables',async t=>{
  const secret='synthetic-ui-key-123456',ctx={get:name=>name==='credentials'?createClaudeCredentialsService({env:{DEMO_KEY:secret}}):undefined};
  const {remote,dispose}=createRemoteServices({rpc:async(method,{channel,endpoint,payload})=>{assert.equal(channel,'/api');const [namespace,operation]=endpoint.split('/');return dispatchOfficialUiCall({ctx,namespace,method:operation,args:payload.args});}});t.after(dispose);
  const described=await remote.credentials.describe(['DEMO_KEY','NOT_SET']);
  assert.deepEqual(described.value,{DEMO_KEY:{configured:true,writable:false,source:'env'},NOT_SET:{configured:false,writable:false}});
  assert.ok(!JSON.stringify(described).includes(secret));
  const written=await remote.credentials.set('DEMO_KEY','other-value');assert.equal(written.ok,false);assert.ok(!JSON.stringify(written).includes('other-value'));
  const cleared=await remote.credentials.unset('DEMO_KEY');assert.equal(cleared.ok,false);
  assert.equal((await dispatchOfficialUiCall({ctx:{get:()=>undefined},namespace:'credentials',method:'describe',args:{refs:['DEMO_KEY']}})).error.code,'gateway/unavailable');
});

test('official settings keeps original revisions, redaction and write results',async()=>{
  let revision=2,value={title:'before'},redacted=false;
  const settings={writable:true,describe(options){redacted=options.redactSecrets;return [{ns:'demo',value:{...value},revision,secrets:[{path:['key'],set:true}],private:'must not cross wire'}];},async update(ns,patch,expected){assert.equal(ns,'demo');if(expected!==revision)throw Object.assign(Error('changed'),{code:'SETTINGS_CONFLICT'});value={...value,...patch};revision++;}};
  const ctx={get:name=>name==='settings'?settings:undefined};
  const read=await dispatchOfficialUiCall({ctx,namespace:'settings',method:'describe'});assert.equal(redacted,true);assert.equal(read.value.namespaces[0].private,undefined);
  const changed=await dispatchOfficialUiCall({ctx,namespace:'settings',method:'update',args:{ns:'demo',patch:{title:'after'},expectedRevision:2}});
  assert.equal(changed.value.value.title,'after');assert.equal(changed.value.revision,3);
  const stale=await dispatchOfficialUiCall({ctx,namespace:'settings',method:'update',args:{ns:'demo',patch:{title:'lost'},expectedRevision:2}});assert.equal(stale.error.code,'settings/conflict');assert.equal(value.title,'after');
  assert.equal(await dispatchOfficialUiCall({ctx,namespace:'settings',method:'internalDeleteEverything'}),undefined);
  assert.equal(await dispatchOfficialUiCall({ctx,namespace:'credentials',method:'resolve'}),undefined);
});

test('official command bridge invokes the registered global handler and reports unsupported attachment receipts',async()=>{
  const calls=[],commands={list:async()=>[{name:'local-probe'}],find:(_agent,name)=>name==='local-probe'?{handler:async request=>{calls.push(request.rawInput);return {kind:'success',text:'ran'+request.rawInput};}}:undefined};
  const ctx={get:name=>name==='commands'?commands:undefined};
  const result=await dispatchOfficialUiCall({ctx,namespace:'commands',method:'execute',args:{line:'/local-probe actual text',submittedAttachments:[]}});
  assert.equal(result.ok,true);assert.equal(result.value.result.text,'ran actual text');assert.deepEqual(calls,[' actual text']);
  const unavailable=await dispatchOfficialUiCall({ctx,namespace:'commands',method:'execute',args:{line:'/local-probe x',submittedAttachments:[{type:'file',receiptId:'unmapped'}]}});
  assert.equal(unavailable.ok,false);assert.equal(calls.length,1);
});

test('opening the settings document is reported as unsupported, not pretended',async()=>{
  const ctx={get:name=>name==='settings'?{writable:true,prepareDocument:async()=>'file.yml',describe:()=>[]}:undefined};
  const result=await dispatchOfficialUiCall({ctx,namespace:'settings',method:'openSettingsDocument'});
  assert.equal(result.ok,false);assert.equal(result.error.code,'gateway/unsupported');
});

test('conversation namespaces are not served by the official-service dispatcher',async()=>{
  const ctx={get:()=>({list:()=>[]})};
  for(const namespace of ['sessions','currentConversation','conversation'])assert.equal(await dispatchOfficialUiCall({ctx,namespace,method:'list'}),undefined,namespace);
});
