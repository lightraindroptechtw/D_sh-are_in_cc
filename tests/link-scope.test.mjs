// 同一個插件同時啟動兩份時（例如還在啟動就 /reload-plugins），兩份都會去建 <stateDir>/compiled/node_modules/@deepseek-ai 的連結。
// 實際發生過：後到的那份拿到 EEXIST，插件啟動失敗。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {linkScope} from '../lib/compat/version-alias.mjs';

test('建連結：同時建同一個連結都算成功；已經指向別處的連結照樣報錯', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-link-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const target = path.join(dir, 'runtime', '@deepseek-ai'), other = path.join(dir, 'other');
  await fs.mkdir(target, {recursive: true}); await fs.mkdir(other);
  await fs.writeFile(path.join(target, 'marker'), 'x');
  const link = path.join(dir, 'compiled', '@deepseek-ai');
  await fs.mkdir(path.dirname(link));

  await Promise.all([linkScope(target, link), linkScope(target, link), linkScope(target, link)]);
  assert.equal(await fs.readFile(path.join(link, 'marker'), 'utf8'), 'x');
  await linkScope(target, link);

  await assert.rejects(linkScope(other, link), {code: 'EEXIST'});
});
