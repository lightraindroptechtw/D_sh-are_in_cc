// End to end WITHOUT a model: convert -> generated hooks/register.ts (esbuild-stripped, driven with a `$` stand-in)
// -> generated runtime/claude-host.mjs as a real child process -> the real official DSH host worker.
//
// Proven here: the three parts (child host, mod template, converter) agree with each other.
// NOT proven here (needs a real Claude Code session with a model): see VERIFICATION.md.
//
// The four third-party sources are read-only and each skips cleanly when the corpus is not on this machine.
// Everything else uses synthetic DSH plugins written by this test. No network: --no-install-deps, and the
// four sources only have peerDependencies.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childPids, hasEsbuild, loadGeneratedMod, processAlive, runConverter, waitFor } from './e2e-claude-harness.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Folder holding the unpacked read-only corpus sources (<name>_<version>/); the tests skip without it.
const CORPUS = process.env.DSH_E2E_CORPUS ?? path.join(project, 'tmp', 'no-corpus');
const exists = async file => fs.access(file).then(() => true, () => false);
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const SKIP_ESBUILD = hasEsbuild ? false : 'esbuild is not installed';

// Short paths on purpose: on Windows the worker's temp directories under a long state path hit ENAMETOOLONG.
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-e2e-'));
const stateRoot = path.join(work, 's');
after(async () => {
  if (!process.env.DSH_E2E_KEEP) await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
});

const mods = [];
async function load(dir, options) {
  const mod = await loadGeneratedMod(dir, { env: { DSH_CLAUDE_STATE_ROOT: stateRoot }, ...options });
  mods.push(mod);
  return mod;
}
after(async () => {
  await Promise.all(mods.map(mod => mod.stop()));
  for (const mod of mods) for (const child of mod.world.children) assert.ok(child.exitCode !== null || child.signalCode !== null, 'no child host is left running');
});

async function convert(label, source, extra = []) {
  const out = path.join(work, label);
  const { code, report, stderr } = await runConverter(project, ['convert', source, '--out', out, '--no-cli', '--no-install-deps', '--cache-dir', path.join(work, 'cache'), '--state-root', stateRoot, ...extra]);
  assert.ok(report, `the converter printed a report (exit ${code}): ${stderr.slice(0, 500)}`);
  return { out, report, code };
}

const hex64 = /[0-9a-f]{64}/;
const toolText = answer => (Array.isArray(answer?.result) ? answer.result.map(b => b.text).join('\n') : JSON.stringify(answer));

// ---------------------------------------------------------------------------
// The four allowed third-party sources
// ---------------------------------------------------------------------------

const SOURCES = [
  {
    key: 'finance-data', dir: 'dsh-plugin-finance-data_0.3.2', tool: 'finance_data', promptHint: /finance_data/,
    calls: [
      { args: { action: 'ratio', type: 'pe', price: 50, eps: 5 }, expect: /\bpe\b\D*10\b/i },
      { args: { action: 'ratio', type: 'pe', price: 50, eps: 0 }, error: true }, // a zero EPS is an error, not a number
    ],
  },
  { key: 'academic-writing', dir: 'dsh-plugin-academic-writing_0.3.2', tool: 'academic_writing', promptHint: /academic_writing/, calls: [{ args: { action: 'checklist' }, expect: /\S{20}/ }] },
  { key: 'education', dir: 'dsh-plugin-education_0.3.2', tool: 'edu_kit', promptHint: /edu_kit/, calls: [{ args: { action: 'lesson', topic: 'fractions', subject: 'math', grade: '5', minutes: 30 }, expect: /fraction/i }] },
  { key: 'translation', dir: 'dsh-plugin-translation_0.3.2', tool: 'translate_kit', promptHint: /translate_kit/, memo: true, calls: [{ args: { action: 'segment', text: 'One sentence. Another sentence.' }, expect: /\[1\] One sentence/ }] },
];

