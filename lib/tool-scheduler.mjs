function failure(message,code='HOST_CANCELED'){return Object.assign(new Error(message),{code});}
/** FIFO scheduler; only the official DSH executionMode classifier can admit parallel work. */
export class ToolScheduler {
  constructor(tools){this.tools=tools;this.queue=[];this.active=new Set();this.exclusive=false;this.closed=false;}
  run(exec,fn,{signal=exec.signal}={}) {
    if(this.closed)return Promise.reject(failure('Tool scheduler has been disposed','DISPOSED'));
    if(signal?.aborted)return Promise.reject(failure('Tool request canceled before scheduling'));
    return new Promise((resolve,reject)=>{
      const controller=new AbortController(),slot={exec,fn,resolve,reject,controller,started:false,finished:false};
      const abort=()=>{controller.abort();if(!slot.started){const index=this.queue.indexOf(slot);if(index>=0)this.queue.splice(index,1);slot.finished=true;slot.removeAbort?.();reject(failure('Queued tool request canceled'));this.pump();}};
      if(signal){signal.addEventListener('abort',abort,{once:true});slot.removeAbort=()=>signal.removeEventListener('abort',abort);}
      this.queue.push(slot);this.pump();
    });
  }
  pump(){
    if(this.closed||this.exclusive)return;
    while(this.queue.length){
      const slot=this.queue[0];let parallel=false;
      try{parallel=this.tools.executionMode(slot.exec)?.kind==='parallel';}catch{}
      if(!parallel&&this.active.size)return;
      this.queue.shift();slot.started=true;slot.parallel=parallel;this.active.add(slot);if(!parallel)this.exclusive=true;
      Promise.resolve().then(()=>{if(slot.controller.signal.aborted)throw failure('Tool request canceled before execution');return slot.fn({...slot.exec,signal:slot.controller.signal});}).then(slot.resolve,slot.reject).finally(()=>{slot.finished=true;slot.removeAbort?.();this.active.delete(slot);if(!slot.parallel)this.exclusive=false;this.pump();});
      if(!parallel)return;
    }
  }
  dispose(){
    if(this.closed)return;this.closed=true;
    for(const slot of this.queue.splice(0)){slot.finished=true;slot.removeAbort?.();slot.controller.abort();slot.reject(failure('Tool scheduler disposed before execution','DISPOSED'));}
    for(const slot of this.active)slot.controller.abort();
  }
}
export const createToolScheduler=tools=>new ToolScheduler(tools);
