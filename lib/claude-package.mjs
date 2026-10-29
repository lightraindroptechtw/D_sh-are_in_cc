import { mkdir, readFile, writeFile, readdir, stat, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeCommand, findClaude } from './claude-cli.mjs';

// 產生與檢查 Claude Code 插件資料夾。這裡只處理檔案結構與範本，不執行任何來源程式。

export const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PLACEHOLDER_CONFIG = '"__DSH_BRIDGE_CONFIG__"';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MODULE_SUFFIX = /\.(?:ts|tsx|jsx|js|mjs|cjs|mts|cts)$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = value => JSON.stringify(value, null, 2) + '\n';
const exists = async file => { try { await access(file); return true; } catch { return false; } };
const isFile = async file => { try { return (await stat(file)).isFile(); } catch { return false; } };
const isDirectory = async file => { try { return (await stat(file)).isDirectory(); } catch { return false; } };

/**
 * 由 DSH 套件名稱決定性地產生 Claude 插件名稱：小寫英文、數字、連字號，最多 64 字。
 * `@scope/name` 變成 `scope-name`；沒有 `dsh-` 開頭就補上，讓人一眼看出是轉換來的 DSH 插件。
 * 超過長度時截短並附上原名稱的雜湊，避免不同名稱截成同一個。
 */
