// 市場的「已安裝」與「收藏」：狀態從本機插件市場登記檔和 claude plugin list 來，管理動作用 claude plugin 指令，收藏存在 home。
// claude 指令一律換成替身，不會動到這台電腦真的 Claude Code 設定。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {findClaude,installedState,matchEntry,newerVersion,manage,readFavorites,setFavorite} from '../lib/market-installed.mjs';
import {createMarketWeb} from '../lib/market-web.mjs';

const tempHome=async t=>{const home=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-market-installed-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));return home;};
const register=async(home,plugins)=>{
  await fs.mkdir(path.join(home,'.claude-plugin'),{recursive:true});
  await fs.writeFile(path.join(home,'.claude-plugin','marketplace.json'),JSON.stringify({name:'dsh-local',plugins}));
  for(const p of plugins)await fs.mkdir(path.join(home,'plugins',p.name),{recursive:true});
};
const local=(name,dshSource)=>({name,source:`./plugins/${name}`,metadata:{dshSource}});

/** claude 指令的替身：記下每次的參數；`list` 是 plugin list --json 的內容，`marketplaces` 是 marketplace list --json 的。 */
function fakeClaude({list=[],marketplaces=[],fail={}}={}){
  const calls=[];
  const run=async args=>{
    calls.push(args);
    const key=args.slice(0,args[1]==='marketplace'?3:2).join(' ');
    if(fail[key])return {code:1,stdout:'',stderr:fail[key]};
    if(key==='plugin list')return {code:0,stdout:JSON.stringify(list),stderr:''};
    if(key==='plugin marketplace list')return {code:0,stdout:JSON.stringify(marketplaces),stderr:''};
    return {code:0,stdout:'',stderr:''};
  };
  return {run,calls};
}

const npmEntry=(name,version)=>({name,versions:[{version,source:{type:'npm'}}]});
const gitEntry=(name,url,commit,dir)=>({name,versions:[{version:'1.0.0',source:{type:'git',url,commit,...(dir?{path:dir}:{})}}]});

test('找 claude：先用 CLAUDE_CODE_EXECPATH，沒有就看啟動自己的程式是不是 claude，都不是才用 PATH 上的', async () => {
  const exe='C:\\x\\claude.exe';
  assert.equal(await findClaude({CLAUDE_CODE_EXECPATH:'/a/claude'},async()=>exe),'/a/claude');
  assert.equal(await findClaude({},async()=>exe),exe,'插件的 MCP 伺服器沒有 CLAUDE_CODE_EXECPATH，由 Claude Code 直接啟動');
  assert.equal(await findClaude({},async()=>'/usr/bin/node'),'claude','啟動自己的不是 claude');
  assert.equal(await findClaude({},async()=>''),'claude');
});

test('狀態：沒裝的是已轉換未安裝，裝好的看 enabled；讀不到安裝清單時是不明並說原因', async t=>{
  const home=await tempHome(t);
  await register(home,[local('a',{origin:'npm:dsh-a',version:'1.0.0'}),local('b',{origin:'npm:dsh-b'}),local('c',{origin:'npm:dsh-c'}),{name:'Bad Name'}]);
  const {run}=fakeClaude({list:[{id:'b@dsh-local',enabled:true},{id:'c@dsh-local',enabled:false},{id:'a@other',enabled:true}]});
  const state=await installedState({home,run});
  assert.equal(state.known,true);
  assert.deepEqual(state.plugins.map(p=>[p.plugin,p.status]),[['a','converted'],['b','enabled'],['c','disabled']],'名稱不合法的略過；別的市場的同名插件不算');
  const broken=await installedState({home,run:fakeClaude({fail:{'plugin list':'boom'}}).run});
  assert.equal(broken.known,false);
  assert.match(broken.error,/boom/);
  assert.ok(broken.plugins.every(p=>p.status==='unknown'),'不猜有沒有裝');
  assert.deepEqual(await installedState({home:await tempHome(t),run}),{known:true,plugins:[]},'沒有登記過就不問 Claude Code');
});

