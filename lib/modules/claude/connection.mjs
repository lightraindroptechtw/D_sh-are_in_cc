export const descriptor = {
  id: 'connection', displayName: '前端連線模組（Claude Code，無作用）', services: ['connection'],
  requires: {capabilities: []},
  methods: {
    'rpc.handle': {support: 'partial', reason: 'DSH 前端（瀏覽器）連線在 Claude Code 沒有對象；登記會成功但不會有任何前端呼叫它。只記錄頻道名稱'},
    'rpc.intercept': {support: 'partial', reason: '同 rpc.handle'},
    'fetch.register': {support: 'partial', reason: '同 rpc.handle'},
    register: {support: 'partial', reason: '同 rpc.handle'},
    requestRejection: {support: 'unsupported', reason: '沒有瀏覽器驗證；此方法不存在，插件會自行回報「不可用」'},
  },
  requirements: ['只適合「沒有前端時工具仍有意義」的插件；前端專用功能（面板、卡片）不會出現'],
};

/** A connection service with nobody connected. Registration succeeds (so a plugin whose tools do not need
 * the browser still starts) and is remembered for diagnostics; nothing is ever dispatched to a handler. */
export function createClaudeConnectionService() {
  const channels = new Map(); // name -> registrations
  const remember = (kind, name) => {
    const key = `${kind}:${String(name)}`;
    channels.set(key, (channels.get(key) ?? 0) + 1);
    let released = false;
    return async () => { if (released) return; released = true; const n = (channels.get(key) ?? 1) - 1; if (n > 0) channels.set(key, n); else channels.delete(key); };
  };
  const service = {
    rpc: Object.freeze({handle: channel => remember('rpc', channel), intercept: channel => remember('rpc-intercept', channel)}),
    fetch: Object.freeze({register: route => remember('fetch', route?.path ?? route?.pattern ?? '?')}),
    // Some plugins prefer a flat register(ctx, channel, handler, options) when it exists.
    register: (_ctx, channel) => remember('rpc', channel),
    allowsRemoteAuthorities: false,
    registeredChannels: () => [...channels.keys()],
    frontendAttached: false,
  };
  return Object.freeze(service);
}

export async function install() {
  const service = createClaudeConnectionService();
  return {
    services: {connection: service}, dispose: async () => {},
    unsupported: [{feature: 'DSH frontend connection', reason: 'connection.rpc.handle / fetch.register / register 只記錄頻道，沒有前端會呼叫；插件的面板與卡片不會出現'}],
    diagnostics: [{module: 'connection', level: 'warning', status: 'partial', reason: '沒有 DSH 前端：頻道登記成功但永遠不會被呼叫。'}],
  };
}
