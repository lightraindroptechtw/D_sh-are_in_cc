// 瀏覽器版市場的「已安裝」與「收藏」：只管本機插件市場（dsh-local）登記過的插件。
// - installedState：本機插件市場的登記檔 + `claude plugin list --json`（只讀）→ 每個插件是已轉換未安裝、已啟用或已停用。
// - manage：使用者在網頁上按的安裝、啟用、停用、移除，用 Claude Code 自己的 `claude plugin` 指令執行（不經 shell）。
//   插件名稱一律從登記檔來，網頁送來的只是清單上的名稱，不會拿網頁給的字串去組指令。
// - 收藏存在 <home>/state/market-favorites.json：網址的埠號每次都不同，瀏覽器自己的儲存空間會跟著換，所以不放那裡。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { claudeCommand, findClaude, parentExecutable } from './claude-cli.mjs';
import { deleteDownloads } from './downloads.mjs';

export const LOCAL_MARKETPLACE = 'dsh-local';
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FAVORITES_MAX = 1000;
const clip = (text, max = 600) => String(text ?? '').trim().split('\n').slice(-6).join('\n').slice(0, max);
const readJson = async file => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } };
async function writeJsonAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}

export { findClaude, parentExecutable } from './claude-cli.mjs';

/** 執行 `claude` 指令，回傳 `{ code, stdout, stderr }`。執行檔第一次用到時才找，之後沿用。 */
export function claudeRunner(env = process.env, parent = parentExecutable) {
  let found;
  return async (args, timeout = 120_000) => {
    const exe = await (found ??= findClaude(env, parent));
    let command;
    try { command = claudeCommand(exe, args); } catch (error) { return { code: -1, stdout: '', stderr: error.message }; }
    const [file, argv, extra] = command;
    return new Promise(resolve => {
      execFile(file, argv, { timeout, windowsHide: true, maxBuffer: 8 << 20, ...extra }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr || (error && !stdout ? error.message : '') || '') });
      });
    });
  };
}

const marketplaceFile = home => path.join(home, '.claude-plugin', 'marketplace.json');

/** 本機插件市場登記的插件（名稱不合法的略過）。 */
async function localPlugins(home) {
  const data = await readJson(marketplaceFile(home));
  return (Array.isArray(data?.plugins) ? data.plugins : []).filter(p => typeof p?.name === 'string' && PLUGIN_NAME.test(p.name));
}

/**
 * 每個登記過的插件現在的狀態。`known` 是 false 時讀不到 Claude Code 的安裝清單（`error` 是原因），
 * 這時每個插件的狀態都是不明（unknown），不猜它有沒有裝。
 */
export async function installedState({ home, run }) {
  await removeLeftovers(home);
  const plugins = await localPlugins(home);
  if (!plugins.length) return { known: true, plugins: [] };
  const listed = await run(['plugin', 'list', '--json'], 60_000);
  let rows = null;
  try { rows = listed.code === 0 ? JSON.parse(listed.stdout) : null; } catch { rows = null; }
  const byId = new Map((Array.isArray(rows) ? rows : []).map(row => [row?.id, row]));
  return {
    known: Array.isArray(rows),
    ...(Array.isArray(rows) ? {} : { error: clip(listed.stderr || listed.stdout) || `結束碼 ${listed.code}` }),
    plugins: plugins.map(p => {
      const row = byId.get(`${p.name}@${LOCAL_MARKETPLACE}`);
      const source = p.metadata?.dshSource ?? {};
      return {
        plugin: p.name,
        status: !Array.isArray(rows) ? 'unknown' : !row ? 'converted' : row.enabled === false ? 'disabled' : 'enabled',
        source: { origin: source.origin ?? null, name: source.name ?? null, version: source.version ?? null, commit: source.commit ?? null, packageDir: source.packageDir ?? null },
      };
    }),
  };
}

const sameRepo = (a, b) => String(a ?? '').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase() === String(b ?? '').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();

/**
 * 登記的插件對回清單上的哪一個：npm 插件看套件名稱；GitHub 插件看倉庫網址和子目錄（舊的登記沒有子目錄就只看倉庫），
 * 最後才看插件自己的名稱。對不到回傳 undefined。
 */
export function matchEntry(source, entries) {
  const npm = /^npm:(.+)$/.exec(source.origin ?? '');
  if (npm) return entries.find(e => e.name === npm[1]);
  if (source.origin) {
    const git = entries.filter(e => e.versions.some(v => v.source.type === 'git' && sameRepo(v.source.url, source.origin)));
    // 轉換器記的子目錄：根目錄是「.」，Windows 上可能是反斜線。
    const dir = String(source.packageDir ?? '').replace(/\\/g, '/').replace(/^\.\/?$/, '');
    const exact = git.find(e => e.versions.some(v => (v.source.path ?? '') === dir));
    if (exact || git.length) return exact ?? (source.packageDir === null ? git[0] : undefined);
  }
  return source.name ? entries.find(e => e.name === source.name) : undefined;
}

