/** Shared support of the `shell` and `subprocess` modules of the Claude host:
 * workspace fencing, environment scrubbing, bounded output capture, process-tree kill,
 * and the per-execution approval request. Nothing here runs a command by itself. */
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {existsSync, realpathSync, statSync} from 'node:fs';
import path from 'node:path';
import {PassThrough, Writable} from 'node:stream';
import {argumentSummary, claudeError, disabledError, isDisabled, redactText} from './common.mjs';
import {blockedError, execDeniedNotice, pluginLabel} from './blocked.mjs';

/** Same heuristic as @deepseek-ai/dsh-subprocess `SENSITIVE_ENV_PATTERN` (kept local: no runtime dependency). */
export const SENSITIVE_ENV = /KEY|PASSWORD|SECRET|TOKEN/i;

/** The ambient environment minus credential-shaped names and every `DSH_*` name. */
export function scrubbedEnv(base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || SENSITIVE_ENV.test(key) || key.toUpperCase().startsWith('DSH_')) continue;
    env[key] = value;
  }
  return env;
}

/** Merge explicit entries after the scrub; `undefined` removes an entry. */
export function mergeEnv(extra, dshEnv) {
  const env = scrubbedEnv();
  for (const layer of [extra, dshEnv]) {
    if (!layer || typeof layer !== 'object') continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) delete env[key];
      else if (typeof value === 'string') env[key] = value;
    }
  }
  return env;
}

/** The workspace the Claude host fences commands into: profileContext.cwd, then DSH_CLAUDE_WORKSPACE. */
export function workspaceOf(root, env = process.env) {
  let profile;
  try { profile = root?.get?.('profileContext'); } catch { /* absent */ }
  const base = typeof profile?.cwd === 'string' && profile.cwd ? profile.cwd : env.DSH_CLAUDE_WORKSPACE;
  if (typeof base !== 'string' || !base || !path.isAbsolute(base)) return null;
  return path.resolve(base);
}