for (const spec of SOURCES) {
  const source = path.join(CORPUS, spec.dir);
  const skip = SKIP_ESBUILD || ((await exists(path.join(source, 'package.json'))) ? false : `the read-only corpus source ${spec.dir} is not on this machine (set DSH_E2E_CORPUS)`);

  test(`e2e ${spec.key}: convert -> start the generated mod -> tools, prompt, commands, a real call, dispose`, { skip, timeout: 240000 }, async () => {
    const before = await fs.readFile(path.join(source, 'package.json'), 'utf8');
    // --lenient-output: the official output validation rejects results holding undefined fields (see the strict test below).
    const { out, report, code } = await convert(spec.key, source, ['--lenient-output']);

    // --- conversion -------------------------------------------------------
    assert.equal(code, 0);
    assert.equal(report.plugin.layout, 'bridge');
    // Status rule (lib/converter-claude.mjs): nothing is omitted (systemPrompt is provided), but the declared-vs-bundled
    // package version difference is a warning and keeps the status `partial`, with the reason written down.
    assert.deepEqual(report.conversion.omitted, []);
    assert.ok(report.conversion.warnings.some(w => w.code === 'HOST_VERSION_MISMATCH'), 'the version-range difference stays visible as a warning');
    assert.equal(report.conversion.status, 'partial');
    assert.match(report.conversion.reason, /HOST_VERSION_MISMATCH/);
    assert.equal(report.conversion.validation.valid, true, JSON.stringify(report.conversion.validation.errors));
    assert.equal(await exists(path.join(out, 'bin')), false);
    assert.equal(await fs.readFile(path.join(source, 'package.json'), 'utf8'), before, 'the corpus source is untouched');
    const staticNames = report.plugin.bridgeConfig.staticTools.map(t => t.name);
    assert.deepEqual(staticNames, [spec.tool]);

    // --- start ------------------------------------------------------------
    const cwd = await fs.mkdtemp(path.join(work, 'cwd-'));
    const mod = await load(out, { cwd });
    await mod.start({ cwd });
    const world = mod.world;
    assert.equal(world.statuses.at(-1), undefined, `no failure on the status line: ${JSON.stringify(world.statuses)} ${JSON.stringify(world.logs)}`);
    assert.deepEqual(world.logs, []);
    const spawn = world.spawns[0];
    assert.deepEqual(spawn.argv[0], 'node');
    assert.equal(spawn.env.DSH_CLAUDE_PLUGIN_NAME, world.manifest.name, 'the mod tells the host its plugin name');
    assert.equal(spawn.env.DSH_CLAUDE_WORKSPACE, cwd, "the session directory becomes the host's workspace");
    assert.ok(!Object.values(spawn.env).some(v => hex64.test(v)), 'no token in the child environment');

    // tools: registered under the expected names, last registration carries the host's real schema
    const names = [...new Set(world.registered.map(s => s.name))];
    assert.deepEqual(names, [spec.tool]);
    for (const spec2 of world.registered) assert.equal(spec2.inputSchema.type, 'object', 'every registration describes an object');
    const last = world.registered.at(-1);
    assert.ok(last.inputSchema.properties?.action, 'the host-reported schema (with its "action" parameter) replaced the static placeholder');
    assert.ok(last.description.length > 50);
    assert.ok(world.fullNames.get(spec.tool).startsWith('mcp__dsh-plugin-'));

    // system prompt reaches prompt.compose after the engine's own sections
    const composed = await mod.compose();
    assert.equal(composed.sections[0].id, 'engine');
    const own = composed.sections.at(-1);
    assert.equal(own.id, `${world.manifest.name}:dsh-prompt`);
    assert.equal(own.scope, 'session');
    assert.match(own.text, spec.promptHint);

    // /<plugin>-status
    const status = (await mod.command(mod.statusName)).text;
    assert.match(status, /host: ready on 127\.0\.0\.1:\d+/);
    assert.match(status, new RegExp(`tools: \\["${spec.tool}"\\]`));
    assert.match(status, /last error: none/);
    assert.match(status, /model calls from the plugin: allowed; subagents: allowed/, 'both switches are on by default');
    assert.doesNotMatch(status, hex64, 'the token is never printed');

    // calls through the mod's tool.call path -> HTTP -> official tool service
    for (const [i, call] of spec.calls.entries()) {
      const answer = await mod.toolCall(spec.tool, call.args, `toolu_${i}`);
      if (call.error) assert.equal(typeof answer.deny, 'string', `expected an error for ${JSON.stringify(call.args)}: ${JSON.stringify(answer)}`);
      else {
        assert.equal(answer.deny, undefined, `unexpected deny: ${answer.deny}`);
        assert.match(toolText(answer), call.expect, toolText(answer));
      }
    }
    if (spec.memo) {
      // translation memory: the plugin writes inside its workspace = the session directory (DSH_CLAUDE_WORKSPACE)
      const added = await mod.toolCall(spec.tool, { action: 'memo_add', source: 'hello', target: 'bonjour', lang: 'en->fr' }, 'toolu_memo');
      assert.equal(added.deny, undefined, added.deny);
      const memo = await fs.readFile(path.join(cwd, '.dsh', 'translation-memo.md'), 'utf8');
      assert.match(memo, /bonjour/);
      assert.match(toolText(await mod.toolCall(spec.tool, { action: 'memo_get' }, 'toolu_memo2')), /bonjour/);
    }

    // an unknown tool name is refused by the host, not invented
    const unknownCall = await mod.run('tool.call', { tool: 'mcp__other__thing', tool_use_id: 'x' });
    assert.equal(unknownCall.tool, 'mcp__other__thing', 'a tool of another plugin passes through untouched');

    // --- dispose: the child ends by itself (exit 0) and so does its worker ------
    const child = world.children[0];
    const workers = childPids(child.pid);
    const exited = new Promise(resolve => child.once('exit', (c, s) => resolve({ code: c, signal: s })));
    await mod.end();
    assert.deepEqual(await Promise.race([exited, new Promise(r => setTimeout(() => r('timeout'), 8000))]), { code: 0, signal: null }, 'dispose lets the host leave on its own (not killed)');
    await waitFor(() => workers.every(pid => !processAlive(pid)), { label: 'the worker process to end' });
  });
}

