// Bug: plugins that declare a DSH front end (dsh.client) were all treated as "pure DSH UI" and skipped, even when
// they also register a web search backend, an LLM hook, a tool hook, ... Synthetic sources only; no third party plugin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inspectSource,inspectJs} from '../lib/inspect.mjs';
import {convertToClaude,isPureNativeUi,modelBehaviors} from '../lib/converter-claude.mjs';
import {loadDshHost} from '../lib/dsh-host.mjs';
import {yieldOfficialWebTools,descriptor as webDescriptor,OFFICIAL_WEB_TOOL_NAMES} from '../lib/modules/web.mjs';
import {tempRoot,writeStubTemplates,stubBuildHost} from './claude-package-fixtures.mjs';

const exists=async file=>{try{await fs.access(file);return true;}catch{return false;}};

/** One synthetic source: package.json (with or without dsh.client) + index.js. */
async function writeSource(root,name,body,{client=true}={}){
  const dir=path.join(root,name);
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({name,version:'0.0.1',type:'module',main:'index.js',...(client?{dsh:{client:'./client.js'}}:{})}));
  await fs.writeFile(path.join(dir,'index.js'),body);
  if(client)await fs.writeFile(path.join(dir,'client.js'),'export default {};\n');
  return dir;
}
async function plan(t,name,body,options){
  const root=await tempRoot(t,'native-ui ');
  const dir=await writeSource(root,name,body,options);
  return {root,dir,plan:await inspectSource({root:dir,origin:dir})};
}

// (a) a backend for a DSH service
const WEB_BACKEND=`export const name='backend-web';export const inject=['web'];
export function apply(ctx){ctx.web.registerSearchProvider({id:'synthetic',available:()=>true,search:async()=>({sources:[],truncated:false})});}`;
const LLM_PROVIDER=`export const name='backend-llm';export const inject=['llm'];
export function apply(ctx){ctx.llm.registerAdapter({id:'synthetic'});}`;
// (b) hooks that change model or tool behaviour
const TOOL_HOOK=`export const name='hook-tools';
export function apply(ctx){ctx.on('tools/pre-execute',async(exec,next)=>next());}`;
const LLM_HOOK=`export const name='hook-llm';export const inject=['llm'];
export function apply(ctx){ctx.llm.resolveModelInfo=async()=>({});ctx.on('llm/stream',(options,next)=>next());}`;
const AGENT_HOOK=`export const name='hook-agent';
export function apply(ctx){ctx.on('agent/pre-step',async(step,next)=>next());}`;
// (c) background work: a timer and a local web page
const BACKGROUND=`export const name='background';export const inject=['webServer'];
export function apply(ctx){setInterval(()=>{},1000).unref();ctx.webServer.register({kind:'exact',path:'/x',handler:(req,res)=>res.end('ok')});}`;
// (d) only talks to its own DSH front end
const PANEL=`export const name='panel';export const inject=['webServer'];
export function apply(ctx){setInterval(()=>{},60000).unref();ctx.webServer.register({kind:'exact',path:'/panel/data',handler:(req,res)=>res.end('{}')});
  ctx.on('session/event',()=>{});ctx.systemPrompt.section({name:'panel:note',order:1,text:'x'});}`;
const EMPTY_PANEL=`export const name='empty';export function apply(){}`;

test('inspect: model-behaviour evidence is recorded with kind, name and line',()=>{
  const found=inspectJs(`export function apply(ctx){
    ctx.web.registerFetchProvider({});
    ctx.llm.registerAdapter({});
    ctx.on('tools/post-execute',()=>{});
    ctx.on('agent/pre-step',()=>{});
    ctx.llm.streamWithRegistration=1;
    holder.systemPrompt.section({});
  }`).behaviors;
  assert.deepEqual(found.map(item=>item.kind+':'+item.name),['web-provider:registerFetchProvider','llm-provider:registerAdapter','tool-hook:tools/post-execute','agent-hook:agent/pre-step','llm-hook:streamWithRegistration','prompt-section:systemPrompt.section']);
  assert.deepEqual(found.map(item=>item.line),[2,3,4,5,6,7]);
});

test('inspect: look-alike calls are not evidence (bare function names, unrelated events, UI-only settings)',()=>{
  const found=inspectJs(`function registerProvider(){}
  export function apply(ctx){
    registerProvider('x',{});
    ctx.on('session/event',()=>{});ctx.on('loader/volatile-update',()=>{});
    ctx.llm.registerConfigurableProviders([]);
    ctx.settings.section({});
  }`).behaviors;
  assert.deepEqual(found,[]);
});