const real = target => { try { return realpathSync.native(target); } catch { return null; } };
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
/** Whether `dir` (existing) resolves inside `workspace`, symlinks and junctions included. */
export function insideWorkspace(workspace, dir) {
  const base = real(workspace), target = real(dir);
  if (!base || !target) return false;
  if (same(base, target)) return true;
  const rel = path.relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Resolve a requested working directory against the workspace; throws when it escapes. */
export function resolveWorkdir(module, method, workspace, requested) {
  if (!workspace) throw claudeError(module, method, '找不到工作目錄（DSH_CLAUDE_WORKSPACE 未設定），不執行指令', 'DSH_EXEC_NO_WORKSPACE');
  const dir = requested === undefined || requested === null || requested === '' ? workspace : path.resolve(workspace, String(requested));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw claudeError(module, method, '工作目錄不存在或不是資料夾', 'DSH_EXEC_BAD_CWD');
  if (!insideWorkspace(workspace, dir)) throw claudeError(module, method, '工作目錄必須在 DSH_CLAUDE_WORKSPACE 之內', 'DSH_EXEC_CWD_OUTSIDE_WORKSPACE');
  return dir;
}

/** The program name shown to the user. Never includes arguments.
 * `literal` means the whole value is one path (argv[0]); otherwise the first token of a command line. */
export function programName(value, {literal = false} = {}) {
  let token;
  if (literal) token = String(value ?? '').trim();
  else {
    const text = String(value ?? '').trim().replace(/^&\s*/, '');
    const first = /^(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(text);
    token = first ? (first[1] ?? first[2] ?? first[3]) : '';
  }
  const base = path.basename(token.replace(/\\/g, '/')).replace(/\.(exe|cmd|bat|com|ps1)$/i, '');
  return base.replace(/[^\w.+-]/g, '').slice(0, 64) || 'unknown';
}

/** One approval per execution. Anything but an explicit yes means the command is not run. */
/** The command as the person will judge it: secret-looking values masked, bounded length. */
export function approvalCommandText(commandText, cwd) {
  const text = redactText(String(commandText ?? '')).replace(/\s+/g, ' ').trim();
  const shown = text.length > 600 ? `${text.slice(0, 600)}…（共 ${text.length} 字）` : text;
  return `${shown}${cwd ? `\n工作目錄：${cwd}` : ''}`;
}

/** Reply codes meaning "this mod does not know exec.check": fall back to the older approval.request.
 * `UNKNOWN_METHOD` is the agreed code; `UNSUPPORTED` is what mods built before exec.check answer. */
export const EXEC_CHECK_FALLBACK = new Set(['UNKNOWN_METHOD', 'UNSUPPORTED', 'METHOD_NOT_FOUND', 'REVERSE_METHOD_UNSUPPORTED']);

async function raceAbort(promise, signal) {
  let onAbort;
  const cancelled = new Promise((_, reject) => { onAbort = () => reject(Object.assign(new Error('canceled'), {code: 'HOST_CANCELED'})); signal?.addEventListener('abort', onAbort, {once: true}); });
  try { return await Promise.race([promise, cancelled]); } finally { signal?.removeEventListener('abort', onAbort); }
}

function deniedError(module, method, notice) {
  const blocked = blockedError('DSH_EXEC_DENIED', notice);
  return Object.assign(claudeError(module, method, blocked.message, 'DSH_EXEC_DENIED'), {blocked: blocked.blocked});
}

/** One check per execution (SECURITY-PLAN.md agreement 4): `exec.check` asks Claude Code's own permission rules
 * (allow / deny / ask the person); a mod that does not know it gets the older `approval.request`.
 * Anything but an explicit allow means the command is not run. */
export async function requireExecApproval({requestHost, module, method, toolName, commandName, commandText, cwd, args, argsSummary, signal, callId, plugin, feature}) {
  if (typeof requestHost !== 'function') throw claudeError(module, method, '沒有 Claude Code 的反向請求通道，無法取得使用者核准；指令未執行', 'DSH_EXEC_APPROVAL_UNAVAILABLE');
  if (signal?.aborted) throw claudeError(module, method, '執行已取消', 'ABORT_ERR');
  const why = `${pluginLabel(plugin)}${feature ? `的「${String(feature).slice(0, 80)}」功能` : ''}要執行 ${commandName}`;
  let response;
  try {
    response = await raceAbort(requestHost('exec.check', {tool: 'Bash', command: String(commandText ?? commandName), cwd: cwd ?? '', why}, {signal}), signal);
  } catch (error) {
    if (signal?.aborted) throw claudeError(module, method, '執行已取消', 'ABORT_ERR');
    if (EXEC_CHECK_FALLBACK.has(error?.code)) return legacyApproval({requestHost, module, method, toolName, commandName, commandText, cwd, args, argsSummary, signal, callId, plugin, feature});
    if (isDisabled(error)) throw disabledError(module, method, error, 'the approval prompt', 'DSH_APPROVAL_DISABLED');
    throw claudeError(module, method, `無法取得 Claude Code 的權限檢查結果（${error?.code ?? 'error'}）；指令未執行`, 'DSH_EXEC_APPROVAL_UNAVAILABLE');
  }
  if (response?.decision === 'allow') return;
  const reason = typeof response?.reason === 'string' && response.reason ? redactText(response.reason) : response?.decision === 'deny' ? '' : 'mod 回覆了無法辨識的檢查結果';
  throw deniedError(module, method, execDeniedNotice({program: commandName, reason}, {plugin, feature}));
}

async function legacyApproval({requestHost, module, method, toolName, commandName, commandText, cwd, args, argsSummary, signal, callId, plugin, feature}) {
  let response;
  try {
    response = await raceAbort(requestHost('approval.request', {
      toolName, ...(callId ? {callId} : {}),
      reason: commandText === undefined ? `Run the local program "${commandName}" on this computer`
        : `Run the local program "${commandName}" on this computer:\n${approvalCommandText(commandText, cwd)}`,
      argumentSummary: argsSummary ?? argumentSummary(args),
    }, {signal}), signal);
  } catch (error) {
    if (signal?.aborted) throw claudeError(module, method, '執行已取消', 'ABORT_ERR');
    if (isDisabled(error)) throw disabledError(module, method, error, 'the approval prompt', 'DSH_APPROVAL_DISABLED');
    throw claudeError(module, method, `無法取得使用者核准（${error?.code ?? 'error'}）；指令未執行`, 'DSH_EXEC_APPROVAL_UNAVAILABLE');
  }
  if (response?.approved !== true) throw deniedError(module, method, execDeniedNotice({program: commandName, byUser: true}, {plugin, feature}));
}

/** Runs programs in this process (direct module use, tests, and hosts without the IPC exec channel). */
export function createLocalExecutor({requestHost, plugin, currentFeature} = {}) {
  return {
    kind: 'local',
    async launch({argv, cwd, env, stdin, check, signal}) {
      await requireExecApproval({requestHost, ...check, cwd, signal, plugin, feature: currentFeature?.()});
      if (signal?.aborted) throw claudeError(check.module, check.method, '執行已取消', 'ABORT_ERR');
      const child = spawn(argv[0], argv.slice(1), {cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: [stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe']});
      child.stopTree = graceMs => killTree(child, graceMs);
      return child;
    },
  };
}

const toBuffer = data => Buffer.isBuffer(data) ? data : data instanceof Uint8Array ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(String(data ?? ''));

/** A program the host process runs for the worker (the worker itself may not start programs under the Node permission model).
 * Looks like a ChildProcess to the shell/subprocess modules: stdout/stderr streams, stdin, 'error'/'close', exitCode. */
class HostProcess extends EventEmitter {
  constructor(channelFactory, stdinMode) {
    super();
    this.stdout = new PassThrough(); this.stderr = new PassThrough();
    this.exitCode = null; this.signalCode = null; this.pid = undefined; this.finished = false;
    this.channel = channelFactory(event => this.onEvent(event));
    const channel = this.channel;
    this.stdin = stdinMode === 'pipe' ? new Writable({
      write(chunk, _encoding, callback) { try { channel.write(toBuffer(chunk)); callback(); } catch (error) { callback(error); } },
      final(callback) { try { channel.end(); callback(); } catch (error) { callback(error); } },
    }) : null;
  }
  onEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'spawned') { this.pid = event.pid; this.emit('spawned'); return; }
    if (event.type === 'stdout') { this.stdout.write(toBuffer(event.data)); return; }
    if (event.type === 'stderr') { this.stderr.write(toBuffer(event.data)); return; }
    if (this.finished) return;
    if (event.type === 'exit') {
      this.finished = true; this.exitCode = event.exitCode ?? null; this.signalCode = event.signal ?? null;
      this.stdout.end(); this.stderr.end();
      this.emit('close', this.exitCode, this.signalCode);
      return;
    }
    if (event.type === 'error') {
      this.finished = true;
      const error = Object.assign(new Error(String(event.message ?? 'the host could not run the program')), {code: event.code ?? 'DSH_EXEC_SPAWN_FAILED'});
      if (event.blocked && typeof event.blocked === 'object') error.blocked = event.blocked;
      this.stdout.end(); this.stderr.end();
      this.emit('failed', error);
    }
  }
  stopTree(graceMs) { if (!this.finished) { try { this.channel.kill(graceMs); } catch { /* channel gone */ } } }
  kill() { this.stopTree(0); return true; }
}

/** `execHost.start(spec, onEvent)` is the worker's IPC channel to the host (lib/dsh-host-worker.mjs).
 * The host checks the working directory and asks `exec.check` itself, so a plugin cannot skip the check by talking to the channel. */
export function createHostExecutor({execHost, plugin, currentFeature} = {}) {
  return {
    kind: 'host',
    launch({argv, cwd, env, stdin, check, signal}) {
      if (signal?.aborted) return Promise.reject(claudeError(check.module, check.method, '執行已取消', 'ABORT_ERR'));
      return new Promise((resolve, reject) => {
        const feature = currentFeature?.();
        const proc = new HostProcess(onEvent => execHost.start({
          argv, cwd, env: env ?? {}, stdin: stdin === 'pipe' ? 'pipe' : 'ignore',
          check: {module: check.module, method: check.method, toolName: check.toolName, commandName: check.commandName, commandText: check.commandText, args: argumentSummary(check.args), ...(check.callId ? {callId: check.callId} : {}), plugin, feature},
        }, onEvent), stdin);
        const onAbort = () => proc.stopTree(0);
        signal?.addEventListener('abort', onAbort, {once: true});
        proc.once('spawned', () => { signal?.removeEventListener('abort', onAbort); resolve(proc); });
        proc.once('failed', error => {
          signal?.removeEventListener('abort', onAbort);
          if (proc.pid !== undefined) { proc.emit('error', error); proc.emit('close', null, null); return; }
          reject(signal?.aborted ? claudeError(check.module, check.method, '執行已取消', 'ABORT_ERR') : error);
        });
      });
    },
  };
}

/** Host side of the exec channel: check the folder, ask exec.check, spawn, stream. `emit(event)` goes back to the worker. */
export function createExecRunner({requestHost, workspace, plugin} = {}) {
  const live = new Set();
  function start(spec, emit) {
    const controller = new AbortController();
    let child = null, finished = false, pendingInput = [], inputEnded = false, killGrace = null;
    const finish = event => { if (finished) return; finished = true; live.delete(session); emit(event); };
    const session = {
      write(data) { if (child?.stdin) child.stdin.write(toBuffer(data)); else if (!child) pendingInput.push(toBuffer(data)); },
      end() { if (child?.stdin) child.stdin.end(); else inputEnded = true; },
      kill(graceMs = 0) { killGrace = Math.max(0, Number(graceMs) || 0); controller.abort(); if (child) killTree(child, killGrace); },
    };
    live.add(session);
    (async () => {
      const check = spec?.check && typeof spec.check === 'object' ? spec.check : {};
      const module = typeof check.module === 'string' ? check.module : 'exec', method = typeof check.method === 'string' ? check.method : 'run';
      if (!Array.isArray(spec?.argv) || !spec.argv.length || spec.argv.some(x => typeof x !== 'string') || !spec.argv[0]) throw claudeError(module, method, 'argv 必須是非空字串陣列', 'DSH_SUBPROCESS_BAD_SPEC');
      if (typeof spec.cwd !== 'string' || !spec.cwd) throw claudeError(module, method, 'cwd 必須是非空字串', 'DSH_SUBPROCESS_BAD_SPEC');
      // The worker already checked the folder; the host checks again because the worker runs plugin code.
      resolveWorkdir(module, method, workspace, spec.cwd);
      const env = {};
      for (const [key, value] of Object.entries(spec.env && typeof spec.env === 'object' ? spec.env : {})) if (typeof value === 'string' && /^[^=\0]+$/.test(key)) env[key] = value;
      await requireExecApproval({requestHost, module, method, toolName: typeof check.toolName === 'string' ? check.toolName : module,
        commandName: typeof check.commandName === 'string' ? check.commandName : programName(spec.argv[0], {literal: true}),
        commandText: typeof check.commandText === 'string' ? check.commandText : spec.argv.join(' '), cwd: spec.cwd,
        argsSummary: check.args, callId: typeof check.callId === 'string' ? check.callId : undefined, signal: controller.signal,
        plugin: typeof check.plugin === 'string' ? check.plugin : plugin, feature: typeof check.feature === 'string' ? check.feature : undefined});
      if (controller.signal.aborted) throw claudeError(module, method, '執行已取消', 'ABORT_ERR');
      child = spawn(spec.argv[0], spec.argv.slice(1), {cwd: spec.cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: [spec.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe']});
      let spawned = false;
      child.once('spawn', () => {
        spawned = true; emit({type: 'spawned', pid: child.pid});
        if (child.stdin) { child.stdin.on('error', () => {}); for (const chunk of pendingInput) child.stdin.write(chunk); pendingInput = []; if (inputEnded) child.stdin.end(); }
        if (killGrace !== null) killTree(child, killGrace);
      });
      child.stdout.on('data', data => { if (!finished) emit({type: 'stdout', data}); });
      child.stderr.on('data', data => { if (!finished) emit({type: 'stderr', data}); });
      child.once('error', error => finish({type: 'error', code: 'DSH_EXEC_SPAWN_FAILED', message: `${module}.${method}: 無法啟動 ${programName(spec.argv[0], {literal: true})}：${error.message}`}));
      child.once('close', (exitCode, signal) => finish({type: 'exit', exitCode, signal}));
    })().catch(error => finish({type: 'error', code: error?.code ?? 'DSH_EXEC_FAILED', message: String(error?.message ?? error), ...(error?.blocked ? {blocked: {...error.blocked}} : {})}));
    return session;
  }
  return {start, dispose() { for (const session of [...live]) session.kill(500); live.clear(); }, get size() { return live.size; }};
}

/** Bounded tail of one output stream with whole-stream offsets (no spill file). */
export class TailCollector {
  constructor(maxBytes) { this.max = Math.max(1, Math.floor(maxBytes) || 1); this.tail = Buffer.alloc(0); this.total = 0; this.dropped = false; this.note = ''; }
  push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.total += buf.length;
    let next = Buffer.concat([this.tail, buf]);
    if (next.length > this.max) { next = next.subarray(next.length - this.max); this.dropped = true; }
    this.tail = next;
  }
  /** Non-consuming, offset based read (the SubprocessOutputReader contract). */
  readFrom(fromByte = 0) {
    const start = this.total - this.tail.length;
    const lossy = fromByte < start;
    const slice = lossy ? this.tail : this.tail.subarray(Math.max(0, fromByte - start));
    return {text: slice.toString('utf8'), nextOffset: this.total, lossy};
  }
  get text() { return this.tail.toString('utf8'); }
  get truncated() { return this.dropped; }
}

/** Kill the process and its children. The returned promise only waits for the signalling. */
export function killTree(child, graceMs = 3000) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true}).on('error', () => child.kill()); } catch { child.kill(); }
    return;
  }
  const signalGroup = signal => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } } };
  signalGroup('SIGTERM');
  const timer = setTimeout(() => { if (child.exitCode === null && !child.signalCode) signalGroup('SIGKILL'); }, Math.max(100, graceMs));
  timer.unref?.();
}

/** Find an executable the way the platform would: absolute path, or a bare name on PATH (+PATHEXT). */
export function findExecutable(command, env = process.env) {
  const isFile = file => { try { return statSync(file).isFile(); } catch { return false; } };
  const exts = process.platform === 'win32' ? ['', ...String(env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const tryAll = base => { for (const ext of exts) if (isFile(base + ext)) return base + ext; return null; };
  if (path.isAbsolute(command)) return tryAll(command);
  if (/[\\/]/.test(command)) return null;
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) { const hit = tryAll(path.join(dir, command)); if (hit) return hit; }
  return null;
}
