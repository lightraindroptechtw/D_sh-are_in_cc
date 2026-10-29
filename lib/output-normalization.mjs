/** Drop only enumerable object properties whose values are undefined. All other
 * values and schema constraints remain the official validator's responsibility. */
export function normalizeOutput(value,seen=new WeakMap()) {
  if(!value||typeof value!=='object')return value;
  const proto=Object.getPrototypeOf(value);
  if(!Array.isArray(value)&&proto!==Object.prototype&&proto!==null)return value;
  if(seen.has(value))return seen.get(value);
  const copy=Array.isArray(value)?[]:Object.create(proto);seen.set(value,copy);
  for(const key of Reflect.ownKeys(value)) {
    if(Array.isArray(value)&&key==='length')continue;
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!Array.isArray(value)&&typeof key==='string'&&descriptor.enumerable&&'value'in descriptor&&descriptor.value===undefined)continue;
    if('value'in descriptor)descriptor.value=normalizeOutput(descriptor.value,seen);
    Object.defineProperty(copy,key,descriptor);
  }
  if(Array.isArray(value))Object.defineProperty(copy,'length',Object.getOwnPropertyDescriptor(value,'length'));
  return copy;
}
export function wrapToolDefinition(definition,enabled=false) {
  if(!enabled||!definition||typeof definition.execute!=='function')return definition;
  const descriptors=Object.getOwnPropertyDescriptors(definition),original=definition.execute;
  descriptors.execute={...descriptors.execute,value:async function(...args){return normalizeOutput(await Reflect.apply(original,this,args));}};
  return Object.create(Object.getPrototypeOf(definition),descriptors);
}
