import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {scanSecurity,classifyOutbound,isSecretName,looksLikeSecretValue,configSecretPaths,redactSnippet,obfuscationMetrics,judgeObfuscation,secretOptionsFromScan,serviceFromEnvName,renderSecurityMarkdown} from '../lib/security-scan.mjs';
import {writeRiskySource,writeObfuscatedSource,obfuscatedText,minifiedText,FAKE_SECRET} from './security-scan-fixtures.mjs';

const bin=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','bin','d-sh-are-in-cc.mjs');
let root,source,scan;
before(async()=>{
  root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh scan '));
  source=await writeRiskySource(root);
  scan=await scanSecurity(source);
});
after(()=>fs.rm(root,{recursive:true,force:true}));
const at=(list,predicate)=>list.find(predicate);

test('processes: program names from literals, constants, shell strings, require(), Bun, Deno, MCP config; unknown program kept with its expression',()=>{
  const programs=scan.summary.programs;
  for(const name of ['python','cloudflared','uv','git','ffmpeg','node','uvx'])assert.ok(programs.includes(name),name);
  const python=at(scan.processes,item=>item.program==='python'&&item.path==='index.js');
  assert.equal(python.line,13);
  assert.equal(python.api,'child_process.spawn');
  const shell=at(scan.processes,item=>item.program==='cloudflared');
  assert.equal(shell.shell,true);
  const unknown=at(scan.processes,item=>item.path==='index.js'&&item.program===null);
  assert.equal(unknown.expression,'anything');
  assert.ok(scan.summary.unknownPrograms>=1);
  assert.ok(at(scan.processes,item=>item.path==='cordis.patch.yml'&&item.program==='uvx'));
  // 測試檔和 node_modules 不算進摘要
  assert.ok(!programs.includes('rm'));
  assert.ok(!programs.includes('evil'));
  assert.ok(!scan.processes.some(item=>item.path.startsWith('node_modules')));
  assert.equal(scan.files.bundledDependencies.packages.includes('dep'),true);
  assert.ok(scan.files.bundledDependencies.files>=2);
});

test('files: home directory, absolute path, .. escape and writes are flagged; a plain relative read is not',()=>{
  const home=at(scan.fileAccess,item=>item.api.endsWith('writeFileSync'));
  assert.deepEqual(home.flags.sort(),['home','write']);
  const abs=at(scan.fileAccess,item=>item.target==="'/etc/hosts'");
  assert.deepEqual(abs.flags,['absolute']);
  const parent=at(scan.fileAccess,item=>item.api.endsWith('.rm'));
  assert.deepEqual(parent.flags.sort(),['delete','parent']);
  const plain=at(scan.fileAccess,item=>item.target==="'local.txt'");
  assert.deepEqual(plain.flags,[]);
  assert.ok(scan.summary.writesFiles);
  assert.ok(scan.homeReferences.some(item=>item.kind==='os.homedir'));
});

test('network: fetch, https.request, WebSocket, axios with domains; client code and Python are separate contexts',()=>{
  for(const domain of ['api.example-search.com','hooks.slack.com','stream.example.io','api.example-bar.com','api.example-video.com'])assert.ok(scan.summary.domains.includes(domain),domain);
  const client=at(scan.network,item=>item.domain==='cdn.example-client.com');
  assert.equal(client.context,'client');
  assert.ok(!scan.summary.domains.includes('cdn.example-client.com'));
  assert.equal(at(scan.network,item=>item.domain==='api.example-video.com').context,'python');
});

test('secrets: process.env, destructuring, patch !!js and Python os.environ names; MAX_TOKENS, PATH and *_ID are not secrets; values never stored',()=>{
  assert.deepEqual(scan.summary.secretNames,['AGENTMAIL_API_KEY','BILI_SESSDATA','GITHUB_TOKEN','TAVILY_API_KEY']);
  for(const name of ['PATH','MAX_TOKENS','AGENTMAIL_INBOX_ID','TAVILY_API_KEY'])assert.ok(scan.summary.environmentNames.includes(name),name);
  assert.deepEqual(scan.summary.credentialRefs,['my-service-ref']);
  assert.equal(scan.summary.usesCredentialService,true);
  assert.equal(scan.secrets.hardcoded.length,1);
  assert.equal(scan.secrets.hardcoded[0].name,'API_KEY');
  assert.equal(scan.summary.passesWholeEnvironment,true);
  assert.ok(!JSON.stringify(scan).includes(FAKE_SECRET),'secret value leaked into the scan result');
  assert.ok(!renderSecurityMarkdown(scan).includes(FAKE_SECRET));
});