test('對回清單：npm 看套件名稱，GitHub 看倉庫和子目錄（根目錄記成「.」），最後看插件名稱', () => {
  const entries=[npmEntry('dsh-a','2.0.0'),gitEntry('o/root','https://github.com/O/Repo','c1'),gitEntry('o/sub','https://github.com/o/repo','c2','packages/x'),npmEntry('named','1.0.0')];
  assert.equal(matchEntry({origin:'npm:dsh-a'},entries)?.name,'dsh-a');
  assert.equal(matchEntry({origin:'npm:nope'},entries),undefined);
  assert.equal(matchEntry({origin:'https://github.com/o/repo',packageDir:'.'},entries)?.name,'o/root','倉庫網址不分大小寫');
  assert.equal(matchEntry({origin:'https://github.com/o/repo',packageDir:'packages\\x'},entries)?.name,'o/sub','Windows 的反斜線');
  assert.equal(matchEntry({origin:'https://github.com/o/repo',packageDir:'packages/y'},entries),undefined,'子目錄對不上就不猜');
  assert.equal(matchEntry({origin:'https://github.com/o/repo',packageDir:null},entries)?.name,'o/root','舊的登記沒有子目錄');
  assert.equal(matchEntry({origin:null,name:'named'},entries)?.name,'named');
});

test('更新：清單上的固定版本和裝的不同才算；只有「最新版」的清單不比', () => {
  assert.equal(newerVersion({version:'1.0.0'},npmEntry('a','1.1.0')),'1.1.0');
  assert.equal(newerVersion({version:'1.1.0'},npmEntry('a','1.1.0')),undefined);
  assert.equal(newerVersion({commit:'c1'},gitEntry('g','https://github.com/o/r','c2')),'1.0.0');
  assert.equal(newerVersion({commit:'c2'},gitEntry('g','https://github.com/o/r','c2')),undefined);
  assert.equal(newerVersion({version:'1.0.0'},{name:'f',versions:[{version:'最新版',floating:true,source:{type:'npm'}}]}),undefined);
});

test('管理：停用、啟用、安裝（沒加過本機市場就先加）、移除（裝過的先解除安裝，再刪登記和資料夾）', async t=>{
  const home=await tempHome(t);
  await register(home,[local('a',{origin:'npm:dsh-a'}),local('b',{origin:'npm:dsh-b'})]);
  const fake=fakeClaude();
  assert.deepEqual(await manage({home,run:fake.run,action:'disable',plugin:'a',status:'enabled'}),{ok:true});
  assert.deepEqual(fake.calls.at(-1),['plugin','disable','a@dsh-local']);
  await manage({home,run:fake.run,action:'enable',plugin:'a',status:'disabled'});
  assert.deepEqual(fake.calls.at(-1),['plugin','enable','a@dsh-local']);
  fake.calls.length=0;
  await manage({home,run:fake.run,action:'install',plugin:'a',status:'converted'});
  assert.deepEqual(fake.calls,[['plugin','marketplace','list','--json'],['plugin','marketplace','add',home],['plugin','install','a@dsh-local']]);
  const added=fakeClaude({marketplaces:[{name:'dsh-local'}]});
  await manage({home,run:added.run,action:'install',plugin:'a',status:'converted'});
  assert.deepEqual(added.calls[1],['plugin','marketplace','update','dsh-local'],'加過就更新，讀到新登記的插件');
  fake.calls.length=0;
  await manage({home,run:fake.run,action:'remove',plugin:'a',status:'enabled'});
  assert.deepEqual(fake.calls,[['plugin','uninstall','a@dsh-local']]);
  await manage({home,run:fake.run,action:'remove',plugin:'b',status:'converted'});
  assert.equal(fake.calls.length,1,'沒裝過的不用解除安裝');
  const data=JSON.parse(await fs.readFile(path.join(home,'.claude-plugin','marketplace.json'),'utf8'));
  assert.deepEqual(data.plugins,[]);
  await assert.rejects(fs.access(path.join(home,'plugins','a')));
  const failing=await manage({home,run:fakeClaude({fail:{'plugin disable':'not found'}}).run,action:'disable',plugin:'a',status:'enabled'});
  assert.equal(failing.ok,false);
  assert.match(failing.text,/停用失敗.*not found/);
  assert.equal((await manage({home,run:fake.run,action:'disable',plugin:'../x',status:'enabled'})).ok,false,'名稱不合法不執行');
  assert.equal((await manage({home,run:fake.run,action:'rm',plugin:'a',status:'enabled'})).ok,false);
});

