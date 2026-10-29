// search 子命令：跟插件市場讀同一套社群清單，只在 GitHub 上的插件也找得到。網路用假造的清單代替。
import test from 'node:test';
import assert from 'node:assert/strict';
import {main} from '../bin/d-sh-are-in-cc.mjs';

const COMMIT='c'.repeat(40);
const LISTS={
  'https://dshopen.org/index.json':{format:1,plugins:[
    {name:'dsh-weather-open',title:'天氣查詢',description:{zh:'查天氣'},versions:[{version:'1.2.0',publishTimestamp:1790000000000,source:{type:'npm'}}]},
  ]},
  'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json':{format:1,metadata:{categories:{tools:{title:{zh:'工具'}}}},plugins:[
    {name:'dsh-weather-npm',title:'Weather',description:{en:'weather from npm'},metadata:{category:'tools'},versions:[{version:'0.3.0',publishTimestamp:1780000000000,source:{type:'npm'}}]},
    {name:'dsh-weather-git',description:{en:'weather pinned on GitHub'},versions:[{version:'0.1.0',publishTimestamp:1770000000000,source:{type:'git',url:'https://github.com/o/pinned',commit:COMMIT}}]},
  ]},
  'https://awesome-dsh-plugin.com/catalog.json':{items:[
    {npm:0,name:'weather-gh',slug:'o/weather-gh--pkg',owner:'o',cat:'tools',dl:7,stars:3,added:'2026-10-20',desc:'weather only on GitHub',cmd:'dsh plugin --profile web add github:o/weather-gh#path:/pkg',href:'/p/o/weather-gh--pkg/'},
    {npm:0,name:'weather-tgz',slug:'o/weather-tgz',owner:'o',desc:'weather as a release file',cmd:'dsh plugin --profile web add "https://github.com/o/weather-tgz/releases/download/v1/w.tgz"'},
    {npm:1,name:'unrelated',slug:'o/unrelated',owner:'o',desc:'nothing to see',cmd:'dsh plugin --profile web add unrelated'},
  ]},
};

async function runSearch(t,args,lists=LISTS){
  const fetched=[];
  t.mock.method(globalThis,'fetch',async url=>{
    fetched.push(String(url));
    const body=lists[String(url)];
    return body?new Response(JSON.stringify(body),{status:200}):new Response('',{status:503});
  });
  let out='';
  t.mock.method(process.stdout,'write',chunk=>{out+=chunk;return true;});
  await main(['search',...args]);
  return {result:JSON.parse(out),fetched};
}

test('search 查兩個社群清單：npm、固定提交的 GitHub、只在 GitHub 上的都找得到，發布檔沒有來源寫法', async t => {
  const {result,fetched}=await runSearch(t,['weather','--limit','10']);
  assert.deepEqual(new Set(fetched),new Set(Object.keys(LISTS)));
  assert.deepEqual(result.catalogs.map(c=>c.total),[1,5]);
  const byName=Object.fromEntries(result.results.map(r=>[r.name,r]));
  assert.equal(result.total,5,'名稱、說明裡有 weather 的都算；unrelated 不算');
  assert.equal(byName['dsh-weather-npm'].source,'npm:dsh-weather-npm@0.3.0');
  assert.equal(byName['dsh-weather-git'].source,`https://github.com/o/pinned/tree/${COMMIT}`);
  assert.equal(byName['o/weather-gh--pkg'].source,'https://github.com/o/weather-gh');
  assert.equal(byName['o/weather-gh--pkg'].packageDir,'pkg');
  assert.equal(byName['o/weather-gh--pkg'].downloads30d,7);
  assert.deepEqual(byName['o/weather-gh--pkg'].lists,['Awesome DSH 插件精選']);
  assert.equal(byName['o/weather-tgz'].source,null,'發布檔轉換器還不能下載');
  assert.match(result.note,/不是指令/);
});

test('search 中文關鍵字、排序與更新日期；一份清單讀不到時照樣回報另一份，並寫明原因', async t => {
  const {result}=await runSearch(t,['天氣','--sort','downloads'],{...LISTS,'https://awesome-dsh-plugin.com/catalog.json':undefined,'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json':undefined});
  assert.equal(result.sort,'downloads');
  assert.deepEqual(result.results.map(r=>r.name),['dsh-weather-open']);
  assert.match(result.results[0].updated,/^2026-09-2[12]$/,'清單的時間轉成日期（依所在時區）');
  assert.match(result.catalogs[1].error,/HTTP 503/);
});

test('search 兩份清單都讀不到時說明原因', async t => {
  await assert.rejects(runSearch(t,['x'],{}),/讀不到任何 DSH 插件清單/);
});
