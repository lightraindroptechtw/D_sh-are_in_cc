/** Isolated process adapter for pinned, unmodified official DSH host services. */
import { fork } from 'node:child_process';
import { lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installVersionAliases, linkScope, removeAliasedScope } from './compat/version-alias.mjs';

export class DshHostError extends Error {
  constructor(message, code = 'DSH_HOST_ERROR', unsupported = [], details) { super(message); this.name = 'DshHostError'; this.code = code; this.unsupported = unsupported; if (details !== undefined) this.details = details; }
}
function jsonClone(value, label) {
  const seen = new Set();
  const walk = v => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v) && !Object.is(v, -0)) return;
    if (!v || typeof v !== 'object' || seen.has(v) || !Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v))) throw new TypeError(`${label} must be lossless JSON`);
    if (Object.getOwnPropertySymbols(v).length || Array.isArray(v) && Object.keys(v).length !== v.length) throw new TypeError(`${label} must be lossless JSON`);
    seen.add(v);
    for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && key === 'length') continue;
      if (!d.enumerable || !('value' in d)) throw new TypeError(`${label} cannot contain accessors or hidden fields`);
      walk(d.value);
    }
    seen.delete(v);
  };
  walk(value); return JSON.parse(JSON.stringify(value));
}
/** Node permission model flag of this Node.js (`--permission` from 22.13/23.5, `--experimental-permission` before), or null. */
export function permissionFlag(flags = process.allowedNodeEnvironmentFlags) {
  if (flags?.has?.('--permission')) return '--permission';
  if (flags?.has?.('--experimental-permission')) return '--experimental-permission';
  return null;
}
/** execArgv of a worker under the Node permission model. `permission`: { read, write, childProcess, worker, addons, wasi }. */
export function permissionArgs(permission, flag = permissionFlag()) {
  if (!permission || !flag) return [];
  const unique = list => [...new Set((list ?? []).filter(p => typeof p === 'string' && p && isAbsolute(p)).map(p => resolve(p)))];
  return [flag, ...unique(permission.read).map(p => `--allow-fs-read=${p}`), ...unique(permission.write).map(p => `--allow-fs-write=${p}`),
    ...(permission.childProcess ? ['--allow-child-process'] : []), ...(permission.worker ? ['--allow-worker'] : []),
    ...(permission.addons ? ['--allow-addons'] : []), ...(permission.wasi ? ['--allow-wasi'] : [])];
}
/** The worker cannot create links under the permission model (fs.symlink needs full access), so the host prepares the
 * managed SDK scope link (.../compiled/node_modules/@deepseek-ai) that the worker would otherwise create itself. */
async function prepareSdkScope({ home, runtime, versionAliases }) {
  const moduleDir = join(home, 'compiled', 'node_modules'); await mkdir(moduleDir, { recursive: true });
  const scopeLink = join(moduleDir, '@deepseek-ai'), scopeDirectory = join(runtime, 'node_modules', '@deepseek-ai');
  if (Array.isArray(versionAliases) && versionAliases.length) return { aliases: await installVersionAliases({ scopeLink, scopeDirectory, aliases: versionAliases }) };
  try { const info = await lstat(scopeLink); if (info.isDirectory() && !info.isSymbolicLink()) await removeAliasedScope(scopeLink); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  let ready = false;
  try {
    const info = await lstat(scopeLink);
    if (!info.isSymbolicLink()) throw new DshHostError('Managed SDK resolution path is occupied', 'HOST_STATE_CONFLICT');
    let matches = false; try { matches = await realpath(scopeLink) === await realpath(scopeDirectory); } catch {}
    if (!matches) await unlink(scopeLink); else ready = true;
  } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  if (!ready) await linkScope(scopeDirectory, scopeLink);
  return { aliases: [] };
}
const OS_ENV = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'LANG', 'LC_ALL'];
// Windows supplies names such as ProgramFiles(x86); shell identifiers are too restrictive.
const validEnvironmentName = name => typeof name === 'string' && name.length > 0 && !/[=\0]/.test(name);

/**
 * Source is trusted and can execute arbitrary Node.js: process isolation protects
 * host state/environment, not the filesystem or the network. No model provider is mounted.
 */