// Default conversion (strict output) on the first source, plus the engine killing the child.
{
  const spec = SOURCES[0];
  const source = path.join(CORPUS, spec.dir);
  const skip = SKIP_ESBUILD || ((await exists(path.join(source, 'package.json'))) ? false : 'corpus source missing');
  test('e2e finance-data, default (strict) conversion: actions with undefined fields fail loudly; the engine killing the child leaves no worker', { skip, timeout: 120000 }, async () => {
    const { out } = await convert('finance-strict', source);
    const mod = await load(out, { cwd: work });
    await mod.start();
    // The official output validation (bundled 0.2.1-rc.2) rejects a result with undefined fields. The mod must say so, not invent a result.
    const format = await mod.toolCall('finance_data', { action: 'format', value: 1234.5 });
    assert.match(format.deny, /not lossless JSON/, JSON.stringify(format));
    assert.match(toolText(await mod.toolCall('finance_data', { action: 'ratio', type: 'pe', price: 50, eps: 5 })), /\bpe\b\D*10\b/i, 'actions whose fields are all defined work');

    // Leaving the spawn loop (`stream.return()`, what the engine does when the module unloads) kills the host without
    // letting it clean up; the worker notices the closed channel itself.
    const child = mod.world.children[0];
    const workers = childPids(child.pid);
    assert.ok(workers.length >= 1 || process.platform !== 'win32', 'found the worker process');
    await mod.world.streams[0].return();
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, { label: 'the host to die' });
    await waitFor(() => workers.every(pid => !processAlive(pid)), { timeoutMs: 15000, label: 'the worker to notice and end' });
  });
}

// ---------------------------------------------------------------------------
// Synthetic DSH plugins (own code, no third-party source)
// ---------------------------------------------------------------------------

