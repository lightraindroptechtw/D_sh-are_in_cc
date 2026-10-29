import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDshHost } from '../lib/dsh-host.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const runtimeRoot = process.env.DSH_TEST_RUNTIME_ROOT ?? packageRoot;
const emitTool = `import {defineTool} from '@deepseek-ai/dsh-tools';const tool=(name,execute)=>defineTool({name,description:name,parameters:{value:{type:'string'}},output:{schema:{type:'json'},render:(_,v)=>[{type:'text',text:typeof v==='string'?v:JSON.stringify(v)}]},execute});`;
async function fixture(t, source, extra = {}) {
  if (!source.includes('export const inject=')) source += `\nexport const inject=['tools'];\n`;
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-host-'));
  const sourceRoot = join(root, 'source'), stateDir = join(root, 'state'); await mkdir(sourceRoot);
  await writeFile(join(sourceRoot, 'package.json'), '{"type":"module"}'); await writeFile(join(sourceRoot, 'index.ts'), source);
  for (const [name, value] of Object.entries(extra)) { const path = join(sourceRoot, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); }
  const hosts = [];
  t.after(async () => { try { for (const host of hosts) await host.dispose(); } finally { await rm(root, { recursive: true, force: true }); } });
  return { root, sourceRoot, stateDir, entry: join(sourceRoot, 'index.ts'), runtimeRoot, track(host){hosts.push(host);return host;}, async load(options = {}) { const host = await loadDshHost({ entry: join(sourceRoot, 'index.ts'), sourceRoot, stateDir, runtimeRoot, ...options }); hosts.push(host); return host; } };
}

test('official host mounts real registry, system prompt, timer, settings, HTTP and commands', async t => {
  const f = await fixture(t, `${emitTool}export const name='native-probe';export const inject=['tools','systemPrompt','settings','webServer','commands','timer','fs'];export function apply(ctx){ctx.tools.register(tool('native_probe',async a=>a.value??'ok'));ctx.systemPrompt.section({name:'native:instructions',order:5,text:'Use the native probe.'});ctx.commands.register({name:'probe',description:'A real registered command',handler:()=>({kind:'success',text:'ok'})});ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/probe',handler:(req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('real HTTP route')}}));}`);
  const host = await f.load();
  assert.equal((await host.tools[0].execute({ value: 'real' })).content[0].text, 'real');
  assert.equal(host.metadata.host, 'official-dsh-cordis'); assert.equal(host.metadata.versions['@deepseek-ai/dsh-tools'], '0.2.1-rc.2');
  assert.ok(host.metadata.entries.every(e => e.active));
  assert.ok((await host.context()).sections.some(s => s.name === 'native:instructions' && s.text === 'Use the native probe.'));
  assert.ok((await host.request('commands.list')).some(c => c.name === 'probe'));
  const routes = await host.request('routes'); assert.ok(routes.routes.some(r => r.path === '/probe'));
  assert.equal(await (await fetch(routes.origin + '/probe')).text(), 'real HTTP route');
});

test('original local-life source matches direct official registry output and assembles its actual guidance', async t => {
  const original = resolve(packageRoot, '../../work/dsh-converter-corpus/dsh-plugin-local-life/lib/index.js');
  try { await access(original); } catch { t.skip('Optional downloaded community corpus is not present'); return; }
  const f = await fixture(t, '');
  const host = f.track(await loadDshHost({ entry: original, sourceRoot: dirname(original), stateDir: f.stateDir, runtimeRoot }));
  assert.equal(host.tools[0].name, 'local_life');
  const result = await host.tools[0].execute({ action: 'convert', value: 1, from: 'kg', to: '斤' });
  assert.equal(result.isError, false); assert.equal(result.content[0].text, '1 kg = 2 斤'); assert.equal(result.structuredContent.value, 2);
  assert.ok((await host.context()).sections.some(s => s.name === 'local-life:instructions' && s.text.includes('Local-life guidance:')));
  assert.ok(host.metadata.toolsChanged >= 1);
});

test('real pre/post policies run and asking without an approval service fails closed', async t => {
  const f = await fixture(t, `${emitTool}export const name='policy-probe';export function apply(ctx){let calls=0;ctx.on('tools/pre-execute',(exec,next)=>exec.arguments.value==='deny'?{kind:'deny',reason:'Denied by native policy'}:exec.arguments.value==='ask'?{kind:'ask',reason:'Needs explicit approval'}:next());ctx.on('tools/post-execute',(exec,result,next)=>exec.arguments.value==='post'?{kind:'accept',content:[{type:'text',text:'native post policy ran'}]}:next());ctx.tools.register(tool('policy_probe',async()=>{calls++;return calls}));}`);
  const host = await f.load();
  const deny = await host.tools[0].execute({ value: 'deny' }); assert.equal(deny.isError, true); assert.match(deny.content[0].text, /Denied by native policy/);
  const ask = await host.tools[0].execute({ value: 'ask' }); assert.equal(ask.isError, true);
  const first = await host.tools[0].execute({ value: 'allow' }); assert.equal(first.content[0].text, '1', 'Denied and unapproved calls must not run the tool body');
  const post = await host.tools[0].execute({ value: 'post' }); assert.equal(post.content[0].text, 'native post policy ran');
});

