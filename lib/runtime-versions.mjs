import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import semver from 'semver';

const bundledRoot=fileURLToPath(new URL('../',import.meta.url));

/** Read manifests only; never resolve source code by importing a dependency. */
export async function checkRuntimeVersions(pkg,{runtimeRoot=bundledRoot}={}){
  const requirements=[];
  for(const declaredIn of ['dependencies','peerDependencies']){
    for(const [name,requested] of Object.entries(pkg[declaredIn]??{})){
      if(!/^@deepseek-ai\/[a-z0-9][a-z0-9._-]*$/.test(name))continue;
      let installed=null;
      try{const manifest=JSON.parse(await fs.readFile(path.join(runtimeRoot,'node_modules',name,'package.json'),'utf8'));if(manifest.name===name)installed=manifest.version??null;}
      catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;}
      const comparable=typeof requested==='string'&&Boolean(semver.validRange(requested));
      // Deliberately use the wider prerelease compatibility policy: a bundled
      // release candidate may satisfy an otherwise matching stable range or *.
      const status=!installed?'not-bundled':!semver.valid(installed)||!comparable?'uncomparable':semver.satisfies(installed,requested,{includePrerelease:true})?'in-declared-range':'outside-declared-range';
      requirements.push({name,declaredIn,requested,installed,status,optional:declaredIn==='peerDependencies'&&pkg.peerDependenciesMeta?.[name]?.optional===true});
    }
  }
  return {engine:'official-dsh',rangePolicy:{includePrerelease:true},requirements,mismatches:requirements.filter(item=>item.status==='outside-declared-range'),unresolved:requirements.filter(item=>item.status==='not-bundled'||item.status==='uncomparable'),sourceExecuted:false};
}
