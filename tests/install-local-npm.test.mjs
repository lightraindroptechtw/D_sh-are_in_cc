// npm 來源：解析、解開壓縮檔、下載（用替身 npm，不連網路）、快取重用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import {parseNpmSpec,isNpmSpec,cacheFolderName,extractNpmTarball,fetchNpmSource,dshHome} from '../lib/npm-source.mjs';
import {acquireSource} from '../lib/source.mjs';
import {tempRoot} from './claude-package-fixtures.mjs';

/** 做一個 ustar 格式的 .tgz。entries：{name, content?, type?('0'|'5'|'2'|'x'), linkname?} */
export function makeTgz(entries){
  const blocks=[];
  const header=({name,size,type='0',linkname=''})=>{
    const h=Buffer.alloc(512,0);
    const put=(value,offset,length)=>Buffer.from(value,'utf8').copy(h,offset,0,length);
    put(name.slice(0,100),0,100);put('0000644\0',100,8);put('0000000\0',108,8);put('0000000\0',116,8);
    put(size.toString(8).padStart(11,'0')+'\0',124,12);put('00000000000\0',136,12);
    h.fill(0x20,148,156);put(type,156,1);put(linkname,157,100);put('ustar\0',257,6);put('00',263,2);
    let sum=0;for(const byte of h)sum+=byte;put(sum.toString(8).padStart(6,'0')+'\0 ',148,8);
    return h;
  };
  for(const entry of entries){
    const data=Buffer.from(entry.content??'','utf8');
    blocks.push(header({name:entry.name,size:entry.type==='5'||entry.type==='2'?0:data.length,type:entry.type??'0',linkname:entry.linkname}));
    if(entry.type!=='5'&&entry.type!=='2'&&data.length){blocks.push(data);blocks.push(Buffer.alloc((512-data.length%512)%512,0));}
  }
  blocks.push(Buffer.alloc(1024,0));
  return zlib.gzipSync(Buffer.concat(blocks));
}
const pax=(key,value)=>{let line=` ${key}=${value}\n`;let length=line.length+2;while(String(length).length+line.length!==length)length=String(length).length+line.length;return `${length}${line}`;};

/** 替身 npm：把預先做好的壓縮檔放進 --pack-destination，印出和 npm pack --json 相同形狀的結果。 */
function fakeNpm({name,version,tgz,integrity='sha512-fake'},calls){
  return async(command,args,options)=>{
    calls.push({command,args,options});
    const destination=args[args.indexOf('--pack-destination')+1];
    const filename=`${name.replace(/^@/,'').replace('/','-')}-${version}.tgz`;
    await fs.writeFile(path.join(destination,filename),tgz);
    return {code:0,stdout:JSON.stringify([{name,version,filename,integrity,shasum:'abc'}]),stderr:''};
  };
}

test('parseNpmSpec 接受名稱與版本，拒絕 git、路徑與奇怪字元', () => {
  assert.deepEqual(parseNpmSpec('npm:dsh-plugin-finance-data'),{name:'dsh-plugin-finance-data',version:null});
  assert.deepEqual(parseNpmSpec('npm:dsh-plugin-finance-data@0.3.2'),{name:'dsh-plugin-finance-data',version:'0.3.2'});
  assert.deepEqual(parseNpmSpec('npm:@acme/dsh-x@^1.2.0'),{name:'@acme/dsh-x',version:'^1.2.0'});
  assert.deepEqual(parseNpmSpec('npm:@acme/dsh-x'),{name:'@acme/dsh-x',version:null});
  assert.equal(isNpmSpec('npm:x'),true);assert.equal(isNpmSpec('./x'),false);
  for(const bad of ['npm:','npm:../evil','npm:git+https://github.com/a/b','npm:Foo Bar','npm:a@-rf','npm:a/b/c','npm:https://x.test/a.tgz','npm:a@$(id)'])assert.throws(()=>parseNpmSpec(bad),bad);
  assert.equal(cacheFolderName('@acme/dsh-x','1.0.0'),'acme-dsh-x-1.0.0');
});

test('dshHome 預設在使用者家目錄的 .dsh-to-claude，可用環境變數改', () => {
  assert.match(dshHome({}),/[\\/]\.dsh-to-claude$/);
  assert.equal(dshHome({DSH_TO_CLAUDE_HOME:'C:/x/y'}),path.resolve('C:/x/y'));
});

test('extractNpmTarball 拿掉第一層、支援長檔名與 pax 路徑、不解開連結', async t => {
  const root=await tempRoot(t);
  const longName='package/'+'d'.repeat(120)+'/file.js';
  const tgz=makeTgz([
    {name:'package/',type:'5'},
    {name:'package/package.json',content:'{"name":"x","version":"1.0.0"}'},
    {name:'package/lib/index.js',content:'export const a=1;\n'},
    {name:'././@PaxHeader',type:'x',content:pax('path',longName)},
    {name:'package/placeholder',content:'long body'},
    {name:'package/link',type:'2',linkname:'/etc/passwd'}
  ]);
  await fs.writeFile(path.join(root,'a.tgz'),tgz);
  const out=path.join(root,'out');
  const result=await extractNpmTarball(path.join(root,'a.tgz'),out);
  assert.equal(result.files,3);
  assert.equal(await fs.readFile(path.join(out,'lib','index.js'),'utf8'),'export const a=1;\n');
  assert.equal(await fs.readFile(path.join(out,'d'.repeat(120),'file.js'),'utf8'),'long body');
  assert.deepEqual(result.skipped.map(item=>item.path),['link']);
  await assert.rejects(fs.access(path.join(out,'link')));
});

