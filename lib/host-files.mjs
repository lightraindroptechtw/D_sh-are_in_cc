import fs from 'node:fs/promises';
import path from 'node:path';
import {inside} from './source.mjs';

const readJson=async file=>JSON.parse(await fs.readFile(file,'utf8'));
async function locate(name,from,root){
  let current=from;
  while(inside(root,current)){
    const candidate=path.join(current,'node_modules',name);
    try{const pkg=await readJson(path.join(candidate,'package.json'));if(pkg.name===name)return {dir:candidate,pkg};}catch(e){if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e;}
    const next=path.dirname(current);if(next===current)break;current=next;
  }
  return null;
}

/** Copy already installed official runtime dependencies; never invokes npm or source scripts. */
export async function copyHostEnvironment({fromRoot,toRoot}){
  fromRoot=path.resolve(fromRoot);toRoot=path.resolve(toRoot);
  const installedModules=path.join(fromRoot,'node_modules');
  if(inside(installedModules,toRoot)||inside(toRoot,installedModules))throw new Error('Host environment destination cannot overlap the installed dependency tree');
  const manifest=await readJson(path.join(fromRoot,'package.json'));
  // SRC Remote signatures are parsed at runtime, after conversion. TypeScript
  // must travel with the Host rather than resolve from the converter checkout.
  const initial=Object.keys(manifest.dependencies??{}).filter(name=>name.startsWith('@deepseek-ai/')||name==='esbuild'||name==='typescript');
  if(!initial.length)throw new Error('No official DSH runtime dependencies are installed');
  const queue=initial.map(name=>({name,from:fromRoot,optional:false})),seen=new Set(),copied=[],omitted=[];
  while(queue.length){
    const {name,from,optional}=queue.shift();const found=await locate(name,from,fromRoot);
    if(!found){if(optional){omitted.push(name);continue;}throw new Error(`Missing installed DSH dependency: ${name}; run npm ci --ignore-scripts --legacy-peer-deps in the converter package`);}
    if(seen.has(found.dir))continue;seen.add(found.dir);
    if(!inside(path.join(fromRoot,'node_modules'),await fs.realpath(found.dir)))throw new Error('Host dependency resolves outside the installed runtime');
    const relative=path.relative(fromRoot,found.dir),destination=path.join(toRoot,relative);
    await fs.mkdir(path.dirname(destination),{recursive:true});
    await fs.cp(found.dir,destination,{recursive:true,filter:source=>source===found.dir||path.basename(source)!=='node_modules'});
    copied.push({name:found.pkg.name,version:found.pkg.version,license:found.pkg.license??null,path:relative.replaceAll('\\','/')});
    for(const dependency of Object.keys(found.pkg.dependencies??{}))queue.push({name:dependency,from:found.dir,optional:Boolean(found.pkg.optionalDependencies?.[dependency])});
    for(const dependency of Object.keys(found.pkg.optionalDependencies??{}))if(!Object.hasOwn(found.pkg.dependencies??{},dependency))queue.push({name:dependency,from:found.dir,optional:true});
  }
  const result={engine:'official-dsh',packages:copied,omittedOptionalDependencies:[...new Set(omitted)],installScriptsExecuted:false};
  await fs.writeFile(path.join(toRoot,'host-environment.json'),JSON.stringify(result,null,2)+'\n');return result;
}
