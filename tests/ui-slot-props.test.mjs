import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createSlotProps} from '../ui/slot-props.mjs';
import {createConfigForms,createRuntime,createRpc} from '../ui/runtime.mjs';

test('original injected stores become selector hooks and retain original actions and translations',()=>{
  let current={title:'before'};const action=()=>{};
  const row={registrant:'sample',locale:'sample-locale',instance:{id:1},inject:()=>({hooks:{card:{getSnapshot:()=>current,subscribe:()=>()=>{}}},onSave:action})};
  const props=createSlotProps(React,row,{bind:ns=>key=>ns+':'+key},{visible:true});
  function Card(){return React.createElement('p',null,props.t('title')+':'+props.useCard(state=>state.title));}
  assert.equal(renderToStaticMarkup(React.createElement(Card)),'<p>sample-locale:title:before</p>');
  current={title:'after'};assert.match(renderToStaticMarkup(React.createElement(Card)),/after/);assert.equal(props.onSave,action);assert.equal(props.store,row.instance);assert.equal(props.visible,true);
});

test('nested settings edits and clearing an override use the real remote contract and revisions',async()=>{
  let revision=4,value={tools:{read:true},limit:7};const calls=[];
  const forms=createConfigForms(async(method,args)=>{calls.push([method,args]);if(method==='settings.describe')return [{ns:'sample',value:structuredClone(value),revision}];
    assert.equal(method,'ui.connection.call');assert.equal(args.endpoint,'settings/mutate');assert.equal(args.payload.args.expectedRevision,revision);
    for(const op of args.payload.args.ops){if(op.path.length===2)value[op.path[0]][op.path[1]]=op.value;else delete value[op.path[0]];}revision++;return {ok:true,value:{ns:'sample',value,revision}};
  });await forms.load();const form=forms.get('sample');
  await form.mutate([{op:'set',path:['tools','read'],value:false}]);assert.equal(form.getSnapshot().value.tools.read,false);
  await form.unset('limit');assert.equal(form.getSnapshot().value.limit,undefined);assert.equal(form.getSnapshot().revision,6);assert.equal(calls.filter(([method])=>method==='ui.connection.call').length,2);
});

test('context injection waits for a real mounted Remote namespace and cleanup withdraws it',async()=>{
  const runtime=createRuntime({rpc:async()=>({ok:true,value:42})});let started=0,stopped=0;
  runtime.load({id:'consumer',factory:()=>({apply(ctx){ctx.inject(['remote.example'],()=>{started++;return()=>stopped++;});}})});
  assert.equal(started,0);
  const off=await runtime.services.remote.$mount({package:'provider',descriptors:[{namespace:'example',method:'read',service:'example',invocation:{kind:'direct'},parameters:[],result:{mode:'src-json'}}]});
  assert.equal(started,1);assert.equal((await runtime.services.remote.example.read()).value,42);
  await off();assert.equal(stopped,1);runtime.dispose();
});

test('browser request cancellation travels as fetch options and is never serialized as business data',async()=>{
  const controller=new AbortController();let request;
  const rpc=createRpc(async(_url,options)=>{request=options;return {ok:true,json:async()=>({ok:true,result:'done'})};});
  assert.equal(await rpc('ui.connection.call',{channel:'/probe'},{signal:controller.signal}),'done');assert.equal(request.signal,controller.signal);assert.equal(JSON.parse(request.body).params.signal,undefined);
});
