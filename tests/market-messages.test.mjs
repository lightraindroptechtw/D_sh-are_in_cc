// 伺服器和外掛送給網頁的訊息代碼（msg.*）都要在 market-web/i18n.js 裡有句子，網頁才能照介面語言顯示。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasKey, t } from '../market-web/i18n.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SENDERS = ['lib/market-web.mjs', 'lib/market-installed.mjs', 'hooks/register.tsx'];

test('訊息代碼：伺服器和外掛用到的每個 msg.* 都有句子', async () => {
  const codes = new Set();
  for (const file of SENDERS) {
    const text = await fs.readFile(path.join(root, file), 'utf8');
    for (const match of text.matchAll(/'(msg\.[a-zA-Z0-9.-]+)'/g)) codes.add(match[1]);
  }
  // 執行中的工作：msg.job.<動作>
  for (const action of ['review', 'scan', 'download', 'open-folder', 'ai-search']) codes.add(`msg.job.${action}`);
  assert.ok(codes.size > 30, `只找到 ${codes.size} 個代碼，比對方式可能壞了`);
  assert.deepEqual([...codes].filter(code => !hasKey(code)), []);
});

test('訊息代碼：句子裡的參數和送來的一致', () => {
  assert.equal(t('msg.aiQueryLength', { max: 200 }), '描述要寫 1 到 200 個字');
  assert.equal(t('msg.ai.picked', { count: 3 }), 'Haiku 挑出 3 個插件。');
  assert.match(t('msg.download.done', { path: 'C:/x' }), /位置：C:\/x$/);
  assert.match(t('msg.fail.deps', { action: '下載', root: 'C:/p' }), /^下載失敗。\n[\s\S]*「C:\/p」/);
});
