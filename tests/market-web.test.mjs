import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createMarketWeb} from '../lib/market-web.mjs';
import {npmDownloadsPeriod} from '../hooks/catalog.ts';

// 假造的網路：三個清單檔、一份自述文件、npm 下載統計。
const OPEN={format:1,plugins:[
  {name:'dsh-a',title:'A 插件',versions:[{version:'1.0.0',publishTimestamp:1790000000,source:{type:'npm'}}]},
  {name:'dsh-icon',icon:'icons/i.svg',versions:[{version:'2.0.0',publishTimestamp:1790000000,source:{type:'npm'}}]},
]};
const INDEX={format:1,metadata:{categories:{tools:{title:{zh:'工具'}}}},plugins:[{name:'dsh-a',versions:[{version:'1.0.0',publishTimestamp:1790000000,source:{type:'npm'}}]}]};
const SITE={items:[
  {npm:0,name:'gh',slug:'o/gh',owner:'o',cat:'tools',added:'2026-10-01',cmd:'dsh plugin --profile web add github:o/gh',href:'/p/o/gh/'},
  {npm:0,name:'rel',slug:'o/rel',owner:'o',cmd:'dsh plugin --profile web add "https://github.com/o/rel/releases/latest/download/rel.tgz"'},
]};
const FILES={
  'https://dshopen.org/index.json':JSON.stringify(OPEN),
  'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json':JSON.stringify(INDEX),
  'https://awesome-dsh-plugin.com/catalog.json':JSON.stringify(SITE),
  'https://data.jsdelivr.com/v1/packages/npm/dsh-a@1.0.0?structure=flat':JSON.stringify({files:[{name:'/README.md'}]}),
  'https://cdn.jsdelivr.net/npm/dsh-a@1.0.0/README.md':'# A\n<img src="x" onerror="alert(1)">',
  'https://registry.npmjs.org/dsh-a/1.0.0':JSON.stringify({name:'dsh-a',version:'1.0.0',icon:'assets/icon.png'}),
  [`https://api.npmjs.org/downloads/point/${npmDownloadsPeriod(Date.now())}/dsh-a`]:JSON.stringify({downloads:914,package:'dsh-a',start:'2026-09-23',end:'2026-10-22'}),
};
const fakeFetch=async url=>{const text=FILES[url];return {ok:text!==undefined,status:text===undefined?404:200,text:async()=>text??''};};

/** 用原始的 http 送請求，才能自己指定 Host 與 Origin。 */
function request(web,{method='GET',path='/',headers={},body}={}){
  const {port}=new URL(web.origin);
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,method,path,headers:{host:`127.0.0.1:${port}`,...headers}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');let json;try{json=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,json});});
    });
    req.on('error',reject);if(body!==undefined)req.write(body);req.end();
  });
}
const withKey=web=>({'x-dsh-access':web.token});

