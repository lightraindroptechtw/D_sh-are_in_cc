import fs from 'node:fs/promises';
import path from 'node:path';
import {build} from 'esbuild';
import {copyHostEnvironment} from './host-files.mjs';
import {createHash} from 'node:crypto';
import {stablePluginId} from './state-paths.mjs';

// Only immutable generated JS bytes are shared. Every destination keeps its
// own dependency files, state and settings, and remains relocatable.
const templateCache=new Map();
async function templates(converterRoot){
  const hash=createHash('sha256').update(path.resolve(converterRoot));
  const lib=path.join(converterRoot,'lib');
  const scan=async(dir,prefix='')=>{for(const row of(await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const name=prefix+row.name;if(row.isDirectory())await scan(path.join(dir,row.name),name+'/');else if(name.endsWith('.mjs'))hash.update(name).update(await fs.readFile(path.join(dir,row.name)));}};await scan(lib);
  // Transport codecs are shared with the browser; their bytes also invalidate
  // the bundled host template when converting twice in one market process.
  await scan(path.join(converterRoot,'ui'),'ui/');
  hash.update(await fs.readFile(path.join(converterRoot,'package-lock.json')));
  const key=hash.digest('hex'),cacheHit=templateCache.has(key);
  if(!cacheHit){
    const compile=async(contents,sourcefile)=>{
      const result=await build({stdin:{contents,sourcefile,resolveDir:lib},write:false,bundle:true,platform:'node',format:'esm',target:'node22',packages:'bundle',external:['esbuild'],banner:{js:"import {createRequire as __runtimeCreateRequire} from 'node:module';const require=__runtimeCreateRequire(import.meta.url);"},logLevel:'silent'});
      return result.outputFiles[0].contents;
    };
    const promise=(async()=>({
      worker:await compile(`import './dsh-host-worker.mjs';`,'worker-entry.mjs'),
    }))();
    templateCache.set(key,promise);
    if(templateCache.size>4)templateCache.delete(templateCache.keys().next().value);
    promise.catch(()=>templateCache.delete(key));
  }
  return {...await templateCache.get(key),cacheHit,hash:key};
}

/** Generate a relocatable host without importing or initializing any source code. */
export async function buildOfficialHost({converterRoot,outputDir,plan,config,allowTools,workspace,options={}}){
  const runtime=path.join(outputDir,'runtime');await fs.mkdir(runtime,{recursive:true});
  const environment=await copyHostEnvironment({fromRoot:converterRoot,toRoot:path.join(runtime,'host-env')});
  const stateId=options.stateId??stablePluginId({origin:plan.source?.origin??plan.origin??plan.source?.path??plan.name,packageDir:plan.packageDir??'.',name:plan.name});
  const interception=options.interception??/tools\/(pre-execute|post-execute|result)/.test(JSON.stringify(plan.hostRuntime??plan.host??{}));
  const settings={...options,stateId,name:plan.name,entry:plan.entry,packageDir:plan.packageDir??'.',config:{...plan.defaultConfig,...config},allowTools,interception,plan:{hostRuntime:plan.hostRuntime,host:plan.host,capabilities:plan.capabilities},...(workspace?{workspace:path.resolve(workspace)}:{})};
  await fs.writeFile(path.join(runtime,'settings.json'),JSON.stringify(settings,null,2)+'\n');
  const compiled=await templates(converterRoot);
  await fs.writeFile(path.join(runtime,'dsh-host-worker.mjs'),compiled.worker);
  return {environment,settings,sourceExecuted:false,runtimeTemplate:{cacheHit:compiled.cacheHit,hash:compiled.hash}};
}
