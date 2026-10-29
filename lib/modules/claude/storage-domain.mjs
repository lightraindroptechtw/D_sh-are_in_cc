import fs from 'node:fs/promises';
import path from 'node:path';
import {claudeError} from './common.mjs';

export const descriptor = {
  id: 'storageDomain', displayName: '領域儲存模組（Claude Code）', services: ['storageDomain', 'storage'],
  requires: {capabilities: []},
  methods: {
    'storageDomain.open': {support: 'full', reason: '沿用官方 @deepseek-ai/dsh-storage-domain（結構驗證、單一開啟、變更事件）'},
    'storage.backend': {support: 'partial', reason: '官方 storage 樞紐 + 本模組的檔案後端 claude-kv：每個 domain 一個 JSON 檔，放在宿主狀態資料夾的 storage/ 之下；整份檔案原子改寫'},
    'layout.per-record': {support: 'partial', reason: '宣告 per-record 的 domain 也存成單一檔案（資料正確，只是每次寫入改寫整份）；沒有 backupRecord，壞紀錄會明確失敗而不是被移開'},
    'backend.sqlite': {support: 'unsupported', reason: '沒有 SQLite 後端'},
  },
  requirements: ['資料寫在宿主的狀態資料夾，不寫進 Claude Code 的設定'],
};

const BACKEND = 'claude-kv';
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*(?:-[a-z0-9_]+)*$/i;

/** A minimal StorageBackend (kv facet): one atomically rewritten JSON file per unit. */
export function createKvBackend({dir, StorageError}) {
  const open = new Map();
  let closed = false;
  const fail = (code, message) => new StorageError(code, message);

  async function atomicWrite(file, text) {
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, text, {mode: 0o600});
    for (let attempt = 0; ; attempt += 1) {
      try { await fs.rename(temp, file); return; }
      catch (error) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) { await fs.rm(temp, {force: true}); throw error; }
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }

  const kv = {
    async open(descriptor) {
      if (closed) throw fail('closed', 'storage backend is closed');
      if (!UNIT_NAME_RE.test(descriptor.name)) throw fail('malformed-medium', `invalid unit name '${descriptor.name}'`);
      if (open.has(descriptor.name)) throw fail('already-open', `unit '${descriptor.name}' is already open`);
      const file = path.join(dir, `${descriptor.name}.json`);
      let data = {version: descriptor.version, tables: {}, global: null};
      let text;
      try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (text !== undefined) {
        let parsed;
        try { parsed = JSON.parse(text); } catch { throw fail('malformed-medium', `unit '${descriptor.name}' is not valid JSON`); }
        if (!parsed || typeof parsed !== 'object' || typeof parsed.tables !== 'object' || parsed.tables === null) throw fail('malformed-medium', `unit '${descriptor.name}' has an unexpected shape`);
        if (parsed.version !== descriptor.version && !(descriptor.compatibleVersions ?? []).includes(parsed.version)) throw fail('version-mismatch', `unit '${descriptor.name}' is version ${String(parsed.version)}, expected ${descriptor.version}`);
        data = {version: descriptor.version, tables: parsed.tables, global: parsed.global ?? null};
      }
      for (const table of descriptor.tables) data.tables[table] ??= {};
      let chain = Promise.resolve(), isClosed = false;
      const guard = () => { if (isClosed) throw fail('closed', `unit '${descriptor.name}' is closed`); };
      const persist = () => {
        const snapshot = JSON.stringify({version: descriptor.version, tables: data.tables, global: data.global});
        const run = chain.then(async () => { await fs.mkdir(dir, {recursive: true, mode: 0o700}); await atomicWrite(file, snapshot); });
        chain = run.catch(() => {});
        return run;
      };
      const unit = {
        async loadAll() { guard(); return {tables: JSON.parse(JSON.stringify(data.tables)), global: data.global === null ? null : JSON.parse(JSON.stringify(data.global))}; },
        async putRecord(table, key, value) { guard(); if (!descriptor.tables.includes(table)) throw fail('malformed-medium', `unknown table '${table}'`); data.tables[table][key] = JSON.parse(JSON.stringify(value)); await persist(); },
        async deleteRecord(table, key) { guard(); if (!descriptor.tables.includes(table)) return; delete data.tables[table][key]; await persist(); },
        async setGlobal(value) { guard(); if (!descriptor.hasGlobal) throw fail('malformed-medium', 'this unit declares no global slot'); data.global = JSON.parse(JSON.stringify(value)); await persist(); },
        async close() { if (isClosed) return; isClosed = true; open.delete(descriptor.name); await chain; },
      };
      open.set(descriptor.name, unit);
      return unit;
    },
  };
  return {
    kv,
    async close() { if (closed) return; closed = true; await Promise.allSettled([...open.values()].map(unit => unit.close())); },
  };
}

export async function install({root, load, options = {}} = {}) {
  if (typeof load !== 'function' || !root?.plugin) throw claudeError('storageDomain', 'install', '需要 Cordis root 與官方套件載入器', 'DSH_MODULE_UNSUPPORTED');
  let home = options.dir;
  if (!home) { try { home = root.get('profileContext')?.home; } catch { /* absent */ } }
  if (typeof home !== 'string' || !home) throw claudeError('storageDomain', 'install', '找不到宿主的狀態資料夾，無法放置資料', 'DSH_STORAGE_NO_HOME');
  const dir = options.dir ? path.resolve(options.dir) : path.join(home, 'storage');
  const storage = await load('@deepseek-ai/dsh-storage');
  const domain = await load('@deepseek-ai/dsh-storage-domain');
  const forks = [];
  const mount = async (plugin, config) => { const fork = root.plugin(plugin, config); await fork?.await?.(); forks.push(fork); return fork; };
  if (!root.get('storage')) await mount(storage.default, {});
  const backend = createKvBackend({dir, StorageError: storage.StorageError});
  await mount({
    name: 'claude-kv-backend', inject: ['storage'],
    apply(ctx) {
      ctx.effect(() => {
        const unregister = ctx.storage.backend.register(BACKEND, backend);
        return async () => { unregister(); await backend.close(); };
      });
      ctx.provide(storage.storageBackendServiceKey(BACKEND), backend);
    },
  }, {});
  await mount({name: domain.name, inject: domain.inject, Config: domain.Config, apply: domain.apply}, {backend: BACKEND});
  const facility = root.get('storageDomain');
  if (!facility) throw claudeError('storageDomain', 'install', '官方 storage-domain 沒有提供 storageDomain', 'DSH_STORAGE_NOT_MOUNTED');
  return {
    services: {storageDomain: facility, storage: root.get('storage')},
    async dispose() { for (const fork of [...forks].reverse()) { try { await fork?.dispose?.(); } catch { /* keep tearing down */ } } },
    diagnostics: [{module: 'storageDomain', level: 'info', status: 'partial', reason: `官方 storage-domain，後端為檔案 JSON（${BACKEND}）；資料放在宿主狀態資料夾的 storage/。`}],
  };
}