test('(a) a DSH front end plus a web search backend or LLM provider is converted, not skipped',async t=>{
  for(const [label,body,kind] of [['a-web',WEB_BACKEND,'web-provider'],['a-llm',LLM_PROVIDER,'llm-provider']]){
    const {plan:p}=await plan(t,label,body);
    assert.equal(p.host.client,true,label);
    assert.ok(modelBehaviors(p).some(item=>item.kind===kind),label);
    assert.equal(isPureNativeUi(p),false,label);
    assert.equal(p.convertible,true,label);
  }
});

test('(b) a DSH front end plus a tool, model or per-step hook is converted, not skipped',async t=>{
  for(const [label,body,kind] of [['b-tools',TOOL_HOOK,'tool-hook'],['b-llm',LLM_HOOK,'llm-hook'],['b-agent',AGENT_HOOK,'agent-hook']]){
    const {plan:p}=await plan(t,label,body);
    assert.ok(modelBehaviors(p).some(item=>item.kind===kind),label);
    assert.equal(isPureNativeUi(p),false,label);
    assert.equal(p.convertible,true,`${label}: must have a host entry to run`);
    assert.ok(p.capabilities.hostRuntime,label);
  }
});

test('(c) background work: without a DSH front end it is not a native-UI plugin; with one, timers and routes alone serve that front end',async t=>{
  const headless=await plan(t,'c-headless',BACKGROUND,{client:false});
  assert.equal(headless.plan.host.client,false);
  assert.equal(isPureNativeUi(headless.plan),false);
  assert.equal(headless.plan.convertible,true);
  assert.ok(headless.plan.issues.some(item=>item.code==='SCHEDULER'));
  const withClient=await plan(t,'c-client',BACKGROUND,{client:true});
  assert.deepEqual(modelBehaviors(withClient.plan),[]);
  assert.equal(isPureNativeUi(withClient.plan),false,'a timer plus webServer routes next to dsh.client is the front end\'s own backend');
});

test('(d) original settings and main pages are retained even without tools',async t=>{
  for(const [label,body] of [['d-panel',PANEL],['d-empty',EMPTY_PANEL]]){
    const {plan:p}=await plan(t,label,body);
    assert.equal(isPureNativeUi(p),false,label);assert.ok(p.host.frontend,label);
  }
  const {plan:p}=await plan(t,'d-panel2',PANEL);
  assert.ok(p.host.behaviors.some(item=>item.kind==='prompt-section'),'the prompt section stays visible as evidence');
  assert.deepEqual(modelBehaviors(p),[],'but it does not count as a behaviour that rescues the plugin');
});

test('isPureNativeUi: tools, skills, commands, MCP and behaviours each rescue a native-UI plugin; a non-native plugin is never pure',()=>{
  const base={host:{client:true,behaviors:[]},issues:[],capabilities:{skills:[],commands:{definitions:[],dynamicRegistrations:[]},mcpServers:{},pythonServers:[],toolRuntime:null}};
  assert.equal(isPureNativeUi(base),true);
  assert.equal(isPureNativeUi({...base,host:{client:true}}),true,'plans from before the behaviour field still work');
  for(const kind of ['web-provider','llm-provider','llm-hook','tool-hook','agent-hook'])assert.equal(isPureNativeUi({...base,host:{client:true,behaviors:[{kind}]}}),false,kind);
  assert.equal(isPureNativeUi({...base,host:{client:true,behaviors:[{kind:'prompt-section'}]}}),true);
  assert.equal(isPureNativeUi({...base,host:{client:false,behaviors:[{kind:'web-provider'}]}}),false);
  assert.equal(isPureNativeUi({...base,issues:[{code:'NATIVE_UI'}],host:{client:false}}),true);
});

test('conversion retains both backend and original frontend, including frontend-focused packages',async t=>{
  const root=await tempRoot(t,'native-ui convert ');
  const templatesDir=await writeStubTemplates(path.join(root,'templates'));
  const web=await writeSource(root,'conv-web',WEB_BACKEND);
  const panel=await writeSource(root,'conv-panel',PANEL);
  const converted=await convertToClaude(web,{outputDir:path.join(root,'out-web'),installDependencies:false,templatesDir,buildClaudeHost:stubBuildHost});
  assert.notEqual(converted.conversion.status,'not-applicable');
  assert.equal(await exists(path.join(root,'out-web','runtime','claude-host.mjs')),true);
  assert.equal(await exists(path.join(root,'out-web','.claude-plugin','plugin.json')),true);
  assert.ok(converted.conversion.notes.some(item=>item.code==='ORIGINAL_UI'));
  assert.equal(converted.plugin.bridgeConfig.features.ui,true);
  const skipped=await convertToClaude(panel,{outputDir:path.join(root,'out-panel'),installDependencies:false,templatesDir,buildClaudeHost:stubBuildHost});
  assert.notEqual(skipped.conversion.status,'not-applicable');
  assert.equal(skipped.plugin.bridgeConfig.features.ui,true);
  assert.equal(await exists(path.join(root,'out-panel','runtime/ui/manifest.json')),true);
  assert.equal(await exists(path.join(root,'out-panel','.claude-plugin')),true);
});