test('outbound tools: positive and negative cases, wrapper registration, commands excluded, Python MCP tools reported separately',()=>{
  const byName=Object.fromEntries(scan.tools.map(item=>[item.name,item]));
  assert.equal(byName.post_comment.outbound,true);
  assert.equal(byName.post_comment.kind,'comment');
  assert.deepEqual(byName.post_comment.targetFields,['bvid']);
  assert.deepEqual(byName.post_comment.textFields,['text']);
  assert.equal(byName.send_email.outbound,true);
  assert.equal(byName.send_email.kind,'email');
  assert.equal(byName.send_email.path,'lib/wrapped.js');
  assert.deepEqual(byName.send_email.targetFields,['to']);
  assert.deepEqual(byName.send_email.textFields.sort(),['body','subject']);
  assert.equal(byName.send_draft.outbound,true);
  assert.equal(byName.video_feedback.outbound,true);
  assert.equal(byName.video_feedback.confidence,'description');
  for(const name of ['search_comments','create_draft','nas_reboot','get_messages','wecom_notify_group'])assert.equal(byName[name].outbound,false,name);
  assert.ok(!byName['send-report'],'command registration must not be treated as a tool');
  const py=Object.fromEntries(scan.internalTools.map(item=>[item.name,item]));
  assert.equal(py.send_message.outbound,true);
  assert.deepEqual(py.send_message.targetFields,['receiver_uid']);
  assert.equal(py.search_videos.outbound,false);
  assert.deepEqual(scan.summary.internalOutboundToolNames,['send_message']);
});

test('outbound overrides: --outbound-tool adds (even unknown names), --not-outbound-tool removes',async()=>{
  const fixed=await scanSecurity(source,{outboundTool:['wecom_notify_group','ghost_tool'],notOutboundTool:['video_feedback']});
  const byName=Object.fromEntries(fixed.tools.map(item=>[item.name,item]));
  assert.equal(byName.wecom_notify_group.outbound,true);
  assert.equal(byName.wecom_notify_group.decidedBy,'user');
  assert.deepEqual(byName.wecom_notify_group.textFields,['text']);
  assert.equal(byName.ghost_tool.outbound,true);
  assert.equal(byName.video_feedback.outbound,false);
});

test('classifyOutbound: Bilibili-like and common names',()=>{
  const yes=[['bili_reply','在视频下发评论（或回复某条评论）'],['bili_send_message','给B站用户发送私信'],['agentmail_reply',''],['tweet',''],['create_issue','Open a GitHub issue'],['publish_post',''],['notify_feishu','推送到飞书群：把结果发出去']];
  const no=[['bili_search','搜 B站 视频'],['bili_subtitle','取一个视频的字幕全文'],['bili_comments','取一个视频的热门评论（含点赞/回复数）'],['team_mail_ack','mailbox ack'],['cancel_scheduled_message',''],['crossfire_attack','Send in the red team: spawn experts'],['diff_approval_annotate','Annotate lines: they can reply to it there'],['ask_model','Send a prompt to the model'],['list_threads','']];
  for(const [name,description]of yes)assert.equal(classifyOutbound({name,description}).outbound,true,name);
  for(const [name,description]of no)assert.equal(classifyOutbound({name,description}).outbound,false,name);
  assert.equal(classifyOutbound({name:'agentmail_reply'}).kind,'email');
  assert.equal(classifyOutbound({name:'send_chat_message',description:'推送到 Telegram / Email 等'}).kind,'message');
});

test('obfuscation: _0x identifiers and while(!![]) are obfuscated; a long minified line is not',()=>{
  const bad=judgeObfuscation(obfuscationMetrics(obfuscatedText()));
  assert.equal(bad.obfuscated,true);
  assert.ok(bad.reasons.some(item=>/_0x/.test(item)));
  const minified=judgeObfuscation(obfuscationMetrics(minifiedText()));
  assert.equal(minified.obfuscated,false);
  assert.equal(minified.minified,true);
  const normal=judgeObfuscation(obfuscationMetrics('const a = 1;\nfunction b(x) { return x + a; }\n'));
  assert.equal(normal.obfuscated,false);
  assert.equal(normal.minified,false);
  assert.equal(scan.summary.obfuscated,false);
});

