/** Version aliases: let a plugin that gates itself on an EXACT official package version see that version,
 * when the bundled release is known to behave the same on the part of the package the plugin uses.
 *
 * Nothing is installed and no second copy of the package is created. The plugin resolves official packages through
 * `<stateDir>/compiled/node_modules/@deepseek-ai/` (a directory link into the bundled runtime). When an alias is needed,
 * that scope directory becomes a real directory of links to the same packages, except the aliased one: it is a small
 * shim package whose package.json reports the requested version and whose files re-export the REAL bundled package.
 * So `import('@deepseek-ai/dsh-tools')` from the plugin returns the very same module (same registry classes, same
 * ToolArgsError) that the host uses; only the version text differs.
 *
 * An alias is only ever created from the table below. Each row records what was compared. */
import {lstat,mkdir,readdir,readFile,realpath,rm,rmdir,symlink,unlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

/** Directory link (a junction on Windows). Claude Code can start two copies of a plugin at once (a reload while the
 * first is still starting); both see no link and both create it. The one that loses gets EEXIST: when the existing
 * link already points at `target`, that is the same result, so it is kept instead of failing the start. */
export async function linkScope(target,link){
  try{await symlink(target,link,process.platform==='win32'?'junction':'dir');}
  catch(cause){
    if(cause.code!=='EEXIST')throw cause;
    let same=false;try{same=await realpath(link)===await realpath(target);}catch{}
    if(!same)throw cause;
  }
}

export const VERSION_ALIASES=Object.freeze([
  Object.freeze({
    name:'@deepseek-ai/dsh-tools',
    reports:'0.2.1-alpha.2',
    hostVersions:Object.freeze(['0.2.1-rc.2']),
    comparedExports:Object.freeze(['defineTool','ToolArgsError','validateArgs']),
    evidence:'Function bodies of defineTool, ToolArgsError and validateArgs (and the whole JSON-schema validation / rendering code they use) are textually identical in 0.2.1-alpha.2 and 0.2.1-rc.2; the 23 export names are identical. Differences are confined to run_code (PTC) internals.',
  }),
]);

/** Converter side: which of a plugin's version mismatches can be aliased. `mismatches` is plan.runtimeCompatibility.mismatches. */
export function planVersionAliases(mismatches=[]){
  const result=[];
  for(const item of mismatches){
    const row=VERSION_ALIASES.find(alias=>alias.name===item.name&&alias.reports===item.requested&&alias.hostVersions.includes(item.installed));
    if(row&&!result.some(x=>x.name===row.name))result.push({name:row.name,version:row.reports,hostVersion:item.installed,comparedExports:[...row.comparedExports]});
  }
  return result;
}

const MARKER='.dsh-version-aliases.json';
const exists=async file=>{try{await lstat(file);return true;}catch{return false;}};

/** Resolve the file a package.json `exports` condition object / string points at (types are skipped). */
function exportTarget(value){
  if(typeof value==='string')return value;
  if(Array.isArray(value)){for(const item of value){const found=exportTarget(item);if(found)return found;}return undefined;}
  if(value&&typeof value==='object'){
    for(const key of ['import','node','default']){const found=exportTarget(value[key]);if(found)return found;}
  }
  return undefined;
}

async function writeShimPackage({shimDir,realDir,alias}){
  const manifest=JSON.parse(await readFile(join(realDir,'package.json'),'utf8'));
  await mkdir(shimDir,{recursive:true});
  const exportsOut={},skipped=[];
  let index=0;
  const entries=Object.entries(manifest.exports??{'.':manifest.main??'./index.js'});
  for(const [subpath,value]of entries){
    if(subpath==='./package.json'){exportsOut[subpath]='./package.json';continue;}
    const target=exportTarget(value);
    if(!subpath.startsWith('.')||subpath.includes('*')||typeof target!=='string'){skipped.push(subpath);continue;}
    const realFile=resolve(realDir,target);
    const realUrl=pathToFileURL(await realpath(realFile)).href;
    const namespace=await import(realUrl);
    const shimFile=`__alias_${index++}.mjs`;
    await writeFile(join(shimDir,shimFile),`export * from ${JSON.stringify(realUrl)};\n${'default'in namespace?`export {default} from ${JSON.stringify(realUrl)};\n`:''}`);
    exportsOut[subpath]='./'+shimFile;
  }
  const out={name:manifest.name,version:alias.reports,type:'module',description:`Version alias of the bundled ${manifest.name}@${manifest.version} (reports ${alias.reports}); re-exports the real package.`,exports:exportsOut,main:exportsOut['.']};
  await writeFile(join(shimDir,'package.json'),JSON.stringify(out,null,2)+'\n');
  await writeFile(join(shimDir,MARKER),JSON.stringify({alias:alias.name,reports:alias.reports,realVersion:manifest.version,skipped})+'\n');
  return {skipped,realVersion:manifest.version};
}

async function clearScope(scopeLink){
  // Links are removed as links; only directories this module created (marker file present) are removed recursively.
  for(const entry of await readdir(scopeLink)){
    const full=join(scopeLink,entry),info=await lstat(full);
    if(info.isSymbolicLink())await unlink(full);
    else if(info.isDirectory()&&await exists(join(full,MARKER)))await rm(full,{recursive:true,force:true});
    else throw Object.assign(new Error(`Managed SDK resolution path is occupied: ${entry}`),{code:'HOST_STATE_CONFLICT'});
  }
}

/** Worker side, when no alias is needed (any more): turn a previously aliased scope directory back into nothing, so the plain
 * directory link can be created. Only links and shim directories this module made are removed. */
export async function removeAliasedScope(scopeLink){
  await clearScope(scopeLink);
  await rmdir(scopeLink);
}

/** Worker side. Makes `scopeLink` (…/compiled/node_modules/@deepseek-ai) a real directory of links to `scopeDirectory`'s packages
 * with the aliased packages replaced by shims. Returns one row per alias for the host metadata.
 * @param aliases rows `{ name, version }` from settings (already checked against VERSION_ALIASES here, so a hand-edited settings file cannot alias anything else) */
export async function installVersionAliases({scopeLink,scopeDirectory,aliases}){
  const wanted=[];
  for(const row of aliases){
    const known=VERSION_ALIASES.find(alias=>alias.name===row?.name&&alias.reports===row?.version);
    if(!known)throw Object.assign(new Error(`Version alias is not allowed: ${String(row?.name)}@${String(row?.version)}`),{code:'INVALID_CONFIGURATION'});
    wanted.push(known);
  }
  const info=await lstat(scopeLink).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(info?.isSymbolicLink())await unlink(scopeLink);
  else if(info?.isDirectory())await clearScope(scopeLink);
  else if(info)throw Object.assign(new Error('Managed SDK resolution path is occupied'),{code:'HOST_STATE_CONFLICT'});
  await mkdir(scopeLink,{recursive:true});
  const aliased=new Map(wanted.map(alias=>[alias.name.split('/')[1],alias]));
  const result=[];
  for(const short of await readdir(scopeDirectory)){
    const realDir=join(scopeDirectory,short),alias=aliased.get(short);
    if(!alias){await linkScope(realDir,join(scopeLink,short));continue;}
    const shim=await writeShimPackage({shimDir:join(scopeLink,short),realDir,alias});
    result.push({name:alias.name,reports:alias.reports,realVersion:shim.realVersion,comparedExports:[...alias.comparedExports],skippedSubpaths:shim.skipped});
    aliased.delete(short);
  }
  if(aliased.size)throw Object.assign(new Error(`Aliased package is not bundled: ${[...aliased.values()].map(alias=>alias.name).join(', ')}`),{code:'HOST_DEPENDENCY_MISSING'});
  return result;
}

export const versionAliasMarker=MARKER;