test('real settings volatile updates mutate live config and persist through official profile patches', async t => {
  const f = await fixture(t, `${emitTool}import z from '@deepseek-ai/schemastery';export const name='settings-probe';export const Config=z.object({count:z.natural().default(2).volatile(),token:z.string().role('secret').default('').volatile()});export function apply(ctx,c){ctx.tools.register(tool('settings_probe',async()=>({count:c.count.get()})));}`);
  const host = await f.load({ config: { token: 'fixture-secret' } });
  const descriptors = await host.request('settings.describe');
  const form = descriptors.find(d => d.ns === 'settings-probe'); assert.ok(form); assert.equal(form.value.count, 2); assert.equal(form.value.token, undefined); assert.ok(form.secrets.some(s => s.path.includes('token') && s.set));
  await host.request('settings.update', { namespace: 'settings-probe', values: { count: 7 }, expectedRevision: form.revision });
  const updatedResult=await (await host.getTools())[0].execute();assert.equal(updatedResult.isError,false,JSON.stringify(updatedResult));assert.equal(updatedResult.structuredContent.count,7);
  const persisted = await readFile(join(f.stateDir, 'profiles', 'codex-bridge', 'cordis.patch.yml'), 'utf8'); assert.match(persisted, /count: 7/);
  const after = (await host.request('settings.describe')).find(d => d.ns === 'settings-probe');
  await assert.rejects(host.request('settings.update', { namespace: 'settings-probe', values: { count: 8 }, expectedRevision: form.revision }), /changed since/);
  assert.ok(after.revision > form.revision);
  await host.dispose(); const restarted = await f.load({ config: { token: 'fixture-secret' } });
  assert.equal((await restarted.tools[0].execute()).structuredContent.count, 7);
});

test('real registry changes notify observers and getTools returns the current tool set', async t => {
  const f = await fixture(t, `${emitTool}export const name='dynamic-probe';export function apply(ctx){ctx.tools.register(tool('initial_probe',async()=> 'initial'));ctx.on('bridge/register-extra',()=>{ctx.tools.register(tool('extra_probe',async()=> 'extra'))});}`);
  const host = await f.load(); let notifications = 0; const stop = host.onToolsChanged(() => { notifications++; });
  await host.dispatchEvent('bridge/register-extra', []);
  assert.deepEqual((await host.getTools()).map(t => t.name).sort(), ['extra_probe', 'initial_probe']); assert.ok(notifications >= 1);
  assert.equal((await (await host.getTools()).find(t => t.name === 'extra_probe').execute()).content[0].text, 'extra'); stop();
});

test('DSH home and user directories are isolated and ambient API secrets are not inherited', async t => {
  const key = 'DSH_HOST_TEST_SECRET', before = process.env[key]; process.env[key] = 'must-not-leak';
  t.after(() => before === undefined ? delete process.env[key] : process.env[key] = before);
  const f = await fixture(t, `${emitTool}import {homedir} from 'node:os';export const name='isolation-probe';export function apply(ctx){ctx.tools.register(tool('isolation_probe',async()=>({home:homedir(),dsh:process.env.DSH_HOME,appdata:process.env.APPDATA,modules:process.env.DSH_HOST_MODULES,secret:process.env.DSH_HOST_TEST_SECRET??null})));}`);
  const host = await f.load(); const values = (await host.tools[0].execute()).structuredContent;
  assert.equal(values.home, f.stateDir); assert.equal(values.dsh, f.stateDir); assert.equal(values.appdata, join(f.stateDir, 'appdata')); assert.equal(values.secret, null); assert.equal(values.modules, join(runtimeRoot, 'node_modules', '@deepseek-ai'));
});

test('source-relative assets keep working with real host imports and TypeScript', async t => {
  const f = await fixture(t, `${emitTool}import {readFile} from 'node:fs/promises';export const name='asset-probe';export function apply(ctx){ctx.tools.register(tool('asset_probe',async()=>readFile(new URL('./asset.txt',import.meta.url),'utf8')));}`, { 'asset.txt': 'original asset' });
  const host = await f.load(); assert.equal((await host.tools[0].execute()).content[0].text, 'original asset');
});

