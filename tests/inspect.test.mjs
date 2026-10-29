import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inspectSource,headerExpression,inspectJs,parsePatch} from '../lib/inspect.mjs';

async function fixture(t,pkg={},files={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh inspect '));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const [file,content]of Object.entries({'package.json':JSON.stringify({name:'sample',...pkg}),...files})){
    const target=path.join(root,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,typeof content==='string'?content:JSON.stringify(content));
  }
  return {root,inspect:()=>inspectSource({root})};
}
const mcp=(id,config)=>({id,name:'@deepseek-ai/dsh-mcp-client',config});
const tool=name=>`export function apply(ctx){ctx.tools.register({name:'${name}',description:'Test',execute(){return 1}})}`;

test('published JavaScript bundles larger than 512 KiB still expose their real tool registrations',async t=>{
  const f=await fixture(t,{main:'lib/index.js'},{'lib/index.js':'/*'+'x'.repeat(600*1024)+'*/\n'+tool('large-bundle-tool')});
  const result=await f.inspect();
  assert.equal(result.convertible,true);
  assert.deepEqual(result.capabilities.toolRuntime.tools.map(x=>x.name),['large-bundle-tool']);
  assert.ok(!result.issues.some(x=>x.code==='JS_ANALYSIS_LIMIT'));
});

test('oversized reachable JavaScript is reported as unanalysed rather than silently treated as empty',async t=>{
  const f=await fixture(t,{main:'index.js'},{'index.js':"import './oversized.js';",'oversized.js':'/*'+'x'.repeat(8*1024*1024)+'*/\n'+tool('not-analysed')});
  const result=await f.inspect();
  assert.ok(result.issues.some(x=>x.code==='JS_ANALYSIS_LIMIT'&&x.path==='oversized.js'));
  assert.equal(result.capabilities.toolRuntime,null);
  await fs.writeFile(path.join(f.root,'index.js'),tool('small'));
  const unrelated=await f.inspect();
  assert.equal(unrelated.convertible,true);
  assert.ok(!unrelated.issues.some(x=>x.code==='JS_ANALYSIS_LIMIT'));
});

test('ordered patch files apply id overrides and replace config wholesale',async t=>{
  const f=await fixture(t,{dsh:{bundle:{patch:['base.yml','override.yml']}}},{
    'base.yml':[{insert:[{id:'self',name:'sample',config:{keep:1,removed:2}},mcp('remote',{serverName:'old',transport:'stdio',command:'node',args:['old.js'],env:{OLD:'yes'}})]}],
    'override.yml':[{id:'self',name:'sample',config:{keep:3}},{id:'remote',config:{serverName:'new',transport:'stdio',command:'new-node'}}],
  });
  const r=await f.inspect();
  assert.deepEqual(r.defaultConfig,{keep:3});
  assert.deepEqual(Object.keys(r.capabilities.mcpServers),['new']);
  assert.deepEqual(r.capabilities.mcpServers.new,{command:'new-node',args:[]});
});

test('row discovery never interprets unrelated config objects as Cordis rows',async t=>{
  const f=await fixture(t,{dsh:{bundle:{patch:'p.yml'}}},{'p.yml':[{insert:[{id:'outer',name:'sample',config:{nested:mcp('fake',{transport:'stdio',command:'do-not-run'})}}]}]});
  const r=await f.inspect();assert.deepEqual(r.capabilities.mcpServers,{});assert.equal(r.convertible,false);
});

test('group insertions and disabled id overrides affect only real rows',async t=>{
  const f=await fixture(t,{dsh:{bundle:{patch:'p.yml'}}},{'p.yml':[{insert:[{id:'g',name:'cordis:group',group:true,config:[mcp('a',{transport:'stdio',command:'one'})]}]},{id:'g',insert:[mcp('b',{transport:'stdio',command:'two'})]},{id:'a',disabled:true}]});
  const r=await f.inspect();assert.deepEqual(Object.keys(r.capabilities.mcpServers),['b']);
});

test('group config replacement normalizes only the replacement children',async t=>{
  const f=await fixture(t,{dsh:{bundle:{patch:'p.yml'}}},{'p.yml':[{insert:[{id:'g',name:'cordis:group',config:[mcp('a',{transport:'stdio',command:'old'})]}]},{id:'g',config:[mcp('a',{transport:'stdio',command:'replacement'})]}]});
  const r=await f.inspect();assert.equal(r.capabilities.mcpServers.a.command,'replacement');assert.equal(r.issues.length,0);
});

