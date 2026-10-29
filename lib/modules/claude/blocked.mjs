/** "Blocked" notices of the Claude Code host (SECURITY-PLAN.md, agreement 5).
 * Every action the host or the Node permission model stops is reported in four parts, in Traditional Chinese:
 *   [被擋下] <what was blocked>
 *   原因：<one plain sentence>
 *   怎麼放行：<the plugin option or the step that allows it>
 *   影響：<the feature that does not work because of it>
 *   （代碼：<CODE>）
 * Nothing here contains a secret value: only paths, program names, option names and environment variable names. */
import path from 'node:path';

export const BLOCKED_CODES = Object.freeze(['ERR_ACCESS_DENIED', 'ERR_DLOPEN_DISABLED', 'DSH_CREDENTIAL_MISSING', 'DSH_MODULE_UNSUPPORTED', 'DSH_EXEC_DENIED']);

const clip = (value, limit = 300) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

/** The four-part text. */
export function blockedText({what, why, how, impact, code}) {
  return `[被擋下] ${clip(what, 400)}\n原因：${clip(why, 400)}\n怎麼放行：${clip(how, 400)}\n影響：${clip(impact, 300)}\n（代碼：${code}）`;
}

/** An Error whose message is the four-part text; `blocked` keeps the parts (for status lists and deduplication). */
export function blockedError(code, parts, extra = {}) {
  const blocked = {code, ...parts};
  const error = new Error(blockedText(blocked));
  error.name = 'DshBlockedError';
  return Object.assign(error, extra, {code, blocked});
}

export const pluginLabel = name => (typeof name === 'string' && name.trim() ? `「${clip(name, 80)}」插件` : '這個插件');
const featureImpact = feature => feature ? `「${clip(feature, 80)}」功能無法使用` : '用到這個動作的插件功能無法使用';

/** Strip the Windows long-path prefix Node puts on permission errors. */
export const cleanResource = value => String(value ?? '').replace(/^\\\\\?\\(UNC\\)?/, (_, unc) => unc ? '\\\\' : '');

/** Node permission model (`--permission`) errors → four-part notice. `feature` is the tool or phase that hit it. */
export function permissionNotice(error, {plugin, feature} = {}) {
  const kind = String(error?.permission ?? '');
  // Some denials carry no resource; the host's fs wrappers add the operation and the path argument.
  const resource = cleanResource(error?.resource) || cleanResource(error?.attemptedPath);
  const operation = typeof error?.operation === 'string' ? error.operation : '';
  const who = pluginLabel(plugin);
  const impact = feature ? featureImpact(feature) : '插件無法啟動';
  const disabledApi = /^(\w+) API is disabled when Permission Model is enabled/.exec(String(error?.message ?? ''))?.[1];
  if (disabledApi) return {
    key: `disabled-api:${disabledApi}`, kind: 'disabled-api',
    what: `${who}用檔案代號（file descriptor）做 ${disabledApi}${resource ? `（${clip(resource, 200)}）` : operation ? `（${clip(operation, 60)}）` : ''}`,
    why: `Node 權限模式一律停用 ${disabledApi}，因為無法檢查檔案代號指向哪個檔案；這不是資料夾設定能放行的`,
    how: '這是轉換器宿主要處理的相容問題，請回報；暫時可在 runtime/settings.json 設 claudeHost.sandbox=false 關閉權限限制（不建議）',
    impact,
  };
  if (error?.code === 'ERR_DLOPEN_DISABLED' || /addon/i.test(kind)) return {
    key: `addon:${resource}`, kind: 'addon',
    what: `${who}想載入原生模組（.node 檔）`,
    why: 'Node 權限模式不准插件載入原生模組，原生模組可以繞過所有限制',
    how: '在跳出的詢問視窗選「完全信任這個插件」（只對這個插件有效，插件會自動重新啟動），或在插件選項開啟 allowDirectExec',
    impact,
  };
  if (/ChildProcess/i.test(kind)) {
    const program = path.basename(resource.replace(/\\/g, '/')).replace(/\.(exe|cmd|bat|com)$/i, '') || resource || '外部程式';
    return {
      key: `exec:${program.toLowerCase()}`, kind: 'exec',
      what: `${who}想直接執行程式 ${clip(program, 80)}`,
      why: '安全限制（Node 權限模式）不准插件自己開程式；經過 Claude Code 權限檢查的指令執行（shell／subprocess 服務）不受影響',
      how: '在跳出的詢問視窗選「完全信任這個插件」（只對這個插件有效，插件會自動重新啟動），或在插件選項開啟 allowDirectExec',
      impact,
    };
  }
  if (/Worker/i.test(kind)) return {
    key: 'worker', kind: 'worker',
    what: `${who}想開背景執行緒（worker_threads）`,
    why: '安全限制（Node 權限模式）不准插件開背景執行緒',
    how: '在跳出的詢問視窗選「完全信任這個插件」（只對這個插件有效，插件會自動重新啟動），或在插件選項開啟 allowDirectExec',
    impact,
  };
  if (/WASI/i.test(kind)) return {
    key: 'wasi', kind: 'wasi',
    what: `${who}想使用 WASI（WebAssembly 系統介面）`,
    why: '安全限制（Node 權限模式）不准插件使用 WASI',
    how: '在跳出的詢問視窗選「完全信任這個插件」（只對這個插件有效，插件會自動重新啟動），或在插件選項開啟 allowDirectExec',
    impact,
  };
  const write = /Write/i.test(kind);
  const folder = resource ? (write ? path.dirname(resource) : resource) : '';
  return {
    key: `fs-${write ? 'write' : 'read'}:${folder.toLowerCase()}`, kind: write ? 'fs-write' : 'fs-read',
    what: `${who}想${write ? '寫入' : '讀取'} ${resource ? clip(resource, 200) : '允許範圍外的檔案'}${operation ? `（操作：${clip(operation, 60)}）` : ''}${!resource && !operation ? '（Node 沒有提供路徑；可能是解析路徑時檢查上層資料夾）' : ''}`,
    why: '這個位置不在允許的資料夾內（插件只能讀寫插件資料夾、狀態資料夾、工作資料夾）',
    how: `在插件選項「額外允許的資料夾」（extraFolders）加入 ${folder ? clip(folder, 200) : '那個資料夾'}（多個用分號 ; 分隔），然後重新啟動插件`,
    impact,
  };
}

