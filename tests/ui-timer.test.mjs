import test from 'node:test';
import assert from 'node:assert/strict';
import {createTimer} from '../ui/timer.mjs';
import {createEffects,createRuntime} from '../ui/runtime.mjs';

function fakeClock(){
  let now=0,sequence=0;const timers=new Map();
  const add=(callback,delay,repeat,args)=>{const id=++sequence;timers.set(id,{callback,at:now+delay,repeat,args});return id;};
  return {now:()=>now,setTimeout:(callback,delay,...args)=>add(callback,delay,0,args),setInterval:(callback,delay,...args)=>add(callback,delay,delay,args),clearTimeout:id=>timers.delete(id),clearInterval:id=>timers.delete(id),get pending(){return timers.size;},advance(amount){const end=now+amount;while(true){const next=[...timers].filter(([,row])=>row.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!next)break;const [id,row]=next;now=row.at;if(row.repeat)row.at+=row.repeat;else timers.delete(id);row.callback(...row.args);}now=end;}};
}

test('callback timers run once or repeatedly and return idempotent owned disposers',()=>{
  const scope=createEffects(),clock=fakeClock(),timer=createTimer(scope,clock),calls=[];
  const cancel=timer.timeout(()=>calls.push('cancelled'),3);cancel();cancel();
  timer.setTimeout(()=>calls.push('once'),4);const stop=timer.setInterval(()=>calls.push('repeat'),2);
  clock.advance(5);assert.deepEqual(calls,['repeat','once','repeat']);stop();clock.advance(10);assert.deepEqual(calls,['repeat','once','repeat']);assert.equal(clock.pending,0);
  timer.interval(()=>calls.push('after-unload'),2);scope.dispose();clock.advance(10);assert.equal(clock.pending,0);assert.equal(calls.includes('after-unload'),false);
});

test('timeout promise resolves on elapsed time and rejects when its owner unloads',async()=>{
  const scope=createEffects(),clock=fakeClock(),timer=createTimer(scope,clock);
  const elapsed=timer.timeout(5);clock.advance(5);assert.equal(await elapsed,undefined);assert.equal(clock.pending,0);
  const pending=timer.timeout(10),rejected=assert.rejects(pending,{code:'UI_CONTEXT_DISPOSED'});scope.dispose();await rejected;assert.equal(clock.pending,0);
});

test('interval async iterator delivers ticks, completes on return and rejects pending reads on disposal',async()=>{
  const scope=createEffects(),clock=fakeClock(),timer=createTimer(scope,clock),iterator=timer.interval(4);assert.equal(iterator[Symbol.asyncIterator](),iterator);
  const first=iterator.next();clock.advance(4);assert.deepEqual(await first,{done:false,value:undefined});
  const pending=iterator.next();assert.deepEqual(await iterator.return('done'),{done:true,value:'done'});assert.deepEqual(await pending,{done:true,value:'done'});assert.deepEqual(await iterator.next(),{done:true,value:'done'});assert.equal(clock.pending,0);
  const interrupted=timer.interval(3),read=interrupted.next(),rejected=assert.rejects(read,{code:'UI_CONTEXT_DISPOSED'});scope.dispose();await rejected;await assert.rejects(interrupted.next(),{code:'UI_CONTEXT_DISPOSED'});assert.equal(clock.pending,0);
});

test('iterator throw rejects its pending and future reads and clears the scheduled timer',async()=>{
  const scope=createEffects(),clock=fakeClock(),iterator=createTimer(scope,clock).interval(3),problem=new Error('指定錯誤');
  const pending=iterator.next(),rejected=assert.rejects(pending,problem);assert.deepEqual(await iterator.throw(problem),{done:true,value:undefined});await rejected;await assert.rejects(iterator.next(),problem);assert.equal(clock.pending,0);
});

test('debounce preserves the latest arguments and cleanup cancels its pending work',()=>{
  const scope=createEffects(),clock=fakeClock(),timer=createTimer(scope,clock),calls=[],invoke=timer.debounce((...args)=>calls.push(args),5);
  invoke('old');clock.advance(3);invoke('latest',7);clock.advance(4);assert.deepEqual(calls,[]);clock.advance(1);assert.deepEqual(calls,[['latest',7]]);
  invoke('cancelled');invoke.dispose();invoke.dispose();clock.advance(10);assert.equal(calls.length,1);invoke('after-release');clock.advance(10);assert.equal(calls.length,1);
  const pending=timer.debounce(()=>calls.push('after-unload'),3);pending();scope.dispose();clock.advance(3);assert.equal(calls.length,1);assert.equal(clock.pending,0);
});

test('throttle follows the official leading, latest trailing and noTrailing rules',()=>{
  const scope=createEffects(),clock=fakeClock(),timer=createTimer(scope,clock),calls=[],invoke=timer.throttle(value=>calls.push(value),10);
  invoke('leading');clock.advance(2);invoke('old-trailing');clock.advance(2);invoke('latest-trailing');clock.advance(6);assert.deepEqual(calls,['leading','latest-trailing']);
  invoke('cancelled');invoke.dispose();clock.advance(10);assert.deepEqual(calls,['leading','latest-trailing']);
  const leading=timer.throttle(value=>calls.push(value),10,true);leading('only-leading');clock.advance(2);leading('no-trailing');clock.advance(10);assert.deepEqual(calls,['leading','latest-trailing','only-leading']);scope.dispose();assert.equal(clock.pending,0);
});

test('runtime exposes timer injection and mixed-in methods with independent plugin ownership',async()=>{
  const runtime=createRuntime();let first,second,calls=0;
  runtime.load({id:'first-timer',factory:()=>({inject:['timer'],apply(ctx){first=ctx;}})});
  runtime.load({id:'second-timer',factory:()=>({inject:['timer'],apply(ctx){second=ctx;}})});
  assert.deepEqual(runtime.diagnostics,[]);assert.notEqual(first.timer,second.timer);assert.equal(first.get('timer'),first.timer);
  for(const name of ['timeout','interval','throttle','debounce','setTimeout','setInterval'])assert.equal(first[name],first.timer[name]);
  const firstWait=assert.rejects(first.timeout(10000),{code:'UI_CONTEXT_DISPOSED'}),secondWait=assert.rejects(second.timer.timeout(10000),{code:'UI_CONTEXT_DISPOSED'});
  first.setTimeout(()=>calls++,0);first.dispose();await firstWait;assert.equal(runtime.modules.get('second-timer').status,'loaded');runtime.dispose();await secondWait;await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);
});
