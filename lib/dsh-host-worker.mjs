import {withSourceLoaderNames} from './compat/loader-context.mjs';
/** Private IPC worker: the real Cordis/DSH runtime, never a compatibility stub. */
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fsSync from 'node:fs';
import childProcessModule from 'node:child_process';
import { mkdir, readFile, writeFile, lstat, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath as fileURLToPathSafe } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createToolScheduler } from './tool-scheduler.mjs';
import { wrapToolDefinition } from './output-normalization.mjs';
import { selectModules, installModules } from './modules/index.mjs';
import { claudeRegistry, claudeUiRegistry, claudeCapabilities, createClaudeBridgeAgent, runCommand, interceptPre, interceptPost, collectPromptSections } from './modules/claude/index.mjs';
import { entryIdFor, ENTRY_ID_PATTERN } from './entry-id.mjs';
import {compileDshEntry,resolveSourceRootPlaceholder,PRECOMPILED_META_FILE,PRECOMPILED_SCHEMA_VERSION} from './precompile-entry.mjs';
import {adaptApplyResult} from './compat/apply-result.mjs';
import {resolveConfigExpressions,expressionEnvNames} from './compat/dsh-expression.mjs';
import {installVersionAliases,linkScope,removeAliasedScope} from './compat/version-alias.mjs';
import {translateBlocked,createBlockedReporter,blockedText} from './modules/claude/blocked.mjs';
import {createConversationBridge} from './modules/claude/conversation.mjs';
import {isKnownDshService} from './dsh-services.mjs';
// Browser-screen backend (only mounted when the package has a screen: options.uiBackend).
import {callConnection,describeConnection} from './modules/connection.mjs';
import {callTypert,openTypert,describeTypert,markUiSourceContext} from './modules/typert.mjs';
import {dispatchOfficialUiCall} from './ui-official-services.mjs';
import {createUiEventJournal} from './ui-event-journal.mjs';
import {encodeConnectionResult} from '../ui/transport.mjs';
import {createRemoteStreamRegistry} from './ui-remote-streams.mjs';
import {dispatchFileResourceCall,dispatchWorkspaceFilesCall,dispatchWorkspaceFilesStream} from './ui-files.mjs';