export function claudePluginName(packageName) {
  const original = typeof packageName === 'string' ? packageName : '';
  let base = original.replace(/^@/, '').replace(/\//g, '-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base) base = 'converted';
  if (base === 'dsh') base = 'plugin';
  if (!base.startsWith('dsh-')) base = 'dsh-' + base;
  if (base.length > 64) {
    const hash = createHash('sha256').update(original).digest('hex').slice(0, 8);
    base = base.slice(0, 55).replace(/-+$/, '') + '-' + hash;
  }
  return base;
}

/** Claude 技能資料夾名稱：與插件名稱同樣的字元規則，最多 64 字。 */
export function claudeSkillDirName(skillName) {
  const base = String(skillName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
  return base || 'skill';
}

export function claudePluginVersion(version) {
  return typeof version === 'string' && VERSION_PATTERN.test(version) ? version : '0.1.0';
}

const escapeForJsonString = value => JSON.stringify(String(value)).slice(1, -1);

/** 用 `templates/claude-mod/plugin.json` 產生 manifest；只換三個佔位字串，換完必須是合法 JSON 且不留佔位字串。 */
export function renderPluginManifest(templateText, { name, version, description }) {
  const values = { __DSH_PLUGIN_NAME__: name, __DSH_PLUGIN_VERSION__: version, __DSH_PLUGIN_DESCRIPTION__: description };
  let text = templateText;
  for (const [placeholder, value] of Object.entries(values)) text = text.split(placeholder).join(escapeForJsonString(value));
  let manifest;
  try { manifest = JSON.parse(text); } catch (error) { throw new Error(`plugin.json 範本換完佔位字串後不是合法 JSON：${error.message}`); }
  if (!object(manifest)) throw new Error('plugin.json 範本必須是 JSON 物件');
  if (/__DSH_[A-Z_]+__/.test(text)) throw new Error('plugin.json 範本含有未知的佔位字串');
  if (manifest.name !== name) throw new Error('plugin.json 範本沒有使用 __DSH_PLUGIN_NAME__ 作為 name');
  return { manifest, text: json(manifest) };
}

/** 把 `"__DSH_BRIDGE_CONFIG__"`（含引號）換成 JSON。用函式取代，避免設定內容裡的 `$&` 被當成取代語法。 */
export function renderRegisterModule(templateText, config) {
  const count = templateText.split(PLACEHOLDER_CONFIG).length - 1;
  if (count < 1) throw new Error('register.ts 範本找不到 "__DSH_BRIDGE_CONFIG__"');
  const literal = JSON.stringify(config, null, 2).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const text = templateText.split(PLACEHOLDER_CONFIG).join(literal);
  return text;
}

export function defaultTemplatesDir(converterRoot) {
  return path.join(converterRoot, 'templates', 'claude-mod');
}

/** 讀範本；缺檔時丟出說明清楚的錯誤。 */
export async function readTemplates(templatesDir) {
  const result = {};
  for (const [key, file] of [['pluginJson', 'plugin.json'], ['hooksJson', 'hooks.json'], ['registerTs', 'register.ts']]) {
    try { result[key] = await readFile(path.join(templatesDir, file), 'utf8'); }
    catch (error) { throw Object.assign(new Error(`找不到 mod 範本 ${path.join(templatesDir, file)}：${error.message}`), { code: 'CLAUDE_TEMPLATE_MISSING' }); }
  }
  // register.ts 匯入的補寫共用事件（預設什麼都不做）；自訂範本資料夾沒有就用內附的。
  const ownTemplates = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'claude-mod');
  result.rewriteSharedTs = await readFile(path.join(templatesDir, 'rewrite-shared.ts'), 'utf8').catch(() => readFile(path.join(ownTemplates, 'rewrite-shared.ts'), 'utf8'));
  return result;
}

/** 寫 `.claude-plugin/plugin.json`、`hooks/hooks.json`、`hooks/register.ts`、`hooks/rewrite-shared.ts`（補寫部分的共用事件，預設什麼都不做）。 */
export async function writeClaudeModFiles({ outputDir, templates, name, version, description, bridgeConfig }) {
  const root = path.resolve(outputDir);
  const { manifest, text } = renderPluginManifest(templates.pluginJson, { name, version, description });
  let hooks;
  try { hooks = JSON.parse(templates.hooksJson); } catch (error) { throw new Error(`hooks.json 範本不是合法 JSON：${error.message}`); }
  if (!object(hooks) || !Array.isArray(hooks.modules) || hooks.modules.length !== 1 || typeof hooks.modules[0] !== 'string') throw new Error('hooks.json 範本必須是 { "modules": ["./register.ts"] }');
  const modulePath = hooks.modules[0];
  const registerFile = path.resolve(root, 'hooks', modulePath);
  const relative = path.relative(path.join(root, 'hooks'), registerFile);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !MODULE_SUFFIX.test(registerFile)) throw new Error('hooks.json 的 modules 路徑必須在 hooks/ 內，且副檔名要是可載入的程式檔');
  const register = renderRegisterModule(templates.registerTs, bridgeConfig);
  await mkdir(path.join(root, '.claude-plugin'), { recursive: true });
  await mkdir(path.join(root, 'hooks'), { recursive: true });
  await mkdir(path.dirname(registerFile), { recursive: true });
  await writeFile(path.join(root, '.claude-plugin', 'plugin.json'), text, 'utf8');
  await writeFile(path.join(root, 'hooks', 'hooks.json'), json(hooks), 'utf8');
  await writeFile(registerFile, register, 'utf8');
  await writeFile(path.join(path.dirname(registerFile), 'rewrite-shared.ts'), templates.rewriteSharedTs, 'utf8');
  return { manifest, registerFile };
}

/** 沒有可橋接的程式（只有技能）時，只寫 manifest。 */
export async function writeClaudeManifestOnly({ outputDir, templates, name, version, description }) {
  const root = path.resolve(outputDir);
  const { manifest, text } = renderPluginManifest(templates.pluginJson, { name, version, description });
  await mkdir(path.join(root, '.claude-plugin'), { recursive: true });
  await writeFile(path.join(root, '.claude-plugin', 'plugin.json'), text, 'utf8');
  return { manifest };
}

/**
 * 約定 1：把插件需要的金鑰合併進「輸出的」plugin.json 的 userConfig（不改範本檔）。
 * 每把金鑰一個欄位 `secret_<環境變數名稱>`，type string、sensitive true。範本已有同名欄位時不覆寫。
 */