test('name assertions do not rename existing rows and unknown overrides stay unmounted',async t=>{
  const f=await fixture(t,{dsh:{bundle:{patch:'p.yml'}}},{'p.yml':[{insert:[mcp('a',{transport:'stdio',command:'one'})]},{id:'a',name:'other',config:{command:'evil'}},{id:'missing',name:'@deepseek-ai/dsh-mcp-client',config:{transport:'stdio',command:'evil'}}]});
  const r=await f.inspect();assert.equal(r.capabilities.mcpServers.a.command,'one');assert.equal(Object.keys(r.capabilities.mcpServers).length,1);assert.ok(r.issues.some(i=>i.code==='PATCH_NAME_ASSERTION'));assert.ok(r.issues.some(i=>i.code==='PATCH_TARGET'));
});

test('MCP timeouts preserve milliseconds and every unsupported config field is reported',async t=>{
  const f=await fixture(t,{dsh:{bundle:{patch:'p.yml'}}},{'p.yml':[{insert:[mcp('a',{transport:'stdio',command:'node',cwd:'./server',toolCallTimeoutMs:120001,failOnStartupError:true,reconnect:{enabled:true},maxInstructionBytes:1234,futureField:true})]}]});
  const r=await f.inspect(),server=r.capabilities.mcpServers.a;
  assert.equal(server.tool_timeout_sec,120.001);assert.equal(server.cwd,'./server');
  for(const field of ['failOnStartupError','reconnect','maxInstructionBytes','futureField'])assert.ok(r.issues.some(i=>i.field===field),field);
  assert.equal(server.failOnStartupError,undefined);assert.equal(r.status,'partial');
});

test('optional environment headers remain optional proxy metadata, without evaluating code',async t=>{
  const f=await fixture(t,{dsh:{bundle:{patch:'p.yml'}}},{'p.yml':`- insert:\n    - id: remote\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: streamable-http\n        url: https://example.test/mcp\n        headers: !!js 'process.env.API_KEY ? { "x-api-key": process.env.API_KEY } : {}'\n`});
  const r=await f.inspect(),server=r.capabilities.mcpServers.remote;
  assert.deepEqual(server._optionalEnvHeaders,{'x-api-key':'API_KEY'});assert.equal(server.env_http_headers,undefined);assert.ok(r.issues.some(i=>i.code==='OPTIONAL_ENV_HEADER'));
  assert.equal(headerExpression('process.env.KEY ? {x:process.env.KEY} : {...danger()}'),null);
  assert.equal(headerExpression('process.env.KEY ? {[danger()]:process.env.KEY} : {}'),null);
  assert.equal(headerExpression('process.env.KEY ? {x:process.env.KEY} : {}); danger(); ('),null);
});

test('unknown dynamic command/header values and SSE never produce usable connections',async t=>{
  const f=await fixture(t,{dsh:{bundle:{patch:'p.yml'}}},{'p.yml':`- insert:\n    - id: dynamic\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: stdio\n        command: !!js 'process.execPath'\n    - id: headers\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: streamable-http\n        url: https://example.test/mcp\n        headers: !!js 'danger()'\n    - id: sse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: sse\n        url: https://example.test/sse\n`});
  const r=await f.inspect();assert.deepEqual(r.capabilities.mcpServers,{});assert.equal(r.convertible,false);assert.ok(r.issues.some(i=>i.code==='SSE_TRANSPORT'));assert.ok(r.issues.some(i=>i.code==='UNSUPPORTED_EXPRESSION'));
});

test('native MCP JSON rejects unsupported transport instead of deleting type',async t=>{
  const f=await fixture(t,{}, {'.mcp.json':{mcpServers:{sse:{type:'sse',url:'https://example.test/sse'},ok:{type:'stdio',command:'node',args:[],unknownFlag:1}}}});
  const r=await f.inspect();assert.deepEqual(Object.keys(r.capabilities.mcpServers),['ok']);assert.ok(r.issues.some(i=>i.field==='unknownFlag'));assert.ok(r.issues.some(i=>i.code==='SSE_TRANSPORT'));
});

test('skill default selection runs before convertible/status and preserves manifest diagnostics',async t=>{
  const f=await fixture(t,{}, {'skills/a/SKILL.md':'---\nname: a\ndescription: Skill A\n---\nRead.','skills.manifest.json':{default:[]}});
  const r=await f.inspect();assert.equal(r.capabilities.skills.length,0);assert.equal(r.convertible,false);assert.equal(r.status,'unsupported');
  await fs.writeFile(path.join(f.root,'skills.manifest.json'),'{');
  const invalid=await f.inspect();assert.equal(invalid.convertible,false);assert.ok(invalid.issues.some(i=>i.code==='SKILL_MANIFEST'));
});

