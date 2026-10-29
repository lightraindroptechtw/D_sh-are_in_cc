// npm 來源：用 `npm pack --ignore-scripts` 只下載套件壓縮檔，再由本檔自己解開（不呼叫 tar、不執行任何安裝腳本、不安裝依賴）。
// 來源寫法：`npm:<套件名稱>` 或 `npm:<套件名稱>@<版本或範圍>`，例如 `npm:dsh-plugin-finance-data@0.3.2`。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {run} from './source.mjs';

const PACKAGE_NAME=/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION_SPEC=/^[0-9A-Za-z.+\-^~<>=*| ]{1,64}$/;
const EXACT_VERSION=/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_UNPACKED=200*1024*1024, MAX_ENTRIES=20000;

/** 轉換器自己的資料夾：環境變數 DSH_TO_CLAUDE_HOME，否則 `~/.dsh-to-claude`（路徑短，避免 Windows 路徑過長）。 */
export function dshHome(env=process.env){
  return path.resolve(env.DSH_TO_CLAUDE_HOME||path.join(os.homedir(),'.dsh-to-claude'));
}
export const isNpmSpec=input=>typeof input==='string'&&input.startsWith('npm:');

/** `npm:<名稱>[@<版本>]` → {name, version}；只接受 npm 公開登錄的套件名稱，不接受 git、網址、檔案路徑或別名。 */
export function parseNpmSpec(input){
  if(!isNpmSpec(input))throw new Error('npm 來源要寫成 npm:<套件名稱>[@<版本>]');
  const body=input.slice(4).trim();
  const at=body.lastIndexOf('@');
  const [name,version]=at>0?[body.slice(0,at),body.slice(at+1)]:[body,null];
  if(!PACKAGE_NAME.test(name)||name.length>214)throw new Error(`npm 套件名稱不合法：${name}`);
  if(version!==null&&(!VERSION_SPEC.test(version)||version.trim().startsWith('-')))throw new Error(`npm 版本寫法不合法：${version}`);
  return {name,version:version?.trim()||null};
}
/** 快取資料夾名稱：`@scope/name` → `scope-name`，接上版本。 */
export const cacheFolderName=(name,version)=>`${name.replace(/^@/,'').replace(/\//g,'-')}-${version}`;

async function npmCommand(){
  const candidates=[process.env.npm_execpath,path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')].filter(item=>item&&/npm-cli\.js$/.test(item));
  for(const file of candidates){try{await fs.access(file);return {command:process.execPath,prefix:[file]};}catch{/* 下一個 */}}
  if(process.platform!=='win32')return {command:'npm',prefix:[]};
  throw Object.assign(new Error('找不到 npm 命令列程式'),{code:'NPM_UNAVAILABLE'});
}
const readJson=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch{return null;}};
const exists=async file=>{try{await fs.access(file);return true;}catch{return false;}};

/**
 * 解開 npm 套件壓縮檔（.tgz）。拿掉第一層資料夾（npm 慣例是 package/）。
 * 不接受絕對路徑、`..`、磁碟代號；符號連結與硬連結不解開，只記下來。
 */
export async function extractNpmTarball(file,destination){
  const gz=await fs.readFile(file);
  const buf=zlib.gunzipSync(gz,{maxOutputLength:MAX_UNPACKED});
  const skipped=[];let files=0,bytes=0,entries=0,offset=0,longName=null,paxPath=null;
  const text=(start,length)=>{const slice=buf.subarray(start,start+length);const end=slice.indexOf(0);return slice.subarray(0,end<0?slice.length:end).toString('utf8');};
  while(offset+512<=buf.length){
    const headerStart=offset,header=buf.subarray(offset,offset+512);
    if(header.every(byte=>byte===0))break;
    if(++entries>MAX_ENTRIES)throw new Error(`npm 套件超過 ${MAX_ENTRIES} 個項目`);
    const sizeField=text(offset+124,12).trim();
    const size=sizeField?parseInt(sizeField,8):0;
    if(!Number.isFinite(size)||size<0)throw new Error('npm 套件壓縮檔格式不正確');
    const type=String.fromCharCode(header[156]||48);
    const dataStart=offset+512,dataEnd=dataStart+size;
    if(dataEnd>buf.length)throw new Error('npm 套件壓縮檔被截斷');
    offset=dataStart+Math.ceil(size/512)*512;
    if(type==='L'){longName=text(dataStart,size);continue;}
    if(type==='x'){const body=buf.subarray(dataStart,dataEnd).toString('utf8');const m=body.match(/(?:^|\n)\d+ path=([^\n]*)\n/);paxPath=m?m[1]:null;continue;}
    if(type==='g')continue;
    const prefix=text(headerStart+257,5)==='ustar'?text(headerStart+345,155):'';
    let name=paxPath??longName??(prefix?prefix+'/':'')+text(headerStart,100);
    longName=null;paxPath=null;
    name=name.replace(/\\/g,'/');
    const parts=name.split('/').filter(part=>part&&part!=='.');
    parts.shift(); // 第一層（package/）
    const rel=parts.join('/');
    if(!rel)continue;
    if(parts.some(part=>part==='..')||/^[A-Za-z]:/.test(rel)||name.startsWith('/'))throw new Error(`npm 套件含有不安全的路徑：${name}`);
    const target=path.join(destination,...parts);
    if(type==='5'){await fs.mkdir(target,{recursive:true});continue;}
    if(type!=='0'&&type!=='7'){skipped.push({path:rel,reason:type==='1'||type==='2'?'連結（不解開）':`不支援的項目類型 ${type}`});continue;}
    bytes+=size;
    if(bytes>MAX_UNPACKED)throw new Error('npm 套件解開後超過 200 MiB');
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.writeFile(target,buf.subarray(dataStart,dataEnd));
    files++;
  }
  return {files,bytes,skipped};
}