test('收藏：加入、取消、重複加入只留一個', async t=>{
  const home=await tempHome(t);
  assert.deepEqual(await readFavorites(home),[]);
  await setFavorite(home,'a',true);await setFavorite(home,'b',true);await setFavorite(home,'a',true);
  assert.deepEqual(await readFavorites(home),['b','a']);
  await setFavorite(home,'b',false);
  assert.deepEqual(await readFavorites(home),['a']);
});

// ── 本機網站的 API ──
const OPEN={format:1,plugins:[{name:'dsh-a',versions:[{version:'2.0.0',publishTimestamp:1,source:{type:'npm'}}]},{name:'dsh-b',versions:[{version:'1.0.0',publishTimestamp:1,source:{type:'npm'}}]}]};
const fakeFetch=async url=>{const text=url==='https://dshopen.org/index.json'?JSON.stringify(OPEN):undefined;return {ok:text!==undefined,status:text?200:404,text:async()=>text??''};};
function request(web,{method='GET',path:p,body}){
  const {port}=new URL(web.origin);
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,method,path:p,headers:{host:`127.0.0.1:${port}`,'x-dsh-access':web.token,...(body?{'content-type':'application/json'}:{})}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,json:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
    });
    req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();
  });
}

test('網站：已安裝對回清單名稱並標出新版；管理只接受登記過的插件；收藏只收清單上的插件', async t=>{
  const home=await tempHome(t);
  await register(home,[local('a',{origin:'npm:dsh-a',version:'1.0.0'}),local('gone',{origin:'npm:not-listed'})]);
  const fake=fakeClaude({list:[{id:'a@dsh-local',enabled:true}]});
  const web=createMarketWeb({fetchImpl:fakeFetch,home,runClaude:fake.run});t.after(()=>web.close());await web.open();
  await request(web,{path:'/api/catalog'});
  const installed=(await request(web,{path:'/api/installed'})).json;
  assert.deepEqual(installed.items,{'dsh-a':{plugin:'a',status:'enabled',version:'1.0.0',update:'2.0.0'}});
  assert.deepEqual(installed.others,[{plugin:'gone',status:'converted'}]);
  assert.equal((await request(web,{method:'POST',path:'/api/manage',body:{action:'disable',name:'dsh-b'}})).status,404,'沒登記過的不能管');
  assert.equal((await request(web,{method:'POST',path:'/api/manage',body:{action:'format',name:'dsh-a'}})).status,400);
  const done=(await request(web,{method:'POST',path:'/api/manage',body:{action:'disable',name:'dsh-a'}})).json;
  assert.equal(done.ok,true);
  assert.deepEqual(fake.calls.find(args=>args[1]==='disable'),['plugin','disable','a@dsh-local'],'指令裡的名稱來自登記檔');
  assert.ok(done.installed.items['dsh-a'],'回傳更新後的狀態');
  assert.equal((await request(web,{method:'POST',path:'/api/favorites',body:{name:'nope',on:true}})).status,404);
  assert.deepEqual((await request(web,{method:'POST',path:'/api/favorites',body:{name:'dsh-b',on:true}})).json.names,['dsh-b']);
  assert.deepEqual((await request(web,{path:'/api/favorites'})).json.names,['dsh-b']);
});