export async function mergeSecretUserConfig(outputDir, secretOptions = []) {
  const file = path.join(path.resolve(outputDir), '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (!secretOptions.length) return manifest;
  manifest.userConfig = object(manifest.userConfig) ? manifest.userConfig : {};
  for (const item of secretOptions) {
    if (!/^secret_[A-Za-z_][A-Za-z0-9_]*$/.test(item.option) || Object.hasOwn(manifest.userConfig, item.option)) continue;
    manifest.userConfig[item.option] = { type: 'string', title: item.title, description: item.description, sensitive: true, default: '' };
  }
  await writeFile(file, json(manifest), 'utf8');
  return manifest;
}

// 約定 1 的固定欄位：白話說明（README 用）。範本的 title／description 若存在，以範本為準，這裡補「被擋下時」的說明。
const OPTION_HELP = {
  allowModelCalls: '插件可以透過你的 Claude 工作階段呼叫模型（用你的額度）。關閉時，插件要呼叫模型會被擋下並通知你。',
  allowAgents: '插件可以開 Claude Code 子代理（用你的額度，子代理能使用工具，權限模式和你目前的一樣）。關閉時，插件要開子代理會被擋下並通知你。',
  allowInterception: '插件可以在 Claude 使用工具前檢查並擋下（不能改寫）。預設關閉；關閉時插件的監督功能不會生效。',
  outboundMode: '插件要用你的帳號對外發文（留言、私訊、寄信、貼文）時：ask 每次問你（預設）、auto 自動發（仍有數量上限與通知）、deny 一律不准發。第一次確認視窗也可以直接選「以後都自動發」。',
  outboundHourlyLimit: 'outboundMode 為 auto 時，每小時最多幾則；0 表示不限。超過會暫停並通知。',
  outboundDailyLimit: 'outboundMode 為 auto 時，每天最多幾則；0 表示不限。',
  allowDirectExec: '插件自己直接開程式（不經 Claude Code 權限確認，也不受讀寫範圍限制）。預設關閉；關閉時插件直接開程式會被擋下，並跳出視窗問你要不要信任這個插件，選「完全信任這個插件」的效果和開啟這個選項一樣，只對這個插件有效。',
  extraFolders: '除了插件資料夾、狀態資料夾、工作資料夾以外，額外允許插件讀寫的資料夾，以 ; 分隔的絕對路徑。插件讀寫其他資料夾被擋下時，把那個資料夾加進來。'
};

/** 輸出資料夾的 README.md：第三方程式碼的風險說明、各插件選項、被擋下時去哪裡放行。已有 README.md 就補在後面。 */
export function renderPluginReadme({ name, displayName, description, userConfig = {}, outboundTools = [], secretOptions = [], securitySummary = null }) {
  const lines = [];
  lines.push(`# ${name}`, '', description ? description : `由 DSH 插件 ${displayName} 轉換的 Claude Code 插件。`, '');
  lines.push(...securityReadmeSection({ displayName, userConfig, outboundTools, secretOptions, securitySummary }));
  return lines.join('\n');
}
export function securityReadmeSection({ displayName, userConfig = {}, outboundTools = [], secretOptions = [], securitySummary = null }) {
  const lines = [];
  lines.push('## 使用前請先知道', '');
  lines.push(`- 這個插件執行的是**第三方程式碼**（DSH 插件「${displayName}」的原作者寫的，不是 Anthropic，也沒有經過 Anthropic 審核），原本也不是為 Claude Code 寫的。`);
  lines.push('- 插件程式的**權限和你的使用者帳號一樣**：可以讀寫你能讀寫的檔案、連網路。轉換後加的保護（限制直接開程式、限制讀寫的資料夾、對外發文先確認）只能降低風險，不能消除風險；網路連線目前沒有限制。');
  lines.push('- 安裝前會先做固定規則掃描與審查（結果見 `SECURITY.md`、`security-report.json`），**但審查不是保證**：規則可能漏掉透過變數組出來的行為，審查的 AI 也可能被原始碼裡的文字誤導。');
  lines.push('- **不建議在「略過權限確認」模式下使用會對外發文或會開子代理的插件**：那個模式下 Claude Code 不會再問你，插件開的子代理也沿用同樣的權限模式。');
  if (securitySummary) {
    const s = securitySummary, facts = [];
    if (s.spawnsProcesses) facts.push(`會自己開程式${s.programs?.length ? '（' + s.programs.slice(0, 8).join('、') + '）' : ''}`);
    if (s.usesNetwork) facts.push(`會連網路${s.domains?.length ? '（' + s.domains.slice(0, 8).join('、') + '）' : ''}`);
    if (s.writesFiles) facts.push('會寫入檔案');
    if (s.secretNames?.length) facts.push(`需要金鑰（${s.secretNames.join('、')}）`);
    if (s.outboundToolNames?.length) facts.push(`有對外發文工具（${s.outboundToolNames.join('、')}）`);
    if (facts.length) lines.push(`- 掃描結果摘要：${facts.join('；')}。每一項的位置見 \`SECURITY.md\`。`);
  }
  lines.push('');
  lines.push('## 插件選項', '', '在 Claude Code 的插件設定（`/config` 或安裝時的選項畫面）裡設定。以 `--plugin-dir` 載入時，值存在設定檔的 `pluginConfigs`。', '');
  lines.push('| 選項 | 意思 | 預設 |', '|---|---|---|');
  for (const [key, field] of Object.entries(userConfig ?? {})) {
    if (key.startsWith('secret_')) continue;
    const help = OPTION_HELP[key] ?? field?.description ?? '';
    const fallback = field?.default === undefined ? '（無）' : field.default === '' ? '空' : String(field.default);
    lines.push(`| \`${key}\`${field?.title ? '（' + field.title + '）' : ''} | ${String(help).replace(/\|/g, '｜')} | ${fallback} |`);
  }
  if (secretOptions.length) {
    lines.push('', '### 金鑰欄位', '', '這些欄位是敏感欄位，值存在系統的安全儲存區，不會寫進插件資料夾。**不要用 `--config` 把金鑰寫進 `runtime/settings.json`**（那是純文字，分享插件資料夾就會跟著出去）。', '');
    for (const item of secretOptions) lines.push(`- \`${item.option}\`：${item.title}。用到它的功能：${item.features}。`);
  }
  if (outboundTools.length) {
    lines.push('', '### 會對外發文的工具', '', '下列工具會用你的帳號把內容送出去，受 `outboundMode` 管：', '');
    for (const item of outboundTools) lines.push(`- \`${item.name}\`：${item.summary || item.kind}`);
  }
  lines.push('', '## 被擋下時去哪裡放行', '');
  lines.push('被保護擋下時，Claude 的工具結果或畫面通知會寫出「什麼被擋了、為什麼、怎麼放行、不放行會怎樣」。常見的情況：', '');
  lines.push('| 情況 | 放行方式 |', '|---|---|');
  lines.push('| 插件想直接執行某個程式（例如 `python`） | 跳出的詢問視窗選「完全信任這個插件」，或執行 `/<插件名稱>-trust`（再執行一次可取消）；也可以到插件選項開啟 `allowDirectExec` |');
  lines.push('| 插件想讀寫插件資料夾以外的資料夾 | 插件選項 `extraFolders` 加上那個資料夾 |');
  lines.push('| 插件經由 Claude Code 執行指令被拒 | Claude Code 自己的權限設定（和 Claude 用 Bash 時一樣） |');
  lines.push('| 對外發文等待確認或被拒 | 確認視窗的「以後都自動發」，或插件選項 `outboundMode` |');
  lines.push('| 自動發文超過數量上限 | 插件選項 `outboundHourlyLimit`、`outboundDailyLimit` |');
  lines.push('| 插件想開子代理或呼叫模型被關閉 | 插件選項 `allowAgents`、`allowModelCalls` |');
  lines.push('| 缺少金鑰 | 插件選項中對應的 `secret_<變數名稱>` 欄位 |');
  lines.push('| 插件的監督功能沒有作用 | 插件選項 `allowInterception` |');
  lines.push('');
  return lines;
}

/** 寫輸出的 README.md；已存在就把安全說明補在後面（不重複補）。 */
export async function writePluginReadme(outputDir, options) {
  const file = path.join(path.resolve(outputDir), 'README.md');
  let existing = null;
  try { existing = await readFile(file, 'utf8'); } catch { /* 沒有就新寫 */ }
  if (existing === null) await writeFile(file, renderPluginReadme(options), 'utf8');
  else if (!existing.includes('## 使用前請先知道')) await writeFile(file, existing.replace(/\s*$/, '\n\n') + securityReadmeSection(options).join('\n'), 'utf8');
  if(options.ui){const current=await readFile(file,'utf8');if(!current.includes('## 開啟原插件畫面'))await writeFile(file,current+'\n\n## 開啟原插件畫面\n\n在 Claude Code 輸入 `/'+options.name+'-ui`，會在內建瀏覽器開啟原插件的設定頁、主頁或浮窗。若內建瀏覽器不可用，指令會顯示本機網址，可用一般瀏覽器開啟。缺少的服務會在頁面列出；聊天外觀不處理。\n','utf8');}
  return file;
}

// ---------- 驗證 ----------

function skillField(text, key) {
  const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  return header?.match(new RegExp('^' + key + ':\\s*(.+?)\\s*$', 'm'))?.[1];
}

/** 指定的路徑、環境變數 DSH_TO_CLAUDE_CLI，都沒有時自動找（見 claude-cli.mjs）。 */
export async function resolveClaudeCli(cliPath, env = process.env, find = findClaude) {
  return cliPath ?? env.DSH_TO_CLAUDE_CLI ?? find(env);
}

/** 把 `claude plugin validate --json` 的報告整理成扁平清單（不保留含本機路徑的原文）。directoryFindings 是「插件目錄」上架規則的檢查，不影響 --plugin-dir 載入。 */
export function summarizeCliReport(report) {
  const pick = (rows, label) => (Array.isArray(rows) ? rows : []).map(row => (typeof row === 'string' ? row : `${row.path ? row.path + ': ' : ''}${row.message ?? JSON.stringify(row)}`)).map(text => label ? `${label}: ${text}` : text);
  const manifest = report.manifest ?? {}, contents = Array.isArray(report.contents) ? report.contents : [];
  const where = file => (file ? path.basename(String(file)) : '');
  return {
    success: report.success === true,
    errors: [...pick(manifest.errors, 'plugin.json'), ...contents.flatMap(item => pick(item.errors, where(item.file)))],
    warnings: [...pick(manifest.warnings, 'plugin.json'), ...contents.flatMap(item => pick(item.warnings, where(item.file)))],
    notes: [...pick(manifest.notes), ...contents.flatMap(item => pick(item.notes))],
    gatingHooks: contents.flatMap(item => item.gatingHooks ?? []).map(item => `${item.hook}${item.hasCatch ? ' (.catch)' : ''}`),
    directoryFindings: (report.directory?.findings ?? []).map(item => ({ code: item.code, severity: item.severity, blocking: item.blocking === true }))
  };
}

/** 執行 `claude plugin validate <dir> --json`。只讀、不跑模型。CLI 不存在時回傳 ran:false。 */
export async function runClaudePluginValidate(dir, { cliPath, timeoutMs = 90000 } = {}) {
  const cli = await resolveClaudeCli(cliPath);
  if (path.isAbsolute(cli) && !(await isFile(cli))) return { ran: false, available: false, cli, reason: '找不到 Claude Code 命令列程式；可用環境變數 DSH_TO_CLAUDE_CLI 指定' };
  return new Promise(resolve => {
    let stdout = '', stderr = '', timedOut = false;
    let command;
    try { command = claudeCommand(cli, ['plugin', 'validate', path.resolve(dir), '--json']); } catch (error) { resolve({ ran: false, available: true, cli, reason: error.message }); return; }
    const [file, argv, extra] = command;
    const child = spawn(file, argv, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...extra });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const cap = (which, chunk) => { if (which === 'out') stdout += chunk; else stderr += chunk; if (stdout.length + stderr.length > 2_000_000) child.kill(); };
    child.stdout.on('data', chunk => cap('out', chunk));
    child.stderr.on('data', chunk => cap('err', chunk));
    child.on('error', error => { clearTimeout(timer); resolve({ ran: false, available: true, cli, reason: error.message }); });
    child.on('close', exitCode => {
      clearTimeout(timer);
      let report = null;
      try { report = JSON.parse(stdout); } catch { /* 非 JSON 輸出時保留原文 */ }
      resolve({ ran: true, available: true, cli, exitCode, ok: exitCode === 0 && !timedOut, timedOut, ...(report ? summarizeCliReport(report) : { stdout: stdout.slice(0, 20000) }), stderr: stderr.slice(0, 5000) });
    });
  });
}

