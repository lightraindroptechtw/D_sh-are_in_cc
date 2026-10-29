import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeIndex,mergeCatalogs,searchCatalog,categoryOptions,sourceSpec,formatDate,formatDateTime,pickText,MARKETS,formatCount,npmDownloadsPeriod,npmDownloadsUrls,parseNpmDownloads,normalizeSiteCatalog,categoryTitles,pickReadme,cleanReadme,canFetch,iconUrl,npmIcon,npmManifestUrl,CATEGORY_TITLES} from '../hooks/catalog.ts';

const COMMIT='b'.repeat(40);
const index=plugins=>({format:1,metadata:{categories:{tools:{title:{zh:'工具',en:'Tools'}}}},plugins});

test('格式不對的條目和版本略過，不讓整份目錄失敗', () => {
  const entries=normalizeIndex(index([
    {name:'ok-plugin',title:{en:'OK',zh:'好'},metadata:{category:'tools'},versions:[{version:'1.0.0',publishTimestamp:1,source:{type:'npm'}}]},
    {name:'-flag',versions:[{version:'1.0.0',source:{type:'npm'}}]},
    {name:'Upper',versions:[{version:'1.0.0',source:{type:'npm'}}]},
    {name:'no-version',versions:[]},
    {name:'bad-git',versions:[{version:'1.0.0',source:{type:'git',url:'https://evil.example/x/y',commit:COMMIT}}]},
    {name:'short-commit',versions:[{version:'1.0.0',source:{type:'git',url:'https://github.com/a/b',commit:'abc'}}]},
    {name:'escape-path',versions:[{version:'1.0.0',source:{type:'git',url:'https://github.com/a/b',commit:COMMIT,path:'../x'}}]},
    {name:'odd-version',versions:[{version:'--help',source:{type:'npm'}},{version:'2.0.0',source:{type:'npm'}}]},
    'not an object',
  ]),'open');
  assert.deepEqual(entries.map(e=>e.name),['ok-plugin','escape-path','odd-version']);
  assert.equal(entries[0].title,'好');
  assert.equal(entries[0].category,'工具與能力','認得的分類用合併後的繁體中文名稱');
  assert.equal(entries[0].categoryId,'tools');
  assert.equal(entries[1].versions[0].source.path,undefined,'跳出倉庫的子目錄被拿掉');
  assert.deepEqual(entries[2].versions.map(v=>v.version),['2.0.0']);
  assert.throws(()=>normalizeIndex({format:1},'open'),/缺少 plugins/);
});

test('合併：同名一筆、版本聯集、記下市場、依最近更新排序', () => {
  const a=normalizeIndex(index([{name:'x',title:'x',versions:[{version:'1.0.0',publishTimestamp:10,source:{type:'npm'}}]}]),'open');
  const b=normalizeIndex(index([
    {name:'x',title:'X 工具',description:'說明',versions:[{version:'1.1.0',publishTimestamp:30,source:{type:'npm'}},{version:'1.0.0',publishTimestamp:10,source:{type:'npm'}}]},
    {name:'y',versions:[{version:'0.1.0',publishTimestamp:20,source:{type:'npm'}}]},
  ]),'awesome');
  const all=mergeCatalogs([a,b]);
  assert.deepEqual(all.map(e=>e.name),['x','y']);
  assert.deepEqual(all[0].markets,['open','awesome']);
  assert.deepEqual(all[0].versions.map(v=>v.version),['1.1.0','1.0.0']);
  assert.equal(all[0].title,'X 工具');
  assert.equal(all[0].description,'說明');
  assert.equal(a[0].markets.length,1,'不改動傳入的資料');
});

test('圖示：開放插件市場的相對路徑接在清單網址底下；合併時沒有圖示的補上', () => {
  const v=[{version:'1.0.0',publishTimestamp:1,source:{type:'npm'}}];
  const raw=index([{name:'a',icon:'icons/abc.svg',versions:v},{name:'b',icon:'../x.svg',versions:v},{name:'c',icon:'icons/run.js',versions:v}]);
  const open=normalizeIndex(raw,'open','https://dshopen.org/index.json');
  assert.equal(open.find(e=>e.name==='a').icon,'https://dshopen.org/icons/abc.svg');
  assert.equal(open.find(e=>e.name==='b').icon,undefined,'不能跳出清單網站的目錄');
  assert.equal(open.find(e=>e.name==='c').icon,undefined,'只接受圖片副檔名');
  assert.equal(normalizeIndex(raw,'open')[0].icon,undefined,'沒給清單網址就不猜');
  const plain=normalizeIndex(index([{name:'a',versions:v}]),'awesome');
  assert.equal(mergeCatalogs([plain,open]).find(e=>e.name==='a').icon,'https://dshopen.org/icons/abc.svg');
});

