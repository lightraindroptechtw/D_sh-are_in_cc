/** Bundles a DSH plugin entry with esbuild. Shared by the worker (compile at start-up, the original
 * behaviour) and by the Claude converter (compile once at conversion time, `portable: true`).
 *
 * Only the places that used to hard-code an absolute path differ in portable mode:
 *  - `@deepseek-ai/*` stays a bare external specifier (the worker links `<stateDir>/compiled/node_modules/@deepseek-ai`),
 *  - `import.meta.url` of every source file and the `createRequire` entry URL become
 *    `__DSH_SOURCE_ROOT_URL__/<path relative to the source root>`, which `resolveSourceRootPlaceholder` fills in at start-up.
 * Everything else (nodePaths, bundling, lazy dependency handling, transform) is identical in both modes.
 *
 * esbuild is passed in, never imported here, so the worker bundle does not pull in a second copy of it. */
import {readFile} from 'node:fs/promises';
import {dirname,extname,isAbsolute,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {lazyDependenciesPlugin} from './lazy-dependencies.mjs';
import {compatModuleFor,exportNamesOf} from './compat/index.mjs';

export const SOURCE_ROOT_PLACEHOLDER='__DSH_SOURCE_ROOT_URL__';
export const PRECOMPILED_ENTRY_FILE='plugin.mjs';
export const PRECOMPILED_META_FILE='plugin.meta.json';
export const PRECOMPILED_SCHEMA_VERSION=1;

const hostError=(message,code)=>Object.assign(new Error(message),{code});
// Every character outside [A-Za-z0-9._~%-] is percent-encoded so the placeholder is easy to find again
// and survives however esbuild quotes the string it sits in.
const encodeSegment=segment=>encodeURIComponent(segment).replace(/[!'()*]/g,ch=>'%'+ch.charCodeAt(0).toString(16).toUpperCase());
const PLACEHOLDER_PATTERN=new RegExp(`${SOURCE_ROOT_PLACEHOLDER}/([A-Za-z0-9._~%/-]*)`,'g');

// CommonJS-style sources use __dirname/__filename, which do not exist once esbuild emits an ES module.
// Each file that uses one (and does not declare it itself) gets a prelude on its first line, so line numbers stay put.
// The URL is the same text as import.meta.url, so a portable bundle stays correct after the plugin is moved.
const uses=(code,name)=>new RegExp('\\b'+name+'\\b').test(code);
const declares=(code,name)=>new RegExp('\\b(?:const|let|class|function|import)\\s+'+name+'\\b|[{,]\\s*'+name+'\\s*[,}]\\s*=').test(code);
export function nodeFileGlobalsPrelude(code,fileUrl){
  const wantFilename=uses(code,'__filename')&&!declares(code,'__filename');
  const wantDirname=uses(code,'__dirname')&&!declares(code,'__dirname');
  if(!wantFilename&&!wantDirname)return code;
  const file=`require('node:url').fileURLToPath(${JSON.stringify(fileUrl)})`;
  const prelude=';'+(wantFilename?`var __filename=${file};`:'')+(wantDirname?`var __dirname=require('node:path').dirname(${file});`:'');
  // Keep a shebang line and a leading "use strict" directive first.
  const head=/^(?:#![^\n]*\n)?\s*(?:(['"])use strict\1;?)?/.exec(code)[0];
  return head+prelude+code.slice(head.length);
}

/** Portable URL text for a file; absolute `file:` URL only when the file is on another drive than the source root. */
export function portableFileUrl(sourceRoot,file){
  const rel=relative(sourceRoot,file);
  if(!rel||isAbsolute(rel))return pathToFileURL(file).href;
  return `${SOURCE_ROOT_PLACEHOLDER}/${rel.split(sep).map(encodeSegment).join('/')}`;
}

/** Replace every placeholder in precompiled code by the real file URL under `sourceRoot`. */
export function resolveSourceRootPlaceholder(code,sourceRoot){
  return code.replace(PLACEHOLDER_PATTERN,(_,rel)=>pathToFileURL(resolve(sourceRoot,...rel.split('/').map(decodeURIComponent))).href);
}

/**
 * @param esbuild        the esbuild module (needs build and transform)
 * @param requireFromHost  a require rooted at the official runtime (host-env), used to check `@deepseek-ai/*`
 * @param nodePaths      absolute directories searched for bare packages (source-deps, then the runtime's node_modules)
 * @param portable       true: write a relocatable bundle (see the file header)
 * @param onLazyDependency  called for every dependency kept lazy or external
 * @param onCompat       called once per official package whose import was served by a compat module (lib/compat/index.mjs)
 */
export async function compileDshEntry({esbuild,requireFromHost,entry,outfile,sourceRoot,nodePaths,portable=false,onLazyDependency,onCompat}){
  const compatSeen=new Set();
  const urlOf=file=>portable?portableFileUrl(sourceRoot,file):pathToFileURL(file).href;
  await esbuild.build({
    entryPoints:[entry],outfile,absWorkingDir:sourceRoot,nodePaths,bundle:true,platform:'node',format:'esm',target:'node22',logLevel:'silent',
    banner:{js:`import {createRequire as __hostCreateRequire} from 'node:module';const require=__hostCreateRequire(${JSON.stringify(urlOf(entry))});`},
    plugins:[{name:'real-dsh-host-modules',setup(api){
      // An official package whose older API the plugin may expect: the plugin sees the real package plus the compat names.
      // Imports made BY the compat module itself (namespace dsh-compat) fall through to the normal external rule below.
      api.onResolve({filter:/^@deepseek-ai\/[^/]+$/},args=>{
        const compat=args.namespace==='dsh-compat'?undefined:compatModuleFor(args.path);
        if(!compat)return undefined;
        try{requireFromHost.resolve(args.path);}catch{throw hostError(`Official runtime dependency is unavailable: ${args.path}`,'HOST_DEPENDENCY_MISSING');}
        if(!compatSeen.has(args.path)){compatSeen.add(args.path);onCompat?.({package:args.path,olderRelease:compat.olderRelease,provides:[...compat.provides]});}
        return {path:args.path,namespace:'dsh-compat'};
      });
      api.onLoad({filter:/.*/,namespace:'dsh-compat'},async args=>{
        const names=await exportNamesOf(esbuild,requireFromHost.resolve(args.path));
        return {contents:compatModuleFor(args.path).render(args.path,names),loader:'js',resolveDir:sourceRoot};
      });
      api.onResolve({filter:/^@deepseek-ai\//},args=>{
        try{
          const resolved=requireFromHost.resolve(args.path);
          return {path:portable?args.path:pathToFileURL(resolved).href,external:true};
        }catch{throw hostError(`Official runtime dependency is unavailable: ${args.path}`,'HOST_DEPENDENCY_MISSING');}
      });
      api.onLoad({filter:/\.(?:[cm]?[jt]sx?)$/},async args=>{
        const ext=extname(args.path).slice(1),loader={cjs:'js',mjs:'js',mts:'ts',cts:'ts'}[ext]??ext;
        const transformed=await esbuild.transform(nodeFileGlobalsPrelude(await readFile(args.path,'utf8'),urlOf(args.path)),{loader,target:'node22',sourcefile:args.path,define:{'import.meta.url':JSON.stringify(urlOf(args.path))}});
        return {contents:transformed.code,loader:'js',resolveDir:dirname(args.path)};
      });
    }},lazyDependenciesPlugin({onUnresolved:onLazyDependency})],
  });
}
