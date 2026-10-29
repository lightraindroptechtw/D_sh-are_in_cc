import {claudeError, guardService} from './common.mjs';
import {blockedError, credentialNotice} from './blocked.mjs';

export const descriptor = {
  id: 'credentials', displayName: '憑證模組（Claude Code，只讀環境變數）', services: ['credentials'],
  requires: {capabilities: []},
  methods: {
    resolve: {support: 'partial', reason: '憑證參考名稱就是環境變數名稱，每次呼叫即時讀取。找不到或空字串時丟 DSH_CREDENTIAL_MISSING（四段式訊息，點名插件選項 secret_<變數名稱>），不回傳空值'},
    describe: {support: 'partial', reason: '只回報是否已設定與來源 env；writable 一律 false；不含值'},
    set: {support: 'unsupported', reason: '不寫入環境或任何憑證儲存'},
    unset: {support: 'unsupported', reason: '不修改環境或任何憑證儲存'},
    readRecord: {support: 'unsupported', reason: '沒有 DSH 憑證紀錄儲存'}, describeRecord: {support: 'unsupported', reason: '沒有 DSH 憑證紀錄儲存'},
    listRecords: {support: 'unsupported', reason: '沒有 DSH 憑證紀錄儲存'}, modifyRecord: {support: 'unsupported', reason: '沒有可寫入的憑證儲存'}, deleteRecord: {support: 'unsupported', reason: '沒有可寫入的憑證儲存'},
  },
  requirements: ['金鑰由 mod 從插件選項 secret_<變數名稱>（userConfig 敏感欄位）傳入，變數名稱列在 DSH_CLAUDE_SECRET_NAMES；也可在轉換時用 --pass-env 傳入。值不寫進設定、日誌或報告'],
};

const REF = /^[A-Za-z_][A-Za-z0-9_]*$/;
const refName = (value, method) => {
  const name = typeof value === 'string' ? value : value?.name;
  if (typeof name !== 'string' || !REF.test(name)) throw claudeError('credentials', method, '憑證參考必須是環境變數名稱（英數字與底線）', 'DSH_CREDENTIAL_BAD_REF');
  return name;
};

export function createClaudeCredentialsService({env = process.env, plugin, currentFeature} = {}) {
  const read = name => { const v = env[name]; return typeof v === 'string' && v.length > 0 ? v : undefined; };
  return guardService({
    async resolve(ref) {
      const name = refName(ref, 'resolve'), value = read(name);
      if (value === undefined) {
        const blocked = blockedError('DSH_CREDENTIAL_MISSING', credentialNotice(name, {plugin, feature: currentFeature?.()}));
        throw Object.assign(claudeError('credentials', 'resolve', blocked.message, 'DSH_CREDENTIAL_MISSING'), {blocked: blocked.blocked, credential: name});
      }
      return {value, source: 'env'};
    },
    async describe(ref) {
      const configured = read(refName(ref, 'describe')) !== undefined;
      return {configured, ...(configured ? {source: 'env'} : {}), writable: false};
    },
  }, 'credentials', '持久憑證、授權紀錄與寫入在 Claude Code 宿主不支援（只讀環境變數）');
}

export async function install({env, hostInfo} = {}) {
  return {services: {credentials: createClaudeCredentialsService({env, plugin: hostInfo?.plugin, currentFeature: hostInfo?.currentFeature})}, dispose: async () => {}, diagnostics: [{module: 'credentials', level: 'info', reason: '憑證參考即時讀取環境變數，缺少時丟明確錯誤；診斷不含任何值。'}]};
}