test('網站：讀不到安裝清單時狀態不明，管理動作一律不執行', async t=>{
  const home=await tempHome(t);
  await register(home,[local('a',{origin:'npm:dsh-a',version:'1.0.0'})]);
  const fake=fakeClaude({fail:{'plugin list':'spawn claude ENOENT'}});
  const web=createMarketWeb({fetchImpl:fakeFetch,home,runClaude:fake.run});t.after(()=>web.close());await web.open();
  await request(web,{path:'/api/catalog'});
  const installed=(await request(web,{path:'/api/installed'})).json;
  assert.equal(installed.known,false);
  assert.equal(installed.items['dsh-a'].status,'unknown');
  const refused=await request(web,{method:'POST',path:'/api/manage',body:{action:'remove',name:'dsh-a'}});
  assert.equal(refused.status,409);
  assert.match(refused.json.error,/ENOENT/);
  assert.ok(!fake.calls.some(args=>args[1]==='uninstall'),'沒有執行');
  assert.equal((await fs.readFile(path.join(home,'.claude-plugin','marketplace.json'),'utf8')).includes('"a"'),true,'登記還在');
});

test('claude on PATH: claude.exe first, npm claude.cmd next, bare claude otherwise',async t=>{
  const {claudeOnPath,claudeCommand}=await import('../lib/claude-cli.mjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'claude-path-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const npm=path.join(root,'npm'),native=path.join(root,'native');
  await fs.mkdir(npm);await fs.mkdir(native);
  await fs.writeFile(path.join(npm,'claude.cmd'),'@echo off\n');
  assert.equal(await claudeOnPath({PATH:`${npm};${native}`},'win32'),path.join(npm,'claude.cmd'));
  await fs.writeFile(path.join(native,'claude.exe'),'');
  assert.equal(await claudeOnPath({PATH:`${npm};${native}`},'win32'),path.join(native,'claude.exe'));
  assert.equal(await claudeOnPath({PATH:root},'win32'),'claude');
  assert.equal(await claudeOnPath({PATH:native},'linux'),'claude');
  assert.deepEqual(claudeCommand('C:/x/claude.exe',['plugin','list']),['C:/x/claude.exe',['plugin','list'],{}]);
  assert.deepEqual(claudeCommand('C:/npm dir/claude.cmd',['plugin','install','a@dsh-local']),['"C:/npm dir/claude.cmd"',['"plugin"','"install"','"a@dsh-local"'],{shell:true}]);
  assert.throws(()=>claudeCommand('C:/x/claude.cmd',['a"&calc']));
});

test('移除：資料夾被鎖住時先記下來，下次讀安裝狀態再刪；重新登記回來的不刪',async t=>{
  const {removeLeftovers}=await import('../lib/market-installed.mjs');
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'leftovers-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  await fs.mkdir(path.join(home,'.claude-plugin'),{recursive:true});
  await fs.mkdir(path.join(home,'state'),{recursive:true});
  for(const n of ['gone','back'])await fs.mkdir(path.join(home,'plugins',n),{recursive:true});
  await fs.writeFile(path.join(home,'.claude-plugin','marketplace.json'),JSON.stringify({name:'dsh-local',plugins:[{name:'back',source:'./plugins/back'}]}));
  await fs.writeFile(path.join(home,'state','market-leftovers.json'),JSON.stringify({names:['gone','back','../evil']}));
  await removeLeftovers(home);
  assert.equal(await fs.access(path.join(home,'plugins','gone')).then(()=>true,()=>false),false);
  assert.equal(await fs.access(path.join(home,'plugins','back')).then(()=>true,()=>false),true,'重新安裝回來的不能刪');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home,'state','market-leftovers.json'),'utf8')).names,[]);
});