/** 同一個套件的其他版本下載：舊版本下次審查會重新下載，留著只會越堆越多。裝好的插件有自己的一份，不受影響。 */
async function removeOlderVersions(cacheDir,name,version){
  for(const file of await fs.readdir(cacheDir).catch(()=>[])){
    if(!file.endsWith('.json'))continue;
    const meta=await readJson(path.join(cacheDir,file));
    if(meta?.name!==name||meta.version===version||file!==cacheFolderName(meta.name,meta.version)+'.json')continue;
    await fs.rm(path.join(cacheDir,file.slice(0,-5)),{recursive:true,force:true}).catch(()=>{});
    await fs.rm(path.join(cacheDir,file),{force:true}).catch(()=>{});
  }
}

/**
 * 下載 npm 套件到 `<cacheDir>/<名稱>-<版本>`，不安裝、不執行任何腳本。
 * 指定精確版本且快取已有完成記號時直接用快取（不連網路），讓「審查的檔案」與「轉換的檔案」是同一份。
 * 回傳的 origin 是 `npm:<名稱>`（不含版本），讓同一個插件換版本後仍沿用同一份持久資料。
 */
export async function fetchNpmSource(input,{cacheDir=path.join(dshHome(),'cache'),runner=run,npm,timeout=180000}={}){
  const {name,version}=parseNpmSpec(input);
  cacheDir=path.resolve(cacheDir);
  await fs.mkdir(cacheDir,{recursive:true});
  const describe=(meta,root,cached)=>({root,origin:`npm:${meta.name}`,commit:null,remote:true,npm:{name:meta.name,version:meta.version,integrity:meta.integrity??null,shasum:meta.shasum??null,cached,fetchedAt:meta.fetchedAt}});
  if(version&&EXACT_VERSION.test(version)){
    const folder=path.join(cacheDir,cacheFolderName(name,version));
    const meta=await readJson(folder+'.json');
    if(meta&&meta.name===name&&meta.version===version&&meta.complete&&await exists(folder))return describe(meta,folder,true);
  }
  const work=path.join(cacheDir,'.dl-'+crypto.randomBytes(4).toString('hex'));
  await fs.mkdir(work,{recursive:true});
  try{
    const invocation=npm??await npmCommand();
    const args=[...invocation.prefix,'pack',`${name}@${version??'latest'}`,'--json','--ignore-scripts','--pack-destination',work,'--registry=https://registry.npmjs.org/','--no-audit','--no-fund','--loglevel=error'];
    const result=await runner(invocation.command,args,{cwd:work,timeout,env:{npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false'}});
    if(result.code!==0)throw Object.assign(new Error(`npm 下載失敗（${name}@${version??'latest'}）：${String(result.stderr).split('\n').filter(Boolean).slice(-3).join(' ').slice(0,600)}`),{code:'NPM_PACK_FAILED'});
    let info;try{info=JSON.parse(result.stdout.slice(result.stdout.indexOf('[')))[0];}catch{throw Object.assign(new Error('看不懂 npm pack 的輸出'),{code:'NPM_PACK_FAILED'});}
    if(!info||info.name!==name||!EXACT_VERSION.test(String(info.version))||typeof info.filename!=='string'||/[\\/]/.test(info.filename))throw Object.assign(new Error('npm pack 回傳的套件資訊不符'),{code:'NPM_PACK_FAILED'});
    const folder=path.join(cacheDir,cacheFolderName(info.name,info.version));
    const old=await readJson(folder+'.json');
    const meta={name:info.name,version:info.version,integrity:info.integrity??null,shasum:info.shasum??null,fetchedAt:new Date().toISOString(),complete:false};
    if(old&&old.complete&&old.integrity&&old.integrity===meta.integrity&&await exists(folder))return describe(old,folder,true);
    await fs.rm(folder,{recursive:true,force:true});
    await fs.mkdir(folder,{recursive:true});
    const unpacked=await extractNpmTarball(path.join(work,info.filename),folder);
    meta.complete=true;meta.files=unpacked.files;meta.bytes=unpacked.bytes;meta.skipped=unpacked.skipped;
    await fs.writeFile(folder+'.json',JSON.stringify(meta,null,2)+'\n','utf8');
    await removeOlderVersions(cacheDir,meta.name,meta.version);
    return describe(meta,folder,false);
  }finally{
    await fs.rm(work,{recursive:true,force:true});
  }
}