// ---------------------------------------------------------------- web tool name conflict

/** Minimal stand-in for the official tool registry: only the pieces yieldOfficialWebTools touches. */
function fakeRegistry(){
  const data=new Map();
  const tools={
    layers:{global:{tools:{data,get:name=>data.get(name),has:name=>data.has(name)}}},
    register(definition){
      if(data.has(definition.name))throw new Error(`tool "${definition.name}" is already registered`);
      if(definition.invalid)throw new TypeError('invalid definition');
      data.set(definition.name,definition);
      return ()=>{if(data.get(definition.name)===definition)data.delete(definition.name);};
    }
  };
  return {tools,data};
}

test('web tools: a plugin that registers web_fetch replaces the official one instead of failing',()=>{
  const {tools,data}=fakeRegistry(),logs=[];
  const official={name:'web_fetch',official:true},officialSearch={name:'web_search',official:true};
  tools.register(official);tools.register(officialSearch);
  const originalRegister=tools.register;
  const restore=yieldOfficialWebTools(tools,{log:message=>logs.push(message)});
  assert.equal(typeof restore,'function');
  const mine={name:'web_fetch',mine:true};
  tools.register(mine);
  assert.equal(data.get('web_fetch'),mine,'the plugin version wins');
  assert.equal(data.get('web_search'),officialSearch,'unrelated official tools stay');
  assert.deepEqual(logs,['[web] 插件登記了同名工具 web_fetch，官方網頁工具讓位']);
  assert.throws(()=>tools.register({name:'web_fetch',second:true}),/already registered/,'two plugins with the same name still collide');
  assert.equal(data.get('web_fetch'),mine);
  tools.register({name:'unrelated'});
  restore();
  assert.equal(tools.register,originalRegister,'restore puts the original register back');
});

test('web tools: a failing registration puts the official tool back; names outside the official set are untouched',()=>{
  const {tools,data}=fakeRegistry();
  const official={name:'web_search',official:true};
  tools.register(official);
  yieldOfficialWebTools(tools,{log:()=>{}});
  assert.throws(()=>tools.register({name:'web_search',invalid:true}),/invalid definition/);
  assert.equal(data.get('web_search'),official);
  tools.register({name:'custom_a'});
  assert.throws(()=>tools.register({name:'custom_a'}),/already registered/);
});

test('web tools: an unexpected registry shape is reported, not guessed at',()=>{
  assert.equal(yieldOfficialWebTools(undefined),null);
  assert.equal(yieldOfficialWebTools({register(){},layers:{}}),null);
  assert.deepEqual([...OFFICIAL_WEB_TOOL_NAMES],['web_search','web_fetch']);
});

test('web module descriptor has no host version gate',()=>{
  assert.equal(Object.hasOwn(webDescriptor.requires,'minimumCodexVersion'),false);
  assert.deepEqual(webDescriptor.requires.capabilities,['mcp']);
});

const clashing=`import{defineTool}from'@deepseek-ai/dsh-tools';
export const name='clash';export const inject=['tools','web'];
export function apply(ctx){
  ctx.tools.register(defineTool({name:'web_fetch',description:'plugin version',parameters:{},output:{schema:{type:'json'},render:(_,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:async()=>({from:'plugin'})}));
}`;
const quiet=clashing.replace("name:'web_fetch'","name:'plugin_only'");

async function claudeHost(t,source,options={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'web-clash-'));let host;
  t.after(async()=>{await host?.dispose();await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  await fs.writeFile(path.join(dir,'index.mjs'),source);
  host=await loadDshHost({entry:path.join(dir,'index.mjs'),sourceRoot:dir,stateDir:path.join(dir,'state'),initializeTimeoutMs:20000,services:['web'],hostKind:'claude',...options});
  return host;
}

test('claude host: official web_search/web_fetch are present, and a plugin web_fetch starts without "already registered"',async t=>{
  const plain=await claudeHost(t,quiet);
  const names=plain.tools.map(row=>row.name).sort();
  assert.deepEqual(names,['plugin_only','web_fetch','web_search'],'the official web tools are mounted whenever the web service is');
  const diagnostics=(await plain.describe()).moduleDiagnostics??[];
  assert.ok(!diagnostics.some(item=>item.module==='web'&&item.status==='disabled'),JSON.stringify(diagnostics));
  const clash=await claudeHost(t,clashing);
  const row=clash.tools.filter(item=>item.name==='web_fetch');
  assert.equal(row.length,1);
  assert.equal((await row[0].execute({})).structuredContent.from,'plugin','the plugin version is the one that runs');
  assert.ok(clash.tools.some(item=>item.name==='web_search'),'the other official web tool is still there');
});