let ctx, options, modules, activeState, initialized = false, changes = 0, changedQueued = false;
let sessionQuery, moduleRuntime, scheduler, scopeTarget, hostModules, uiEventJournal, uiStreams;
let bridgeSequence=0;
// Which tool call is running ({tool, callId, blocked}: for "which feature was blocked" and the blocks of that call), blocked actions, programs run by the host.
const currentCall=new AsyncLocalStorage();
const startupBlocks=[];
let blockedReporter=null,execSequence=0;
// The conversation as DSH session events and one live agent (lib/modules/claude/conversation.mjs).
let conversation=null;
const execSessions=new Map();
// A notice raised inside a tool call names the call, so the mod can tie it to that call's answer.
const reportBlocked=blocked=>{if(!blockedReporter)blockedReporter=createBlockedReporter({notify:(text,blocked)=>{const callId=currentCall.getStore()?.callId;if(process.connected)requestHost('ui.notify',{level:'warning',text,blocked:{kind:blocked.kind,code:blocked.code,...(typeof callId==='string'?{callId}:{})}}).catch(()=>{});}});return blockedReporter.report(blocked);};
/** Every block hit inside a tool call is kept on the call (also one already notified), for the tools.call answer. */
function noteCallBlock(blocked){const call=currentCall.getStore();if(!Array.isArray(call?.blocked)||!blocked?.kind)return;if(call.blocked.some(row=>row.kind===blocked.kind&&row.code===blocked.code&&row.what===blocked.what))return;if(call.blocked.length<8)call.blocked.push({kind:String(blocked.kind),code:String(blocked.code??''),what:String(blocked.what??'')});}
const pluginLabelOf=()=>options?.pluginLabel??null;
/** Turn a known block (permission model, missing secret, DSH-only feature, refused command) into the four-part notice and report it once. */
function blockedFailure(cause,feature){
  const translated=translateBlocked(cause,{plugin:pluginLabelOf(),feature});
  if(!translated)return cause;
  noteCallBlock(translated.blocked);
  // The same error may pass here twice (where it was raised, then at the tool boundary): count it once.
  if(!translated.__blockedReported){reportBlocked(translated.blocked);try{Object.defineProperty(translated,'__blockedReported',{value:true});}catch{}}
  return translated;
}
function execHostChannel(){
  return {start(spec,onEvent){
    const id=`exec-${++execSequence}`;execSessions.set(id,onEvent);
    send({event:'exec',op:'start',id,spec});
    return {write:data=>send({event:'exec',op:'write',id,data}),end:()=>send({event:'exec',op:'end',id}),kill:graceMs=>send({event:'exec',op:'kill',id,graceMs})};
  }};
}
const lazyDependencies = [];
// Compatibility measures that were applied for this plugin (reported in host metadata so nothing is silent).
const compatNotes = [];
const addCompat = note => { if (!compatNotes.some(x => x.id === note.id && x.entry === note.entry && x.package === note.package)) compatNotes.push(note); };
const active = new Map(), routeRows = new Map(), bridgePending=new Map();
const send = message => { if (process.connected) process.send(message); };
function error(message, code = 'DSH_HOST_ERROR', unsupported = []) { const e = new Error(message); e.code = code; e.unsupported = unsupported; return e; }
function schemaTools() { return ctx.tools.schemas().map(({ name, description, parameters }) => {const timeoutMs=ctx.tools.resolveExecution(name,undefined,false)?.timeoutMs;return { name, description, inputSchema: parameters,...(timeoutMs===undefined?{}:{timeoutMs}) };}); }
function requestHost(method,params={},execution={}){
  if(execution.signal?.aborted)return Promise.reject(error('Client request canceled','HOST_CANCELED'));
  const id=`bridge-${++bridgeSequence}`;
  return new Promise((resolve,reject)=>{
    const finish=(cause,result)=>{const slot=bridgePending.get(id);if(!slot)return;bridgePending.delete(id);execution.signal?.removeEventListener('abort',abort);cause?reject(cause):resolve(result);};
    const abort=()=>finish(error('Client request canceled','HOST_CANCELED'));
    bridgePending.set(id,{finish});execution.signal?.addEventListener('abort',abort,{once:true});
    send({event:'bridgeRequest',id,method,params,...(execution.requestId===undefined?{}:{requestId:execution.requestId})});
  });
}
function cancelBridges(){for(const slot of [...bridgePending.values()])slot.finish(error('DSH host disposed','DISPOSED'));}
function toolsChanged() {
  changes++;
  if (changedQueued) return; changedQueued = true;
  queueMicrotask(() => { changedQueued = false; if (initialized && ctx.get('tools')) send({ event: 'toolsChanged', tools: schemaTools() }); });
}
async function compileEntry(entry, outfile, requireFromHost) {
  if(options.compileViaHost){
    // Under the Node permission model the worker cannot start esbuild; the host process compiles with the same settings.
    let result;
    // A bridged failure has no code of its own: keep the message (esbuild's first error) so start-up diagnosis reads it as before.
    try{result=await requestHost('host.compileEntry',{entry,outfile});}catch(cause){throw error(cause.message,cause.code&&cause.code!=='CLIENT_REQUEST_FAILED'?cause.code:'DSH_HOST_ERROR');}
    for(const row of result?.lazyDependencies??[])if(!lazyDependencies.some(x=>x.specifier===row.specifier&&x.mode===row.mode))lazyDependencies.push(row);
    for(const row of result?.compat??[])addCompat({id:'package-compat',package:row.package,olderRelease:row.olderRelease,provides:row.provides});
    return;
  }
  const esbuild = await import(pathToFileURL(requireFromHost.resolve('esbuild')).href);
  await compileDshEntry({esbuild,requireFromHost,entry,outfile,sourceRoot:options.sourceRoot,nodePaths:[...(options.sourceNodePaths??options.nodePaths??[]).map(path=>resolve(options.sourceRoot,path)),join(options.runtimeRoot,'node_modules')],portable:false,onLazyDependency:row=>{if(!lazyDependencies.some(x=>x.specifier===row.specifier&&x.mode===row.mode))lazyDependencies.push({specifier:row.specifier,kind:row.kind,mode:row.mode});},onCompat:row=>addCompat({id:'package-compat',package:row.package,olderRelease:row.olderRelease,provides:row.provides})});
}
// The converter may ship `runtime/plugin.mjs` (compiled once at conversion time). Returns false when it is absent
// or does not belong to this entry, so the caller compiles at start-up exactly as before.
// With `id` (a bundle that mounts several plugin entries) the matching row of meta.entries is used instead.
async function installPrecompiledEntry(file, outfile, { entry = options.entry, id } = {}) {
  const directory = dirname(file);
  let meta;
  try { meta = JSON.parse(await readFile(join(directory, PRECOMPILED_META_FILE), 'utf8')); } catch { return false; }
  if (meta?.schemaVersion !== PRECOMPILED_SCHEMA_VERSION) return false;
  const relativeEntry = relative(options.sourceRoot, entry).split(sep).join('/');
  let source = file, lazy = meta.lazyDependencies, compat = meta.compat;
  if (id !== undefined) {
    const row = (Array.isArray(meta.entries) ? meta.entries : []).find(item => item && item.id === id && item.entry === relativeEntry && typeof item.file === 'string');
    if (!row) return false;
    source = resolve(directory, row.file);
    if (relative(directory, source).startsWith('..')) return false;
    lazy = row.lazyDependencies; compat = row.compat;
  } else if (meta.entry !== relativeEntry) return false;
  let code;
  try { code = await readFile(source, 'utf8'); } catch { return false; }
  await writeFile(outfile, resolveSourceRootPlaceholder(code, options.sourceRoot));
  for (const row of Array.isArray(lazy) ? lazy : []) if (row && typeof row.specifier === 'string' && !lazyDependencies.some(x => x.specifier === row.specifier && x.mode === row.mode)) lazyDependencies.push({ specifier: row.specifier, kind: row.kind, mode: row.mode });
  for (const row of Array.isArray(compat) ? compat : []) if (row && typeof row.package === 'string') addCompat({ id: 'package-compat', package: row.package, olderRelease: row.olderRelease, provides: row.provides });
  return true;
}
async function initialize(input) {
  if (ctx) throw error('DSH host was already initialized', 'HOST_ALREADY_INITIALIZED');
  options = input;
  // The official Cordis/DSH host with the Claude Code service modules.
  hostModules = options.uiBackend === true ? claudeUiRegistry : claudeRegistry;
  if (options.sandboxed) installSandboxGuards();
  const capabilities = claudeCapabilities;
  // Native import(variable) and import.meta.resolve cannot use esbuild nodePaths.
  // A managed scope junction exposes the same pinned SDK to compiled modules,
  // without writing into the source or modifying official package files.
  const moduleDir=join(options.stateDir,'compiled','node_modules');await mkdir(moduleDir,{recursive:true});
  const scopeLink=join(moduleDir,'@deepseek-ai'),scopeDirectory=join(options.runtimeRoot,'node_modules','@deepseek-ai');
  const aliasRows=Array.isArray(options.versionAliases)?options.versionAliases:[];
  if(options.sdkScopePrepared){
    // Prepared by the host process (the worker may not create links under the permission model).
    for(const row of options.sdkScopePrepared.aliases??[])addCompat({id:'version-alias',package:row.name,reports:row.reports,realVersion:row.realVersion,comparedExports:row.comparedExports,skippedSubpaths:row.skippedSubpaths});
  }else if(aliasRows.length){
    // Plugins that gate on an exact official version see it through a shim that re-exports the real bundled package (lib/compat/version-alias.mjs).
    for(const row of await installVersionAliases({scopeLink,scopeDirectory,aliases:aliasRows}))addCompat({id:'version-alias',package:row.name,reports:row.reports,realVersion:row.realVersion,comparedExports:row.comparedExports,skippedSubpaths:row.skippedSubpaths});
  }else{
    try{const info=await lstat(scopeLink);if(info.isDirectory()&&!info.isSymbolicLink())await removeAliasedScope(scopeLink);}catch(cause){if(cause.code!=='ENOENT')throw cause;}
    try{const info=await lstat(scopeLink);if(!info.isSymbolicLink())throw error('Managed SDK resolution path is occupied','HOST_STATE_CONFLICT');let matches=false;try{matches=await realpath(scopeLink)===await realpath(scopeDirectory);}catch{}if(!matches)await unlink(scopeLink);else options.sdkLinkReady=true;}catch(cause){if(cause.code!=='ENOENT')throw cause;}
    if(!options.sdkLinkReady)await linkScope(scopeDirectory,scopeLink);
  }
  const hostRequire = createRequire(join(options.runtimeRoot, 'package.json'));
  const load = async name => {
    try { return await import(pathToFileURL(hostRequire.resolve(name)).href); }
    catch (cause) { throw error(`Cannot load pinned official runtime package: ${name} (${cause.code ?? 'import failed'})`, 'HOST_DEPENDENCY_MISSING'); }
  };
  const [cordis, boot, prompt, tools,scope] = await Promise.all(['@deepseek-ai/cordis', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools','@deepseek-ai/dsh-scope'].map(load));
  scopeTarget=scope.scopeTarget;
  // FiberState is a const enum erased from published JavaScript. In pinned
  // @deepseek-ai/cordis@4.0.5 its published lib/types/fiber.d.ts declares ACTIVE=2.
  activeState = 2; modules = { boot, prompt, cordis };
  class BridgeTools extends tools.default {register(definition){return super.register(guardToolDefinition(wrapToolDefinition(definition,options.lenientOutput===true)));}}
  const builtins = { systemPrompt: prompt.default, tools: BridgeTools };
  const plan=options.plan??{};
  // The browser screen talks to the plugin through the connection and typert services; they are mounted only for a package that has a screen.
  const uiServices=options.uiBackend===true?['connection','typert']:[];
  const requiredServices=[...new Set([...options.services,...uiServices,...(plan.host?.services??[]),...(plan.capabilities?.hostRuntime?.services??[]),...(plan.hostRuntime?.services??[])])];
  const selected=selectModules(plan, {modules:options.modules===undefined?undefined:[...new Set([...options.modules,...uiServices])],services:requiredServices,...(options.interception===true?{interception:true}:{})},capabilities,hostModules);
  const supported=Object.fromEntries([...hostModules.values()].filter(m=>m.descriptor.officialPackage).map(m=>[m.descriptor.services[0],m.descriptor.officialPackage]));
  if (!Array.isArray(options.services)) throw error('services must be a list of supported official services', 'INVALID_CONFIGURATION');
  for(const name of options.services)if(!hostModules.has(name)&&![...hostModules.values()].some(m=>m.descriptor.services.includes(name)))throw error(`No official service adapter was selected for ${name}`,'HOST_SERVICE_UNSUPPORTED',[{feature:name,reason:'No service composition was selected'}]);
  const services = [...new Set([...options.services.filter(name=>Object.hasOwn(supported,name)),...selected.filter(row=>hostModules.get(row.id)?.descriptor.officialPackage).flatMap(row=>row.services)])];
  for (const name of services) {
    if (!Object.hasOwn(supported, name)) throw error(`No official service adapter was selected for ${name}`, 'HOST_SERVICE_UNSUPPORTED', [{ feature: name, reason: 'No service composition was selected' }]);
    const module = await load(supported[name]); builtins[name] = module.default;
    if (name === 'fs' && options.sandboxed && process.platform === 'win32' && typeof module.default === 'function') builtins[name] = sandboxedLocalFs(module.default);
  }
  if (services.includes('settings')) builtins.configEditor = (await load('@deepseek-ai/dsh-config-editor')).default;
  if (services.includes('webServer')) {
    const OfficialWebServer = builtins.webServer;
    builtins.webServer = class ObservedWebServer extends OfficialWebServer {
      register(route) {
        const dispose = super.register(route), key = `${route.kind}:${route.path}`;
        routeRows.set(key, { kind: route.kind, path: route.path });
        return () => { routeRows.delete(key); return dispose(); };
      }
      registerUpgrade(route) {
        const dispose = super.registerUpgrade(route), key = `upgrade:${route.path}`;
        routeRows.set(key, { kind: 'upgrade', path: route.path });
        return () => { routeRows.delete(key); return dispose(); };
      }
    };
  }
  // The profile, bundle and boot names (codex-bridge, codex-host-bundle, dsh-codex-host) are kept from the first version:
  // installed plugins already keep their state under them.
  const home = options.stateDir, dir = join(home, 'profiles', 'codex-bridge');
  await mkdir(join(home, 'compiled'), { recursive: true });
  // One plugin entry (the normal case), or several for a bundle whose cordis.patch.yml mounts more than one row
  // (settings.entries: [{ id, entry, config }]). Each entry is compiled/loaded on its own and becomes its own Cordis plugin.
  const entryDefs = Array.isArray(options.entries) && options.entries.length ? options.entries : null;
  const targets = [], sourceLoaderNames = new Map();
  const loadTarget = async ({ entry, builtin, label, precompiledId, id, config }) => {
    const outfile = join(home, 'compiled', precompiledId === undefined ? 'plugin.mjs' : `plugin-${precompiledId}.mjs`);
    const precompiled = typeof options.precompiledEntry === 'string' && await installPrecompiledEntry(options.precompiledEntry, outfile, precompiledId === undefined ? { entry } : { entry, id: precompiledId });
    if (!precompiled) await compileEntry(entry, outfile, hostRequire);
    const targetModule = await import(`${pathToFileURL(outfile).href}?host=${randomUUID()}`);
    // The plugin's generated remote-method declaration (TYPERT) is registered with the typert service when its context starts.
    let typertManifest;
    if (options.uiBackend === true) {
      typertManifest = targetModule.TYPERT;
      // Published plugins may ship the generated host face as an explicit package export rather than re-exporting it from their main entry.
      if (!typertManifest) {
        let packageMetadata;
        try { packageMetadata = JSON.parse(await readFile(join(options.sourceRoot, 'package.json'), 'utf8')); } catch (cause) { if (cause.code !== 'ENOENT' && cause.code !== 'ERR_ACCESS_DENIED' && cause.code !== 'EACCES' && !(cause instanceof SyntaxError)) throw cause; }
        const exported = packageMetadata?.exports?.['./typert'], manifestEntry = typeof exported === 'string' ? exported : exported?.import ?? exported?.default;
        if (typeof manifestEntry === 'string') {
          const absolute = resolve(options.sourceRoot, manifestEntry), rel = relative(resolve(options.sourceRoot), absolute);
          if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw error('Typert export escapes source', 'INVALID_CONFIGURATION');
          const compiledManifest = join(home, 'compiled', `typert-${builtin}.mjs`);
          await compileEntry(absolute, compiledManifest, hostRequire);
          typertManifest = (await import(pathToFileURL(compiledManifest).href)).TYPERT;
        }
      }
    }
    const target = targetModule.apply ? targetModule : targetModule.default;
    if (!target || typeof target !== 'function' && typeof target.apply !== 'function') throw error(entryDefs ? `Plugin entry ${label} needs a Cordis apply export` : 'Plugin needs a Cordis apply export', 'UNSUPPORTED_ENTRY');
    sourceLoaderNames.set('cordis:'+builtin,target.name??options.entryId??label);
    const originalApply = typeof target === 'function' ? target : target.apply;
    // An entry that declares no inject but uses services (ctx.systemPrompt without `inject`) gets what static analysis found,
    // as its inject: Cordis refuses such a property otherwise. A service the host cannot map is still provided, as a placeholder that fails when called.
    const inferred = target.inject === undefined ? [...new Set((options.plan?.host?.services ?? []).filter(isKnownDshService))] : [];
    if (inferred.length) addCompat({ id: 'inject-inferred', entry: label, names: inferred });
    const originalInject = target.inject ?? inferred;
    const inject = Array.isArray(originalInject) ? [...originalInject, 'bridgeModulesReady'] : { ...originalInject, required: [...(originalInject.required ?? []), 'bridgeModulesReady'] };
    // Cordis only accepts a dispose function / promise / generator as the return value of apply(); see lib/compat/apply-result.mjs.
    // Claude Code host: a permission-model block while the plugin starts becomes the four-part notice (and the fatal message).
    const startupFailure = cause => { const translated = blockedFailure(cause, null); if (translated !== cause) startupBlocks.push(translated.blocked); return translated; };
    const guarded = value => value && typeof value.then === 'function' ? Promise.resolve(value).catch(cause => { throw startupFailure(cause); }) : value;
    builtins[builtin] = { ...target, inject, apply: (context, pluginConfig) => { let value; if (options.uiBackend === true) { markUiSourceContext(context); if (typertManifest && context.get('typert')) context.get('typert').register(typertManifest); } try { value = Reflect.apply(originalApply, target, [withSourceLoaderNames(context, sourceLoaderNames), pluginConfig]); } catch (cause) { throw startupFailure(cause); } return adaptApplyResult(guarded(value), note => addCompat({ id: 'apply-return-value', entry: label, kind: note.kind, keys: note.keys })); } };
    // A scoped package name (@scope/name) becomes scope-name instead of an invalid loader id.
    const entryId = id ?? entryIdFor(options.entryId ?? target.name ?? 'target-plugin');
    if (typeof entryId !== 'string' || !ENTRY_ID_PATTERN.test(entryId)) throw error('Plugin entry id is invalid', 'INVALID_CONFIGURATION');
    targets.push({ target, entryId, builtin, config });
  };
  if (entryDefs) {
    for (const [index, def] of entryDefs.entries()) {
      if (!def || typeof def.id !== 'string' || typeof def.entry !== 'string') throw error('settings.entries rows need an id and an entry', 'INVALID_CONFIGURATION');
      const missingEnv = new Set();
      const walkEnv = value => { if (Array.isArray(value)) value.forEach(walkEnv); else if (value && typeof value === 'object') { if (typeof value.$dshExpression === 'string') { for (const name of expressionEnvNames(value.$dshExpression)) if (process.env[name] === undefined) missingEnv.add(name); } else Object.values(value).forEach(walkEnv); } };
      walkEnv(def.config);
      const resolved = resolveConfigExpressions(def.config ?? {}, { env: process.env, onUnsupported: text => addCompat({ id: 'config-expression-unsupported', entry: def.id, names: expressionEnvNames(text) }) });
      const override = options.config && typeof options.config === 'object' && !Array.isArray(options.config) ? options.config[def.id] : undefined;
      if (missingEnv.size) addCompat({ id: 'config-env-missing', entry: def.id, names: [...missingEnv].sort() });
      await loadTarget({ entry: resolve(def.entry), builtin: `target${index}`, label: def.id, precompiledId: def.id, id: entryIdFor(def.id), config: override && typeof override === 'object' && !Array.isArray(override) ? { ...resolved, ...override } : resolved });
    }
    if (new Set(targets.map(item => item.entryId)).size !== targets.length) throw error('Plugin entry ids are not unique', 'INVALID_CONFIGURATION');
  } else await loadTarget({ entry: options.entry, builtin: 'target', label: 'target', config: options.config });
  builtins.bridgeModules={inject:['tools',...services],async apply(root){
    moduleRuntime=await installModules({root,selected,registry:hostModules,options:options.moduleConfig??options.moduleOptions??{},capabilities,requestHost,sessionQuery,load,emit:(name,...args)=>root.emit(name,...args),
      conversation,hostInfo:{plugin:pluginLabelOf(),currentFeature:()=>currentCall.getStore()?.tool},...(options.execViaHost?{execHost:execHostChannel()}:{})});
    scheduler=createToolScheduler(root.tools);root.provide('bridgeModulesReady',true);
  }};
  await writeFile(join(home, 'package.json'), '{"name":"dsh-codex-isolated-installation","private":true}\n', { mode: 0o600 });
  boot.initProfile(dir, ['codex-host-bundle']);
  const bundle = join(dir, 'node_modules', 'codex-host-bundle'); await mkdir(bundle, { recursive: true });
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'codex-host-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }), { mode: 0o600 });
  const rows = [{ id: 'system-prompt', name: 'cordis:systemPrompt', config: { includeHarnessIdentity: false, includeRuntimeContext: false } }, { id: 'tools', name: 'cordis:tools', config: { mode: 'native' } }];
  for (const name of services) {
    if (name === 'settings') rows.push({ id: 'config-editor', name: 'cordis:configEditor' });
    const config = name === 'fs' ? { cwd: options.workspace } : name === 'webServer' ? { host: '127.0.0.1', port: 0 } : {};
    Object.assign(config, options.serviceConfig[name] ?? {});
    if (name === 'webServer' && config.host !== '127.0.0.1' && config.host !== '::1') throw error('Bridge webServer must bind loopback', 'INVALID_CONFIGURATION');
    rows.push({ id: `host-${name}`, name: `cordis:${name}`, config });
    const descriptor=[...hostModules.values()].find(m=>m.descriptor.services.includes(name))?.descriptor;
    for(const [index,spec]of (descriptor?.companionPackages??[]).entries()){
      const key=`${name}Companion${index}`,loaded=await load(spec);builtins[key]=loaded.default??loaded;rows.push({id:`host-${name}-companion-${index}`,name:`cordis:${key}`,config:options.serviceConfig[spec]??{}});
    }
  }
  rows.push({id:'bridge-modules',name:'cordis:bridgeModules'});
  for (const item of targets) {
    if (rows.some(row => row.id === item.entryId)) throw error('Plugin entry id collides with a bridge service id', 'INVALID_CONFIGURATION');
    rows.push({ id: item.entryId, name: `cordis:${item.builtin}`, config: item.config });
  }
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]), { mode: 0o600 });
  // Keep persisted user edits; generated base rows are refreshed on each start.
  const rootFile = join(dir, 'cordis.yml'); await writeFile(rootFile, '[]\n', { mode: 0o600 });
  const profile = { name: 'codex-bridge', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: options.workspace, home, startedBundles: ['codex-host-bundle'], overlays: [], telemetryDisabledEnv: '1' };
  // The conversation the mod reports is the plugin's only session (read-only, since the plugin started).
  conversation = createConversationBridge({ emit: (name, ...args) => ctx.emit(name, ...args), requestHost }); sessionQuery = conversation.query;
  ctx = await boot.boot('dsh-codex-host', rootFile, boot.readProfilePatches('dsh-codex-host', profile), root => {
    ctx = root;
    root.provide('profileContext', profile);
    root.provide('sessionQuery', sessionQuery);
    // No DSH agent loop runs here: without the agents module, the agent list is empty.
    if(!selected.some(row=>row.id==='agents'))root.provide('agents', Object.freeze({ list: () => [] }));
    root.provide('webRuntime', Object.freeze({ trustedHosts: ['127.0.0.1', 'localhost', '[::1]'] }));
    // Actual official events, not a replacement registry or policy pipeline.
    root.on('tools/change', toolsChanged);
    if (options.uiBackend === true) uiEventJournal = createUiEventJournal({ context: root });
    root.on('system-prompt/change', () => { if (initialized) send({ event: 'promptChanged' }); });
    // The plugin may raise this on purpose: ctx.emit('bridge/notify', { level, text }). DSH itself has no notification service.
    root.on('bridge/notify', note => { if (initialized && note && typeof note.text === 'string') requestHost('ui.notify', { level: ['info', 'warning', 'error'].includes(note.level) ? note.level : 'info', text: note.text.slice(0, 2000) }).catch(() => {}); });
    Object.assign(root.loader.builtins, builtins);
  });
  // Every mounted entry must be active: a bundle that mounts a policy row (for example an approval gate) must not run without it.
  for (const { target, entryId } of targets) {
    const targetEntry = [...ctx.loader.entries()].find(e => e.options.id === entryId);
    await targetEntry?.fiber?.await();
    if (targetEntry?.fiber?.state !== activeState) {
      if (startupBlocks.length) throw Object.assign(error(blockedText(startupBlocks[0]), startupBlocks[0].code), { details: { blocked: startupBlocks } });
      const inject = target.inject ?? [];
      const required = Array.isArray(inject) ? inject : inject.required ?? [];
      const missing = required.filter(name => ctx.get(name) === undefined);
      throw error(`Plugin did not activate in the real DSH host (entry ${entryId}, state ${targetEntry?.fiber?.state ?? 'absent'})`, 'HOST_PLUGIN_INACTIVE', missing.map(name => ({ feature: `service:${name}`, reason: 'Official service is not mounted in this composition' })));
    }
  }
  if (options.uiBackend === true) uiStreams = createRemoteStreamRegistry({ open: async (params, signal, uplink) => {
    if (params.channel !== '/api' || typeof params.endpoint !== 'string' || params.endpoint.split('/').length !== 2) throw error('這個插件串流通道尚未接上，請使用已登記的遠端方法。', 'UI_BACKEND_UNSUPPORTED');
    const [namespace, method] = params.endpoint.split('/');
    const files = dispatchWorkspaceFilesStream({ ctx, namespace, method, args: params.payload?.args ?? {}, signal, workspace: options.workspace });
    if (files !== undefined) return files;
    return openTypert(ctx.get('typert'), { namespace, method, args: params.payload?.args ?? {} }, signal, uplink, ctx.get('connection')?.browserPeer);
  } });
  initialized = true;
  conversation.announce();
  return { tools: schemaTools(), metadata: await describe() };
}
/** Official local file service on Windows under the permission model: replacing an existing file copies its DACL and calls ReplaceFileW
 * through koffi, a native addon the worker may not load. Those two steps run in the host process (paths checked there). */