const HEADER = `import{defineTool}from'@deepseek-ai/dsh-tools';
const tool=(name,execute,extra={})=>defineTool({name,description:'synthetic '+name,parameters:{},output:{schema:{type:'json'},render:(_,v)=>[{type:'text',text:typeof v==='string'?v:JSON.stringify(v)}]},execute,...extra});
`;
async function synthetic(label, packageName, index) {
  const dir = path.join(work, `src-${label}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: packageName, version: '0.0.1', description: `Synthetic ${label}`, type: 'module', main: 'index.mjs' }));
  await fs.writeFile(path.join(dir, 'index.mjs'), HEADER + index);
  return dir;
}

test('e2e synthetic: a known DSH service without a Claude counterpart (sessionController) is mounted as a guarded placeholder: the plugin starts, using it fails loudly', { skip: SKIP_ESBUILD, timeout: 180000 }, async () => {
  const src = await synthetic('sessionController', 'dsh-synthetic-needs-sessionctl', `export const name='needs-sessionctl';export const inject=['tools','sessionController'];export function apply(ctx){ctx.tools.register(tool('probe',async()=>ctx.sessionController.run('ls')));ctx.tools.register(tool('fine',async()=>'ok'));}`);
  const { out, report } = await convert('sessionController', src);
  assert.ok(report.conversion.omitted.some(i => i.code === 'SERVICE_UNSUPPORTED' && i.service === 'sessionController'), 'the converter already says sessionController is unsupported');
  assert.equal(report.conversion.status, 'partial');
  const mod = await load(out, { cwd: work });
  await mod.start();
  assert.equal(mod.world.statuses.at(-1), undefined, JSON.stringify(mod.world.logs));
  assert.equal(toolText(await mod.toolCall('fine')), 'ok');
  const used = await mod.toolCall('probe');
  assert.match(used.deny, /sessionController.run/, 'the denial names the unsupported service and method');
  assert.match(used.deny, /No generic module maps this DSH service/, JSON.stringify(used));
});

test('e2e synthetic: a plugin that cannot start (waits for a service nobody provides) surfaces the real cause through fatal', { skip: SKIP_ESBUILD, timeout: 180000 }, async () => {
  const src = await synthetic('waits', 'dsh-synthetic-waits', `export const name='waits';export const inject=['tools','mysteryService'];export function apply(ctx){ctx.tools.register(defineTool({name:'probe',description:'p',parameters:{},output:{schema:{type:'json'},render:(_,v)=>[{type:'text',text:String(v)}]},execute:async()=>1}));}`);
  const { out, report } = await convert('waits', src);
  assert.ok(report.conversion.uncertainServices.some(i => i.name === 'mysteryService'), 'the converter lists the name as uncertain');
  const mod = await load(out, { cwd: work });
  await mod.start();
  assert.match(mod.world.statuses.at(-1) ?? '', /waiting for service: mysteryService/, 'the status line carries the real cause');
  assert.ok(mod.world.logs.some(l => /waiting for service: mysteryService/.test(l) && /-status/.test(l)), 'the transcript line carries it and names /<plugin>-status');
  const denied = await mod.toolCall('probe', {});
  assert.match(denied.deny, /waiting for service: mysteryService/);
  const status = (await mod.command(mod.statusName)).text;
  assert.match(status, /host: fatal/);
  assert.match(status, /last error: .*waiting for service: mysteryService/);
  const child = mod.world.children[0];
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, { label: 'the host to exit after fatal' });
  assert.equal(child.exitCode, 1);
  // the static tool is still declared (from analysis), with an object schema
  assert.ok(mod.world.registered.length >= 1 && mod.world.registered.every(s => s.inputSchema.type === 'object'));
});

const REVERSE = `export const name='syn-reverse';export const inject=['tools','llm','agents','commands'];
export function apply(ctx){
  ctx.commands.register({name:'hello',description:'Say hello',handler:async inv=>({kind:'success',text:'hello'+inv.rawInput})});
  ctx.commands.register({name:'broken',description:'Always fails',handler:async()=>({kind:'error',text:'command failed on purpose'})});
  ctx.on('tools/pre-execute',(exec,next)=>exec.name==='danger_tool'||exec.name==='Write'?{kind:'ask',reason:'Synthetic approval for '+exec.name}:exec.name==='Bash'?{kind:'deny',reason:'no bash for you'}:next());
  ctx.on('tools/post-execute',(exec,result,next)=>exec.name==='Read'?{kind:'block',feedback:[{type:'text',text:'blocked by policy'}]}:next());
  ctx.tools.register(tool('danger_tool',async a=>({ran:true,note:a.note}),{parameters:{token:{type:'string'},note:{type:'string'}}}));
  ctx.tools.register(tool('ask_model',async()=>{const r=await ctx.llm.complete({system:'Be brief',messages:[{role:'user',content:'Ping'}]});return {text:r.text};}));
  ctx.tools.register(tool('spawn_agent',async()=>{const h=await ctx.agents.create({sessionId:'s1',agentOptions:{subagentType:'general-purpose'}});try{h.agent.send('Do the thing');await h.agent.whenIdle();return {reply:h.agent.lastReply};}finally{await h.dispose();}}));
}`;

test('e2e synthetic: approval round trip, model calls and subagents are on by default and close with the options; interception only when allowed', { skip: SKIP_ESBUILD, timeout: 240000 }, async () => {
  const src = await synthetic('reverse', 'dsh-synthetic-reverse', REVERSE);
  const { out, report } = await convert('reverse', src);
  assert.notEqual(report.conversion.status, 'unsupported', JSON.stringify(report.conversion.omitted));
  const manifest = await readJson(path.join(out, '.claude-plugin', 'plugin.json'));
  assert.equal(manifest.userConfig.allowModelCalls.default, true);
  assert.equal(manifest.userConfig.allowAgents.default, true);
  assert.equal(manifest.userConfig.allowInterception.default, false);

  // ---- slash commands: registered from the host's list, run through commands.run ----
  const withCommands = await load(out, { cwd: work });
  await withCommands.start();
  assert.deepEqual(withCommands.world.commands.map(c => c.name).filter(n => !n.endsWith('-status') && !n.endsWith('-restart') && !n.endsWith('-trust')).sort(), ['broken', 'hello']);
  assert.equal((await withCommands.command('hello', 'world')).text, 'hello world');
  assert.match((await withCommands.command('broken')).text, /command failed on purpose/);
  assert.equal((await withCommands.command('not-ours')).command, 'not-ours', 'a command of another plugin goes on to the engine');
  await withCommands.end();

  // ---- switches turned off by the person; interception turned on to exercise it ----
  const closed = await load(out, { cwd: work, options: { allowModelCalls: false, allowAgents: false, allowInterception: true } });
  await closed.start();
  assert.equal(closed.world.statuses.at(-1), undefined, JSON.stringify(closed.world.logs));
  const model = await closed.toolCall('ask_model');
  assert.match(model.deny, /allowModelCalls/, JSON.stringify(model));
  assert.equal(closed.world.modelCalls.length, 0, 'no model call was made while the switch is off');
  const agent = await closed.toolCall('spawn_agent');
  assert.match(agent.deny, /allowAgents/, JSON.stringify(agent));
  assert.equal(closed.world.agentCalls.length, 0);

  // approval: question names the host's reason; the secret argument value is never shown; only "Approve" runs the tool
  const yes = await closed.toolCall('danger_tool', { token: 'SUPER-SECRET-VALUE', note: 'plain note' });
  assert.equal(yes.deny, undefined, JSON.stringify(yes));
  assert.deepEqual(JSON.parse(toolText(yes)), { ran: true, note: 'plain note' });
  assert.equal(closed.world.asks.length, 1);
  assert.match(closed.world.asks[0].question, /Synthetic approval for danger_tool/, 'the reason the host sends is what the person reads');
  assert.doesNotMatch(closed.world.asks[0].question, /SUPER-SECRET-VALUE/);
  assert.deepEqual(closed.world.asks[0].options, ['Approve', 'Deny']);
  for (const answer of ['Deny', 'yes, go ahead', new Error('dismissed')]) {
    closed.world.ask = answer;
    const refused = await closed.toolCall('danger_tool', { note: 'n' });
    assert.equal(typeof refused.deny, 'string', `anything but "Approve" refuses (${String(answer)})`);
    assert.match(refused.deny, /rejected|unavailable|cancel/i);
  }

  // interception through the mod's tool.call: pre deny, pre ask -> approval, post block
  closed.world.ask = 'Approve';
  const terminal = async e => ({ result: [{ type: 'text', text: `engine ran ${e.tool}` }] });
  const bash = await closed.run('tool.call', { tool: 'Bash', tool_use_id: 'b1', command: 'ls' }, { terminal });
  assert.equal(bash.deny, 'no bash for you');
  const glob = await closed.run('tool.call', { tool: 'Glob', tool_use_id: 'g1', pattern: '*' }, { terminal });
  assert.equal(glob.result[0].text, 'engine ran Glob');
  const asksBefore = closed.world.asks.length;
  const write = await closed.run('tool.call', { tool: 'Write', tool_use_id: 'w1', file_path: 'a.txt', content: 'SECRET-BODY' }, { terminal });
  assert.equal(write.deny, undefined);
  assert.equal(closed.world.asks.length, asksBefore + 1, 'a pre-execute "ask" became an approval dialog');
  assert.doesNotMatch(closed.world.asks.at(-1).question, /SECRET-BODY/);
  const read = await closed.run('tool.call', { tool: 'Read', tool_use_id: 'r1', file_path: 'a.txt' }, { terminal });
  assert.match(JSON.stringify(read.context ?? []), /blocked by policy/, `the post-execute block reaches the model as a note: ${JSON.stringify(read)}`);
  await closed.end();

  // ---- userConfig on ----
  const open = await load(out, { cwd: work, options: { allowModelCalls: true, allowAgents: true }, modelText: 'Pong', agentAnswer: 'done by the subagent' });
  await open.start();
  const pong = await open.toolCall('ask_model');
  assert.equal(pong.deny, undefined, JSON.stringify(pong));
  assert.deepEqual(JSON.parse(toolText(pong)), { text: 'Pong' });
  assert.equal(open.world.modelCalls.length, 1);
  assert.equal(open.world.modelCalls[0].prompt, 'Ping');
  assert.equal(open.world.modelCalls[0].system, 'Be brief');
  assert.equal(open.world.modelCalls[0].model, 'test-model', 'a DSH model id is never forwarded: the session model is used');
  const spawned = await open.toolCall('spawn_agent');
  assert.equal(spawned.deny, undefined, JSON.stringify(spawned));
  assert.deepEqual(JSON.parse(toolText(spawned)), { reply: 'done by the subagent' });
  assert.match(open.world.agentCalls[0].prompt, /Do the thing/);
  assert.equal(open.world.agentCalls[0].subagentType, 'general-purpose');
  await open.end();
});