/**
 * 結構檢查，不載入 Claude Code，不代表插件實際可用。
 * options.cli：false 不跑 CLI；true 一定要跑（找不到 CLI 算錯誤）；'auto'（預設）有 CLI 就跑。
 */
export async function validateClaudePackage(dir, { cli = 'auto', cliPath, cliTimeoutMs } = {}) {
  const root = path.resolve(dir), errors = [], warnings = [];
  const rel = file => path.relative(root, file).split(path.sep).join('/');
  const readJson = async file => {
    try { const data = JSON.parse(await readFile(file, 'utf8')); if (!object(data)) throw new Error('必須是 JSON 物件'); return data; }
    catch (error) { errors.push(`${rel(file)}: ${error.code === 'ENOENT' ? '檔案不存在' : error.message}`); return null; }
  };
  const result = { valid: false, layout: null, errors, warnings, cli: null };
  if (!(await exists(path.join(root, '.claude-plugin', 'plugin.json')))) {
    // 純介面插件不產生插件資料夾，只留下報告；這是「不適用」，不是結構錯誤。
    try {
      const early = JSON.parse(await readFile(path.join(root, 'conversion-report.json'), 'utf8'));
      if (early?.conversion?.status === 'not-applicable') return { ...result, notApplicable: true, warnings: [early.conversion.reason ?? '不適用'] };
    } catch { /* 沒有報告就照一般流程回報缺檔 */ }
  }
  const manifest = await readJson(path.join(root, '.claude-plugin', 'plugin.json'));
  if (manifest) {
    if (typeof manifest.name !== 'string' || manifest.name.length > 64 || !NAME_PATTERN.test(manifest.name)) errors.push('plugin.json 的 name 只能用小寫英文、數字與連字號，最多 64 字');
    if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) errors.push('plugin.json 的 version 必須是語意化版本');
    if (typeof manifest.description !== 'string' || !manifest.description.trim()) errors.push('plugin.json 缺少 description');
    if (JSON.stringify(manifest).includes('__DSH_')) errors.push('plugin.json 還有未取代的 __DSH_ 佔位字串');
    if (!object(manifest.userConfig)) { if (await isFile(path.join(root, 'hooks', 'register.ts'))) warnings.push('plugin.json 沒有 userConfig；使用者無法在設定中開啟 allowModelCalls、allowAgents'); }
    else for (const key of ['allowModelCalls', 'allowAgents']) if (!object(manifest.userConfig[key])) warnings.push(`plugin.json 的 userConfig 缺少 ${key}`);
    if (object(manifest.userConfig)) for (const [key, field] of Object.entries(manifest.userConfig)) if (key.startsWith('secret_') && (!object(field) || field.type !== 'string' || field.sensitive !== true)) errors.push(`plugin.json 的金鑰欄位 ${key} 必須是 type "string" 且 sensitive: true`);
  }
  if (manifest && !(await exists(path.join(root, 'security-report.json')))) warnings.push('沒有 security-report.json（安全掃描結果）');
  if (await exists(path.join(root, 'bin'))) errors.push('不可有 bin/ 資料夾（儲存到 claude.ai 的插件會被拒絕）');
  for (const leftover of ['.codex-plugin', '.mcp.json']) if (await exists(path.join(root, leftover))) warnings.push(`發現不屬於 Claude Code 插件的檔案 ${leftover}`);

  const report = await readJson(path.join(root, 'conversion-report.json'));
  const hasHooks = await exists(path.join(root, 'hooks'));
  // 照原始碼補寫過的插件（lib/rewrite.mjs）：進入點是 hooks/main.ts，轉換的部分（有的話）仍在 hooks/register.ts。
  const rewritten = await isFile(path.join(root, 'hooks', 'main.ts')) && await isFile(path.join(root, '補寫結果.json'));
  const rewriteOnly = rewritten && !(await isFile(path.join(root, 'hooks', 'register.ts')));
  result.layout = rewriteOnly ? 'rewrite-only' : hasHooks ? 'bridge' : 'skills-only';
  if (rewritten) result.rewritten = true;
  if (report?.plugin?.layout && report.plugin.layout !== result.layout && !rewriteOnly) errors.push(`conversion-report.json 說版型是 ${report.plugin.layout}，但資料夾結構是 ${result.layout}`);

  const skillsDir = path.join(root, 'skills');
  let skillCount = 0;
  if (await isDirectory(skillsDir)) {
    for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!(await isFile(file))) { warnings.push(`skills/${entry.name} 沒有 SKILL.md`); continue; }
      skillCount++;
      const text = await readFile(file, 'utf8');
      if (!skillField(text, 'name') || !skillField(text, 'description')) warnings.push(`skills/${entry.name}/SKILL.md 的前置資料缺少 name 或 description`);
    }
  }
  result.skillCount = skillCount;

  if (result.layout === 'bridge') {
    const hooks = await readJson(path.join(root, 'hooks', 'hooks.json'));
    let registerFile = null;
    if (hooks) {
      if (!Array.isArray(hooks.modules) || hooks.modules.length !== 1 || typeof hooks.modules[0] !== 'string' || !hooks.modules[0]) errors.push('hooks/hooks.json 必須是 { "modules": ["./register.ts"] }（恰好一個路徑）');
      else {
        // 補寫過的插件：hooks.json 指向 main.ts，內嵌設定仍在 register.ts。
        registerFile = path.resolve(root, 'hooks', rewritten && hooks.modules[0] === './main.ts' ? './register.ts' : hooks.modules[0]);
        const relative = path.relative(path.join(root, 'hooks'), registerFile);
        if (relative.startsWith('..') || path.isAbsolute(relative)) { errors.push('hooks/hooks.json 的 modules 路徑超出 hooks/'); registerFile = null; }
        else if (!MODULE_SUFFIX.test(registerFile)) { errors.push('hooks/hooks.json 的 modules 檔案副檔名不是可載入的程式檔'); registerFile = null; }
      }
    }
    if (registerFile) {
      if (!(await isFile(registerFile))) errors.push(`${rel(registerFile)} 不存在`);
      else {
        const text = await readFile(registerFile, 'utf8');
        if (text.includes('__DSH_BRIDGE_CONFIG__')) errors.push(`${rel(registerFile)} 還有未取代的 __DSH_BRIDGE_CONFIG__`);
        else {
          const pluginName = text.match(/"pluginName"\s*:\s*"([^"]*)"/)?.[1];
          const hostEntry = text.match(/"hostEntry"\s*:\s*"([^"]*)"/)?.[1];
          if (!pluginName || !hostEntry) errors.push(`${rel(registerFile)} 找不到內嵌設定的 pluginName 或 hostEntry`);
          else {
            if (manifest && pluginName !== manifest.name) errors.push(`${rel(registerFile)} 內嵌的 pluginName（${pluginName}）與 plugin.json 的 name 不同`);
            const entry = path.resolve(root, hostEntry);
            const relative = path.relative(root, entry);
            if (relative.startsWith('..') || path.isAbsolute(relative)) errors.push('內嵌設定的 hostEntry 超出插件資料夾');
            else if (!(await isFile(entry))) errors.push(`內嵌設定的 hostEntry 不存在：${hostEntry}`);
          }
        }
      }
    }
    const settings = await isFile(path.join(root, 'runtime/settings.json')) ? await readJson(path.join(root, 'runtime/settings.json')) : null;
    const uiOnly=settings?.claudeHost?.uiOnly===true;
    if(uiOnly&&!(await isFile(path.join(root,'runtime/ui/manifest.json'))))errors.push('純畫面插件缺少 runtime/ui/manifest.json');
    for (const file of ['runtime/claude-host.mjs', 'runtime/settings.json', ...(uiOnly?[]:['runtime/dsh-host-worker.mjs'])]) if (!(await isFile(path.join(root, file)))) errors.push(`缺少 ${file}`);
    for (const dirName of [...(uiOnly?[]:['runtime/host-env']), 'source']) if (!(await isDirectory(path.join(root, dirName)))) errors.push(`缺少 ${dirName}/`);
    if (settings && typeof settings.name !== 'string') warnings.push('runtime/settings.json 沒有 name 欄位');
    if (report?.conversion?.sourceDependencies?.status === 'installed' && !(await isDirectory(path.join(root, 'runtime/source-deps')))) errors.push('報告說來源依賴已安裝，但缺少 runtime/source-deps/');
  } else if (result.layout === 'rewrite-only') {
    const hooks = await readJson(path.join(root, 'hooks', 'hooks.json'));
    if (hooks && (hooks.modules?.length !== 1 || hooks.modules[0] !== './main.ts')) errors.push('補寫版的 hooks/hooks.json 必須是 { "modules": ["./main.ts"] }');
    if (!(await isFile(path.join(root, 'hooks', 'rewrite', 'register.tsx'))) && !(await isFile(path.join(root, 'hooks', 'rewrite', 'register.ts')))) errors.push('缺少 hooks/rewrite/register.tsx（或 .ts）');
  } else if (!skillCount) errors.push('沒有 hooks/ 也沒有任何技能，這個插件沒有內容');

  if (report?.conversion?.status && !['converted', 'partial'].includes(report.conversion.status) && !rewriteOnly) warnings.push(`conversion-report.json 的狀態是 ${report.conversion.status}`);
  warnings.push('以上只是檔案結構檢查；沒有載入 Claude Code，也沒有啟動子程序宿主。');

  if (cli !== false) {
    if (errors.length && cli === 'auto') result.cli = { ran: false, reason: '結構檢查已有錯誤，略過 claude plugin validate' };
    else {
      result.cli = await runClaudePluginValidate(root, { cliPath, timeoutMs: cliTimeoutMs });
      if (cli === true && !result.cli.ran) errors.push(`無法執行 claude plugin validate：${result.cli.reason}`);
      if (result.cli.ran && !result.cli.ok) errors.push(`claude plugin validate 失敗（結束碼 ${result.cli.exitCode}${result.cli.timedOut ? '，逾時' : ''}）`);
      for (const message of result.cli.errors ?? []) errors.push(`claude plugin validate: ${message}`);
    }
  }
  result.valid = errors.length === 0;
  return result;
}