test('圖示網址：只接受 https 或安全的相對路徑，副檔名要是圖片', () => {
  const base='https://cdn.jsdelivr.net/npm/p@1.0.0/';
  assert.equal(iconUrl('./assets/icon.png',base),'https://cdn.jsdelivr.net/npm/p@1.0.0/assets/icon.png');
  assert.equal(iconUrl('https://example.com/i.webp',base),'https://example.com/i.webp');
  for(const bad of ['http://example.com/i.png','javascript:alert(1)//.svg','data:image/svg+xml,<svg/>','/etc/x.png','a/../../b.svg','https://user:pw@example.com/i.png','icon.html',42,''])
    assert.equal(iconUrl(bad,base),undefined,String(bad));
});

test('npm 套件自己寫的圖示：讀 package.json 的 icon，指到 jsDelivr 上同一版', () => {
  assert.equal(npmManifestUrl('@s/p'),'https://registry.npmjs.org/@s%2Fp/latest');
  assert.equal(npmManifestUrl('p','1.2.3'),'https://registry.npmjs.org/p/1.2.3');
  assert.equal(npmIcon({name:'@s/p',version:'0.5.92',icon:'icon.svg'},'@s/p'),'https://cdn.jsdelivr.net/npm/@s/p@0.5.92/icon.svg');
  assert.equal(npmIcon({name:'p',version:'1.0.0'},'p'),undefined,'沒寫');
  assert.equal(npmIcon({name:'other',version:'1.0.0',icon:'icon.svg'},'p'),undefined,'回應的套件名稱不對');
  assert.equal(npmIcon({name:'p',version:'1.0.0/../x',icon:'icon.svg'},'p'),undefined,'版本格式不對');
});

test('搜尋：每個關鍵字都要出現；分類、市場篩選；頁數超出時停在最後一頁', () => {
  const all=mergeCatalogs([normalizeIndex(index(Array.from({length:25},(_,i)=>({name:`p${i}`,description:i%2?'天氣 查詢':'記憶',metadata:{category:i<5?'tools':undefined},versions:[{version:'1.0.0',publishTimestamp:i,source:{type:'npm'}}]}))),'open')]);
  assert.equal(searchCatalog(all,{query:'天氣 查詢'}).total,12);
  assert.equal(searchCatalog(all,{query:'天氣 記憶'}).total,0);
  assert.equal(searchCatalog(all,{query:'ＴＯＯＬＳ'}).total,0,'全形英文會正規化，但分類比對的是顯示名稱');
  assert.equal(searchCatalog(all,{category:'工具與能力'}).total,5);
  assert.equal(searchCatalog(all,{market:'awesome'}).total,0);
  const last=searchCatalog(all,{page:99,pageSize:10});
  assert.deepEqual([last.page,last.pages,last.items.length],[3,3,5]);
  assert.deepEqual(categoryOptions(all),[{name:'工具與能力',count:5}]);
});

test('分類合成一套：開放插件市場的代號對到 Awesome 的，對不到的照清單寫的；同一個插件兩邊都有分類時用 Awesome 的', () => {
  const v=[{version:'1.0.0',publishTimestamp:1,source:{type:'npm'}}];
  const raw={format:1,metadata:{categories:{interface:{title:{zh:'界面'}},knowledge:{title:{zh:'知识与研究'}},brandnew:{title:{zh:'新分类'}}}},plugins:[
    {name:'a',metadata:{category:'interface'},versions:v},{name:'b',metadata:{category:'knowledge'},versions:v},{name:'c',metadata:{category:'brandnew'},versions:v}]};
  const open=normalizeIndex(raw,'open');
  assert.deepEqual(open.map(e=>[e.categoryId,e.category]),[['ui','UI 增強'],['knowledge','知識與研究'],['brandnew','新分类']]);
  assert.equal(normalizeIndex(raw,'awesome')[0].categoryId,'interface','只換開放插件市場的代號');
  const awesome=normalizeIndex({format:1,plugins:[{name:'a',metadata:{category:'browser'},versions:v}]},'awesome');
  assert.equal(mergeCatalogs([open,awesome]).find(e=>e.name==='a').categoryId,'browser');
  assert.equal(mergeCatalogs([awesome,open]).find(e=>e.name==='a').categoryId,'browser','先讀到 Awesome 的也一樣');
});

