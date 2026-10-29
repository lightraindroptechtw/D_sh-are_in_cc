import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,createEffects,createConfigForms} from '../ui/runtime.mjs';

test('original loader preserves settings after unsupported chat mount, scopes generator cleanup',()=>{
  const runtime=createRuntime();let cleaned=0;
  runtime.load({id:'original',factory:()=>({inject:['slots'],apply(ctx){
    ctx.slots.inject('conversation.input.left',()=>{throw new Error('must not execute');});
    ctx.slots.inject('settings.section',function*(){yield ctx.slots.register({name:'settings.section',id:'settings',order:5},()=>null);yield()=>cleaned++;});
    ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'library'},()=>null));
  }})});
  assert.equal(runtime.modules.get('original').status,'loaded');
  assert.equal(runtime.slots.entries('settings.section').length,1);
  assert.equal(runtime.diagnostics[0].code,'UI_SLOT_UNSUPPORTED');
  runtime.layout.selectPanel('library');assert.equal(runtime.layout.panelInfo.getSnapshot().activePanelId,'library');
  runtime.dispose();assert.equal(cleaned,1);assert.equal(runtime.slots.entries('settings.section').length,0);
});
test('declared child locations activate waiting effects and remove them with the parent',()=>{
  const runtime=createRuntime();let disposed=0;
  runtime.slots.inject('settings.plugin.item',()=>{runtime.slots.register({name:'settings.plugin.item',id:'form'},()=>null);return()=>disposed++;});
  const off=runtime.slots.register({name:'settings.section',id:'container',children:{'settings.plugin.item':{kind:'list',scope:'root'}}},()=>null);
  assert.equal(runtime.slots.entries('settings.plugin.item').length,1);off();assert.equal(disposed,1);
});
test('settings writes use real revision and refresh; backend rejection never reports saved',async()=>{
  let revision=4,value=2,deny=false;
  const calls=[];const forms=createConfigForms(async(method,args)=>{calls.push([method,args]);if(method==='settings.describe')return [{ns:'test',value:{count:value},revision}];if(deny)throw new Error('來源拒絕更新');assert.equal(args.revision,revision);value=args.patch.count;revision++;return {applied:true};});
  await forms.load();const form=forms.get('test');await form.set('count',9);assert.equal(form.getSnapshot().value.count,9);
  deny=true;await assert.rejects(form.set('count',20),/來源拒絕/);assert.equal(form.getSnapshot().value.count,9);assert.ok(calls.length>=5);
});
test('async effect disposer arriving after shutdown is still released',async()=>{
  const effects=createEffects();let release,closed=0;effects.effect(()=>new Promise(resolve=>{release=resolve;}));effects.dispose();release(()=>closed++);await Promise.resolve();assert.equal(closed,1);
});
