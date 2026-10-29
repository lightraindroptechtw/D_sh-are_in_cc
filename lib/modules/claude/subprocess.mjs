import {PassThrough} from 'node:stream';
import {claudeError, guardService} from './common.mjs';
import {TailCollector, createHostExecutor, createLocalExecutor, findExecutable, mergeEnv, programName, resolveWorkdir, workspaceOf} from './exec-support.mjs';

export const descriptor = {
  id: 'subprocess', displayName: '子程序模組（Claude Code）', services: ['subprocess'],
  requires: {capabilities: []},
  methods: {
    resolveExecutable: {support: 'full', reason: '絕對路徑驗證；單純名稱在 PATH（Windows 加 PATHEXT）上搜尋；不需要核准，也不執行任何東西'},
    spawn: {support: 'partial', reason: '由宿主程序代為啟動（工作程序在 Node 權限模式下不能開程式）；每次啟動前送 exec.check（舊 mod 退回 approval.request），允許後才真的啟動（done 在此之前等待）；cwd 限制在 DSH_CLAUDE_WORKSPACE；沒有受管行程範圍，終止是整棵行程樹'},
    terminalEnvironment: {support: 'full', reason: '回報平台與預設 shell'},
    spawnTerminal: {support: 'unsupported', reason: '沒有 PTY（偽終端）後端'},
    'spec.stdio.control': {support: 'unsupported', reason: '不提供額外的 control 通道'},
    'collect.spill': {support: 'unsupported', reason: '只保留記憶體尾端；沒有 spill 檔'},
  },
  requirements: ['每次 spawn 都要經 exec.check 允許；被拒時 handle.done 以 DSH_EXEC_DENIED 拒絕，程式不會被啟動'],
};

export class SubprocessExecutableNotFoundError extends Error {
  constructor(message, options) { super(message, options); this.name = 'SubprocessExecutableNotFoundError'; }
}

const MAX_GRACE = 2 ** 31 - 1;