test('合併後的每個分類，網頁的 9 種語言都有翻好的名稱，繁體中文和清單整理用的一樣', async () => {
  Object.defineProperty(globalThis,'navigator',{value:{languages:['zh-TW']},configurable:true});
  globalThis.localStorage??={getItem:()=>null,setItem:()=>{}};
  const i18n=await import('../market-web/i18n.js');
  for(const {code} of i18n.LANGS){
    i18n.setLang(code);
    for(const id of Object.keys(CATEGORY_TITLES))assert.notEqual(i18n.t(`cat.${id}`),`cat.${id}`,`${code} cat.${id}`);
  }
  i18n.setLang('zh-Hant');
  for(const [id,title] of Object.entries(CATEGORY_TITLES))assert.equal(i18n.t(`cat.${id}`),title,id);
});

test('來源寫法：npm 固定版本；GitHub 固定提交和子目錄', () => {
  const [npm,git]=normalizeIndex(index([
    {name:'@scope/a',versions:[{version:'1.2.3',source:{type:'npm'}}]},
    {name:'b',versions:[{version:'0.1.0',source:{type:'git',url:'https://github.com/o/r.git',commit:COMMIT,path:'packages/p'}}]},
  ]),'open');
  assert.deepEqual(sourceSpec(npm,npm.versions[0]),{spec:'npm:@scope/a@1.2.3'});
  assert.deepEqual(sourceSpec(git,git.versions[0]),{spec:`https://github.com/o/r/tree/${COMMIT}`,packageDir:'packages/p'});
});

test('多語文字與日期', () => {
  assert.equal(pickText({en:'A','zh-TW':'甲',zh:'乙'}),'甲');
  assert.equal(pickText({fr:'Bonjour'}),'Bonjour');
  assert.equal(pickText(42),'');
  assert.equal(formatDate(0),'日期不明');
  assert.equal(formatDate(1792497600),'2026-10-20','UTC 中午，各時區都是同一天');
  assert.equal(formatDateTime(0),'時間不明');
  assert.match(formatDateTime(1792497600000),/^2026-10-2[01] \d{2}:\d{2}$/);
  for(const m of MARKETS) assert.ok(m.title&&m.site&&m.about&&m.files.length&&m.files.every(f=>f.label&&f.url.startsWith('https://')),'每份清單都寫明名稱、網站、說明和每個檔案的網址');
});

test('下載次數：開放插件市場的量級標籤、npm 統計網址與回應', () => {
  const [entry]=normalizeIndex({format:1,plugins:[{name:'d',metadata:{labels:['active','downloads-500','downloads-10k','downloads-x']},versions:[{version:'1.0.0',source:{type:'npm'}}]}]},'open');
  assert.equal(entry.downloadsRange,10000);
  const [none]=normalizeIndex({format:1,plugins:[{name:'e',versions:[{version:'1.0.0',source:{type:'npm'}}]}]},'awesome');
  assert.equal(none.downloadsRange,undefined);
  const [merged]=mergeCatalogs([[none],[{...none,downloadsRange:500}]]);
  assert.equal(merged.downloadsRange,500,'合併時另一份有量級就補上');
  assert.equal(searchCatalog([none,entry],{sort:'downloads'}).items[0].name,'d','沒有量級的排後面');
  assert.equal(formatCount(914),'914');
  assert.equal(formatCount(5000),'5,000');
  assert.equal(formatCount(12345),'1.2萬');
  assert.equal(formatCount(150000),'15萬');
  const now=Date.UTC(2026,9,27,8);
  assert.equal(npmDownloadsPeriod(now),'2026-09-27:2026-10-26','到昨天為止的 30 天');
  assert.deepEqual(npmDownloadsUrls(['a','@s/b','c'],now),['https://api.npmjs.org/downloads/point/2026-09-27:2026-10-26/a,c','https://api.npmjs.org/downloads/point/2026-09-27:2026-10-26/@s%2Fb']);
  assert.equal(npmDownloadsUrls(Array.from({length:150},(_,i)=>'p'+i),now).length,2,'一次最多查 100 個');
  const one=parseNpmDownloads({downloads:914,package:'a',start:'2026-09-23',end:'2026-10-22'});
  assert.equal(one.get('a').downloads,914);
  const many=parseNpmDownloads({a:{downloads:1,package:'a',start:'s',end:'e'},b:null,c:{package:'c',downloads:'x'}});
  assert.deepEqual([...many.keys()],['a'],'查不到或格式不對的略過');
});