test('extractNpmTarball 拒絕往外跳的路徑', async t => {
  const root=await tempRoot(t);
  for(const [index,name] of ['package/../../evil.js','package/C:/evil.js'].entries()){
    await fs.writeFile(path.join(root,`b${index}.tgz`),makeTgz([{name,content:'x'}]));
    await assert.rejects(extractNpmTarball(path.join(root,`b${index}.tgz`),path.join(root,'out'+index)),/不安全的路徑/);
  }
  await assert.rejects(fs.access(path.join(root,'evil.js')));
});

test('fetchNpmSource 用 npm pack --ignore-scripts 下載到 <快取>/<名稱>-<版本>，精確版本第二次直接用快取', async t => {
  const root=await tempRoot(t),calls=[];
  const tgz=makeTgz([{name:'package/package.json',content:'{"name":"@acme/dsh-demo","version":"2.0.1"}'},{name:'package/index.js',content:'export function apply(){}\n'}]);
  const runner=fakeNpm({name:'@acme/dsh-demo',version:'2.0.1',tgz},calls);
  const cacheDir=path.join(root,'cache');
  const first=await fetchNpmSource('npm:@acme/dsh-demo',{cacheDir,runner,npm:{command:'npm-stub',prefix:[]}});
  assert.equal(first.root,path.join(cacheDir,'acme-dsh-demo-2.0.1'));
  assert.equal(first.origin,'npm:@acme/dsh-demo');
  assert.equal(first.npm.version,'2.0.1');assert.equal(first.npm.cached,false);
  assert.equal(calls.length,1);
  const args=calls[0].args;
  assert.ok(args.includes('pack')&&args.includes('--ignore-scripts')&&args.includes('@acme/dsh-demo@latest'),args.join(' '));
  assert.equal(calls[0].options.env.npm_config_ignore_scripts,'true');
  assert.equal(await fs.readFile(path.join(first.root,'index.js'),'utf8'),'export function apply(){}\n');
  // 暫存下載資料夾不留
  assert.deepEqual((await fs.readdir(cacheDir)).sort(),['acme-dsh-demo-2.0.1','acme-dsh-demo-2.0.1.json']);
  const second=await fetchNpmSource('npm:@acme/dsh-demo@2.0.1',{cacheDir,runner,npm:{command:'npm-stub',prefix:[]}});
  assert.equal(second.npm.cached,true);assert.equal(calls.length,1,'精確版本有快取時不再下載');
  // 範圍版本會再問 npm，但完整性相同就沿用快取
  const third=await fetchNpmSource('npm:@acme/dsh-demo@^2.0.0',{cacheDir,runner,npm:{command:'npm-stub',prefix:[]}});
  assert.equal(third.npm.cached,true);assert.equal(calls.length,2);
});

test('fetchNpmSource：npm 失敗時回報錯誤且不留暫存資料夾', async t => {
  const root=await tempRoot(t);
  const runner=async()=>({code:1,stdout:'',stderr:'npm error 404 Not Found - GET https://registry.npmjs.org/nope'});
  await assert.rejects(fetchNpmSource('npm:nope',{cacheDir:path.join(root,'c'),runner,npm:{command:'x',prefix:[]}}),error=>error.code==='NPM_PACK_FAILED'&&/404/.test(error.message));
  assert.deepEqual(await fs.readdir(path.join(root,'c')),[]);
});

test('fetchNpmSource：npm 回報的套件名稱不符就拒絕', async t => {
  const root=await tempRoot(t);
  const runner=fakeNpm({name:'other-package',version:'1.0.0',tgz:makeTgz([{name:'package/a.js',content:'x'}])},[]);
  await assert.rejects(fetchNpmSource('npm:wanted',{cacheDir:path.join(root,'c'),runner,npm:{command:'x',prefix:[]}}),/不符/);
});

test('acquireSource 認得 npm: 來源，且不接受 --ref', async t => {
  const root=await tempRoot(t);
  await assert.rejects(acquireSource('npm:x@1.0.0',{ref:'main',npmCacheDir:path.join(root,'c')}),/--ref/);
  // 快取已有完成記號時不連網路
  const folder=path.join(root,'c','x-1.0.0');
  await fs.mkdir(folder,{recursive:true});
  await fs.writeFile(folder+'.json',JSON.stringify({name:'x',version:'1.0.0',complete:true,integrity:'sha512-a'}));
  const src=await acquireSource('npm:x@1.0.0',{npmCacheDir:path.join(root,'c')});
  assert.equal(src.root,folder);assert.equal(src.origin,'npm:x');
});