// ── 審查時下載的原始碼 ──
/** 在 home 放一份下載完成的 npm 原始碼、它的掃描報告和補寫資料夾。 */
async function downloaded(home,name,version){
  const folder=path.join(home,'cache',`${name}-${version}`);
  await fs.mkdir(folder,{recursive:true});
  await fs.writeFile(path.join(folder,'package.json'),'{}');
  await fs.writeFile(folder+'.json',JSON.stringify({name,version,complete:true,bytes:2}));
  await fs.mkdir(path.join(home,'reports'),{recursive:true});
  await fs.writeFile(path.join(home,'reports',`${name}-${version}.security.json`),'{}');
  await fs.mkdir(path.join(home,'rewrites',`${name}-${version}`),{recursive:true});
}
const exists=async file=>{try{await fs.access(file);return true;}catch{return false;}};

test('下載的原始碼：列出完成的下載；刪除連同報告和補寫資料夾，可以留下指定版本', async t=>{
  const {listDownloads,deleteDownloads}=await import('../lib/downloads.mjs');
  const home=await tempHome(t);
  await downloaded(home,'dsh-a','1.0.0');await downloaded(home,'dsh-a','2.0.0');await downloaded(home,'dsh-b','1.0.0');
  await fs.writeFile(path.join(home,'cache','half-1.0.0.json'),JSON.stringify({name:'half',version:'1.0.0',complete:false}));
  assert.deepEqual((await listDownloads(home)).map(d=>`${d.name}@${d.version}`).sort(),['dsh-a@1.0.0','dsh-a@2.0.0','dsh-b@1.0.0'],'沒下載完的不算');
  assert.deepEqual(await deleteDownloads(home,'dsh-a',{keep:'2.0.0'}),['1.0.0']);
  for(const gone of ['cache/dsh-a-1.0.0','cache/dsh-a-1.0.0.json','reports/dsh-a-1.0.0.security.json','rewrites/dsh-a-1.0.0'])assert.equal(await exists(path.join(home,gone)),false,gone);
  assert.equal(await exists(path.join(home,'cache','dsh-a-2.0.0')),true);
  assert.deepEqual(await deleteDownloads(home,'dsh-a'),['2.0.0']);
  assert.deepEqual((await listDownloads(home)).map(d=>d.name),['dsh-b']);
});

test('網站：已下載未安裝的列在 downloads（標出新版），可以刪除；移除裝好的插件也一起刪掉它的下載', async t=>{
  const home=await tempHome(t);
  await register(home,[local('a',{origin:'npm:dsh-a',version:'2.0.0'})]);
  await downloaded(home,'dsh-a','2.0.0');await downloaded(home,'dsh-b','0.9.0');
  const fake=fakeClaude({list:[{id:'a@dsh-local',enabled:true}]});
  const web=createMarketWeb({fetchImpl:fakeFetch,home,runClaude:fake.run});t.after(()=>web.close());await web.open();
  await request(web,{path:'/api/catalog'});
  const installed=(await request(web,{path:'/api/installed'})).json;
  assert.deepEqual(installed.downloads,{'dsh-b':{version:'0.9.0',update:'1.0.0'}},'裝好的 dsh-a 不算已下載未安裝');
  assert.equal((await request(web,{method:'POST',path:'/api/manage',body:{action:'delete',name:'dsh-a'}})).status,404,'裝好的不能用刪除');
  const deleted=(await request(web,{method:'POST',path:'/api/manage',body:{action:'delete',name:'dsh-b'}})).json;
  assert.equal(deleted.ok,true);
  assert.deepEqual(deleted.installed.downloads,{});
  assert.equal(await exists(path.join(home,'cache','dsh-b-0.9.0')),false);
  const removed=(await request(web,{method:'POST',path:'/api/manage',body:{action:'remove',name:'dsh-a'}})).json;
  assert.equal(removed.ok,true);
  assert.equal(await exists(path.join(home,'cache','dsh-a-2.0.0')),false,'移除也刪掉下載的原始碼');
  assert.equal(await exists(path.join(home,'reports','dsh-a-2.0.0.security.json')),false);
});
