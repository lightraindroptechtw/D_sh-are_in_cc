#!/usr/bin/env node
// 瀏覽器版 DSH 插件市場的 MCP 伺服器：Claude Code 啟動插件時一起啟動、結束時一起結束。
// 只給同一個插件的外掛（hooks/register.tsx）用 $.mcp.call 呼叫，外掛也會擋掉模型直接呼叫這些工具。
// 標準輸出只走 MCP 訊息（一行一則 JSON-RPC），說明文字一律寫到標準錯誤。
import readline from 'node:readline';
import { createMarketWeb } from '../lib/market-web.mjs';

const web = createMarketWeb();
const INTERNAL = '只給 D_sh-are_in_cc 外掛內部使用，模型不要呼叫。';
// caller：外掛每次呼叫都帶的隨機值，外掛的權限檢查靠它分辨是不是自己呼叫的；這裡不使用。
const CALLER = { caller: { type: 'string' } };
const TOOLS = [
  { name: 'dsh_market_open', description: `啟動本機市場網站並回傳網址。${INTERNAL}`, inputSchema: { type: 'object', properties: { ...CALLER }, additionalProperties: false } },
  { name: 'dsh_market_take', description: `取出網頁上排隊的工作。${INTERNAL}`, inputSchema: { type: 'object', properties: { ...CALLER }, additionalProperties: false } },
  {
    name: 'dsh_market_report',
    description: `回報工作結果給網頁。${INTERNAL}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...CALLER, id: { type: 'string' }, phase: { enum: ['running', 'done', 'error'] }, text: { type: 'string' }, path: { type: 'string' }, markdown: { type: 'string' },
        results: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, reason: { type: 'string' } }, required: ['name'] } },
      },
      required: ['id', 'phase'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_market_candidates',
    description: `Haiku 搜尋用：依關鍵字在清單裡找候選插件；keywords 每一項是一組同義詞（陣列）或一個詞，第一組最重要。${INTERNAL}`,
    inputSchema: { type: 'object', properties: { ...CALLER, keywords: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } } }, required: ['keywords'], additionalProperties: false },
  },
];

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

async function call(name, args) {
  if (name === 'dsh_market_open') return result(await web.open());
  if (name === 'dsh_market_take') return result({ jobs: web.take(), opened: web.opened });
  if (name === 'dsh_market_report') return result({ ok: web.report(args) });
  if (name === 'dsh_market_candidates') return result({ candidates: web.candidates(args.keywords) });
  return { content: [{ type: 'text', text: `沒有這個工具：${name}` }], isError: true };
}

async function handle(message) {
  const { id, method, params } = message ?? {};
  const reply = value => id !== undefined && send({ jsonrpc: '2.0', id, result: value });
  const fail = (code, text) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message: text } });
  if (method === 'initialize') return reply({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'dsh-market', version: '0.1.0' } });
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: TOOLS });
  if (method === 'tools/call') {
    try {
      return reply(await call(params?.name, params?.arguments ?? {}));
    } catch (cause) {
      return reply({ content: [{ type: 'text', text: cause instanceof Error ? cause.message : String(cause) }], isError: true });
    }
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) return undefined;
  return fail(-32601, `不支援的方法：${method}`);
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  handle(message).catch(cause => process.stderr.write(`dsh-market: ${cause instanceof Error ? cause.message : String(cause)}\n`));
});
lines.on('close', () => web.close().finally(() => process.exit(0)));
