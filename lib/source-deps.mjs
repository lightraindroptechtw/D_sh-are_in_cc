import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import semver from 'semver';
import {inside,run} from './source.mjs';

const official=name=>name.startsWith('@deepseek-ai/');
const digest=text=>crypto.createHash('sha256').update(text).digest('hex');
const packageName=/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const safeSpec=spec=>typeof spec==='string'&&(Boolean(semver.validRange(spec))||/^[a-z][a-z0-9._-]*$/i.test(spec));
function registrySpec(name,spec){
  if(!packageName.test(name)||typeof spec!=='string')return false;
  if(spec.startsWith('npm:')){const alias=spec.match(/^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/);return Boolean(alias&&packageName.test(alias[1])&&!official(alias[1])&&safeSpec(alias[2]));}
  return safeSpec(spec);
}
const publicTarball=value=>{try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='registry.npmjs.org'&&!u.username&&!u.password&&!u.search&&!u.hash&&!decodeURIComponent(u.pathname).startsWith('/@deepseek-ai/');}catch{return false;}};
async function readOptional(file){try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function filteredEdges(edges={}){return Object.fromEntries(Object.entries(edges).filter(([name,spec])=>!official(name)&&registrySpec(name,spec)));}

/** Build an installable, production-only npm lock without changing source files.
 * Only registry tarballs with integrity metadata qualify for the locked path.
 * Peers are intentionally ignored, consistently with --legacy-peer-deps.
 */
function productionLock(lock,dependencies){
  if(![2,3].includes(lock?.lockfileVersion)||!lock.packages?.[''])throw new Error('LOCK_FORMAT');
  const selected=new Set(),queue=[];
  const locate=(from,name)=>{
    let parent=from;
    for(;;){const candidate=(parent?parent+'/':'')+'node_modules/'+name;if(lock.packages[candidate])return candidate;if(!parent)break;parent=path.posix.dirname(parent);if(parent==='.')parent='';}
    return null;
  };
  const add=(from,name,requested,optional=false)=>{
    if(official(name))return;
    if(!registrySpec(name,requested))throw new Error('LOCK_NONREGISTRY');
    const key=locate(from,name);if(!key){if(optional)return;throw new Error('LOCK_MISSING');}
    const row=lock.packages[key];
    const alias=requested.startsWith('npm:')?requested.match(/^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/):null;
    const range=alias?alias[2]:requested;
    if(row.name&&official(row.name)||row.link||!semver.valid(row.version)||!publicTarball(row.resolved)||typeof row.integrity!=='string'||!/^sha(?:256|384|512)-[A-Za-z0-9+/=]+(?:\s+sha(?:256|384|512)-[A-Za-z0-9+/=]+)*$/.test(row.integrity))throw new Error('LOCK_UNTRUSTED');
    if(semver.validRange(range)&&!semver.satisfies(row.version,range,{includePrerelease:true}))throw new Error('LOCK_RANGE');
    if(!selected.has(key)){selected.add(key);queue.push(key);}
  };
  for(const [name,spec]of Object.entries(dependencies))add('',name,spec);
  for(let i=0;i<queue.length;i++){
    const key=queue[i],row=lock.packages[key];
    for(const [name,spec]of Object.entries(row.dependencies??{}))add(key,name,spec,Object.hasOwn(row.optionalDependencies??{},name));
    for(const [name,spec]of Object.entries(row.optionalDependencies??{}))add(key,name,spec,true);
  }
  const packages={'':{name:'dsh-source-dependencies',version:'1.0.0',dependencies}};
  for(const key of [...selected].sort()){
    const row={...lock.packages[key]};
    for(const field of ['dev','devOptional','devDependencies','peerDependencies','peerDependenciesMeta'])delete row[field];
    for(const field of ['dependencies','optionalDependencies'])if(row[field])row[field]=filteredEdges(row[field]);
    packages[key]=row;
  }
  return {name:'dsh-source-dependencies',version:'1.0.0',lockfileVersion:3,requires:true,packages};
}

/** Inspect manifests and locks only; never imports or initializes the source. */
export async function planSourceDependencies(source,{packageDir='.'}={}){
  const root=path.resolve(source.root??source),packageRoot=await fs.realpath(path.resolve(root,packageDir));
  if(!inside(await fs.realpath(root),packageRoot))throw new Error('依賴套件目錄必須位於來源內');
  const manifestPath=path.join(packageRoot,'package.json'),raw=await readOptional(manifestPath),pkg=raw?JSON.parse(raw):{};
  const dependencies={},excluded=[],unsupported=[];
  for(const [name,spec]of Object.entries(pkg.dependencies??{})){
    if(official(name)||typeof spec==='string'&&/^npm:@deepseek-ai\//.test(spec)){excluded.push({name,reason:'bundled-official-runtime'});continue;}
    if(!registrySpec(name,spec)){unsupported.push({name:packageName.test(name)?name:'[invalid-package-name]',reason:'only-public-npm-registry-specifications-are-supported'});continue;}
    dependencies[name]=spec;
  }
  const sourceFiles=raw?[{path:manifestPath,sha256:digest(raw)}]:[];
  let lock=null,lockfile=null,lockFallbackReason='no-source-lock';
  for(const name of ['npm-shrinkwrap.json','package-lock.json']){
    const file=path.join(packageRoot,name),text=await readOptional(file);if(text===null)continue;
    sourceFiles.push({path:file,sha256:digest(text)});lockfile=name;
    try{lock=productionLock(JSON.parse(text),dependencies);lockFallbackReason=null;}catch(e){lockFallbackReason=/^LOCK_[A-Z]+$/.test(e.message)?e.message:'LOCK_PARSE';}
    break;
  }
  return {schemaVersion:1,sourceRoot:root,packageDir:path.relative(root,packageRoot)||'.',packages:Object.entries(dependencies).map(([name,requested])=>({name,requested})),excluded,unsupported,lockfile,lockMode:lock?'sanitized-production-lock':'registry-resolution',lockFallbackReason,sourceExecuted:false,sourceFilesUnchanged:true,
    // Internal payloads contain manifest metadata only, never ambient env values.
    manifest:{name:'dsh-source-dependencies',version:'1.0.0',private:true,dependencies},lock,sourceFiles};
}

async function npmCommand(){
  const candidates=[process.env.npm_execpath,path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  for(const file of candidates)if(await readOptional(file)!==null)return {command:process.execPath,prefix:[file]};
  if(process.platform!=='win32')return {command:'npm',prefix:[]};
  throw Object.assign(new Error('找不到 npm 命令列程式'),{code:'NPM_UNAVAILABLE'});
}
async function unchanged(plan){for(const item of plan.sourceFiles){const raw=await readOptional(item.path);if(raw===null||digest(raw)!==item.sha256)return false;}return true;}
async function installedPackages(root){
  const text=await readOptional(path.join(root,'package-lock.json'));if(text===null)return [];
  const lock=JSON.parse(text);
  return Object.entries(lock.packages??{}).filter(([key])=>key).map(([key,row])=>({path:key,name:row.name??key.slice(key.lastIndexOf('node_modules/')+13),version:row.version??null,integrity:row.integrity??null}));
}

/** destination is the converted plugin root; installation occurs in an isolated
 * runtime/source-deps tree. The caller adds returned nodePaths to compilation.
 * onPlan is awaited before npm starts, allowing the caller to persist its report.
 */
export async function installSourceDependencies(plan,{destination,enabled=true,runner=run,onPlan,timeout=180000,npm}={}){
  const result={enabled,packages:plan.packages,excluded:plan.excluded,unsupported:plan.unsupported,lockMode:plan.lockMode,lockFallbackReason:plan.lockFallbackReason,sourceExecuted:false,sourceFilesUnchanged:true,nodePaths:[],installed:[]};
  if(onPlan)await onPlan({...result,status:'planned'});
  if(!enabled)return {...result,status:'disabled'};
  if(plan.unsupported.length)return {...result,status:'failed',error:{code:'DEPENDENCY_SPEC_UNSUPPORTED',message:'來源包含無法安全安裝的依賴規格，請查看 unsupported 套件名稱'}};
  if(!plan.packages.length)return {...result,status:'not-needed'};
  if(!destination)throw new Error('依賴安裝必須提供輸出資料夾');
  const root=path.join(path.resolve(destination),'runtime','source-deps');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify(plan.manifest,null,2)+'\n');
  if(plan.lock)await fs.writeFile(path.join(root,'package-lock.json'),JSON.stringify(plan.lock,null,2)+'\n');
  else await fs.rm(path.join(root,'package-lock.json'),{force:true});
  const userconfig=path.join(root,'npm-userconfig');await fs.writeFile(userconfig,'registry=https://registry.npmjs.org/\nignore-scripts=true\n');
  const globalconfig=path.join(root,'npm-globalconfig');await fs.writeFile(globalconfig,'');
  try{
    const invocation=npm??await npmCommand();
    const flags=['--ignore-scripts','--omit=dev','--legacy-peer-deps','--no-audit','--no-fund','--registry=https://registry.npmjs.org/','--userconfig='+userconfig,'--globalconfig='+globalconfig];
    const options={cwd:root,timeout,env:{npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false'}};
    // Resolve metadata without extracting packages first. This lets us remove
    // transitive official/dev packages before any actual installation happens.
    if(!plan.lock){
      const resolution=await runner(invocation.command,[...invocation.prefix,'install','--package-lock-only',...flags],options);
      if(resolution.code!==0)return {...result,status:'failed',sourceFilesUnchanged:await unchanged(plan),error:{code:'DEPENDENCY_RESOLUTION_FAILED',exitCode:resolution.code,message:'npm 依賴解析失敗；未保存子程序輸出以免洩漏秘密'}};
      const resolved=JSON.parse(await fs.readFile(path.join(root,'package-lock.json'),'utf8'));
      const sanitized=productionLock(resolved,plan.manifest.dependencies);
      await fs.writeFile(path.join(root,'package-lock.json'),JSON.stringify(sanitized,null,2)+'\n');
    }
    const execution=await runner(invocation.command,[...invocation.prefix,'ci',...flags],options);
    if(execution.code!==0)return {...result,status:'failed',sourceFilesUnchanged:await unchanged(plan),error:{code:'DEPENDENCY_INSTALL_FAILED',exitCode:execution.code,message:'npm 依賴安裝失敗；未保存子程序輸出以免洩漏秘密'}};
    const installed=await installedPackages(root);
    if(installed.some(item=>official(item.name)||item.path.split('/node_modules/').some(part=>part.startsWith('@deepseek-ai/'))))return {...result,status:'failed',sourceFilesUnchanged:await unchanged(plan),error:{code:'OFFICIAL_DEPENDENCY_UNEXPECTED',message:'依賴樹含官方執行環境套件，未啟用此安裝結果'}};
    return {...result,status:'installed',method:plan.lock?'npm-ci':'npm-resolve-then-ci',sourceFilesUnchanged:await unchanged(plan),installed,nodePaths:[path.join(root,'node_modules')]};
  }catch(e){return {...result,status:'failed',sourceFilesUnchanged:await unchanged(plan),error:{code:/^[A-Z0-9_]+$/.test(e.code??'')?e.code:'DEPENDENCY_INSTALL_FAILED',message:'無法完成依賴安裝；未保存例外內容以免洩漏秘密'}};}
}