export function createClaudeSubprocessService({requestHost, workspace, platform = process.platform, executor = createLocalExecutor({requestHost}), resolveOnHost = null} = {}) {
  const live = new Set();
  let disposed = false;

  async function resolveExecutable(command, env, signal) {
    if (signal?.aborted) throw claudeError('subprocess', 'resolveExecutable', '已取消', 'ABORT_ERR');
    if (typeof command !== 'string' || !command) throw claudeError('subprocess', 'resolveExecutable', 'command 必須是非空字串', 'DSH_SUBPROCESS_BAD_SPEC');
    if (!/^[A-Za-z]:[\\/]|^[\\/]/.test(command) && /[\\/]/.test(command)) throw new SubprocessExecutableNotFoundError(`相對路徑 ${programName(command, {literal: true})} 無法解析：解析基準未定義`);
    const lookupEnv = {...process.env, ...(env ?? {})};
    // Under the permission model the worker may not look at folders on PATH; the host process looks them up (it runs the program too).
    const hit = resolveOnHost ? await resolveOnHost(command, {PATH: lookupEnv.PATH ?? lookupEnv.Path ?? '', PATHEXT: lookupEnv.PATHEXT ?? lookupEnv.Pathext ?? ''}) : findExecutable(command, lookupEnv);
    if (!hit) throw new SubprocessExecutableNotFoundError(`找不到可執行檔：${programName(command, {literal: true})}`);
    return hit;
  }

  function validate(spec) {
    const bad = reason => claudeError('subprocess', 'spawn', reason, 'DSH_SUBPROCESS_BAD_SPEC');
    if (!spec || typeof spec !== 'object') throw bad('spec 必須是物件');
    if (!Array.isArray(spec.argv) || !spec.argv.length || spec.argv.some(x => typeof x !== 'string') || !spec.argv[0]) throw bad('argv 必須是非空字串陣列');
    if (typeof spec.cwd !== 'string' || !spec.cwd) throw bad('cwd 必須是非空字串');
    if (!spec.stdio || typeof spec.stdio !== 'object') throw bad('stdio 必須明確指定');
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_GRACE) throw bad('graceMs 必須是正的有限毫秒數');
    if (spec.stdio.control !== undefined) throw claudeError('subprocess', 'spawn', '不支援 stdio.control 通道');
    for (const key of ['stdout', 'stderr']) {
      const mode = spec.stdio[key];
      if (mode !== 'pipe' && mode !== 'inherit' && !(mode && typeof mode === 'object' && Number.isFinite(mode.maxBytes) && mode.maxBytes > 0)) throw bad(`stdio.${key} 必須是 'pipe'、'inherit' 或 { maxBytes }`);
    }
    const stdin = spec.stdio.stdin;
    if (stdin !== 'ignore' && stdin !== 'pipe' && !(stdin && typeof stdin === 'object' && typeof stdin.data === 'string')) throw bad("stdio.stdin 必須是 'ignore'、'pipe' 或 { data }");
  }

  function spawnProcess(spec) {
    if (disposed) throw claudeError('subprocess', 'spawn', '模組已關閉', 'DSH_MODULE_DISPOSED');
    validate(spec);
    if (spec.signal?.aborted) throw claudeError('subprocess', 'spawn', '啟動已取消', 'ABORT_ERR');
    const cwd = resolveWorkdir('subprocess', 'spawn', workspace, spec.cwd); // throws synchronously when outside the workspace
    const {stdio} = spec;
    const stdin = stdio.stdin === 'pipe' ? new PassThrough() : undefined;
    const stdout = stdio.stdout === 'pipe' ? new PassThrough() : undefined;
    const stderr = stdio.stderr === 'pipe' ? new PassThrough() : undefined;
    const collectors = {};
    if (stdio.stdout && typeof stdio.stdout === 'object') collectors.stdout = new TailCollector(stdio.stdout.maxBytes);
    if (stdio.stderr && typeof stdio.stderr === 'object') collectors.stderr = new TailCollector(stdio.stderr.maxBytes);
    let child = null, terminated = false, settled = false;
    const gate = new AbortController();
    const stop = () => { terminated = true; gate.abort(); if (child) child.stopTree(spec.graceMs); };
    spec.signal?.addEventListener('abort', stop, {once: true});

    const done = (async () => {
      try {
        const name = programName(spec.argv[0], {literal: true});
        try {
          child = await executor.launch({
            argv: spec.argv, cwd, env: mergeEnv(spec.env), stdin: stdio.stdin === 'ignore' ? 'ignore' : 'pipe', signal: gate.signal,
            check: {module: 'subprocess', method: 'spawn', toolName: 'subprocess', commandName: name, commandText: spec.argv.map(a => /[\s"]/.test(String(a)) ? JSON.stringify(String(a)) : String(a)).join(' '), args: {argv: spec.argv, cwd: spec.cwd, ...(spec.env ? {env: spec.env} : {})}},
          });
        } catch (error) {
          if (terminated) throw claudeError('subprocess', 'spawn', '啟動已取消', 'ABORT_ERR');
          if (typeof error?.code === 'string' && /^(?:DSH_|ABORT_ERR$|ERR_ACCESS_DENIED$)/.test(error.code)) throw error;
          throw claudeError('subprocess', 'spawn', `無法啟動 ${name}：${error?.message ?? error}`, 'DSH_EXEC_SPAWN_FAILED');
        }
        if (terminated) { child.stopTree(spec.graceMs); throw claudeError('subprocess', 'spawn', '啟動已取消', 'ABORT_ERR'); }
        return await new Promise((resolve, reject) => {
          live.add(child);
          const sink = (source, passthrough, collector, inherit) => {
            if (!source) return;
            if (passthrough) source.pipe(passthrough);
            if (collector) source.on('data', chunk => collector.push(chunk));
            // 'inherit' means the worker's own output (the host log), never the protocol stream of the host process.
            if (inherit) source.on('data', chunk => { try { inherit.write(chunk); } catch { /* closed */ } });
          };
          sink(child.stdout, stdout, collectors.stdout, stdio.stdout === 'inherit' ? process.stdout : null);
          sink(child.stderr, stderr, collectors.stderr, stdio.stderr === 'inherit' ? process.stderr : null);
          if (child.stdin) {
            child.stdin.on('error', () => {});
            if (stdin) stdin.pipe(child.stdin); else child.stdin.end(stdio.stdin.data);
          }
          child.once('error', error => reject(error?.code && /^DSH_/.test(error.code) ? error : claudeError('subprocess', 'spawn', `無法啟動 ${name}：${error.message}`, 'DSH_EXEC_SPAWN_FAILED')));
          child.once('close', (exitCode, signal) => resolve({exitCode, signal}));
          if (terminated) child.stopTree(spec.graceMs);
        });
      } finally {
        settled = true;
        if (child) live.delete(child);
        spec.signal?.removeEventListener('abort', stop);
        stdin?.destroy?.();
      }
    })();
    done.catch(() => {}); // the consumer awaits it; an unobserved rejection must not end the host

    return {
      stdin, stdout, stderr, control: undefined,
      collected: collectors,
      done,
      terminate() { if (!settled) stop(); },
      async waitForExit(signal) {
        if (signal?.aborted) return false;
        const aborted = new Promise(resolve => signal?.addEventListener('abort', () => resolve(false), {once: true}));
        return Promise.race([done.then(() => true, () => true), aborted]);
      },
    };
  }

  async function terminalEnvironment() {
    return {platform: platform === 'win32' ? 'windows' : 'posix', ...(platform === 'win32' ? {defaultShell: 'powershell.exe'} : {defaultShell: process.env.SHELL || '/bin/sh'})};
  }
  const service = guardService({resolveExecutable, spawn: spawnProcess, terminalEnvironment}, 'subprocess', '這個 subprocess 方法沒有對應到 Claude Code 宿主（沒有 PTY 與受管行程範圍）');
  return {service, async dispose() { disposed = true; for (const child of [...live]) child.stopTree(500); live.clear(); }};
}

export async function install({requestHost, root, execHost, hostInfo} = {}) {
  const workspace = workspaceOf(root);
  const describe = {plugin: hostInfo?.plugin, currentFeature: hostInfo?.currentFeature};
  const executor = execHost ? createHostExecutor({execHost, ...describe}) : createLocalExecutor({requestHost, ...describe});
  const resolveOnHost = execHost && typeof requestHost === 'function' ? async (command, env) => { const answer = await requestHost('exec.resolveExecutable', {command, env}); return typeof answer?.path === 'string' ? answer.path : null; } : null;
  const runtime = createClaudeSubprocessService({requestHost, workspace, executor, resolveOnHost});
  return {
    services: {subprocess: runtime.service}, dispose: () => runtime.dispose(),
    diagnostics: [{module: 'subprocess', level: 'warning', status: 'partial', reason: `每次 spawn 經 Claude Code 權限檢查（exec.check）；cwd 限制在 ${workspace ? 'DSH_CLAUDE_WORKSPACE' : '(未設定，所有啟動都會失敗)'}；沒有 PTY、spill 檔與 control 通道。`}],
  };
}
