// 插件市場網頁的 9 種介面語言：每種語言句子齊全、{名稱} 一致，網頁程式裡不再有寫死的中文。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

Object.defineProperty(globalThis,'navigator',{value:{languages:['zh-TW']},configurable:true});
const saved=new Map();
globalThis.localStorage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)};
const i18n=await import('../market-web/i18n.js');

test('9 種語言，每種的句子都和繁體中文一樣多，{名稱} 也一樣', () => {
  assert.deepEqual(i18n.LANGS.map(item=>item.code),['zh-Hant','zh-Hans','en','ja','ko','es','fr','ru','ar']);
  for(const [code,{missing,extra}] of Object.entries(i18n.missingKeys())){
    assert.deepEqual(missing,[],`${code} 缺少`);
    assert.deepEqual(extra,[],`${code} 多出`);
  }
  const names=text=>[...text.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort().join(',');
  const base=new Map();
  const probe=key=>{i18n.setLang('zh-Hant');return i18n.t(key);};
  // 用 t 不帶值時 {名稱} 會原樣留著，拿來比對每種語言用到的名稱
  const all=['ai.count','pager.total','summary.stale','dl.npm','readme.error','market.link','detail.listsNote','version.git','tag.source'];
  for(const key of all)base.set(key,names(probe(key)));
  for(const {code} of i18n.LANGS){
    i18n.setLang(code);
    for(const key of all)assert.equal(names(i18n.t(key)),base.get(key),`${code} ${key}`);
  }
});

test('第一次打開依瀏覽器語言猜，記住使用者的選擇', () => {
  i18n.setLang('ja');
  assert.equal(i18n.lang(),'ja');
  assert.equal(saved.get('dsh-lang'),'ja');
  assert.equal(i18n.t('pager.total',{n:3}),'全 3 ページ');
  i18n.setLang('xx');
  assert.equal(i18n.lang(),'ja','不認得的語言不換');
  i18n.setLang('ar');
  assert.equal(i18n.langInfo().dir,'rtl');
  const parts=i18n.tParts('ai.count',{n:{el:1},q:'x'});
  assert.ok(parts.some(part=>typeof part==='object'),'值可以是畫面元素');
});

test('網頁程式裡的字串不再有中文（註解除外）', async () => {
  const source=await readFile(new URL('../market-web/app.js',import.meta.url),'utf8');
  const code=source.split('\n').filter(line=>!/^\s*(\/\/|\/\*\*|\*)/.test(line)).map(line=>line.replace(/\/\/.*$/,'').replace(/\/\*\*.*?\*\//g,'')).join('\n');
  const strings=[...code.matchAll(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)].map(m=>m[0]);
  assert.deepEqual(strings.filter(text=>/[一-鿿]/.test(text)),[]);
});
