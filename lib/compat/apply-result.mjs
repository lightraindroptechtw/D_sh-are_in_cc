/** Cordis treats whatever a plugin's `apply()` returns as an "effect": undefined/null, a dispose function, a promise
 * of one of those, or a generator. Any other value makes Cordis throw `TypeError: Invalid effect`
 * (the contract is the same in @deepseek-ai/cordis 4.0.1 and 4.0.5, so this is not a version difference).
 * Some community plugins return an API object from `apply()` (for example `{ api, getConfig, dispose() {} }`).
 * This adapter keeps the plugin starting without changing its source:
 *   - a plain object with a `dispose` function: that function becomes the effect (called on teardown),
 *   - any other plain object / primitive / array of non-functions: ignored,
 *   - function, nullish, generator, async iterator: unchanged,
 *   - a promise: its resolved value goes through the same rule.
 * The returned object itself is NOT exported anywhere (nothing in DSH reads it), which is stated in `note`. */

const isThenable=value=>value!==null&&typeof value==='object'&&typeof value.then==='function';
const isIterator=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&(typeof value[Symbol.iterator]==='function'||typeof value[Symbol.asyncIterator]==='function');

/** @param report called once per distinct adaptation with `{ kind, keys }` (key names only, never values) */
export function adaptApplyResult(result,report){
  const adapt=value=>{
    if(value===undefined||value===null||typeof value==='function')return value;
    if(isThenable(value))return value.then(adapt);
    if(isIterator(value))return value;
    if(Array.isArray(value)){
      if(value.every(item=>item===undefined||item===null||typeof item==='function'))return value;
      report?.({kind:'array',keys:[]});return undefined;
    }
    if(typeof value==='object'){
      const keys=Object.keys(value).slice(0,20);
      if(typeof value.dispose==='function'){report?.({kind:'object-with-dispose',keys});return ()=>value.dispose();}
      report?.({kind:'object',keys});return undefined;
    }
    report?.({kind:typeof value,keys:[]});return undefined;
  };
  return adapt(result);
}
