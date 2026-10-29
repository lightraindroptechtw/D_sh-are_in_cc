export class ModuleError extends Error{
  constructor(module,method,reason,code='DSH_MODULE_UNSUPPORTED'){
    super(`${module}.${method}: ${reason}`);this.name='DshModuleError';this.code=code;this.module=module;this.method=method;this.reason=reason;
  }
}
export const unsupported=(module,method,reason)=>{throw new ModuleError(module,method,reason);};
export function unavailableService(module,reason){
  return new Proxy(Object.create(null),{get(_,method){if(typeof method==='symbol'||method==='then'||method==='toJSON')return undefined;return()=>unsupported(module,String(method),reason);}});
}
export async function installOfficial(descriptor,{root,load,options={}}){
  const name=descriptor.services[0];
  if(root.get(name))return {services:{[name]:root.get(name)},diagnostics:[]};
  const implementation=await load(descriptor.officialPackage);
  const fork=root.plugin(implementation.default,options.config??{});
  await fork?.await?.();
  return {services:{[name]:root.get(name)},dispose:()=>fork?.dispose?.(),diagnostics:[]};
}