test('Node ESM export conditions respect declaration order and export arrays',async t=>{
  const f=await fixture(t,{exports:{'.':{types:'./types.d.ts',node:{import:['./entry.mjs'],default:'./unused.mjs'},default:'./unused.mjs'}}},{'entry.mjs':tool('active'),'unused.mjs':tool('unused')});
  const r=await f.inspect();assert.equal(r.entry,'./entry.mjs');assert.deepEqual(r.capabilities.toolRuntime.tools.map(t=>t.name),['active']);
});

test('root exports never fall through to a require-only or unrelated subpath entry',async t=>{
  const f=await fixture(t,{exports:{'./sub':'./index.js'},main:'./index.js'},{'index.js':tool('not-root')});
  const r=await f.inspect();assert.equal(r.entry,null);assert.equal(r.capabilities.toolRuntime,null);assert.equal(r.convertible,false);assert.ok(r.issues.some(i=>i.code==='ENTRY_EXPORT_UNSUPPORTED'));
});

test('host service and tool discovery follows only reachable imports and re-exports',async t=>{
  const f=await fixture(t,{main:'./src/index.ts'},{
    'src/index.ts':`import type {X} from './unused.js'; import {type Y} from './also-unused.js'; export * from './mounted.js'; export type {Z} from './third-unused.js';`,
    'src/mounted.ts':tool('mounted'),
    'src/unused.ts':`ctx.invariants.register({}); ${tool('unused')} setInterval(()=>{},1000);`,
    'src/also-unused.ts':`ctx.events.listen();`,
    'src/third-unused.ts':`ctx.http.listen();`,
  });
  const r=await f.inspect();assert.deepEqual(r.host.features,[]);assert.deepEqual(r.capabilities.toolRuntime.tools.map(t=>t.name),['mounted']);assert.equal(r.capabilities.toolRuntime.registrations,1);assert.equal(r.status,'candidate');assert.equal(r.issues.length,0);
});

test('existing JavaScript targets take precedence over TypeScript substitution',async t=>{
  const f=await fixture(t,{main:'./index.ts'},{'index.ts':`import './dep.js';`,'dep.js':tool('javascript'),'dep.ts':`ctx.events.listen(); ${tool('typescript')}`});
  const r=await f.inspect();assert.deepEqual(r.capabilities.toolRuntime.tools.map(t=>t.name),['javascript']);assert.deepEqual(r.host.features,[]);
});

test('unknown dynamic imports warn only when their source is entry-reachable',async t=>{
  const f=await fixture(t,{main:'./index.ts'},{'index.ts':`${tool('active')} import(getModule());`,'unused.ts':`import(otherModule());ctx.secret.doThing();`});
  const r=await f.inspect();assert.equal(r.issues.filter(i=>i.code==='DYNAMIC_IMPORT').length,1);assert.deepEqual(r.host.features,[]);assert.equal(r.status,'partial');
  assert.deepEqual(inspectJs(`import type X from './a'; export type {Y} from './b'; import {type Z} from './c';`).imports,[]);
});

test('Python stdio scans remain explicit candidates without claiming enablement',async t=>{
  const f=await fixture(t,{}, {'server.py':`from mcp.server.fastmcp import FastMCP\nmcp=FastMCP('test')\nmcp.run(transport='stdio')`});
  const r=await f.inspect();assert.equal(r.capabilities.pythonServers[0].status,'candidate-not-enabled');assert.deepEqual(r.capabilities.mcpServers,{});
});

test('patch parsing rejects unknown executable tags and cyclic aliases',()=>{
  assert.throws(()=>parsePatch('value: !!unknown danger()'),/標籤/);
  assert.throws(()=>parsePatch('value: &loop {nested: *loop}'),/循環/);
});

test('chat events: listening to the conversation and followup are recorded, without counting as model behaviour', () => {
  const result = inspectJs(`export function apply(ctx){
    ctx.on('session/event',(s,e)=>{});
    ctx.on('agent/created',({agent})=>agent.followup('hi'));
    ctx.on('tools/change',()=>{});
  }`);
  assert.deepEqual(result.chatEvents.map(item => item.name), ['session/event', 'agent/created', 'agent.followup']);
  assert.deepEqual(result.behaviors, []);
});