test('obfuscated plugin: summary marks it unreviewable with the file',async()=>{
  const dir=await writeObfuscatedSource(root);
  const result=await scanSecurity(dir);
  assert.equal(result.summary.obfuscated,true);
  assert.equal(result.summary.verdict,'unreviewable');
  assert.deepEqual(result.summary.obfuscatedFiles,['lib/core.js']);
});

test('other languages: listed with whether they are referenced; install scripts and patch MCP commands reported',()=>{
  const py=at(scan.otherLanguages,item=>item.path==='mcp_server.py');
  assert.equal(py.executedLikely,true);
  assert.ok(py.referencedBy.includes('index.js'));
  const sh=at(scan.otherLanguages,item=>item.path==='scripts/unused.sh');
  assert.equal(sh.executedLikely,false);
  assert.match(sh.executed,/假說/);
  assert.deepEqual(scan.summary.installScripts,['postinstall']);
});

test('helpers: secret names and values, --config paths, snippet redaction, env service names, secret options',()=>{
  for(const name of ['TAVILY_API_KEY','GITHUB_TOKEN','apiKey','DB_PASSWORD','BILI_SESSDATA','ZCODE_CREDENTIAL_SECRET'])assert.equal(isSecretName(name),true,name);
  for(const name of ['PATH','PWD','MAX_TOKENS','KEYWORDS','TOKEN_URL','AGENTMAIL_INBOX_ID','apiKeyEnv','DSH_AUTH_DEBUG_STREAM','SESSION_TTL_DAYS'])assert.equal(isSecretName(name),false,name);
  assert.equal(looksLikeSecretValue(FAKE_SECRET),true);
  assert.equal(looksLikeSecretValue('dsh-auto-memory.presentation.v1'),false);
  assert.equal(looksLikeSecretValue('https://example.com/a/b'),false);
  assert.deepEqual(configSecretPaths({web:{apiKey:'abc'},nested:[{token:'x'}],name:'demo',opaque:FAKE_SECRET,fromEnv:{apiKey:'${TAVILY}'}}).map(item=>item.path),['web.apiKey','nested.0.token','opaque']);
  assert.doesNotMatch(redactSnippet(`fetch(u,{headers:{a:'${FAKE_SECRET}'}})`),new RegExp(FAKE_SECRET));
  assert.match(redactSnippet("x='https://api.example.com/v1/a1b2c3d4e5f6g7h8i9'"),/https:/);
  assert.equal(serviceFromEnvName('TAVILY_API_KEY'),'Tavily');
  assert.equal(serviceFromEnvName('API_KEY'),null);
  const options=secretOptionsFromScan(scan,{displayName:'risky-plugin'});
  const tavily=options.find(item=>item.env==='TAVILY_API_KEY');
  assert.equal(tavily.option,'secret_TAVILY_API_KEY');
  assert.match(tavily.title,/Tavily/);
  assert.match(tavily.features,/post_comment/);
  assert.equal(tavily.required,false);
});

test('CLI scan: JSON output without converting or installing; package-dir outside the source is refused',async()=>{
  const result=spawnSync(process.execPath,[bin,'scan',source],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const data=JSON.parse(result.stdout);
  assert.equal(data.engine,'fixed-rules');
  assert.equal(data.modelCalls,0);
  assert.ok(data.summary.outboundToolNames.includes('post_comment'));
  const override=spawnSync(process.execPath,[bin,'scan',source,'--not-outbound-tool','post_comment','--outbound-tool','wecom_notify_group'],{encoding:'utf8'});
  const fixed=JSON.parse(override.stdout);
  assert.ok(!fixed.summary.outboundToolNames.includes('post_comment'));
  assert.ok(fixed.summary.outboundToolNames.includes('wecom_notify_group'));
  const bad=spawnSync(process.execPath,[bin,'scan',source,'--package-dir','..'],{encoding:'utf8'});
  assert.equal(bad.status,1);
  await assert.rejects(scanSecurity(source,{packageDir:'../..'}),/子目錄/);
});
