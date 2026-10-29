/** Source code sees original package names while the boot loader keeps private aliases. */
export function withSourceLoaderNames(context,names){
  const loader=context.loader;
  if(!loader||typeof loader.entries!=='function')return context;
  const view=new Proxy(loader,{get(target,key){
    if(key==='entries')return(...args)=>Array.from(target.entries(...args),entry=>{
      const name=names.get(entry?.options?.name);
      if(!name)return entry;
      const options=new Proxy(entry.options,{get(object,key){return key==='name'?name:Reflect.get(object,key);}});
      return new Proxy(entry,{get(object,key){return key==='options'?options:Reflect.get(object,key,object);}});
    });
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  return new Proxy(context,{get(target,key){
    if(key==='loader')return view;
    if(key==='get')return(name,...args)=>name==='loader'?view:target.get(name,...args);
    return Reflect.get(target,key,target);
  }});
}
