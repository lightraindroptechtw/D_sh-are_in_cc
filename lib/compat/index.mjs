/** Compatibility modules that the plugin-entry compile substitutes for an official package.
 *
 * A compat module is ES module source generated per compile. esbuild resolves the plugin's `import ... from '<package>'` to it;
 * inside the module the bare specifier `<package>` still means the real, bundled official package (marked external as usual), so
 * the module is "the real package, plus these extra names". The real package's exports are re-exported ONE BY ONE (the list is
 * read from the package with esbuild's metafile, no code is executed), so a name that exists in neither release is still a
 * bundle-time "No matching export" error at the plugin's import, not a silent `undefined`.
 * (If the list cannot be read, `export *` is used instead; that is more permissive but never stricter than before.)
 *
 * Only names whose behaviour was compared with the older release are provided; a name that cannot be mapped faithfully is listed
 * in `unavailable` and throws a clear error when it is CALLED (or used), never at import time. `unavailable` is empty today.
 *
 * @deepseek-ai/dsh-llm  0.1.0-rc.6 -> 0.2.1-rc.2
 *   exports of 0.1.0-rc.6 that 0.2.1-rc.2 no longer has: CallId, assertNever, deepFreeze (all other names exist).
 *   CallId      0.1: `function CallId(id){return id}`; 0.2 renamed it ToolCallId = brandString(id) = `return id`. Same runtime value.
 *   assertNever 0.1 body == 0.2 body (moved to @deepseek-ai/dsh-util-values).
 *   deepFreeze  0.1 body == 0.2 body (moved to @deepseek-ai/dsh-util-values).
 *   Names that exist in both releases but behave differently (not changed here, listed so nobody assumes otherwise):
 *   createToolResultMessage (0.2 builds a role "tool" message, 0.1 a user message with a tool-result block),
 *   contentHasImage (0.2 no longer walks into tool-result blocks), createMessage (0.2 clones before freezing). */

const quote=value=>JSON.stringify(value);

function llmSource(specifier,exportNames){
  const lines=[];
  const real=Array.isArray(exportNames)?exportNames:null;
  const has=name=>real?.includes(name)??false;
  if(real){
    const named=real.filter(name=>name!=='default'&&/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name));
    if(named.length)lines.push(`export {${named.join(',')}} from ${quote(specifier)};`);
    if(has('default'))lines.push(`export {default} from ${quote(specifier)};`);
  }else{
    lines.push(`export * from ${quote(specifier)};`,`export {default} from ${quote(specifier)};`);
  }
  lines.push(`import {ToolCallId as __dshToolCallId} from ${quote(specifier)};`,`import * as __dshValues from '@deepseek-ai/dsh-util-values';`);
  // 0.1.0-rc.6 name for the tool-call id brand; identical at run time (returns its argument).
  if(!has('CallId'))lines.push('export const CallId=__dshToolCallId;');
  // Moved to @deepseek-ai/dsh-util-values in 0.2 with the same implementation.
  if(!has('assertNever'))lines.push('export const assertNever=__dshValues.assertNever;');
  if(!has('deepFreeze'))lines.push('export const deepFreeze=__dshValues.deepFreeze;');
  return lines.join('\n')+'\n';
}

export const COMPAT_MODULES=Object.freeze({
  '@deepseek-ai/dsh-llm':Object.freeze({
    render:llmSource,
    olderRelease:'0.1.0-rc.6',
    provides:Object.freeze(['CallId','assertNever','deepFreeze']),
    unavailable:Object.freeze([]),
    differs:Object.freeze(['createToolResultMessage','contentHasImage','createMessage']),
  }),
});

/** The compat row for a bare package specifier, or undefined. */
export const compatModuleFor=specifier=>typeof specifier==='string'&&Object.hasOwn(COMPAT_MODULES,specifier)?COMPAT_MODULES[specifier]:undefined;

/** Export names of an ESM file without executing it (esbuild metafile), or null when they cannot be determined. */
export async function exportNamesOf(esbuild,file){
  try{
    const result=await esbuild.build({entryPoints:[file],bundle:true,packages:'external',write:false,metafile:true,format:'esm',platform:'node',logLevel:'silent',outfile:'compat-exports.mjs'});
    const output=Object.values(result.metafile.outputs)[0];
    return Array.isArray(output?.exports)?[...output.exports]:null;
  }catch{return null;}
}