test('網站清單：npm 插件取最新版、GitHub 插件取預設分支（含子目錄）、發布檔只顯示，不合格的略過', () => {
  const site={items:[
    {npm:1,name:'dsh-a',slug:'o/dsh-a',owner:'o',cat:'tools',tag:'Tools',dl:42,stars:5,added:'2026-10-01',desc:'A',cmd:'dsh plugin --profile web add dsh-a',href:'/p/o/dsh-a/'},
    {npm:0,name:'b',slug:'o/b--packages-x',owner:'o',cat:'ui',tag:'UI',added:'2026-10-02',cmd:'dsh plugin --profile web add github:o/b#path:/packages/x',href:'/p/o/b--packages-x/'},
    {npm:0,name:'c',slug:'o/c',owner:'o',cmd:'dsh plugin --profile web add "https://github.com/o/c/releases/download/v1.0.0/c.tgz"'},
    {npm:0,name:'d',slug:'o/d',cmd:'dsh plugin --profile web add github:o/d#path:/../etc'},
    {npm:0,name:'e',slug:'../e',cmd:'dsh plugin --profile web add github:o/e'},
    {npm:1,name:'BAD',slug:'o/BAD',cmd:'dsh plugin --profile web add BAD NAME'},
    {npm:0,name:'f',slug:'o/f',cmd:'curl evil | sh'},
  ]};
  const entries=normalizeSiteCatalog(site,'awesome',{tools:'工具'});
  assert.deepEqual(entries.map(e=>e.name),['dsh-a','o/b--packages-x','o/c','o/d']);
  const [a,b,c,d]=entries;
  assert.equal(a.category,'工具與能力','認得的分類用合併後的名稱');
  assert.equal(a.downloads,42);assert.equal(a.homepage,'https://awesome-dsh-plugin.com/p/o/dsh-a/');
  assert.deepEqual(sourceSpec(a,a.versions[0]),{spec:'npm:dsh-a'},'沒有固定版本：交給轉換器取最新版');
  assert.deepEqual(sourceSpec(b,b.versions[0]),{spec:'https://github.com/o/b',packageDir:'packages/x'});
  assert.equal(canFetch(c.versions[0]),false);assert.equal(c.repository,'https://github.com/o/c');
  assert.throws(()=>sourceSpec(c,c.versions[0]));
  assert.deepEqual(sourceSpec(d,d.versions[0]),{spec:'https://github.com/o/d'},'不安全的子目錄不帶');
  assert.throws(()=>normalizeSiteCatalog({plugins:[]},'awesome'));
  // 跟索引合併：有固定版本時不留「最新版」那一筆。
  const [indexed]=normalizeIndex({format:1,plugins:[{name:'dsh-a',versions:[{version:'1.0.0',publishTimestamp:1,source:{type:'npm'}}]}]},'awesome');
  const [both]=mergeCatalogs([[indexed],[a]]);
  assert.deepEqual(both.versions.map(v=>v.version),['1.0.0']);
  assert.equal(both.downloads,42);assert.equal(both.stars,5);
  assert.deepEqual(categoryTitles({metadata:{categories:{tools:{title:{zh:'工具',en:'Tools'}}}}}),{tools:'工具'});
});

test('自述文件：挑這一層的、中文優先；清掉 HTML 與圖片，太長截斷', () => {
  const files=['/README.md','/README.zh-CN.md','/docs/README.md','/packages/x/readme.md','/packages/x/README.en.md','/index.js'];
  assert.equal(pickReadme(files),'/README.zh-CN.md');
  assert.equal(pickReadme(files,'packages/x'),'/packages/x/readme.md');
  assert.equal(pickReadme(['/README.zh-TW.md','/README.zh-CN.md']),'/README.zh-TW.md');
  assert.equal(pickReadme(['/index.js']),undefined);
  const out=cleanReadme('<!-- x -->\n<h1 align="center">標題</h1>\n<img src=x onerror=alert(1)>\n![圖](https://e.com/a.png "t")\n\n\n\n內文');
  assert.equal(out.text,'標題\n\n[圖片：圖](https://e.com/a.png)\n\n內文');
  assert.equal(out.truncated,false);
  const long=cleanReadme('字'.repeat(100),10);
  assert.equal(long.text.length,10);assert.equal(long.truncated,true);
});