/** 清單上有比裝的更新的固定版本時，回傳那個版本（npm 比版本號，GitHub 比提交）；沒有就 undefined。 */
export function newerVersion(source, entry) {
  const latest = entry.versions.find(v => !v.floating && v.source.type !== 'release');
  if (!latest) return undefined;
  if (latest.source.type === 'npm') return source.version && latest.version !== source.version ? latest.version : undefined;
  return latest.source.commit && source.commit && latest.source.commit !== source.commit ? latest.version : undefined;
}

const ACTION_WORD = { install: '安裝', enable: '啟用', disable: '停用', remove: '移除' };

/**
 * 執行一個管理動作。`plugin` 是登記檔裡的名稱，`status` 是它現在的狀態。
 * 安裝前確認本機插件市場已加進 Claude Code（沒有就加、有就更新）；移除會從 Claude Code 解除安裝，再刪掉登記、轉換好的資料夾，
 * 以及審查時下載的原始碼、掃描報告和補寫的資料夾。
 */
export async function manage({ home, run, action, plugin, status }) {
  if (!PLUGIN_NAME.test(plugin) || !ACTION_WORD[action]) return { ok: false, text: '動作或插件名稱不對，沒有執行。', code: 'msg.manageInvalid' };
  const id = `${plugin}@${LOCAL_MARKETPLACE}`;
  const fail = (step, result) => {
    const detail = clip(result.stderr || result.stdout) || `結束碼 ${result.code}`;
    return { ok: false, text: `${ACTION_WORD[action]}失敗（${step}）：${detail}`, code: 'msg.manageFailed', params: { action, step, detail } };
  };
  if (action === 'enable' || action === 'disable') {
    const result = await run(['plugin', action, id]);
    return result.code === 0 ? { ok: true } : fail(`claude plugin ${action}`, result);
  }
  if (action === 'install') {
    const listed = await run(['plugin', 'marketplace', 'list', '--json'], 60_000);
    let added = false;
    try { added = JSON.parse(listed.stdout).some(m => m?.name === LOCAL_MARKETPLACE); } catch { added = false; }
    const prepared = added ? await run(['plugin', 'marketplace', 'update', LOCAL_MARKETPLACE]) : await run(['plugin', 'marketplace', 'add', home]);
    if (prepared.code !== 0) return fail(added ? 'claude plugin marketplace update' : 'claude plugin marketplace add', prepared);
    const result = await run(['plugin', 'install', id], 300_000);
    return result.code === 0 ? { ok: true } : fail('claude plugin install', result);
  }
  if (status !== 'converted') {
    const result = await run(['plugin', 'uninstall', id]);
    if (result.code !== 0) return fail('claude plugin uninstall', result);
  }
  const data = await readJson(marketplaceFile(home));
  const npm = /^npm:(.+)$/.exec(data?.plugins?.find?.(p => p?.name === plugin)?.metadata?.dshSource?.origin ?? '');
  if (Array.isArray(data?.plugins)) {
    data.plugins = data.plugins.filter(p => p?.name !== plugin);
    await writeJsonAtomic(marketplaceFile(home), data);
  }
  if (npm) await deleteDownloads(home, npm[1]).catch(() => []);
  try {
    await fs.rm(path.join(home, 'plugins', plugin), { recursive: true, force: true });
  } catch {
    // Windows 上插件還在目前的對話裡執行時資料夾會被鎖住；先記下來，下次讀安裝狀態時再刪。
    await writeJsonAtomic(leftoversFile(home), { names: [...new Set([...(await readLeftovers(home)), plugin])] });
    return { ok: true, later: true };
  }
  return { ok: true };
}

const leftoversFile = home => path.join(home, 'state', 'market-leftovers.json');
async function readLeftovers(home) {
  const names = (await readJson(leftoversFile(home)))?.names;
  return Array.isArray(names) ? names.filter(n => typeof n === 'string' && PLUGIN_NAME.test(n)) : [];
}

/** 刪掉之前移除時刪不掉的資料夾；又被登記回來（重新安裝）的不刪，還是刪不掉的留到下次。 */
export async function removeLeftovers(home) {
  const names = await readLeftovers(home);
  if (!names.length) return;
  const registered = new Set((await localPlugins(home)).map(p => p.name));
  const kept = [];
  for (const name of names) {
    if (registered.has(name)) continue;
    try { await fs.rm(path.join(home, 'plugins', name), { recursive: true, force: true }); } catch { kept.push(name); }
  }
  await writeJsonAtomic(leftoversFile(home), { names: kept });
}

const favoritesFile = home => path.join(home, 'state', 'market-favorites.json');

export async function readFavorites(home) {
  const names = (await readJson(favoritesFile(home)))?.names;
  return Array.isArray(names) ? names.filter(n => typeof n === 'string').slice(0, FAVORITES_MAX) : [];
}

/** 加入或取消一個收藏，回傳更新後的清單。 */
export async function setFavorite(home, name, on) {
  const names = (await readFavorites(home)).filter(n => n !== name);
  if (on) names.push(name);
  const kept = names.slice(-FAVORITES_MAX);
  await writeJsonAtomic(favoritesFile(home), { names: kept });
  return kept;
}
