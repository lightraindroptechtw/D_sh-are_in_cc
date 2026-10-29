/** Browser-safe projection of @deepseek-ai/cordis-plugin-timer 1.1.7.
 * Callback timers, waiting promises, tick iterators and scheduled wrappers are
 * all owned by the calling plugin's effect scope. */
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const disposedError=()=>Object.assign(new Error('所屬插件已卸載，計時工作已取消。'),{code:'UI_CONTEXT_DISPOSED'});
export function createTimer(scope,clock={setTimeout:(...args)=>globalThis.setTimeout(...args),clearTimeout:timer=>globalThis.clearTimeout(timer),setInterval:(...args)=>globalThis.setInterval(...args),clearInterval:timer=>globalThis.clearInterval(timer),now:()=>Date.now()}){
  function timeout(...args){
    const callback=typeof args[0]==='function'?args.shift():undefined,delay=args[0];
    if(callback){const dispose=scope.effect(()=>{const timer=clock.setTimeout(()=>{dispose();callback();},delay);return()=>clock.clearTimeout(timer);});return dispose;}
    const task=deferred(),dispose=scope.effect(()=>{const timer=clock.setTimeout(task.resolve,delay);return()=>{clock.clearTimeout(timer);task.reject(disposedError());};});
    return task.promise.finally(dispose);
  }
  function interval(...args){
    const callback=typeof args[0]==='function'?args.shift():undefined,delay=args[0];
    if(callback)return scope.effect(()=>{const timer=clock.setInterval(callback,delay);return()=>clock.clearInterval(timer);});
    let done,nextTask;
    const dispose=scope.effect(()=>{const timer=clock.setInterval(()=>nextTask?.resolve({done:false,value:undefined}),delay);return()=>{clock.clearInterval(timer);if(done)return;done={kind:'throw',reason:disposedError()};nextTask?.reject(done.reason);};});
    return {next(){if(!done)return (nextTask=deferred()).promise;return done.kind==='return'?Promise.resolve({done:true,value:done.value}):Promise.reject(done.reason);},return(value){if(!done)done={kind:'return',value};nextTask?.resolve({done:true,value});dispose();return Promise.resolve({done:true,value});},throw(reason){if(!done)done={kind:'throw',reason};nextTask?.reject(reason);dispose();return Promise.resolve({done:true,value:undefined});},[Symbol.asyncIterator](){return this;}};
  }
  function schedule(trigger,isDisposed=false){
    let timer;const dispose=scope.effect(()=>()=>{isDisposed=true;clock.clearTimeout(timer);});
    const wrapper=(...args)=>{clock.clearTimeout(timer);timer=trigger(args,isDisposed);};wrapper.dispose=dispose;return wrapper;
  }
  function throttle(callback,delay,noTrailing){
    let lastCall=-Infinity;const execute=(...args)=>{lastCall=clock.now();callback(...args);};
    return schedule((args,isDisposed)=>{const remaining=delay-clock.now()+lastCall;if(remaining<=0)execute(...args);else if(!isDisposed)return clock.setTimeout(execute,remaining,...args);},noTrailing);
  }
  function debounce(callback,delay){return schedule((args,isDisposed)=>{if(!isDisposed)return clock.setTimeout(callback,delay,...args);});}
  return {timeout,interval,throttle,debounce,setTimeout:timeout,setInterval:interval};
}