function sandboxedLocalFs(Base){
  const hostOp=async(op,a,b)=>{try{return await requestHost('fs.win32',{op,a,b});}catch(cause){const e=new Error(cause.message);e.code=cause.code&&!/^CLIENT_REQUEST_FAILED$/.test(cause.code)?cause.code:'EIO';throw e;}};
  return class SandboxedLocalFileSystem extends Base{
    constructor(...args){super(...args);this.internals={...(this.internals??{}),copyFileDacl:(source,destination)=>hostOp('copyDacl',source,destination),replaceFile:(replaced,replacement)=>hostOp('replace',replaced,replacement)};}
  };
}
/** Tool definitions: remember which tool runs (for notices) and turn known blocks into the four-part notice. */
function guardToolDefinition(definition){
  if(!definition||typeof definition.execute!=='function')return definition;
  const descriptors=Object.getOwnPropertyDescriptors(definition),original=definition.execute,name=String(definition.name??'');
  descriptors.execute={...descriptors.execute,value:async function(...args){
    try{return await currentCall.run({...currentCall.getStore(),tool:name},()=>Reflect.apply(original,this,args));}
    catch(cause){throw blockedFailure(cause,name);}
  }};
  return Object.create(Object.getPrototypeOf(definition),descriptors);
}
async function promptSections() {
  const assembly = await ctx.systemPrompt.assemble();
  return collectPromptSections(assembly.sections, modules.prompt.renderContextSections(assembly));
}
function listenerCounts() {
  const hooks = ctx.events?._hooks ?? {};
  const count = name => (hooks[name] ?? []).length;
  return { preExecute: count('tools/pre-execute'), postExecute: count('tools/post-execute'), sessionEvent: count('session/event'), agentCreated: count('agent/created') };
}
async function context() {
  const assembly = await ctx.systemPrompt.assemble();
  return { sections: assembly.sections, contexts: modules.prompt.renderContextSections(assembly), text: modules.prompt.renderPrompt(assembly), contextText: modules.prompt.renderContextSnapshot(assembly) };
}
async function describe() {
  const entries = [...ctx.loader.entries()].map(entry => ({ id: entry.options.id, state: entry.fiber?.state ?? null, active: entry.fiber?.state === activeState }));
  const versions = {};
  const hostRequire = createRequire(join(options.runtimeRoot, 'package.json'));
  for (const spec of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-app-boot']) versions[spec] = JSON.parse(await readFile(hostRequire.resolve(`${spec}/package.json`), 'utf8')).version;
  return {
    host: 'official-dsh-cordis', isolatedProcess: true, versions, entries, services: ['loader', 'profileContext', 'systemPrompt', 'tools', ...new Set([...options.services,...Object.keys(moduleRuntime?.services??{})])],
    lazyDependencies,compat:compatNotes,
    modules:moduleRuntime?.modules??[],moduleDiagnostics:moduleRuntime?.diagnostics??[],homeMode:options.homeMode??'isolated',lenientOutput:options.lenientOutput===true,
    context: await context(), toolsChanged: changes,
    webServer: ctx.get('webServer') ? { origin: ctx.webServer.getOrigin(), routes: [...routeRows.values()] } : null,
    claude: { listeners: listenerCounts(), commands: ctx.get('commands') ? ctx.commands.list(undefined).map(({ name, description }) => ({ name, description })) : [] },
    unsupported: [
      { feature: 'DSH chat UI', reason: 'No DSH frontend is mounted in Claude Code' },
      { feature: 'DSH Agent/Session lifecycle', reason: 'No DSH agent loop is created; model calls and sub-agents are delegated to Claude Code through reverse requests' },
      { feature: 'DSH command lifecycle logging', reason: 'Commands run through commands.run without a DSH Agent and are not written to a DSH session log' },
    ],
  };
}
/** Calls from the browser screen (lib/ui-server.mjs publicRpc). Settings, credentials and command calls go through the official services; nothing here lists conversations. */
async function dispatchUi(method, params, requestId) {
  if (!uiEventJournal || !uiStreams) throw error('這個插件沒有啟用畫面後端。', 'UI_BACKEND_UNSUPPORTED');
  if (method === 'ui.events.poll') return uiEventJournal.poll(params);
  if (method === 'ui.resources.file') {
    const controller = new AbortController(); active.set(requestId, controller);
    try { return encodeConnectionResult(await dispatchFileResourceCall({ ctx, params, signal: controller.signal, workspace: options.workspace })); } finally { active.delete(requestId); }
  }
  if (/^ui\.stream\.(open|read|send|end|cancel)$/.test(method)) {
    const controller = new AbortController(); active.set(requestId, controller);
    try { return await uiStreams.request(method, params, controller.signal); } finally { active.delete(requestId); }
  }
  if (method === 'ui.backend.describe') return { connection: describeConnection(ctx.get('connection')), typert: describeTypert(ctx.get('typert')) };
  if (method === 'ui.connection.call' || method === 'ui.typert.call') {
    const controller = new AbortController(); active.set(requestId, controller);
    try {
      const official = async ({ namespace, method, args }) => await dispatchWorkspaceFilesCall({ ctx, namespace, method, args, signal: controller.signal, workspace: options.workspace }) ?? await dispatchOfficialUiCall({ ctx, namespace, method, args, signal: controller.signal });
      if (method === 'ui.typert.call') return encodeConnectionResult(await official(params) ?? await callTypert(ctx.get('typert'), params, controller.signal));
      if (params.channel === '/api') {
        const endpoint = typeof params.endpoint === 'string' ? params.endpoint.split('/') : [];
        if (endpoint.length === 2) {
          const invocation = { namespace: endpoint[0], method: endpoint[1], args: params.payload?.args ?? {} };
          const supported = await official(invocation); if (supported !== undefined) return encodeConnectionResult(supported);
          try { return encodeConnectionResult(await callConnection(ctx.get('connection'), params, controller.signal)); }
          catch (cause) { if (cause.code !== 'UI_BACKEND_NOT_REGISTERED') throw cause; }
          return encodeConnectionResult(await callTypert(ctx.get('typert'), invocation, controller.signal));
        }
      }
      return encodeConnectionResult(await callConnection(ctx.get('connection'), params, controller.signal));
    } finally { active.delete(requestId); }
  }
  throw error('Unknown or unsupported DSH host RPC method', 'HOST_RPC_UNSUPPORTED');
}
async function dispatch(method, params, requestId) {
  if (method === 'initialize') return initialize(params);
  if (!initialized && method !== 'dispose') throw error('DSH host is not initialized', 'HOST_NOT_INITIALIZED');
  if (method === 'getTools') return schemaTools();
  if (method === 'describe') return describe();
  if (method === 'context') return context();
  if (/^ui\.(events|resources|stream|backend|connection|typert)\./.test(method)) return dispatchUi(method, params, requestId);
  if (method === 'commands.run') {
    const controller = new AbortController(); active.set(requestId, controller);
    try { return await runCommand(ctx, { name: params.name, args: params.args, signal: controller.signal }); } finally { active.delete(requestId); }
  }
  if (method === 'interception.pre') return interceptPre({ ctx, scopeTarget, tool: params.tool, input: params.input, callId: params.callId, sessionId: params.sessionId });
  if (method === 'interception.post') return interceptPost({ ctx, scopeTarget, tool: params.tool, input: params.input, result: params.result, callId: params.callId, sessionId: params.sessionId });
  if (method === 'prompt.sections') return promptSections();
  if (method === 'session.event') { if (!conversation) throw error('Conversation bridge is not ready', 'HOST_NOT_INITIALIZED'); return conversation.event(params); }
  if (method === 'restrictions') return blockedReporter?.list() ?? [];
  if (method === 'routes') return ctx.get('webServer') ? { origin: ctx.webServer.getOrigin(), routes: [...routeRows.values()] } : null;
  if (method === 'settings.describe') {
    if (!ctx.get('settings')) throw error('Official settings service is not mounted', 'HOST_SERVICE_UNAVAILABLE');
    return ctx.settings.describe({ redactSecrets: true });
  }
  if (method === 'settings.update') {
    if (!ctx.get('settings')) throw error('Official settings service is not mounted', 'HOST_SERVICE_UNAVAILABLE');
    await ctx.settings.update(params.namespace, params.values, params.expectedRevision); return { applied: true };
  }
  if (method === 'commands.list') {
    if (!ctx.get('commands')) throw error('Official commands service is not mounted', 'HOST_SERVICE_UNAVAILABLE');
    return ctx.commands.list(undefined);
  }
  if (method === 'skills.list' || method === 'skills.get') {
    if (!ctx.get('skills')) throw error('Official skill registry is not mounted', 'HOST_SERVICE_UNAVAILABLE');
    const lookup = { cwd: options.workspace };
    if (method === 'skills.list') return (await ctx.skills.list(lookup)).filter(skill => skill.invocation.modelInvocable);
    if (typeof params.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(params.name)) throw error('Invalid skill name', 'INVALID_CONFIGURATION');
    const skill = await ctx.skills.get(params.name, lookup);
    if (!skill || !skill.invocation.modelInvocable) throw error('Skill is absent or not model-invocable', 'HOST_SKILL_UNAVAILABLE');
    return skill;
  }
  if (method === 'dispatchEvent') {
    if (typeof params.name !== 'string' || !/^bridge\/[A-Za-z0-9_./-]+$/.test(params.name) || !Array.isArray(params.args)) throw error('Only explicitly namespaced bridge/* events can be forwarded without native DSH lifecycle objects', 'HOST_EVENT_UNSUPPORTED');
    await ctx.parallel(params.name, ...params.args); return { dispatched: true, name: params.name, origin: 'bridge' };
  }
  if (method === 'execute') {
    const controller = new AbortController(); active.set(requestId, controller);
    try {
      const callId=params.callId??randomUUID();
      const agent=createClaudeBridgeAgent({root:ctx,callId,requestId,args:params.args});
      const exec={callId,name:params.name,arguments:params.args,agent,signal:controller.signal};
      // The blocks this call hit travel back with its answer (the mod may ask to trust the plugin and run it again).
      const call={callId,blocked:[]};
      let result;
      try{result = await scheduler.run(exec,scheduled=>currentCall.run(call,()=>ctx.tools.execute(scheduled)),{signal:controller.signal});}
      catch(cause){if(call.blocked.length&&cause&&typeof cause==='object'){try{cause.details={...(cause.details&&typeof cause.details==='object'?cause.details:{}),blocked:call.blocked};}catch{}}throw cause;}
      return {
        ...(call.blocked.length?{blocked:call.blocked}:{}),
        content: result.content, isError: result.isError,
        ...(result.isError ? {} : result.value && typeof result.value === 'object' && !Array.isArray(result.value) ? { structuredContent: result.value } : {}),
        ...(result.meta === undefined ? {} : { _meta: { dsh: result.meta } }),
        // Additional contexts are real DSH data; expose them as explicit metadata,
        // never silently claim they were injected into the Claude Code conversation.
        ...(result.additionalContexts?.length ? { _meta: { dshAdditionalContexts: result.additionalContexts, ...(result.meta === undefined ? {} : { dsh: result.meta }) } } : {}),
      };
    } finally { active.delete(requestId); }
  }
  if (method === 'dispose') { initialized = false; conversation?.dispose(); conversation = null; for (const controller of active.values()) controller.abort();scheduler?.dispose();cancelBridges();await uiStreams?.dispose();await uiEventJournal?.dispose();await moduleRuntime?.dispose(); await ctx?.fiber.dispose(); await sessionQuery?.close(); return { disposed: true }; }
  throw error('Unknown or unsupported DSH host RPC method', 'HOST_RPC_UNSUPPORTED');
}
process.on('message', async message => {
  if (!message || typeof message !== 'object') return;
  if(message.execEvent){const event=message.execEvent,handler=execSessions.get(event.id);if(!handler)return;if(event.type==='exit'||event.type==='error')execSessions.delete(event.id);try{handler(event);}catch{}return;}
  if(message.bridgeResponse){const response=message.bridgeResponse;bridgePending.get(response.id)?.finish(response.error?error(response.error.message,response.error.code):null,response.result);return;}
  if (message.method === 'cancel') { active.get(message.params?.requestId)?.abort(); return; }
  try { const result = await dispatch(message.method, message.params ?? {}, message.id); send({ id: message.id, result }); }
  catch (cause) {
    // Startup failures carry what the host needs to name the missing setting (compat notes hold only names, never values).
    const details = message.method === 'initialize' ? { compat: compatNotes, blocked: startupBlocks, ...(cause.details && typeof cause.details === 'object' ? cause.details : {}) } : cause.details;
    let safeDetails; try { safeDetails = details === undefined ? undefined : JSON.parse(JSON.stringify(details)); } catch {}
    send({ id: message.id, error: { message: cause.message, code: cause.code ?? 'DSH_HOST_ERROR', unsupported: cause.unsupported ?? [], ...(safeDetails === undefined ? {} : { details: safeDetails }) } });
  }
});
// Under the permission model a plugin may hit ERR_ACCESS_DENIED outside a tool call (timers, events). That is reported, not a crash.
// Installed only for a sandboxed worker; every other worker keeps Node's default (print and exit 1).
function installSandboxGuards(){
  // Node's existsSync throws ERR_ACCESS_DENIED for a path outside the allowed folders instead of answering false, which breaks
  // ordinary "look upward for node_modules / package.json" probing (the official profile loader does it). existsSync is documented
  // never to throw, so a denied path answers false; reading that path still fails (and is reported).
  const originalExists = fsSync.existsSync;
  fsSync.existsSync = function existsSync(target) { try { return originalExists(target); } catch (cause) { if (cause?.code === 'ERR_ACCESS_DENIED') return false; throw cause; } };
  // The JavaScript realpath walks every segment from the drive root (lstat "C:\"), which is outside the allowed folders even for
  // an allowed path. The native variant asks the OS about the path itself; it is used when the walk is denied.
  const realpathJs = fsSync.realpathSync, realpathNative = fsSync.realpathSync.native;
  fsSync.realpathSync = Object.assign(function realpathSync(target, options) { try { return realpathJs(target, options); } catch (cause) { if (cause?.code === 'ERR_ACCESS_DENIED') return realpathNative(target, options); throw cause; } }, { native: realpathNative });
  const realpathCb = fsSync.realpath, realpathCbNative = fsSync.realpath.native;
  fsSync.realpath = Object.assign(function realpath(target, options, callback) {
    const done = typeof options === 'function' ? options : callback, opts = typeof options === 'function' ? undefined : options;
    try { return realpathCb(target, opts, (cause, value) => cause?.code === 'ERR_ACCESS_DENIED' ? realpathCbNative(target, opts, done) : done(cause, value)); }
    catch (cause) { if (cause?.code === 'ERR_ACCESS_DENIED') return realpathCbNative(target, opts, done); throw cause; }
  }, { native: realpathCbNative });
  // Node disables every file-descriptor based chmod/chown/utimes under the permission model ("fchmod API is disabled"), because it
  // cannot tell which file a descriptor is. The official file service (dsh-fs-local atomic write) calls FileHandle.chmod on the file
  // it just created. Remember which path a handle / descriptor was opened from and apply the same change by path (checked normally).
  const handlePaths = new WeakMap(), fdPaths = new Map();
  const openPromise = fsSync.promises.open;
  let handlePatched = false;
  fsSync.promises.open = async function open(target, ...rest) {
    const handle = await openPromise(target, ...rest);
    if (typeof target === 'string' || target instanceof URL) handlePaths.set(handle, target instanceof URL ? fileURLToPathSafe(target) : target);
    if (!handlePatched) {
      handlePatched = true;
      const proto = Object.getPrototypeOf(handle);
      for (const [method, byPath] of [['chmod', (p, a) => fsSync.promises.chmod(p, ...a)], ['utimes', (p, a) => fsSync.promises.utimes(p, ...a)], ['chown', (p, a) => fsSync.promises.chown(p, ...a)]]) {
        const original = proto[method];
        if (typeof original !== 'function') continue;
        proto[method] = async function (...args) {
          try { return await Reflect.apply(original, this, args); }
          catch (cause) { const known = handlePaths.get(this); if (cause?.code === 'ERR_ACCESS_DENIED' && known) return byPath(known, args); if (cause?.code === 'ERR_ACCESS_DENIED') { cause.operation = `FileHandle.${method}`; } throw cause; }
        };
      }
    }
    return handle;
  };
  const openSync = fsSync.openSync, closeSync = fsSync.closeSync;
  fsSync.openSync = function openSync_(target, ...rest) { const fd = Reflect.apply(openSync, this, [target, ...rest]); if (typeof target === 'string') fdPaths.set(fd, target); return fd; };
  fsSync.closeSync = function closeSync_(fd) { fdPaths.delete(fd); return Reflect.apply(closeSync, this, [fd]); };
  for (const [name, byPath] of [['fchmodSync', (p, a) => fsSync.chmodSync(p, ...a)], ['futimesSync', (p, a) => fsSync.utimesSync(p, ...a)], ['fchownSync', (p, a) => fsSync.chownSync(p, ...a)]]) {
    const original = fsSync[name];
    fsSync[name] = function (fd, ...args) { try { return Reflect.apply(original, this, [fd, ...args]); } catch (cause) { if (cause?.code === 'ERR_ACCESS_DENIED' && fdPaths.has(fd)) return byPath(fdPaths.get(fd), args); if (cause?.code === 'ERR_ACCESS_DENIED') cause.operation = name.replace(/Sync$/, ''); throw cause; } };
  }
  // Plugins often catch errors of child_process / fs calls themselves (for example "uv is not installed"), so the block would
  // never reach a tool result. Report it where it is raised; the plugin then gets the four-part notice as the error message.
  const denied = cause => cause?.code === 'ERR_ACCESS_DENIED' || cause?.code === 'ERR_DLOPEN_DISABLED';
  const feature = () => currentCall.getStore()?.tool ?? (initialized ? '插件的背景工作' : null);
  const wrap = (target, name, gate) => {
    const original = target?.[name];
    if (typeof original !== 'function' || original.__sandboxWrapped) return;
    const wrapped = function (...args) {
      let value;
      // Some denials carry no resource (for example descriptor based calls): keep the operation and the path argument for the notice.
      const note = cause => { if (denied(cause) && !cause.resource) { try { cause.operation ??= name; if (typeof args[0] === 'string' && cause.attemptedPath === undefined) cause.attemptedPath = args[0]; } catch {} } return cause; };
      try { value = Reflect.apply(original, this, args); } catch (cause) { note(cause); throw denied(cause) && gate() ? blockedFailure(cause, feature()) : cause; }
      if (value && typeof value.then === 'function' && typeof value.catch === 'function') return value.catch(cause => { note(cause); throw denied(cause) && gate() ? blockedFailure(cause, feature()) : cause; });
      return value;
    };
    Object.defineProperty(wrapped, '__sandboxWrapped', { value: true });
    Object.defineProperty(wrapped, 'name', { value: original.name });
    // Keep attached members such as realpathSync.native and custom promisify symbols.
    for (const key of Reflect.ownKeys(original)) if (!['length', 'name', 'prototype', 'arguments', 'caller'].includes(key) && !Object.hasOwn(wrapped, key)) { try { Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(original, key)); } catch {} }
    try { target[name] = wrapped; } catch { /* read-only export */ }
  };
  const always = () => true, afterStart = () => initialized || currentCall.getStore() !== undefined;
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) wrap(childProcessModule, name, always);
  for (const name of Object.keys(fsSync)) if (/Sync$/.test(name) && name !== 'existsSync') wrap(fsSync, name, afterStart);
  for (const name of Object.keys(fsSync.promises)) wrap(fsSync.promises, name, afterStart);
  syncBuiltinESMExports();
  for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, cause => {
    if (cause?.code === 'ERR_ACCESS_DENIED' || cause?.code === 'ERR_DLOPEN_DISABLED') { const translated = blockedFailure(cause, null); try { process.stderr.write(`[sandbox] ${String(translated.message).split(/\r?\n/)[0]}\n`); } catch {} return; }
    try { process.stderr.write(`${event === 'uncaughtException' ? 'Uncaught' : 'Unhandled rejection'}: ${cause?.stack ?? cause}\n`); } catch {}
    process.exit(1);
  });
}
process.on('disconnect', () => { for (const controller of active.values()) controller.abort();scheduler?.dispose();cancelBridges();void (async()=>{try{await uiStreams?.dispose();await uiEventJournal?.dispose();await moduleRuntime?.dispose();await ctx?.fiber.dispose();await sessionQuery?.close();}finally{process.exit(0);}})(); });
