import test from 'node:test';
import assert from 'node:assert/strict';
import {claudePluginName,claudeSkillDirName,claudePluginVersion,renderPluginManifest,renderRegisterModule,NAME_PATTERN} from '../lib/claude-package.mjs';

test('plugin name: scope becomes prefix, dsh- prefix added, characters normalized',()=>{
  assert.equal(claudePluginName('@acme/Synthetic Tools'),'dsh-acme-synthetic-tools');
  assert.equal(claudePluginName('dsh-plugin-finance-data'),'dsh-plugin-finance-data');
  assert.equal(claudePluginName('finance_data.v2'),'dsh-finance-data-v2');
  assert.equal(claudePluginName('@dsh/ledger'),'dsh-ledger');
  assert.equal(claudePluginName('dsh'),'dsh-plugin');
  assert.equal(claudePluginName('中文名稱'),'dsh-converted');
  assert.equal(claudePluginName(undefined),'dsh-converted');
});

test('plugin name is deterministic, valid and at most 64 characters, long names stay distinct',()=>{
  const a='@scope/'+'a'.repeat(100),b='@scope/'+'a'.repeat(99)+'b';
  const na=claudePluginName(a),nb=claudePluginName(b);
  assert.equal(na,claudePluginName(a));
  assert.ok(na.length<=64&&nb.length<=64);
  assert.match(na,NAME_PATTERN);
  assert.notEqual(na,nb);
  for(const sample of ['x','A--B','__a__','@a/b/c','dsh-','-dsh-x-'])assert.match(claudePluginName(sample),NAME_PATTERN);
});

test('skill directory names and versions',()=>{
  assert.equal(claudeSkillDirName('Probe Skill'),'probe-skill');
  assert.equal(claudeSkillDirName('///'),'skill');
  assert.ok(claudeSkillDirName('x'.repeat(100)).length<=64);
  assert.equal(claudePluginVersion('1.2.3'),'1.2.3');
  assert.equal(claudePluginVersion('1.2.3-rc.1'),'1.2.3-rc.1');
  assert.equal(claudePluginVersion('latest'),'0.1.0');
  assert.equal(claudePluginVersion(null),'0.1.0');
});

test('manifest placeholders are replaced with JSON-safe values',()=>{
  const template=JSON.stringify({name:'__DSH_PLUGIN_NAME__',version:'__DSH_PLUGIN_VERSION__',description:'__DSH_PLUGIN_DESCRIPTION__',userConfig:{}});
  const {manifest,text}=renderPluginManifest(template,{name:'dsh-x',version:'1.0.0',description:'He said "hi"\nnew line \\ and $& $1'});
  assert.equal(manifest.description,'He said "hi"\nnew line \\ and $& $1');
  assert.doesNotMatch(text,/__DSH_/);
  assert.throws(()=>renderPluginManifest('{"name":"fixed","version":"__DSH_PLUGIN_VERSION__","description":"d"}',{name:'dsh-x',version:'1.0.0',description:'d'}),/__DSH_PLUGIN_NAME__/);
  assert.throws(()=>renderPluginManifest('{"name":"__DSH_PLUGIN_NAME__","other":"__DSH_UNKNOWN__"}',{name:'dsh-x',version:'1.0.0',description:'d'}),/未知的佔位字串/);
  assert.throws(()=>renderPluginManifest('not json __DSH_PLUGIN_NAME__',{name:'dsh-x',version:'1.0.0',description:'d'}),/合法 JSON/);
});

test('register.ts placeholder (with quotes) becomes a JSON literal, replacement patterns are not interpreted',()=>{
  const template='const config = "__DSH_BRIDGE_CONFIG__";\nexport {};\n';
  const config={schemaVersion:1,pluginName:'dsh-x',staticTools:[{dshName:'a',description:'costs $& and $1 and `tick` and */ end  '}]};
  const text=renderRegisterModule(template,config);
  assert.doesNotMatch(text,/__DSH_BRIDGE_CONFIG__/);
  const literal=text.slice('const config = '.length,text.indexOf(';\nexport'));
  assert.deepEqual(JSON.parse(literal),config);
  assert.throws(()=>renderRegisterModule('const config = {};',config),/找不到/);
  // 沒有引號的佔位字串不算數。
  assert.throws(()=>renderRegisterModule('const config = __DSH_BRIDGE_CONFIG__;',config),/找不到/);
});
