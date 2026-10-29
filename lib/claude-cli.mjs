// 找 Claude Code 的命令列程式並執行它（不經 shell；只有 npm 裝的 claude.cmd 必須經過 cmd.exe）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

const execText = (file, args) => new Promise(resolve => {
  execFile(file, args, { timeout: 15_000, windowsHide: true }, (error, stdout) => resolve(error ? '' : String(stdout ?? '').trim()));
});
const isFile = file => fs.stat(file).then(s => s.isFile(), () => false);

/** 啟動這個程序的程式的執行檔路徑；查不到回傳空字串。 */
export async function parentExecutable(pid = process.ppid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  if (platform === 'win32') return execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).Path`]);
  if (platform === 'linux') return fs.readlink(`/proc/${pid}/exe`).catch(() => '');
  return execText('ps', ['-o', 'comm=', '-p', String(pid)]);
}

/** Windows 上 PATH 裡的 claude.exe 或 npm 裝的 claude.cmd；其他系統直接用 `claude` 交給 PATH。 */
export async function claudeOnPath(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return 'claude';
  const dirs = String(env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  for (const name of ['claude.exe', 'claude.cmd']) {
    for (const dir of dirs) if (await isFile(path.join(dir, name))) return path.join(dir, name);
  }
  return 'claude';
}

/**
 * 找 Claude Code 的執行檔：工具開的程序帶有 CLAUDE_CODE_EXECPATH；插件的 MCP 伺服器不一定有，
 * 這時看啟動自己的程式是不是 claude（MCP 伺服器由 Claude Code 直接啟動）；都不是才找 PATH 上的 claude。
 */
export async function findClaude(env = process.env, parent = parentExecutable, onPath = claudeOnPath) {
  if (env.CLAUDE_CODE_EXECPATH) return env.CLAUDE_CODE_EXECPATH;
  const exe = await parent();
  return exe && /^claude(\.exe)?$/i.test(path.basename(exe)) ? exe : onPath(env);
}

/**
 * execFile／spawn 用的 [程式, 參數, 額外選項]。.cmd 不能直接執行，要經 cmd.exe；
 * 這時每個參數加上引號，含引號、%、換行的參數不接受（我們傳的只有插件名稱、路徑和固定字）。
 */
export function claudeCommand(exe, args) {
  if (!/\.(cmd|bat)$/i.test(exe)) return [exe, args, {}];
  const quote = value => {
    if (/["%\r\n]/.test(value)) throw new Error(`這個參數不能交給 ${path.basename(exe)}：${value}`);
    return `"${value}"`;
  };
  return [quote(exe), args.map(quote), { shell: true }];
}