test('網址帶存取鑰匙，只綁 127.0.0.1；頁面有安全標頭', async t=>{
  const web=createMarketWeb({fetchImpl:fakeFetch});t.after(()=>web.close());
  assert.equal(web.opened,false);
  const {url}=await web.open();
  assert.match(url,/^http:\/\/127\.0\.0\.1:\d+\/#access=[a-f0-9]{64}$/);
  assert.equal(web.opened,true);
  const page=await request(web);
  assert.equal(page.status,200);
  assert.match(page.headers['content-security-policy'],/script-src 'self'/);
  assert.equal(page.headers['x-frame-options'],'DENY');
  assert.equal(page.headers['referrer-policy'],'no-referrer');
  assert.ok(page.text.includes('/app.js'));
  assert.equal((await request(web,{path:'/../lib/market-web.mjs'})).status,404,'只送寫死的幾個檔案');
});

test('沒有鑰匙、鑰匙錯、別的網域、別的 Host 一律拒絕', async t=>{
  const web=createMarketWeb({fetchImpl:fakeFetch});t.after(()=>web.close());await web.open();
  assert.equal((await request(web,{path:'/api/catalog'})).status,403);
  assert.equal((await request(web,{path:'/api/catalog',headers:{'x-dsh-access':'0'.repeat(64)}})).status,403);
  assert.equal((await request(web,{path:'/api/catalog',headers:{...withKey(web),origin:'https://evil.example'}})).status,403);
  assert.equal((await request(web,{path:'/api/catalog',headers:{...withKey(web),'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await request(web,{path:'/api/catalog',headers:{...withKey(web),host:'evil.example'}})).status,421,'擋掉把別的網域指到本機');
  const ok=await request(web,{path:'/api/catalog',headers:withKey(web)});
  assert.equal(ok.status,200);
});

test('清單、自述文件、下載次數', async t=>{
  const web=createMarketWeb({fetchImpl:fakeFetch});t.after(()=>web.close());await web.open();
  const {json}=await request(web,{path:'/api/catalog',headers:withKey(web)});
  assert.equal(json.meta.phase,'ready');
  assert.deepEqual(json.entries.map(e=>e.name).sort(),['dsh-a','dsh-icon','o/gh','o/rel']);
  assert.equal(json.entries.find(e=>e.name==='dsh-icon').icon,'https://dshopen.org/icons/i.svg');
  assert.equal(json.entries.find(e=>e.name==='o/gh').category,'工具與能力');
  assert.equal(json.entries.find(e=>e.name==='o/gh').categoryId,'tools');
  assert.equal(json.meta.markets.length,2);
  const readme=(await request(web,{path:'/api/readme?name=dsh-a&version=1.0.0',headers:withKey(web)})).json;
  assert.equal(readme.phase,'done');
  assert.equal(readme.base,'https://cdn.jsdelivr.net/npm/dsh-a@1.0.0/');
  assert.match(readme.from,/經 jsDelivr 讀取/);
  assert.equal((await request(web,{path:'/api/readme?name=nope&version=1',headers:withKey(web)})).status,404);
  const counts=(await request(web,{path:'/api/downloads?names=dsh-a,o/gh,evil',headers:withKey(web)})).json.counts;
  assert.deepEqual(Object.keys(counts),['dsh-a'],'只查清單裡的 npm 插件');
  assert.equal(counts['dsh-a'].downloads,914);
  const icons=(await request(web,{path:'/api/icons?names=dsh-a,dsh-icon,o/gh,evil',headers:withKey(web)})).json.icons;
  assert.deepEqual(icons,{'dsh-a':'https://cdn.jsdelivr.net/npm/dsh-a@1.0.0/assets/icon.png'},'只查清單沒有圖示的 npm 插件');
});

test('動作排隊：來源寫法由清單產生；外掛拿走後回報，網頁看得到結果', async t=>{
  const web=createMarketWeb({fetchImpl:fakeFetch});t.after(()=>web.close());await web.open();
  await request(web,{path:'/api/catalog',headers:withKey(web)});
  const post=body=>request(web,{method:'POST',path:'/api/jobs',headers:{...withKey(web),'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await request(web,{method:'POST',path:'/api/jobs',headers:{...withKey(web),'content-type':'text/plain'},body:'{}'})).status,415,'只接受 JSON');
  assert.equal((await post({action:'rm',name:'dsh-a',version:'1.0.0'})).status,400);
  assert.equal((await post({action:'review',name:'dsh-a',version:'9.9.9'})).status,404,'清單裡沒有的版本');
  assert.equal((await post({action:'review',name:'o/rel',version:'發布檔'})).status,400,'發布檔不能下載');
  assert.equal((await post({action:'review',name:'dsh-a',version:'1.0.0',spec:'npm:evil'})).status,200);
  assert.equal((await post({action:'review',name:'dsh-a',version:'1.0.0'})).status,409,'同一個動作不重複排隊');
  assert.equal((await post({action:'download',name:'o/gh',version:'最新版'})).status,200);
  assert.equal((await post({action:'scan',name:'dsh-a',version:'1.0.0'})).status,409,'下載或掃描一次一個');
  const taken=web.take();
  assert.deepEqual(taken.map(j=>[j.action,j.spec,j.packageDir]),[['review','npm:dsh-a@1.0.0',undefined],['download','https://github.com/o/gh',undefined]],'網頁給的 spec 不採用');
  assert.deepEqual(web.take(),[],'拿過的不會再拿');
  assert.equal(web.report({id:taken[1].id,phase:'done',text:'已下載',path:'C:\\x'}),true);
  assert.equal(web.report({id:'999',phase:'done'}),false);
  assert.equal(web.report({id:taken[0].id,phase:'hacked'}),false);
  const jobs=(await request(web,{path:'/api/jobs',headers:withKey(web)})).json.jobs;
  assert.equal(jobs.find(j=>j.id===taken[1].id).path,'C:\\x');
  assert.equal(jobs.find(j=>j.id===taken[0].id).phase,'running');
  assert.ok(jobs.every(j=>!('spec' in j)),'網頁看不到來源寫法以外的內部欄位');
  // 開資料夾只能指定先前的工作，不能自己給路徑。
  assert.equal((await post({action:'open-folder',job:taken[0].id})).status,400);
  const open=await post({action:'open-folder',job:taken[1].id,path:'C:\\Windows'});
  assert.equal(open.status,200);
  assert.equal(web.take()[0].path,'C:\\x');
  assert.equal((await request(web,{method:'POST',path:'/api/jobs',headers:{...withKey(web),'content-type':'application/json'},body:'x'.repeat(5000)})).status,413);
});

test('Haiku 搜尋：描述排進佇列，外掛用關鍵字找候選，回報的結果只留清單裡有的插件', async t=>{
  const web=createMarketWeb({fetchImpl:fakeFetch});t.after(()=>web.close());
  await web.open();
  await request(web,{path:'/api/catalog',headers:withKey(web)});
  const post=body=>request(web,{method:'POST',path:'/api/jobs',headers:{...withKey(web),'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post({action:'ai-search',query:'  '})).status,400,'空的描述不收');
  assert.equal((await post({action:'ai-search',query:'x'.repeat(301)})).status,400,'太長不收');
  const queued=await post({action:'ai-search',query:'找個 GitHub 工具',lang:'ja'});
  assert.equal(queued.status,200);
  assert.equal((await post({action:'ai-search',query:'再一個'})).status,409,'一次一個');
  const [taken]=web.take();
  assert.deepEqual([taken.action,taken.query,taken.lang],['ai-search','找個 GitHub 工具','ja']);
  // 名稱、標題對到加倍：o/gh 名稱有 gh；dsh-a 只有標題「A 插件」對到「插件」
  const found=web.candidates(['gh','插件',42,'']);
  assert.deepEqual(found.map(c=>c.name),['o/gh','dsh-a']);
  assert.ok(found.every(c=>c.description.length<=160));
  assert.deepEqual(web.candidates('not a list'),[]);
  // 3 個字母以內的英文詞要整個詞對到：ds 不算對到 dsh-a
  assert.deepEqual(web.candidates([['ds']]),[]);
  // 一組同義詞只算一次：o/gh 對到同組的三個詞，分數不會比只對到一個詞的高
  const synonyms=web.candidates([['gh','github','o/gh'],['插件']]);
  assert.deepEqual(synonyms.map(c=>c.name),['o/gh','dsh-a']);
  // 中文詞不管空白：標題寫「A 插件」，關鍵字「a插件」也對到
  assert.deepEqual(web.candidates([['a插件']]).map(c=>c.name),['dsh-a']);
  assert.equal(web.report({id:taken.id,phase:'done',text:'ok',results:[{name:'o/gh',reason:'r'.repeat(500)},{name:'evil/x',reason:'不在清單'},{reason:'沒名字'}]}),true);
  const {json}=await request(web,{path:'/api/jobs',headers:withKey(web)});
  const job=json.jobs.find(j=>j.id===taken.id);
  assert.equal(job.phase,'done');
  assert.deepEqual(job.results.map(r=>r.name),['o/gh']);
  assert.equal(job.results[0].reason.length,300);
  assert.equal((await post({action:'ai-search',query:'再一個'})).status,200,'上一個完成後可以再搜');
});
