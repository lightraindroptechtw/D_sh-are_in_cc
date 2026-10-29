import {existsSync} from 'node:fs';
import {claudeError, guardService} from './common.mjs';
import {TailCollector, createHostExecutor, createLocalExecutor, mergeEnv, programName, resolveWorkdir, workspaceOf} from './exec-support.mjs';

export const descriptor = {
  id: 'shell', displayName: '指令執行模組（Claude Code）', services: ['shell'],
  requires: {capabilities: []},
  methods: {
    resolve: {support: 'partial', reason: '補齊預設值（工作目錄=DSH_CLAUDE_WORKSPACE、逾時 120 秒、上限 600 秒、輸出上限 1 MiB）；sandboxPolicy 被忽略'},
    execute: {support: 'partial', reason: '每次執行前送 exec.check 讓 Claude Code 依自己的權限規則決定（mod 太舊時退回 approval.request），允許才執行；實際執行在宿主程序（工作程序在 Node 權限模式下不能開程式）；工作目錄限制在 DSH_CLAUDE_WORKSPACE；指令本身沒有沙箱，具有目前使用者的權限'},
    sandboxMode: {support: 'unsupported', reason: '不做沙箱，回傳 undefined'},
    'handle.readOutput': {support: 'partial', reason: '增量讀取尾端輸出；沒有 spill 檔'},
  },
  requirements: ['每次執行前經 exec.check（或舊 mod 的 approval.request）允許；被拒、逾時或沒有回覆時丟 DSH_EXEC_DENIED／DSH_EXEC_APPROVAL_UNAVAILABLE'],
};

const DEFAULTS = {timeoutMs: 120000, maxTimeoutMs: 600000, stdoutMaxBytes: 1 << 20, stderrMaxBytes: 1 << 20, graceMs: 3000};