test('unknown services, native lifecycle event impersonation and arbitrary RPC are refused', async t => {
  const f = await fixture(t, `${emitTool}export const name='refusal-probe';export function apply(ctx){ctx.tools.register(tool('refusal_probe',async()=> 'ok'));}`);
  const host = await f.load();
  await assert.rejects(host.dispatchEvent('agent-loop/pre-call', [{}]), { code: 'HOST_EVENT_UNSUPPORTED' });
  await assert.rejects(host.request('eval', { code: 'process.exit(0)' }), { code: 'HOST_RPC_UNSUPPORTED' });
  await assert.rejects(f.load({ services: ['made-up-service'] }), { code: 'HOST_SERVICE_UNSUPPORTED' });
});

test('missing injected service does not activate a partial plugin or fabricate a service', async t => {
  const f = await fixture(t, `${emitTool}export const name='missing-probe';export const inject=['nonexistentRealService'];export function apply(ctx){ctx.tools.register(tool('never_registered',async()=> 'bad'));}`);
  await assert.rejects(f.load(), error => error.code === 'HOST_PLUGIN_INACTIVE' && error.unsupported.some(v => v.feature === 'service:nonexistentRealService'));
});

test('dispose runs genuine Cordis effect cleanup and prevents later calls', async t => {
  const f = await fixture(t, `${emitTool}import {writeFileSync} from 'node:fs';export const name='cleanup-probe';export function apply(ctx){ctx.effect(()=>()=>writeFileSync(new URL('./cleanup.txt',import.meta.url),'clean'));ctx.tools.register(tool('cleanup_probe',async()=> 'ok'));}`);
  const host = await f.load(); await host.dispose(); await host.dispose();
  assert.equal(await readFile(join(f.sourceRoot, 'cleanup.txt'), 'utf8'), 'clean');
  await assert.rejects(host.tools[0].execute(), { code: 'DISPOSED' });
});

test('cooperative cancellation reaches the genuine official ToolRunContext signal', async t => {
  const f = await fixture(t, `${emitTool}export const name='cancel-probe';export function apply(ctx){ctx.tools.register(tool('cancel_probe',async(a,exec)=>new Promise((resolve,reject)=>exec.signal.addEventListener('abort',()=>reject(new Error('signal reached plugin')),{once:true}))));}`);
  const host = await f.load(); const controller = new AbortController();
  const result = host.tools[0].execute({}, { signal: controller.signal }); setTimeout(() => controller.abort(), 50);
  assert.equal((await result).isError, true);
});

test('official dynamic skill registry preserves bodies, resource bases and invocation restrictions',async t=>{
  const f=await fixture(t,`export const name='runtime-skill-probe';export const inject=['skills'];export function apply(ctx){ctx.skills.register({name:'runtime-public',description:'A runtime skill',source:'runtime',content:'Original runtime instruction body.',resourceBase:{kind:'directory',path:'/synthetic/resources'}});ctx.skills.register({name:'human-only',description:'Human only',source:'runtime',content:'Not model invocable',invocation:{modelInvocable:false,userInvocable:true}});ctx.on('bridge/register-skill',()=>ctx.skills.register({name:'runtime-later',description:'Registered later',source:'runtime',content:'Later body'}));}`);
  const host=await f.load();
  const listed=await host.request('skills.list');assert.deepEqual(listed.map(skill=>skill.name),['runtime-public']);
  const original=await host.request('skills.get',{name:'runtime-public'});assert.equal(original.content,'Original runtime instruction body.');assert.equal(original.resourceBase.path,'/synthetic/resources');
  await assert.rejects(host.request('skills.get',{name:'human-only'}),{code:'HOST_SKILL_UNAVAILABLE'});
  await host.dispatchEvent('bridge/register-skill');assert.deepEqual((await host.request('skills.list')).map(skill=>skill.name),['runtime-later','runtime-public']);
});

test('original browser channel exposes its runtime skill and disconnected status without connecting a browser',async t=>{
  const original=resolve(packageRoot,'../../work/dsh-expanded-corpus/dsh-cdp/lib/index.js');
  try{await access(original);}catch{t.skip('Original corpus source is absent');return;}
  const f=await fixture(t,'');
  const host=f.track(await loadDshHost({entry:original,sourceRoot:dirname(original),stateDir:f.stateDir,runtimeRoot,config:{autoConnect:false}}));
  const listed=await host.request('skills.list');assert.ok(listed.some(skill=>skill.name==='browser-cdp'));
  const skill=await host.request('skills.get',{name:'browser-cdp'});assert.match(skill.content,/\/api\/dsh-cdp/);
  const {origin}=await host.request('routes');const status=await fetch(new URL('/api/dsh-cdp?cmd=status',origin),{redirect:'error'});assert.equal(status.status,200);assert.equal((await status.json()).ok,true);
});