export function credentialNotice(name, {plugin, feature} = {}) {
  return {
    key: `secret:${name}`, kind: 'secret',
    what: `${pluginLabel(plugin)}缺少金鑰 ${name}`,
    why: `沒有設定環境變數 ${name}，插件拿不到這把金鑰`,
    how: `在插件選項填入「secret_${name}」欄位（存在系統安全儲存區），然後重新啟動插件`,
    impact: feature ? `「${clip(feature, 80)}」功能無法使用` : `需要 ${name} 的功能無法使用`,
  };
}

export function unsupportedNotice({module, method, reason}, {plugin, feature} = {}) {
  const where = [module, method].filter(Boolean).join('.') || '某項 DSH 服務';
  return {
    key: `unsupported:${where}`, kind: 'unsupported',
    what: `${pluginLabel(plugin)}用到 DSH 才有的功能 ${clip(where, 120)}`,
    why: `${typeof reason === 'string' && reason ? `${clip(reason, 200)}。` : ''}這個功能需要 DeepSeek Harness 本身（例如它的對話管理或前端），Claude Code 沒有對應`,
    how: '無法放行；請改用插件其他不依賴這項功能的工具，或在 DeepSeek Harness 裡使用這個插件',
    impact: feature ? featureImpact(feature) : `用到 ${clip(where, 120)} 的插件功能無法使用`,
  };
}

export function execDeniedNotice({program, reason, byUser = false}, {plugin, feature} = {}) {
  return {
    key: `exec-denied:${String(program).toLowerCase()}`, kind: 'exec-denied',
    what: `${pluginLabel(plugin)}${feature ? `的「${clip(feature, 80)}」功能` : ''}想執行程式 ${clip(program, 80)}`,
    why: byUser ? '使用者在確認視窗沒有核准這個指令' : `Claude Code 的權限設定拒絕了這個指令${reason ? `：${clip(reason, 200)}` : ''}`,
    how: byUser ? '再呼叫一次並在確認視窗按允許，或在 Claude Code 的權限設定（/permissions）允許這個指令' : '在 Claude Code 的權限設定（/permissions）允許這個指令，或改用一般權限模式在確認視窗允許',
    impact: feature ? `「${clip(feature, 80)}」功能沒有完成（指令沒有執行）` : '這個指令沒有執行',
  };
}

/** Turn any error into a blocked error when it is one of the known blocks; otherwise null.
 * An error that is already a blocked error is returned as it is. */
export function translateBlocked(error, {plugin, feature} = {}) {
  if (!error || typeof error !== 'object') return null;
  if (error.blocked && typeof error.blocked === 'object' && typeof error.blocked.key === 'string') return error;
  if (error.code === 'ERR_ACCESS_DENIED' || error.code === 'ERR_DLOPEN_DISABLED') return blockedError(error.code, permissionNotice(error, {plugin, feature}), {original: error});
  if (error.code === 'DSH_MODULE_UNSUPPORTED') return blockedError(error.code, unsupportedNotice({module: error.module, method: error.method, reason: error.reason}, {plugin, feature}), {original: error, module: error.module, method: error.method});
  if (error.code === 'DSH_CREDENTIAL_MISSING' && typeof error.credential === 'string') return blockedError(error.code, credentialNotice(error.credential, {plugin, feature}), {original: error});
  return null;
}

/** Notification and status bookkeeping. One notice per kind of block (same key) per session, at most `maxNotices` in total. */
export function createBlockedReporter({notify, maxNotices = 12} = {}) {
  const rows = new Map();
  let sent = 0;
  return {
    report(blocked) {
      if (!blocked?.key) return false;
      const row = rows.get(blocked.key);
      if (row) { row.count++; row.lastAt = new Date().toISOString(); return false; }
      rows.set(blocked.key, {kind: blocked.kind, code: blocked.code, what: blocked.what, why: blocked.why, how: blocked.how, impact: blocked.impact, count: 1, firstAt: new Date().toISOString()});
      if (typeof notify === 'function' && sent < maxNotices) {
        sent++;
        try { notify(blockedText(blocked), blocked); } catch { /* the notice is best effort */ }
      }
      return true;
    },
    list() { return [...rows.values()].map(row => ({...row})); },
  };
}
