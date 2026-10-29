// 審查時下載的 npm 原始碼（<home>/cache/<名稱>-<版本>，旁邊有同名 .json 記錄）、掃描報告（<home>/reports）與補寫的資料夾（<home>/rewrites）。
// 裝好的插件在自己的資料夾裡有一份原始碼，所以這些都可以刪；刪了之後再審查或更新會重新下載。
import fs from 'node:fs/promises';
import path from 'node:path';
import {cacheFolderName,dshHome} from './npm-source.mjs';
import {claudePluginName} from './claude-package.mjs';

const readJson=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch{return null;}};
const safe=value=>String(value).replace(/[^A-Za-z0-9._@/-]+/g,'-');

/** 預設的安全掃描 JSON 位置：<home>/reports/<名稱>-<版本>.security.json。 */
export function defaultReportPath({name,version},home=dshHome()){
  return path.join(home,'reports',cacheFolderName(safe(name||'plugin'),safe(version||'unknown'))+'.security.json');
}

/** 下載完成的 npm 原始碼：[{ name, version, bytes, fetchedAt }]。 */
export async function listDownloads(home=dshHome()){
  const dir=path.join(home,'cache');
  const names=await fs.readdir(dir).catch(()=>[]);
  const found=[];
  for(const file of names.filter(name=>name.endsWith('.json'))){
    const meta=await readJson(path.join(dir,file));
    if(meta?.complete&&typeof meta.name==='string'&&typeof meta.version==='string'&&file===cacheFolderName(meta.name,meta.version)+'.json')
      found.push({name:meta.name,version:meta.version,bytes:meta.bytes??null,fetchedAt:meta.fetchedAt??null});
  }
  return found;
}

/**
 * 刪掉一個插件下載的原始碼，連同那些版本的掃描報告和補寫資料夾。`keep` 是要留下的版本（下載新版時留新的）。
 * 回傳刪掉的版本。
 */
export async function deleteDownloads(home,name,{keep}={}){
  home=path.resolve(home??dshHome());
  const versions=(await listDownloads(home)).filter(item=>item.name===name&&item.version!==keep).map(item=>item.version);
  for(const version of versions){
    const folder=path.join(home,'cache',cacheFolderName(name,version));
    await fs.rm(folder,{recursive:true,force:true});
    await fs.rm(folder+'.json',{force:true});
    await fs.rm(defaultReportPath({name,version},home),{force:true});
    await fs.rm(path.join(home,'rewrites',cacheFolderName(claudePluginName(name),version)),{recursive:true,force:true});
  }
  return versions;
}
