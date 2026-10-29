import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {isNpmSpec,fetchNpmSource} from './npm-source.mjs';

export function inside(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export async function filesIn(root, {limit = 10000} = {}) {
  const files = [];
  async function walk(dir) {
    for (const d of (await fs.readdir(dir, {withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (['.git','node_modules','.venv','__pycache__','.npm','.cache','.pytest_cache'].includes(d.name)) continue;
      const full = path.join(dir,d.name);
      if (d.isSymbolicLink()) throw new Error(`不接受來源中的符號連結：${path.relative(root,full)}`);
      if (d.isDirectory()) await walk(full);
      else if (d.isFile()) {
        files.push(full);
        if (files.length > limit) throw new Error(`來源超過 ${limit} 個檔案`);
      }
    }
  }
  await walk(root); return files;
}
export async function run(command,args,{cwd,env,timeout=45000,input}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env:{...process.env,...env},windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',over=false;
    const timer=setTimeout(()=>{over=true;child.kill();},timeout);
    const collect=(which,chunk)=>{
      if(which==='out') stdout+=chunk; else stderr+=chunk;
      if(stdout.length+stderr.length>8*1024*1024){over=true;child.kill();}
    };
    child.stdout.on('data',c=>collect('out',c)); child.stderr.on('data',c=>collect('err',c));
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer); if(over) reject(new Error('子程序超時或輸出過量')); else resolve({code,stdout,stderr});});
    child.stdin.end(input);
  });
}
export async function acquireSource(input,{cacheDir,ref,npmCacheDir}={}) {
  // npm 來源（npm:<名稱>[@<版本>]）：只下載、不安裝，預設快取在 ~/.dsh-to-claude/cache。
  if (isNpmSpec(input)) { if(ref) throw new Error('npm 來源不接受 --ref；版本請寫在 npm:<名稱>@<版本>'); return fetchNpmSource(input,npmCacheDir?{cacheDir:npmCacheDir}:{}); }
  if (!/^https?:\/\//i.test(input)) {
    const root=await fs.realpath(path.resolve(input));
    if(!(await fs.stat(root)).isDirectory()) throw new Error('來源必須是插件資料夾、GitHub 倉庫網址或 npm:<套件名稱>');
    let commit=null;
    try { const r=await run('git',['-C',root,'rev-parse','HEAD']); if(r.code===0) commit=r.stdout.trim(); } catch {}
    return {root,origin:root,commit,remote:false};
  }
  const u=new URL(input);
  if(u.protocol!=='https:' || u.hostname!=='github.com' || u.username || u.password || u.search || u.hash) throw new Error('遠端來源只接受公開 HTTPS GitHub 倉庫網址');
  const parts=u.pathname.replace(/\/$/,'').split('/').filter(Boolean);
  if(parts.length!==2 && !(parts.length>=4 && parts[2]==='tree')) throw new Error('請提供 GitHub 倉庫網址；分支或提交可用 --ref 指定');
  const [owner,rawRepo]=parts, repo=rawRepo.replace(/\.git$/,'');
  if(!/^[\w.-]+$/.test(owner)||!/^[\w.-]+$/.test(repo)) throw new Error('GitHub 倉庫名稱不合法');
  const selected=ref || (parts[2]==='tree'?parts.slice(3).join('/'):null);
  if(selected && (selected.startsWith('-') || /[\x00-\x20]/.test(selected))) throw new Error('分支／提交格式不合法');
  const origin=`https://github.com/${owner}/${repo}.git`;
  const root=path.join(path.resolve(cacheDir),`${repo}-${crypto.randomBytes(6).toString('hex')}`);
  await fs.mkdir(root,{recursive:true});
  const gitEnv={GIT_TERMINAL_PROMPT:'0',GIT_LFS_SKIP_SMUDGE:'1'};
  for(const args of [
    ['-c','init.templateDir=','init',root],
    ['-C',root,'-c','core.hooksPath=','-c','protocol.file.allow=never','fetch','--depth=1',origin,selected||'HEAD'],
    ['-C',root,'-c','core.hooksPath=','checkout','--detach','FETCH_HEAD']
  ]) {const r=await run('git',args,{env:gitEnv,timeout:60000});if(r.code!==0)throw new Error(`GitHub 來源取得失敗：${r.stderr.slice(-1200)}`);}
  const result=await run('git',['-C',root,'rev-parse','HEAD']);
  return {root,origin:origin.replace(/\.git$/,''),commit:result.stdout.trim(),remote:true};
}
export async function copySource(root,destination) {
  let bytes=0; const copied=[]; const excluded=[];
  for(const file of await filesIn(root)) {
    const rel=path.relative(root,file);
    if(/(^|[\\/])(?:\.env(?:\..*)?|[^\\/]*(?:credential|secret|token)[^\\/]*\.(?:json|log|pem)|id_rsa|.*\.log|.*\.pyc)$/i.test(rel)) {excluded.push(rel);continue;}
    const stat=await fs.stat(file); bytes+=stat.size;
    if(bytes>100*1024*1024)throw new Error('來源檔案超過 100 MiB，請提供較小的插件目錄');
    const dest=path.join(destination,rel);
    await fs.mkdir(path.dirname(dest),{recursive:true}); await fs.copyFile(file,dest); copied.push(rel);
  }
  return {files:copied.length,bytes,excluded};
}
