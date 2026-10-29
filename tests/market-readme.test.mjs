// 自述文件：npm 版本先找 jsDelivr 上這一版的檔案；讀不到時改讀插件 GitHub 倉庫預設分支的，並註明可能和這一版不同。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readReadme} from '../hooks/readme.ts';

const entry={name:'dsh-a',repository:'https://github.com/o/dsh-a',versions:[]};
const v100={version:'1.0.0',published:1,source:{type:'npm'}};
const fake=files=>{const seen=[];const fetchText=async url=>{seen.push(url);return files[url];};return {fetchText,seen};};

test('npm 版本的自述文件從 jsDelivr 讀這一版的', async () => {
  const {fetchText}=fake({
    'https://data.jsdelivr.com/v1/packages/npm/dsh-a@1.0.0?structure=flat':JSON.stringify({files:[{name:'/README.md'}]}),
    'https://cdn.jsdelivr.net/npm/dsh-a@1.0.0/README.md':'# A',
  });
  const found=await readReadme(fetchText,entry,v100);
  assert.equal(found.url,'https://cdn.jsdelivr.net/npm/dsh-a@1.0.0/README.md');
  assert.match(found.from,/npm 套件 dsh-a@1\.0\.0/);
});

test('jsDelivr 還沒有這一版（剛發布）或清單裡沒有自述文件：改讀 GitHub 倉庫的，並說明可能不同', async () => {
  const github={'https://raw.githubusercontent.com/o/dsh-a/HEAD/README.md':'# from github'};
  const missing=await readReadme(fake(github).fetchText,entry,v100);
  assert.equal(missing.text,'# from github');
  assert.match(missing.from,/讀不到自述文件，改讀倉庫的，內容可能和這一版不同/);
  const empty=await readReadme(fake({...github,'https://data.jsdelivr.com/v1/packages/npm/dsh-a@1.0.0?structure=flat':JSON.stringify({files:[{name:'/index.js'}]})}).fetchText,entry,v100);
  assert.equal(empty.url,'https://raw.githubusercontent.com/o/dsh-a/HEAD/README.md');
});

test('兩邊都沒有：清單讀不到時說原因，清單有但沒有自述文件時回傳沒有', async () => {
  await assert.rejects(readReadme(fake({}).fetchText,entry,v100),/jsDelivr 查不到/);
  const noRepo={...entry,repository:''};
  const list={'https://data.jsdelivr.com/v1/packages/npm/dsh-a@1.0.0?structure=flat':JSON.stringify({files:[]})};
  assert.equal(await readReadme(fake(list).fetchText,noRepo,v100),undefined);
});