/** argv that runs one command line. Windows: Windows PowerShell (EncodedCommand avoids quoting bugs); POSIX: bash, else sh. */
export function shellArgv(command, platform = process.platform, exists = existsSync) {
  if (platform === 'win32') {
    // The footer makes the process exit with the last native command's code (PowerShell would say 1 for any failure).
    const footer = 'if ($?) { if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } else { exit 0 } } elseif ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 1 }';
    const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$ProgressPreference='SilentlyContinue';\n${command}\n${footer}`;
    return ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  }
  return [exists('/bin/bash') ? '/bin/bash' : '/bin/sh', '-c', command];
}

export function createClaudeShellService({requestHost, workspace, platform = process.platform, executor = createLocalExecutor({requestHost})} = {}) {
  const live = new Set();
  let disposed = false;

  function resolve(request = {}) {
    if (typeof request.command !== 'string' || !request.command.trim()) throw claudeError('shell', 'resolve', 'command 必須是非空字串', 'DSH_SHELL_BAD_REQUEST');
    const timeoutMs = Number.isFinite(request.timeoutMs) && request.timeoutMs > 0 ? Math.min(Math.floor(request.timeoutMs), DEFAULTS.maxTimeoutMs) : DEFAULTS.timeoutMs;
    const onExpiry = request.onExpiry === 'none' ? 'none' : 'kill';
    const stdoutMaxBytes = Number.isFinite(request.stdoutMaxBytes) && request.stdoutMaxBytes > 0 ? Math.floor(request.stdoutMaxBytes) : DEFAULTS.stdoutMaxBytes;
    return {
      command: request.command,
      workdir: request.workdir === undefined || request.workdir === '' ? (workspace ?? '') : String(request.workdir),
      timeoutMs, onExpiry, stdoutMaxBytes,
      ...(request.signal ? {signal: request.signal} : {}),
      ...(request.stdin === undefined ? {} : {stdin: String(request.stdin)}),
      ...(request.env ? {env: request.env} : {}),
      ...(request.dshEnv ? {dshEnv: request.dshEnv} : {}),
      sandboxPolicy: undefined, // no sandbox on this host; a supplied policy is not honored
    };
  }

  async function execute(spec) {
    if (disposed) throw claudeError('shell', 'execute', '模組已關閉', 'DSH_MODULE_DISPOSED');
    if (!spec || typeof spec.command !== 'string' || !spec.command.trim() || typeof spec.timeoutMs !== 'number') throw claudeError('shell', 'execute', '請先用 resolve() 取得完整的 spec', 'DSH_SHELL_BAD_REQUEST');
    const cwd = resolveWorkdir('shell', 'execute', workspace, spec.workdir || undefined);
    const argv = shellArgv(spec.command, platform);
    const out = new TailCollector(spec.stdoutMaxBytes), err = new TailCollector(DEFAULTS.stderrMaxBytes);
    let status = 'running', exitCode = null, termSignal = null, timedOut = false, aborted = false, spawnError = null, killedByUs = false;
    let child;
    try {
      child = await executor.launch({
        argv, cwd, env: mergeEnv(spec.env, spec.dshEnv), stdin: spec.stdin === undefined ? 'ignore' : 'pipe', signal: spec.signal,
        check: {module: 'shell', method: 'execute', toolName: 'shell', commandName: programName(spec.command), commandText: spec.command,
          args: {command: spec.command, workdir: spec.workdir, timeoutMs: spec.timeoutMs, ...(spec.stdin === undefined ? {} : {stdin: spec.stdin}), ...(spec.env ? {env: spec.env} : {})}},
      });
    } catch (error) {
      if (typeof error?.code === 'string' && /^(?:DSH_|ABORT_ERR$|ERR_ACCESS_DENIED$)/.test(error.code)) throw error;
      throw claudeError('shell', 'execute', `無法啟動 shell：${error?.message ?? error}`, 'DSH_EXEC_SPAWN_FAILED');
    }
    if (spec.signal?.aborted) { child.stopTree(0); throw claudeError('shell', 'execute', '執行已取消', 'ABORT_ERR'); }
    live.add(child);
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    if (spec.stdin !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(spec.stdin); }
    const done = new Promise(finish => {
      child.once('error', error => { spawnError = error; err.push(`spawn failed: ${error.message}\n`); status = 'killed'; finish(); });
      child.once('close', (code, signal) => {
        exitCode = code; termSignal = signal;
        status = killedByUs || signal ? 'killed' : 'completed';
        finish();
      });
    });
    const stop = () => { killedByUs = true; child.stopTree(DEFAULTS.graceMs); };
    const onAbort = () => { if (!timedOut && status === 'running') aborted = true; stop(); };
    spec.signal?.addEventListener('abort', onAbort, {once: true});
    const timer = spec.onExpiry === 'none' ? null : setTimeout(() => { if (!aborted && status === 'running') timedOut = true; stop(); }, spec.timeoutMs);
    timer?.unref?.();
    done.finally(() => { clearTimeout(timer); spec.signal?.removeEventListener('abort', onAbort); live.delete(child); });
    let outCursor = 0, errCursor = 0, resultPromise;
    const handle = {
      get status() { return status; }, get exitCode() { return exitCode; }, get signal() { return termSignal; },
      done: done.then(() => {}),
      readOutput() {
        const a = out.readFrom(outCursor), b = err.readFrom(errCursor);
        outCursor = a.nextOffset; errCursor = b.nextOffset;
        return {delta: a.text + (b.text ? `${a.text && !a.text.endsWith('\n') ? '\n' : ''}[stderr]\n${b.text}` : ''), lossy: a.lossy || b.lossy};
      },
      observed: {stdout: out, stderr: err},
      kill() { if (status !== 'running') return false; stop(); return true; },
      result() {
        resultPromise ??= done.then(() => {
          if (spawnError) throw claudeError('shell', 'execute', `無法啟動 shell：${spawnError.message}`, 'DSH_EXEC_SPAWN_FAILED');
          return {
            exitCode, signal: termSignal, timedOut, aborted, timeoutMs: spec.timeoutMs,
            stdout: {text: out.text, truncated: out.truncated}, stderr: {text: err.text, truncated: err.truncated},
          };
        });
        return resultPromise;
      },
    };
    done.then(() => handle.result().catch(() => {}));
    return handle;
  }

  const service = guardService({resolve, execute, get sandboxMode() { return undefined; }}, 'shell', '這個 shell 方法沒有對應到 Claude Code 宿主');
  return {
    service,
    async dispose() { disposed = true; for (const child of [...live]) child.stopTree(500); live.clear(); },
  };
}

export async function install({requestHost, root, execHost, hostInfo} = {}) {
  const workspace = workspaceOf(root);
  const describe = {plugin: hostInfo?.plugin, currentFeature: hostInfo?.currentFeature};
  const executor = execHost ? createHostExecutor({execHost, ...describe}) : createLocalExecutor({requestHost, ...describe});
  const runtime = createClaudeShellService({requestHost, workspace, executor});
  return {
    services: {shell: runtime.service}, dispose: () => runtime.dispose(),
    diagnostics: [{module: 'shell', level: 'warning', status: 'partial', reason: `每次執行前經 Claude Code 權限檢查（exec.check）；工作目錄限制在 ${workspace ? 'DSH_CLAUDE_WORKSPACE' : '(未設定，所有執行都會失敗)'}；沒有沙箱。`}],
  };
}