export async function loadDshHost(options = {}) {
  const { entry, config = {}, stateDir, sourceRoot = entry && dirname(resolve(entry)), runtimeRoot = fileURLToPath(new URL('../', import.meta.url)), workerPath = fileURLToPath(new URL('./dsh-host-worker.mjs', import.meta.url)), timeout, initializeTimeoutMs = timeout ?? 120000, callTimeoutMs = timeout ?? 60000, cancelGraceMs = 1000, homeMode = 'isolated', logger, env = {}, passEnv = [] } = options;
  if (!entry || !stateDir) throw new TypeError('loadDshHost requires entry and a dedicated stateDir');
  for (const [key, value] of Object.entries({ initializeTimeoutMs, callTimeoutMs, cancelGraceMs, ...(timeout === undefined ? {} : { timeout }) })) if (!Number.isFinite(value) || value <= 0 || value > 2 ** 31 - 1) throw new TypeError(`${key} must be a positive bounded number`);
  if (!['isolated', 'real'].includes(homeMode)) throw new TypeError('homeMode must be isolated or real');
  const home = resolve(stateDir), runtime = resolve(runtimeRoot);
  await mkdir(home, { recursive: true });
  const homeKeys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'HOMEDRIVE', 'HOMEPATH'];
  const childEnv = {};
  for (const key of [...OS_ENV, ...(homeMode === 'real' ? homeKeys : [])]) if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  if (!Array.isArray(passEnv) || passEnv.some(k => !validEnvironmentName(k))) throw new TypeError('passEnv must contain environment variable names');
  for (const key of passEnv) if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (!validEnvironmentName(key) || typeof value !== 'string' || value.includes('\0')) throw new TypeError('env must map environment variable names to strings without NUL characters');
    childEnv[key] = value;
  }
  // Explicit passEnv/env cannot re-enable runtime injection or escape isolated home lookup.
  const blockedEnv=new Set(['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'CORDIS_SHARED', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES']);
  for (const key of Object.keys(childEnv)) if(blockedEnv.has(key.toUpperCase()))delete childEnv[key];
  if (homeMode === 'isolated') {
    const homeEnv=new Set(homeKeys);
    for (const key of Object.keys(childEnv)) if(homeEnv.has(key.toUpperCase()))delete childEnv[key];
    Object.assign(childEnv, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'), XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state') });
  }
  Object.assign(childEnv, { DSH_HOME: home, DSH_HOST_MODULES: join(runtime, 'node_modules', '@deepseek-ai'), DSH_TELEMETRY_DISABLED: '1', TEMP: join(home, 'tmp'), TMP: join(home, 'tmp') });
  await Promise.all(['tmp', 'appdata', 'localappdata', 'config', 'cache', 'data', 'state'].map(p => mkdir(join(home, p), { recursive: true })));
  // Node permission model (only when the host passes `permission`).
  const sandboxArgs = permissionArgs(options.permission);
  const sdkScope = sandboxArgs.length ? await prepareSdkScope({ home, runtime, versionAliases: options.versionAliases }) : null;
  const payload = jsonClone({
    entry: resolve(entry), config, stateDir: home, sourceRoot: resolve(sourceRoot), runtimeRoot: runtime,
    workspace: resolve(options.workspace ?? sourceRoot), services: options.services ?? ['timer', 'fs', 'settings', 'webServer', 'commands', 'skills'],
    serviceConfig: options.serviceConfig ?? {}, ...(options.entryId ? { entryId: options.entryId } : {}),
    homeMode,
    ...(options.modules === undefined ? {} : { modules: options.modules }),
    ...(options.moduleConfig === undefined ? {} : { moduleConfig: options.moduleConfig }),
    ...(options.lenientOutput === undefined ? {} : { lenientOutput: options.lenientOutput }),
    ...(options.sourceNodePaths === undefined ? {} : { sourceNodePaths: options.sourceNodePaths }),
    ...(options.nodePaths === undefined ? {} : { nodePaths: options.nodePaths }),
    ...(options.plan === undefined ? {} : { plan: options.plan }),
    ...(options.moduleOptions === undefined ? {} : { moduleOptions: options.moduleOptions }),
    // The package has a browser screen: the worker also mounts the connection and typert services it needs.
    ...(options.uiBackend === true ? { uiBackend: true } : {}),
    ...(options.interception === undefined ? {} : { interception: options.interception }),
    ...(options.precompiledEntry === undefined ? {} : { precompiledEntry: resolve(options.precompiledEntry) }),
    // A bundle whose patch mounts several plugin entries: [{ id, entry (relative to the source root), config }], see lib/compat/dsh-expression.mjs for config values.
    ...(Array.isArray(options.entries) && options.entries.length ? { entries: options.entries.map(row => ({ ...row, entry: resolve(sourceRoot, row.entry) })) } : {}),
    ...(Array.isArray(options.versionAliases) && options.versionAliases.length ? { versionAliases: options.versionAliases.map(({ name, version }) => ({ name, version })) } : {}),
    ...(typeof options.pluginLabel === 'string' ? { pluginLabel: options.pluginLabel } : {}),
    ...(typeof options.execHandler === 'function' ? { execViaHost: true } : {}),
    ...(sdkScope ? { sdkScopePrepared: { aliases: sdkScope.aliases }, compileViaHost: true, sandboxed: true } : {}),
  }, 'host configuration');
  // Requests from the worker that this process answers itself (never forwarded to the client).
  const localRequests = {
    ...(options.localRequests && typeof options.localRequests === 'object' ? options.localRequests : {}),
    async 'host.compileEntry'(params) {
      if (!sdkScope) throw new DshHostError('Compilation in the host process is only used under the permission model', 'HOST_RPC_UNSUPPORTED');
      const entryFile = resolve(String(params.entry ?? '')), outfile = resolve(String(params.outfile ?? ''));
      const inside = (base, file) => { const rel = relative(base, file); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); };
      const allowedEntry = inside(payload.sourceRoot, entryFile) || entryFile === payload.entry;
      if (!allowedEntry || !inside(join(home, 'compiled'), outfile)) throw new DshHostError(`Compile request outside the plugin source or the compiled folder (${entryFile} -> ${outfile})`, 'INVALID_CONFIGURATION');
      const { compileDshEntry } = await import('./precompile-entry.mjs');
      const requireFromHost = createRequire(join(runtime, 'package.json'));
      const esbuild = await import(pathToFileURL(requireFromHost.resolve('esbuild')).href);
      const lazy = [], compat = [];
      await compileDshEntry({ esbuild, requireFromHost, entry: entryFile, outfile, sourceRoot: payload.sourceRoot,
        nodePaths: [...(payload.sourceNodePaths ?? payload.nodePaths ?? []).map(path => resolve(payload.sourceRoot, path)), join(runtime, 'node_modules')], portable: false,
        onLazyDependency: row => lazy.push({ specifier: row.specifier, kind: row.kind, mode: row.mode }),
        onCompat: row => compat.push({ package: row.package, olderRelease: row.olderRelease, provides: row.provides }) });
      return { lazyDependencies: lazy, compat };
    },
  };
  let sequence = 0, disposed = false, connection, current, recovery;
  const listeners = new Set(), promptListeners = new Set();
  const emitChanged = () => { for (const listener of listeners) { try { listener(); } catch {} } };
  const wrapTools = schemas => (schemas ?? []).map(schema => ({ ...schema, execute: (args = {}, execution = {}) => rpc('execute', { name: schema.name, args: jsonClone(args, 'tool arguments'), ...(execution.callId !== undefined ? { callId: execution.callId } : {}), ...(execution.clientCapabilities === undefined ? {} : { clientCapabilities: jsonClone(execution.clientCapabilities, 'client capabilities') }) }, { ...execution, timeoutMs: schema.timeoutMs ?? callTimeoutMs }) }));
  function cleanup(slot) { clearTimeout(slot.timer); clearTimeout(slot.killTimer); slot.removeAbort?.(); }
  function settle(g, id, cause, result) { const slot = g.pending.get(id); if (!slot) return; g.pending.delete(id); cleanup(slot); slot.controller.abort(); cause ? slot.reject(cause) : slot.resolve(result); }
  function rejectAll(g, cause) { for (const id of [...g.pending.keys()]) settle(g, id, cause); for (const c of g.bridges.values()) c.abort(); g.bridges.clear(); }
  function send(g, message) { if (g.exited || !g.child.connected) throw new DshHostError('DSH host is disconnected', 'HOST_EXITED'); g.child.send(message, cause => { if (cause && !g.exited) rejectAll(g, new DshHostError('DSH host IPC failed', 'HOST_IPC_ERROR')); }); }
  function update(initial) { if (connection) { connection.tools = wrapTools(initial.tools); connection.metadata = initial.metadata; connection.unsupported = initial.metadata?.unsupported ?? []; emitChanged(); } }
  function restart(g, triggerId, code) {
    if (g !== current || disposed || g.restarting) return;
    g.restarting = true;
    // Publish recovery before rejecting callers; their next call awaits the new initialized worker.
    recovery = (async () => { await stop(g); if (disposed) return; const fresh = launch(); const initial = await direct(fresh, 'initialize', payload, { timeoutMs: initializeTimeoutMs }); update(initial); })();
    recovery.catch(() => {});
    for (const id of [...g.pending.keys()]) settle(g, id, new DshHostError(id === triggerId ? 'DSH host request did not stop after cancellation; host restarted' : 'DSH host restarted while this request was active; request was not retried', id === triggerId ? code : 'HOST_RESTARTED'));
    for (const c of g.bridges.values()) c.abort();g.bridges.clear();
  }
  async function stop(g) { if (!g || g.closed) return; await new Promise((resolveStop,rejectStop) => { const timer = setTimeout(()=>rejectStop(new DshHostError('Worker resources did not close after shutdown','HOST_STOP_TIMEOUT')),5000); g.child.once('close', () => { clearTimeout(timer); resolveStop(); }); if(!g.exited)g.child.kill(); }); }
  async function bridge(g, message) {
    const slot = g.pending.get(message.requestId), controller = new AbortController();
    const key = message.id;g.bridges.set(key, controller);
    const abort = () => controller.abort();slot?.controller.signal.addEventListener('abort', abort, { once: true });
    try {
      if (slot?.controller.signal.aborted) controller.abort();
      const local = Object.hasOwn(localRequests, message.method) ? (_method, params) => localRequests[message.method](params) : null;
      const callback = local ?? slot?.requestClient ?? options.bridgeRequest;
      if (typeof callback !== 'function') throw new DshHostError('No client request bridge is available', 'CLIENT_CAPABILITY_UNAVAILABLE');
      if (controller.signal.aborted) throw new DshHostError('Client request canceled', 'HOST_CANCELED');
      const result = await callback(message.method, message.params ?? {}, { signal: controller.signal });
      if (!controller.signal.aborted && !g.exited) send(g, { bridgeResponse: { id: key, result: jsonClone(result, 'client response') } });
    } catch (cause) { if (!g.exited) { try { send(g, { bridgeResponse: { id: key, error: { message: cause.message, code: cause.code ?? 'CLIENT_REQUEST_FAILED' } } }); } catch {} } }
    finally { slot?.controller.signal.removeEventListener('abort', abort);g.bridges.delete(key); }
  }
  function launch() {
    const child = fork(resolve(workerPath), [], { cwd: home, env: childEnv, execArgv: sandboxArgs, windowsHide: true, serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const g = { child, exited: false, closed:false, restarting: false, pending: new Map(), bridges: new Map(), execs: new Map() };current = g;
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => { if (typeof logger === 'function') logger({ stream, text: chunk.toString('utf8') }); });
    child.on('error', () => rejectAll(g, new DshHostError('Cannot start the isolated DSH host process', 'HOST_START_FAILED')));
    child.on('exit', (code, signal) => { g.exited = true; for (const session of g.execs.values()) { try { session.kill(500); } catch {} } g.execs.clear(); rejectAll(g, new DshHostError(`Isolated DSH host exited (${signal ?? code})`, 'HOST_EXITED')); });
    child.on('close',()=>{g.closed=true;});
    child.on('message', message => {
      if (!message || typeof message !== 'object' || g !== current || g.restarting) return;
      if (message.event === 'bridgeRequest') { void bridge(g, message);return; }
      if (message.event === 'exec') { handleExec(g, message); return; }
      if (message.event === 'promptChanged') { for (const listener of promptListeners) { try { listener(); } catch {} } return; }
      if (message.event === 'toolsChanged') { if (connection) connection.tools = wrapTools(message.tools);emitChanged();return; }
      const slot = g.pending.get(message.id);if (!slot) return;
      const cause = slot.cancelCode === 'HOST_TIMEOUT' ? new DshHostError('DSH host request timed out', 'HOST_TIMEOUT') : message.error ? new DshHostError(message.error.message, message.error.code, message.error.unsupported, message.error.details) : slot.cancelCode && !message.result?.isError ? new DshHostError('DSH host request canceled', slot.cancelCode) : null;
      settle(g, message.id, cause, message.result);
    });return g;
  }
  /** Programs the worker asks this process to run (`options.execHandler`, Claude Code host): start / write / end / kill, events back as execEvent. */
  function handleExec(g, message) {
    const id = typeof message.id === 'string' ? message.id : null;
    if (!id) return;
    const reply = event => { try { if (!g.exited) send(g, { execEvent: { id, ...event } }); } catch {} if (event.type === 'exit' || event.type === 'error') g.execs.delete(id); };
    if (message.op === 'start') {
      if (typeof options.execHandler !== 'function') { reply({ type: 'error', code: 'HOST_RPC_UNSUPPORTED', message: 'This host does not run programs for the worker' }); return; }
      if (g.execs.has(id)) return;
      try { g.execs.set(id, options.execHandler(message.spec ?? {}, reply)); } catch (cause) { reply({ type: 'error', code: cause?.code ?? 'DSH_EXEC_FAILED', message: String(cause?.message ?? cause) }); }
      return;
    }
    const session = g.execs.get(id);
    if (!session) return;
    if (message.op === 'write') session.write(message.data);
    else if (message.op === 'end') session.end();
    else if (message.op === 'kill') session.kill(message.graceMs);
  }
  function direct(g, method, params = {}, execution = {}) {
    if (disposed && method !== 'dispose') return Promise.reject(new DshHostError('DSH host has been disposed', 'DISPOSED'));
    if (g.exited) return Promise.reject(new DshHostError('DSH host exited', 'HOST_EXITED'));
    if (execution.signal?.aborted) return Promise.reject(new DshHostError('DSH host request was canceled before dispatch', 'HOST_CANCELED'));
    const id = ++sequence;
    return new Promise((resolveRpc, rejectRpc) => {
      const slot = { resolve: resolveRpc, reject: rejectRpc, controller: new AbortController(), requestClient: execution.requestClient };
      const cancel = code => {
        if (!g.pending.has(id) || slot.cancelCode) return;slot.cancelCode = code;slot.controller.abort();
        try { send(g, { method: 'cancel', params: { requestId: id } }); } catch {}
        slot.killTimer = setTimeout(() => {
          if (method === 'initialize' || disposed) { settle(g, id, new DshHostError('DSH host request did not stop after cancellation', code));void stop(g); }
          else restart(g, id, code);
        }, cancelGraceMs);
      };
      slot.timer = setTimeout(() => cancel('HOST_TIMEOUT'), execution.timeoutMs ?? callTimeoutMs);
      if (execution.signal) { const abort = () => cancel('HOST_CANCELED');execution.signal.addEventListener('abort', abort, { once: true });slot.removeAbort = () => execution.signal.removeEventListener('abort', abort); }
      g.pending.set(id, slot);try { send(g, { id, method, params }); } catch (cause) { settle(g, id, cause); }
    });
  }
  async function rpc(method, params = {}, execution = {}) {
    if (disposed && method !== 'dispose') throw new DshHostError('DSH host has been disposed', 'DISPOSED');
    if (recovery && method !== 'dispose') await recovery;
    return direct(current, method, params, execution);
  }
  try {
    const g = launch(), initial = await direct(g, 'initialize', payload, { timeoutMs: initializeTimeoutMs });
    connection = {
      tools: wrapTools(initial.tools), metadata: initial.metadata, unsupported: initial.metadata?.unsupported ?? [],
      async getTools() { connection.tools = wrapTools(await rpc('getTools'));return connection.tools; },
      onToolsChanged(callback) { if (typeof callback !== 'function') throw new TypeError('callback must be a function');listeners.add(callback);return () => listeners.delete(callback); },
      onPromptChanged(callback) { if (typeof callback !== 'function') throw new TypeError('callback must be a function');promptListeners.add(callback);return () => promptListeners.delete(callback); },
      async describe() { connection.metadata = await rpc('describe');return connection.metadata; },
      context: () => rpc('context'), dispatchEvent: (name, args = []) => rpc('dispatchEvent', { name, args: jsonClone(args, 'event arguments') }),
      request: (method, params = {}, execution = {}) => rpc(method, jsonClone(params, 'host RPC arguments'), execution),
      async dispose() {
        if (disposed) return;disposed = true;listeners.clear();promptListeners.clear();
        for (const id of [...current.pending.keys()]) { const slot = current.pending.get(id);slot.controller.abort();try { send(current, { method: 'cancel', params: { requestId: id } }); } catch {}settle(current, id, new DshHostError('DSH host disposed during request', 'DISPOSED')); }
        try { if (!current.exited && !current.restarting) await direct(current, 'dispose', {}, { timeoutMs: cancelGraceMs }); } finally { rejectAll(current, new DshHostError('DSH host disposed', 'DISPOSED'));await stop(current);await recovery?.catch(() => {}); }
      },
    };return connection;
  } catch (cause) { disposed = true;if (current) { rejectAll(current, cause);await stop(current); }throw cause; }
}
