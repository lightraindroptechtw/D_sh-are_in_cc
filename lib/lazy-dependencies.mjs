import fs from 'node:fs/promises';
import path from 'node:path';

const packageNameOf=specifier=>specifier.startsWith('@')?specifier.split('/').slice(0,2).join('/'):specifier.split('/')[0];
async function declaredOptional(importer,specifier){
  const name=packageNameOf(specifier);
  let current=path.dirname(importer);
  for(;;){
    try{const pkg=JSON.parse(await fs.readFile(path.join(current,'package.json'),'utf8'));return Boolean(Object.hasOwn(pkg.optionalDependencies??{},name)||pkg.peerDependenciesMeta?.[name]?.optional===true);}catch(error){if(error.code!=='ENOENT')return false;}
    const parent=path.dirname(current);if(parent===current)return false;current=parent;
  }
}

// Evaluated only when the module is first used, never at bundle time. Reading a member, calling or
// constructing it throws a clear "not installed" error instead of an undefined-is-not-a-function.
const missingModule=name=>`const name=${JSON.stringify(name)};
const fail=()=>{const error=new Error('Optional dependency "'+name+'" is not installed in this converted plugin');error.code='MODULE_NOT_FOUND';return error;};
const quiet=key=>typeof key==='symbol'||key==='__esModule'||key==='then'||key==='toJSON';
const handler={get(_,key){if(quiet(key))return undefined;throw fail();},apply(){throw fail();},construct(){throw fail();}};
const fallback=new Proxy(function(){},handler);
module.exports=new Proxy(function(){},{...handler,getPrototypeOf:()=>fallback});
`;

/** Keep unresolved optional dependencies lazy instead of failing the whole bundle.
 *
 * - `import()` and `require()` of a package that cannot be resolved stay as runtime calls
 *   (external), so the source's own try/catch fallback works exactly as it does under Node.
 * - A static `import` of a package that the nearest package.json declares optional
 *   (optionalDependencies or an optional peer) becomes a module that fails only when used.
 * - Any other missing static import is still a build error ("Could not resolve ..."): nothing
 *   is invented for a dependency the source needs at load time.
 * `onUnresolved({specifier, kind, importer, mode})` reports every case for the conversion report.
 */
export function lazyDependenciesPlugin({onUnresolved}={}){return {name:'preserve-lazy-dependencies',setup(api){
  const note=(args,mode)=>{try{onUnresolved?.({specifier:args.path,kind:args.kind,importer:args.importer,mode});}catch{}};
  api.onResolve({filter:/^[^./\\]|^@/},async args=>{
    if(args.pluginData?.dshLazyResolution||args.path.startsWith('@deepseek-ai/')||args.namespace==='dsh-missing-optional')return;
    const lazyKinds=['dynamic-import','require-call','require-resolve'];
    if(!lazyKinds.includes(args.kind)&&args.kind!=='import-statement')return;
    const result=await api.resolve(args.path,{importer:args.importer,resolveDir:args.resolveDir,kind:args.kind,pluginData:{dshLazyResolution:true}});
    if(result.errors.length===0)return result;
    if(lazyKinds.includes(args.kind)){note(args,'external');return {path:args.path,external:true};}
    if(await declaredOptional(args.importer,args.path)){note(args,'optional-stub');return {path:args.path,namespace:'dsh-missing-optional'};}
  });
  api.onLoad({filter:/.*/,namespace:'dsh-missing-optional'},args=>({contents:missingModule(args.path),loader:'js'}));
}};}
